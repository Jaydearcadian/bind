import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { IDEMPOTENT_ROUTES } from "../../src/server/idempotency.js";

/** Client idempotency keys over real HTTP and a real database (ADR 0049). */
const run = Date.now();
const wsA = `ws-idem-a-${run}`;
const wsB = `ws-idem-b-${run}`;

describe("Idempotency-Key", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  let ownerA1: { token: string };
  let ownerA2: { token: string };
  let ownerB: { token: string };

  async function pause(ws: string, token: string, paused: unknown, key?: string) {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    if (key !== undefined) headers["Idempotency-Key"] = key;
    const res = await fetch(`${baseUrl}/api/workspaces/${ws}/agents-paused`, { method: "PUT", headers, body: JSON.stringify({ paused }) });
    return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, any> };
  }
  async function isPaused(): Promise<boolean> {
    const r = await query<{ agents_paused: boolean }>(`SELECT agents_paused FROM workspaces WHERE id = $1;`, [wsA]);
    return r.rows[0].agents_paused;
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsA, "Idem A", "kitchen-v1");
    await provisionWorkspace(wsB, "Idem B", "kitchen-v1");
    ownerA1 = await issueToken(wsA, "owner", "alice");
    ownerA2 = await issueToken(wsA, "owner", "bob");
    ownerB = await issueToken(wsB, "owner", "carol");
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
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [[wsA, wsB]]);
    for (const id of [wsA, wsB]) await fsp.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    await closePool();
  });

  it("replays the first outcome and does not run the command again", async () => {
    const first = await pause(wsA, ownerA1.token, true, "k-replay-1");
    expect(first.status).toBe(200);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    expect((await pause(wsA, ownerA1.token, false)).status).toBe(200); // the world moves on
    const again = await pause(wsA, ownerA1.token, true, "k-replay-1");
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    const { _meta: firstMeta, ...firstRest } = first.body;
    expect(again.body).toMatchObject(firstRest);
    expect(firstMeta.requestId).not.toBe(again.body._meta.requestId);
    expect(await isPaused()).toBe(false); // not paused again by the replay
  });

  it("adds _meta: a missing-key warning without a key, none with one, and a fresh request id on a replay", async () => {
    const without = await pause(wsA, ownerA1.token, false);
    expect(without.status).toBe(200);
    expect(without.body._meta).toMatchObject({ status: "completed", warnings: [{ code: "IDEMPOTENCY_KEY_MISSING" }] });
    expect(without.body._meta.requestId).toBe(without.headers.get("x-request-id"));

    const first = await pause(wsA, ownerA1.token, true, "k-meta");
    expect(first.body._meta.warnings).toBeUndefined();
    expect(first.body._meta.requestId).toBe(first.headers.get("x-request-id"));
    const again = await pause(wsA, ownerA1.token, true, "k-meta");
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.body._meta.requestId).toBe(again.headers.get("x-request-id"));
    expect(again.body._meta.requestId).not.toBe(first.body._meta.requestId);
  });

  it("never stores a secret: a replayed rotation says the secret was left out", async () => {
    const send = () =>
      fetch(`${baseUrl}/api/workspaces/${wsA}/webhook-secret/rotate`, { method: "POST", headers: { Authorization: `Bearer ${ownerA1.token}`, "Idempotency-Key": "k-rotate" } }).then(async (r) => ({
        headers: r.headers,
        body: (await r.json()) as Record<string, any>,
      }));
    const first = await send();
    expect(typeof first.body.secret).toBe("string");
    const again = await send();
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.body.secret).toBeUndefined();
    expect(again.body).toMatchObject({ version: first.body.version, secretOmitted: true });
    const stored = await query<{ response_body: unknown }>(`SELECT response_body FROM api_idempotency WHERE workspace_id = $1 AND key = 'k-rotate';`, [wsA]);
    expect(JSON.stringify(stored.rows[0].response_body)).not.toContain(first.body.secret);
  });

  it("refuses the same key with a different request (422)", async () => {
    await pause(wsA, ownerA1.token, true, "k-reuse");
    const res = await pause(wsA, ownerA1.token, false, "k-reuse");
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", category: "validation", retryable: false });
  });

  it("refuses a malformed key (400) before running anything", async () => {
    for (const key of ["", "has space", "x".repeat(129), "a/b"]) {
      const res = await pause(wsA, ownerA1.token, true, key);
      expect(res.status, key).toBe(400);
      expect(res.body.code).toBe("IDEMPOTENCY_KEY_INVALID");
    }
  });

  it("scopes a key to the token and the workspace", async () => {
    await pause(wsA, ownerA1.token, false, "k-scope");
    const otherToken = await pause(wsA, ownerA2.token, true, "k-scope");
    expect(otherToken.status).toBe(200);
    expect(otherToken.headers.get("idempotent-replayed")).toBeNull();
    const otherTenant = await pause(wsB, ownerB.token, true, "k-scope");
    expect(otherTenant.status).toBe(200);
    expect(otherTenant.headers.get("idempotent-replayed")).toBeNull();
  });

  it("stores a refusal a retry would repeat, and replays it", async () => {
    const first = await pause(wsA, ownerA1.token, "yes", "k-400");
    expect(first.status).toBe(400);
    const again = await pause(wsA, ownerA1.token, "yes", "k-400");
    expect(again.status).toBe(400);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
  });

  it("does not let an unauthenticated or wrong-role caller touch the store", async () => {
    const before = (await query(`SELECT COUNT(*)::int AS n FROM api_idempotency;`)).rows[0].n;
    const res = await fetch(`${baseUrl}/api/workspaces/${wsA}/agents-paused`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "k-anon" },
      body: JSON.stringify({ paused: true }),
    });
    expect(res.status).toBe(401);
    expect((await query(`SELECT COUNT(*)::int AS n FROM api_idempotency;`)).rows[0].n).toBe(before);
  });

  it("answers 409 with Retry-After while the first request is running, and takes over a stale lock", async () => {
    await pause(wsA, ownerA1.token, true, "k-seed"); // learn the token id from a real row
    const { token_id } = (await query<{ token_id: string }>(`SELECT token_id FROM api_idempotency WHERE workspace_id=$1 AND key='k-seed';`, [wsA])).rows[0];
    // The fingerprint of the request the test will send, computed the way the server does.
    const { fingerprintOf } = await import("../../src/server/idempotency.js");
    const fp = fingerprintOf("PUT", `/api/workspaces/${wsA}/agents-paused`, { paused: false });
    await query(
      `INSERT INTO api_idempotency (workspace_id, token_id, key, operation, fingerprint, state) VALUES ($1,$2,'k-busy','PUT /api/workspaces/:id/agents-paused',$3,'in_progress');`,
      [wsA, token_id, fp]
    );
    const busy = await pause(wsA, ownerA1.token, false, "k-busy");
    expect(busy.status).toBe(409);
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(busy.body).toMatchObject({ code: "IDEMPOTENCY_IN_PROGRESS", category: "conflict", retryable: true, retryAfterSeconds: 1 });
    expect(await isPaused()).toBe(true); // not run

    await query(`UPDATE api_idempotency SET locked_at = NOW() - INTERVAL '1 hour' WHERE key = 'k-busy';`);
    const taken = await pause(wsA, ownerA1.token, false, "k-busy");
    expect(taken.status).toBe(200);
    expect(await isPaused()).toBe(false);
  });

  it("forgets a stored outcome after 24 hours", async () => {
    await pause(wsA, ownerA1.token, true, "k-old");
    await query(`UPDATE api_idempotency SET created_at = NOW() - INTERVAL '25 hours' WHERE key = 'k-old';`);
    const again = await pause(wsA, ownerA1.token, true, "k-old");
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBeNull();
  });

  it("is ignored on a route that does not take a key", async () => {
    const res = await fetch(`${baseUrl}/api/workspaces/${wsA}/inventory`, { headers: { Authorization: `Bearer ${ownerA1.token}`, "Idempotency-Key": "bad key!" } });
    expect(res.status).toBe(200);
  });

  it("covers exactly the economic or irreversible public writes in the capability catalogue", () => {
    const catalogue = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "docs/capabilities.json"), "utf8")) as {
      capabilities: { method: string; route: string; exposure: string; economic?: boolean; irreversible?: boolean }[];
    };
    const expected = catalogue.capabilities
      .filter((c) => c.method !== "GET" && c.exposure === "public_api" && (c.economic || c.irreversible))
      .map((c) => `${c.method} ${c.route.replace(/\{(\w+)\}/g, ":$1")}`)
      .sort();
    // The one keyed route that is neither economic nor irreversible: the analytics sync (docs/decisions/0091). The brief
    // asks for an Idempotency-Key on it. A repeat leaves the stored posts as they were, and the key replays the first answer.
    // It is named here, so a second such route is a visible decision and not a silent one.
    // Keyed for a reason other than economic: the analytics sync (a provider call, replayed on a retry) and connecting an account
    // (a row per call, replayed on a retry). See docs/decisions/0091.
    const keyedForAnotherReason = [
      "POST /api/workspaces/:id/analytics/accounts/:accountId/sync",
      "POST /api/workspaces/:id/analytics/accounts",
    ];
    expect([...IDEMPOTENT_ROUTES].sort()).toEqual([...expected, ...keyedForAnotherReason].sort());
  });
});
