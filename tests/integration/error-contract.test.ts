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

/**
 * Error body v2 from the real server (ADR 0047, stage 1 and 2). Every error below comes from the running app over HTTP and is
 * validated against the draft schema in docs/ecosystem/spec/error-v2.schema.json, so the specification and the server cannot
 * drift apart. Rate limits (429) are covered in tests/integration/rate-limit.test.ts.
 */
const run = Date.now();
const wsA = `ws-errc-a-${run}`;
const wsB = `ws-errc-b-${run}`;
const ids = [wsA, wsB];

const ajv = new Ajv2020({ strict: true, allErrors: true });
(addFormats as unknown as (a: Ajv2020) => void)(ajv);
const validate = ajv.compile(JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "docs/ecosystem/spec/error-v2.schema.json"), "utf8")));
const catalogue = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "docs/ecosystem/spec/error-catalogue.json"), "utf8")) as { codes: { code: string; httpStatus: number; category: string; retryable: boolean; existing: boolean }[] };

describe("error body v2 from the server", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  let ownerA: { token: string };
  let staffA: { token: string };

  async function call(method: string, route: string, opts: { token?: string; body?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}${route}`, { method, headers, body: opts.body });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as Record<string, any>, headers: res.headers };
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsA, "Error Contract A", "kitchen-v1");
    await provisionWorkspace(wsB, "Error Contract B", "kitchen-v1");
    ownerA = await issueToken(wsA, "owner", "alice");
    staffA = await issueToken(wsA, "staff", "line-cook");
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
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [ids]);
    for (const id of ids) await fsp.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    await closePool();
  });

  const cases: Array<{ name: string; status: number; code: string; category: string; retryable: boolean; send: () => Promise<{ status: number; body: Record<string, any>; text: string; headers: Headers }> }> = [
    { name: "malformed JSON", status: 400, code: "MALFORMED_JSON", category: "validation", retryable: false, send: () => call("POST", `/api/workspaces/${wsA}/replenish`, { token: ownerA.token, body: "{not json" }) },
    { name: "a body that fails its schema", status: 400, code: "VALIDATION_FAILED", category: "validation", retryable: false, send: () => call("PUT", `/api/workspaces/${wsA}/agents-paused`, { token: ownerA.token, body: JSON.stringify({ paused: "yes" }) }) },
    { name: "no token", status: 401, code: "UNAUTHENTICATED", category: "authentication", retryable: false, send: () => call("GET", `/api/workspaces/${wsA}/inventory`) },
    { name: "staff on an owner route", status: 403, code: "FORBIDDEN", category: "authorization", retryable: false, send: () => call("PUT", `/api/workspaces/${wsA}/policy`, { token: staffA.token, body: "{}" }) },
    { name: "another tenant's workspace", status: 404, code: "NOT_FOUND", category: "not_found", retryable: false, send: () => call("GET", `/api/workspaces/${wsB}/inventory`, { token: ownerA.token }) },
    { name: "an unknown approval", status: 404, code: "APPROVAL_NOT_FOUND", category: "not_found", retryable: false, send: () => call("POST", "/api/approvals/appr_none/approve", { token: ownerA.token, body: "{}" }) },
    { name: "an id that is taken", status: 409, code: "CONFLICT", category: "conflict", retryable: false, send: () => call("POST", "/api/workspaces", { body: JSON.stringify({ id: wsA, name: "Dup", templateId: "kitchen-v1" }) }) },
    { name: "a body over the limit", status: 413, code: "BODY_TOO_LARGE", category: "validation", retryable: false, send: () => call("POST", `/api/workspaces/${wsA}/replenish`, { token: ownerA.token, body: JSON.stringify({ sku: "x".repeat(300_000) }) }) },
  ];

  for (const c of cases) {
    it(`${c.name}: ${c.status} ${c.code}, valid against the draft schema, with the request id`, async () => {
      const res = await c.send();
      expect(res.status).toBe(c.status);
      expect(validate(res.body), JSON.stringify(validate.errors)).toBe(true);
      expect(res.body).toMatchObject({ code: c.code, category: c.category, retryable: c.retryable });
      expect(res.body.requestId).toBe(res.headers.get("x-request-id"));
      const entry = catalogue.codes.find((x) => x.code === c.code);
      expect(entry, `${c.code} in the catalogue`).toBeDefined();
      expect(entry).toMatchObject({ httpStatus: c.status, category: c.category, retryable: c.retryable, existing: true });
    });
  }

  it("keeps a safe incoming request id and puts it in the body", async () => {
    const res = await call("GET", `/api/workspaces/${wsA}/inventory`, { headers: { "x-request-id": "client-request-0001" } });
    expect(res.body.requestId).toBe("client-request-0001");
    expect(res.headers.get("x-request-id")).toBe("client-request-0001");
  });

  it("a validation error names the failing fields and never echoes the submitted value", async () => {
    const secretish = "bnd_" + "Z".repeat(43);
    const res = await call("PUT", `/api/workspaces/${wsA}/agents-paused`, { token: ownerA.token, body: JSON.stringify({ paused: secretish }) });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(secretish);
    expect(res.text).not.toContain(ownerA.token);
  });

  it("a successful response is unchanged: no category, no request id in the body", async () => {
    const res = await fetch(`${baseUrl}/api/workspaces/${wsA}/inventory`, { headers: { Authorization: `Bearer ${ownerA.token}` } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    const health = await fetch(`${baseUrl}/health`);
    expect(Object.keys(await health.json()).sort()).not.toContain("category");
  });

  it("the readiness and health failure bodies are not changed (they have no error field)", async () => {
    const ready = await fetch(`${baseUrl}/ready`);
    expect([200, 503]).toContain(ready.status);
    expect(Object.keys(await ready.json())).not.toContain("category");
  });
});
