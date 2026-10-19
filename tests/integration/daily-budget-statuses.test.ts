import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { createReplenishmentTools } from "../../src/agents/replenishmentTools.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { WorkflowState } from "../../src/workflows/types.js";

describe("Daily budget counts orders that are mid-settlement", () => {
  const wsIds: string[] = [];

  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    for (const id of wsIds.splice(0)) {
      await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  async function workspace(): Promise<string> {
    const wsId = `ws-budget-status-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    wsIds.push(wsId);
    await provisionWorkspace(wsId, "Budget Status Kitchen", "kitchen-v1", {
      customDailyLimitCents: 30000n, // $300.00
      customApprovalThresholdCents: 25000n,
    });
    return wsId;
  }

  async function insertOrder(wsId: string, status: string, totalCents: number): Promise<void> {
    const id = `ord_budget_${status}_${Math.random().toString(36).slice(2, 8)}`;
    await query(
      `INSERT INTO orders (id, workspace_id, order_number, supplier_name, item_sku, item_name, quantity, unit_price_cents, total_price_cents, status, idempotency_key)
       VALUES ($1, $2, $3, 'Test Supplier', 'FOOD-OTHER', 'Other', 1, $4, $4, $5, $6);`,
      [id, wsId, `PO-${id.slice(-6)}`, totalCents, status, `idem_${id}`]
    );
  }

  for (const status of ["settling", "confirmed"]) {
    it(`an order in '${status}' is counted in today's cumulative spend`, async () => {
      const wsId = await workspace();
      await insertOrder(wsId, status, 10000);
      const tools = createReplenishmentTools({ workspaceId: wsId, workflowId: "wf_unused" });
      const ctx = JSON.parse(await tools.getBusinessContextTool.invoke({}));
      expect(ctx.todayCumulativeSpentCents).toBe("10000");
      expect(ctx.remainingDailyBudgetCents).toBe("20000");
    });
  }

  it("a proposal that would exceed the daily limit because of a settling order is denied", async () => {
    const wsId = await workspace();
    await insertOrder(wsId, "settling", 10000); // $100 + flour $245 > $300 limit
    const runner = new ProcurementWorkflowRunner();
    const result = await runner.startReplenishment(wsId, "FOOD-FLOUR-50LB");
    expect(result.state).toBe(WorkflowState.FAILED);
    const wf = await query(`SELECT error_message FROM workflows WHERE id = $1;`, [result.workflowId]);
    expect(wf.rows[0].error_message).toMatch(/Daily spend limit exceeded/);
    const orders = await query(`SELECT 1 FROM orders WHERE workspace_id = $1 AND item_sku = 'FOOD-FLOUR-50LB';`, [wsId]);
    expect(orders.rows.length).toBe(0);
  });
});
