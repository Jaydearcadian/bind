import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { config } from "../../src/config/env.js";
import { setLogSink } from "../../src/observability/logger.js";
import { runTick } from "../../src/workers/runner.js";

/*
 * Operations (docs/decisions/0032): request ids, the request log, /health and /ready, and /metrics.
 * The database guard below is the same pattern as route-failure.test.ts: a named query can be made to fail or to
 * return a fixed result once. Authentication queries are never touched.
 */

const fault = vi.hoisted(() => ({
  next: null as null | { match: RegExp; error?: Error; result?: unknown },
}));

vi.mock("../../src/db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/client.js")>();
  const guarded: typeof actual.query = (text, params) => {
    const armed = fault.next;
    if (armed && armed.match.test(String(text))) {
      fault.next = null;
      if (armed.result !== undefined) return Promise.resolve(armed.result as any);
      return Promise.reject(armed.error ?? new Error("injected failure"));
    }
    return actual.query(text, params);
  };
  return { ...actual, query: guarded };
});

const run = Date.now();
const METRICS_TOKEN = `metrics-test-token-${run}-0123456789abcdef`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SQL_TEXT = /SELECT|INSERT|FROM |relation|SQLSTATE|42P01/i;

type Captured = Record<string, any>;

describe("Operations: request ids, request log, readiness and metrics", () => {
  const app = createApp({ metrics: { token: METRICS_TOKEN, cacheMs: 0 } });
  const wsId = `ops-ws-${run}`;
  const metricsWsId = `ops-metrics-ws-${run}`;
  let server: Server;
  let baseUrl = "";
  let owner: { id: string; token: string };
  let lines: string[] = [];

  async function send(
    method: string,
    routePath: string,
    opts: { token?: string; headers?: Record<string, string>; body?: string; contentType?: string } = {}
  ) {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = opts.contentType ?? "application/json";
    const res = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers,
      body: opts.body,
      signal: AbortSignal.timeout(10000),
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

  function entries(): Captured[] {
    return lines.map((line) => JSON.parse(line));
  }

  function requestLine(requestId: string): Captured | undefined {
    return entries().find((e) => e.event === "http.request" && e.requestId === requestId);
  }

  async function scrape(): Promise<string> {
    const res = await send("GET", "/metrics", { token: METRICS_TOKEN });
    expect(res.status).toBe(200);
    return res.text;
  }

  /** The value of one exposition sample, or undefined when it is absent. */
  function sample(text: string, selector: string): number | undefined {
    for (const line of text.split("\n")) {
      if (line.startsWith(`${selector} `)) return Number(line.slice(selector.length + 1));
    }
    return undefined;
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsId, "Ops Kitchen", "kitchen-v1");
    owner = await issueToken(wsId, "owner", "ops-owner");
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  beforeEach(() => {
    lines = [];
    setLogSink((line) => {
      lines.push(line);
    });
  });

  afterEach(() => {
    fault.next = null;
    setLogSink(null);
  });

  afterAll(async () => {
    fault.next = null;
    setLogSink(null);
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [[wsId, metricsWsId]]);
    for (const id of [wsId, metricsWsId]) {
      await fs.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    }
    await closePool();
  });

  describe("request ids", () => {
    it("every response carries an x-request-id", async () => {
      const ok = await send("GET", "/health");
      expect(ok.status).toBe(200);
      expect(ok.headers.get("x-request-id")).toMatch(UUID);

      const unauth = await send("GET", `/api/workspaces/${wsId}/inventory`);
      expect(unauth.status).toBe(401);
      expect(unauth.headers.get("x-request-id")).toMatch(UUID);

      const notFound = await send("GET", "/api/no-such-route");
      expect(notFound.status).toBe(404);
      expect(notFound.headers.get("x-request-id")).toMatch(UUID);

      const malformed = await send("POST", "/api/workspaces/onboard", { body: "{not json" });
      expect(malformed.status).toBe(400);
      expect(malformed.body).toEqual({ error: "Malformed JSON body", code: "MALFORMED_JSON" });
      expect(malformed.headers.get("x-request-id")).toMatch(UUID);

      const tooLarge = await send("POST", "/api/workspaces/onboard", {
        body: JSON.stringify({ pad: "x".repeat(300_000) }),
      });
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.headers.get("x-request-id")).toMatch(UUID);

      fault.next = { match: /FROM suppliers/, error: Object.assign(new Error('relation "suppliers" failed'), { code: "42P01" }) };
      const failed = await send("GET", `/api/workspaces/${wsId}/suppliers`, { token: owner.token });
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({ error: "Internal error" });
      expect(failed.headers.get("x-request-id")).toMatch(UUID);
    });

    it("a safe incoming request id is kept and an unsafe one is replaced", async () => {
      const safe = "abcdefgh_12-34";
      const kept = await send("GET", "/health", { headers: { "x-request-id": safe } });
      expect(kept.headers.get("x-request-id")).toBe(safe);

      const longest = "a".repeat(64);
      expect((await send("GET", "/health", { headers: { "x-request-id": longest } })).headers.get("x-request-id")).toBe(longest);

      for (const unsafe of ["abc", "a".repeat(65), "bad;semicolon;id", "dots.are.not.safe", "under_score_is_safe_but_$dollar"]) {
        const res = await send("GET", "/health", { headers: { "x-request-id": unsafe } });
        const got = res.headers.get("x-request-id") ?? "";
        expect(got, `replaced: ${unsafe}`).not.toBe(unsafe);
        expect(got, `replaced: ${unsafe}`).toMatch(UUID);
      }
    });

    it("the log line for a request has the same id and the route pattern, not the raw path", async () => {
      const id = `req-route-${run}`;
      const res = await send("GET", `/api/workspaces/${wsId}/inventory?probe=1`, {
        token: owner.token,
        headers: { "x-request-id": id },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-request-id")).toBe(id);

      const line = requestLine(id);
      expect(line, "no http.request line for the request").toBeDefined();
      expect(line!.method).toBe("GET");
      expect(line!.route).toBe("/api/workspaces/:id/inventory");
      expect(line!.status).toBe(200);
      expect(typeof line!.durationMs).toBe("number");
      expect(line!.workspaceId).toBe(wsId);

      const unmatchedId = `req-unmatched-${run}`;
      await send("GET", `/api/no-such-thing/${wsId}`, { headers: { "x-request-id": unmatchedId } });
      expect(requestLine(unmatchedId)!.route).toBe("unmatched");
      expect(requestLine(unmatchedId)!.status).toBe(404);
    });

    it("log lines never contain the query string, a bearer token or the request body", async () => {
      const queryProbe = `SEED-QUERY-${run}`;
      const headerProbe = `SEED-HEADER-${run}`;
      const bodyProbe = `SEED-BODY-${run}`;
      await send("GET", `/api/workspaces/${wsId}/inventory?leak=${queryProbe}`, {
        token: owner.token,
        headers: { "x-probe": headerProbe },
      });
      await send("POST", `/api/workspaces/${wsId}/inventory`, {
        token: owner.token,
        headers: { "x-probe": headerProbe },
        body: JSON.stringify({ sku: "BAD SKU WITH SPACES", name: bodyProbe }),
      });
      await send("GET", `/api/workspaces/${wsId}/inventory?leak=${queryProbe}`, {
        headers: { authorization: `Bearer ${owner.token}`, "x-probe": headerProbe },
      });

      const all = lines.join("\n");
      expect(all).toContain("http.request");
      expect(all).not.toContain(queryProbe);
      expect(all).not.toContain(headerProbe);
      expect(all).not.toContain(bodyProbe);
      expect(all).not.toContain(owner.token);
      expect(all).not.toContain("leak=");
    });

    it("the error log carries the request id and no stack", async () => {
      const id = `req-error-${run}`;
      fault.next = { match: /FROM suppliers/, error: new Error(`probe failure at ${run}`) };
      const res = await send("GET", `/api/workspaces/${wsId}/suppliers`, {
        token: owner.token,
        headers: { "x-request-id": id },
      });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "Internal error" });

      const errorLine = entries().find((e) => e.level === "error" && e.requestId === id);
      expect(errorLine, "no error line for the request").toBeDefined();
      expect(errorLine!.event).toBe("http.error");
      const raw = lines.find((line) => line.includes(id) && line.includes('"level":"error"')) ?? "";
      expect(raw).not.toBe("");
      expect(raw).not.toMatch(/\n\s+at /);
      expect(raw).not.toContain("stack");
      expect(raw).not.toMatch(/\.ts:\d+/);
    });
  });

  describe("health and readiness", () => {
    it("/ready is 200 when the database is up", async () => {
      const res = await send("GET", "/ready");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ready" });
      expect(res.headers.get("x-request-id")).toMatch(UUID);
    });

    it("/ready is 503 when the database is down and leaks nothing", async () => {
      fault.next = {
        match: /SELECT 1/,
        error: Object.assign(
          new Error(`password authentication failed for postgres://bind_local:bind_local_only@127.0.0.1:5432/bind_local ECONNREFUSED`),
          { code: "ECONNREFUSED" }
        ),
      };
      const res = await send("GET", "/ready");
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: "not_ready" });
      expect(res.text).not.toMatch(/bind_local|postgres:|ECONNREFUSED|password|5432|SQL/i);

      const reason = entries().find((e) => e.event === "ready.not_ready");
      expect(reason?.reason).toBe("database_unavailable");

      fault.next = {
        match: /SELECT 1/,
        error: new Error("connection refused"),
      };
      const health = await send("GET", "/health");
      expect(health.status).toBe(500);
      expect(health.body).toEqual({ status: "error" });
      expect(health.text).not.toMatch(/connection refused|bind_local|postgres:/i);
    });

    it("/ready is 503 when the schema is missing", async () => {
      fault.next = { match: /to_regclass/, result: { rows: [{ schema_present: false }] } };
      const res = await send("GET", "/ready");
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ status: "not_ready" });
      expect(entries().find((e) => e.event === "ready.not_ready")?.reason).toBe("schema_missing");
    });

    it("/ready and /health expose no workspace data", async () => {
      for (const routePath of ["/ready", "/health"]) {
        const res = await send("GET", routePath);
        expect(Object.keys(res.body).sort(), routePath).toEqual(
          routePath === "/ready" ? ["status"] : ["postgres", "status", "timestamp"]
        );
        expect(res.text, routePath).not.toContain(wsId);
        expect(res.text, routePath).not.toContain(owner.token);
        expect(SQL_TEXT.test(res.text), routePath).toBe(false);
      }
    });
  });

  describe("metrics", () => {
    it("metrics is disabled with 404 when no token is configured", async () => {
      const disabled = createApp({ metrics: { token: null } });
      const disabledServer = await new Promise<Server>((resolve) => {
        const s = disabled.listen(0, "127.0.0.1", () => resolve(s));
      });
      try {
        const addr = disabledServer.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
          headers: { Authorization: `Bearer ${METRICS_TOKEN}` },
        });
        expect(res.status).toBe(404);
      } finally {
        await new Promise<void>((resolve) => disabledServer.close(() => resolve()));
      }
    });

    it("metrics needs the metrics token and refuses a workspace token", async () => {
      const none = await send("GET", "/metrics");
      expect(none.status).toBe(401);
      expect(none.body).toEqual({ error: "Authentication required" });

      const wrong = await send("GET", "/metrics", { token: `${METRICS_TOKEN}x` });
      expect(wrong.status).toBe(401);
      expect(wrong.body).toEqual({ error: "Authentication required" });

      const workspace = await send("GET", "/metrics", { token: owner.token });
      expect(workspace.status).toBe(401);
      expect(workspace.body).toEqual({ error: "Authentication required" });

      const ok = await send("GET", "/metrics", { token: METRICS_TOKEN });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toMatch(/^text\/plain/);
    });

    it("metrics exposes workflow counts by state", async () => {
      await provisionWorkspace(metricsWsId, "Ops Metrics Kitchen", "kitchen-v1");
      const before = await scrape();
      const draftBefore = sample(before, 'bind_workflows{state="draft"}') ?? 0;
      const cancelledBefore = sample(before, 'bind_workflows{state="cancelled"}') ?? 0;

      await query(
        `INSERT INTO workflows (id, workspace_id, workflow_type, state, idempotency_key) VALUES
           ($1, $4, 'kitchen_replenishment', 'draft', $2),
           ($3, $4, 'kitchen_replenishment', 'draft', $5),
           ($6, $4, 'kitchen_replenishment', 'cancelled', $7);`,
        [`wf-ops-a-${run}`, `idem-ops-a-${run}`, `wf-ops-b-${run}`, metricsWsId, `idem-ops-b-${run}`, `wf-ops-c-${run}`, `idem-ops-c-${run}`]
      );

      const after = await scrape();
      expect(sample(after, 'bind_workflows{state="draft"}')).toBeGreaterThanOrEqual(draftBefore + 2);
      expect(sample(after, 'bind_workflows{state="cancelled"}')).toBeGreaterThanOrEqual(cancelledBefore + 1);
    });

    it("metrics exposes pending approval age", async () => {
      await query(
        `INSERT INTO approvals (id, workspace_id, entity_type, entity_id, action_requested, amount_cents, requester_role, status, expires_at, created_at)
         VALUES ($1, $2, 'order', $3, 'submit_order', 100, 'procurement', 'pending', NOW() + INTERVAL '1 day', NOW() - INTERVAL '2 hours');`,
        [`appr-ops-${run}`, metricsWsId, `wf-appr-ops-${run}`]
      );
      const text = await scrape();
      expect(sample(text, "bind_approvals_pending")).toBeGreaterThanOrEqual(1);
      expect(sample(text, "bind_approvals_oldest_pending_age_seconds")).toBeGreaterThanOrEqual(7000);
    });

    it("metrics exposes unresolved effects and retried effects", async () => {
      const before = await scrape();
      const startedBefore = sample(before, 'bind_effects_unresolved{status="started"}') ?? 0;
      const failedBefore = sample(before, 'bind_effects_unresolved{status="failed"}') ?? 0;
      const retriedBefore = sample(before, "bind_effects_retried") ?? 0;

      await query(
        `INSERT INTO effects (id, workspace_id, effect_class, operation, idempotency_key, request_hash, status, attempts) VALUES
           ($1, $4, 'read', 'ops.probe', $2, 'h', 'started', 2),
           ($3, $4, 'read', 'ops.probe', $5, 'h', 'failed', 1);`,
        [`eff-ops-a-${run}`, `eff-key-a-${run}`, `eff-ops-b-${run}`, metricsWsId, `eff-key-b-${run}`]
      );

      const after = await scrape();
      expect(sample(after, 'bind_effects_unresolved{status="started"}')).toBeGreaterThanOrEqual(startedBefore + 1);
      expect(sample(after, 'bind_effects_unresolved{status="failed"}')).toBeGreaterThanOrEqual(failedBefore + 1);
      expect(sample(after, "bind_effects_retried")).toBeGreaterThanOrEqual(retriedBefore + 1);
    });

    it("metrics labels never contain a workspace id or secret", async () => {
      const text = await scrape();
      expect(text).not.toContain(metricsWsId);
      expect(text).not.toContain(wsId);
      expect(text).not.toContain(owner.token);
      expect(text).not.toContain(config.BIND_MASTER_SECRET ?? "unset-secret");
      expect(text).not.toMatch(/workspace_?id/i);
      expect(text).not.toContain(METRICS_TOKEN);
    });

    it("worker lag and tick metrics update after a tick", async () => {
      const before = await scrape();
      const ticksBefore = sample(before, "bind_worker_tick_duration_seconds_count") ?? 0;

      await runTick({ batchSize: 5 });

      const after = await scrape();
      expect(sample(after, "bind_worker_tick_duration_seconds_count")).toBe(ticksBefore + 1);
      const lastTick = sample(after, "bind_worker_last_tick_timestamp_seconds") ?? 0;
      expect(lastTick).toBeGreaterThan(0);
      const lag = sample(after, "bind_worker_lag_seconds") ?? -2;
      expect(lag).toBeGreaterThanOrEqual(0);
      expect(lag).toBeLessThan(60);
    });

    it("request counters and the duration histogram update", async () => {
      const before = await scrape();
      const counterKey = 'bind_http_requests_total{method="GET",route="/health",status_class="2xx"}';
      const countBefore = sample(before, counterKey) ?? 0;
      const histogramBefore = sample(before, "bind_http_request_duration_seconds_count") ?? 0;

      await send("GET", "/health");
      await send("GET", "/health");

      const after = await scrape();
      expect(sample(after, counterKey)).toBeGreaterThanOrEqual(countBefore + 2);
      expect(sample(after, "bind_http_request_duration_seconds_count")).toBeGreaterThanOrEqual(histogramBefore + 2);
      expect(sample(after, 'bind_http_request_duration_seconds_bucket{le="+Inf"}')).toBe(
        sample(after, "bind_http_request_duration_seconds_count")
      );
    });

    it("the metrics text is valid exposition format", async () => {
      await runTick({ batchSize: 5 });
      const text = await scrape();
      const sampleLine = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{.*\})? -?[0-9.eE+Inf]+$/;
      const help = new Set<string>();
      const type = new Set<string>();
      const seenSample: string[] = [];
      for (const line of text.split("\n")) {
        if (line === "") continue;
        if (line.startsWith("# HELP ")) {
          help.add(line.split(" ")[2]);
          continue;
        }
        if (line.startsWith("# TYPE ")) {
          const parts = line.split(" ");
          expect(help.has(parts[2]), `HELP before TYPE for ${parts[2]}`).toBe(true);
          type.add(parts[2]);
          continue;
        }
        expect(line, `sample line: ${line}`).toMatch(sampleLine);
        const name = line.split(/[{ ]/)[0].replace(/_(bucket|sum|count)$/, "");
        expect(type.has(name), `TYPE before sample for ${name}`).toBe(true);
        seenSample.push(line);
        const labels = line.match(/\{(.*)\}/)?.[1] ?? "";
        for (const pair of labels.match(/[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\]|\\.)*"/g) ?? []) {
          expect(pair.length).toBeGreaterThan(0);
        }
        expect(labels.replace(/[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\]|\\.)*"/g, "").replace(/,/g, "")).toBe("");
      }
      expect(seenSample.length).toBeGreaterThan(10);
      expect(text).toContain("# TYPE bind_http_requests_total counter");
      expect(text).toContain("# TYPE bind_http_request_duration_seconds histogram");
      expect(text).toContain("# TYPE bind_workflows gauge");
    });
  });
});
