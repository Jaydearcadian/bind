import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { MatchStatus } from "../../src/accounting/three-way-match.js";
import { WorkflowState } from "../../src/workflows/types.js";
import type {
  SettlementAdapter,
  TransferRequest,
  TransferResult,
} from "../../src/adapters/settlement/types.js";

/**
 * Counting settlement adapter injected through the runner's constructor deps.
 * The tx hash is derived from the idempotency key so a repeated key is visible.
 */
class CountingSettlementAdapter implements SettlementAdapter {
  readonly mode = "local" as const;
  transferCalls = 0;
  readonly idempotencyKeys: string[] = [];
  failNextTransfers = 0;
  delayMs = 0;

  async getBalance(): Promise<bigint> {
    return 1_000_000n;
  }

  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    this.transferCalls += 1;
    this.idempotencyKeys.push(req.idempotencyKey);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.failNextTransfers > 0) {
      this.failNextTransfers -= 1;
      throw new Error("simulated settlement outage");
    }
    const txHash = `0x${crypto.createHash("sha256").update(req.idempotencyKey).digest("hex")}`;
    return { txHash, status: "settled", timestamp: new Date(), mode: "local" };
  }

  async depositEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }

  async releaseEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }
}

describe("Reconcile exactly once", () => {
  const wsIds: string[] = [];
  let settlement: CountingSettlementAdapter;
  let runner: ProcurementWorkflowRunner;

  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(() => {
    settlement = new CountingSettlementAdapter();
    runner = new ProcurementWorkflowRunner({ settlementFor: () => settlement });
  });

  afterEach(async () => {
    for (const id of wsIds.splice(0)) {
      await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  async function confirmedOrder(): Promise<{ wsId: string; orderId: string; startingStock: number; received: number }> {
    const wsId = `ws-reconcile-once-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    wsIds.push(wsId);
    await provisionWorkspace(wsId, "Reconcile Once Kitchen", "kitchen-v1", {
      customDailyLimitCents: 100000n,
      customApprovalThresholdCents: 25000n,
    });
    const started = await runner.startReplenishment(wsId, "FOOD-FLOUR-50LB");
    expect(started.state).toBe(WorkflowState.CONFIRMED);
    const orderId = started.orderId!;
    const stock = await query(
      `SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = 'FOOD-FLOUR-50LB';`,
      [wsId]
    );
    const order = await query(`SELECT quantity FROM orders WHERE id = $1;`, [orderId]);
    return {
      wsId,
      orderId,
      startingStock: Number(stock.rows[0].current_quantity),
      received: Number(order.rows[0].quantity),
    };
  }

  async function stockOf(wsId: string): Promise<number> {
    const res = await query(
      `SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = 'FOOD-FLOUR-50LB';`,
      [wsId]
    );
    return Number(res.rows[0].current_quantity);
  }

  it("reconciling twice pays once, restocks once and keeps one journal entry", async () => {
    const { wsId, orderId, startingStock, received } = await confirmedOrder();

    const first = await runner.fulfillAndReconcile(orderId);
    expect(first.status).toBe(MatchStatus.MATCHED);
    expect(first.reconciled).toBe(true);
    expect(first.txHash).toBeDefined();
    expect(first.alreadyReconciled).toBeUndefined();

    const second = await runner.fulfillAndReconcile(orderId);
    expect(second.alreadyReconciled).toBe(true);
    expect(second.reconciled).toBe(true);
    expect(second.status).toBe(MatchStatus.MATCHED);
    expect(second.txHash).toBe(first.txHash);

    expect(settlement.transferCalls).toBe(1);
    expect(settlement.idempotencyKeys).toEqual([`idem_pay_${orderId}`]);
    expect(await stockOf(wsId)).toBe(startingStock + received);

    const journal = await query(`SELECT * FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(journal.rows.length).toBe(1);
    expect(journal.rows[0].tx_hash).toBe(first.txHash);

    const order = await query(`SELECT status, tx_hash FROM orders WHERE id = $1;`, [orderId]);
    expect(order.rows[0].status).toBe("reconciled");
    expect(order.rows[0].tx_hash).toBe(first.txHash);
  });

  it("five concurrent reconcile calls settle once", async () => {
    const { wsId, orderId, startingStock, received } = await confirmedOrder();
    settlement.delayMs = 150; // hold the claim open so the other callers really race

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => runner.fulfillAndReconcile(orderId))
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof runner.fulfillAndReconcile>>>).value);
    expect(settlement.transferCalls).toBe(1);

    const winners = values.filter((v) => v.reconciled && !v.alreadyReconciled);
    expect(winners.length).toBe(1);
    for (const loser of values.filter((v) => v !== winners[0])) {
      expect(loser.reconciled === true ? loser.alreadyReconciled : loser.hold).toBeTruthy();
      if (!loser.reconciled) expect(loser.hold).toBe("RECONCILE_IN_PROGRESS");
    }

    expect(await stockOf(wsId)).toBe(startingStock + received);
    const journal = await query(`SELECT 1 FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(journal.rows.length).toBe(1);
    const order = await query(`SELECT status, tx_hash FROM orders WHERE id = $1;`, [orderId]);
    expect(order.rows[0].status).toBe("reconciled");
    expect(order.rows[0].tx_hash).toBe(winners[0].txHash);
  });

  it("a settlement failure leaves the order retryable and does not restock", async () => {
    const { wsId, orderId, startingStock, received } = await confirmedOrder();
    settlement.failNextTransfers = 1;

    await expect(runner.fulfillAndReconcile(orderId)).rejects.toThrow(/simulated settlement outage/);

    const afterFailure = await query(`SELECT status, tx_hash FROM orders WHERE id = $1;`, [orderId]);
    expect(afterFailure.rows[0].status).toBe("confirmed");
    expect(afterFailure.rows[0].tx_hash).toBeNull();
    expect(await stockOf(wsId)).toBe(startingStock);
    const noJournal = await query(`SELECT 1 FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(noJournal.rows.length).toBe(0);

    const retry = await runner.fulfillAndReconcile(orderId);
    expect(retry.reconciled).toBe(true);
    expect(retry.alreadyReconciled).toBeUndefined();
    expect(retry.txHash).toBeDefined();
    expect(settlement.transferCalls).toBe(2);
    // The retry presents the same idempotency key to the adapter.
    expect(settlement.idempotencyKeys).toEqual([`idem_pay_${orderId}`, `idem_pay_${orderId}`]);
    expect(await stockOf(wsId)).toBe(startingStock + received);

    // A failed first attempt must not leave duplicate receipts or bills behind.
    const receipts = await query(`SELECT 1 FROM delivery_receipts WHERE order_id = $1;`, [orderId]);
    const bills = await query(`SELECT 1 FROM supplier_bills WHERE order_id = $1;`, [orderId]);
    expect(receipts.rows.length).toBe(1);
    expect(bills.rows.length).toBe(1);
  });

  it("three_way_matches has one row per order after repeated calls", async () => {
    const { orderId } = await confirmedOrder();
    settlement.failNextTransfers = 1;

    await expect(runner.fulfillAndReconcile(orderId)).rejects.toThrow();
    await runner.fulfillAndReconcile(orderId);
    await runner.fulfillAndReconcile(orderId);
    await runner.fulfillAndReconcile(orderId);

    const matches = await query(`SELECT id, match_status FROM three_way_matches WHERE order_id = $1;`, [orderId]);
    expect(matches.rows.length).toBe(1);
    expect(matches.rows[0].id).toBe(`match_${orderId}`);
    expect(matches.rows[0].match_status).toBe(MatchStatus.MATCHED);
  });
});
