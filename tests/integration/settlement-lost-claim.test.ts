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
 * The stuck-claim hazard (ADR 0029, closed by ADR 0030). A settle that is slow can lose its claim to the worker's
 * stuck-claim step after the transfer has gone out but before the transaction hash is stored. The spy below
 * simulates exactly that: `beforeReturn` runs inside transferUSDC, after the money has moved, and moves the order
 * to `payment_hold` with no hash, as step 4 would. Local test keys and addresses only. Nothing is broadcast.
 */

const run = Date.now();
const FLOUR = "FOOD-FLOUR-50LB"; // par 6, on hand 3, reorder 10
const PAYER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;
const OTHER_HASH = `0x${"ab".repeat(32)}`;

const created: string[] = [];

async function newWorkspace(label: string): Promise<string> {
  const id = `wkr-lost-${label}-${run}-${created.length}`;
  await provisionWorkspace(id, `Lost claim ${label}`, "kitchen-v1", {
    customDailyLimitCents: 10_000_000n,
    customApprovalThresholdCents: 10_000_000n,
  });
  await query(`UPDATE workspaces SET settlement_address = $2 WHERE id = $1;`, [id, PAYER]);
  created.push(id);
  return id;
}

class LostClaimSettlement implements SettlementAdapter {
  readonly mode = "local" as const;
  /** Every transfer request, in order. Each one moved money. */
  readonly transfers: TransferRequest[] = [];
  /** The hash each transfer produced, keyed by order. */
  readonly moves: Array<{ orderId: string; txHash: string }> = [];
  readonly confirmCalls: string[] = [];
  transferStatus: SettlementStatus = "submitted";
  confirmStatus: SettlementStatus = "confirmed";
  /** Runs inside transferUSDC after the transfer is made and before the adapter returns. */
  beforeReturn: ((req: TransferRequest) => Promise<void>) | null = null;

  async getBalance(): Promise<bigint> {
    return 1_000_000n;
  }

  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    this.transfers.push(req);
    const txHash = `0x${crypto.createHash("sha256").update(`${req.idempotencyKey}:${this.transfers.length}`).digest("hex")}`;
    this.moves.push({ orderId: req.orderId, txHash });
    if (this.beforeReturn) await this.beforeReturn(req);
    return { txHash, status: this.transferStatus, timestamp: new Date(), mode: "local", simulated: true };
  }

  async confirm(txHash: string): Promise<TransferResult> {
    this.confirmCalls.push(txHash);
    return { txHash, status: this.confirmStatus, timestamp: new Date(), mode: "local", simulated: true };
  }

  async depositEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }

  async releaseEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }
}

async function orderRow(orderId: string): Promise<any> {
  return (await query(`SELECT * FROM orders WHERE id = $1;`, [orderId])).rows[0];
}

async function auditRows(workspaceId: string, action: string): Promise<any[]> {
  return (
    await query(`SELECT evidence, tx_hash, actor_id FROM audit_logs WHERE workspace_id = $1 AND action = $2 ORDER BY created_at;`, [
      workspaceId,
      action,
    ])
  ).rows;
}

async function stockOf(workspaceId: string, sku: string): Promise<number> {
  const res = await query(`SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`, [workspaceId, sku]);
  return Number(res.rows[0].current_quantity);
}

async function journalCount(orderId: string): Promise<number> {
  const res = await query(`SELECT COUNT(*)::int AS n FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
  return res.rows[0].n;
}

/** Starts a flour replenishment and makes its supplier verified and payable. The order is `confirmed`. */
async function confirmedOrder(runner: ProcurementWorkflowRunner, ws: string): Promise<{ orderId: string; workflowId: string }> {
  const started = await runner.startReplenishment(ws, FLOUR);
  expect(started.state).toBe(WorkflowState.CONFIRMED);
  const orderId = started.orderId!;
  const supplierId = (await orderRow(orderId)).supplier_id as string;
  await query(`UPDATE suppliers SET verified = TRUE, payment_address = $2 WHERE id = $1;`, [supplierId, PAYEE]);
  return { orderId, workflowId: started.workflowId };
}

describe("a settlement whose claim was lost after the transfer (PostgreSQL)", () => {
  let supplier: SupplierAdapter;

  beforeAll(async () => {
    await runMigrations();
    const base = new SimulatedSupplierAdapter("supp-sysco-metro", "Lost Claim Supplier", 1.0);
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

  it("a transfer sent after the claim was lost is recorded and confirmed, not paid twice", async () => {
    const ws = await newWorkspace("recorded");
    const settle = new LostClaimSettlement();
    const deps = { supplierFor: () => supplier, settlementFor: () => settle };
    const runner = new ProcurementWorkflowRunner(deps);
    const { orderId, workflowId } = await confirmedOrder(runner, ws);
    const stockBefore = await stockOf(ws, FLOUR);
    settle.beforeReturn = async () => {
      // Step 4 of the worker: the order is `settling` with no hash yet, so it is moved to payment_hold.
      await query(`UPDATE orders SET status = 'payment_hold', updated_at = NOW() WHERE id = $1 AND status = 'settling';`, [orderId]);
    };

    const result = await runner.fulfillAndReconcile(orderId, ws);

    const sent = settle.moves.find((m) => m.orderId === orderId);
    expect(sent).toBeDefined();
    expect(result).toMatchObject({
      status: MatchStatus.MATCHED,
      reconciled: false,
      pending: "AWAITING_SETTLEMENT_CONFIRMATION",
      txHash: sent!.txHash,
    });

    const afterSend = await orderRow(orderId);
    expect(afterSend.status).toBe("settlement_submitted");
    expect(afterSend.tx_hash).toBe(sent!.txHash);
    expect(afterSend.settled_amount_cents).not.toBeNull();
    expect(afterSend.settled_receipt_id).not.toBeNull();
    expect(afterSend.settled_bill_id).not.toBeNull();

    const reattached = await auditRows(ws, "settlement.reattached");
    expect(reattached).toHaveLength(1);
    expect(reattached[0].evidence).toEqual({ orderId, txHash: sent!.txHash });
    expect(reattached[0].tx_hash).toBe(sent!.txHash);
    // Nothing is restocked or journaled by the call that sent the money: the confirmation does that.
    expect(await stockOf(ws, FLOUR)).toBe(stockBefore);
    expect(await journalCount(orderId)).toBe(0);

    // The worker's confirmation poll finishes the payment, once its wait has passed.
    await query(`UPDATE orders SET updated_at = NOW() - INTERVAL '1 hour' WHERE id = $1;`, [orderId]);
    await runTick({ deps, confirmAfterMs: 30_000 });

    expect(settle.transfers.filter((t) => t.orderId === orderId)).toHaveLength(1);
    // Only this order's hash is counted: the shared database may hold settlements left by other test files.
    expect(settle.confirmCalls.filter((hash) => hash === sent!.txHash)).toHaveLength(1);
    const finished = await orderRow(orderId);
    expect(finished.status).toBe("reconciled");
    expect(finished.tx_hash).toBe(sent!.txHash);
    expect((await query(`SELECT state FROM workflows WHERE id = $1;`, [workflowId])).rows[0].state).toBe(WorkflowState.RECONCILED);
    expect(await stockOf(ws, FLOUR)).toBe(stockBefore + Number(finished.quantity));
    expect(await journalCount(orderId)).toBe(1);
    expect(await auditRows(ws, "settlement.reconcile_and_pay")).toHaveLength(1);

    // A further tick pays nothing and restocks nothing.
    await runTick({ deps, confirmAfterMs: 0 });
    expect(settle.transfers.filter((t) => t.orderId === orderId)).toHaveLength(1);
    expect(await stockOf(ws, FLOUR)).toBe(stockBefore + Number(finished.quantity));
    expect(await journalCount(orderId)).toBe(1);
  });

  it("a transfer after the order was already finished by someone else changes nothing", async () => {
    const ws = await newWorkspace("finished");
    const settle = new LostClaimSettlement();
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplier, settlementFor: () => settle });
    const { orderId } = await confirmedOrder(runner, ws);
    const stockBefore = await stockOf(ws, FLOUR);
    settle.beforeReturn = async () => {
      // Another caller finishes the order while this transfer is in flight.
      await query(
        `UPDATE orders SET status = 'reconciled', tx_hash = $2, updated_at = NOW() WHERE id = $1 AND status = 'settling';`,
        [orderId, OTHER_HASH]
      );
    };

    const result = await runner.fulfillAndReconcile(orderId, ws);

    expect(result).toMatchObject({ status: MatchStatus.MATCHED, reconciled: false, hold: "RECONCILE_IN_PROGRESS" });
    expect(result.txHash).toBeUndefined();
    expect(result.pending).toBeUndefined();

    const after = await orderRow(orderId);
    expect(after.status).toBe("reconciled");
    expect(after.tx_hash).toBe(OTHER_HASH);
    expect(await auditRows(ws, "settlement.reattached")).toHaveLength(0);
    expect(await auditRows(ws, "settlement.submitted")).toHaveLength(0);
    expect(await auditRows(ws, "settlement.reconcile_and_pay")).toHaveLength(0);
    expect(settle.confirmCalls).toHaveLength(0);
    expect(await stockOf(ws, FLOUR)).toBe(stockBefore);
    expect(await journalCount(orderId)).toBe(0);
  });
});
