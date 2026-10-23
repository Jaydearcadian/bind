import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { createReplenishmentTools } from "../../src/agents/replenishmentTools.js";
import { notificationEmitter } from "../../src/adapters/web2/notifications.js";
import type { NotificationPayload } from "../../src/adapters/web2/types.js";
import { sendApprovalNotification } from "../../src/notifications/dispatch.js";
import { setEffectFault } from "../../src/effects/faults.js";
import { upsertSurfaceBinding } from "../../src/adapters/socialSurface.js";

const run = Date.now();
const SKU = "FOOD-FLOUR-50LB";
const TITLE_MARKER = `TITLE-MARKER-${run}`;
const MESSAGE_MARKER = `MESSAGE-MARKER-${run}`;

describe("Approval notifications are sent through the effects ledger", () => {
  const engine = new WorkflowEngine();
  const wsIds: string[] = [];
  let counter = 0;

  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    setEffectFault(null);
    vi.restoreAllMocks();
    notificationEmitter.clear();
    for (const id of wsIds.splice(0)) {
      await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  /** A fresh kitchen workspace, so each test controls its own effects and audit rows. */
  async function freshWorkspace(): Promise<string> {
    counter += 1;
    const wsId = `ws-notify-${run}-${counter}`;
    wsIds.push(wsId);
    await provisionWorkspace(wsId, "Notify Kitchen", "kitchen-v1");
    // Fixture only: the owner's WhatsApp binding, so an approval request has a recipient (docs/decisions/0025).
    // The actor id is unique per workspace.
    await upsertSurfaceBinding(
      wsId,
      { surface: "whatsapp", actorId: `+1555${run % 1000000}${String(counter).padStart(3, "0")}`, actorRole: "owner" },
      { type: "owner", id: "test-owner" }
    );
    return wsId;
  }

  /** A real workflow and approval, so the notification refers to rows that exist. */
  async function pendingApproval(wsId: string) {
    counter += 1;
    const wfId = `wf_notify_${run}_${counter}`;
    const approvalId = `appr_${wfId}`;
    await engine.createWorkflow(wfId, wsId, "kitchen_replenishment", `idem_notify_${wfId}`, { sku: SKU });
    await engine.transition(wfId, { fromState: WorkflowState.DRAFT, toState: WorkflowState.AWAITING_APPROVAL });
    await engine.createApproval(approvalId, wsId, "order", wfId, `Purchase 10x ${SKU}`, 30000n, "procurement_agent");
    return { wfId, approvalId };
  }

  function payloadFor(wsId: string, approvalId: string): NotificationPayload {
    return {
      workspaceId: wsId,
      channel: "whatsapp",
      recipient: "+12125550199",
      title: TITLE_MARKER,
      message: MESSAGE_MARKER,
      actionUrl: `http://127.0.0.1:3000/api/approvals/${approvalId}/approve`,
      approvalToken: approvalId,
    };
  }

  const effectKeyFor = (wsId: string, approvalId: string) => `${wsId}:notify:approval:${approvalId}`;

  it("an approval notification is sent once per approval", async () => {
    const wsId = await freshWorkspace();
    const { wfId, approvalId } = await pendingApproval(wsId);
    const spy = vi.spyOn(notificationEmitter, "send");

    const out = await sendApprovalNotification({
      workspaceId: wsId,
      workflowId: wfId,
      approvalId,
      payload: payloadFor(wsId, approvalId),
    });

    expect(out).toEqual({ sent: true });
    expect(spy).toHaveBeenCalledTimes(1);
    const row = await query(`SELECT status, operation FROM effects WHERE idempotency_key = $1;`, [effectKeyFor(wsId, approvalId)]);
    expect(row.rows[0]).toMatchObject({ status: "completed", operation: "notifications.send_approval_request" });
  });

  it("a second call for the same approval replays without sending again", async () => {
    const wsId = await freshWorkspace();
    const { wfId, approvalId } = await pendingApproval(wsId);
    const spy = vi.spyOn(notificationEmitter, "send");
    const input = { workspaceId: wsId, workflowId: wfId, approvalId, payload: payloadFor(wsId, approvalId) };

    expect(await sendApprovalNotification(input)).toEqual({ sent: true });
    expect(await sendApprovalNotification(input)).toEqual({ sent: true });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a crash after the send and before the record is reported in doubt and not sent again", async () => {
    const wsId = await freshWorkspace();
    const { wfId, approvalId } = await pendingApproval(wsId);
    const key = effectKeyFor(wsId, approvalId);
    const spy = vi.spyOn(notificationEmitter, "send");
    const input = { workspaceId: wsId, workflowId: wfId, approvalId, payload: payloadFor(wsId, approvalId) };

    // The send happens, then the process "dies" before the ledger records completion.
    setEffectFault({ point: "after_call_before_complete", match: (spec) => spec.idempotencyKey === key });
    await expect(sendApprovalNotification(input)).rejects.toThrow("injected fault");
    expect(spy).toHaveBeenCalledTimes(1);

    const retry = await sendApprovalNotification(input);

    expect(retry).toEqual({ sent: false, reason: "in_doubt" });
    expect(spy).toHaveBeenCalledTimes(1);
    const audit = await query(
      `SELECT actor_type, actor_id, effect_class, policy_decision, evidence FROM audit_logs
       WHERE workspace_id = $1 AND workflow_id = $2 AND action = 'notification.in_doubt';`,
      [wsId, wfId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_type: "system",
      actor_id: "system:notifications",
      effect_class: "external_request",
      policy_decision: "ALLOW",
    });
    expect(audit.rows[0].evidence).toMatchObject({ approvalId });
    expect(audit.rows[0].evidence.effectId).toMatch(/^eff_/);
  });

  it("a failing emitter does not fail the policy evaluation", async () => {
    const wsId = await freshWorkspace();
    counter += 1;
    const wfId = `wf_notify_eval_${run}_${counter}`;
    const quoteId = `quote_notify_${run}_${counter}`;
    const totalCents = 30000;
    await query(
      `INSERT INTO quotes (id, workspace_id, rfq_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, currency, valid_until)
       VALUES ($1, $2, $3, $4, 'Sysco Metro Distribution', $5, 10, $6, $7, 'USDC', NOW() + INTERVAL '1 day');`,
      [quoteId, wsId, `rfq_${quoteId}`, `${wsId}_supp-sysco-metro`, SKU, totalCents / 10, totalCents]
    );
    await engine.createWorkflow(wfId, wsId, "kitchen_replenishment", `idem_notify_eval_${wfId}`, {
      sku: SKU,
      replenishmentProposal: {
        proposalId: `prop_${wfId}`,
        workflowId: wfId,
        sku: SKU,
        quantity: 10,
        supplierId: `${wsId}_supp-sysco-metro`,
        supplierName: "Sysco Metro Distribution",
        quoteId,
        unitPriceCents: String(totalCents / 10),
        totalPriceCents: String(totalCents),
        jevEvaluation: { holdForOwnerReview: false },
        status: "VALIDATED",
      },
    });
    vi.spyOn(notificationEmitter, "send").mockRejectedValue(new Error("WhatsApp gateway unreachable"));
    const tools = createReplenishmentTools({ workspaceId: wsId, workflowId: wfId });

    const out = JSON.parse(await tools.requestPolicyEvaluationTool.invoke({ requestId: wfId }));

    expect(out.policyDecision).toBe("REQUIRE_APPROVAL");
    expect(out.workflowState).toBe(WorkflowState.AWAITING_APPROVAL);
    const wf = await query(`SELECT state FROM workflows WHERE id = $1;`, [wfId]);
    expect(wf.rows[0].state).toBe("awaiting_approval");
    const approval = await query(`SELECT status FROM approvals WHERE id = $1;`, [out.approvalId]);
    expect(approval.rows[0].status).toBe("pending");
    const failed = await query(
      `SELECT evidence FROM audit_logs WHERE workspace_id = $1 AND workflow_id = $2 AND action = 'notification.failed';`,
      [wsId, wfId]
    );
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0].evidence.error).toMatch(/WhatsApp gateway unreachable/);
  });

  it("the notification key includes the workspace id", async () => {
    const wsId = await freshWorkspace();
    const { wfId, approvalId } = await pendingApproval(wsId);

    await sendApprovalNotification({ workspaceId: wsId, workflowId: wfId, approvalId, payload: payloadFor(wsId, approvalId) });

    const rows = await query(`SELECT idempotency_key, workspace_id FROM effects WHERE workspace_id = $1;`, [wsId]);
    expect(rows.rows).toEqual([{ idempotency_key: `${wsId}:notify:approval:${approvalId}`, workspace_id: wsId }]);
  });

  it("the in-doubt audit row contains no message text", async () => {
    const wsId = await freshWorkspace();
    const { wfId, approvalId } = await pendingApproval(wsId);
    const key = effectKeyFor(wsId, approvalId);
    const input = { workspaceId: wsId, workflowId: wfId, approvalId, payload: payloadFor(wsId, approvalId) };
    setEffectFault({ point: "after_call_before_complete", match: (spec) => spec.idempotencyKey === key });
    await expect(sendApprovalNotification(input)).rejects.toThrow("injected fault");

    expect(await sendApprovalNotification(input)).toEqual({ sent: false, reason: "in_doubt" });

    const audit = await query(
      `SELECT evidence::text AS evidence_text FROM audit_logs WHERE workspace_id = $1 AND action = 'notification.in_doubt';`,
      [wsId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].evidence_text).not.toContain(TITLE_MARKER);
    expect(audit.rows[0].evidence_text).not.toContain(MESSAGE_MARKER);
    expect(audit.rows[0].evidence_text).not.toContain("+12125550199");
  });
});
