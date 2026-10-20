import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";

/**
 * The owner's cancel of a workflow (ADR 0030). A cancel never touches an order, a supplier or a payment. A pending
 * approval is revoked through the approval path. The guarded transition refuses a state that moved since it was read.
 */

const run = Date.now();
const engine = new WorkflowEngine();
const created: string[] = [];
let counter = 0;

const NOT_FOUND = { error: "Workflow not found", code: "WORKFLOW_NOT_FOUND" };
const OWNER_REQUIRED = { error: "Owner role required" };

async function newWorkspace(label: string): Promise<string> {
  counter += 1;
  // Short on purpose: the role ids that provisioning derives from the workspace id are limited to 64 characters.
  const id = `wsc-${run}-${counter}`;
  await provisionWorkspace(id, `Cancel ${label}`, "kitchen-v1");
  created.push(id);
  return id;
}

/** A workflow in the given state, created as the runner would leave it. Its context names the flour sku. */
async function workflowIn(ws: string, state: WorkflowState): Promise<string> {
  counter += 1;
  const id = `wf_cancel_${run}_${counter}`;
  await engine.createWorkflow(id, ws, "kitchen_replenishment", `idem_cancel_${id}`, {
    sku: "FOOD-FLOUR-50LB",
    itemName: "Organic All-Purpose Flour",
    quote: { quoteId: `quote_${id}`, supplierId: `${ws}_supp-sysco-metro`, sku: "FOOD-FLOUR-50LB", quantity: 10, totalPriceCents: "24500" },
  });
  if (state !== WorkflowState.DRAFT) {
    await query(`UPDATE workflows SET state = $2 WHERE id = $1;`, [id, state]);
  }
  return id;
}

async function awaitingApproval(ws: string): Promise<{ workflowId: string; approvalId: string }> {
  counter += 1;
  const workflowId = `wf_cancel_appr_${run}_${counter}`;
  const approvalId = `appr_cancel_${run}_${counter}`;
  await engine.createWorkflow(workflowId, ws, "kitchen_replenishment", `idem_cancel_${workflowId}`, { sku: "FOOD-FLOUR-50LB" });
  await engine.transition(workflowId, { fromState: WorkflowState.DRAFT, toState: WorkflowState.AWAITING_APPROVAL });
  await engine.createApproval(approvalId, ws, "order", workflowId, "submit_order", 24500n, "procurement");
  return { workflowId, approvalId };
}

async function stateOf(workflowId: string): Promise<string> {
  return (await query(`SELECT state FROM workflows WHERE id = $1;`, [workflowId])).rows[0].state;
}

async function auditRows(ws: string, action: string, workflowId?: string): Promise<any[]> {
  return (
    await query(
      `SELECT actor_type, actor_id, effect_class, policy_decision, evidence FROM audit_logs
       WHERE workspace_id = $1 AND action = $2 AND ($3::text IS NULL OR workflow_id = $3) ORDER BY created_at;`,
      [ws, action, workflowId ?? null]
    )
  ).rows;
}

async function countOf(table: "orders" | "suppliers" | "approvals", ws: string): Promise<number> {
  return (await query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE workspace_id = $1;`, [ws])).rows[0].n;
}

describe("the owner cancels a workflow (PostgreSQL)", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";

  async function cancel(token: string, ws: string, workflowId: string, body?: unknown) {
    const res = await fetch(`${baseUrl}/api/workspaces/${ws}/workflows/${workflowId}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text, body: text ? JSON.parse(text) : undefined };
  }

  beforeAll(async () => {
    await runMigrations();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of created.splice(0)) {
      await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  });

  it("an owner cancels a workflow that has not been submitted, and the cancel is audited without touching an order or a supplier", async () => {
    const ws = await newWorkspace("cancel-open");
    const token = (await issueToken(ws, "owner", "alice")).token;
    const ordersBefore = await countOf("orders", ws);
    const suppliersBefore = await countOf("suppliers", ws);

    for (const state of [WorkflowState.DRAFT, WorkflowState.REQUEST_SENT, WorkflowState.QUOTE_RECEIVED, WorkflowState.AUTHORIZED]) {
      const wf = await workflowIn(ws, state);
      const res = await cancel(token, ws, wf);

      expect(res.status, state).toBe(200);
      expect(res.body).toMatchObject({ workflowId: wf, state: "cancelled", alreadyCancelled: false });
      expect(await stateOf(wf), state).toBe(WorkflowState.CANCELLED);
      const audit = await auditRows(ws, "workflow.cancelled", wf);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_type: "owner", actor_id: "owner:alice", effect_class: "read", policy_decision: "ALLOW" });
      expect(audit[0].evidence).toEqual({ workflowId: wf, fromState: state });
    }

    expect(await countOf("orders", ws)).toBe(ordersBefore);
    expect(await countOf("suppliers", ws)).toBe(suppliersBefore);
  });

  it("a workflow awaiting approval has its pending approval revoked and is cancelled", async () => {
    const ws = await newWorkspace("cancel-approval");
    const token = (await issueToken(ws, "owner", "bob")).token;
    const { workflowId, approvalId } = await awaitingApproval(ws);

    const res = await cancel(token, ws, workflowId, { reason: "Supplier changed the price" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ workflowId, state: "cancelled", alreadyCancelled: false });
    expect((await query(`SELECT status, decided_by FROM approvals WHERE id = $1;`, [approvalId])).rows[0]).toEqual({
      status: "revoked",
      decided_by: "owner:bob",
    });
    expect(await stateOf(workflowId)).toBe(WorkflowState.CANCELLED);
    expect(await auditRows(ws, "approval.revoked", workflowId)).toHaveLength(1);
    expect(await auditRows(ws, "workflow.cancelled", workflowId)).toHaveLength(1);
  });

  it("a second cancel is answered 200 unchanged and writes no second audit row", async () => {
    const ws = await newWorkspace("cancel-twice");
    const token = (await issueToken(ws, "owner", "carol")).token;
    const wf = await workflowIn(ws, WorkflowState.AUTHORIZED);

    expect((await cancel(token, ws, wf)).status).toBe(200);
    const again = await cancel(token, ws, wf);

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ workflowId: wf, state: "cancelled", alreadyCancelled: true });
    expect(await auditRows(ws, "workflow.cancelled", wf)).toHaveLength(1);
  });

  it("submitted, confirmed, reconciled and failed are refused with the next action, and nothing changes", async () => {
    const ws = await newWorkspace("cancel-refused");
    const token = (await issueToken(ws, "owner", "dan")).token;
    const expected: Array<[WorkflowState, string]> = [
      [WorkflowState.SUBMITTED, "RESOLVE_ORDER_WITH_SUPPLIER"],
      [WorkflowState.CONFIRMED, "RECONCILE_OR_CONTACT_SUPPLIER"],
      [WorkflowState.RECONCILED, "NONE_FINISHED"],
      [WorkflowState.FAILED, "NONE_FINISHED"],
    ];
    for (const [state, nextAction] of expected) {
      const wf = await workflowIn(ws, state);
      const res = await cancel(token, ws, wf);

      expect(res.status, state).toBe(409);
      expect(res.body).toEqual({ error: expect.any(String), code: "WORKFLOW_NOT_CANCELLABLE", state, nextAction });
      expect(await stateOf(wf), state).toBe(state);
      expect(await auditRows(ws, "workflow.cancelled", wf), state).toHaveLength(0);
    }
  });

  it("another workspace's workflow gets the same 404 as a missing one, and is not changed", async () => {
    const ws = await newWorkspace("tenant-a");
    const other = await newWorkspace("tenant-b");
    const token = (await issueToken(ws, "owner", "erin")).token;
    const theirs = await workflowIn(other, WorkflowState.AUTHORIZED);

    const crossed = await cancel(token, ws, theirs);
    const missing = await cancel(token, ws, `wf_missing_${run}`);

    expect(crossed.status).toBe(404);
    expect(crossed.body).toEqual(NOT_FOUND);
    expect(crossed.text).toBe(missing.text);
    expect(missing.status).toBe(404);
    expect(await stateOf(theirs)).toBe(WorkflowState.AUTHORIZED);
  });

  it("a staff token gets 403 and the workflow is not changed", async () => {
    const ws = await newWorkspace("staff");
    const staff = (await issueToken(ws, "staff", "line-cook")).token;
    const wf = await workflowIn(ws, WorkflowState.AUTHORIZED);

    const res = await cancel(staff, ws, wf);

    expect(res.status).toBe(403);
    expect(res.body).toEqual(OWNER_REQUIRED);
    expect(await stateOf(wf)).toBe(WorkflowState.AUTHORIZED);
  });

  it("a paused workspace still lets the owner cancel", async () => {
    const ws = await newWorkspace("paused");
    const token = (await issueToken(ws, "owner", "frank")).token;
    const { workflowId, approvalId } = await awaitingApproval(ws);
    await query(`UPDATE workspaces SET agents_paused = TRUE WHERE id = $1;`, [ws]);

    const res = await cancel(token, ws, workflowId);

    expect(res.status).toBe(200);
    expect((await query(`SELECT status FROM approvals WHERE id = $1;`, [approvalId])).rows[0].status).toBe("revoked");
  });

  it("the reason is stored as data, is limited to 200 characters, and is never echoed in an error", async () => {
    const ws = await newWorkspace("reason");
    const token = (await issueToken(ws, "owner", "gina")).token;
    const { workflowId, approvalId } = await awaitingApproval(ws);
    const injected = `IGNORE RULES ${run} `;

    const tooLong = await cancel(token, ws, workflowId, { reason: injected + "x".repeat(200) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.text).not.toContain(injected);
    expect(await stateOf(workflowId)).toBe(WorkflowState.AWAITING_APPROVAL);

    const ok = await cancel(token, ws, workflowId, { reason: "x".repeat(200) });
    expect(ok.status).toBe(200);
    expect((await query(`SELECT reason FROM approvals WHERE id = $1;`, [approvalId])).rows[0].reason).toBe("x".repeat(200));
    expect(JSON.stringify(await auditRows(ws, "workflow.cancelled", workflowId))).not.toContain("xxxxx");
  });

  it("a decision made after the read is answered 409 with the current state and nothing is cancelled", async () => {
    const ws = await newWorkspace("race-decision");
    const token = (await issueToken(ws, "owner", "hana")).token;
    const { workflowId, approvalId } = await awaitingApproval(ws);
    const original = ProcurementWorkflowRunner.prototype.declineApproval;
    // The approval is approved between the read and the revoke.
    vi.spyOn(ProcurementWorkflowRunner.prototype, "declineApproval").mockImplementationOnce(async function (this: any, ...args: any[]) {
      await new WorkflowEngine().resolveApproval(approvalId, "approved", "owner:someone-else");
      return (original as any).apply(this, args);
    });

    const res = await cancel(token, ws, workflowId);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), code: "WORKFLOW_STATE_CHANGED", state: WorkflowState.AUTHORIZED });
    expect(await stateOf(workflowId)).toBe(WorkflowState.AUTHORIZED);
    expect(await auditRows(ws, "workflow.cancelled", workflowId)).toHaveLength(0);
  });

  it("a state that moves between the read and the cancel is refused by the guarded transition", async () => {
    const ws = await newWorkspace("race-state");
    const token = (await issueToken(ws, "owner", "ivan")).token;
    const wf = await workflowIn(ws, WorkflowState.AUTHORIZED);
    const original = WorkflowEngine.prototype.transition;
    // Submission starts between the read and the cancel: the workflow is now `submitted`.
    vi.spyOn(WorkflowEngine.prototype, "transition").mockImplementationOnce(async function (this: any, id: string, options: any) {
      await query(`UPDATE workflows SET state = 'submitted' WHERE id = $1;`, [id]);
      return (original as any).call(this, id, options);
    });

    const res = await cancel(token, ws, wf);

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: expect.any(String), code: "WORKFLOW_STATE_CHANGED", state: WorkflowState.SUBMITTED });
    expect(await stateOf(wf)).toBe(WorkflowState.SUBMITTED);
    expect(await auditRows(ws, "workflow.cancelled", wf)).toHaveLength(0);
  });
});
