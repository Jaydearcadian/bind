import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { MatchStatus } from "../../src/accounting/three-way-match.js";
import { notificationEmitter } from "../../src/adapters/web2/notifications.js";
import { upsertSurfaceBinding } from "../../src/adapters/socialSurface.js";

describe("Workflow Orchestrator & End-to-End Kitchen Slice", () => {
  const wsId = "ws-integration-kitchen-01";
  const runner = new ProcurementWorkflowRunner();

  beforeAll(async () => {
    await runMigrations();
    // Provision fresh workspace with kitchen template
    await provisionWorkspace(wsId, "Le Bistro Autonomous Kitchen", "kitchen-v1", {
      customDailyLimitCents: 100000n, // $1,000.00
      customApprovalThresholdCents: 25000n, // $250.00
    });
  });

  afterAll(async () => {
    await query(`DELETE FROM workspaces WHERE id = $1;`, [wsId]);
    await closePool();
  });

  it("completes autonomous replenishment for order under approval threshold ($245 < $250)", async () => {
    // Flour: 10 bags @ $24.50 = $245.00
    const result = await runner.startReplenishment(wsId, "FOOD-FLOUR-50LB");
    expect(result.state).toBe(WorkflowState.CONFIRMED);
    expect(result.orderId).toBeDefined();

    // Verify order was recorded in PostgreSQL
    const orderRes = await query(`SELECT * FROM orders WHERE id = $1;`, [result.orderId]);
    expect(orderRes.rows.length).toBe(1);
    expect(orderRes.rows[0].status).toBe("confirmed");
    expect(orderRes.rows[0].item_sku).toBe("FOOD-FLOUR-50LB");
    expect(BigInt(orderRes.rows[0].total_price_cents)).toBe(24500n); // $245.00

    // Now execute 3-way match, settlement payment, and inventory restock
    const reconResult = await runner.fulfillAndReconcile(result.orderId!, wsId);
    expect(reconResult.status).toBe(MatchStatus.MATCHED);
    expect(reconResult.reconciled).toBe(true);
    expect(reconResult.txHash).toBeDefined();

    // Verify inventory was restocked: initial was 3, reorder was 10 -> new stock 13
    const itemRes = await query(
      `SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = 'FOOD-FLOUR-50LB';`,
      [wsId]
    );
    expect(Number(itemRes.rows[0].current_quantity)).toBe(13);
  });

  it("pauses in AWAITING_APPROVAL and notifies owner when order exceeds threshold ($392 > $250)", async () => {
    notificationEmitter.clear();
    // The owner has a WhatsApp binding in this workspace. Approval requests go only to the owner's own binding.
    await upsertSurfaceBinding(wsId, { surface: "whatsapp", actorId: "+15550100001", actorRole: "owner" }, { type: "owner", id: "test-owner" });

    // Butter: 4 cases @ $98.00 = $392.00 (Exceeds $250.00 threshold)
    const result = await runner.startReplenishment(wsId, "FOOD-BUTTER-36LB");
    expect(result.state).toBe(WorkflowState.AWAITING_APPROVAL);
    expect(result.approvalId).toBeDefined();

    // Verify WhatsApp notification was emitted
    const notifications = notificationEmitter.getSentNotifications("whatsapp");
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[0].title).toMatch(/Restock Approval Required/i);
    expect(notifications[0].message).toMatch(/European Unsalted Butter/i);

    // Verify approval record in DB
    const apprRes = await query(`SELECT * FROM approvals WHERE id = $1;`, [result.approvalId]);
    expect(apprRes.rows.length).toBe(1);
    expect(apprRes.rows[0].status).toBe("pending");
    expect(BigInt(apprRes.rows[0].amount_cents)).toBe(39200n);

    // Simulate Human Owner Approval
    const resumeResult = await runner.approveAndSubmit(result.approvalId!, "owner@lebistro.example.com", wsId);
    expect(resumeResult.state).toBe(WorkflowState.CONFIRMED);
    expect(resumeResult.orderId).toBeDefined();

    // Complete fulfillment and reconciliation
    const reconResult = await runner.fulfillAndReconcile(resumeResult.orderId!, wsId);
    expect(reconResult.status).toBe(MatchStatus.MATCHED);
    expect(reconResult.reconciled).toBe(true);
  });
});
