import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { authorizeCommitment } from "../../src/policy/commitment-gate.js";
import { PolicyDecision } from "../../src/policy/types.js";
import { TabLedger } from "../../src/tabs/ledger.js";
import { TabSpy, newCounterparty, newTabWorkspace, removeWorkspaces } from "../helpers/tab-spy.js";

/**
 * The daily budget is one sum on both sides (ADR 0081): an order's commitment gate counts today's tab settlements that own a
 * clear, and a tab's reserve counts today's order spend. Each test shows the side that is not otherwise checked.
 */

const created: string[] = [];
let counter = 0;

async function ws(label: string, budgetCents: number): Promise<string> {
  const id = await newTabWorkspace(label, { budgetCents });
  created.push(id);
  return id;
}

async function insertQuote(workspaceId: string, supplierId: string, totalCents: number): Promise<string> {
  counter += 1;
  const id = `quote_sym_${workspaceId}_${counter}`;
  await query(
    `INSERT INTO quotes (id, workspace_id, rfq_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, currency, valid_until)
     VALUES ($1, $2, $3, $4, 'Counterparty', 'FOOD-FLOUR-50LB', 10, $5, $6, 'USDC', NOW() + INTERVAL '1 day');`,
    [id, workspaceId, `rfq_${id}`, supplierId, Math.round(totalCents / 10), totalCents]
  );
  return id;
}

async function insertOrder(workspaceId: string, totalCents: number, status: string): Promise<void> {
  counter += 1;
  await query(
    `INSERT INTO orders (id, workspace_id, order_number, supplier_name, item_sku, item_name, quantity, unit_price_cents, total_price_cents, status, idempotency_key, created_at, updated_at)
     VALUES ($1, $2, $3, 'Counterparty', 'FOOD-OTHER', 'Other', 1, $4, $4, $5, $6, NOW(), NOW());`,
    [`ord_sym_${workspaceId}_${counter}`, workspaceId, `PO-SYM-${counter}`, totalCents, status, `idem_sym_${workspaceId}_${counter}`]
  );
}

function orderRequest(workspaceId: string, supplierId: string, quoteId: string, totalCents: number) {
  return {
    workspaceId,
    workflowId: `wf_sym_${workspaceId}_${counter}`,
    actorRole: "procurement_agent",
    supplierId,
    quoteId,
    quantity: 10,
    totalPriceCents: BigInt(totalCents),
  };
}

describe("order and tab spend share one daily budget (ADR 0081)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    await removeWorkspaces(created.splice(0));
  });

  afterAll(async () => {
    await closePool();
  });

  it("an order that fits the budget alone is refused when same-day tab settlements have used the budget", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("sym-order", 1000);
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 6_000_000n, idempotencyKey: "sym-t1", description: "Dish" });
    const settled = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    expect(settled).toMatchObject({ outcome: "settlement", status: "confirmed", amountCents: 600n });

    // 500 cents fits a 1000-cent budget on its own; with 600 cents of tab spend today it does not.
    const quote = await insertQuote(w, cp, 500);
    const decision = await authorizeCommitment(orderRequest(w, cp, quote, 500));

    expect(decision.decision).toBe(PolicyDecision.DENY);
    expect(decision.reasonCodes).toContain("DAILY_LIMIT_EXCEEDED");
    expect(decision.evidence.dailySpentCents).toBe("600");
  });

  it("a tab that fits the budget alone is refused when same-day orders have used the budget", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("sym-tab", 1000);
    const cp = await newCounterparty(w);
    await insertOrder(w, 600, "confirmed");
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 5_000_000n, idempotencyKey: "sym-t2", description: "Dish" });

    // 500 cents fits the budget alone; with 600 cents of order spend today it does not.
    const refused = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(refused).toEqual({ outcome: "refused", reason: "DAILY_LIMIT_EXCEEDED", balanceMicro: 5_000_000n });
    expect(spy.calls).toHaveLength(0);
  });

  it("an order and a tab that fit together are both allowed", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("sym-both", 1000);
    const cp = await newCounterparty(w);
    await insertOrder(w, 300, "confirmed");
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 3_000_000n, idempotencyKey: "sym-t3", description: "Dish" });

    const settled = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    const quote = await insertQuote(w, cp, 300);
    const decision = await authorizeCommitment(orderRequest(w, cp, quote, 300));

    expect(settled).toMatchObject({ outcome: "settlement", status: "confirmed", amountCents: 300n });
    expect(decision.decision).toBe(PolicyDecision.ALLOW);
    expect(decision.evidence.dailySpentCents).toBe("600");
  });
});
