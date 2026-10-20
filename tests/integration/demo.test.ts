import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { config } from "../../src/config/env.js";
import { runTick } from "../../src/workers/runner.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { setLogSink } from "../../src/observability/logger.js";
import { SimulatedSupplierAdapter } from "../../src/adapters/suppliers/simulated.js";
import { DEMO_TTL_MS } from "../../src/demo/policy.js";

/**
 * Demo workspaces (docs/decisions/0057). Real PostgreSQL and real HTTP through createApp; nothing is mocked except where a
 * test forces a failure (a seed that throws, a supplier that is not simulated). Every demo a test creates is deleted in
 * afterAll with its files, so the shared database keeps no demo from this file.
 */

const run = Date.now();
const WS_REAL = `ws-demo-real-${run}`;
const FLOUR = "FOOD-FLOUR-50LB"; // low: 3 on hand, par 6, 10 to order at $24.50 (under the $250 approval threshold)
const BUTTER = "FOOD-BUTTER-36LB"; // low: 2 on hand, par 4, 4 to order at $98.00 (needs owner approval)
const RESET_WINDOW_MS = 60 * 60_000;

const createdDemoIds = new Set<string>();

interface Reply {
  status: number;
  text: string;
  body: any;
  headers: Headers;
}

async function call(
  base: string,
  method: string,
  routePath: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let payload: string | undefined;
  if (opts.body !== undefined) {
    payload = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(`${base}${routePath}`, { method, headers, body: payload, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, text, body, headers: res.headers };
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A demo created through the public route. Recorded for cleanup. */
async function createDemo(url: string): Promise<{ workspaceId: string; token: string; expiresAt: string; reply: Reply }> {
  const reply = await call(url, "POST", "/api/demo");
  expect(reply.status, reply.text).toBe(201);
  const { workspaceId, token, expiresAt } = reply.body;
  createdDemoIds.add(workspaceId);
  return { workspaceId, token, expiresAt, reply };
}

async function countRows(table: string, workspaceId: string): Promise<number> {
  const res = await query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE workspace_id = $1;`, [workspaceId]);
  return Number(res.rows[0].n);
}

async function activeDemoCount(): Promise<number> {
  const res = await query(`SELECT COUNT(*)::int AS n FROM workspaces WHERE is_demo AND demo_expires_at > NOW();`);
  return Number(res.rows[0].n);
}

function templateDirOf(workspaceId: string): string {
  return path.resolve(process.cwd(), "templates", workspaceId);
}

function workflowDirOf(workflowId: string): string {
  return path.resolve(process.cwd(), "workflows", workflowId);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("demo workspaces (docs/decisions/0057)", () => {
  // Generous cap: this file's own demos never reach it. The cap test sets its own.
  const app = createApp({ rateLimits: { enabled: false }, metrics: { token: null }, demo: { enabled: true, maxActive: 10_000 } });
  let server: { url: string; close: () => Promise<void> };
  let realOwner: { id: string; token: string };
  const savedEnv = { SETTLEMENT_MODE: config.SETTLEMENT_MODE, SUPPLIER_ADAPTER_MODE: config.SUPPLIER_ADAPTER_MODE };
  const logLines: string[] = [];

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(WS_REAL, "Demo Test Real Kitchen", "kitchen-v1");
    realOwner = await issueToken(WS_REAL, "owner", "demo-real-owner");
    server = await listen(app);
  }, 120_000);

  afterEach(() => {
    vi.restoreAllMocks();
    setLogSink(null);
    logLines.length = 0;
    config.SETTLEMENT_MODE = savedEnv.SETTLEMENT_MODE;
    config.SUPPLIER_ADAPTER_MODE = savedEnv.SUPPLIER_ADAPTER_MODE;
  });

  afterAll(async () => {
    if (server) await server.close();
    const ids = [...createdDemoIds];
    await query(`DELETE FROM idempotency_keys WHERE workspace_id = ANY($1::text[]);`, [ids]);
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [ids]);
    await query(`DELETE FROM workspaces WHERE id = $1;`, [WS_REAL]);
    for (const id of ids) {
      await fs.rm(templateDirOf(id), { recursive: true, force: true });
    }
    await closePool();
  });

  it("creating a demo returns a working owner token, marks the workspace as a demo, and expires about four hours ahead", async () => {
    const before = Date.now();
    const demo = await createDemo(server.url);

    expect(Object.keys(demo.reply.body).sort()).toEqual(["expiresAt", "token", "workspaceId"]);
    expect(demo.reply.headers.get("cache-control")).toBe("no-store");
    expect(demo.token).toMatch(/^bnd_[A-Za-z0-9_-]{43}$/);
    expect(demo.workspaceId).toMatch(/^ws-demo-[0-9a-f]{16}$/);

    const expiresMs = Date.parse(demo.expiresAt);
    expect(expiresMs - before).toBeGreaterThan(DEMO_TTL_MS - 60_000);
    expect(expiresMs - before).toBeLessThan(DEMO_TTL_MS + 60_000);

    // The token is an ordinary owner token for that workspace.
    const detail = await call(server.url, "GET", `/api/workspaces/${demo.workspaceId}`, { token: demo.token });
    expect(detail.status, detail.text).toBe(200);
    expect(detail.body.workspace.is_demo).toBe(true);
    expect(Date.parse(detail.body.workspace.demo_expires_at)).toBe(expiresMs);
    expect(detail.body.workspace.settlement_mode).toBe("local");
    expect(detail.body.workspace.template_id).toBe("kitchen-v1");

    // A token for the demo is refused on every other workspace.
    const other = await call(server.url, "GET", `/api/workspaces/${WS_REAL}/inventory`, { token: demo.token });
    expect(other.status).toBe(404);

    // A real workspace is never a demo.
    const real = await call(server.url, "GET", `/api/workspaces/${WS_REAL}`, { token: realOwner.token });
    expect(real.body.workspace.is_demo).toBe(false);
    expect(real.body.workspace.demo_expires_at).toBeNull();
  });

  it("the seeded records come from a real replenishment: a pending approval with its workflow and the low-stock audit row", async () => {
    const demo = await createDemo(server.url);

    const approvals = await call(server.url, "GET", `/api/workspaces/${demo.workspaceId}/approvals`, { token: demo.token });
    expect(approvals.status).toBe(200);
    const pending = approvals.body.filter((a: any) => a.status === "pending");
    expect(pending.length).toBe(1);
    const approval = pending[0];
    // 4 units of butter at 9800 cents, above the 25000 cent approval threshold: the owner must decide.
    expect(Number(approval.amount_cents)).toBe(39200);

    // The approval belongs to a real workflow that is waiting for the owner.
    const workflow = await call(server.url, "GET", `/api/workspaces/${demo.workspaceId}/workflows/${approval.entity_id}`, {
      token: demo.token,
    });
    expect(workflow.status, workflow.text).toBe(200);
    expect(workflow.body.state).toBe("awaiting_approval");

    // The audit trail says a real replenishment ran for the seed item and that the demo was created.
    const audit = await call(server.url, "GET", `/api/workspaces/${demo.workspaceId}/audit`, { token: demo.token });
    expect(audit.status).toBe(200);
    const actions = audit.body.map((row: any) => row.action);
    expect(actions).toContain("inventory.detect_low_stock");
    expect(actions).toContain("demo.created");
    expect(actions).toContain("auth.token_issued");
    const low = audit.body.find((row: any) => row.action === "inventory.detect_low_stock");
    expect(low.evidence.sku).toBe(BUTTER);
  });

  it("a demo uses local settlement and simulated suppliers even when the environment asks for live ones", async () => {
    // The environment asks for Arc and for live suppliers. A demo still starts local and simulated.
    config.SETTLEMENT_MODE = "arc-testnet";
    config.SUPPLIER_ADAPTER_MODE = "live";
    const demo = await createDemo(server.url);
    const row = await query(`SELECT settlement_mode, is_demo FROM workspaces WHERE id = $1;`, [demo.workspaceId]);
    expect(row.rows[0]).toEqual({ settlement_mode: "local", is_demo: true });

    // A stored value that asks for Arc (as a damaged row could) is still not used: a replenishment takes the deterministic local path.
    // On the Arc path it would stop with INVARIANT_10 (no NEBIUS_API_KEY), so the answer shows which path ran.
    await query(`UPDATE workspaces SET settlement_mode = 'arc-testnet' WHERE id = $1;`, [demo.workspaceId]);
    const replenish = await call(server.url, "POST", `/api/workspaces/${demo.workspaceId}/replenish`, {
      token: demo.token,
      body: { sku: FLOUR },
    });
    expect(replenish.status, replenish.text).toBe(200);
    expect(replenish.body.state).not.toBe("failed");
    expect(JSON.stringify(replenish.body)).not.toContain("INVARIANT_10");

    // Settlement reads the local adapter, so the workspace detail answers (the Arc adapter is not configured here).
    const detail = await call(server.url, "GET", `/api/workspaces/${demo.workspaceId}`, { token: demo.token });
    expect(detail.status, detail.text).toBe(200);
  });

  it("a demo refuses a supplier that is not simulated, at creation and when a quote is requested", async () => {
    const demo = await createDemo(server.url);

    // Creation through the API: a demo may not add a live supplier or one with an endpoint.
    const live = await call(server.url, "POST", `/api/workspaces/${demo.workspaceId}/suppliers`, {
      token: demo.token,
      body: { id: "live-supplier", name: "Live Supplier", adapterType: "manual_quote", isSimulated: false, verified: true },
    });
    expect(live.status).toBe(400);
    expect(live.body.error).toBe("Demo workspaces use simulated suppliers only.");
    const endpoint = await call(server.url, "POST", `/api/workspaces/${demo.workspaceId}/suppliers`, {
      token: demo.token,
      body: {
        id: "endpoint-supplier",
        name: "Endpoint Supplier",
        adapterType: "simulated_sysco",
        isSimulated: true,
        verified: true,
        endpointUrl: "https://supplier.example.invalid/quotes",
      },
    });
    expect(endpoint.status).toBe(400);

    // The same request on a real workspace is accepted: the rule is for demos only.
    const realLive = await call(server.url, "POST", `/api/workspaces/${WS_REAL}/suppliers`, {
      token: realOwner.token,
      body: { id: `live-real-${run}`, name: "Live Real", adapterType: "manual_quote", isSimulated: false, verified: true },
    });
    expect(realLive.status).toBe(201);

    // At quote time: an adapter that is not simulated is refused before any effect starts. The workflow ends failed with the reason.
    const notSimulated = new SimulatedSupplierAdapter("supp-sysco-metro", "Not Simulated", 1.0, false);
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => notSimulated });
    const result = await runner.startReplenishment(demo.workspaceId, FLOUR, "demo_test");
    expect(result.state).toBe("failed");
    const workflow = await query(`SELECT state, error_message FROM workflows WHERE id = $1;`, [result.workflowId]);
    expect(workflow.rows[0].state).toBe("failed");
    expect(workflow.rows[0].error_message).toContain("simulated suppliers");
    // The seed's butter quote is real and stays. No quote was stored for the refused flour request.
    const flourQuotes = await query(`SELECT COUNT(*)::int AS n FROM quotes WHERE workspace_id = $1 AND item_sku = $2;`, [
      demo.workspaceId,
      FLOUR,
    ]);
    expect(Number(flourQuotes.rows[0].n)).toBe(0);
    // No external effect was started for the refused workflow (the seed's own effects belong to its workflow).
    const refusedEffects = await query(`SELECT COUNT(*)::int AS n FROM effects WHERE workflow_id = $1;`, [result.workflowId]);
    expect(Number(refusedEffects.rows[0].n)).toBe(0);
  });

  it("an expired demo's token gets 401, and the worker deletes the demo with its rows and its generated files", async () => {
    const expired = await createDemo(server.url);
    const kept = await createDemo(server.url);

    // The demo's own generated template folder exists once the owner changes its policy (syncWorkspaceDerivedTemplateFiles).
    const policy = await call(server.url, "PUT", `/api/workspaces/${expired.workspaceId}/policy`, {
      token: expired.token,
      body: { budgetDailyLimitCents: 100000, approvalThresholdCents: 25000 },
    });
    expect(policy.status, policy.text).toBe(200);
    expect(await exists(templateDirOf(expired.workspaceId))).toBe(true);

    // The seed's workflow, and a folder for it as settlement writes one. The folder is created here by the test.
    const workflowRow = await query(`SELECT id FROM workflows WHERE workspace_id = $1 LIMIT 1;`, [expired.workspaceId]);
    const workflowId = String(workflowRow.rows[0].id);
    await fs.mkdir(workflowDirOf(workflowId), { recursive: true });
    await fs.writeFile(path.join(workflowDirOf(workflowId), "decision.md"), "test evidence", "utf8");
    expect(await countRows("approvals", expired.workspaceId)).toBe(1);

    // Expire it, as time would.
    await query(`UPDATE workspaces SET demo_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1;`, [expired.workspaceId]);
    const refused = await call(server.url, "GET", `/api/workspaces/${expired.workspaceId}`, { token: expired.token });
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe("Authentication required");

    // The worker step removes it. The other demo is not expired and stays.
    const report = await runTick();
    expect(report.demoExpiry.skipped).toBe(false);
    expect(report.errors.filter((e) => e.step === "demo_expiry")).toEqual([]);
    expect(report.demoExpiry.removed).toBeGreaterThanOrEqual(1);

    const row = await query(`SELECT id FROM workspaces WHERE id = $1;`, [expired.workspaceId]);
    expect(row.rows.length).toBe(0);
    expect(await countRows("workspace_tokens", expired.workspaceId)).toBe(0);
    expect(await countRows("approvals", expired.workspaceId)).toBe(0);
    expect(await countRows("workflows", expired.workspaceId)).toBe(0);
    expect(await countRows("audit_logs", expired.workspaceId)).toBe(0);
    expect(await exists(templateDirOf(expired.workspaceId))).toBe(false);
    expect(await exists(workflowDirOf(workflowId))).toBe(false);

    const keptRow = await query(`SELECT id FROM workspaces WHERE id = $1;`, [kept.workspaceId]);
    expect(keptRow.rows.length).toBe(1);
    const keptDetail = await call(server.url, "GET", `/api/workspaces/${kept.workspaceId}`, { token: kept.token });
    expect(keptDetail.status).toBe(200);
  });

  it("reset returns new credentials, the old token stops working, and a reset of a real workspace is refused and changes nothing", async () => {
    const demo = await createDemo(server.url);
    const reset = await call(server.url, "POST", `/api/workspaces/${demo.workspaceId}/demo/reset`, { token: demo.token });
    expect(reset.status, reset.text).toBe(201);
    expect(reset.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(reset.body).sort()).toEqual(["expiresAt", "token", "workspaceId"]);
    createdDemoIds.add(reset.body.workspaceId);
    expect(reset.body.workspaceId).not.toBe(demo.workspaceId);
    expect(reset.body.token).not.toBe(demo.token);

    // The old demo and its token are gone.
    const oldRow = await query(`SELECT id FROM workspaces WHERE id = $1;`, [demo.workspaceId]);
    expect(oldRow.rows.length).toBe(0);
    const oldToken = await call(server.url, "GET", `/api/workspaces/${demo.workspaceId}`, { token: demo.token });
    expect(oldToken.status).toBe(401);

    // The new one works and is seeded like any demo.
    const fresh = await call(server.url, "GET", `/api/workspaces/${reset.body.workspaceId}/approvals`, { token: reset.body.token });
    expect(fresh.status).toBe(200);
    expect(fresh.body.filter((a: any) => a.status === "pending").length).toBe(1);

    // A real workspace cannot be reset. The answer is 409, and the real owner and its data are untouched.
    const refusedReset = await call(server.url, "POST", `/api/workspaces/${WS_REAL}/demo/reset`, { token: realOwner.token });
    expect(refusedReset.status).toBe(409);
    expect(refusedReset.body.code).toBe("NOT_A_DEMO");
    const stillThere = await query(`SELECT is_demo FROM workspaces WHERE id = $1;`, [WS_REAL]);
    expect(stillThere.rows[0].is_demo).toBe(false);
    const realStill = await call(server.url, "GET", `/api/workspaces/${WS_REAL}`, { token: realOwner.token });
    expect(realStill.status).toBe(200);

    // Staff of the demo cannot reset it: the owner issues a staff token for the demo, and that token gets 403.
    const staffToken = await call(server.url, "POST", `/api/workspaces/${reset.body.workspaceId}/tokens`, {
      token: reset.body.token,
      body: { role: "staff", label: "demo-staff" },
    });
    expect(staffToken.status, staffToken.text).toBe(201);
    const staff = await call(server.url, "POST", `/api/workspaces/${reset.body.workspaceId}/demo/reset`, {
      token: staffToken.body.token,
    });
    expect(staff.status).toBe(403);
  });

  it("creating and resetting share one per-address limit, and a refused request is answered 429 with Retry-After", async () => {
    let clock = Date.UTC(2026, 9, 20, 12, 0, 0);
    const limited = createApp({
      rateLimits: { enabled: true, now: () => clock, demoCreate: { windowMs: RESET_WINDOW_MS, max: 2 } },
      metrics: { token: null },
      demo: { enabled: true, maxActive: 10_000 },
    });
    const srv = await listen(limited);
    try {
      const first = await call(srv.url, "POST", "/api/demo");
      expect(first.status).toBe(201);
      createdDemoIds.add(first.body.workspaceId);
      const second = await call(srv.url, "POST", `/api/workspaces/${first.body.workspaceId}/demo/reset`, { token: first.body.token });
      expect(second.status).toBe(201);
      createdDemoIds.add(second.body.workspaceId);

      // The third attempt, a create, is over the limit for this address.
      const third = await call(srv.url, "POST", "/api/demo");
      expect(third.status).toBe(429);
      expect(third.body.code).toBe("RATE_LIMITED");
      expect(Number(third.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
      expect(third.body.retryAfterSeconds).toBeGreaterThanOrEqual(1);

      // Still refused later in the window; allowed again after it.
      clock += 10_000;
      expect((await call(srv.url, "POST", "/api/demo")).status).toBe(429);
      clock += RESET_WINDOW_MS;
      const afterWindow = await call(srv.url, "POST", "/api/demo");
      expect(afterWindow.status).toBe(201);
      createdDemoIds.add(afterWindow.body.workspaceId);
    } finally {
      await srv.close();
    }
  });

  it("the global cap answers 503 with a clear code and creates nothing; concurrent creates cannot pass the cap", async () => {
    const active = await activeDemoCount();
    const capped = createApp({ rateLimits: { enabled: false }, metrics: { token: null }, demo: { enabled: true, maxActive: active } });
    const srv = await listen(capped);
    try {
      const refused = await call(srv.url, "POST", "/api/demo");
      expect(refused.status).toBe(503);
      expect(refused.body.code).toBe("DEMO_CAPACITY_REACHED");
      expect(refused.body.category).toBe("unavailable");
      expect(refused.body.retryable).toBe(true);
      expect(refused.headers.get("cache-control")).toBe("no-store");
      expect(await activeDemoCount()).toBe(active);
    } finally {
      await srv.close();
    }

    // Three creates at once against room for one: exactly one succeeds.
    const room = createApp({ rateLimits: { enabled: false }, metrics: { token: null }, demo: { enabled: true, maxActive: active + 1 } });
    const roomSrv = await listen(room);
    try {
      const replies = await Promise.all([1, 2, 3].map(() => call(roomSrv.url, "POST", "/api/demo")));
      const statuses = replies.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 503, 503]);
      for (const r of replies.filter((x) => x.status === 201)) createdDemoIds.add(r.body.workspaceId);
      expect(await activeDemoCount()).toBe(active + 1);
    } finally {
      await roomSrv.close();
    }
  }, 120_000);

  it("with demos switched off, creating and resetting answer 404 DEMO_DISABLED and create nothing", async () => {
    const off = createApp({ rateLimits: { enabled: false }, metrics: { token: null }, demo: { enabled: false } });
    const srv = await listen(off);
    try {
      const before = await activeDemoCount();
      const create = await call(srv.url, "POST", "/api/demo");
      expect(create.status).toBe(404);
      expect(create.body.code).toBe("DEMO_DISABLED");
      expect(create.headers.get("cache-control")).toBe("no-store");

      const reset = await call(srv.url, "POST", `/api/workspaces/${WS_REAL}/demo/reset`, { token: realOwner.token });
      expect(reset.status).toBe(404);
      expect(reset.body.code).toBe("DEMO_DISABLED");
      expect(await activeDemoCount()).toBe(before);
    } finally {
      await srv.close();
    }
  });

  it("a demo token cannot reach another workspace, and another demo's owner cannot reset a demo it does not own", async () => {
    const mine = await createDemo(server.url);
    const theirs = await createDemo(server.url);

    const crossRead = await call(server.url, "GET", `/api/workspaces/${theirs.workspaceId}/inventory`, { token: mine.token });
    expect(crossRead.status).toBe(404);
    const crossWrite = await call(server.url, "POST", `/api/workspaces/${theirs.workspaceId}/replenish`, {
      token: mine.token,
      body: { sku: FLOUR },
    });
    expect(crossWrite.status).toBe(404);
    const crossReset = await call(server.url, "POST", `/api/workspaces/${theirs.workspaceId}/demo/reset`, { token: mine.token });
    expect(crossReset.status).toBe(404);
    const realWithDemo = await call(server.url, "GET", `/api/workspaces/${WS_REAL}/approvals`, { token: mine.token });
    expect(realWithDemo.status).toBe(404);
    const stillTheirs = await call(server.url, "GET", `/api/workspaces/${theirs.workspaceId}`, { token: theirs.token });
    expect(stillTheirs.status).toBe(200);
  });

  it("a seed that fails still leaves a working demo, logs the failure, and writes no record for it", async () => {
    setLogSink((line) => {
      logLines.push(line);
    });
    vi.spyOn(ProcurementWorkflowRunner.prototype, "startReplenishment").mockRejectedValueOnce(
      new Error("simulated supplier outage during seed")
    );
    const demo = await createDemo(server.url);

    // The demo exists and its owner token works.
    const detail = await call(server.url, "GET", `/api/workspaces/${demo.workspaceId}`, { token: demo.token });
    expect(detail.status).toBe(200);
    // The failure is logged, with its message.
    const failed = logLines.map((line) => JSON.parse(line)).find((entry) => entry.event === "demo.seed_failed");
    expect(failed, logLines.join("\n")).toBeDefined();
    expect(failed.workspaceId).toBe(demo.workspaceId);
    expect(failed.error).toContain("simulated supplier outage");
    // Nothing was recorded as if the replenishment had run.
    expect(await countRows("workflows", demo.workspaceId)).toBe(0);
    expect(await countRows("approvals", demo.workspaceId)).toBe(0);
  });
});
