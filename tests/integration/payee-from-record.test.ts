import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import type { Server } from "node:http";
import { getAddress } from "viem";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { OrderSettlementService } from "../../src/workflows/settlement.js";
import { createReplenishmentTools } from "../../src/agents/replenishmentTools.js";
import { MatchStatus } from "../../src/accounting/three-way-match.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { simulatedPaymentAddress } from "../../src/adapters/suppliers/payment-address.js";
import type {
  SettlementAdapter,
  TransferRequest,
  TransferResult,
} from "../../src/adapters/settlement/types.js";

/**
 * Counting settlement adapter. Records every transfer request so each payment can be
 * checked against the payee and payer it was made to.
 */
class PayeeSettlementAdapter implements SettlementAdapter {
  readonly mode = "local" as const;
  readonly requests: TransferRequest[] = [];

  get transferCalls(): number {
    return this.requests.length;
  }

  async getBalance(): Promise<bigint> {
    return 1_000_000n;
  }

  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    this.requests.push(req);
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

const FLOUR = "FOOD-FLOUR-50LB"; // preferred supplier: supp-sysco-metro, low stock, $245.00 order
const MILK = "FOOD-MILK-CASE"; // preferred supplier: supp-baldor-metro, made low stock below

describe("The payee comes from the verified supplier record", () => {
  const wsIds: string[] = [];
  let settlement: PayeeSettlementAdapter;
  let runner: ProcurementWorkflowRunner;

  beforeAll(async () => {
    await runMigrations();
  });

  beforeEach(() => {
    settlement = new PayeeSettlementAdapter();
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

  async function workspace(dailyLimitCents = 100000n): Promise<string> {
    const wsId = `ws-payee-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    wsIds.push(wsId);
    await provisionWorkspace(wsId, "Payee Kitchen", "kitchen-v1", {
      customDailyLimitCents: dailyLimitCents,
      customApprovalThresholdCents: 25000n,
    });
    return wsId;
  }

  async function orderFor(wsId: string, sku: string): Promise<{ orderId: string; supplierId: string }> {
    const started = await runner.startReplenishment(wsId, sku);
    expect(started.state).toBe(WorkflowState.CONFIRMED);
    const orderId = started.orderId!;
    const order = await query(`SELECT supplier_id FROM orders WHERE id = $1;`, [orderId]);
    return { orderId, supplierId: order.rows[0].supplier_id };
  }

  async function orderRow(orderId: string): Promise<any> {
    return (await query(`SELECT * FROM orders WHERE id = $1;`, [orderId])).rows[0];
  }

  async function paymentAddressOf(supplierId: string): Promise<string | null> {
    const res = await query(`SELECT payment_address FROM suppliers WHERE id = $1;`, [supplierId]);
    return res.rows[0].payment_address;
  }

  async function stockOf(wsId: string, sku: string): Promise<number> {
    const res = await query(
      `SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`,
      [wsId, sku]
    );
    return Number(res.rows[0].current_quantity);
  }

  it("settlement pays the supplier on the order, not a constant", async () => {
    const wsId = await workspace();
    await query(`UPDATE inventory_items SET current_quantity = 1 WHERE workspace_id = $1 AND sku = $2;`, [wsId, MILK]);
    const flour = await orderFor(wsId, FLOUR);
    const milk = await orderFor(wsId, MILK);
    expect(flour.supplierId).not.toBe(milk.supplierId);

    const flourResult = await runner.fulfillAndReconcile(flour.orderId, wsId);
    const milkResult = await runner.fulfillAndReconcile(milk.orderId, wsId);
    expect(flourResult.reconciled).toBe(true);
    expect(milkResult.reconciled).toBe(true);

    expect(settlement.requests.length).toBe(2);
    const toFlour = settlement.requests.find((r) => r.orderId === flour.orderId)!;
    const toMilk = settlement.requests.find((r) => r.orderId === milk.orderId)!;
    expect(toFlour.toAddress).toBe(await paymentAddressOf(flour.supplierId));
    expect(toMilk.toAddress).toBe(await paymentAddressOf(milk.supplierId));
    expect(toFlour.toAddress).toBe(simulatedPaymentAddress(flour.supplierId));
    expect(toMilk.toAddress).not.toBe(toFlour.toAddress);
  });

  it("an order whose supplier has no payment address is held as payment_hold and nothing is paid", async () => {
    const wsId = await workspace();
    const { orderId, supplierId } = await orderFor(wsId, FLOUR);
    const stockBefore = await stockOf(wsId, FLOUR);
    await query(`UPDATE suppliers SET payment_address = NULL WHERE id = $1;`, [supplierId]);

    const result = await runner.fulfillAndReconcile(orderId, wsId);
    expect(result).toEqual({
      status: MatchStatus.MATCHED,
      reconciled: false,
      hold: "SUPPLIER_PAYMENT_ADDRESS_MISSING",
    });

    expect(settlement.transferCalls).toBe(0);
    const order = await orderRow(orderId);
    expect(order.status).toBe("payment_hold");
    expect(order.tx_hash).toBeNull();
    expect(await stockOf(wsId, FLOUR)).toBe(stockBefore);

    const journal = await query(`SELECT 1 FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(journal.rows.length).toBe(0);
    const match = await query(`SELECT match_status FROM three_way_matches WHERE order_id = $1;`, [orderId]);
    expect(match.rows[0].match_status).toBe(MatchStatus.MATCHED);

    const audit = await query(
      `SELECT actor_type, actor_id, policy_decision, evidence FROM audit_logs
       WHERE workspace_id = $1 AND action = 'settlement.payment_hold';`,
      [wsId]
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0]).toMatchObject({
      actor_type: "system",
      actor_id: "settlement_engine",
      policy_decision: "DENY",
    });
    expect(audit.rows[0].evidence).toMatchObject({ orderId, hold: "SUPPLIER_PAYMENT_ADDRESS_MISSING" });
  });

  it("an unverified supplier is never paid", async () => {
    const wsId = await workspace();
    const { orderId, supplierId } = await orderFor(wsId, FLOUR);
    await query(`UPDATE suppliers SET verified = FALSE WHERE id = $1;`, [supplierId]);

    const result = await runner.fulfillAndReconcile(orderId, wsId);
    expect(result).toEqual({ status: MatchStatus.MATCHED, reconciled: false, hold: "SUPPLIER_NOT_VERIFIED" });
    expect(settlement.transferCalls).toBe(0);
    expect((await orderRow(orderId)).status).toBe("payment_hold");
  });

  it("a workspace without a settlement address is held, with no deployer fallback", async () => {
    const wsId = await workspace();
    const { orderId } = await orderFor(wsId, FLOUR);
    await query(`UPDATE workspaces SET settlement_address = NULL WHERE id = $1;`, [wsId]);

    // A new arc-testnet workspace provisioned without an address also stores NULL, not a constant.
    const arcWsId = `ws-payee-arc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    wsIds.push(arcWsId);
    await provisionWorkspace(arcWsId, "Arc Payee Kitchen", "kitchen-v1", { settlementMode: "arc-testnet" });
    const arc = await query(`SELECT settlement_address FROM workspaces WHERE id = $1;`, [arcWsId]);
    expect(arc.rows[0].settlement_address).toBeNull();

    const result = await runner.fulfillAndReconcile(orderId, wsId);
    expect(result).toEqual({
      status: MatchStatus.MATCHED,
      reconciled: false,
      hold: "WORKSPACE_SETTLEMENT_ADDRESS_MISSING",
    });
    expect(settlement.transferCalls).toBe(0);
    expect((await orderRow(orderId)).status).toBe("payment_hold");
  });

  it("a held order settles once the payment address is added, and pays once", async () => {
    const wsId = await workspace();
    const { orderId, supplierId } = await orderFor(wsId, FLOUR);
    const stockBefore = await stockOf(wsId, FLOUR);
    const received = Number((await orderRow(orderId)).quantity);
    const address = simulatedPaymentAddress(supplierId);

    await query(`UPDATE suppliers SET payment_address = NULL WHERE id = $1;`, [supplierId]);
    const held = await runner.fulfillAndReconcile(orderId, wsId);
    expect(held.hold).toBe("SUPPLIER_PAYMENT_ADDRESS_MISSING");
    expect(settlement.transferCalls).toBe(0);

    await query(`UPDATE suppliers SET payment_address = $2 WHERE id = $1;`, [supplierId, address]);
    const paid = await runner.fulfillAndReconcile(orderId, wsId);
    expect(paid.reconciled).toBe(true);
    expect(paid.txHash).toBeDefined();
    expect(paid.alreadyReconciled).toBeUndefined();
    expect(settlement.transferCalls).toBe(1);
    expect(settlement.requests[0].toAddress).toBe(address);

    const again = await runner.fulfillAndReconcile(orderId, wsId);
    expect(again).toMatchObject({ reconciled: true, alreadyReconciled: true, txHash: paid.txHash });
    expect(settlement.transferCalls).toBe(1);

    expect((await orderRow(orderId)).status).toBe("reconciled");
    expect(await stockOf(wsId, FLOUR)).toBe(stockBefore + received);
    // The held attempt and the paying attempt reuse one receipt and one bill.
    const receipts = await query(`SELECT 1 FROM delivery_receipts WHERE order_id = $1;`, [orderId]);
    const bills = await query(`SELECT 1 FROM supplier_bills WHERE order_id = $1;`, [orderId]);
    expect(receipts.rows.length).toBe(1);
    expect(bills.rows.length).toBe(1);
  });

  it("a payment_hold order still counts toward the daily budget", async () => {
    const wsId = await workspace(30000n); // $300.00 daily limit; the flour order is $245.00
    const { orderId, supplierId } = await orderFor(wsId, FLOUR);
    await query(`UPDATE suppliers SET payment_address = NULL WHERE id = $1;`, [supplierId]);
    await runner.fulfillAndReconcile(orderId, wsId);
    expect((await orderRow(orderId)).status).toBe("payment_hold");

    const tools = createReplenishmentTools({ workspaceId: wsId, workflowId: "wf_unused" });
    const ctx = JSON.parse(await tools.getBusinessContextTool.invoke({}));
    expect(ctx.todayCumulativeSpentCents).toBe("24500");
    expect(ctx.remainingDailyBudgetCents).toBe("5500");
  });

  it("POST suppliers rejects a malformed paymentAddress with 400 and stores a valid one checksummed", async () => {
    const app = createApp();
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address();
    const baseUrl = addr && typeof addr === "object" ? `http://127.0.0.1:${addr.port}` : "";
    try {
      const wsId = await workspace();
      const ownerToken = (await issueToken(wsId, "owner", "payee-owner")).token;
      const suppId = "supp-payee-route";
      const post = async (paymentAddress: unknown) => {
        const res = await fetch(`${baseUrl}/api/workspaces/${wsId}/suppliers`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
          body: JSON.stringify({
            id: suppId,
            name: "Route Payee Supplier",
            adapterType: "manual_quote",
            verified: true,
            isSimulated: false,
            paymentAddress,
          }),
        });
        return { status: res.status, body: (await res.json()) as any };
      };

      const short = await post("0x1234");
      expect(short.status).toBe(400);
      expect(short.body).toMatchObject({ error: "paymentAddress must be a valid EVM address" });

      const nonHex = await post("0x" + "g".repeat(40));
      expect(nonHex.status).toBe(400);
      expect(nonHex.body).toMatchObject({ error: "paymentAddress must be a valid EVM address" });

      const notString = await post(12345);
      expect(notString.status).toBe(400);
      expect(notString.body).toMatchObject({ error: "paymentAddress must be a valid EVM address" });

      const fullId = `${wsId}_${suppId}`;
      expect((await query(`SELECT 1 FROM suppliers WHERE id = $1;`, [fullId])).rows.length).toBe(0);

      const lower = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
      const created = await post(lower);
      expect(created.status).toBe(201);
      expect(created.body.payment_address).toBe(getAddress(lower));
      expect(await paymentAddressOf(fullId)).toBe(getAddress(lower));

      // Re-posting the supplier with a new valid address updates the stored value (ON CONFLICT path).
      const other = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc";
      const updated = await post(other);
      expect(updated.status).toBe(201);
      expect(await paymentAddressOf(fullId)).toBe(getAddress(other));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("simulatedPaymentAddress matches the SQL backfill", async () => {
    const wsId = `ws-payee-backfill-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    wsIds.push(wsId);
    await query(`INSERT INTO workspaces (id, name, template_id) VALUES ($1, 'Backfill Check', 'kitchen-v1');`, [wsId]);
    const suppId = `${wsId}_supp-backfill-check`;
    await query(
      `INSERT INTO suppliers (id, workspace_id, name, adapter_type, is_simulated)
       VALUES ($1, $2, 'Backfill Check Supplier', 'simulated_sysco', TRUE);`,
      [suppId, wsId]
    );

    await runMigrations();

    expect(await paymentAddressOf(suppId)).toBe(simulatedPaymentAddress(suppId));
  });

  it("callers racing for a held order never throw and never pay", async () => {
    const wsId = await workspace();
    const { orderId, supplierId } = await orderFor(wsId, FLOUR);
    await query(`UPDATE suppliers SET payment_address = NULL WHERE id = $1;`, [supplierId]);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => runner.fulfillAndReconcile(orderId, wsId))
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const values = results.map((r) => (r as PromiseFulfilledResult<any>).value);
    for (const value of values) {
      expect(value.reconciled).toBe(false);
      expect(["SUPPLIER_PAYMENT_ADDRESS_MISSING", "RECONCILE_IN_PROGRESS"]).toContain(value.hold);
    }
    expect(settlement.transferCalls).toBe(0);
    expect((await orderRow(orderId)).status).toBe("payment_hold");
  });

  it("a held order stays payment_hold when evidence loading fails on retry", async () => {
    const wsId = await workspace();
    const { orderId, supplierId } = await orderFor(wsId, FLOUR);
    await query(`UPDATE suppliers SET payment_address = NULL WHERE id = $1;`, [supplierId]);
    expect((await runner.fulfillAndReconcile(orderId, wsId)).hold).toBe("SUPPLIER_PAYMENT_ADDRESS_MISSING");
    expect((await orderRow(orderId)).status).toBe("payment_hold");

    const service = new OrderSettlementService({ settlementFor: () => settlement });
    await expect(
      service.settle(orderId, async () => {
        throw new Error("evidence source unavailable");
      })
    ).rejects.toThrow(/evidence source unavailable/);

    expect((await orderRow(orderId)).status).toBe("payment_hold");
    expect(settlement.transferCalls).toBe(0);
  });

  it("a held order stays payment_hold when the match is not MATCHED on retry", async () => {
    const wsId = await workspace();
    const { orderId, supplierId } = await orderFor(wsId, FLOUR);
    await query(`UPDATE suppliers SET payment_address = NULL WHERE id = $1;`, [supplierId]);
    expect((await runner.fulfillAndReconcile(orderId, wsId)).hold).toBe("SUPPLIER_PAYMENT_ADDRESS_MISSING");

    // Stored bill now overcharges by $1.00 per unit, so the retry's match is a price discrepancy.
    await query(
      `UPDATE supplier_bills
       SET billed_unit_price_cents = billed_unit_price_cents + 100,
           billed_total_cents = (billed_unit_price_cents + 100) * billed_quantity
       WHERE order_id = $1;`,
      [orderId]
    );
    const retry = await runner.fulfillAndReconcile(orderId, wsId);
    expect(retry).toEqual({ status: MatchStatus.PRICE_DISCREPANCY, reconciled: false });

    expect((await orderRow(orderId)).status).toBe("payment_hold");
    expect(settlement.transferCalls).toBe(0);
  });

  it("a supplier from another workspace is never paid", async () => {
    const wsA = await workspace();
    const wsB = await workspace();
    const { orderId } = await orderFor(wsA, FLOUR);
    const foreignSupplier = `${wsB}_supp-sysco-metro`;
    const foreign = await query(`SELECT verified, payment_address FROM suppliers WHERE id = $1;`, [foreignSupplier]);
    expect(foreign.rows[0].verified).toBe(true);
    expect(foreign.rows[0].payment_address).not.toBeNull();

    // Point workspace A's order at workspace B's verified, payable supplier record.
    await query(`UPDATE orders SET supplier_id = $2 WHERE id = $1;`, [orderId, foreignSupplier]);

    const result = await runner.fulfillAndReconcile(orderId, wsA);
    expect(result).toEqual({ status: MatchStatus.MATCHED, reconciled: false, hold: "SUPPLIER_NOT_VERIFIED" });
    expect(settlement.transferCalls).toBe(0);
    expect((await orderRow(orderId)).status).toBe("payment_hold");
  });

  it("callers racing while evidence is pending never throw and never pay", async () => {
    const wsId = await workspace();
    const { orderId } = await orderFor(wsId, FLOUR);
    const service = new OrderSettlementService({ settlementFor: () => settlement });
    const pendingLoader = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { pending: "AWAITING_DELIVERY_RECEIPT" as const };
    };

    // 30 callers: the claim-to-read window is a few ms and the pool has 20 connections, so the
    // reads queue behind the holder's release. Ten callers did not reproduce the race in 8 runs.
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () => service.settle(orderId, pendingLoader))
    );

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const values = results.map((r) => (r as PromiseFulfilledResult<any>).value);
    for (const value of values) {
      expect(value.reconciled).toBe(false);
      expect(["AWAITING_DELIVERY_RECEIPT", "RECONCILE_IN_PROGRESS"]).toContain(value.pending ?? value.hold);
    }
    expect(settlement.transferCalls).toBe(0);
    expect((await orderRow(orderId)).status).toBe("confirmed");
  });
});
