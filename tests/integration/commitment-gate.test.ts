import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { authorizeCommitment } from "../../src/policy/commitment-gate.js";
import { PolicyDecision } from "../../src/policy/types.js";

const run = Date.now();
const wsA = `ws-gate-a-${run}`;
const wsB = `ws-gate-b-${run}`;
const supplierA = `${wsA}_supp-sysco-metro`;
const supplierB = `${wsB}_supp-sysco-metro`;
const quoteA = `quote_gate_a_${run}`;
const quoteB = `quote_gate_b_${run}`;
const wfA = `wf_gate_a_${run}`;

async function insertOrder(wsId: string, id: string, status: string, totalCents: number, createdAt?: string) {
  await query(
    `INSERT INTO orders (id, workspace_id, order_number, supplier_name, item_sku, item_name, quantity, unit_price_cents, total_price_cents, status, idempotency_key, created_at)
     VALUES ($1, $2, $3, 'Test Supplier', 'FOOD-OTHER', 'Other', 1, $4, $4, $5, $6, COALESCE($7::timestamptz, NOW()));`,
    [id, wsId, `PO-${id.slice(-6)}`, totalCents, status, `idem_${id}`, createdAt ?? null]
  );
}

async function insertQuote(id: string, wsId: string, supplierId: string, totalCents: number) {
  await query(
    `INSERT INTO quotes (id, workspace_id, rfq_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, currency, valid_until)
     VALUES ($1, $2, $3, $4, 'Sysco Metro Distribution', 'FOOD-FLOUR-50LB', 10, $5, $6, 'USDC', NOW() + INTERVAL '1 day');`,
    [id, wsId, `rfq_${id}`, supplierId, totalCents / 10, totalCents]
  );
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: wsA,
    workflowId: `wf_req_${run}`,
    actorRole: "procurement_agent",
    supplierId: supplierA,
    quoteId: quoteA,
    quantity: 10,
    totalPriceCents: 24500n,
    ...overrides,
  };
}

describe("Commitment gate loads its facts from PostgreSQL", () => {
  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsA, "Gate Kitchen A", "kitchen-v1");
    await provisionWorkspace(wsB, "Gate Kitchen B", "kitchen-v1");
    await insertQuote(quoteA, wsA, supplierA, 24500);
    await insertQuote(quoteB, wsB, supplierB, 24500);
  });

  afterAll(async () => {
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [[wsA, wsB]]);
    await closePool();
  });

  it("reads spend from orders in spend-counting statuses only", async () => {
    const ws = `ws-gate-spend-${run}`;
    await provisionWorkspace(ws, "Gate Spend Kitchen", "kitchen-v1");
    await insertQuote(`quote_spend_${run}`, ws, `${ws}_supp-sysco-metro`, 24500);
    await insertOrder(ws, `ord_spend_settling_${run}`, "settling", 1000);
    await insertOrder(ws, `ord_spend_confirmed_${run}`, "confirmed", 2000);
    await insertOrder(ws, `ord_spend_cancelled_${run}`, "cancelled", 5000);
    await insertOrder(ws, `ord_spend_draft_${run}`, "draft", 7000);
    await insertOrder(ws, `ord_spend_yesterday_${run}`, "confirmed", 9000, "2020-01-01T00:00:00Z");

    const d = await authorizeCommitment({
      workspaceId: ws,
      workflowId: `wf_spend_${run}`,
      actorRole: "procurement_agent",
      supplierId: `${ws}_supp-sysco-metro`,
      quoteId: `quote_spend_${run}`,
      quantity: 10,
      totalPriceCents: 24500n,
    });
    expect(d.evidence.dailySpentCents).toBe("3000");
    expect(d.decision).toBe(PolicyDecision.ALLOW);
    await query(`DELETE FROM workspaces WHERE id = $1;`, [ws]);
  });

  it("ignores the workflow's own order when re-checking", async () => {
    const ws = `ws-gate-own-${run}`;
    const wf = `wf_own_${run}`;
    await provisionWorkspace(ws, "Gate Own Order Kitchen", "kitchen-v1");
    await insertQuote(`quote_own_${run}`, ws, `${ws}_supp-sysco-metro`, 24500);
    await insertOrder(ws, `ord_${wf}`, "confirmed", 24500);
    await insertOrder(ws, `ord_other_${run}`, "confirmed", 3000);

    const d = await authorizeCommitment({
      workspaceId: ws,
      workflowId: wf,
      actorRole: "procurement_agent",
      supplierId: `${ws}_supp-sysco-metro`,
      quoteId: `quote_own_${run}`,
      quantity: 10,
      totalPriceCents: 24500n,
    });
    expect(d.evidence.dailySpentCents).toBe("3000");
    await query(`DELETE FROM workspaces WHERE id = $1;`, [ws]);
  });

  it("a quote from another workspace is QUOTE_NOT_FOUND", async () => {
    const d = await authorizeCommitment(request({ quoteId: quoteB, workflowId: wfA }));
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toContain("QUOTE_NOT_FOUND");
  });

  it("a supplier from another workspace is not verified for this workspace", async () => {
    // A quote in workspace A that names workspace B's supplier. The supplier row is looked up
    // inside workspace A, where it does not exist.
    const crossQuote = `quote_cross_supplier_${run}`;
    await insertQuote(crossQuote, wsA, supplierB, 24500);
    const d = await authorizeCommitment(request({ supplierId: supplierB, quoteId: crossQuote, workflowId: wfA }));
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toContain("SUPPLIER_NOT_VERIFIED");
  });

  it("a missing role row is denied, never allowed", async () => {
    const ws = `ws-gate-norole-${run}`;
    await provisionWorkspace(ws, "Gate No Role Kitchen", "kitchen-v1");
    await insertQuote(`quote_norole_${run}`, ws, `${ws}_supp-sysco-metro`, 24500);
    await query(`DELETE FROM agent_roles WHERE workspace_id = $1 AND role_name = 'procurement_agent';`, [ws]);
    const d = await authorizeCommitment({
      workspaceId: ws,
      workflowId: `wf_norole_${run}`,
      actorRole: "procurement_agent",
      supplierId: `${ws}_supp-sysco-metro`,
      quoteId: `quote_norole_${run}`,
      quantity: 10,
      totalPriceCents: 24500n,
    });
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["ROLE_NOT_PERMITTED"]);
    await query(`DELETE FROM workspaces WHERE id = $1;`, [ws]);
  });
});
