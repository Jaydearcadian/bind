import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { SimulatedSupplierAdapter } from "../../src/adapters/suppliers/simulated.js";
import type { SupplierAdapter } from "../../src/adapters/suppliers/types.js";
import type {
  SettlementAdapter,
  SettlementStatus,
  TransferRequest,
  TransferResult,
} from "../../src/adapters/settlement/types.js";

/**
 * A reverted duplicate send is adopted only when the first transfer is confirmed (docs/decisions/0079, the duplicate
 * rule). The spy is the only adapter. It models the in-flight sequence of ADR 0019 without a chain:
 *   - attempt 1 moves the money (the first broadcast, tx1) and then throws a timeout-style error;
 *   - attempt 2 runs before tx1 is mined, so the lookup finds nothing, and sends again (tx2);
 *   - tx1 is mined while tx2's receipt is read, and tx2 reverts with OrderAlreadySettled.
 * Nothing is broadcast. The keys are local test values.
 */

const run = Date.now();
const FLOUR = "FOOD-FLOUR-50LB";
const PAYER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;
const TX1 = `0x${"a1".repeat(32)}`;
const TX2 = `0x${"b2".repeat(32)}`;
const BLOCK1 = 777;

type FindMode = "mined-original" | "null" | "throws" | "same-hash" | "submitted";

class DuplicateSpy implements SettlementAdapter {
  readonly mode = "local" as const;
  /** Every transferUSDC call, in order. */
  readonly sends: string[] = [];
  /** Hashes that moved money on chain (a successful, mined transfer). */
  readonly moved: string[] = [];
  /** Set when tx1 has been mined. Until then findTransfer finds nothing. */
  mined = false;
  /** When true, the first send moves money and then fails with a timeout-style error (the transport case). */
  failFirstSendAfterBroadcast = false;
  /** When true, tx1 is mined while tx2's receipt is being read (the in-flight race). */
  mineOnSecondConfirm = false;
  findMode: FindMode = "mined-original";
  /** The hash whose confirmation reports REVERTED. The in-flight case reverts the second send (TX2). */
  revertedHash: string = TX2;

  async getBalance(): Promise<bigint> {
    return 1_000_000n;
  }

  async transferUSDC(_req: TransferRequest): Promise<TransferResult> {
    const hash = this.sends.length === 0 ? TX1 : TX2;
    this.sends.push(hash);
    if (this.sends.length === 1 && this.failFirstSendAfterBroadcast) {
      // The first broadcast went out. The adapter sees a failure, so the caller believes nothing was sent.
      throw new Error("RPC request timed out after the transaction was sent");
    }
    return this.result(hash, "submitted");
  }

  async confirm(txHash: string): Promise<TransferResult> {
    if (txHash === this.revertedHash) {
      if (this.mineOnSecondConfirm) {
        this.mined = true;
        this.moved.push(TX1);
      }
      return this.result(txHash, "failed", "REVERTED");
    }
    if (txHash === TX1 && this.mined) return this.result(TX1, "confirmed");
    return this.result(txHash, "submitted");
  }

  async findTransfer(_req: { orderId: string }): Promise<TransferResult | null> {
    switch (this.findMode) {
      case "null":
        return null;
      case "throws":
        throw new Error("settlement lookup: rpc unreachable");
      case "same-hash":
        return this.result(this.revertedHash, "confirmed");
      case "submitted":
        return this.result(TX1, "submitted");
      case "mined-original":
        return this.mined ? this.result(TX1, "confirmed") : null;
    }
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
      blockNumber: status === "confirmed" ? BLOCK1 : undefined,
      ...(failureCode ? { failureCode } : {}),
    };
  }
}

const created: string[] = [];

async function newWorkspace(label: string): Promise<string> {
  const id = `wkr-dup-${label}-${run.toString(36)}-${created.length}`;
  await provisionWorkspace(id, `Duplicate ${label}`, "kitchen-v1", {
    customDailyLimitCents: 10_000_000n,
    customApprovalThresholdCents: 10_000_000n,
  });
  await query(`UPDATE workspaces SET settlement_address = $2 WHERE id = $1;`, [id, PAYER]);
  created.push(id);
  return id;
}

async function orderRow(orderId: string): Promise<any> {
  return (await query(`SELECT * FROM orders WHERE id = $1;`, [orderId])).rows[0];
}

async function auditRows(workspaceId: string, action: string): Promise<any[]> {
  return (
    await query(
      `SELECT evidence, tx_hash FROM audit_logs WHERE workspace_id = $1 AND action = $2 ORDER BY created_at;`,
      [workspaceId, action]
    )
  ).rows;
}

async function stockOf(workspaceId: string, sku: string): Promise<number> {
  const res = await query(`SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`, [workspaceId, sku]);
  return Number(res.rows[0].current_quantity);
}

async function confirmedOrder(runner: ProcurementWorkflowRunner, ws: string): Promise<{ orderId: string; workflowId: string }> {
  const started = await runner.startReplenishment(ws, FLOUR);
  expect(started.state).toBe(WorkflowState.CONFIRMED);
  const orderId = started.orderId!;
  const supplierId = (await orderRow(orderId)).supplier_id as string;
  await query(`UPDATE suppliers SET verified = TRUE, payment_address = $2 WHERE id = $1;`, [supplierId, PAYEE]);
  return { orderId, workflowId: started.workflowId };
}

describe("a reverted duplicate send is adopted only when the first transfer is confirmed (PostgreSQL)", () => {
  let supplier: SupplierAdapter;

  beforeAll(async () => {
    await runMigrations();
    const base = new SimulatedSupplierAdapter("supp-sysco-metro", "Duplicate Supplier", 1.0);
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

  it("the in-flight sequence ends reconciled with the first hash: one payment, the confirmed block of the first transfer", async () => {
    const ws = await newWorkspace("inflight");
    const spy = new DuplicateSpy();
    spy.failFirstSendAfterBroadcast = true;
    spy.mineOnSecondConfirm = true;
    spy.mined = false;
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplier, settlementFor: () => spy });
    const { orderId, workflowId } = await confirmedOrder(runner, ws);
    const stockBefore = await stockOf(ws, FLOUR);
    const qty = Number((await orderRow(orderId)).quantity);

    // Attempt 1: the first broadcast goes out and the adapter reports a failure. The order goes back to confirmed.
    await expect(runner.fulfillAndReconcile(orderId, ws)).rejects.toThrow(/timed out/);
    expect((await orderRow(orderId)).status).toBe("confirmed");
    expect((await query(`SELECT status FROM effects WHERE idempotency_key = $1;`, [`${ws}:settle:${orderId}`])).rows[0].status).toBe(
      "failed"
    );

    // Attempt 2, immediately: the lookup finds nothing (tx1 is not mined), so the transfer is sent again (tx2),
    // which reverts with OrderAlreadySettled once tx1 is mined. The adoption then finds tx1 confirmed.
    const result = await runner.fulfillAndReconcile(orderId, ws);

    expect(result).toMatchObject({ reconciled: true, txHash: TX1 });
    expect(spy.sends).toEqual([TX1, TX2]);
    expect(spy.moved).toEqual([TX1]);

    const row = await orderRow(orderId);
    expect(row.status).toBe("reconciled");
    expect(row.tx_hash).toBe(TX1);
    expect(Number(row.settlement_confirmed_block)).toBe(BLOCK1);
    expect(row.settlement_confirmed_at).toBeInstanceOf(Date);

    const effect = (await query(`SELECT status, external_ref FROM effects WHERE idempotency_key = $1;`, [`${ws}:settle:${orderId}`])).rows[0];
    expect(effect.external_ref).toBe(TX1);

    const adopted = await auditRows(ws, "settlement.reverted_duplicate_adopted");
    expect(adopted).toHaveLength(1);
    expect(adopted[0].evidence).toEqual({ orderId, revertedTxHash: TX2, adoptedTxHash: TX1 });
    expect(adopted[0].tx_hash).toBe(TX1);

    const confirmed = await auditRows(ws, "settlement.confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0].evidence).toEqual({ orderId, txHash: TX1, blockNumber: BLOCK1 });

    // The stored submission is the reverted one (it was the send that was recorded); the adoption is what the
    // audit trail shows, and the confirmation is the first transfer's.
    expect(await stockOf(ws, FLOUR)).toBe(stockBefore + qty);
    expect(spy.moved).toHaveLength(1);
    expect((await query(`SELECT state FROM workflows WHERE id = $1;`, [workflowId])).rows[0].state).toBe(WorkflowState.RECONCILED);
  });

  it("a reverted confirmation with no transfer found is held as SETTLEMENT_FAILED, with nothing adopted", async () => {
    const ws = await newWorkspace("none");
    const spy = new DuplicateSpy();
    spy.findMode = "null";
    spy.revertedHash = TX1;
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplier, settlementFor: () => spy });
    const { orderId } = await confirmedOrder(runner, ws);

    const result = await runner.fulfillAndReconcile(orderId, ws);

    expect(result).toMatchObject({ reconciled: false, hold: "SETTLEMENT_FAILED", txHash: TX1 });
    const row = await orderRow(orderId);
    expect(row.status).toBe("payment_hold");
    expect(row.tx_hash).toBe(TX1);
    expect(await auditRows(ws, "settlement.reverted_duplicate_adopted")).toHaveLength(0);
    expect(spy.sends).toEqual([TX1]);
  });

  it("a failed lookup keeps the SETTLEMENT_FAILED hold and adopts nothing", async () => {
    const ws = await newWorkspace("throws");
    const spy = new DuplicateSpy();
    spy.findMode = "throws";
    spy.revertedHash = TX1;
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplier, settlementFor: () => spy });
    const { orderId } = await confirmedOrder(runner, ws);

    const result = await runner.fulfillAndReconcile(orderId, ws);

    expect(result).toMatchObject({ reconciled: false, hold: "SETTLEMENT_FAILED", txHash: TX1 });
    const row = await orderRow(orderId);
    expect(row.status).toBe("payment_hold");
    expect(row.tx_hash).toBe(TX1);
    expect(await auditRows(ws, "settlement.reverted_duplicate_adopted")).toHaveLength(0);
    expect(spy.sends).toEqual([TX1]);
  });

  it("a lookup that returns the same reverted hash is not adopted: a genuinely reverted payment stays held", async () => {
    const ws = await newWorkspace("same");
    const spy = new DuplicateSpy();
    spy.findMode = "same-hash";
    spy.revertedHash = TX1;
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplier, settlementFor: () => spy });
    const { orderId } = await confirmedOrder(runner, ws);

    const result = await runner.fulfillAndReconcile(orderId, ws);

    expect(result).toMatchObject({ reconciled: false, hold: "SETTLEMENT_FAILED", txHash: TX1 });
    const row = await orderRow(orderId);
    expect(row.status).toBe("payment_hold");
    expect(row.tx_hash).toBe(TX1);
    expect(await auditRows(ws, "settlement.reverted_duplicate_adopted")).toHaveLength(0);
  });

  it("a lookup that reports an unconfirmed transfer is not adopted either", async () => {
    const ws = await newWorkspace("unconfirmed");
    const spy = new DuplicateSpy();
    spy.findMode = "submitted";
    spy.revertedHash = TX1;
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplier, settlementFor: () => spy });
    const { orderId } = await confirmedOrder(runner, ws);

    const result = await runner.fulfillAndReconcile(orderId, ws);

    expect(result).toMatchObject({ reconciled: false, hold: "SETTLEMENT_FAILED" });
    expect((await orderRow(orderId)).tx_hash).toBe(TX1);
    expect(await auditRows(ws, "settlement.reverted_duplicate_adopted")).toHaveLength(0);
  });
});
