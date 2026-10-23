import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { query, pool, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { config } from "../../src/config/env.js";
import { signPayload, workspaceWebhookSecret } from "../../src/webhooks/signing.js";
import { stableText } from "../helpers/error-body.js";

/*
 * Webhook authentication, bound actors, replay protection and the pause switch (ADR 0022). HTTP against createApp(),
 * as in auth-tenancy.test.ts. Every request body that must be authentic is signed over its exact bytes.
 */

const run = Date.now();
const wsA = `ws-hook-a-${run}`;
const wsB = `ws-hook-b-${run}`;
const wsC = `ws-hook-c-${run}`;
const allWorkspaceIds = [wsA, wsB, wsC];
const SKU = `SKU-HOOK-${run}`;
const SURFACE_PATH = "/api/webhooks/incoming";

const MASTER = config.BIND_MASTER_SECRET ?? "";
const WEBHOOK = config.BIND_WEBHOOK_SECRET ?? "";

const BAD_SIGNATURE = { error: "Invalid signature or expired timestamp" };
const BAD_SIGNATURE_TEXT = JSON.stringify(BAD_SIGNATURE);
const AUTH_REQUIRED = { error: "Authentication required" };
const OWNER_REQUIRED = { error: "Owner role required" };

let counter = 0;
/** A unique event or row id for this run. */
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${run}_${counter}`;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** The current derived secret of a workspace, for a given secret version. */
function surfaceSecret(workspaceId: string, version = 1): string {
  return workspaceWebhookSecret(MASTER, workspaceId, version);
}

/** The two headers that authenticate a raw body. */
function signHeaders(raw: string, secret: string, timestamp: number = nowSec()): Record<string, string> {
  return {
    "x-bind-timestamp": String(timestamp),
    "x-bind-signature": signPayload(secret, timestamp, raw),
  };
}

type Sent = { status: number; text: string; body: any; headers: Headers };

async function request(base: string, method: string, routePath: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${routePath}`, {
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
  return { status: res.status, text, body, headers: res.headers } as Sent;
}

/** A POST of exact raw bytes with the given headers. */
async function postRaw(base: string, routePath: string, raw: string, headers: Record<string, string> = {}): Promise<Sent> {
  const res = await fetch(`${base}${routePath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: raw,
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

function stockEvent(workspaceId: string, actorId: string, observedQuantity: number, eventId = nextId("evt_stock"), actorRole = "owner") {
  return {
    eventType: "SURFACE_STOCK_OBSERVED",
    eventId,
    workspaceId,
    surface: "whatsapp",
    actorId,
    actorRole,
    sku: SKU,
    observedQuantity,
  };
}

function approvalEvent(
  workspaceId: string,
  actorId: string,
  approvalId: string,
  decision: "approve" | "reject" = "approve",
  actorRole = "owner",
  eventId = nextId("evt_appr")
) {
  return {
    eventType: "SURFACE_OWNER_APPROVAL_DECISION",
    eventId,
    workspaceId,
    surface: "whatsapp",
    actorId,
    actorRole,
    approvalId,
    decision,
    reason: "decided from a surface card",
  };
}

function pauseEvent(workspaceId: string, actorId: string, paused: boolean, actorRole = "owner", eventId = nextId("evt_pause")) {
  return {
    eventType: "SURFACE_AGENT_PAUSE_TOGGLE",
    eventId,
    workspaceId,
    surface: "whatsapp",
    actorId,
    actorRole,
    paused,
  };
}

describe("Webhooks: signed events, bound actors, replay protection and a real pause switch", () => {
  const engine = new WorkflowEngine();
  const app = createApp();
  let server: Server;
  let baseUrl = "";

  let ownerA: { id: string; token: string };
  let staffA: { id: string; token: string };
  let ownerB: { id: string; token: string };
  let ownerC: { id: string; token: string };
  let staffC: { id: string; token: string };

  const ownerActorA = `owner-a-${run}`;
  const staffActorA = `staff-a-${run}`;
  const ownerActorB = `owner-b-${run}`;
  const ownerActorC = `owner-c-${run}`;
  const staffActorC = `staff-c-${run}`;

  const call = (method: string, routePath: string, opts: { token?: string; body?: unknown } = {}) =>
    request(baseUrl, method, routePath, opts);

  /** A surface event, signed with the workspace secret of the given version. */
  async function sendSurface(event: Record<string, unknown>, version = 1): Promise<Sent> {
    const raw = JSON.stringify(event);
    return postRaw(baseUrl, SURFACE_PATH, raw, signHeaders(raw, surfaceSecret(String(event.workspaceId), version)));
  }

  /** A surface event with no signature headers. */
  async function sendUnsigned(event: Record<string, unknown>): Promise<Sent> {
    return postRaw(baseUrl, SURFACE_PATH, JSON.stringify(event));
  }

  /** A quote, a workflow waiting on an owner approval, and the approval row. */
  async function awaitingApproval(workspaceId: string) {
    const label = nextId("appr");
    const wfId = `wf_${label}`;
    const approvalId = `appr_${label}`;
    const quote = {
      quoteId: `quote_${label}`,
      rfqId: `rfq_${label}`,
      supplierId: `${workspaceId}_supp-sysco-metro`,
      supplierName: "Sysco Metro Distribution",
      sku: SKU,
      quantity: 10,
      unitPriceCents: "2450",
      totalPriceCents: "24500",
    };
    await query(
      `INSERT INTO quotes (id, workspace_id, rfq_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, currency, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'USDC', NOW() + INTERVAL '1 day');`,
      [quote.quoteId, workspaceId, quote.rfqId, quote.supplierId, quote.supplierName, quote.sku, quote.quantity, quote.unitPriceCents, quote.totalPriceCents]
    );
    await engine.createWorkflow(wfId, workspaceId, "kitchen_replenishment", `idem_${label}`, {
      itemName: "Hook Test Flour",
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

  async function dedupeCount(provider: string, eventId: string) {
    return (await query(`SELECT COUNT(*)::int AS n FROM inbound_webhooks WHERE provider = $1 AND event_id = $2;`, [provider, eventId])).rows[0].n as number;
  }

  async function stockOf(workspaceId: string) {
    return Number((await query(`SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`, [workspaceId, SKU])).rows[0].current_quantity);
  }

  async function setStock(workspaceId: string, quantity: number) {
    await query(`UPDATE inventory_items SET current_quantity = $1 WHERE workspace_id = $2 AND sku = $3;`, [quantity, workspaceId, SKU]);
  }

  async function pausedOf(workspaceId: string): Promise<boolean> {
    return (await query(`SELECT agents_paused FROM workspaces WHERE id = $1;`, [workspaceId])).rows[0].agents_paused === true;
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsA, "Hook Kitchen A", "kitchen-v1");
    await provisionWorkspace(wsB, "Hook Kitchen B", "kitchen-v1");
    await provisionWorkspace(wsC, "Hook Kitchen C", "kitchen-v1");
    ownerA = await issueToken(wsA, "owner", "alice-hook");
    staffA = await issueToken(wsA, "staff", "cook-hook");
    ownerB = await issueToken(wsB, "owner", "bob-hook");
    ownerC = await issueToken(wsC, "owner", "carol-hook");
    staffC = await issueToken(wsC, "staff", "cook-c-hook");
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });

    // Par 10 and quantity 10: a stock count at par never starts a replenishment, so the stock tests stay simple.
    for (const [ws, token] of [
      [wsA, ownerA.token],
      [wsB, ownerB.token],
      [wsC, ownerC.token],
    ] as const) {
      const add = await call("POST", `/api/workspaces/${ws}/inventory`, {
        token,
        body: {
          sku: SKU,
          name: "Hook Test Flour",
          category: "Dry Goods",
          unit: "bag",
          currentQuantity: 10,
          parLevel: 10,
          reorderQuantity: 5,
          unitPriceCents: 1000,
        },
      });
      expect(add.status).toBe(201);
    }

    // Surface bindings, made through the owner API.
    const bind = async (ws: string, token: string, actorId: string, actorRole: "owner" | "staff") =>
      call("POST", `/api/workspaces/${ws}/surfaces`, {
        token,
        body: { surface: "whatsapp", actorId, actorLabel: actorId, actorRole },
      });
    expect((await bind(wsA, ownerA.token, ownerActorA, "owner")).status).toBe(201);
    expect((await bind(wsA, ownerA.token, staffActorA, "staff")).status).toBe(201);
    expect((await bind(wsB, ownerB.token, ownerActorB, "owner")).status).toBe(201);
    expect((await bind(wsC, ownerC.token, ownerActorC, "owner")).status).toBe(201);
    expect((await bind(wsC, ownerC.token, staffActorC, "staff")).status).toBe(201);
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await query(`DELETE FROM inbound_webhooks WHERE provider LIKE $1 OR event_id LIKE $1;`, [`%${run}%`]);
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [allWorkspaceIds]);
    for (const id of allWorkspaceIds) {
      await fs.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    }
    await closePool();
  });

  it("the test environment supplies a master secret and a webhook secret of at least 32 characters", () => {
    expect(MASTER.length).toBeGreaterThanOrEqual(32);
    expect(WEBHOOK.length).toBeGreaterThanOrEqual(32);
    expect(MASTER).not.toBe(WEBHOOK);
  });

  describe("Surface events: signed, bound to a verified actor, and replay-safe", () => {
    it("a surface event without a signature is refused with 401", async () => {
      const appr = await awaitingApproval(wsA);
      const ev = approvalEvent(wsA, ownerActorA, appr.approvalId);
      const res = await sendUnsigned(ev);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject(BAD_SIGNATURE);

      expect((await approvalRow(appr.approvalId)).status).toBe("pending");
      expect(await dedupeCount(`surface:${wsA}:whatsapp`, ev.eventId)).toBe(0);
    });

    it("a surface event with a wrong, expired or future-dated signature is refused", async () => {
      const appr = await awaitingApproval(wsA);
      const ev = approvalEvent(wsA, ownerActorA, appr.approvalId);
      const raw = JSON.stringify(ev);
      const secret = surfaceSecret(wsA);
      const now = nowSec();
      const cases: Array<[string, Record<string, string>]> = [
        ["a wrong signature", { "x-bind-timestamp": String(now), "x-bind-signature": "0".repeat(64) }],
        ["an expired timestamp", signHeaders(raw, secret, now - 400)],
        ["a future-dated timestamp", signHeaders(raw, secret, now + 120)],
        ["a signature of the wrong length", { "x-bind-timestamp": String(now), "x-bind-signature": "ab" }],
        ["a non-hex signature", { "x-bind-timestamp": String(now), "x-bind-signature": "z".repeat(64) }],
        ["no timestamp header", { "x-bind-signature": signPayload(secret, now, raw) }],
        ["the master secret used as the key", signHeaders(raw, MASTER, now)],
      ];
      for (const [name, headers] of cases) {
        const res = await postRaw(baseUrl, SURFACE_PATH, raw, headers);
        expect(res.status, name).toBe(401);
        expect(JSON.parse(res.text), name).toMatchObject(JSON.parse(BAD_SIGNATURE_TEXT));
      }
      expect((await approvalRow(appr.approvalId)).status).toBe("pending");
      expect(await dedupeCount(`surface:${wsA}:whatsapp`, ev.eventId)).toBe(0);
    });

    it("a signature made for workspace A does not validate an event for workspace B", async () => {
      const appr = await awaitingApproval(wsB);
      const ev = approvalEvent(wsB, ownerActorB, appr.approvalId);
      const raw = JSON.stringify(ev);

      const wrongKey = await postRaw(baseUrl, SURFACE_PATH, raw, signHeaders(raw, surfaceSecret(wsA)));
      expect(wrongKey.status).toBe(401);
      expect(JSON.parse(wrongKey.text)).toMatchObject(JSON.parse(BAD_SIGNATURE_TEXT));
      expect((await approvalRow(appr.approvalId)).status).toBe("pending");

      // Control: the same bytes signed with B's own secret are accepted, so the refusal above is the signature check.
      const right = await postRaw(baseUrl, SURFACE_PATH, raw, signHeaders(raw, surfaceSecret(wsB)));
      expect(right.status).toBe(200);
      expect((await approvalRow(appr.approvalId)).status).toBe("approved");
    });

    it("an unknown workspace id gets the same 401 as a bad signature", async () => {
      const unknown = `ws-hook-missing-${run}`;
      const ev = approvalEvent(unknown, `owner-x-${run}`, `appr_missing_${run}`);
      const raw = JSON.stringify(ev);
      const signedForUnknown = await postRaw(baseUrl, SURFACE_PATH, raw, signHeaders(raw, surfaceSecret(unknown)));
      const badSignature = await postRaw(baseUrl, SURFACE_PATH, raw, {
        "x-bind-timestamp": String(nowSec()),
        "x-bind-signature": "0".repeat(64),
      });

      expect(signedForUnknown.status).toBe(401);
      expect(badSignature.status).toBe(401);
      expect(stableText(signedForUnknown.text)).toBe(stableText(badSignature.text));
      expect(JSON.parse(signedForUnknown.text)).toMatchObject(JSON.parse(BAD_SIGNATURE_TEXT));
      expect(await dedupeCount(`surface:${unknown}:whatsapp`, ev.eventId)).toBe(0);
    });

    it("an event from an actor with no binding is refused even when it claims the owner role", async () => {
      const stranger = `stranger-${run}`;
      const appr = await awaitingApproval(wsA);
      const approve = await sendSurface(approvalEvent(wsA, stranger, appr.approvalId, "approve", "owner"));
      expect(approve.status).toBe(403);
      expect(approve.text).toContain("SURFACE_ROLE_VIOLATION");
      expect((await approvalRow(appr.approvalId)).status).toBe("pending");
      expect(await workflowState(appr.wfId)).toBe(WorkflowState.AWAITING_APPROVAL);
      expect(await orderCount(appr.orderId)).toBe(0);

      const before = await stockOf(wsA);
      const count = await sendSurface(stockEvent(wsA, stranger, 3, nextId("evt_stranger"), "owner"));
      expect(count.status).toBe(403);
      expect(count.text).toContain("SURFACE_ROLE_VIOLATION");
      expect(await stockOf(wsA)).toBe(before);
    });

    it("a staff binding cannot approve even when the event claims owner", async () => {
      const appr = await awaitingApproval(wsA);
      const res = await sendSurface(approvalEvent(wsA, staffActorA, appr.approvalId, "approve", "owner"));
      expect(res.status).toBe(403);
      expect(res.text).toContain("SURFACE_ROLE_VIOLATION");
      expect((await approvalRow(appr.approvalId)).status).toBe("pending");
      expect(await workflowState(appr.wfId)).toBe(WorkflowState.AWAITING_APPROVAL);
    });

    it("an owner binding approves an approval of its own workspace and the decision is recorded as the surface actor", async () => {
      const appr = await awaitingApproval(wsA);
      const res = await sendSurface(approvalEvent(wsA, ownerActorA, appr.approvalId));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "processed", decision: "approve", effectiveRole: "owner" });

      const row = await approvalRow(appr.approvalId);
      expect(row.status).toBe("approved");
      expect(row.decided_by).toBe(`surface:whatsapp:${ownerActorA}`);
      expect(await workflowState(appr.wfId)).toBe(WorkflowState.CONFIRMED);

      const audit = await query(
        `SELECT actor_type, actor_id FROM audit_logs WHERE workflow_id = $1 AND action = 'approval.approved';`,
        [appr.wfId]
      );
      expect(audit.rows).toEqual([{ actor_type: "owner", actor_id: `surface:whatsapp:${ownerActorA}` }]);
    });

    it("an owner binding of workspace A cannot approve an approval of workspace B and nothing changes", async () => {
      const appr = await awaitingApproval(wsB);
      for (const decision of ["approve", "reject"] as const) {
        const res = await sendSurface(approvalEvent(wsA, ownerActorA, appr.approvalId, decision));
        expect(res.status, decision).toBe(404);
        expect(res.body, decision).toMatchObject({ error: expect.any(String), code: "APPROVAL_NOT_FOUND" });
      }
      const row = await approvalRow(appr.approvalId);
      expect(row.status).toBe("pending");
      expect(row.decided_by).toBeNull();
      expect(await workflowState(appr.wfId)).toBe(WorkflowState.AWAITING_APPROVAL);
      expect(await orderCount(appr.orderId)).toBe(0);
    });

    it("a replayed surface event is accepted once", async () => {
      const ev = stockEvent(wsA, ownerActorA, 10);
      await setStock(wsA, 99);
      const first = await sendSurface(ev);
      expect(first.status).toBe(200);
      expect(first.body.status).toBe("processed");
      expect(await stockOf(wsA)).toBe(10);

      await setStock(wsA, 99);
      const replay = await sendSurface(ev);
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ status: "duplicate", eventId: ev.eventId });
      expect(await stockOf(wsA)).toBe(99);

      // The same event id with a different body is also a duplicate: the id is the key.
      const altered = await sendSurface({ ...ev, observedQuantity: 1 });
      expect(altered.body.status).toBe("duplicate");
      expect(await stockOf(wsA)).toBe(99);
      expect(await dedupeCount(`surface:${wsA}:whatsapp`, ev.eventId)).toBe(1);
    });

    it("the same event id in two workspaces is processed in both", async () => {
      const sharedId = nextId("evt_shared");
      await setStock(wsA, 99);
      await setStock(wsB, 99);
      const inA = await sendSurface(stockEvent(wsA, ownerActorA, 10, sharedId));
      const inB = await sendSurface(stockEvent(wsB, ownerActorB, 10, sharedId));
      expect(inA.body.status).toBe("processed");
      expect(inB.body.status).toBe("processed");
      expect(await stockOf(wsA)).toBe(10);
      expect(await stockOf(wsB)).toBe(10);
    });

    it("an unsigned request cannot burn an event id", async () => {
      const id = nextId("evt_burn");
      const unsigned = await sendUnsigned(stockEvent(wsA, ownerActorA, 10, id));
      expect(unsigned.status).toBe(401);

      const signed = await sendSurface(stockEvent(wsA, ownerActorA, 10, id));
      expect(signed.status).toBe(200);
      expect(signed.body.status).toBe("processed");
    });

    it("a surface binding is audited under the token label, not a fixed address", async () => {
      const actorId = `audit-${run}`;
      const res = await call("POST", `/api/workspaces/${wsA}/surfaces`, {
        token: ownerA.token,
        body: { surface: "email", actorId, actorRole: "staff" },
      });
      expect(res.status).toBe(201);
      const rows = await query(
        `SELECT actor_id FROM audit_logs WHERE workspace_id = $1 AND action = 'surface.bind_identity' AND evidence->>'actorId' = $2;`,
        [wsA, actorId]
      );
      expect(rows.rows).toEqual([{ actor_id: "owner:alice-hook" }]);
    });
  });

  describe("A real pause switch", () => {
    it("a staff binding cannot pause", async () => {
      const res = await sendSurface(pauseEvent(wsC, staffActorC, true, "owner"));
      expect(res.status).toBe(403);
      expect(res.text).toContain("SURFACE_ROLE_VIOLATION");
      expect(await pausedOf(wsC)).toBe(false);
    });

    it("a signed pause event from an owner binding pauses the workspace and the stored value is returned", async () => {
      const res = await sendSurface(pauseEvent(wsC, ownerActorC, true));
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "processed", eventType: "SURFACE_AGENT_PAUSE_TOGGLE", paused: true, workspaceId: wsC });
      expect(await pausedOf(wsC)).toBe(true);

      const audit = await query(
        `SELECT actor_type, actor_id, evidence FROM audit_logs WHERE workspace_id = $1 AND action = 'workspace.agents_paused_changed';`,
        [wsC]
      );
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].actor_id).toBe(`surface:whatsapp:${ownerActorC}`);
      expect(audit.rows[0].evidence).toMatchObject({ paused: true });
    });

    it("replenishment is refused while paused and no workflow is created", async () => {
      const sku = `SKU-PAUSE-${run}`;
      const add = await call("POST", `/api/workspaces/${wsC}/inventory`, {
        token: ownerC.token,
        body: {
          sku,
          name: "Paused Test Oil",
          category: "Dry Goods",
          unit: "bottle",
          currentQuantity: 1,
          parLevel: 10,
          reorderQuantity: 5,
          unitPriceCents: 1000,
        },
      });
      expect(add.status).toBe(201);

      const workflowsFor = async () =>
        (await query(`SELECT COUNT(*)::int AS n FROM workflows WHERE workspace_id = $1 AND context_data->>'sku' = $2;`, [wsC, sku])).rows[0].n as number;
      const quotesIn = async () => (await query(`SELECT COUNT(*)::int AS n FROM quotes WHERE workspace_id = $1;`, [wsC])).rows[0].n as number;
      const workflowsBefore = await workflowsFor();
      const quotesBefore = await quotesIn();

      const res = await call("POST", `/api/workspaces/${wsC}/replenish`, { token: ownerC.token, body: { sku } });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/AGENTS_PAUSED/);
      expect(res.body.error).toMatch(/paused/i);

      expect(await workflowsFor()).toBe(workflowsBefore);
      expect(await quotesIn()).toBe(quotesBefore);
    });

    it("an approved order is not placed while paused (the commitment is denied)", async () => {
      const first = await awaitingApproval(wsC);
      const viaApi = await call("POST", `/api/approvals/${first.approvalId}/approve`, { token: ownerC.token });
      expect(viaApi.status).toBe(409);
      expect(viaApi.body.code).toBe("POLICY_DENIED");
      expect(viaApi.body.reasonCodes).toContain("AGENTS_PAUSED");

      const second = await awaitingApproval(wsC);
      const viaSurface = await sendSurface(approvalEvent(wsC, ownerActorC, second.approvalId));
      expect(viaSurface.status).toBe(409);
      expect(viaSurface.body.reasonCodes).toContain("AGENTS_PAUSED");

      for (const appr of [first, second]) {
        expect((await approvalRow(appr.approvalId)).status).not.toBe("approved");
        expect(await orderCount(appr.orderId)).toBe(0);
      }
    });

    it("the owner API resumes the workspace", async () => {
      const denied = await call("PUT", `/api/workspaces/${wsC}/agents-paused`, { token: staffC.token, body: { paused: false } });
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject(OWNER_REQUIRED);
      expect(await pausedOf(wsC)).toBe(true);

      const resumed = await call("PUT", `/api/workspaces/${wsC}/agents-paused`, { token: ownerC.token, body: { paused: false } });
      expect(resumed.status).toBe(200);
      // `_meta` is added beside the existing fields (ADR 0050).
      expect(resumed.body).toMatchObject({ workspaceId: wsC, paused: false });
      expect(await pausedOf(wsC)).toBe(false);

      const audit = await query(
        `SELECT actor_id, evidence FROM audit_logs WHERE workspace_id = $1 AND action = 'workspace.agents_paused_changed' AND evidence->>'paused' = 'false';`,
        [wsC]
      );
      expect(audit.rows.map((r) => r.actor_id)).toEqual([`owner:carol-hook`]);

      const sku = `SKU-PAUSE-${run}`;
      const replenish = await call("POST", `/api/workspaces/${wsC}/replenish`, { token: ownerC.token, body: { sku } });
      expect(replenish.status).toBe(200);
      expect(replenish.body.workflowId).toBeDefined();
    });

    it("the owner pause API is owner only and needs a boolean", async () => {
      const bad = await call("PUT", `/api/workspaces/${wsC}/agents-paused`, { token: ownerC.token, body: { paused: "yes" } });
      expect(bad.status).toBe(400);
      expect(await pausedOf(wsC)).toBe(false);

      const none = await call("PUT", `/api/workspaces/${wsC}/agents-paused`, { body: { paused: true } });
      expect(none.status).toBe(401);
      expect(none.body).toMatchObject(AUTH_REQUIRED);
    });
  });

  describe("The standard webhook route", () => {
    const STANDARD = SURFACE_PATH;

    it("the standard webhook requires a signature in the test environment too", async () => {
      const provider = `hook_unsigned_${run}`;
      const eventId = nextId("evt_std_unsigned");
      const raw = JSON.stringify({ provider, eventId, payload: { item: "flour" } });
      const res = await postRaw(baseUrl, STANDARD, raw);
      expect(res.status).toBe(401);
      expect(JSON.parse(res.text)).toMatchObject(JSON.parse(BAD_SIGNATURE_TEXT));
      expect(await dedupeCount(provider, eventId)).toBe(0);
    });

    it("the standard webhook with a signature of the wrong length answers 401, not 500", async () => {
      const raw = JSON.stringify({ provider: `hook_len_${run}`, eventId: nextId("evt_len"), payload: {} });
      const res = await postRaw(baseUrl, STANDARD, raw, {
        "x-bind-timestamp": String(nowSec()),
        "x-bind-signature": "abc",
      });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.text)).toMatchObject(JSON.parse(BAD_SIGNATURE_TEXT));
    });

    it("the standard webhook refuses a missing eventId with 400", async () => {
      const provider = `hook_noid_${run}`;
      const raw = JSON.stringify({ provider, payload: { item: "flour" } });
      const res = await postRaw(baseUrl, STANDARD, raw, signHeaders(raw, WEBHOOK));
      expect(res.status).toBe(400);
      expect((await query(`SELECT COUNT(*)::int AS n FROM inbound_webhooks WHERE provider = $1;`, [provider])).rows[0].n).toBe(0);

      const noProvider = JSON.stringify({ eventId: nextId("evt_noprov"), payload: {} });
      const bad = await postRaw(baseUrl, STANDARD, noProvider, signHeaders(noProvider, WEBHOOK));
      expect(bad.status).toBe(400);
    });

    it("a signature is checked over the raw bytes, not a re-serialized body", async () => {
      const provider = `hook_raw_${run}`;
      const eventId = nextId("evt_raw");
      const spaced = `{ "provider": "${provider}",   "eventId": "${eventId}", "payload": { "n": 1 } }`;

      const reserialized = await postRaw(baseUrl, STANDARD, spaced, signHeaders(JSON.stringify(JSON.parse(spaced)), WEBHOOK));
      expect(reserialized.status).toBe(401);

      const exact = await postRaw(baseUrl, STANDARD, spaced, signHeaders(spaced, WEBHOOK));
      expect(exact.status).toBe(200);
      expect(exact.body.accepted).toBe(true);
    });

    it("a signed standard event is accepted once", async () => {
      const provider = `hook_once_${run}`;
      const eventId = nextId("evt_once");
      const raw = JSON.stringify({ provider, eventId, payload: { item: "flour" } });
      const first = await postRaw(baseUrl, STANDARD, raw, signHeaders(raw, WEBHOOK));
      expect(first.status).toBe(200);
      expect(first.body.accepted).toBe(true);

      const second = await postRaw(baseUrl, STANDARD, raw, signHeaders(raw, WEBHOOK));
      expect(second.status).toBe(200);
      expect(second.body.accepted).toBe(false);
      expect(second.body.reason).toMatch(/Duplicate webhook event/);
    });

    it("a database error is not returned to the webhook caller", async () => {
      const provider = `hook_dberr_${run}`;
      const raw = JSON.stringify({ provider, eventId: nextId("evt_dberr"), payload: {} });
      const original = pool.query.bind(pool);
      const spy = vi.spyOn(pool, "query").mockImplementation(((text: string, params?: unknown[]) => {
        if (typeof text === "string" && text.includes("inbound_webhooks")) {
          return Promise.reject(new Error('relation "secret_internal_table" does not exist'));
        }
        return original(text, params);
      }) as any);
      let res: Sent;
      try {
        res = await postRaw(baseUrl, STANDARD, raw, signHeaders(raw, WEBHOOK));
      } finally {
        spy.mockRestore();
      }
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ accepted: false, reason: "Webhook could not be recorded" });
      expect(res.text).not.toContain("secret_internal_table");
    });

    it("no default webhook secret exists in the source", async () => {
      const root = path.resolve(process.cwd(), "src");
      const files = (await fs.readdir(root, { recursive: true })) as string[];
      const offenders: string[] = [];
      for (const rel of files) {
        if (rel.split(path.sep).includes("ui")) continue;
        if (!/\.(ts|js|mjs|sql|json)$/.test(rel)) continue;
        const text = await fs.readFile(path.join(root, rel), "utf8");
        if (text.includes("whsec_test_secret_key_12345")) offenders.push(rel);
      }
      expect(offenders).toEqual([]);
    });
  });

  describe("Webhook secrets, configuration and schema", () => {
    it("the webhook secret is shown to the owner only and rotation invalidates the old signature", async () => {
      const staff = await call("GET", `/api/workspaces/${wsA}/webhook-secret`, { token: staffA.token });
      expect(staff.status).toBe(403);
      expect(staff.body).toMatchObject(OWNER_REQUIRED);

      const shown = await call("GET", `/api/workspaces/${wsA}/webhook-secret`, { token: ownerA.token });
      expect(shown.status).toBe(200);
      expect(shown.headers.get("cache-control")).toMatch(/no-store/);
      expect(Object.keys(shown.body).sort()).toEqual(["secret", "version"]);
      expect(shown.body).toEqual({ secret: surfaceSecret(wsA, 1), version: 1 });
      const viewed = await query(
        `SELECT evidence::text AS ev FROM audit_logs WHERE workspace_id = $1 AND action = 'auth.webhook_secret_viewed';`,
        [wsA]
      );
      expect(viewed.rows.length).toBeGreaterThanOrEqual(1);
      for (const row of viewed.rows) expect(row.ev).not.toContain(shown.body.secret);

      // Signed with the version 1 secret: accepted before rotation.
      const before = await sendSurface(stockEvent(wsA, ownerActorA, 10), 1);
      expect(before.status).toBe(200);

      const staffRotate = await call("POST", `/api/workspaces/${wsA}/webhook-secret/rotate`, { token: staffA.token });
      expect(staffRotate.status).toBe(403);
      expect(staffRotate.body).toMatchObject(OWNER_REQUIRED);
      expect((await query(`SELECT webhook_secret_version FROM workspaces WHERE id = $1;`, [wsA])).rows[0].webhook_secret_version).toBe(1);

      const rotated = await call("POST", `/api/workspaces/${wsA}/webhook-secret/rotate`, { token: ownerA.token });
      expect(rotated.status).toBe(200);
      expect(Object.keys(rotated.body).filter((k) => k !== "_meta").sort()).toEqual(["secret", "version"]);
      expect(rotated.body.version).toBe(2);
      expect(rotated.body.secret).toBe(surfaceSecret(wsA, 2));
      expect(rotated.body.secret).not.toBe(shown.body.secret);
      expect((await query(`SELECT webhook_secret_version FROM workspaces WHERE id = $1;`, [wsA])).rows[0].webhook_secret_version).toBe(2);

      const rotatedAudit = await query(
        `SELECT actor_id, evidence::text AS ev FROM audit_logs WHERE workspace_id = $1 AND action = 'auth.webhook_secret_rotated';`,
        [wsA]
      );
      expect(rotatedAudit.rows.map((r) => r.actor_id)).toEqual(["owner:alice-hook"]);
      expect(rotatedAudit.rows[0].ev).not.toContain(rotated.body.secret);
      expect(rotatedAudit.rows[0].ev).not.toContain(shown.body.secret);

      const stale = await sendSurface(stockEvent(wsA, ownerActorA, 10), 1);
      expect(stale.status).toBe(401);
      expect(JSON.parse(stale.text)).toMatchObject(JSON.parse(BAD_SIGNATURE_TEXT));

      const fresh = await sendSurface(stockEvent(wsA, ownerActorA, 10), 2);
      expect(fresh.status).toBe(200);

      // Rotation of A does not change B's secret.
      const other = await sendSurface(stockEvent(wsB, ownerActorB, 10), 1);
      expect(other.status).toBe(200);
    });

    it("without a configured secret the webhook routes answer 503 and process nothing", async () => {
      const unconfigured = createApp({ secrets: { masterSecret: null, webhookSecret: null } });
      const local = await new Promise<Server>((resolve) => {
        const s = unconfigured.listen(0, "127.0.0.1", () => resolve(s));
      });
      const addr = local.address();
      const localUrl = addr && typeof addr === "object" ? `http://127.0.0.1:${addr.port}` : "";
      try {
        const appr = await awaitingApproval(wsA);
        const versionBefore = (await query(`SELECT webhook_secret_version FROM workspaces WHERE id = $1;`, [wsA])).rows[0].webhook_secret_version;
        const stockBefore = await stockOf(wsA);
        const pausedBefore = await pausedOf(wsC);
        const stdId = nextId("evt_unconf");
        const stdRaw = JSON.stringify({ provider: `hook_unconf_${run}`, eventId: stdId, payload: {} });
        const notConfigured = { error: "Webhook signing is not configured" };

        const std = await postRaw(localUrl, SURFACE_PATH, stdRaw, signHeaders(stdRaw, WEBHOOK));
        expect(std.status).toBe(503);
        expect(std.body).toMatchObject(notConfigured);

        const stockRaw = JSON.stringify(stockEvent(wsA, ownerActorA, 3));
        const stock = await postRaw(localUrl, SURFACE_PATH, stockRaw, signHeaders(stockRaw, surfaceSecret(wsA)));
        expect(stock.status).toBe(503);
        expect(stock.body).toMatchObject(notConfigured);

        const approvalRaw = JSON.stringify(approvalEvent(wsA, ownerActorA, appr.approvalId));
        const approval = await postRaw(localUrl, SURFACE_PATH, approvalRaw, signHeaders(approvalRaw, surfaceSecret(wsA)));
        expect(approval.status).toBe(503);

        const pauseRaw = JSON.stringify(pauseEvent(wsC, ownerActorC, true));
        const pause = await postRaw(localUrl, SURFACE_PATH, pauseRaw, signHeaders(pauseRaw, surfaceSecret(wsC)));
        expect(pause.status).toBe(503);

        const shown = await request(localUrl, "GET", `/api/workspaces/${wsA}/webhook-secret`, { token: ownerA.token });
        expect(shown.status).toBe(503);
        expect(shown.body).toMatchObject(notConfigured);
        const rotated = await request(localUrl, "POST", `/api/workspaces/${wsA}/webhook-secret/rotate`, { token: ownerA.token });
        expect(rotated.status).toBe(503);

        expect(await dedupeCount(`hook_unconf_${run}`, stdId)).toBe(0);
        expect((await approvalRow(appr.approvalId)).status).toBe("pending");
        expect(await stockOf(wsA)).toBe(stockBefore);
        expect(await pausedOf(wsC)).toBe(pausedBefore);
        expect((await query(`SELECT webhook_secret_version FROM workspaces WHERE id = $1;`, [wsA])).rows[0].webhook_secret_version).toBe(versionBefore);
      } finally {
        await new Promise<void>((resolve) => local.close(() => resolve()));
      }
    });

    it("the schema adds the pause and secret-version columns with safe defaults", async () => {
      await runMigrations();
      await runMigrations();
      const cols = await query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'workspaces' AND column_name IN ('agents_paused', 'webhook_secret_version');`
      );
      expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["agents_paused", "webhook_secret_version"]);
      const row = (await query(`SELECT agents_paused, webhook_secret_version FROM workspaces WHERE id = $1;`, [wsB])).rows[0];
      expect(row.agents_paused).toBe(false);
      expect(Number(row.webhook_secret_version)).toBe(1);
    });

    it("the document confirm route records the token label, not the body's decidedBy", async () => {
      const extract = await call("POST", `/api/workspaces/${wsA}/documents/extract`, {
        token: ownerA.token,
        body: {
          docType: "quote",
          sourceLabel: "hook_test",
          rawText: `Supplier: Sysco Metro Restock\nSKU: ${SKU}\nQty: 8\nUnit Price: $38.00\nTotal: $304.00`,
        },
      });
      expect(extract.status).toBe(201);
      const docId = extract.body.docId as string;

      const confirm = await call("POST", `/api/workspaces/${wsA}/documents/${docId}/confirm`, {
        token: ownerA.token,
        body: { decidedBy: "mallory@example.test" },
      });
      expect(confirm.status).toBe(200);

      const row = (await query(`SELECT confirmed_by FROM staged_documents WHERE id = $1;`, [docId])).rows[0];
      expect(row.confirmed_by).toBe("owner:alice-hook");
    });
  });
});
