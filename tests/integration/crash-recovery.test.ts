import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { WorkflowCrashRecoveryRunner } from "../../src/workflows/recovery.js";

describe("Workflow Crash Recovery & Restart Resilience", () => {
  const wsId = "ws-crash-recovery-test";
  const engine = new WorkflowEngine();
  const recoveryRunner = new WorkflowCrashRecoveryRunner();

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsId, "Crash Recovery Test Kitchen", "kitchen-v1");
  });

  afterAll(async () => {
    await query(`DELETE FROM workspaces WHERE id = $1;`, [wsId]);
    await closePool();
  });

  it("recovers an authorized workflow interrupted by process termination", async () => {
    const wfId = "wf_crashed_auth_101";
    const idemKey = "idem_crash_auth_101";

    // Simulate workflow that reached AUTHORIZED but process died before submission
    await engine.createWorkflow(wfId, wsId, "kitchen_replenishment", idemKey, {
      itemName: "Organic All-Purpose Flour",
      quote: {
        quoteId: "quote_sysco_recovery_1",
        rfqId: "rfq_recovery_1",
        supplierId: `${wsId}_supp-sysco-metro`,
        supplierName: "Sysco Metro Distribution",
        sku: "FOOD-FLOUR-50LB",
        quantity: 10,
        unitPriceCents: "2450",
        totalPriceCents: "24500",
      },
    });

    await engine.transition(wfId, {
      fromState: WorkflowState.DRAFT,
      toState: WorkflowState.AUTHORIZED,
    });

    // Run crash recovery
    const report = await recoveryRunner.recoverInterruptedWorkflows();
    expect(report.recoveredCount).toBeGreaterThan(0);

    // Verify workflow safely reached CONFIRMED
    const wf = await engine.getWorkflow(wfId);
    expect(wf?.state).toBe(WorkflowState.CONFIRMED);

    // Verify exactly 1 order exists for this workflow
    const orderRes = await query(`SELECT * FROM orders WHERE id = $1;`, [`ord_${wfId}`]);
    expect(orderRes.rows.length).toBe(1);
    expect(orderRes.rows[0].status).toBe("confirmed");
  });

  it("recovers a submitted workflow without duplicating orders", async () => {
    const wfId = "wf_crashed_sub_202";
    const idemKey = "idem_crash_sub_202";
    const orderId = `ord_${wfId}`;

    await engine.createWorkflow(wfId, wsId, "kitchen_replenishment", idemKey, {
      itemName: "Whole Milk Case",
    });

    await engine.transition(wfId, {
      fromState: WorkflowState.DRAFT,
      toState: WorkflowState.SUBMITTED,
    });

    // Insert order as if external submit completed before the crash
    await query(
      `INSERT INTO orders (id, workspace_id, order_number, supplier_id, supplier_name, item_sku, item_name, quantity, unit_price_cents, total_price_cents, currency, status, idempotency_key, external_order_ref)
       VALUES ($1, $2, 'PO-RECOVERY-01', $3, 'Baldor Foods', 'FOOD-MILK-CASE', 'Whole Milk Case', 6, 1680, 10080, 'USDC', 'confirmed', $4, 'EXT-BALDOR-REF99');`,
      [orderId, wsId, `${wsId}_supp-baldor-metro`, `idem_ord_${orderId}`]
    );

    // Run recovery
    const report = await recoveryRunner.recoverInterruptedWorkflows();
    expect(report.recoveredCount).toBeGreaterThan(0);

    // Verify workflow reached CONFIRMED
    const wf = await engine.getWorkflow(wfId);
    expect(wf?.state).toBe(WorkflowState.CONFIRMED);

    // Verify no duplicate order was created
    const countRes = await query(`SELECT count(*) FROM orders WHERE id = $1;`, [orderId]);
    expect(Number(countRes.rows[0].count)).toBe(1);
  });
});
