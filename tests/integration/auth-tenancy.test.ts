import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { LocalSettlementSimulator } from "../../src/adapters/settlement/local-sim.js";
import { stableText } from "../helpers/error-body.js";

const run = Date.now();
const wsA = `ws-auth-a-${run}`;
const wsB = `ws-auth-b-${run}`;
const wsC = `ws-auth-c-${run}`;
const wsD = `ws-auth-d-${run}`;
const wsNew = `ws-auth-new-${run}`;
const wsNewCreate = `ws-auth-create-${run}`;
const wsMissing = `ws-auth-missing-${run}`;
const allWorkspaceIds = [wsA, wsB, wsC, wsD, wsNew, wsNewCreate];

const NOT_FOUND = { error: "Workspace not found" };
const AUTH_REQUIRED = { error: "Authentication required" };
const OWNER_REQUIRED = { error: "Owner role required" };

/**
 * Every route in createApp, with its access level. The route-table test fails when createApp registers a route that is
 * not listed here, so a new route cannot ship unprotected by accident.
 */
const PUBLIC_ROUTES: Array<[string, string]> = [
  ["GET", "/health"],
  // Readiness is public and answers no data (ADR 0032). Metrics is not a workspace route: it needs BIND_METRICS_TOKEN.
  ["GET", "/ready"],
  ["GET", "/metrics"],
  ["GET", "/api/templates"],
  ["GET", "/api/templates/:id/blueprint"],
  // The browser's sign-in config: the public Privy app id or null, never cached (docs/decisions/0070). Its tests are in public-config.test.ts.
  ["GET", "/api/public-config"],
  // The OpenAPI document, generated from the route registry (docs/decisions/0034). Public, describes no data.
  ["GET", "/api/openapi.json"],
  ["POST", "/api/workspaces/onboard"],
  ["POST", "/api/workspaces"],
  // Creates a throwaway demo workspace and returns its owner token once (docs/decisions/0057). Its own tests are in demo.test.ts.
  ["POST", "/api/demo"],
  ["POST", "/api/webhooks/incoming"],
  ["GET", "*"],
];

/** Owner or staff of the workspace in the path (or, for the list, the caller's own workspace). */
const ANY_ROLE_ROUTES: Array<[string, string]> = [
  // Staff and owner may record a charge on a tab: it is an obligation, and it is audited with the token (ADR 0081).
  ["POST", "/api/workspaces/:id/tabs/charges"],
  ["GET", "/api/workspaces"],
  // Who the token is (ADR 0058). The route answers for the caller's own workspace only.
  ["GET", "/api/me"],
  ["GET", "/api/workspaces/:id"],
  ["GET", "/api/workspaces/:id/inventory"],
  ["POST", "/api/workspaces/:id/inventory"],
  ["POST", "/api/workspaces/:id/replenish"],
  ["GET", "/api/workspaces/:id/approvals"],
  ["GET", "/api/workspaces/:id/workflows"],
  ["GET", "/api/workspaces/:id/orders"],
  ["GET", "/api/workspaces/:id/suppliers"],
  ["GET", "/api/workspaces/:id/agents"],
  ["GET", "/api/workspaces/:id/surfaces"],
  ["GET", "/api/workspaces/:id/documents"],
  ["POST", "/api/workspaces/:id/documents/extract"],
  ["GET", "/api/workspaces/:id/accounting/ledger"],
  ["GET", "/api/workspaces/:id/audit"],
  // The event stream (docs/decisions/0035) and its poll fallback. Both take the Authorization header only.
  ["GET", "/api/workspaces/:id/events"],
  ["GET", "/api/workspaces/:id/events/poll"],
  ["GET", "/api/workspaces/:id/customer-orders"],
  ["POST", "/api/workspaces/:id/customer-orders"],
  ["GET", "/api/workspaces/:id/customer-orders/:orderId"],
  ["POST", "/api/workspaces/:id/customer-orders/:orderId/cancel"],
  ["POST", "/api/workspaces/:id/customer-orders/:orderId/fulfil"],
  ["GET", "/api/workspaces/:id/kitchen-capacity"],
  ["POST", "/api/workspaces/:id/feedback"],
  ["GET", "/api/workspaces/:id/feedback"],
  ["GET", "/api/workspaces/:id/feedback/summary"],
  ["POST", "/api/workspaces/:id/menu-proposals"],
  ["GET", "/api/workspaces/:id/menu-proposals"],
  ["GET", "/api/workspaces/:id/menu"],
  ["GET", "/api/workspaces/:id/needs-attention"],
  ["GET", "/api/workspaces/:id/workflows/:workflowId"],
  ["GET", "/api/workspaces/:id/orders/:orderId"],
  ["GET", "/api/workspaces/:id/approvals/:approvalId"],
  // Ends the account session the request used; a workspace token is told signedOut: false and keeps working.
  ["POST", "/api/auth/sign-out"],
];

/**
 * Routes that take a Privy access token, not a workspace token (ADR 0051). Without a configured Privy app they answer 503 and
 * touch nothing; with one, a missing or workspace token is 401 (tests/integration/accounts.test.ts).
 */
const ACCOUNT_ROUTES: Array<[string, string]> = [
  ["POST", "/api/auth/session"],
  ["GET", "/api/account/workspaces"],
  ["POST", "/api/account/workspaces"],
  ["POST", "/api/account/invites/accept"],
];

/** Owner of the workspace in the path, or of the approval or order whose workspace the service checks. */
const OWNER_ROUTES: Array<[string, string]> = [
  ["PUT", "/api/workspaces/:id/policy"],
  // Reading a tab and settling it are owner actions (ADR 0081).
  ["GET", "/api/workspaces/:id/tabs"],
  ["GET", "/api/workspaces/:id/tabs/:counterpartyId"],
  ["POST", "/api/workspaces/:id/tabs/:counterpartyId/settle"],
  ["POST", "/api/workspaces/:id/suppliers"],
  ["POST", "/api/workspaces/:id/agents"],
  ["POST", "/api/workspaces/:id/surfaces"],
  // Owner notices by email (ADR 0074): owner only. A staff token is refused, another workspace is 404.
  ["GET", "/api/workspaces/:id/notifications"],
  ["POST", "/api/workspaces/:id/notifications/email"],
  ["POST", "/api/workspaces/:id/notifications/email/verify"],
  ["DELETE", "/api/workspaces/:id/notifications/email/:emailId"],
  ["POST", "/api/workspaces/:id/documents/:docId/confirm"],
  ["POST", "/api/workspaces/:id/recover"],
  // Deletes a demo workspace and returns a fresh one. A workspace that is not a demo is refused (docs/decisions/0057).
  ["POST", "/api/workspaces/:id/demo/reset"],
  ["POST", "/api/workspaces/:id/tokens"],
  ["GET", "/api/workspaces/:id/tokens"],
  // People (ADR 0051): invitations and members are owner routes.
  ["POST", "/api/workspaces/:id/invites"],
  ["GET", "/api/workspaces/:id/invites"],
  ["DELETE", "/api/workspaces/:id/invites/:inviteId"],
  ["GET", "/api/workspaces/:id/members"],
  ["PUT", "/api/workspaces/:id/members/:accountId"],
  ["DELETE", "/api/workspaces/:id/members/:accountId"],
  ["DELETE", "/api/workspaces/:id/tokens/:tokenId"],
  ["PUT", "/api/workspaces/:id/agents-paused"],
  ["POST", "/api/workspaces/:id/customer-orders/:orderId/accept"],
  ["PUT", "/api/workspaces/:id/kitchen-capacity"],
  ["POST", "/api/workspaces/:id/menu-proposals/:proposalId/approve"],
  ["POST", "/api/workspaces/:id/menu-proposals/:proposalId/reject"],
  ["POST", "/api/workspaces/:id/menu-proposals/:proposalId/cancel"],
  ["POST", "/api/workspaces/:id/menu-proposals/:proposalId/publish"],
  ["POST", "/api/workspaces/:id/workflows/:workflowId/cancel"],
  ["GET", "/api/workspaces/:id/webhook-secret"],
  ["POST", "/api/workspaces/:id/webhook-secret/rotate"],
  ["GET", "/api/workspaces/:id/connectors"],
  ["PUT", "/api/workspaces/:id/connectors/:connectorId"],
  ["DELETE", "/api/workspaces/:id/connectors/:connectorId"],
  ["POST", "/api/workspaces/:id/connectors/:connectorId/verify"],
  ["POST", "/api/approvals/:id/approve"],
  ["POST", "/api/approvals/:id/reject"],
  ["POST", "/api/approvals/:id/revoke"],
  ["POST", "/api/orders/:id/reconcile"],
  ["POST", "/api/orders/:id/confirm-settlement"],
];

/**
 * The hosted MCP endpoint (docs/decisions/0075). A staff workspace key only: an owner key or an account session gets 403, and
 * no token gets 401 on all three methods. GET and DELETE answer 405 once authenticated. Its own tests are in hosted-mcp.test.ts.
 */
const STAFF_KEY_ROUTES: Array<[string, string]> = [
  ["POST", "/mcp"],
  ["GET", "/mcp"],
  ["DELETE", "/mcp"],
];

const PROTECTED_ROUTES = [...ANY_ROLE_ROUTES, ...OWNER_ROUTES, ...STAFF_KEY_ROUTES];

/** Substitutes a path template with a value that is not a real record. */
function fillPath(template: string): string {
  return template
    .replace(":id", wsA)
    .replace(/:(\w+)/g, (_m, name: string) => `${name}_none`);
}

function routesOf(app: any): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const layer of app._router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      out.push({ method: method.toUpperCase(), path: layer.route.path });
    }
  }
  return out;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Per-workspace owner and staff tokens: tenancy enforced on the server", () => {
  const engine = new WorkflowEngine();
  const runner = new ProcurementWorkflowRunner();
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  let counter = 0;

  let ownerA: { id: string; token: string };
  let staffA: { id: string; token: string };
  let ownerB: { id: string; token: string };
  let staffB: { id: string; token: string };

  type CallOptions = { token?: string; authorization?: string; body?: unknown };
  async function call(method: string, routePath: string, opts: CallOptions = {}) {
    const headers: Record<string, string> = {};
    if (opts.authorization !== undefined) headers.Authorization = opts.authorization;
    else if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, text, body, headers: res.headers };
  }

  /** A quote, a workflow waiting on an owner approval, and the approval row. */
  async function awaitingApproval(workspaceId: string) {
    counter += 1;
    const label = `${run}_${counter}`;
    const wfId = `wf_auth_${label}`;
    const approvalId = `appr_auth_${label}`;
    const quote = {
      quoteId: `quote_auth_${label}`,
      rfqId: `rfq_auth_${label}`,
      supplierId: `${workspaceId}_supp-sysco-metro`,
      supplierName: "Sysco Metro Distribution",
      sku: "FOOD-FLOUR-50LB",
      quantity: 10,
      unitPriceCents: "2450",
      totalPriceCents: "24500",
    };
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
    await engine.createWorkflow(wfId, workspaceId, "kitchen_replenishment", `idem_auth_${label}`, {
      itemName: "Organic All-Purpose Flour",
      quote,
    });
    await engine.transition(wfId, { fromState: WorkflowState.DRAFT, toState: WorkflowState.AWAITING_APPROVAL });
    await engine.createApproval(approvalId, workspaceId, "order", wfId, "submit_order", 24500n, "procurement");
    return { wfId, approvalId, orderId: `ord_${wfId}` };
  }

  async function approvalRow(approvalId: string) {
    return (await query(`SELECT * FROM approvals WHERE id = $1;`, [approvalId])).rows[0];
  }

  async function workflowState(wfId: string) {
    return (await engine.getWorkflow(wfId))!.state;
  }

  async function orderCount(orderId: string) {
    return (await query(`SELECT COUNT(*)::int AS n FROM orders WHERE id = $1;`, [orderId])).rows[0].n as number;
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsA, "Tenancy Kitchen A", "kitchen-v1");
    await provisionWorkspace(wsB, "Tenancy Kitchen B", "kitchen-v1");
    ownerA = await issueToken(wsA, "owner", "alice");
    staffA = await issueToken(wsA, "staff", "line-cook");
    ownerB = await issueToken(wsB, "owner", "bob");
    staffB = await issueToken(wsB, "staff", "bob-staff");
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
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [allWorkspaceIds]);
    for (const id of allWorkspaceIds) {
      await fs.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    }
    await closePool();
  });

  it("no token gives 401 on every protected route", async () => {
    for (const [method, template] of PROTECTED_ROUTES) {
      const res = await call(method, fillPath(template), {
        body: method === "GET" || method === "DELETE" ? undefined : {},
      });
      expect(res.status, `${method} ${template}`).toBe(401);
      expect(res.body, `${method} ${template}`).toMatchObject(AUTH_REQUIRED);
    }
  });

  it("every route in createApp is either protected or listed as public", () => {
    const registered = routesOf(createApp());
    const key = (method: string, p: string) => `${method} ${p}`;
    const registeredKeys = new Set(registered.map((r) => key(r.method, r.path)));
    const listedKeys = new Set([...PUBLIC_ROUTES, ...PROTECTED_ROUTES, ...ACCOUNT_ROUTES].map(([m, p]) => key(m, p)));

    const unlisted = [...registeredKeys].filter((k) => !listedKeys.has(k));
    const absent = [...listedKeys].filter((k) => !registeredKeys.has(k));
    expect(unlisted).toEqual([]);
    expect(absent).toEqual([]);
  });

  it("a malformed, unknown and revoked token all give the same 401 body", async () => {
    const revoked = await issueToken(wsA, "staff", "revoked-one");
    const revokeRes = await call("DELETE", `/api/workspaces/${wsA}/tokens/${revoked.id}`, { token: ownerA.token });
    expect(revokeRes.status).toBe(200);

    const probes: Array<{ name: string; opts: CallOptions }> = [
      { name: "missing", opts: {} },
      { name: "malformed", opts: { token: "bnd_short" } },
      { name: "wrong prefix", opts: { token: `xyz_${"A".repeat(43)}` } },
      { name: "unknown", opts: { token: `bnd_${"B".repeat(43)}` } },
      { name: "revoked", opts: { token: revoked.token } },
      { name: "other scheme", opts: { authorization: "Basic dXNlcjpwYXNz" } },
    ];

    const texts: string[] = [];
    for (const probe of probes) {
      const res = await call("GET", `/api/workspaces/${wsA}/inventory`, probe.opts);
      expect(res.status, probe.name).toBe(401);
      expect(res.body, probe.name).toMatchObject(AUTH_REQUIRED);
      texts.push(stableText(res.text));
    }
    expect(new Set(texts).size).toBe(1);
  });

  it("a token for workspace A gets 404, not 403, on workspace B's workspace, inventory, approvals, workflows, orders, suppliers, agents, surfaces, documents, ledger and audit", async () => {
    const readPaths = [
      `/api/workspaces/${wsB}`,
      `/api/workspaces/${wsB}/inventory`,
      `/api/workspaces/${wsB}/approvals`,
      `/api/workspaces/${wsB}/workflows`,
      `/api/workspaces/${wsB}/orders`,
      `/api/workspaces/${wsB}/suppliers`,
      `/api/workspaces/${wsB}/agents`,
      `/api/workspaces/${wsB}/surfaces`,
      `/api/workspaces/${wsB}/documents`,
      `/api/workspaces/${wsB}/accounting/ledger`,
      `/api/workspaces/${wsB}/audit`,
    ];
    const missing = await call("GET", `/api/workspaces/${wsMissing}/inventory`, { token: ownerA.token });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject(NOT_FOUND);

    for (const p of readPaths) {
      for (const caller of [ownerA, staffA]) {
        const res = await call("GET", p, { token: caller.token });
        expect(res.status, p).toBe(404);
        expect(stableText(res.text), p).toBe(stableText(missing.text));
      }
    }

    // A write on the other tenant is refused the same way, before any body is read.
    const policy = await call("PUT", `/api/workspaces/${wsB}/policy`, {
      token: ownerA.token,
      body: { budgetDailyLimitCents: 1, approvalThresholdCents: 0 },
    });
    expect(policy.status).toBe(404);
    expect(stableText(policy.text)).toBe(stableText(missing.text));
  });

  it("a token for A cannot approve, reject or revoke an approval of B and nothing changes", async () => {
    const approvals = [await awaitingApproval(wsB), await awaitingApproval(wsB), await awaitingApproval(wsB)];
    const [approve, reject, revoke] = approvals;

    const attempts = [
      { action: "approve", approval: approve },
      { action: "reject", approval: reject },
      { action: "revoke", approval: revoke },
    ];
    for (const { action, approval } of attempts) {
      const res = await call("POST", `/api/approvals/${approval.approvalId}/${action}`, {
        token: ownerA.token,
        body: { decidedBy: "owner@other-tenant.example", reason: "cross-tenant attempt" },
      });
      expect(res.status, action).toBe(404);
      expect(res.body, action).toMatchObject({ error: expect.any(String), code: "APPROVAL_NOT_FOUND" });
    }

    for (const { approvalId, wfId, orderId } of approvals) {
      expect((await approvalRow(approvalId)).status).toBe("pending");
      expect((await approvalRow(approvalId)).decided_by).toBeNull();
      expect(await workflowState(wfId)).toBe(WorkflowState.AWAITING_APPROVAL);
      expect(await orderCount(orderId)).toBe(0);
    }
  });

  it("a token for A cannot reconcile or confirm settlement for an order of B", async () => {
    const { wfId, approvalId, orderId } = await awaitingApproval(wsB);
    await runner.approveAndSubmit(approvalId, "owner@other-tenant.example", wsB);
    expect(await workflowState(wfId)).toBe(WorkflowState.CONFIRMED);
    expect((await query(`SELECT status FROM orders WHERE id = $1;`, [orderId])).rows[0].status).toBe("confirmed");

    const transfer = vi.spyOn(LocalSettlementSimulator.prototype, "transferUSDC");
    try {
      const reconcile = await call("POST", `/api/orders/${orderId}/reconcile`, { token: ownerA.token });
      expect(reconcile.status).toBe(404);
      expect(reconcile.body).toMatchObject({ error: expect.any(String), code: "ORDER_NOT_FOUND" });

      const confirm = await call("POST", `/api/orders/${orderId}/confirm-settlement`, { token: ownerA.token });
      expect(confirm.status).toBe(404);
      expect(confirm.body).toMatchObject({ error: expect.any(String), code: "ORDER_NOT_FOUND" });

      expect(transfer).not.toHaveBeenCalled();
      expect((await query(`SELECT status FROM orders WHERE id = $1;`, [orderId])).rows[0].status).toBe("confirmed");
      expect(await workflowState(wfId)).toBe(WorkflowState.CONFIRMED);

      // Control: the owner of B can reconcile the same order, so the refusal above is the tenancy check and not a fault.
      const own = await call("POST", `/api/orders/${orderId}/reconcile`, { token: ownerB.token });
      expect(own.status).toBe(200);
      expect(transfer).toHaveBeenCalledTimes(1);
    } finally {
      transfer.mockRestore();
    }
  });

  it("a staff token can read and trigger replenishment but gets 403 on approve, reject, revoke, policy, suppliers, agents, surfaces, document confirm, reconcile, confirm-settlement, recover and token routes", async () => {
    const sku = `SKU-AUTH-STAFF-${run}`;
    const add = await call("POST", `/api/workspaces/${wsA}/inventory`, {
      token: staffA.token,
      body: {
        sku,
        name: "Staff Test Flour",
        category: "Dry Goods",
        unit: "bag",
        currentQuantity: 1,
        parLevel: 10,
        reorderQuantity: 5,
        unitPriceCents: 1000,
      },
    });
    expect(add.status).toBe(201);

    expect((await call("GET", `/api/workspaces/${wsA}/inventory`, { token: staffA.token })).status).toBe(200);
    const replenish = await call("POST", `/api/workspaces/${wsA}/replenish`, { token: staffA.token, body: { sku } });
    expect(replenish.status).toBe(200);
    expect(replenish.body.workflowId).toBeDefined();

    const pending = await awaitingApproval(wsA);
    const forbidden: Array<[string, string, unknown?]> = [
      ["POST", `/api/approvals/${pending.approvalId}/approve`],
      ["POST", `/api/approvals/${pending.approvalId}/reject`, { reason: "no" }],
      ["POST", `/api/approvals/${pending.approvalId}/revoke`, { reason: "no" }],
      ["PUT", `/api/workspaces/${wsA}/policy`, { budgetDailyLimitCents: 5000, approvalThresholdCents: 100 }],
      ["POST", `/api/workspaces/${wsA}/suppliers`, { id: "supp-staff", name: "Staff Supplier", adapterType: "manual_quote" }],
      ["POST", `/api/workspaces/${wsA}/agents`, { roleName: "staff_agent", displayName: "x", allowedTools: [] }],
      ["POST", `/api/workspaces/${wsA}/surfaces`, { surface: "whatsapp", actorId: "whatsapp:+1", actorRole: "owner" }],
      ["POST", `/api/workspaces/${wsA}/documents/doc_none/confirm`, {}],
      ["POST", `/api/orders/${pending.orderId}/reconcile`],
      ["POST", `/api/orders/${pending.orderId}/confirm-settlement`],
      ["POST", `/api/workspaces/${wsA}/recover`],
      ["POST", `/api/workspaces/${wsA}/tokens`, { role: "owner", label: "staff-made" }],
      ["GET", `/api/workspaces/${wsA}/tokens`],
      ["DELETE", `/api/workspaces/${wsA}/tokens/tok_none`],
    ];
    for (const [method, p, body] of forbidden) {
      const res = await call(method, p, { token: staffA.token, body });
      expect(res.status, `${method} ${p}`).toBe(403);
      expect(res.body, `${method} ${p}`).toMatchObject(OWNER_REQUIRED);
    }

    expect((await approvalRow(pending.approvalId)).status).toBe("pending");
    expect(await workflowState(pending.wfId)).toBe(WorkflowState.AWAITING_APPROVAL);
    expect(await orderCount(pending.orderId)).toBe(0);
    const suppliers = await query(`SELECT 1 FROM suppliers WHERE id = $1;`, [`${wsA}_supp-staff`]);
    expect(suppliers.rows).toHaveLength(0);
  });

  it("the body decidedBy is ignored and the audit row records the token label", async () => {
    const approved = await awaitingApproval(wsA);
    const res = await call("POST", `/api/approvals/${approved.approvalId}/approve`, {
      token: ownerA.token,
      body: { decidedBy: "mallory@example.test" },
    });
    expect(res.status).toBe(200);

    const row = await approvalRow(approved.approvalId);
    expect(row.status).toBe("approved");
    expect(row.decided_by).toBe("owner:alice");

    const audit = await query(
      `SELECT actor_type, actor_id, evidence::text AS evidence_text FROM audit_logs
       WHERE workflow_id = $1 AND action = 'approval.approved';`,
      [approved.wfId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_type).toBe("owner");
    expect(audit.rows[0].actor_id).toBe("owner:alice");
    expect(audit.rows[0].evidence_text).not.toContain("mallory");

    const rejected = await awaitingApproval(wsA);
    const rej = await call("POST", `/api/approvals/${rejected.approvalId}/reject`, {
      token: ownerA.token,
      body: { decidedBy: "mallory@example.test", reason: "Too expensive" },
    });
    expect(rej.status).toBe(200);
    expect((await approvalRow(rejected.approvalId)).decided_by).toBe("owner:alice");
    const rejAudit = await query(
      `SELECT actor_id FROM audit_logs WHERE workflow_id = $1 AND action = 'approval.rejected';`,
      [rejected.wfId]
    );
    expect(rejAudit.rows.map((r) => r.actor_id)).toEqual(["owner:alice"]);
  });

  it("a revoked token stops working immediately", async () => {
    const second = await issueToken(wsA, "owner", "second-owner");
    expect((await call("GET", `/api/workspaces/${wsA}/inventory`, { token: second.token })).status).toBe(200);

    const revoke = await call("DELETE", `/api/workspaces/${wsA}/tokens/${second.id}`, { token: ownerA.token });
    expect(revoke.status).toBe(200);

    const after = await call("GET", `/api/workspaces/${wsA}/inventory`, { token: second.token });
    expect(after.status).toBe(401);
    expect(after.body).toMatchObject(AUTH_REQUIRED);
  });

  it("the last active owner token cannot be revoked", async () => {
    await provisionWorkspace(wsC, "Last Owner Kitchen", "kitchen-v1");
    const only = await issueToken(wsC, "owner", "solo");

    const refused = await call("DELETE", `/api/workspaces/${wsC}/tokens/${only.id}`, { token: only.token });
    expect(refused.status).toBe(409);

    const created = await call("POST", `/api/workspaces/${wsC}/tokens`, {
      token: only.token,
      body: { role: "owner", label: "backup" },
    });
    expect(created.status).toBe(201);
    const backup = created.body as { id: string; token: string };

    const first = await call("DELETE", `/api/workspaces/${wsC}/tokens/${only.id}`, { token: backup.token });
    expect(first.status).toBe(200);

    const last = await call("DELETE", `/api/workspaces/${wsC}/tokens/${backup.id}`, { token: backup.token });
    expect(last.status).toBe(409);

    expect((await call("GET", `/api/workspaces/${wsC}/inventory`, { token: backup.token })).status).toBe(200);
  });

  it("GET /api/workspaces returns only the caller's workspace", async () => {
    const asOwnerA = await call("GET", "/api/workspaces", { token: ownerA.token });
    expect(asOwnerA.status).toBe(200);
    expect(asOwnerA.body.map((w: any) => w.id)).toEqual([wsA]);

    const asStaffB = await call("GET", "/api/workspaces", { token: staffB.token });
    expect(asStaffB.status).toBe(200);
    expect(asStaffB.body.map((w: any) => w.id)).toEqual([wsB]);
    expect(asStaffB.text).not.toContain(wsA);
  });

  it("recover touches only the caller's workspace", async () => {
    const stuckA = `wf_stuck_a_${run}`;
    const stuckB = `wf_stuck_b_${run}`;
    await engine.createWorkflow(stuckA, wsA, "kitchen_replenishment", `idem_stuck_a_${run}`, { sku: "X" });
    await engine.createWorkflow(stuckB, wsB, "kitchen_replenishment", `idem_stuck_b_${run}`, { sku: "X" });

    const res = await call("POST", `/api/workspaces/${wsA}/recover`, { token: ownerA.token });
    expect(res.status).toBe(200);
    const touched = res.body.details.map((d: any) => d.workflowId);
    expect(touched).toContain(stuckA);
    expect(touched).not.toContain(stuckB);

    expect(await workflowState(stuckA)).toBe(WorkflowState.FAILED);
    expect(await workflowState(stuckB)).toBe(WorkflowState.DRAFT);
  });

  it("a token is returned once and only its hash is stored", async () => {
    const created = await call("POST", `/api/workspaces/${wsA}/tokens`, {
      token: ownerA.token,
      body: { role: "staff", label: "new-cook" },
    });
    expect(created.status).toBe(201);
    expect(Object.keys(created.body).sort()).toEqual(["id", "label", "role", "token"]);
    const { id, token } = created.body as { id: string; token: string };
    expect(token).toMatch(/^bnd_[A-Za-z0-9_-]{43}$/);

    const stored = await query(
      `SELECT token_hash, row_to_json(t)::text AS row_json FROM workspace_tokens t WHERE id = $1;`,
      [id]
    );
    expect(stored.rows[0].token_hash).toBe(sha256(token));
    expect(stored.rows[0].row_json).not.toContain(token);

    const list = await call("GET", `/api/workspaces/${wsA}/tokens`, { token: ownerA.token });
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(token);
    expect(list.text).not.toContain(sha256(token));
    const entry = list.body.find((t: any) => t.id === id);
    expect(Object.keys(entry).sort()).toEqual(["createdAt", "id", "label", "revokedAt", "role"]);

    const later = [
      await call("GET", `/api/workspaces/${wsA}`, { token: ownerA.token }),
      await call("GET", `/api/workspaces/${wsA}/audit`, { token: ownerA.token }),
      await call("GET", `/api/workspaces/${wsA}/tokens`, { token: staffA.token }),
    ];
    for (const res of later) {
      expect(res.text).not.toContain(token);
    }
    const audit = await query(
      `SELECT action, evidence::text AS evidence_text FROM audit_logs
       WHERE workspace_id = $1 AND action = 'auth.token_issued' AND evidence::text LIKE $2;`,
      [wsA, `%${id}%`]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].evidence_text).not.toContain(token);
  });

  it("onboarding an existing workspace id is refused and changes nothing", async () => {
    const before = (await query(`SELECT name, budget_daily_limit_cents, approval_threshold_cents FROM workspaces WHERE id = $1;`, [wsA])).rows[0];
    const tokensBefore = (await query(`SELECT COUNT(*)::int AS n FROM workspace_tokens WHERE workspace_id = $1;`, [wsA])).rows[0].n;

    const onboard = await call("POST", "/api/workspaces/onboard", {
      body: {
        workspaceId: wsA,
        name: "Hijacked Kitchen",
        businessType: "kitchen",
        budgetDailyLimitCents: 999999,
        approvalThresholdCents: 1000,
        supplies: [],
        suppliers: [],
      },
    });
    expect(onboard.status).toBe(409);
    expect(onboard.body).toMatchObject({ error: "Workspace id is not available" });

    const provision = await call("POST", "/api/workspaces", {
      body: { id: wsA, name: "Hijacked Kitchen", templateId: "kitchen-v1" },
    });
    expect(provision.status).toBe(409);
    expect(provision.body).toMatchObject({ error: "Workspace id is not available" });

    const after = (await query(`SELECT name, budget_daily_limit_cents, approval_threshold_cents FROM workspaces WHERE id = $1;`, [wsA])).rows[0];
    expect(after).toEqual(before);
    const tokensAfter = (await query(`SELECT COUNT(*)::int AS n FROM workspace_tokens WHERE workspace_id = $1;`, [wsA])).rows[0].n;
    expect(tokensAfter).toBe(tokensBefore);
  });

  it("onboarding returns an owner token that works for that workspace and not for another", async () => {
    const onboard = await call("POST", "/api/workspaces/onboard", {
      body: {
        workspaceId: wsNew,
        name: "New Kitchen",
        businessType: "kitchen",
        budgetDailyLimitCents: 150000,
        approvalThresholdCents: 40000,
        supplies: [],
        suppliers: [],
      },
    });
    expect(onboard.status).toBe(201);
    expect(onboard.body.ownerToken).toEqual({ id: expect.any(String), token: expect.stringMatching(/^bnd_/) });
    const newOwner = onboard.body.ownerToken as { id: string; token: string };

    expect((await call("GET", `/api/workspaces/${wsNew}/inventory`, { token: newOwner.token })).status).toBe(200);
    const crossA = await call("GET", `/api/workspaces/${wsA}/inventory`, { token: newOwner.token });
    expect(crossA.status).toBe(404);
    expect(crossA.body).toMatchObject(NOT_FOUND);
    expect((await call("GET", `/api/workspaces/${wsNew}`, { token: ownerA.token })).status).toBe(404);

    const created = await call("POST", "/api/workspaces", {
      body: { id: wsNewCreate, name: "Created Kitchen", templateId: "kitchen-v1" },
    });
    expect(created.status).toBe(201);
    expect(created.body.ownerToken).toEqual({ id: expect.any(String), token: expect.stringMatching(/^bnd_/) });
    const createdOwner = created.body.ownerToken as { id: string; token: string };
    expect((await call("GET", `/api/workspaces/${wsNewCreate}/inventory`, { token: createdOwner.token })).status).toBe(200);
    expect((await call("GET", `/api/workspaces/${wsNew}/inventory`, { token: createdOwner.token })).status).toBe(404);
  });

  it("restarting the demo provisioning keeps the owner's policy", async () => {
    await provisionWorkspace(wsD, "Demo Kitchen", "kitchen-v1", { ifAbsent: true });
    const owner = await issueToken(wsD, "owner", "demo-owner");

    const put = await call("PUT", `/api/workspaces/${wsD}/policy`, {
      token: owner.token,
      body: { budgetDailyLimitCents: 123400, approvalThresholdCents: 20000 },
    });
    expect(put.status).toBe(200);

    await provisionWorkspace(wsD, "Demo Kitchen", "kitchen-v1", { ifAbsent: true });

    const row = (await query(`SELECT name, budget_daily_limit_cents, approval_threshold_cents FROM workspaces WHERE id = $1;`, [wsD])).rows[0];
    expect(Number(row.budget_daily_limit_cents)).toBe(123400);
    expect(Number(row.approval_threshold_cents)).toBe(20000);
    expect(row.name).toBe("Demo Kitchen");
  });

  it("cors sends no headers unless the origin is allowed", async () => {
    const allowedOrigin = "https://ops.bind.test";
    const withList = createApp({ corsOrigins: [allowedOrigin] });
    const withoutList = createApp({ corsOrigins: [] });
    const start = (instance: ReturnType<typeof createApp>) =>
      new Promise<Server>((resolve) => {
        const s = instance.listen(0, "127.0.0.1", () => resolve(s));
      });
    const listOn = await start(withList);
    const offOn = await start(withoutList);
    const urlOf = (s: Server) => {
      const addr = s.address();
      return addr && typeof addr === "object" ? `http://127.0.0.1:${addr.port}` : "";
    };
    try {
      const allowed = await fetch(`${urlOf(listOn)}/api/templates`, { headers: { Origin: allowedOrigin } });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("access-control-allow-origin")).toBe(allowedOrigin);

      const other = await fetch(`${urlOf(listOn)}/api/templates`, { headers: { Origin: "https://evil.test" } });
      expect(other.headers.get("access-control-allow-origin")).toBeNull();

      const preflight = await fetch(`${urlOf(listOn)}/api/workspaces`, {
        method: "OPTIONS",
        headers: { Origin: allowedOrigin, "Access-Control-Request-Method": "GET" },
      });
      expect(preflight.headers.get("access-control-allow-origin")).toBe(allowedOrigin);

      const none = await fetch(`${urlOf(offOn)}/api/templates`, { headers: { Origin: allowedOrigin } });
      expect(none.status).toBe(200);
      expect(none.headers.get("access-control-allow-origin")).toBeNull();
      expect(none.headers.get("access-control-allow-credentials")).toBeNull();
    } finally {
      await new Promise<void>((resolve) => listOn.close(() => resolve()));
      await new Promise<void>((resolve) => offOn.close(() => resolve()));
    }
  });

  it("GET /health and the template routes stay public and return no workspace data", async () => {
    const health = await call("GET", "/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");

    const templates = await call("GET", "/api/templates");
    expect(templates.status).toBe(200);
    expect(Array.isArray(templates.body)).toBe(true);
    expect(templates.body.length).toBeGreaterThan(0);

    const blueprint = await call("GET", "/api/templates/kitchen-v1/blueprint");
    expect(blueprint.status).toBe(200);

    for (const res of [health, templates, blueprint]) {
      expect(res.text).not.toContain(wsA);
      expect(res.text).not.toContain(wsB);
      expect(res.text).not.toContain("bnd_");
    }
  });

  it("auth failures never echo the submitted token", async () => {
    const submitted = [
      `bnd_${"Z".repeat(43)}`,
      `bnd_<script>alert("QQQQQQQQQQQQQQQQQQQQ")</script>${"Q".repeat(20)}`,
      `bnd_${"k".repeat(300)}`,
    ];
    for (const token of submitted) {
      const res = await call("GET", `/api/workspaces/${wsA}/inventory`, { token });
      expect(res.status).toBe(401);
      expect(res.text).not.toContain(token);
      expect(res.text).not.toContain("QQQQQQQQQQQQQQQQQQQQ");
    }

    // A token in the query string is not accepted, and is not echoed back.
    const inQuery = await call("GET", `/api/workspaces/${wsA}/inventory?token=${ownerA.token}`);
    expect(inQuery.status).toBe(401);
    expect(inQuery.body).toMatchObject(AUTH_REQUIRED);
    expect(inQuery.text).not.toContain(ownerA.token);
  });
});
