import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { OrderSettlementService } from "../../src/workflows/settlement.js";
import { extractDocumentDraft, confirmStagedDocument } from "../../src/studio/documentsAndAccounting.js";
import { MatchStatus } from "../../src/accounting/three-way-match.js";
import { WorkflowState } from "../../src/workflows/types.js";
import type {
  SettlementAdapter,
  TransferRequest,
  TransferResult,
} from "../../src/adapters/settlement/types.js";

/**
 * Counting settlement adapter shared by the runner and the studio route, so a
 * payment made through either path is visible in one counter.
 */
class CountingSettlementAdapter implements SettlementAdapter {
  readonly mode = "local" as const;
  transferCalls = 0;
  readonly idempotencyKeys: string[] = [];
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
    const txHash = `0x${crypto.createHash("sha256").update(req.idempotencyKey).digest("hex")}`;
    return { txHash, status: "submitted", timestamp: new Date(), mode: "local", simulated: true };
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

const SKU = "FOOD-FLOUR-50LB";

describe("Studio confirmation and runner settle an order exactly once", () => {
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

  function studio(): OrderSettlementService {
    return new OrderSettlementService({ settlementFor: () => settlement });
  }

  async function confirmedOrder(): Promise<{ wsId: string; orderId: string; startingStock: number; received: number }> {
    const wsId = `ws-settle-once-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    wsIds.push(wsId);
    await provisionWorkspace(wsId, "Settle Once Kitchen", "kitchen-v1", {
      customDailyLimitCents: 100000n,
      customApprovalThresholdCents: 25000n,
    });
    const started = await runner.startReplenishment(wsId, SKU);
    expect(started.state).toBe(WorkflowState.CONFIRMED);
    const orderId = started.orderId!;
    const stock = await query(
      `SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`,
      [wsId, SKU]
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
      `SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`,
      [wsId, SKU]
    );
    return Number(res.rows[0].current_quantity);
  }

  /**
   * Extracts and owner-confirms one document through the studio route. Quantity and unit
   * price default to the purchase order, so a default document matches it exactly.
   */
  async function stageAndConfirm(
    wsId: string,
    orderId: string,
    docType: "delivery_receipt" | "supplier_bill",
    overrides: { unitPriceCents?: number } = {}
  ): Promise<any> {
    const order = (await query(`SELECT quantity, unit_price_cents FROM orders WHERE id = $1;`, [orderId])).rows[0];
    const qty = Number(order.quantity);
    const unit = overrides.unitPriceCents ?? Number(order.unit_price_cents);
    const rawText =
      docType === "delivery_receipt"
        ? `Delivery note\nSKU: ${SKU}\nQty: ${qty}`
        : `Invoice #: INV-${Math.random().toString(36).slice(2, 8).toUpperCase()}\nSKU: ${SKU}\nQty: ${qty}\nUnit Price: $${(unit / 100).toFixed(2)}\nTotal: $${((qty * unit) / 100).toFixed(2)}`;
    const draft = await extractDocumentDraft(wsId, {
      docType,
      sourceLabel: "settle_once_test",
      rawText,
      linkedOrderId: orderId,
    });
    return confirmStagedDocument(
      wsId,
      draft.docId,
      { decidedBy: "owner@bind.local", linkedOrderId: orderId },
      studio()
    );
  }

  it("confirming a matching receipt and bill twice pays and restocks once", async () => {
    const { wsId, orderId, startingStock, received } = await confirmedOrder();

    const receipt = await stageAndConfirm(wsId, orderId, "delivery_receipt");
    expect(receipt.pending).toBe("AWAITING_SUPPLIER_BILL");

    const bill = await stageAndConfirm(wsId, orderId, "supplier_bill");
    expect(bill).toMatchObject({ matchStatus: MatchStatus.MATCHED, reconciled: true });
    expect(bill.txHash).toBeDefined();
    expect(settlement.transferCalls).toBe(1);

    // Confirming the same bill document again is a replay, not a second settlement.
    const replay = await confirmStagedDocument(
      wsId,
      bill.docId,
      { decidedBy: "owner@bind.local", linkedOrderId: orderId },
      studio()
    );
    expect(replay.idempotentReplay).toBe(true);

    // A second, identical bill document for the same order returns the stored result.
    const secondBill = await stageAndConfirm(wsId, orderId, "supplier_bill");
    expect(secondBill).toMatchObject({ reconciled: true, alreadyReconciled: true, txHash: bill.txHash });

    expect(settlement.transferCalls).toBe(1);
    expect(settlement.idempotencyKeys).toEqual([`idem_pay_${orderId}`]);
    expect(await stockOf(wsId)).toBe(startingStock + received);
    const journal = await query(`SELECT tx_hash FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(journal.rows.length).toBe(1);
    expect(journal.rows[0].tx_hash).toBe(bill.txHash);
    const order = await query(`SELECT status, tx_hash FROM orders WHERE id = $1;`, [orderId]);
    expect(order.rows[0].status).toBe("reconciled");
    expect(order.rows[0].tx_hash).toBe(bill.txHash);
  });

  it("a bill alone never settles and returns pending AWAITING_DELIVERY_RECEIPT with no receipt row created", async () => {
    const { wsId, orderId, startingStock } = await confirmedOrder();

    const bill = await stageAndConfirm(wsId, orderId, "supplier_bill");
    expect(bill).toMatchObject({ pending: "AWAITING_DELIVERY_RECEIPT", matchStatus: "UNMATCHED", reconciled: false });
    expect(bill.txHash).toBeUndefined();

    expect(settlement.transferCalls).toBe(0);
    const receipts = await query(`SELECT 1 FROM delivery_receipts WHERE order_id = $1;`, [orderId]);
    expect(receipts.rows.length).toBe(0);
    const matches = await query(`SELECT 1 FROM three_way_matches WHERE order_id = $1;`, [orderId]);
    expect(matches.rows.length).toBe(0);
    const order = await query(`SELECT status FROM orders WHERE id = $1;`, [orderId]);
    expect(order.rows[0].status).toBe("confirmed");
    expect(await stockOf(wsId)).toBe(startingStock);
  });

  it("a receipt alone never settles and returns pending AWAITING_SUPPLIER_BILL with no bill row created", async () => {
    const { wsId, orderId, startingStock } = await confirmedOrder();

    const receipt = await stageAndConfirm(wsId, orderId, "delivery_receipt");
    expect(receipt).toMatchObject({ pending: "AWAITING_SUPPLIER_BILL", matchStatus: "UNMATCHED", reconciled: false });
    expect(receipt.txHash).toBeUndefined();

    expect(settlement.transferCalls).toBe(0);
    const bills = await query(`SELECT 1 FROM supplier_bills WHERE order_id = $1;`, [orderId]);
    expect(bills.rows.length).toBe(0);
    const matches = await query(`SELECT 1 FROM three_way_matches WHERE order_id = $1;`, [orderId]);
    expect(matches.rows.length).toBe(0);
    const order = await query(`SELECT status FROM orders WHERE id = $1;`, [orderId]);
    expect(order.rows[0].status).toBe("confirmed");
    expect(await stockOf(wsId)).toBe(startingStock);
  });

  it("studio confirmation then runner reconcile pays once, and runner then studio pays once", async () => {
    // Studio settles first; the runner then finds the order reconciled.
    const a = await confirmedOrder();
    await stageAndConfirm(a.wsId, a.orderId, "delivery_receipt");
    const studioPaid = await stageAndConfirm(a.wsId, a.orderId, "supplier_bill");
    expect(studioPaid.reconciled).toBe(true);

    const runnerAfterStudio = await runner.fulfillAndReconcile(a.orderId, a.wsId);
    expect(runnerAfterStudio).toMatchObject({
      reconciled: true,
      alreadyReconciled: true,
      txHash: studioPaid.txHash,
    });
    expect(settlement.transferCalls).toBe(1);

    // The runner settles first from supplier-generated documents; the studio then finds it reconciled.
    const b = await confirmedOrder();
    const runnerPaid = await runner.fulfillAndReconcile(b.orderId, b.wsId);
    expect(runnerPaid.reconciled).toBe(true);
    expect(runnerPaid.alreadyReconciled).toBeUndefined();

    const studioAfterRunner = await stageAndConfirm(b.wsId, b.orderId, "supplier_bill");
    expect(studioAfterRunner).toMatchObject({
      reconciled: true,
      alreadyReconciled: true,
      txHash: runnerPaid.txHash,
    });
    expect(settlement.transferCalls).toBe(2);
    expect(await stockOf(b.wsId)).toBe(b.startingStock + b.received);
  });

  it("concurrent studio confirm and runner reconcile on one order settle once", async () => {
    const { wsId, orderId, startingStock, received } = await confirmedOrder();
    await stageAndConfirm(wsId, orderId, "delivery_receipt");
    settlement.delayMs = 150; // hold the claim open so the two callers really race

    const [runnerResult, studioResult] = await Promise.all([
      runner.fulfillAndReconcile(orderId, wsId),
      stageAndConfirm(wsId, orderId, "supplier_bill"),
    ]);

    expect(settlement.transferCalls).toBe(1);
    const results = [runnerResult, studioResult];
    const paid = results.filter((r) => r.reconciled && !r.alreadyReconciled);
    expect(paid.length).toBe(1);
    for (const other of results.filter((r) => r !== paid[0])) {
      if (other.reconciled) {
        expect(other).toMatchObject({ alreadyReconciled: true, txHash: paid[0].txHash });
      } else {
        expect(other).toMatchObject({ reconciled: false, hold: "RECONCILE_IN_PROGRESS" });
        expect(other.txHash).toBeUndefined();
      }
    }

    expect(await stockOf(wsId)).toBe(startingStock + received);
    const journal = await query(`SELECT 1 FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(journal.rows.length).toBe(1);
    const order = await query(`SELECT status, tx_hash FROM orders WHERE id = $1;`, [orderId]);
    expect(order.rows[0].status).toBe("reconciled");
    expect(order.rows[0].tx_hash).toBe(paid[0].txHash);
  });

  it("a PRICE_DISCREPANCY bill leaves an accounting.three_way_match_failed audit row, and a later matching bill settles once", async () => {
    const { wsId, orderId, startingStock, received } = await confirmedOrder();
    const order = (await query(`SELECT unit_price_cents FROM orders WHERE id = $1;`, [orderId])).rows[0];
    const contractedUnit = Number(order.unit_price_cents);
    await stageAndConfirm(wsId, orderId, "delivery_receipt");

    const bad = await stageAndConfirm(wsId, orderId, "supplier_bill", { unitPriceCents: contractedUnit + 100 });
    expect(bad).toMatchObject({ matchStatus: MatchStatus.PRICE_DISCREPANCY, reconciled: false });
    expect(settlement.transferCalls).toBe(0);

    const audits = await query(
      `SELECT actor_type, actor_id, effect_class, policy_decision, evidence
         FROM audit_logs WHERE workspace_id = $1 AND action = 'accounting.three_way_match_failed';`,
      [wsId]
    );
    expect(audits.rows.length).toBe(1);
    expect(audits.rows[0]).toMatchObject({
      actor_type: "system",
      actor_id: "three_way_match_engine",
      effect_class: "commercial_commitment",
      policy_decision: "DENY",
    });
    expect(audits.rows[0].evidence).toEqual({
      orderId,
      matchStatus: MatchStatus.PRICE_DISCREPANCY,
      varianceCents: bad.varianceCents,
      discrepancyReason: expect.any(String),
    });

    const stillConfirmed = await query(`SELECT status FROM orders WHERE id = $1;`, [orderId]);
    expect(stillConfirmed.rows[0].status).toBe("confirmed");

    const good = await stageAndConfirm(wsId, orderId, "supplier_bill");
    expect(good).toMatchObject({ matchStatus: MatchStatus.MATCHED, reconciled: true });
    expect(settlement.transferCalls).toBe(1);
    expect(await stockOf(wsId)).toBe(startingStock + received);
    const journal = await query(`SELECT 1 FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(journal.rows.length).toBe(1);
    const failedAfter = await query(
      `SELECT 1 FROM audit_logs WHERE workspace_id = $1 AND action = 'accounting.three_way_match_failed';`,
      [wsId]
    );
    expect(failedAfter.rows.length).toBe(1);
  });

  it("a studio confirmation of an order in settling returns RECONCILE_IN_PROGRESS", async () => {
    const { wsId, orderId, startingStock } = await confirmedOrder();
    await stageAndConfirm(wsId, orderId, "delivery_receipt");
    await query(`UPDATE orders SET status = 'settling' WHERE id = $1;`, [orderId]);

    const bill = await stageAndConfirm(wsId, orderId, "supplier_bill");
    expect(bill).toMatchObject({ hold: "RECONCILE_IN_PROGRESS", reconciled: false, matchStatus: MatchStatus.UNMATCHED });
    expect(bill.txHash).toBeUndefined();
    expect(settlement.transferCalls).toBe(0);
    const order = await query(`SELECT status FROM orders WHERE id = $1;`, [orderId]);
    expect(order.rows[0].status).toBe("settling");
    expect(await stockOf(wsId)).toBe(startingStock);
  });
});
