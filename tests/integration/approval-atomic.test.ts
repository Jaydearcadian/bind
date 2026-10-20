import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { WorkflowState } from "../../src/workflows/types.js";

const run = Date.now();
const wsId = `ws-approval-atomic-${run}`;
const OWNER = "owner@kitchen.example";

describe("an approval decision and its audit row are one transaction (ADR 0005, ADR 0040)", () => {
  const engine = new WorkflowEngine();
  const runner = new ProcurementWorkflowRunner();
  let counter = 0;

  /** A workflow waiting on an owner approval, with the quote row the commitment re-check reads. */
  async function awaitingApproval() {
    counter += 1;
    const wfId = `wf_atomic_${run}_${counter}`;
    const approvalId = `appr_atomic_${run}_${counter}`;
    const quoteId = `quote_atomic_${run}_${counter}`;
    const supplierId = `${wsId}_supp-sysco-metro`;
    await query(
      `INSERT INTO quotes (id, workspace_id, rfq_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, currency, valid_until)
       VALUES ($1, $2, $3, $4, 'Sysco Metro Distribution', 'FOOD-FLOUR-50LB', 10, '2450', '24500', 'USDC', NOW() + INTERVAL '1 day');`,
      [quoteId, wsId, `rfq_atomic_${run}_${counter}`, supplierId]
    );
    const quote = {
      quoteId,
      rfqId: `rfq_atomic_${run}_${counter}`,
      supplierId,
      supplierName: "Sysco Metro Distribution",
      sku: "FOOD-FLOUR-50LB",
      quantity: 10,
      unitPriceCents: "2450",
      totalPriceCents: "24500",
    };
    await engine.createWorkflow(wfId, wsId, "kitchen_replenishment", `idem_atomic_${run}_${counter}`, { itemName: "Flour", quote });
    await engine.transition(wfId, { fromState: WorkflowState.DRAFT, toState: WorkflowState.AWAITING_APPROVAL });
    await engine.createApproval(approvalId, wsId, "order", wfId, "submit_order", 24500n, "procurement");
    return { wfId, approvalId };
  }

  async function approvalStatus(approvalId: string): Promise<string> {
    return (await query(`SELECT status FROM approvals WHERE id = $1;`, [approvalId])).rows[0].status as string;
  }

  async function workflowState(wfId: string): Promise<string> {
    return (await query(`SELECT state FROM workflows WHERE id = $1;`, [wfId])).rows[0].state as string;
  }

  /** Makes the audit insert for one approval fail inside the transaction that writes it (test-only, removed afterwards). */
  async function failAuditFor(approvalId: string, action: string) {
    const literalAction = action.replace(/'/g, "''");
    const literalId = approvalId.replace(/'/g, "''");
    await query(`
      CREATE OR REPLACE FUNCTION bind_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = '${literalAction}' AND NEW.evidence->>'approvalId' = '${literalId}' THEN
          RAISE EXCEPTION 'injected audit failure';
        END IF;
        RETURN NEW;
      END $$;`);
    await query(`DROP TRIGGER IF EXISTS bind_test_fail_audit ON audit_logs;`);
    await query(`CREATE TRIGGER bind_test_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION bind_test_fail_audit();`);
  }

  async function removeAuditFailure() {
    await query(`DROP TRIGGER IF EXISTS bind_test_fail_audit ON audit_logs;`);
    await query(`DROP FUNCTION IF EXISTS bind_test_fail_audit();`);
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsId, "Approval Atomic Kitchen", "kitchen-v1");
  });

  afterAll(async () => {
    await removeAuditFailure();
    await query(`DELETE FROM workspaces WHERE id = $1;`, [wsId]);
    await closePool();
  });

  it("a failing audit write rolls the approval decision back", async () => {
    const { wfId, approvalId } = await awaitingApproval();
    await failAuditFor(approvalId, "approval.approved");
    try {
      await expect(runner.approveAndSubmit(approvalId, OWNER, wsId)).rejects.toThrow(/injected audit failure/);
    } finally {
      await removeAuditFailure();
    }

    // The decision was written in the same transaction as the audit row, so the failed audit took it back.
    expect(await approvalStatus(approvalId)).toBe("pending");
    expect(await workflowState(wfId)).toBe(WorkflowState.AWAITING_APPROVAL);
    expect((await query(`SELECT COUNT(*)::int AS n FROM orders WHERE id = $1;`, [`ord_${wfId}`])).rows[0].n).toBe(0);

    // With the failure removed, the same approval can still be decided, once.
    const retried = await runner.approveAndSubmit(approvalId, OWNER, wsId);
    expect(retried.state).toBe(WorkflowState.CONFIRMED);
    expect(await approvalStatus(approvalId)).toBe("approved");
  });

  it("a failing audit write rolls a rejection back too", async () => {
    const { wfId, approvalId } = await awaitingApproval();
    await failAuditFor(approvalId, "approval.rejected");
    try {
      await expect(runner.declineApproval(approvalId, "rejected", OWNER, wsId, "no")).rejects.toThrow(/injected audit failure/);
    } finally {
      await removeAuditFailure();
    }
    expect(await approvalStatus(approvalId)).toBe("pending");
    expect(await workflowState(wfId)).toBe(WorkflowState.AWAITING_APPROVAL);
  });

  it("approving still writes the decision and the audit row together", async () => {
    const { wfId, approvalId } = await awaitingApproval();
    const result = await runner.approveAndSubmit(approvalId, OWNER, wsId);
    expect(result.state).toBe(WorkflowState.CONFIRMED);

    const audit = await query(
      `SELECT actor_type, actor_id, policy_decision, workflow_id FROM audit_logs
       WHERE workspace_id = $1 AND action = 'approval.approved' AND evidence->>'approvalId' = $2;`,
      [wsId, approvalId]
    );
    expect(audit.rows).toEqual([{ actor_type: "owner", actor_id: OWNER, policy_decision: "ALLOW", workflow_id: wfId }]);
    expect(await approvalStatus(approvalId)).toBe("approved");
  });
});
