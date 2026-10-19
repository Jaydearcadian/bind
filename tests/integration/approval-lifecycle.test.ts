import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { WorkflowEngine, ApprovalDecisionError } from "../../src/workflows/engine.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { WorkflowState } from "../../src/workflows/types.js";

const run = Date.now();
const wsId = `ws-approval-life-${run}`;
const otherWsId = `ws-approval-other-${run}`;

describe("Approval lifecycle: decide once, expire, reject, revoke", () => {
  const engine = new WorkflowEngine();
  const runner = new ProcurementWorkflowRunner();
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  let counter = 0;
  let ownerToken = "";

  function quoteFor(label: string) {
    return {
      quoteId: `quote_${label}_${run}`,
      rfqId: `rfq_${label}_${run}`,
      supplierId: `${wsId}_supp-sysco-metro`,
      supplierName: "Sysco Metro Distribution",
      sku: "FOOD-FLOUR-50LB",
      quantity: 10,
      unitPriceCents: "2450",
      totalPriceCents: "24500",
    };
  }

  /** Creates a workflow waiting on an owner approval, returning both IDs. */
  async function awaitingApproval(workspaceId: string = wsId) {
    counter += 1;
    const wfId = `wf_appr_${run}_${counter}`;
    const approvalId = `appr_${run}_${counter}`;
    const quote = quoteFor(`c${counter}`);
    // The quote row the workflow refers to. The earlier fixture approved against a quote that did not exist; the
    // approval-time commitment re-check reads the quote from the database, so the row must be there.
    await query(
      `INSERT INTO quotes (id, workspace_id, rfq_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, currency, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'USDC', NOW() + INTERVAL '1 day');`,
      [
        quote.quoteId,
        workspaceId,
        quote.rfqId,
        quote.supplierId,
        quote.supplierName,
        quote.sku,
        quote.quantity,
        quote.unitPriceCents,
        quote.totalPriceCents,
      ]
    );
    await engine.createWorkflow(wfId, workspaceId, "kitchen_replenishment", `idem_appr_${run}_${counter}`, {
      itemName: "Organic All-Purpose Flour",
      quote,
    });
    await engine.transition(wfId, {
      fromState: WorkflowState.DRAFT,
      toState: WorkflowState.AWAITING_APPROVAL,
    });
    await engine.createApproval(approvalId, workspaceId, "order", wfId, "submit_order", 24500n, "procurement");
    return { wfId, approvalId };
  }

  async function stateOf(wfId: string) {
    return (await engine.getWorkflow(wfId))!;
  }

  async function approvalRow(approvalId: string) {
    const res = await query(`SELECT * FROM approvals WHERE id = $1;`, [approvalId]);
    return res.rows[0];
  }

  async function orderCount(wfId: string) {
    const res = await query(`SELECT COUNT(*)::int AS n FROM orders WHERE id = $1;`, [`ord_${wfId}`]);
    return res.rows[0].n as number;
  }

  async function expireNow(approvalId: string) {
    await query(`UPDATE approvals SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1;`, [approvalId]);
  }

  async function api(method: string, routePath: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsId, "Approval Lifecycle Kitchen", "kitchen-v1");
    await provisionWorkspace(otherWsId, "Other Tenant Kitchen", "kitchen-v1");
    ownerToken = (await issueToken(wsId, "owner", "approval-owner")).token;
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [[wsId, otherWsId]]);
    await closePool();
  });

  it("approves once, submits one order, and rejects a second approval", async () => {
    const { wfId, approvalId } = await awaitingApproval();

    const first = await runner.approveAndSubmit(approvalId, "owner@kitchen.example", wsId);
    expect(first.state).toBe(WorkflowState.CONFIRMED);
    expect(await orderCount(wfId)).toBe(1);
    expect((await approvalRow(approvalId)).status).toBe("approved");

    const err = await runner.approveAndSubmit(approvalId, "owner@kitchen.example", wsId).catch((e) => e);
    expect(err).toBeInstanceOf(ApprovalDecisionError);
    expect(err.code).toBe("APPROVAL_NOT_PENDING");
    expect(await orderCount(wfId)).toBe(1);
  });

  it("lets exactly one of two concurrent approvals win and submits one order", async () => {
    const { wfId, approvalId } = await awaitingApproval();

    const results = await Promise.allSettled([
      runner.approveAndSubmit(approvalId, "owner@kitchen.example", wsId),
      runner.approveAndSubmit(approvalId, "owner@kitchen.example", wsId),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ApprovalDecisionError);
    expect(rejected[0].reason.code).toBe("APPROVAL_NOT_PENDING");
    expect(await orderCount(wfId)).toBe(1);
  });

  it("rejecting cancels the waiting workflow and submits nothing", async () => {
    const { wfId, approvalId } = await awaitingApproval();

    const res = await api("POST", `/api/approvals/${approvalId}/reject`, {
      reason: "Too expensive this week",
      decidedBy: "owner@kitchen.example",
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe(WorkflowState.CANCELLED);

    const wf = await stateOf(wfId);
    expect(wf.state).toBe(WorkflowState.CANCELLED);
    expect(wf.errorMessage).toBe("Too expensive this week");
    expect((await approvalRow(approvalId)).status).toBe("rejected");
    expect(await orderCount(wfId)).toBe(0);
  });

  it("revoking a pending approval blocks a later approve", async () => {
    const { wfId, approvalId } = await awaitingApproval();

    const revoke = await api("POST", `/api/approvals/${approvalId}/revoke`, {
      reason: "Supplier changed price",
      decidedBy: "owner@kitchen.example",
    });
    expect(revoke.status).toBe(200);
    expect(revoke.body.status).toBe("revoked");
    expect((await approvalRow(approvalId)).status).toBe("revoked");
    expect((await stateOf(wfId)).state).toBe(WorkflowState.CANCELLED);

    const approve = await api("POST", `/api/approvals/${approvalId}/approve`, {
      decidedBy: "owner@kitchen.example",
    });
    expect(approve.status).toBe(409);
    expect(approve.body.code).toBe("APPROVAL_NOT_PENDING");
    expect(await orderCount(wfId)).toBe(0);
  });

  it("refuses a decision after the window elapsed, expires it, and cancels the workflow", async () => {
    const { wfId, approvalId } = await awaitingApproval();
    await expireNow(approvalId);

    const res = await api("POST", `/api/approvals/${approvalId}/approve`, {
      decidedBy: "owner@kitchen.example",
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("APPROVAL_EXPIRED");

    expect((await approvalRow(approvalId)).status).toBe("expired");
    const wf = await stateOf(wfId);
    expect(wf.state).toBe(WorkflowState.CANCELLED);
    expect(wf.errorMessage).toBe("Owner approval window elapsed");
    expect(await orderCount(wfId)).toBe(0);
  });

  it("expires stale approvals in the list view and only within the requested workspace", async () => {
    const stale = await awaitingApproval(wsId);
    const otherStale = await awaitingApproval(otherWsId);
    await expireNow(stale.approvalId);
    await expireNow(otherStale.approvalId);

    const list = await api("GET", `/api/workspaces/${wsId}/approvals`);
    expect(list.status).toBe(200);
    const row = list.body.find((r: any) => r.id === stale.approvalId);
    expect(row.status).toBe("expired");
    expect((await stateOf(stale.wfId)).state).toBe(WorkflowState.CANCELLED);

    // The other tenant's stale approval was not touched by this workspace's read.
    expect((await approvalRow(otherStale.approvalId)).status).toBe("pending");
    expect((await stateOf(otherStale.wfId)).state).toBe(WorkflowState.AWAITING_APPROVAL);

    const swept = await engine.expireApprovals({ workspaceId: otherWsId });
    expect(swept).toBe(1);
    expect((await stateOf(otherStale.wfId)).state).toBe(WorkflowState.CANCELLED);
  });

  it("returns 404 for an unknown approval and never creates an order", async () => {
    const res = await api("POST", `/api/approvals/appr_does_not_exist_${run}/approve`, {
      decidedBy: "owner@kitchen.example",
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("APPROVAL_NOT_FOUND");
  });

  it("does not let a repeated reject change an already-approved approval", async () => {
    const { wfId, approvalId } = await awaitingApproval();
    await runner.approveAndSubmit(approvalId, "owner@kitchen.example", wsId);

    const res = await api("POST", `/api/approvals/${approvalId}/reject`, {
      reason: "Changed my mind",
      decidedBy: "owner@kitchen.example",
    });
    expect(res.status).toBe(409);
    expect((await approvalRow(approvalId)).status).toBe("approved");
    expect((await stateOf(wfId)).state).toBe(WorkflowState.CONFIRMED);
    expect(await orderCount(wfId)).toBe(1);
  });
});
