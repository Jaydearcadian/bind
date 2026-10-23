import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { createReplenishmentTools } from "../../src/agents/replenishmentTools.js";
import { getSupplierAdapter } from "../../src/adapters/suppliers/index.js";

const run = Date.now();
const SKU = "FOOD-FLOUR-50LB";

describe("Commitment gate is re-checked when the owner approves", () => {
  const engine = new WorkflowEngine();
  const app = createApp();
  const wsIds: string[] = [];
  const ownerTokens = new Map<string, string>();
  const spies: Array<{ mockRestore: () => void }> = [];
  let server: Server;
  let baseUrl = "";
  let counter = 0;

  beforeAll(async () => {
    await runMigrations();
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

  afterEach(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const id of wsIds.splice(0)) {
      await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  });

  /** A fresh kitchen workspace, so each test can change its suppliers, quotes and spend freely. */
  async function freshWorkspace(): Promise<string> {
    counter += 1;
    const wsId = `ws-recheck-${run}-${counter}`;
    wsIds.push(wsId);
    await provisionWorkspace(wsId, "Recheck Kitchen", "kitchen-v1");
    ownerTokens.set(wsId, (await issueToken(wsId, "owner", "recheck-owner")).token);
    return wsId;
  }

  function supplierOf(wsId: string) {
    return `${wsId}_supp-sysco-metro`;
  }

  async function insertQuote(wsId: string, totalCents: number): Promise<string> {
    counter += 1;
    const quoteId = `quote_rc_${run}_${counter}`;
    await query(
      `INSERT INTO quotes (id, workspace_id, rfq_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, currency, valid_until)
       VALUES ($1, $2, $3, $4, 'Sysco Metro Distribution', $5, 10, $6, $7, 'USDC', NOW() + INTERVAL '1 day');`,
      [quoteId, wsId, `rfq_${quoteId}`, supplierOf(wsId), SKU, totalCents / 10, totalCents]
    );
    return quoteId;
  }

  /** A workflow that holds a validated proposal and waits on an owner approval. */
  async function awaitingApproval(wsId: string, totalCents: number) {
    const quoteId = await insertQuote(wsId, totalCents);
    counter += 1;
    const wfId = `wf_rc_${run}_${counter}`;
    const approvalId = `appr_${wfId}`;
    await engine.createWorkflow(wfId, wsId, "kitchen_replenishment", `idem_rc_${wfId}`, {
      sku: SKU,
      itemName: "Organic All-Purpose Flour",
      replenishmentProposal: {
        proposalId: `prop_${wfId}`,
        workflowId: wfId,
        sku: SKU,
        itemName: "Organic All-Purpose Flour",
        quantity: 10,
        supplierId: supplierOf(wsId),
        supplierName: "Sysco Metro Distribution",
        quoteId,
        unitPriceCents: String(totalCents / 10),
        totalPriceCents: String(totalCents),
        jevEvaluation: { holdForOwnerReview: false },
        status: "VALIDATED",
      },
    });
    await engine.transition(wfId, { fromState: WorkflowState.DRAFT, toState: WorkflowState.AWAITING_APPROVAL });
    await engine.createApproval(approvalId, wsId, "order", wfId, `Purchase 10x ${SKU}`, BigInt(totalCents), "procurement_agent");
    return { wfId, approvalId, quoteId };
  }

  async function insertSpend(wsId: string, totalCents: number) {
    counter += 1;
    await query(
      `INSERT INTO orders (id, workspace_id, order_number, supplier_name, item_sku, item_name, quantity, unit_price_cents, total_price_cents, status, idempotency_key)
       VALUES ($1, $2, $3, 'Other Supplier', 'FOOD-OTHER', 'Other', 1, $4, $4, 'confirmed', $5);`,
      [`ord_spend_${run}_${counter}`, wsId, `PO-SPEND-${counter}`, totalCents, `idem_spend_${run}_${counter}`]
    );
  }

  async function api(method: string, routePath: string, token: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() as any };
  }

  async function approve(approvalId: string, wsId: string) {
    return api("POST", `/api/approvals/${approvalId}/approve`, ownerTokens.get(wsId)!, { decidedBy: "owner@kitchen.example" });
  }

  async function orderCount(wfId: string): Promise<number> {
    const res = await query(`SELECT COUNT(*)::int AS n FROM orders WHERE id = $1;`, [`ord_${wfId}`]);
    return res.rows[0].n;
  }

  async function stateOf(wfId: string) {
    return (await engine.getWorkflow(wfId))!;
  }

  async function approvalStatus(approvalId: string): Promise<string> {
    return (await query(`SELECT status FROM approvals WHERE id = $1;`, [approvalId])).rows[0].status;
  }

  /** Spies on the supplier adapter the route would use. The adapter instance is cached, so the spy sees the route's calls. */
  function countSupplierSubmissions(wsId: string) {
    const adapter = getSupplierAdapter(supplierOf(wsId));
    const spy = vi.spyOn(adapter, "submitOrder");
    spies.push(spy);
    return spy;
  }

  it("approval is refused and the workflow cancelled when the daily limit was used up after the approval was requested", async () => {
    const wsId = await freshWorkspace();
    const { wfId, approvalId } = await awaitingApproval(wsId, 24500);
    await insertSpend(wsId, 80000); // $800 committed after the request; $800 + $245 > $1,000
    const submissions = countSupplierSubmissions(wsId);

    const res = await approve(approvalId, wsId);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("POLICY_DENIED");
    expect(res.body.reasonCodes).toEqual(["DAILY_LIMIT_EXCEEDED"]);
    expect(submissions).not.toHaveBeenCalled();
    expect(await orderCount(wfId)).toBe(0);
    expect((await stateOf(wfId)).state).toBe(WorkflowState.CANCELLED);
    expect(await approvalStatus(approvalId)).toBe("rejected");

    const audit = await query(
      `SELECT policy_decision, evidence FROM audit_logs WHERE workflow_id = $1 AND action = 'commitment.recheck';`,
      [wfId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].policy_decision).toBe("DENY");
    expect(audit.rows[0].evidence.reasonCodes).toEqual(["DAILY_LIMIT_EXCEEDED"]);
  });

  it("approval is refused when the quote expired while waiting", async () => {
    const wsId = await freshWorkspace();
    const { wfId, approvalId, quoteId } = await awaitingApproval(wsId, 24500);
    await query(`UPDATE quotes SET valid_until = NOW() - INTERVAL '1 minute' WHERE id = $1;`, [quoteId]);
    const submissions = countSupplierSubmissions(wsId);

    const res = await approve(approvalId, wsId);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("POLICY_DENIED");
    expect(res.body.reasonCodes).toEqual(["QUOTE_EXPIRED"]);
    expect(submissions).not.toHaveBeenCalled();
    expect(await orderCount(wfId)).toBe(0);
    expect((await stateOf(wfId)).state).toBe(WorkflowState.CANCELLED);
  });

  it("approval is refused when the supplier was unverified while waiting", async () => {
    const wsId = await freshWorkspace();
    const { wfId, approvalId } = await awaitingApproval(wsId, 24500);
    await query(`UPDATE suppliers SET verified = FALSE WHERE id = $1;`, [supplierOf(wsId)]);
    const submissions = countSupplierSubmissions(wsId);

    const res = await approve(approvalId, wsId);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("POLICY_DENIED");
    expect(res.body.reasonCodes).toEqual(["SUPPLIER_NOT_VERIFIED"]);
    expect(submissions).not.toHaveBeenCalled();
    expect(await orderCount(wfId)).toBe(0);
    expect((await stateOf(wfId)).state).toBe(WorkflowState.CANCELLED);
  });

  it("approval still proceeds when the only reason is the approval threshold", async () => {
    const wsId = await freshWorkspace();
    // $300 is above the $250 threshold and below the $500 role limit, so the only escalation is the threshold.
    const { wfId, approvalId } = await awaitingApproval(wsId, 30000);

    const res = await approve(approvalId, wsId);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe(WorkflowState.CONFIRMED);
    expect(await orderCount(wfId)).toBe(1);
    expect(await approvalStatus(approvalId)).toBe("approved");
  });

  it("request_policy_evaluation writes an audit row with the reason codes for allow, escalate and deny", async () => {
    const wsId = await freshWorkspace();
    const tools = (wfId: string) => createReplenishmentTools({ workspaceId: wsId, workflowId: wfId });
    const evaluate = async (totalCents: number) => {
      const quoteId = await insertQuote(wsId, totalCents);
      counter += 1;
      const wfId = `wf_eval_${run}_${counter}`;
      await engine.createWorkflow(wfId, wsId, "kitchen_replenishment", `idem_eval_${wfId}`, {
        sku: SKU,
        replenishmentProposal: {
          proposalId: `prop_${wfId}`,
          workflowId: wfId,
          sku: SKU,
          quantity: 10,
          supplierId: supplierOf(wsId),
          supplierName: "Sysco Metro Distribution",
          quoteId,
          unitPriceCents: String(totalCents / 10),
          totalPriceCents: String(totalCents),
          jevEvaluation: { holdForOwnerReview: false },
          status: "VALIDATED",
        },
      });
      const out = JSON.parse(await tools(wfId).requestPolicyEvaluationTool.invoke({ requestId: wfId }));
      return { wfId, out };
    };
    const auditFor = async (wfId: string) =>
      (await query(`SELECT policy_decision, evidence FROM audit_logs WHERE workflow_id = $1 AND action = 'commitment.evaluate';`, [wfId])).rows;

    const allow = await evaluate(24500);
    expect(allow.out.policyDecision).toBe("ALLOW");
    expect(allow.out.workflowState).toBe(WorkflowState.AUTHORIZED);
    expect(allow.out.reasonCodes).toEqual([]);
    const allowAudit = await auditFor(allow.wfId);
    expect(allowAudit).toHaveLength(1);
    expect(allowAudit[0].policy_decision).toBe("ALLOW");
    expect(allowAudit[0].evidence.reasonCodes).toEqual([]);

    const escalate = await evaluate(30000);
    expect(escalate.out.policyDecision).toBe("REQUIRE_APPROVAL");
    expect(escalate.out.workflowState).toBe(WorkflowState.AWAITING_APPROVAL);
    expect(escalate.out.approvalId).toBe(`appr_${escalate.wfId}`);
    expect(escalate.out.reasonCodes).toEqual(["ABOVE_APPROVAL_THRESHOLD"]);
    const approvalRow = await query(`SELECT status, entity_id FROM approvals WHERE id = $1;`, [escalate.out.approvalId]);
    expect(approvalRow.rows[0]).toMatchObject({ status: "pending", entity_id: escalate.wfId });
    const escalateAudit = await auditFor(escalate.wfId);
    expect(escalateAudit[0].policy_decision).toBe("REQUIRE_APPROVAL");
    expect(escalateAudit[0].evidence.reasonCodes).toEqual(["ABOVE_APPROVAL_THRESHOLD"]);

    await insertSpend(wsId, 80000);
    const deny = await evaluate(24500);
    expect(deny.out.policyDecision).toBe("DENY");
    expect(deny.out.workflowState).toBe(WorkflowState.FAILED);
    expect(deny.out.reasonCodes).toEqual(["DAILY_LIMIT_EXCEEDED"]);
    const wf = await query(`SELECT state, error_message FROM workflows WHERE id = $1;`, [deny.wfId]);
    expect(wf.rows[0].state).toBe("failed");
    expect(wf.rows[0].error_message).toMatch(/DAILY_LIMIT_EXCEEDED/);
    expect(wf.rows[0].error_message).toMatch(/Daily spend limit exceeded/);
    const denyAudit = await auditFor(deny.wfId);
    expect(denyAudit[0].policy_decision).toBe("DENY");
    expect(denyAudit[0].evidence.reasonCodes).toEqual(["DAILY_LIMIT_EXCEEDED"]);
  });
});
