import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { setLogSink } from "../../src/observability/logger.js";

/*
 * Rate limits (docs/decisions/0033). Each test starts its own app, so limiter state and the fake clock never leak
 * between tests. Clients are simulated with x-forwarded-for, which is read only when trust proxy is set (one hop here).
 */

const run = Date.now();
const METRICS_TOKEN = `rl-metrics-token-${run}-0123456789abcdef`;
const MASTER_SECRET = `rl-master-secret-${run}-0123456789abcdef0123`;
const WEBHOOK_SECRET = `rl-webhook-secret-${run}-0123456789abcdef0123`;
const BAD_TOKEN = `bnd_${"A".repeat(43)}`;
const WINDOW_MS = 60_000;
const BASE = Date.UTC(2026, 9, 20, 12, 0, 0);
const UNAUTHORIZED = { error: "Invalid signature or expired timestamp" };
const RATE_LIMITED = { error: "Too many requests", code: "RATE_LIMITED" };

const wsA = `rl-ws-a-${run}`;
const createdIds: string[] = [];

let clockMs = BASE;
const now = () => clockMs;

/** The small limits every test uses. The per-hour creation limit is 2 so the test can reach it. */
const LIMITS = {
  enabled: true,
  now,
  authFailures: { windowMs: WINDOW_MS, max: 3 },
  webhookCalls: { windowMs: WINDOW_MS, max: 50 },
  webhookBadSignatures: { windowMs: WINDOW_MS, max: 2 },
  workspaceCreate: { windowMs: 60 * WINDOW_MS, max: 2 },
  apiPerToken: { windowMs: WINDOW_MS, max: 4 },
};

const closers: Array<() => Promise<void>> = [];
let logLines: string[] = [];
let owner: { id: string; token: string };
let staff: { id: string; token: string };

function sha256Prefix(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

interface Reply {
  status: number;
  text: string;
  body: any;
  headers: Headers;
}

async function send(
  base: string,
  method: string,
  routePath: string,
  opts: { ip?: string; token?: string; body?: string; json?: unknown; requestId?: string } = {}
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.requestId) headers["x-request-id"] = opts.requestId;
  let body = opts.body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers["Content-Type"] = "application/json";
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${base}${routePath}`, { method, headers, body, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  return { status: res.status, text, body: parsed, headers: res.headers };
}

async function startApp(rateLimits: Record<string, unknown> = LIMITS, trustProxy = 1): Promise<string> {
  const app = createApp({
    metrics: { token: METRICS_TOKEN, cacheMs: 0 },
    secrets: { masterSecret: MASTER_SECRET, webhookSecret: WEBHOOK_SECRET },
    trustProxy,
    rateLimits: rateLimits as any,
  });
  const server = await new Promise<Server>((resolve) => {
    const started = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return `http://127.0.0.1:${port}`;
}

function entries(): Array<Record<string, any>> {
  return logLines.map((line) => JSON.parse(line));
}

/** The value of one exposition sample, or undefined when it is absent. */
function sample(text: string, selector: string): number | undefined {
  for (const line of text.split("\n")) {
    if (line.startsWith(`${selector} `)) return Number(line.slice(selector.length + 1));
  }
  return undefined;
}

describe("Rate limits: auth failures, webhooks, public creation and per-token budgets", () => {
  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsA, "Rate Limit Kitchen", "kitchen-v1");
    createdIds.push(wsA);
    owner = await issueToken(wsA, "owner", "rl-owner");
    staff = await issueToken(wsA, "staff", "rl-staff");
  });

  beforeEach(() => {
    clockMs = BASE;
    logLines = [];
    setLogSink((line) => {
      logLines.push(line);
    });
  });

  afterEach(async () => {
    setLogSink(null);
    while (closers.length > 0) {
      const close = closers.pop()!;
      await close();
    }
  });

  afterAll(async () => {
    setLogSink(null);
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [createdIds]);
    for (const id of createdIds) {
      await fs.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    }
    await closePool();
  });

  /** Sends three bad tokens from one client, so its next request is over the auth-failure limit. */
  async function blockClient(base: string, ip: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const res = await send(base, "GET", "/api/workspaces", { ip, token: BAD_TOKEN });
      expect(res.status, `bad token ${i + 1}`).toBe(401);
    }
  }

  it("repeated bad tokens from one client are answered 429 after the limit", async () => {
    const base = await startApp();
    const ip = "198.51.100.1";
    for (let i = 0; i < 3; i++) {
      const res = await send(base, "GET", `/api/workspaces/${wsA}/inventory`, { ip, token: BAD_TOKEN });
      expect(res.status, `attempt ${i + 1}`).toBe(401);
      expect(res.body).toEqual({ error: "Authentication required" });
    }
    const blocked = await send(base, "GET", `/api/workspaces/${wsA}/inventory`, { ip, token: BAD_TOKEN });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(RATE_LIMITED);
  });

  it("a blocked client is refused even with a valid token until the window ends", async () => {
    const base = await startApp();
    const ip = "198.51.100.2";
    await blockClient(base, ip);
    const blocked = await send(base, "GET", "/api/workspaces", { ip, token: BAD_TOKEN });
    expect(blocked.status).toBe(429);

    const valid = { ip, token: owner.token };
    expect((await send(base, "GET", "/api/workspaces", valid)).status).toBe(429);

    clockMs = BASE + WINDOW_MS - 1;
    expect((await send(base, "GET", "/api/workspaces", valid)).status).toBe(429);

    clockMs = BASE + WINDOW_MS;
    const after = await send(base, "GET", "/api/workspaces", valid);
    expect(after.status).toBe(200);
    expect(Array.isArray(after.body)).toBe(true);
  });

  it("health and readiness answer while the client is blocked", async () => {
    const base = await startApp();
    const ip = "198.51.100.90";
    await blockClient(base, ip);
    expect((await send(base, "GET", "/api/workspaces", { ip, token: owner.token })).status).toBe(429);

    // Liveness and readiness expose no data and are never refused by the block (docs/decisions/0033).
    expect((await send(base, "GET", "/health", { ip })).status).toBe(200);
    expect((await send(base, "GET", "/ready", { ip })).status).toBe(200);

    // Metrics stays under the block: it is token-guarded and a target for guessing.
    const metrics = await send(base, "GET", "/metrics", { ip, token: METRICS_TOKEN });
    expect(metrics.status).toBe(429);
    expect(metrics.body).toEqual(RATE_LIMITED);
  });

  it("another client is not affected by that block", async () => {
    const base = await startApp();
    const blockedIp = "198.51.100.3";
    const otherIp = "198.51.100.4";
    await blockClient(base, blockedIp);
    expect((await send(base, "GET", "/api/workspaces", { ip: blockedIp, token: owner.token })).status).toBe(429);

    expect((await send(base, "GET", "/api/workspaces", { ip: otherIp, token: owner.token })).status).toBe(200);
    expect((await send(base, "GET", "/api/workspaces", { ip: otherIp, token: BAD_TOKEN })).status).toBe(401);
  });

  it("the forwarded-for header is ignored when trust proxy is zero", async () => {
    // One hop trusted: each forwarded address is its own client, so none reaches the limit.
    const proxied = await startApp(LIMITS, 1);
    for (let i = 0; i < 4; i++) {
      const res = await send(proxied, "GET", "/api/workspaces", { ip: `198.51.100.${10 + i}`, token: BAD_TOKEN });
      expect(res.status, `forwarded client ${i}`).toBe(401);
    }

    // No trusted hop: the header is ignored, so every request is the socket's one client and the limit applies.
    const direct = await startApp(LIMITS, 0);
    for (let i = 0; i < 3; i++) {
      const res = await send(direct, "GET", "/api/workspaces", { ip: `203.0.113.${20 + i}`, token: BAD_TOKEN });
      expect(res.status, `direct attempt ${i + 1}`).toBe(401);
    }
    const blocked = await send(direct, "GET", "/api/workspaces", { ip: "203.0.113.99", token: BAD_TOKEN });
    expect(blocked.status).toBe(429);
  });

  it("repeated bad webhook signatures are answered 429", async () => {
    const base = await startApp();
    const ip = "198.51.100.30";
    const unsigned = { provider: "rl-probe", eventId: `rl-evt-${run}` };
    for (let i = 0; i < 2; i++) {
      const res = await send(base, "POST", "/api/webhooks/incoming", { ip, json: unsigned });
      expect(res.status, `unsigned ${i + 1}`).toBe(401);
      expect(res.body).toEqual(UNAUTHORIZED);
    }
    const blocked = await send(base, "POST", "/api/webhooks/incoming", { ip, json: unsigned });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual(RATE_LIMITED);
    expect(blocked.headers.get("retry-after")).toBe("60");
  });

  it("workspace creation is limited per client and the existing workspace is untouched", async () => {
    const base = await startApp();
    const ip = "198.51.100.40";
    const idOne = `rl-new-${run}-one`;
    const idTwo = `rl-new-${run}-two`;
    createdIds.push(idOne, idTwo);

    // Every attempt counts, including a malformed one (the limit runs before the body is read).
    const malformed = await send(base, "POST", "/api/workspaces/onboard", { ip, body: "{not json" });
    expect(malformed.status).toBe(400);

    const first = await send(base, "POST", "/api/workspaces", {
      ip,
      json: { id: idOne, name: "Rate Kitchen One", templateId: "kitchen-v1" },
    });
    expect(first.status).toBe(201);
    const ownerOne = first.body.ownerToken.token as string;

    const third = await send(base, "POST", "/api/workspaces", {
      ip,
      json: { id: idTwo, name: "Rate Kitchen Two", templateId: "kitchen-v1" },
    });
    expect(third.status).toBe(429);
    expect(third.body).toEqual(RATE_LIMITED);
    const created = await query(`SELECT id FROM workspaces WHERE id = $1;`, [idTwo]);
    expect(created.rows.length).toBe(0);

    // Another client asking for the existing id is refused as before, and the workspace is not changed.
    const other = await send(base, "POST", "/api/workspaces", {
      ip: "198.51.100.41",
      json: { id: idOne, name: "Overwritten", templateId: "kitchen-v1" },
    });
    expect(other.status).toBe(409);
    expect(other.body).toEqual({ error: "Workspace id is not available" });
    const row = await query(`SELECT name FROM workspaces WHERE id = $1;`, [idOne]);
    expect(row.rows[0].name).toBe("Rate Kitchen One");

    const still = await send(base, "GET", "/api/workspaces", { ip: "198.51.100.41", token: ownerOne });
    expect(still.status).toBe(200);
    expect(still.body[0].id).toBe(idOne);
  });

  it("the per-token limit applies after authentication and counts per token", async () => {
    const base = await startApp();
    const ip = "198.51.100.50";
    for (let i = 0; i < 4; i++) {
      const res = await send(base, "GET", `/api/workspaces/${wsA}/inventory`, { ip, token: owner.token });
      expect(res.status, `owner request ${i + 1}`).toBe(200);
    }
    const limited = await send(base, "GET", `/api/workspaces/${wsA}/inventory`, { ip, token: owner.token });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual(RATE_LIMITED);

    // The budget belongs to the token, so the same token from another client is limited too.
    const elsewhere = await send(base, "GET", `/api/workspaces/${wsA}/inventory`, {
      ip: "198.51.100.51",
      token: owner.token,
    });
    expect(elsewhere.status).toBe(429);

    // Another token has its own budget.
    const other = await send(base, "GET", `/api/workspaces/${wsA}/inventory`, {
      ip: "198.51.100.52",
      token: staff.token,
    });
    expect(other.status).toBe(200);

    // A request that does not authenticate is answered 401, never by the token limit.
    const unknown = await send(base, "GET", `/api/workspaces/${wsA}/inventory`, {
      ip: "198.51.100.53",
      token: BAD_TOKEN,
    });
    expect(unknown.status).toBe(401);
  });

  it("a 429 has retry-after, the code and no other detail", async () => {
    const base = await startApp();
    const ip = "198.51.100.60";
    await blockClient(base, ip);
    const blocked = await send(base, "GET", "/api/workspaces", { ip, token: BAD_TOKEN });
    expect(blocked.status).toBe(429);

    const retry = blocked.headers.get("retry-after") ?? "";
    expect(retry).toMatch(/^\d+$/);
    expect(Number(retry)).toBe(60);
    expect(Object.keys(blocked.body).sort()).toEqual(["code", "error"]);
    expect(blocked.body).toEqual(RATE_LIMITED);
    expect(blocked.text).not.toContain(BAD_TOKEN);
    expect(blocked.text).not.toContain(ip);
  });

  it("rate limited requests are counted in the metrics and logged without the raw ip", async () => {
    const base = await startApp();
    const ip = "198.51.100.9";
    const selector = 'bind_rate_limited_total{scope="authFailures"}';
    const scrapeBefore = await send(base, "GET", "/metrics", { token: METRICS_TOKEN });
    const before = sample(scrapeBefore.text, selector) ?? 0;

    await blockClient(base, ip);
    const requestId = `rl-429-${run}`;
    const blocked = await send(base, "GET", "/api/workspaces", { ip, token: BAD_TOKEN, requestId });
    expect(blocked.status).toBe(429);

    const scrapeAfter = await send(base, "GET", "/metrics", { token: METRICS_TOKEN });
    expect(sample(scrapeAfter.text, selector)).toBe(before + 1);

    const line = entries().find((e) => e.event === "rate_limited" && e.requestId === requestId);
    expect(line, "no rate_limited line for the request").toBeDefined();
    expect(line).toMatchObject({ level: "warn", scope: "authFailures", ipHash: sha256Prefix(ip) });

    const all = logLines.join("\n");
    expect(all).not.toContain(ip);
    expect(all).not.toContain(BAD_TOKEN);
  });

  it("a 429 is not counted as an auth failure (the block does not extend itself)", async () => {
    const base = await startApp();
    const ip = "198.51.100.70";
    await blockClient(base, ip);

    // Requests answered 429 during the block are not auth failures: the retry-after never grows.
    for (let i = 0; i < 5; i++) {
      const res = await send(base, "GET", "/api/workspaces", { ip, token: BAD_TOKEN });
      expect(res.status, `blocked ${i + 1}`).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    }

    // The block ends exactly when the first window does, not later.
    const valid = { ip, token: owner.token };
    clockMs = BASE + WINDOW_MS - 1;
    expect((await send(base, "GET", "/api/workspaces", valid)).status).toBe(429);
    clockMs = BASE + WINDOW_MS;
    expect((await send(base, "GET", "/api/workspaces", valid)).status).toBe(200);

    // A new window starts with its own count: three more bad tokens are 401, and the fourth is refused.
    for (let i = 0; i < 3; i++) {
      expect((await send(base, "GET", "/api/workspaces", { ip, token: BAD_TOKEN })).status).toBe(401);
    }
    expect((await send(base, "GET", "/api/workspaces", { ip, token: BAD_TOKEN })).status).toBe(429);
  });

  it("with limits disabled nothing is limited", async () => {
    const base = await startApp({ enabled: false });
    const ip = "198.51.100.80";
    for (let i = 0; i < 12; i++) {
      expect((await send(base, "GET", "/api/workspaces", { ip, token: BAD_TOKEN })).status, `token ${i}`).toBe(401);
    }
    for (let i = 0; i < 12; i++) {
      const res = await send(base, "POST", "/api/webhooks/incoming", {
        ip,
        json: { provider: "rl-off", eventId: `rl-off-${i}` },
      });
      expect(res.status, `webhook ${i}`).toBe(401);
    }
    for (let i = 0; i < 6; i++) {
      expect((await send(base, "POST", "/api/workspaces/onboard", { ip, body: "{not json" })).status, `create ${i}`).toBe(
        400
      );
    }
  });
});
