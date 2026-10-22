import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "crypto";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { MatchStatus } from "../../src/accounting/three-way-match.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { SimulatedSupplierAdapter } from "../../src/adapters/suppliers/simulated.js";
import type { SupplierAdapter } from "../../src/adapters/suppliers/types.js";
import type {
  SettlementAdapter,
  SettlementStatus,
  TransferRequest,
  TransferResult,
} from "../../src/adapters/settlement/types.js";
import { runTick } from "../../src/workers/runner.js";

/**
 * Settlement milestones (ADR 0078). A transfer that was sent is `submitted` and is stored before anything asks
 * whether it was confirmed. A confirmation is a separate record, `confirmed`, with its own time and block. The spy
 * below is the only adapter; nothing is broadcast and the keys are local test values.
 *
 * `confirm()` is called inside OrderSettlementService's confirmation helper, which catches every error, so an
 * assertion inside the spy would never fail a test. Instead the spy reads the database at each confirm call and
 * keeps what it saw; the tests assert on that record.
 */

const run = Date.now();
const FLOUR = "FOOD-FLOUR-50LB"; // par 6, on hand 3, reorder 10
const PAYER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;
const BLOCK = 4242;
const AWAITING = "AWAITING_SETTLEMENT_CONFIRMATION";

type ConfirmMode = "confirmed" | "submitted" | "failed" | "throws";

/** What the database held when confirm() was called, read inside the call. */
interface Snapshot {
  status: string | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  confirmedBlock: string | null;
  submittedAuditRows: number;
}

const created: string[] = [];

async function newWorkspace(label: string): Promise<string> {
  const id = `wkr-ms-${label}-${run.toString(36)}-${created.length}`;
  await provisionWorkspace(id, `Milestones ${label}`, "kitchen-v1", {
    customDailyLimitCents: 10_000_000n,
    customApprovalThresholdCents: 10_000_000n,
  });
  await query(`UPDATE workspaces SET settlement_address = $2 WHERE id = $1;`, [id, PAYER]);
  created.push(id);
  return id;
}

async function snapshotByHash(txHash: string): Promise<Snapshot> {
  const row = (
    await query(
      `SELECT status, settlement_submitted_at, settlement_confirmed_at, settlement_confirmed_block
       FROM orders WHERE tx_hash = $1;`,
      [txHash]
    )
  ).rows[0];
  const submitted = await query(
    `SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'settlement.submitted' AND tx_hash = $1;`,
    [txHash]
  );
  return {
    status: row?.status ?? null,
    submittedAt: row?.settlement_submitted_at ?? null,
    confirmedAt: row?.settlement_confirmed_at ?? null,
    confirmedBlock: row?.settlement_confirmed_block ?? null,
    submittedAuditRows: submitted.rows[0].n,
  };
}

class MilestoneSettlement implements SettlementAdapter {
  readonly mode = "local" as const;
  /** Every transfer request, in order. Each one moved money. */
  readonly transfers: TransferRequest[] = [];
  readonly confirmCalls: string[] = [];
  /** The database as it stood at each confirm() call. */
  readonly snapshots: Snapshot[] = [];
  transferStatus: SettlementStatus = "submitted";
  confirmMode: ConfirmMode = "confirmed";

  async getBalance(): Promise<bigint> {
    return 1_000_000n;
  }

  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    this.transfers.push(req);
    const txHash = `0x${crypto.createHash("sha256").update(`${req.idempotencyKey}:${this.transfers.length}`).digest("hex")}`;
    return this.result(txHash, this.transferStatus, this.transferStatus === "failed" ? "REVERTED" : undefined);
  }

  async confirm(txHash: string): Promise<TransferResult> {
    this.confirmCalls.push(txHash);
    this.snapshots.push(await snapshotByHash(txHash));
    if (this.confirmMode === "throws") throw new Error("confirm: rpc unreachable");
    const failureCode = this.confirmMode === "failed" ? "REVERTED" : undefined;
    return this.result(txHash, this.confirmMode === "failed" ? "failed" : this.confirmMode === "submitted" ? "submitted" : "confirmed", failureCode);
  }

  async depositEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }

  async releaseEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }

  private result(txHash: string, status: SettlementStatus, failureCode?: string): TransferResult {
    return {
      txHash,
      status,
      timestamp: new Date(),
      mode: this.mode,
      simulated: true,
      blockNumber: status === "confirmed" ? BLOCK : undefined,
      ...(failureCode ? { failureCode } : {}),
    };
  }
}

async function orderRow(orderId: string): Promise<any> {
  return (await query(`SELECT * FROM orders WHERE id = $1;`, [orderId])).rows[0];
}

async function auditRows(workspaceId: string, action: string): Promise<any[]> {
  return (
    await query(
      `SELECT evidence, tx_hash, created_at FROM audit_logs WHERE workspace_id = $1 AND action = $2 ORDER BY created_at;`,
      [workspaceId, action]
    )
  ).rows;
}

async function stockOf(workspaceId: string, sku: string): Promise<number> {
  const res = await query(`SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`, [
    workspaceId,
    sku,
  ]);
  return Number(res.rows[0].current_quantity);
}

async function journalCount(orderId: string): Promise<number> {
  const res = await query(`SELECT COUNT(*)::int AS n FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
  return res.rows[0].n;
}

/** Starts a flour replenishment and makes its supplier verified and payable. The order is `confirmed`. */
async function confirmedOrder(
  runner: ProcurementWorkflowRunner,
  ws: string
): Promise<{ orderId: string; workflowId: string }> {
  const started = await runner.startReplenishment(ws, FLOUR);
  expect(started.state).toBe(WorkflowState.CONFIRMED);
  const orderId = started.orderId!;
  const supplierId = (await orderRow(orderId)).supplier_id as string;
  await query(`UPDATE suppliers SET verified = TRUE, payment_address = $2 WHERE id = $1;`, [supplierId, PAYEE]);
  return { orderId, workflowId: started.workflowId };
}

describe("settlement milestones: submitted and confirmed are separate records (PostgreSQL)", () => {
  let supplier: SupplierAdapter;

  beforeAll(async () => {
    await runMigrations();
    const base = new SimulatedSupplierAdapter("supp-sysco-metro", "Milestone Supplier", 1.0);
    supplier = {
      supplierId: base.supplierId,
      supplierName: base.supplierName,
      isSimulated: true,
      requestQuote: (req) => base.requestQuote(req),
      submitOrder: (req) => base.submitOrder(req),
      generateDeliveryReceipt: (orderId, sku, quantity) => base.generateDeliveryReceipt(orderId, sku, quantity),
      generateBill: (orderId, sku, quantity, unitPriceCents, vendorId) =>
        base.generateBill(orderId, sku, quantity, unitPriceCents, vendorId),
    };
  });

  afterEach(async () => {
    for (const id of created.splice(0)) {
      await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it("the transfer is stored as submitted before confirm is asked, and confirmed afterwards with its block", async () => {
    const ws = await newWorkspace("happy");
    const settle = new MilestoneSettlement();
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplier, settlementFor: () => settle });
    const { orderId, workflowId } = await confirmedOrder(runner, ws);
    const stockBefore = await stockOf(ws, FLOUR);
    const qty = Number((await orderRow(orderId)).quantity);

    const result = await runner.fulfillAndReconcile(orderId, ws);

    expect(result).toMatchObject({ status: MatchStatus.MATCHED, reconciled: true });
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.pending).toBeUndefined();

    // Before confirm() ran: the hash, the submitted time and the submitted audit row were all stored.
    expect(settle.confirmCalls).toEqual([result.txHash]);
    const [seenByConfirm] = settle.snapshots;
    expect(seenByConfirm.submittedAt).toBeInstanceOf(Date);
    expect(seenByConfirm.submittedAuditRows).toBe(1);
    expect(seenByConfirm.confirmedAt).toBeNull();
    expect(seenByConfirm.confirmedBlock).toBeNull();
    // The confirmation claim holds the order while confirm() is asked.
    expect(seenByConfirm.status).toBe("settling");

    const row = await orderRow(orderId);
    expect(row.status).toBe("reconciled");
    expect(row.tx_hash).toBe(result.txHash);
    expect(row.settlement_submitted_at).toBeInstanceOf(Date);
    expect(row.settlement_confirmed_at).toBeInstanceOf(Date);
    expect(Number(row.settlement_confirmed_block)).toBe(BLOCK);
    expect(row.settlement_confirmed_at.getTime()).toBeGreaterThanOrEqual(row.settlement_submitted_at.getTime());

    const submitted = await auditRows(ws, "settlement.submitted");
    expect(submitted).toHaveLength(1);
    expect(submitted[0].evidence).toEqual({ orderId, txHash: result.txHash });
    expect(submitted[0].tx_hash).toBe(result.txHash);

    const confirmed = await auditRows(ws, "settlement.confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].evidence).toEqual({ orderId, txHash: result.txHash, blockNumber: BLOCK });
    expect(confirmed[0].tx_hash).toBe(result.txHash);
    expect(confirmed[0].created_at.getTime()).toBeGreaterThan(submitted[0].created_at.getTime());

    expect(settle.transfers.filter((t) => t.orderId === orderId)).toHaveLength(1);
    expect(await stockOf(ws, FLOUR)).toBe(stockBefore + qty);
    expect(await journalCount(orderId)).toBe(1);
    expect((await query(`SELECT state FROM workflows WHERE id = $1;`, [workflowId])).rows[0].state).toBe(
      WorkflowState.RECONCILED
    );
  });

  it("a confirm() that throws leaves the order settlement_submitted with its hash and submitted time, and no confirmed time", async () => {
    const ws = await newWorkspace("crash");
    const settle = new MilestoneSettlement();
    settle.confirmMode = "throws";
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplier, settlementFor: () => settle });
    const { orderId } = await confirmedOrder(runner, ws);
    const stockBefore = await stockOf(ws, FLOUR);

    const result = await runner.fulfillAndReconcile(orderId, ws);

    expect(result).toEqual({
      status: MatchStatus.MATCHED,
      reconciled: false,
      txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      pending: AWAITING,
    });
    const row = await orderRow(orderId);
    expect(row.status).toBe("settlement_submitted");
    expect(row.tx_hash).toBe(result.txHash);
    expect(row.settlement_submitted_at).toBeInstanceOf(Date);
    expect(row.settlement_confirmed_at).toBeNull();
    expect(row.settlement_confirmed_block).toBeNull();
    expect(await stockOf(ws, FLOUR)).toBe(stockBefore);
    expect(await journalCount(orderId)).toBe(0);
    expect(await auditRows(ws, "settlement.confirmed")).toHaveLength(0);
    expect(await auditRows(ws, "settlement.submitted")).toHaveLength(1);
  });

  it("confirmSettlement finishes that crashed payment exactly once; transferUSDC is called once in total", async () => {
    const ws = await newWorkspace("finish");
    const settle = new MilestoneSettlement();
    settle.confirmMode = "throws";
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplier, settlementFor: () => settle });
    const { orderId } = await confirmedOrder(runner, ws);
    const stockBefore = await stockOf(ws, FLOUR);
    const crashed = await runner.fulfillAndReconcile(orderId, ws);
    expect(crashed.pending).toBe(AWAITING);

    // The adapter answers now. The later confirmation finishes the payment.
    settle.confirmMode = "confirmed";
    const finished = await runner.confirmSettlement(orderId, ws);
    expect(finished).toMatchObject({ status: MatchStatus.MATCHED, reconciled: true, txHash: crashed.txHash });

    expect(settle.transfers.filter((t) => t.orderId === orderId)).toHaveLength(1);
    const row = await orderRow(orderId);
    expect(row.status).toBe("reconciled");
    expect(row.settlement_confirmed_at).toBeInstanceOf(Date);
    expect(Number(row.settlement_confirmed_block)).toBe(BLOCK);
    expect(await stockOf(ws, FLOUR)).toBe(stockBefore + Number(row.quantity));
    expect(await journalCount(orderId)).toBe(1);
    expect(await auditRows(ws, "settlement.confirmed")).toHaveLength(1);
    expect(await auditRows(ws, "settlement.submitted")).toHaveLength(1);

    // A second confirmation replays the stored result. It asks no adapter and changes nothing.
    const callsBefore = settle.confirmCalls.length;
    const again = await runner.confirmSettlement(orderId, ws);
    expect(again).toMatchObject({ reconciled: true, alreadyReconciled: true, txHash: crashed.txHash });
    expect(settle.confirmCalls.length).toBe(callsBefore);
    expect(settle.transfers.filter((t) => t.orderId === orderId)).toHaveLength(1);
    expect(await stockOf(ws, FLOUR)).toBe(stockBefore + Number(row.quantity));
    expect(await auditRows(ws, "settlement.confirmed")).toHaveLength(1);
  });

  it("the worker's confirmation poll finishes a payment that stopped before confirmation, once", async () => {
    const ws = await newWorkspace("poll");
    const settle = new MilestoneSettlement();
    settle.confirmMode = "throws";
    const deps = { supplierFor: () => supplier, settlementFor: () => settle };
    const runner = new ProcurementWorkflowRunner(deps);
    const { orderId } = await confirmedOrder(runner, ws);
    const crashed = await runner.fulfillAndReconcile(orderId, ws);
    expect(crashed.pending).toBe(AWAITING);

    settle.confirmMode = "confirmed";
    // Make the order old enough for the poll. The transfer is still recent, so the poll is allowed to ask.
    await query(`UPDATE orders SET updated_at = NOW() - INTERVAL '1 hour' WHERE id = $1;`, [orderId]);
    await runTick({ deps, confirmAfterMs: 30_000 });

    const row = await orderRow(orderId);
    expect(row.status).toBe("reconciled");
    expect(row.settlement_confirmed_at).toBeInstanceOf(Date);
    expect(settle.transfers.filter((t) => t.orderId === orderId)).toHaveLength(1);
    expect(settle.confirmCalls.filter((hash) => hash === crashed.txHash)).toHaveLength(2);
    expect(await auditRows(ws, "settlement.confirmed")).toHaveLength(1);

    await runTick({ deps, confirmAfterMs: 0 });
    expect(settle.transfers.filter((t) => t.orderId === orderId)).toHaveLength(1);
    expect(await auditRows(ws, "settlement.confirmed")).toHaveLength(1);
  });

  it("a failed confirmation never sets settlement_confirmed_at or the block", async () => {
    const ws = await newWorkspace("confirmfail");
    const settle = new MilestoneSettlement();
    settle.confirmMode = "failed";
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplier, settlementFor: () => settle });
    const { orderId } = await confirmedOrder(runner, ws);
    const stockBefore = await stockOf(ws, FLOUR);

    const result = await runner.fulfillAndReconcile(orderId, ws);

    expect(result).toMatchObject({ reconciled: false, hold: "SETTLEMENT_FAILED", txHash: expect.any(String) });
    const row = await orderRow(orderId);
    expect(row.status).toBe("payment_hold");
    expect(row.tx_hash).toBe(result.txHash);
    expect(row.settlement_submitted_at).toBeInstanceOf(Date);
    expect(row.settlement_confirmed_at).toBeNull();
    expect(row.settlement_confirmed_block).toBeNull();
    expect(await stockOf(ws, FLOUR)).toBe(stockBefore);
    expect(await journalCount(orderId)).toBe(0);
    expect(await auditRows(ws, "settlement.confirmed")).toHaveLength(0);
    expect(await auditRows(ws, "settlement.failed")).toHaveLength(1);
  });

  it("an unresolved confirmation keeps settlement_confirmed_at NULL and the order settlement_submitted", async () => {
    const ws = await newWorkspace("unresolv");
    const settle = new MilestoneSettlement();
    settle.confirmMode = "submitted";
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplier, settlementFor: () => settle });
    const { orderId } = await confirmedOrder(runner, ws);

    const result = await runner.fulfillAndReconcile(orderId, ws);

    expect(result).toEqual({
      status: MatchStatus.MATCHED,
      reconciled: false,
      txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      pending: AWAITING,
    });
    const row = await orderRow(orderId);
    expect(row.status).toBe("settlement_submitted");
    expect(row.settlement_submitted_at).toBeInstanceOf(Date);
    expect(row.settlement_confirmed_at).toBeNull();
    expect(await auditRows(ws, "settlement.confirmed")).toHaveLength(0);
    expect(await auditRows(ws, "settlement.submitted")).toHaveLength(1);
  });

  it("a transfer the adapter already reports as confirmed still goes through confirm, and records both milestones", async () => {
    const ws = await newWorkspace("instant");
    const settle = new MilestoneSettlement();
    settle.transferStatus = "confirmed";
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplier, settlementFor: () => settle });
    const { orderId } = await confirmedOrder(runner, ws);

    const result = await runner.fulfillAndReconcile(orderId, ws);

    expect(result).toMatchObject({ reconciled: true, txHash: expect.any(String) });
    expect(settle.confirmCalls).toEqual([result.txHash]);
    expect(settle.snapshots[0].submittedAuditRows).toBe(1);
    expect(settle.snapshots[0].confirmedAt).toBeNull();
    const row = await orderRow(orderId);
    expect(row.status).toBe("reconciled");
    expect(row.settlement_submitted_at).toBeInstanceOf(Date);
    expect(row.settlement_confirmed_at).toBeInstanceOf(Date);
    expect(await auditRows(ws, "settlement.submitted")).toHaveLength(1);
    expect(await auditRows(ws, "settlement.confirmed")).toHaveLength(1);
  });

  it("a transfer the adapter reports as failed holds the order and records no submitted milestone", async () => {
    const ws = await newWorkspace("sendfail");
    const settle = new MilestoneSettlement();
    settle.transferStatus = "failed";
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplier, settlementFor: () => settle });
    const { orderId } = await confirmedOrder(runner, ws);

    const result = await runner.fulfillAndReconcile(orderId, ws);

    expect(result).toMatchObject({ reconciled: false, hold: "SETTLEMENT_FAILED" });
    expect(settle.confirmCalls).toHaveLength(0);
    const row = await orderRow(orderId);
    expect(row.status).toBe("payment_hold");
    expect(row.settlement_submitted_at).toBeNull();
    expect(row.settlement_confirmed_at).toBeNull();
    expect(await auditRows(ws, "settlement.submitted")).toHaveLength(0);
    expect(await auditRows(ws, "settlement.failed")).toHaveLength(1);
  });

  it("a finalising failure after a confirmed transfer leaves settlement_submitted; a later confirmSettlement restocks once", async () => {
    const ws = await newWorkspace("finalfail");
    const settle = new MilestoneSettlement();
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplier, settlementFor: () => settle });
    const { orderId } = await confirmedOrder(runner, ws);
    const stockBefore = await stockOf(ws, FLOUR);
    const qty = Number((await orderRow(orderId)).quantity);

    // The restock write fails for this workspace only, after the adapter has confirmed the transfer.
    await query(`
      CREATE OR REPLACE FUNCTION test_ms_block_restock() RETURNS trigger AS $f$
      BEGIN RAISE EXCEPTION 'simulated database failure after confirmation'; END;
      $f$ LANGUAGE plpgsql;`);
    await query(
      `CREATE TRIGGER test_ms_block_restock BEFORE UPDATE ON inventory_items
       FOR EACH ROW WHEN (NEW.workspace_id = '${ws}') EXECUTE FUNCTION test_ms_block_restock();`
    );
    try {
      await expect(runner.fulfillAndReconcile(orderId, ws)).rejects.toThrow(/simulated database failure after confirmation/);
    } finally {
      await query(`DROP TRIGGER IF EXISTS test_ms_block_restock ON inventory_items;`);
      await query(`DROP FUNCTION IF EXISTS test_ms_block_restock();`);
    }

    // The confirmed row and its audit rolled back with the restock, so the order is not finished.
    const failed = await orderRow(orderId);
    expect(failed.status).toBe("settlement_submitted");
    expect(failed.tx_hash).toBeTruthy();
    expect(failed.settlement_confirmed_at).toBeNull();
    expect(failed.settlement_confirmed_block).toBeNull();
    expect(await stockOf(ws, FLOUR)).toBe(stockBefore);
    expect(await auditRows(ws, "settlement.confirmed")).toHaveLength(0);
    expect(await journalCount(orderId)).toBe(0);

    // The later confirmation finishes it: one restock, one confirmed row, one transfer in total.
    const finished = await runner.confirmSettlement(orderId, ws);
    expect(finished).toMatchObject({ reconciled: true, txHash: failed.tx_hash });
    const row = await orderRow(orderId);
    expect(row.status).toBe("reconciled");
    expect(row.settlement_confirmed_at).toBeInstanceOf(Date);
    expect(await stockOf(ws, FLOUR)).toBe(stockBefore + qty);
    expect(await auditRows(ws, "settlement.confirmed")).toHaveLength(1);
    expect(await journalCount(orderId)).toBe(1);
    expect(settle.transfers.filter((t) => t.orderId === orderId)).toHaveLength(1);
  });
});
