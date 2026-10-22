import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { MatchStatus } from "../../src/accounting/three-way-match.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { getSupplierAdapter } from "../../src/adapters/suppliers/index.js";
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
  /** Transfers this adapter actually made, by order id. An outage throws before anything is recorded here. */
  private readonly madeByOrder = new Map<string, TransferResult>();

  async getBalance(): Promise<bigint> {
    return 1_000_000n;
  }

  /** Answers "did you make this transfer": the transfer made for the order, or null when none was made. */
  async findTransfer(req: { orderId: string }): Promise<TransferResult | null> {
    return this.madeByOrder.get(req.orderId) ?? null;
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
    const made: TransferResult = { txHash, status: "submitted", timestamp: new Date(), mode: "local", simulated: true };
    if (!this.madeByOrder.has(req.orderId)) this.madeByOrder.set(req.orderId, made);
    return made;
  }

  async confirm(txHash: string): Promise<TransferResult> {
    return { txHash, status: "confirmed", timestamp: new Date(), mode: "local", simulated: true };
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

    const first = await runner.fulfillAndReconcile(orderId, wsId);
    expect(first.status).toBe(MatchStatus.MATCHED);
    expect(first.reconciled).toBe(true);
    expect(first.txHash).toBeDefined();
    expect(first.alreadyReconciled).toBeUndefined();

    const second = await runner.fulfillAndReconcile(orderId, wsId);
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
      Array.from({ length: 5 }, () => runner.fulfillAndReconcile(orderId, wsId))
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof runner.fulfillAndReconcile>>>).value);
    expect(settlement.transferCalls).toBe(1);

    // The adapter holds the claim for 150ms, so every other caller sees `settling`.
    const winners = values.filter((v) => v.reconciled);
    const losers = values.filter((v) => !v.reconciled);
    expect(winners.length).toBe(1);
    expect(winners[0].alreadyReconciled).toBeUndefined();
    expect(losers.length).toBe(4);
    for (const loser of losers) {
      expect(loser).toMatchObject({ reconciled: false, hold: "RECONCILE_IN_PROGRESS" });
      expect(loser.txHash).toBeUndefined();
      expect(loser.alreadyReconciled).toBeUndefined();
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

    await expect(runner.fulfillAndReconcile(orderId, wsId)).rejects.toThrow(/simulated settlement outage/);

    const afterFailure = await query(`SELECT status, tx_hash FROM orders WHERE id = $1;`, [orderId]);
    expect(afterFailure.rows[0].status).toBe("confirmed");
    expect(afterFailure.rows[0].tx_hash).toBeNull();
    expect(await stockOf(wsId)).toBe(startingStock);
    const noJournal = await query(`SELECT 1 FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(noJournal.rows.length).toBe(0);

    const retry = await runner.fulfillAndReconcile(orderId, wsId);
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
    const { wsId, orderId } = await confirmedOrder();
    settlement.failNextTransfers = 1;

    await expect(runner.fulfillAndReconcile(orderId, wsId)).rejects.toThrow();
    await runner.fulfillAndReconcile(orderId, wsId);
    await runner.fulfillAndReconcile(orderId, wsId);
    await runner.fulfillAndReconcile(orderId, wsId);

    const matches = await query(`SELECT id, match_status FROM three_way_matches WHERE order_id = $1;`, [orderId]);
    expect(matches.rows.length).toBe(1);
    expect(matches.rows[0].id).toBe(`match_${orderId}`);
    expect(matches.rows[0].match_status).toBe(MatchStatus.MATCHED);
  });

  it("a caller arriving while settlement is in flight gets the exact hold shape", async () => {
    const { wsId, orderId } = await confirmedOrder();
    settlement.delayMs = 300;

    const winner = runner.fulfillAndReconcile(orderId, wsId);
    while (settlement.transferCalls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // The match row was stored before the adapter was called, so it is reported.
    const during = await runner.fulfillAndReconcile(orderId, wsId);
    expect(during).toEqual({ status: MatchStatus.MATCHED, reconciled: false, hold: "RECONCILE_IN_PROGRESS" });
    await winner;
    expect(settlement.transferCalls).toBe(1);
  });

  it("a hold with no stored match row does not claim MATCHED", async () => {
    const { wsId, orderId } = await confirmedOrder();
    await query(`UPDATE orders SET status = 'settling' WHERE id = $1;`, [orderId]);
    const result = await runner.fulfillAndReconcile(orderId, wsId);
    expect(result).toEqual({ status: MatchStatus.UNMATCHED, reconciled: false, hold: "RECONCILE_IN_PROGRESS" });
    expect(settlement.transferCalls).toBe(0);
  });

  it("releases the claim after a non-MATCHED result and pays nothing", async () => {
    const { wsId, orderId, startingStock } = await confirmedOrder();
    const base = getSupplierAdapter("supp-sysco-metro");
    const overbilling = Object.assign(Object.create(base), {
      generateBill: async (...args: Parameters<typeof base.generateBill>) => {
        const bill = await base.generateBill(...args);
        return {
          ...bill,
          billedUnitPriceCents: bill.billedUnitPriceCents + 100n,
          billedTotalCents: (bill.billedUnitPriceCents + 100n) * BigInt(Math.round(bill.billedQuantity)),
        };
      },
    });
    const mismatchRunner = new ProcurementWorkflowRunner({
      settlementFor: () => settlement,
      supplierFor: () => overbilling,
    });

    const result = await mismatchRunner.fulfillAndReconcile(orderId, wsId);
    expect(result).toEqual({ status: MatchStatus.PRICE_DISCREPANCY, reconciled: false });
    expect(settlement.transferCalls).toBe(0);
    const order = await query(`SELECT status, tx_hash FROM orders WHERE id = $1;`, [orderId]);
    expect(order.rows[0].status).toBe("confirmed");
    expect(order.rows[0].tx_hash).toBeNull();
    expect(await stockOf(wsId)).toBe(startingStock);
  });

  it("refuses an order that is not confirmed, settling or reconciled, and an unknown order", async () => {
    const { wsId, orderId } = await confirmedOrder();
    await query(`UPDATE orders SET status = 'cancelled' WHERE id = $1;`, [orderId]);
    await expect(runner.fulfillAndReconcile(orderId, wsId)).rejects.toThrow(/status 'cancelled' and cannot be reconciled/);
    await expect(runner.fulfillAndReconcile("ord_does_not_exist", wsId)).rejects.toThrow(/not found/);
    expect(settlement.transferCalls).toBe(0);
    const order = await query(`SELECT status FROM orders WHERE id = $1;`, [orderId]);
    expect(order.rows[0].status).toBe("cancelled");
  });

  it("uses the latest receipt on retry and records the latest match", async () => {
    const { wsId, orderId, received } = await confirmedOrder();
    settlement.failNextTransfers = 1;
    await expect(runner.fulfillAndReconcile(orderId, wsId)).rejects.toThrow(/simulated settlement outage/);

    await query(
      `INSERT INTO delivery_receipts (id, order_id, received_quantity, received_at, condition_notes, discrepancy_reported)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 minute', 'short delivery', TRUE);`,
      [`dr_late_${orderId}`, orderId, received - 1]
    );
    const retry = await runner.fulfillAndReconcile(orderId, wsId);
    expect(retry).toEqual({ status: MatchStatus.QUANTITY_DISCREPANCY, reconciled: false });
    expect(settlement.transferCalls).toBe(1); // only the failed first attempt
    const match = await query(`SELECT match_status FROM three_way_matches WHERE order_id = $1;`, [orderId]);
    expect(match.rows.length).toBe(1);
    expect(match.rows[0].match_status).toBe(MatchStatus.QUANTITY_DISCREPANCY);
  });

  it("keeps the order settlement_submitted with the payment recorded when the finalising step fails", async () => {
    const { wsId, orderId, startingStock } = await confirmedOrder();
    await query(`
      CREATE OR REPLACE FUNCTION test_block_restock() RETURNS trigger AS $f$
      BEGIN RAISE EXCEPTION 'simulated database failure after payment'; END;
      $f$ LANGUAGE plpgsql;`);
    await query(
      `CREATE TRIGGER test_block_restock BEFORE UPDATE ON inventory_items
       FOR EACH ROW WHEN (NEW.workspace_id = '${wsId}') EXECUTE FUNCTION test_block_restock();`
    );
    try {
      await expect(runner.fulfillAndReconcile(orderId, wsId)).rejects.toThrow(/simulated database failure after payment/);
    } finally {
      await query(`DROP TRIGGER IF EXISTS test_block_restock ON inventory_items;`);
      await query(`DROP FUNCTION IF EXISTS test_block_restock();`);
    }

    const expectedHash = `0x${crypto.createHash("sha256").update(`idem_pay_${orderId}`).digest("hex")}`;
    const order = await query(`SELECT status, tx_hash FROM orders WHERE id = $1;`, [orderId]);
    // ADR 0078: the transfer is stored as submitted before confirmation, and a failed finalising step releases the
    // confirmation claim to settlement_submitted. The payment is still recorded and never repeated.
    expect(order.rows[0].status).toBe("settlement_submitted");
    expect(order.rows[0].tx_hash).toBe(expectedHash);
    expect(await stockOf(wsId)).toBe(startingStock);

    const again = await runner.fulfillAndReconcile(orderId, wsId);
    expect(again).toEqual({
      status: MatchStatus.MATCHED,
      reconciled: false,
      txHash: expectedHash,
      pending: "AWAITING_SETTLEMENT_CONFIRMATION",
    });
    expect(settlement.transferCalls).toBe(1);
  });

  it("rethrows the settlement error even when releasing the claim also fails", async () => {
    const { wsId, orderId } = await confirmedOrder();
    settlement.failNextTransfers = 1;
    await query(`
      CREATE OR REPLACE FUNCTION test_block_release() RETURNS trigger AS $f$
      BEGIN RAISE EXCEPTION 'release blocked'; END;
      $f$ LANGUAGE plpgsql;`);
    await query(
      `CREATE TRIGGER test_block_release BEFORE UPDATE ON orders
       FOR EACH ROW WHEN (OLD.status = 'settling' AND NEW.status = 'confirmed' AND NEW.id = '${orderId}')
       EXECUTE FUNCTION test_block_release();`
    );
    try {
      await expect(runner.fulfillAndReconcile(orderId, wsId)).rejects.toThrow(/simulated settlement outage/);
    } finally {
      await query(`DROP TRIGGER IF EXISTS test_block_release ON orders;`);
      await query(`DROP FUNCTION IF EXISTS test_block_release();`);
    }
    const order = await query(`SELECT status FROM orders WHERE id = $1;`, [orderId]);
    expect(order.rows[0].status).toBe("settling");
  });
});
