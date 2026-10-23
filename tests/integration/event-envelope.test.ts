import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { EffectClass } from "../../src/policy/effect-classifier.js";
import { PolicyDecision } from "../../src/policy/engine.js";

/** Event envelope v1 from the real server (ADR 0053): validated against the draft schema, with the request that caused each event. */
const run = Date.now();
const ws = `ws-env-${run}`;
const ajv = new Ajv2020({ strict: true, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validate = ajv.compile(JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "docs/ecosystem/spec/event-envelope-v1.schema.json"), "utf8")));

describe("event envelope v1", () => {
  const app = createApp({ rateLimits: { enabled: false } });
  let server: Server;
  let baseUrl = "";
  let owner: { token: string };
  let staff: { token: string };

  async function call(method: string, route: string, token: string, opts: { body?: unknown; requestId?: string } = {}) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.requestId) headers["x-request-id"] = opts.requestId;
    const res = await fetch(`${baseUrl}${route}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    return { status: res.status, body: (await res.json()) as any };
  }
  const events = async (token: string) => (await call("GET", `/api/workspaces/${ws}/events/poll?after=0.0&limit=200`, token)).body.events as any[];

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(ws, "Envelope", "kitchen-v1");
    owner = await issueToken(ws, "owner", "alice");
    staff = await issueToken(ws, "staff", "line-cook");
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await query(`DELETE FROM workspaces WHERE id = $1;`, [ws]);
    await fsp.rm(path.resolve(process.cwd(), "templates", ws), { recursive: true, force: true });
    await closePool();
  });

  it("an event carries the request that caused it, its name, its workspace and what it is about", async () => {
    const requestId = `corr-${run}-pause`;
    expect((await call("PUT", `/api/workspaces/${ws}/agents-paused`, owner.token, { body: { paused: true }, requestId })).status).toBe(200);
    const issued = await call("POST", `/api/workspaces/${ws}/tokens`, owner.token, { body: { role: "staff", label: "extra" }, requestId: `corr-${run}-token` });
    expect(issued.status).toBe(201);

    const list = await events(owner.token);
    const paused = list.find((e) => e.type === "workspace.agents_paused_changed");
    expect(paused).toBeTruthy();
    expect(paused).toMatchObject({ name: "workspace.agents_pause_changed", schemaVersion: 1, workspaceId: ws, correlationId: requestId, object: { type: "workspace" } });
    const tokenEvent = list.filter((e) => e.type === "auth.token_issued").pop();
    expect(tokenEvent).toMatchObject({ name: "token.issued", correlationId: `corr-${run}-token`, object: { type: "token", id: issued.body.id } });
    // Every event the server sends is valid against the draft schema.
    for (const e of list) expect(validate(e), `${e.type}: ${JSON.stringify(validate.errors)}`).toBe(true);
  });

  it("a request id from the client that is not safe is not echoed as a correlation id", async () => {
    await call("PUT", `/api/workspaces/${ws}/agents-paused`, owner.token, { body: { paused: false }, requestId: "bad id!" });
    const list = await events(owner.token);
    const last = [...list].reverse().find((e) => e.type === "workspace.agents_paused_changed");
    // The server replaced the unsafe id with its own UUID, which is what the row records.
    expect(last.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("an event no request caused has no correlationId, and staff still do not see owner-only events", async () => {
    await new WorkflowEngine().recordAudit(ws, null, "system", "system:test", EffectClass.READ, "kitchen_capacity.set", PolicyDecision.ALLOW, { note: "no request" });
    const ownerList = await events(owner.token);
    const direct = ownerList.filter((e) => e.type === "kitchen_capacity.set").pop();
    expect(direct).toBeTruthy();
    expect(direct).not.toHaveProperty("correlationId");
    expect(validate(direct)).toBe(true);
    const staffTypes = (await events(staff.token)).map((e) => e.type);
    expect(staffTypes).not.toContain("auth.token_issued");
    expect(staffTypes).not.toContain("kitchen_capacity.set");
  });

  it("records the request id in audit_logs, and the id belongs to this request only", async () => {
    const a = `corr-${run}-a1`;
    const b = `corr-${run}-b2`;
    await Promise.all([
      call("PUT", `/api/workspaces/${ws}/agents-paused`, owner.token, { body: { paused: true }, requestId: a }),
      call("POST", `/api/workspaces/${ws}/tokens`, owner.token, { body: { role: "staff", label: "parallel" }, requestId: b }),
    ]);
    const rows = await query<{ action: string; request_id: string }>(`SELECT action, request_id FROM audit_logs WHERE workspace_id = $1 AND request_id = ANY($2::text[]);`, [ws, [a, b]]);
    const byId = Object.fromEntries(rows.rows.map((r) => [r.request_id, r.action]));
    expect(byId[a]).toBe("workspace.agents_paused_changed");
    expect(byId[b]).toBe("auth.token_issued");
  });
});
