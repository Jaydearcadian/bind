import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { testPrivyVerifier } from "../helpers/privy.js";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { signPayload, workspaceWebhookSecret } from "../../src/webhooks/signing.js";
import { ROUTES, type RouteSpec } from "../../src/api/registry.js";
import { ErrorBody } from "../../src/api/schemas.js";
import { API_VERSION, buildOpenApiDocument, serializeOpenApiDocument } from "../../src/api/openapi.js";

/**
 * The API contract (docs/decisions/0034). Every route in createApp has one registry entry with its access level and its
 * schemas, the access levels match what the server does, the committed OpenAPI file is current, and the responses the
 * server really sends validate against the registry. Nothing here is mocked: the app runs over HTTP against PostgreSQL.
 */

const run = Date.now();
const WS_A = `ws-contract-a-${run}`;
const WS_B = `ws-contract-b-${run}`;
const METRICS_TOKEN = `contract-metrics-token-${run}-0123456789`;
const MASTER_SECRET = process.env.BIND_MASTER_SECRET ?? "";
const WEBHOOK_SECRET = process.env.BIND_WEBHOOK_SECRET ?? "";
const OWNER_REQUIRED = { error: "Owner role required" };
const AUTH_REQUIRED = { error: "Authentication required" };

/** A workspace created by a route during this file. Deleted in afterAll with its templates folder. */
const createdWorkspaceIds: string[] = [];
let freshCounter = 0;
function freshWorkspaceId(): string {
  freshCounter += 1;
  const id = `ws-contract-fresh-${run}-${freshCounter}`;
  createdWorkspaceIds.push(id);
  return id;
}

/**
 * The route table is the registry entries. The "exactly one entry" rule (and the access rules below) are checked against
 * the router stack, the same way the auth-tenancy guard reads it.
 */
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

/**
 * A long-lived response: the registry documents its 200 as text/event-stream (ADR 0035). Such a route cannot be read to the
 * end, so the sweeps read its status line and abort the request (docs/decisions/0035, "Test changes").
 */
const isEventStream = (spec: Pick<RouteSpec, "responses">): boolean => spec.responses[200]?.contentType === "text/event-stream";

/** The status of a long-lived route, read from its headers only. The request is aborted before any body is read. */
async function streamStatus(baseUrl: string, url: string, token: string): Promise<number> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}${url}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  controller.abort();
  return res.status;
}

const keyOf = (method: string, p: string) => `${method.toUpperCase()} ${p}`;
const specKey = (spec: Pick<RouteSpec, "method" | "path">) => keyOf(spec.method, spec.path);
const specFor = (method: string, template: string): RouteSpec => {
  const found = ROUTES.find((r) => keyOf(r.method, r.path) === keyOf(method, template));
  if (!found) throw new Error(`no registry entry for ${keyOf(method, template)}`);
  return found;
};

/** Fills a path template. `:id` is the workspace under test; other parameters are values the caller gives or a non-record. */
function fillPath(template: string, values: Record<string, string> = {}): string {
  return template.replace(/:(\w+)/g, (_m, name: string) => values[name] ?? (name === "id" ? WS_A : `${name}_none`));
}

interface Sent {
  status: number;
  text: string;
  body: any;
  headers: Headers;
}

/** The HMAC headers for a standard or surface webhook. The surface key is the workspace's current secret version. */
function signedHeaders(raw: string, secret: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  return { "x-bind-timestamp": String(timestamp), "x-bind-signature": signPayload(secret, timestamp, raw) };
}

async function send(
  baseUrl: string,
  method: string,
  url: string,
  opts: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}
): Promise<Sent> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let payload: string | undefined;
  if (opts.raw !== undefined) payload = opts.raw;
  else if (opts.body !== undefined) payload = JSON.stringify(opts.body);
  if (payload !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${url}`, { method: method.toUpperCase(), headers, body: payload });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, text, body, headers: res.headers };
}

/** Every response the file received, per kind. Validation tests read these logs, so each one checks what the server did. */
const log = {
  read: [] as Array<{ spec: RouteSpec; res: Sent }>,
  write: [] as Array<{ spec: RouteSpec; res: Sent }>,
  sample: [] as Array<{ spec: RouteSpec; res: Sent }>,
  error: [] as Array<{ spec: RouteSpec; res: Sent }>,
};

/**
 * Asserts that a response is one the registry documents for that route and status, and that its body matches the
 * documented schema. A status the registry does not list is a failure: the contract would be incomplete.
 */
function assertDocumented(spec: RouteSpec, res: Sent, where: string): void {
  const label = `${where}: ${specKey(spec)} answered ${res.status} (${res.text.slice(0, 200)})`;
  const documented = spec.responses[res.status];
  expect(documented, `${label}: this status is not in the registry`).toBeDefined();
  const contentType = res.headers.get("content-type") ?? "";
  if (documented.contentType) {
    expect(contentType, label).toContain(documented.contentType);
  } else if (documented.schema) {
    expect(contentType, label).toContain("application/json");
  }
  if (documented.schema) {
    const parsed = documented.schema.safeParse(res.body);
    expect(parsed.success, `${label}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues).slice(0, 500)}`).toBe(true);
  }
}

describe("API contract: one registry, checked against the running server (ADR 0034)", () => {
  const engine = new WorkflowEngine();
  // Pinned secrets and metrics token, so the access checks do not depend on the environment.
  const app = createApp({
    rateLimits: { enabled: false },
    metrics: { token: METRICS_TOKEN, cacheMs: 0 },
    secrets: { masterSecret: MASTER_SECRET, webhookSecret: WEBHOOK_SECRET },
    accounts: { verifier: testPrivyVerifier },
  });
  let server: Server;
  let baseUrl = "";

  let ownerA: { id: string; token: string };
  let staffA: { id: string; token: string };
  let ownerB: { id: string; token: string };

  /** Ids produced by the seeding that later tests read. */
  const seeded: { workflowId?: string; orderId?: string; heldOrderId?: string; docId?: string; proposalId?: string; approvalId?: string } = {};

  function tokenFor(spec: RouteSpec): string | undefined {
    switch (spec.access) {
      case "owner":
      case "owner-any":
        return ownerA.token;
      case "member":
      case "authenticated":
        return staffA.token;
      case "metrics-token":
        return METRICS_TOKEN;
      default:
        return undefined;
    }
  }

  /** The workspace-level signing secret for a surface event, at the workspace's current version. */
  async function surfaceSecret(workspaceId: string): Promise<string> {
    const rows = await query(`SELECT webhook_secret_version FROM workspaces WHERE id = $1;`, [workspaceId]);
    return workspaceWebhookSecret(MASTER_SECRET, workspaceId, Number(rows.rows[0].webhook_secret_version));
  }

  /** Sends a request for a registry entry, and records the response in the given log. */
  async function invoke(
    spec: RouteSpec,
    kind: keyof typeof log,
    opts: { values?: Record<string, string>; token?: string | undefined; body?: unknown; raw?: string; headers?: Record<string, string> } = {}
  ): Promise<Sent> {
    const res = await send(baseUrl, spec.method, fillPath(spec.path, opts.values), {
      token: opts.token,
      body: opts.body,
      raw: opts.raw,
      headers: opts.headers,
    });
    log[kind].push({ spec, res });
    return res;
  }

  /** A write during seeding: it must succeed with the status given, so a broken fixture stops the file at once. */
  async function seedWrite(
    method: string,
    template: string,
    token: string | undefined,
    body: unknown,
    expectedStatus: number,
    values: Record<string, string> = {}
  ): Promise<any> {
    const spec = specFor(method, template);
    const res = await invoke(spec, "write", { token, body, values });
    expect(res.status, `seeding ${specKey(spec)}: ${res.text.slice(0, 300)}`).toBe(expectedStatus);
    return res.body;
  }

  async function approvalFixture(workspaceId: string) {
    const label = `${run}-${Math.random().toString(36).slice(2, 8)}`;
    const wfId = `wf_contract_${label}`;
    const approvalId = `appr_contract_${label}`;
    const quote = {
      quoteId: `quote_contract_${label}`,
      rfqId: `rfq_contract_${label}`,
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
      [quote.quoteId, workspaceId, quote.rfqId, quote.supplierId, quote.supplierName, quote.sku, quote.quantity, quote.unitPriceCents, quote.totalPriceCents]
    );
    await engine.createWorkflow(wfId, workspaceId, "kitchen_replenishment", `idem_contract_${label}`, {
      itemName: "Organic All-Purpose Flour",
      quote,
    });
    await engine.transition(wfId, { fromState: WorkflowState.DRAFT, toState: WorkflowState.AWAITING_APPROVAL });
    await engine.createApproval(approvalId, workspaceId, "order", wfId, "submit_order", 24500n, "procurement");
    return { wfId, approvalId };
  }

  /** Seeds the workspace through the real routes, so the read and write checks have rows to read and responses to check. */
  async function seedWorkspace(): Promise<void> {
    const owner = ownerA.token;
    const staff = staffA.token;

    await seedWrite("PUT", "/api/workspaces/:id/policy", owner, { budgetDailyLimitCents: 150000, approvalThresholdCents: 25000 }, 200);
    await seedWrite("POST", "/api/workspaces/:id/inventory", staff, {
      sku: "FOOD-CONTRACT-1",
      name: "Contract Test Item",
      category: "General",
      unit: "unit",
      currentQuantity: 3,
      parLevel: 5,
      reorderQuantity: 10,
      unitPriceCents: 100,
    }, 201);
    const replenish = await seedWrite("POST", "/api/workspaces/:id/replenish", staff, { sku: "FOOD-FLOUR-50LB" }, 200);
    seeded.orderId = replenish.orderId;
    seeded.workflowId = replenish.workflowId;
    await seedWrite("POST", "/api/workspaces/:id/suppliers", owner, {
      id: "contract-supplier",
      name: "Contract Supplier",
      adapterType: "manual_quote",
      isSimulated: false,
      verified: true,
    }, 201);
    await seedWrite("POST", "/api/workspaces/:id/agents", owner, {
      roleName: "contract_role",
      displayName: "Contract Role",
      description: "A role used by the contract test",
      permittedEffects: ["read"],
      spendingLimitCents: 1000,
      allowedTools: ["get_stock_snapshot"],
      enabled: true,
    }, 201);
    await seedWrite("POST", "/api/workspaces/:id/surfaces", owner, {
      surface: "whatsapp",
      actorId: "contract-owner-phone",
      actorRole: "owner",
      integrationStatus: "verified",
    }, 201);

    // A surface stock event, signed with the workspace's surface secret, from the owner binding.
    const stockRaw = JSON.stringify({
      eventType: "SURFACE_STOCK_OBSERVED",
      eventId: `contract-stock-${run}`,
      workspaceId: WS_A,
      surface: "whatsapp",
      actorId: "contract-owner-phone",
      actorRole: "owner",
      sku: "FOOD-FLOUR-50LB",
      observedQuantity: 2,
    });
    const stockSecret = await surfaceSecret(WS_A);
    const stock = await invoke(specFor("POST", "/api/webhooks/incoming"), "write", {
      raw: stockRaw,
      headers: signedHeaders(stockRaw, stockSecret),
    });
    expect(stock.status, stock.text).toBe(200);

    // A standard webhook, signed with BIND_WEBHOOK_SECRET.
    const standardRaw = JSON.stringify({ provider: "contract-provider", eventId: `contract-evt-${run}`, payload: { note: "contract" } });
    const standard = await invoke(specFor("POST", "/api/webhooks/incoming"), "write", {
      raw: standardRaw,
      headers: signedHeaders(standardRaw, WEBHOOK_SECRET),
    });
    expect(standard.status, standard.text).toBe(200);

    const extracted = await seedWrite("POST", "/api/workspaces/:id/documents/extract", staff, {
      docType: "quote",
      sourceLabel: "contract_upload",
      rawText: "Supplier: Sysco Metro Restock\nSKU: FOOD-FLOUR-50LB\nQty: 8\nUnit Price: $38.00\nTotal: $304.00",
    }, 201);
    seeded.docId = extracted.docId;
    await seedWrite("POST", "/api/workspaces/:id/documents/:docId/confirm", owner, {}, 200, { docId: String(seeded.docId) });

    await seedWrite("PUT", "/api/workspaces/:id/kitchen-capacity", owner, {
      slots: [{ startsAt: "2026-11-01T10:00:00Z", endsAt: "2026-11-01T11:00:00Z", capacityUnits: 5 }],
    }, 200);
    const held = await seedWrite("POST", "/api/workspaces/:id/customer-orders", staff, {
      externalRef: `contract-held-${run}`,
      lines: [{ sku: "FOOD-FLOUR-50LB", quantity: 1 }],
      note: "contract note",
    }, 201);
    seeded.heldOrderId = held.orderId;
    await seedWrite("POST", "/api/workspaces/:id/customer-orders/:orderId/accept", owner, undefined, 200, { orderId: held.orderId });
    const cancelled = await seedWrite("POST", "/api/workspaces/:id/customer-orders", staff, {
      externalRef: `contract-cancel-${run}`,
      lines: [{ sku: "FOOD-FLOUR-50LB", quantity: 1 }],
    }, 201);
    await seedWrite("POST", "/api/workspaces/:id/customer-orders/:orderId/cancel", staff, undefined, 200, { orderId: cancelled.orderId });
    // Fulfil is answered 200 for an accepted order and 409 (NOT_ACCEPTED) otherwise: both are documented and both are checked.
    const fulfil = await invoke(specFor("POST", "/api/workspaces/:id/customer-orders/:orderId/fulfil"), "write", {
      token: staff,
      values: { orderId: held.orderId },
    });
    expect([200, 409], `fulfil: ${fulfil.text.slice(0, 200)}`).toContain(fulfil.status);

    // One order is left held for the owner, so the attention list has an item.
    await seedWrite("POST", "/api/workspaces/:id/customer-orders", staff, {
      externalRef: `contract-attention-${run}`,
      lines: [{ sku: "FOOD-FLOUR-50LB", quantity: 1 }],
    }, 201);

    await seedWrite("POST", "/api/workspaces/:id/feedback", staff, {
      source: "pos",
      externalId: `contract-fb-${run}`,
      text: "Pasta sauce too salty",
    }, 201);

    const lamb = await seedWrite("POST", "/api/workspaces/:id/menu-proposals", staff, {
      change: { type: "add_item", name: "Contract Lamb skewer", priceCents: 1200 },
      rationale: "Guests asked for lamb",
    }, 201);
    seeded.proposalId = lamb.proposalId;
    await seedWrite("POST", "/api/workspaces/:id/menu-proposals/:proposalId/approve", owner, undefined, 200, { proposalId: lamb.proposalId });
    await seedWrite("POST", "/api/workspaces/:id/menu-proposals/:proposalId/publish", owner, undefined, 200, { proposalId: lamb.proposalId });
    const tart = await seedWrite("POST", "/api/workspaces/:id/menu-proposals", owner, {
      change: { type: "add_item", name: "Contract Tart", priceCents: 800 },
    }, 201);
    await seedWrite("POST", "/api/workspaces/:id/menu-proposals/:proposalId/reject", owner, undefined, 200, { proposalId: tart.proposalId });
    const soup = await seedWrite("POST", "/api/workspaces/:id/menu-proposals", owner, {
      change: { type: "add_item", name: "Contract Soup", priceCents: 600 },
    }, 201);
    await seedWrite("POST", "/api/workspaces/:id/menu-proposals/:proposalId/cancel", owner, undefined, 200, { proposalId: soup.proposalId });

    const extraToken = await seedWrite("POST", "/api/workspaces/:id/tokens", owner, { role: "staff", label: "contract-staff-2" }, 201);
    await seedWrite("DELETE", "/api/workspaces/:id/tokens/:tokenId", owner, undefined, 200, { tokenId: extraToken.id });

    await seedWrite("PUT", "/api/workspaces/:id/connectors/:connectorId", owner, {
      kind: "supplier",
      secret: "contract-secret-value-0123456789",
    }, 200, { connectorId: "contract-supplier-conn" });
    await seedWrite("POST", "/api/workspaces/:id/connectors/:connectorId/verify", owner, undefined, 200, { connectorId: "contract-supplier-conn" });
    await seedWrite("DELETE", "/api/workspaces/:id/connectors/:connectorId", owner, undefined, 200, { connectorId: "contract-supplier-conn" });

    await seedWrite("PUT", "/api/workspaces/:id/agents-paused", owner, { paused: true }, 200);
    await seedWrite("PUT", "/api/workspaces/:id/agents-paused", owner, { paused: false }, 200);

    // Three pending approvals: one rejected, one revoked, one approved. Plus one held workflow cancelled by the owner.
    const rejectable = await approvalFixture(WS_A);
    seeded.approvalId = rejectable.approvalId;
    await seedWrite("POST", "/api/approvals/:id/reject", owner, { reason: "contract reject" }, 200, { id: rejectable.approvalId });
    const revocable = await approvalFixture(WS_A);
    await seedWrite("POST", "/api/approvals/:id/revoke", owner, { reason: "contract revoke" }, 200, { id: revocable.approvalId });
    const approvable = await approvalFixture(WS_A);
    await seedWrite("POST", "/api/approvals/:id/approve", owner, undefined, 200, { id: approvable.approvalId });
    const cancellable = await approvalFixture(WS_A);
    await seedWrite("POST", "/api/workspaces/:id/workflows/:workflowId/cancel", owner, { reason: "contract cancel" }, 200, {
      workflowId: cancellable.wfId,
    });

    await seedWrite("POST", "/api/workspaces/:id/recover", owner, undefined, 200);

    // The order from the replenishment is confirmed on the simulated supplier: reconcile and then the settlement check.
    await seedWrite("POST", "/api/orders/:id/reconcile", owner, undefined, 200, { id: replenish.orderId });
    await seedWrite("POST", "/api/orders/:id/confirm-settlement", owner, undefined, 200, { id: replenish.orderId });

    // A demo (docs/decisions/0057): created, then reset. Both demos are removed in afterAll.
    const demo = await seedWrite("POST", "/api/demo", undefined, undefined, 201);
    createdWorkspaceIds.push(demo.workspaceId);
    const reset = await seedWrite("POST", "/api/workspaces/:id/demo/reset", demo.token, undefined, 201, { id: demo.workspaceId });
    createdWorkspaceIds.push(reset.workspaceId);

    // Last: the signing secret moves to version 2. Later signed calls read the current version.
    await seedWrite("POST", "/api/workspaces/:id/webhook-secret/rotate", owner, undefined, 200);
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(WS_A, "Contract Kitchen A", "kitchen-v1");
    await provisionWorkspace(WS_B, "Contract Kitchen B", "kitchen-v1");
    ownerA = await issueToken(WS_A, "owner", "contract-owner");
    staffA = await issueToken(WS_A, "staff", "contract-staff");
    ownerB = await issueToken(WS_B, "owner", "contract-owner-b");
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
    await seedWorkspace();
  }, 180_000);

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    const ids = [WS_A, WS_B, ...createdWorkspaceIds];
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [ids]);
    await query(`DELETE FROM idempotency_keys WHERE workspace_id = ANY($1::text[]);`, [ids]);
    await query(`DELETE FROM inbound_webhooks WHERE provider LIKE ANY($1::text[]);`, [ids.map((id) => `surface:${id}:%`)]);
    for (const id of ids) {
      await fs.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    }
    await closePool();
  });

  it("every route in createApp has exactly one registry entry and vice versa", () => {
    const registered = routesOf(createApp());
    const appKeys = registered.map((r) => keyOf(r.method, r.path));
    const specKeys = ROUTES.map((r) => specKey(r));

    expect(new Set(appKeys).size, "createApp registers each route once").toBe(appKeys.length);
    expect(new Set(specKeys).size, "the registry has one entry per route").toBe(specKeys.length);

    const appSet = new Set(appKeys);
    const specSet = new Set(specKeys);
    expect(appKeys.filter((k) => !specSet.has(k)), "routes in createApp with no registry entry").toEqual([]);
    expect(specKeys.filter((k) => !appSet.has(k)), "registry entries with no route in createApp").toEqual([]);
  });

  it("the access level in the registry matches the behaviour", async () => {
    for (const spec of ROUTES) {
      const where = specKey(spec);
      // The UI catch-all is not a parameterised path: any unknown path stands for it.
      const url = spec.path === "*" ? "/contract-ui-probe" : fillPath(spec.path);
      const bodyless = spec.method === "get" || spec.method === "delete";

      if (spec.access === "public") {
        const res = await send(baseUrl, spec.method, url, { body: bodyless ? undefined : {} });
        // A demo this sweep creates is recorded so afterAll deletes it with its files (docs/decisions/0057).
        if (spec.operationId === "createDemo" && res.status === 201) createdWorkspaceIds.push(res.body.workspaceId);
        expect([401, 403], where).not.toContain(res.status);
        continue;
      }
      if (spec.access === "account") {
        // Not a workspace token: no token and a workspace token both get the same 401 (ADR 0051).
        const none = await send(baseUrl, spec.method, url, { body: bodyless ? undefined : {} });
        expect(none.status, `${where} without a token`).toBe(401);
        const workspace = await send(baseUrl, spec.method, url, { token: staffA.token, body: bodyless ? undefined : {} });
        expect(workspace.status, `${where} with a workspace token`).toBe(401);
        continue;
      }
      if (spec.access === "metrics-token") {
        // A workspace token is not the metrics token: the route answers 401 to it.
        const res = await send(baseUrl, spec.method, url, { token: staffA.token });
        expect(res.status, where).toBe(401);
        expect(res.body, where).toMatchObject(AUTH_REQUIRED);
        continue;
      }
      if (spec.access === "signed-webhook") {
        // An unsigned request is refused before anything is read.
        const res = await send(baseUrl, spec.method, url, { raw: "{}" });
        expect(res.status, where).toBe(401);
        expect(ErrorBody.safeParse(res.body).success, where).toBe(true);
        continue;
      }

      const none = await send(baseUrl, spec.method, url, { body: bodyless ? undefined : {} });
      expect(none.status, `${where} without a token`).toBe(401);
      expect(none.body, `${where} without a token`).toMatchObject(AUTH_REQUIRED);

      if (spec.access === "owner" || spec.access === "owner-any") {
        const staff = await send(baseUrl, spec.method, url, { token: staffA.token, body: bodyless ? undefined : {} });
        expect(staff.status, `${where} with a staff token`).toBe(403);
        expect(staff.body, `${where} with a staff token`).toMatchObject(OWNER_REQUIRED);
      } else if (spec.access === "member") {
        if (isEventStream(spec)) {
          const status = await streamStatus(baseUrl, url, staffA.token);
          expect([401, 403], `${where} with a staff token`).not.toContain(status);
          continue;
        }
        const staff = await send(baseUrl, spec.method, url, { token: staffA.token, body: bodyless ? undefined : {} });
        expect([401, 403], `${where} with a staff token`).not.toContain(staff.status);
      } else if (spec.access === "authenticated") {
        const staff = await send(baseUrl, spec.method, url, { token: staffA.token });
        expect(staff.status, `${where} with a staff token`).toBe(200);
      } else {
        throw new Error(`${where}: unknown access level ${spec.access}`);
      }
    }
  });

  it("docs/openapi.json is current", async () => {
    const committed = await fs.readFile(path.resolve(process.cwd(), "docs/openapi.json"), "utf8");
    const fresh = serializeOpenApiDocument(buildOpenApiDocument(ROUTES, API_VERSION));
    expect(committed, "run npm run api:spec and commit docs/openapi.json").toBe(fresh);
  });

  it("GET /api/openapi.json equals the committed document", async () => {
    const committedText = await fs.readFile(path.resolve(process.cwd(), "docs/openapi.json"), "utf8");
    const spec = specFor("GET", "/api/openapi.json");
    const res = await invoke(spec, "read", {});
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    // The same bytes as the file, not just an equal parse.
    expect(res.text).toBe(committedText);
    const committed = JSON.parse(committedText);
    expect(res.body).toEqual(committed);
    assertDocumented(spec, res, "openapi");
  });

  it("responses of the read routes validate against their schemas", async () => {
    // Lists that must have rows, so the schema is checked against real data and not against an empty array.
    const NON_EMPTY = new Set([
      "GET /api/workspaces",
      "GET /api/workspaces/:id/inventory",
      "GET /api/workspaces/:id/approvals",
      "GET /api/workspaces/:id/workflows",
      "GET /api/workspaces/:id/orders",
      "GET /api/workspaces/:id/suppliers",
      "GET /api/workspaces/:id/agents",
      "GET /api/workspaces/:id/surfaces",
      "GET /api/workspaces/:id/documents",
      "GET /api/workspaces/:id/accounting/ledger",
      "GET /api/workspaces/:id/audit",
      "GET /api/workspaces/:id/customer-orders",
      "GET /api/workspaces/:id/kitchen-capacity",
      "GET /api/workspaces/:id/feedback",
      "GET /api/workspaces/:id/menu-proposals",
      "GET /api/workspaces/:id/menu",
      "GET /api/workspaces/:id/needs-attention",
      "GET /api/workspaces/:id/tokens",
      "GET /api/workspaces/:id/connectors",
      "GET /api/templates",
    ]);
    const VALUES: Record<string, Record<string, string>> = {
      "/api/templates/:id/blueprint": { id: "kitchen-v1" },
      "/api/workspaces/:id/customer-orders/:orderId": { orderId: seeded.heldOrderId ?? "" },
      "/api/workspaces/:id/workflows/:workflowId": { workflowId: seeded.workflowId ?? "" },
      "/api/workspaces/:id/orders/:orderId": { orderId: seeded.orderId ?? "" },
      "/api/workspaces/:id/approvals/:approvalId": { approvalId: seeded.approvalId ?? "" },
    };

    // Every GET route except the UI catch-all is read here.
    expect(ROUTES.filter((r) => r.method === "get" && !r.contractTested).map((r) => specKey(r))).toEqual([
      "GET /api/workspaces/:id/events",
      "GET /api/account/workspaces", // needs a Privy token: tests/integration/accounts.test.ts (ADR 0052)
      "GET *",
    ]);
    // The long-lived routes are exactly the routes whose registry 200 is text/event-stream (ADR 0035, "Test changes").
    expect(ROUTES.filter((r) => r.method === "get" && isEventStream(r)).map((r) => specKey(r))).toEqual([
      "GET /api/workspaces/:id/events",
    ]);

    for (const spec of ROUTES.filter((r) => r.method === "get" && r.contractTested)) {
      const token = tokenFor(spec);
      const res = await invoke(spec, "read", { token, values: VALUES[spec.path] ?? {} });
      expect(res.status, `${specKey(spec)} ${res.text.slice(0, 200)}`).toBe(200);
      assertDocumented(spec, res, "read");
      if (NON_EMPTY.has(specKey(spec))) {
        const body = res.body;
        const rows = Array.isArray(body) ? body.length : Array.isArray(body?.items) ? body.items.length : Array.isArray(body?.roles) ? body.roles.length : 0;
        expect(rows, `${specKey(spec)} should have rows after seeding`).toBeGreaterThan(0);
      }
    }

    // The CSV form of the ledger is a registry-documented variant of the same route.
    const csv = await send(baseUrl, "GET", `/api/workspaces/${WS_A}/accounting/ledger?format=csv`, { token: staffA.token });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.text.startsWith("entry_number,")).toBe(true);

    // Metrics is text, not JSON.
    const metricsRes = await invoke(specFor("GET", "/metrics"), "read", { token: METRICS_TOKEN });
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.text).toContain("bind_http_requests_total");
  });

  it("responses of the main write routes validate against their schemas", () => {
    expect(log.write.length).toBeGreaterThan(20);
    for (const { spec, res } of log.write) {
      assertDocumented(spec, res, "write");
    }
    // The routes the contract requires to be checked by a write.
    const writes = new Set(log.write.map(({ spec }) => specKey(spec)));
    for (const required of [
      "POST /api/workspaces/:id/inventory",
      "POST /api/workspaces/:id/suppliers",
      "POST /api/workspaces/:id/agents",
      "POST /api/workspaces/:id/surfaces",
      "PUT /api/workspaces/:id/policy",
      "POST /api/workspaces/:id/replenish",
      "POST /api/workspaces/:id/customer-orders",
      "POST /api/workspaces/:id/customer-orders/:orderId/cancel",
      "POST /api/workspaces/:id/feedback",
      "POST /api/workspaces/:id/menu-proposals",
      "POST /api/workspaces/:id/menu-proposals/:proposalId/approve",
      "POST /api/workspaces/:id/menu-proposals/:proposalId/publish",
      "POST /api/workspaces/:id/tokens",
      "DELETE /api/workspaces/:id/tokens/:tokenId",
      "PUT /api/workspaces/:id/connectors/:connectorId",
      "PUT /api/workspaces/:id/kitchen-capacity",
      "POST /api/workspaces/:id/workflows/:workflowId/cancel",
      "POST /api/workspaces/:id/recover",
      "PUT /api/workspaces/:id/agents-paused",
      "POST /api/webhooks/incoming",
    ]) {
      expect(writes.has(required), `${required} is checked by a write`).toBe(true);
    }
  });

  it("valid sample bodies are not rejected by validation", async () => {
    // Path values for a sample: the connector id must be a valid connector id, not a placeholder.
    const SAMPLE_VALUES: Record<string, string> = { connectorId: "contract-sample-conn" };
    const sampled = ROUTES.filter((r) => r.sampleBody !== undefined);
    expect(sampled.length).toBeGreaterThan(10);
    for (const spec of sampled) {
      const fresh = freshWorkspaceId();
      const text = JSON.stringify(spec.sampleBody)
        .replaceAll("<<run>>", String(run))
        .replaceAll("<<fresh>>", fresh);
      const body = JSON.parse(text);
      const token = tokenFor(spec);
      const isWebhook = spec.access === "signed-webhook";
      const res = await invoke(spec, "sample", {
        values: SAMPLE_VALUES,
        token,
        raw: isWebhook ? text : undefined,
        body: isWebhook ? undefined : body,
        headers: isWebhook ? signedHeaders(text, WEBHOOK_SECRET) : undefined,
      });
      const where = `sample ${specKey(spec)}`;
      expect(res.status, `${where}: ${res.text.slice(0, 300)}`).toBeGreaterThanOrEqual(200);
      expect(res.status, `${where}: ${res.text.slice(0, 300)}`).toBeLessThan(300);
      assertDocumented(spec, res, where);
    }
  }, 120_000);

  it("invalid bodies are 400, never 5xx", async () => {
    let checked = 0;
    for (const spec of ROUTES.filter((r) => r.body !== undefined && r.contractTested)) {
      const where = specKey(spec);
      const token = tokenFor(spec);
      const isWebhook = spec.access === "signed-webhook";
      const shape = spec.body!;
      const optional = shape.safeParse({}).success;
      const candidates: Array<Record<string, unknown>> = [];
      if (!optional) candidates.push({});
      candidates.push({ [firstField(shape)]: { wrongType: true } });

      for (const candidate of candidates) {
        const text = JSON.stringify(candidate);
        const res = await invoke(spec, "error", {
          token,
          values: { docId: "doc_contract_none" },
          raw: isWebhook ? text : undefined,
          body: isWebhook ? undefined : candidate,
          headers: isWebhook ? signedHeaders(text, WEBHOOK_SECRET) : undefined,
        });
        expect(res.status, `${where} with ${text}: ${res.text.slice(0, 200)}`).toBe(400);
        assertDocumented(spec, res, `invalid ${where}`);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("error bodies validate against ErrorBody", async () => {
    // 401: no token on an owner route.
    const unauth = await invoke(specFor("POST", "/api/workspaces/:id/suppliers"), "error", { body: {} });
    expect(unauth.status).toBe(401);
    expect(ErrorBody.safeParse(unauth.body).success).toBe(true);
    assertDocumented(specFor("POST", "/api/workspaces/:id/suppliers"), unauth, "401");

    // 403: a staff token on an owner route.
    const forbidden = await invoke(specFor("POST", "/api/workspaces/:id/suppliers"), "error", { token: staffA.token, body: {} });
    expect(forbidden.status).toBe(403);
    assertDocumented(specFor("POST", "/api/workspaces/:id/suppliers"), forbidden, "403");

    // 404: owner of B on A's path, and the same body for a missing workspace.
    const notFound = await invoke(specFor("GET", "/api/workspaces/:id/inventory"), "error", { token: ownerB.token, values: { id: WS_A } });
    expect(notFound.status).toBe(404);
    assertDocumented(specFor("GET", "/api/workspaces/:id/inventory"), notFound, "404");

    // 409 on a reset of a workspace that is not a demo (docs/decisions/0057). The owner's workspace is untouched.
    const notDemo = await invoke(specFor("POST", "/api/workspaces/:id/demo/reset"), "error", {
      token: ownerA.token,
      values: { id: WS_A },
    });
    expect(notDemo.status).toBe(409);
    assertDocumented(specFor("POST", "/api/workspaces/:id/demo/reset"), notDemo, "409");

    // 409: creating a workspace with an id that exists.
    const conflict = await invoke(specFor("POST", "/api/workspaces"), "error", {
      body: { id: WS_A, name: "Duplicate", templateId: "kitchen-v1" },
    });
    expect(conflict.status).toBe(409);
    assertDocumented(specFor("POST", "/api/workspaces"), conflict, "409");

    // 413: a body over the 256 kB limit is refused before any route reads it.
    const big = await invoke(specFor("POST", "/api/workspaces/:id/feedback"), "error", {
      token: staffA.token,
      raw: JSON.stringify({ source: "pos", externalId: "big", text: "a".repeat(300_000) }),
    });
    expect(big.status).toBe(413);
    assertDocumented(specFor("POST", "/api/workspaces/:id/feedback"), big, "413");

    // 429: a second app with a token limit of one request a minute.
    const limited = createApp({
      rateLimits: { enabled: true, apiPerToken: { windowMs: 60_000, max: 1 } },
      secrets: { masterSecret: MASTER_SECRET, webhookSecret: WEBHOOK_SECRET },
      metrics: { token: null },
    });
    const limitedServer = await listen(limited);
    try {
      const url = `http://127.0.0.1:${limitedServer.port}`;
      const first = await send(url, "GET", `/api/workspaces/${WS_A}/inventory`, { token: staffA.token });
      expect(first.status).toBe(200);
      const second = await send(url, "GET", `/api/workspaces/${WS_A}/inventory`, { token: staffA.token });
      expect(second.status).toBe(429);
      expect(ErrorBody.safeParse(second.body).success).toBe(true);
      expect(second.body.code).toBe("RATE_LIMITED");
      assertDocumented(specFor("GET", "/api/workspaces/:id/inventory"), second, "429");
    } finally {
      await limitedServer.close();
    }

    // 503: a standard webhook on an app with no signing secret configured.
    const unconfigured = createApp({
      rateLimits: { enabled: false },
      secrets: { masterSecret: null, webhookSecret: null },
      metrics: { token: null },
    });
    const unconfiguredServer = await listen(unconfigured);
    try {
      const url = `http://127.0.0.1:${unconfiguredServer.port}`;
      const res = await send(url, "POST", "/api/webhooks/incoming", { body: { provider: "p", eventId: "e" } });
      expect(res.status).toBe(503);
      expect(ErrorBody.safeParse(res.body).success).toBe(true);
      assertDocumented(specFor("POST", "/api/webhooks/incoming"), res, "503");
    } finally {
      await unconfiguredServer.close();
    }
  });

  it("routes marked not contract tested are listed with a reason", () => {
    const untested = ROUTES.filter((r) => !r.contractTested);
    for (const route of untested) {
      expect(route.notTestedReason?.trim().length ?? 0, `${specKey(route)} needs a reason`).toBeGreaterThan(0);
    }
    // A growing list is visible: the count is asserted, and the reasons are printed with it.
    console.info(`routes not contract tested: ${untested.length}\n${untested.map((r) => `  ${specKey(r)}: ${r.notTestedReason}`).join("\n")}`);
    expect(untested.length).toBeLessThanOrEqual(MAX_NOT_CONTRACT_TESTED);
  });

  it("every route marked contract tested is exercised by this file", () => {
    const exercised = new Set(
      [...log.read, ...log.write, ...log.sample, ...log.error].map(({ spec }) => specKey(spec))
    );
    const claimed = ROUTES.filter((r) => r.contractTested).map((r) => specKey(r));
    expect(claimed.filter((k) => !exercised.has(k))).toEqual([]);
  });
});

/** The number of routes with `contractTested: false`. Raise it only with a recorded reason in the ADR. */
const MAX_NOT_CONTRACT_TESTED = 10; // 2 earlier, plus 8 People routes that need a Privy token or a seeded id (ADR 0052)

/** The first key of an object schema, or of the first option of a union. Used to build a wrong-typed body. */
function firstField(schema: z.ZodTypeAny): string {
  let current: any = schema;
  for (let depth = 0; depth < 6; depth += 1) {
    if (current instanceof z.ZodObject) return Object.keys(current.shape)[0];
    if (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
      current = current.unwrap();
      continue;
    }
    if (current instanceof z.ZodEffects) {
      current = current.innerType();
      continue;
    }
    const options = current?.options ?? current?._def?.options;
    if (Array.isArray(options) && options.length > 0) {
      current = options[0];
      continue;
    }
    break;
  }
  throw new Error("body schema has no object shape");
}

/** Starts an app on an ephemeral port. */
async function listen(app: ReturnType<typeof createApp>): Promise<{ port: number; close: () => Promise<void> }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
