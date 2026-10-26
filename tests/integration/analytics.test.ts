import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { createAnalyticsAccount, generateReport, syncAccount, setAnalyticsProviderForTests } from "../../src/analytics/service.js";
import { createSimulatedProvider } from "../../src/analytics/simulated-provider.js";
import type { FetchPostsRequest, ProviderPost } from "../../src/analytics/types.js";
import { config } from "../../src/config/env.js";
import { AnalyticsReportCreatedSchema, AnalyticsReportSchema, AnalyticsSyncResultSchema, AnalyticsAccountSchema } from "../../src/api/schemas.js";
import { BindClient } from "../../sdk/src/index.js";
import { createBindMcpServer } from "../../mcp/src/server.js";
import { createLogger } from "../../mcp/src/logger.js";

/*
 * Post analytics over the real API, PostgreSQL and tokens (docs/decisions/0091). Nothing is mocked: the provider is the
 * simulated one, which makes no network call. Each test uses its own workspaces, so the shared database never leaks state
 * between tests or runs.
 */

const run = Date.now();
const WS_SOCIAL = `ws-ana-s-${run}`;
const WS_OTHER = `ws-ana-o-${run}`;
const WS_KITCHEN = `ws-ana-k-${run}`;
const WS_DEMO = `ws-ana-d-${run}`;
const WS_CAP = `ws-ana-c-${run}`;
const WS_CONC = `ws-ana-p-${run}`;
const WS_NY = `ws-ana-n-${run}`;
const ALL_WS = [WS_SOCIAL, WS_OTHER, WS_KITCHEN, WS_DEMO, WS_CAP, WS_CONC, WS_NY];
/** The tests run with no minimum gap between syncs; the throttle test sets its own. */
const DEFAULT_MIN_SYNC_INTERVAL_MS = config.BIND_ANALYTICS_MIN_SYNC_INTERVAL_MS;
const BRAND = `Brand Label ${run}`;
const DAY = 86400000;

let baseUrl = "";
let server: Server;
let app: ReturnType<typeof createApp>;
let ownerSocial = "";
let staffSocial = "";
let ownerOther = "";
let ownerKitchen = "";
let ownerDemo = "";
let ownerCap = "";
let accountId = "";

async function api(method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as any };
}

/** Yesterday and the day before, as YYYY-MM-DD: a period that ends by today and is not the default one. */
function day(offset: number): string {
  const d = new Date(Math.floor(Date.now() / DAY) * DAY - offset * DAY);
  return d.toISOString().slice(0, 10);
}

async function ownerTokenFor(workspaceId: string): Promise<string> {
  return (await issueToken(workspaceId, "owner", `owner-${workspaceId.slice(-8)}-${Math.random().toString(36).slice(2, 8)}`)).token;
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const res = await query<{ n: number }>(sql, params);
  return Number(res.rows[0].n);
}

/**
 * The default provider for this file's simulated accounts: the simulator, plus one post on each of the last 30 UTC days. The
 * simulator publishes nothing on about 45% of days, so a seed can leave a whole week empty (about 0.4%), and the tests below ask
 * for periods of the last 30 days. One post a day makes every such period hold data whatever the seed. A test that needs another
 * provider replaces this for its own account and restores it with `setAnalyticsProviderForTests(null)`; the next test restores it.
 */
const DAY_MS = 86_400_000;
function anchorPostsIn(request: FetchPostsRequest): ProviderPost[] {
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const out: ProviderPost[] = [];
  for (let back = 1; back <= 30; back += 1) {
    const at = today - back * DAY_MS + 12 * 3_600_000;
    if (at < request.since.getTime() || at >= request.until.getTime()) continue;
    out.push({
      externalId: `anchor_${back}`,
      publishedAt: new Date(at),
      mediaType: "image" as ProviderPost["mediaType"],
      metrics: { reach: 100, impressions: 120, likes: 3, comments: 1, saves: 1, shares: 0 },
    });
  }
  return out;
}
function useDefaultProvider(): void {
  setAnalyticsProviderForTests((account) => {
    if (account.provider !== "simulated") return null;
    const inner = createSimulatedProvider({ workspaceId: account.workspace_id, accountId: account.id });
    return { ...inner, fetchPosts: async (request) => [...anchorPostsIn(request), ...(await inner.fetchPosts(request))] };
  });
}

beforeEach(() => {
  useDefaultProvider();
});

beforeAll(async () => {
  await runMigrations();
  app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
  await provisionWorkspace(WS_SOCIAL, "Social Brand", "social-v1");
  await provisionWorkspace(WS_OTHER, "Other Brand", "social-v1");
  await provisionWorkspace(WS_KITCHEN, "Kitchen", "kitchen-v1");
  await provisionWorkspace(WS_DEMO, "Demo Brand", "social-v1");
  await provisionWorkspace(WS_CAP, "Cap Brand", "social-v1");
  await provisionWorkspace(WS_CONC, "Concurrent Brand", "social-v1");
  await provisionWorkspace(WS_NY, "New York Brand", "social-v1");
  config.BIND_ANALYTICS_MIN_SYNC_INTERVAL_MS = 0;
  ownerSocial = (await issueToken(WS_SOCIAL, "owner", "owner-social")).token;
  staffSocial = (await issueToken(WS_SOCIAL, "staff", "staff-social")).token;
  ownerOther = (await issueToken(WS_OTHER, "owner", "owner-other")).token;
  ownerKitchen = (await issueToken(WS_KITCHEN, "owner", "owner-kitchen")).token;
  ownerDemo = (await issueToken(WS_DEMO, "owner", "owner-demo")).token;
  ownerCap = (await issueToken(WS_CAP, "owner", "owner-cap")).token;
});

afterAll(async () => {
  config.BIND_ANALYTICS_MIN_SYNC_INTERVAL_MS = DEFAULT_MIN_SYNC_INTERVAL_MS;
  setAnalyticsProviderForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const id of ALL_WS) await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
  await closePool();
});

describe("refusals before anything is read or written", () => {
  it("a workspace with no analytics module reads as empty, and every write is 400 TEMPLATE_HAS_NO_ANALYTICS", async () => {
    expect(await api("GET", `/api/workspaces/${WS_KITCHEN}/analytics/accounts`, ownerKitchen)).toMatchObject({ status: 200, body: [] });
    expect(await api("GET", `/api/workspaces/${WS_KITCHEN}/analytics/reports`, ownerKitchen)).toMatchObject({ status: 200, body: [] });
    expect((await api("GET", `/api/workspaces/${WS_KITCHEN}/analytics/reports/rpt_none`, ownerKitchen)).body.code).toBe("ANALYTICS_REPORT_NOT_FOUND");
    const routes: Array<[string, string, unknown?]> = [
      ["POST", `/api/workspaces/${WS_KITCHEN}/analytics/accounts`, { provider: "simulated", brandLabel: "X" }],
      ["POST", `/api/workspaces/${WS_KITCHEN}/analytics/reports`, { kind: "on_demand" }],
      ["POST", `/api/workspaces/${WS_KITCHEN}/analytics/accounts/ana_none/sync`],
    ];
    for (const [method, path, body] of routes) {
      const res = await api(method, path, ownerKitchen, body);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect(res.body.code, `${method} ${path}`).toBe("TEMPLATE_HAS_NO_ANALYTICS");
    }
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM analytics_accounts WHERE workspace_id = $1;`, [WS_KITCHEN])).toBe(0);
  });

  it("only the simulated provider is accepted: any other provider is 400 ANALYTICS_PROVIDER_NOT_AVAILABLE and nothing is stored", async () => {
    for (const provider of ["instagram", "meta", "SIMULATED", "simulated "]) {
      const res = await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/accounts`, ownerSocial, { provider, brandLabel: "Brand" });
      expect(res.status, provider).toBe(400);
      expect(res.body.code, provider).toBe("ANALYTICS_PROVIDER_NOT_AVAILABLE");
    }
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM analytics_accounts WHERE workspace_id = $1;`, [WS_SOCIAL])).toBe(0);
  });

  it("refuses a malformed body with INVALID_INPUT and an unknown key, and a bad time zone", async () => {
    const path = `/api/workspaces/${WS_SOCIAL}/analytics/accounts`;
    expect((await api("POST", path, ownerSocial, { provider: "simulated" })).body.code).toBe("INVALID_INPUT");
    expect((await api("POST", path, ownerSocial, { provider: "simulated", brandLabel: "" })).body.code).toBe("INVALID_INPUT");
    expect((await api("POST", path, ownerSocial, { provider: "simulated", brandLabel: "Bad\u0007char" })).body.code).toBe("INVALID_INPUT");
    expect((await api("POST", path, ownerSocial, { provider: "simulated", brandLabel: "Brand", timeZone: "Mars/Olympus" })).body.code).toBe("INVALID_INPUT");
    expect((await api("POST", path, ownerSocial, { provider: "simulated", brandLabel: "Brand", caption: "x" })).status).toBe(400);
  });
});

describe("roles and tenancy", () => {
  it("anonymous gets 401; staff can read and cannot write (403)", async () => {
    expect((await api("GET", `/api/workspaces/${WS_SOCIAL}/analytics/accounts`, null)).status).toBe(401);
    expect((await api("GET", `/api/workspaces/${WS_SOCIAL}/analytics/accounts`, staffSocial)).status).toBe(200);
    expect((await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/accounts`, staffSocial, { provider: "simulated", brandLabel: "Brand" })).status).toBe(403);
    expect((await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/reports`, staffSocial, { kind: "on_demand" })).status).toBe(403);
  });

  it("staff get 403 on every write route, and the write leaves no row and no audit row behind", async () => {
    // The target account is made first, by the owner's service, so every count below is taken after it exists.
    const own = await createAnalyticsAccount(WS_SOCIAL, { provider: "simulated", brandLabel: "Staff target" }, { type: "owner", id: "test" });
    const accountsBefore = await countRows(`SELECT COUNT(*)::int AS n FROM analytics_accounts WHERE workspace_id = $1;`, [WS_SOCIAL]);
    const reportsBefore = await countRows(`SELECT COUNT(*)::int AS n FROM analytics_reports WHERE workspace_id = $1;`, [WS_SOCIAL]);
    const auditBefore = await countRows(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action LIKE 'analytics.%';`, [WS_SOCIAL]);
    const writes: Array<[string, string, unknown?]> = [
      ["POST", `/api/workspaces/${WS_SOCIAL}/analytics/accounts`, { provider: "simulated", brandLabel: "Staff brand" }],
      ["POST", `/api/workspaces/${WS_SOCIAL}/analytics/accounts/${own.id}/sync`],
      ["POST", `/api/workspaces/${WS_SOCIAL}/analytics/reports`, { kind: "on_demand" }],
    ];
    for (const [method, path, body] of writes) {
      const res = await api(method, path, staffSocial, body);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM analytics_accounts WHERE workspace_id = $1;`, [WS_SOCIAL])).toBe(accountsBefore);
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM analytics_posts WHERE workspace_id = $1 AND account_id = $2;`, [WS_SOCIAL, own.id])).toBe(0);
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM analytics_reports WHERE workspace_id = $1;`, [WS_SOCIAL])).toBe(reportsBefore);
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action LIKE 'analytics.%';`, [WS_SOCIAL])).toBe(auditBefore);
  });

  it("another workspace's owner gets 404 for this workspace's routes, and cannot name its accounts", async () => {
    const created = await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/accounts`, ownerSocial, { provider: "simulated", brandLabel: BRAND });
    expect(created.status).toBe(201);
    accountId = created.body.id;

    expect((await api("GET", `/api/workspaces/${WS_SOCIAL}/analytics/accounts`, ownerOther)).status).toBe(404);
    expect((await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/accounts/${accountId}/sync`, ownerOther)).status).toBe(404);
    // The other workspace's own path, with this workspace's account id substituted: not found there.
    const substituted = await api("POST", `/api/workspaces/${WS_OTHER}/analytics/accounts/${accountId}/sync`, ownerOther);
    expect(substituted.status).toBe(404);
    expect(substituted.body.code).toBe("ANALYTICS_ACCOUNT_NOT_FOUND");
    // A report of the other workspace, asked for with an account of this one: refused the same way.
    const crossReport = await api("POST", `/api/workspaces/${WS_OTHER}/analytics/reports`, ownerOther, { kind: "on_demand", accountId });
    expect(crossReport.status).toBe(404);
    expect(crossReport.body.code).toBe("ANALYTICS_ACCOUNT_NOT_FOUND");
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM analytics_accounts WHERE workspace_id = $1;`, [WS_OTHER])).toBe(0);
  });

  it("an owner sees the account, with its time zone, the simulated flag and no sync yet", async () => {
    const list = await api("GET", `/api/workspaces/${WS_SOCIAL}/analytics/accounts`, staffSocial);
    expect(list.status).toBe(200);
    const mine = list.body.find((a: { id: string }) => a.id === accountId);
    expect(mine).toEqual(expect.objectContaining({ id: accountId, provider: "simulated", brandLabel: BRAND, timeZone: "UTC", isSimulated: true, status: "active", postCount: 0, lastSyncedAt: null }));
  });

  it("the account creation writes an audit row whose evidence holds ids and the provider name only", async () => {
    const rows = await query(
      `SELECT actor_id, evidence::text AS evidence FROM audit_logs WHERE workspace_id = $1 AND action = 'analytics.account_created' AND evidence->>'accountId' = $2;`,
      [WS_SOCIAL, accountId]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].actor_id).toBe("owner-social");
    expect(JSON.parse(rows.rows[0].evidence)).toEqual({ accountId, kind: "simulated" });
    expect(rows.rows[0].evidence).not.toContain(BRAND);
  });

  it("a demo workspace reads analytics and refuses every change (403 ANALYTICS_DEMO_REFUSED)", async () => {
    const created = await api("POST", `/api/workspaces/${WS_DEMO}/analytics/accounts`, ownerDemo, { provider: "simulated", brandLabel: "Demo" });
    expect(created.status).toBe(201);
    await query(`UPDATE workspaces SET is_demo = TRUE, demo_expires_at = NOW() + INTERVAL '1 day' WHERE id = $1;`, [WS_DEMO]);
    try {
      const demoAccount = created.body.id;
      const write = await api("POST", `/api/workspaces/${WS_DEMO}/analytics/accounts`, ownerDemo, { provider: "simulated", brandLabel: "More" });
      expect(write.status).toBe(403);
      expect(write.body.code).toBe("ANALYTICS_DEMO_REFUSED");
      const sync = await api("POST", `/api/workspaces/${WS_DEMO}/analytics/accounts/${demoAccount}/sync`, ownerDemo);
      expect(sync.status).toBe(403);
      expect(sync.body.code).toBe("ANALYTICS_DEMO_REFUSED");
      const report = await api("POST", `/api/workspaces/${WS_DEMO}/analytics/reports`, ownerDemo, { kind: "on_demand" });
      expect(report.status).toBe(403);
      expect(report.body.code).toBe("ANALYTICS_DEMO_REFUSED");
      expect((await api("GET", `/api/workspaces/${WS_DEMO}/analytics/accounts`, ownerDemo)).status).toBe(200);
    } finally {
      await query(`UPDATE workspaces SET is_demo = FALSE, demo_expires_at = NULL WHERE id = $1;`, [WS_DEMO]);
    }
  });

  it("20 concurrent connects give exactly 10 accounts: the rest are refused with 409 ANALYTICS_ACCOUNT_LIMIT", async () => {
    const concToken = await ownerTokenFor(WS_CONC);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => api("POST", `/api/workspaces/${WS_CONC}/analytics/accounts`, concToken, { provider: "simulated", brandLabel: `Concurrent ${i}` }))
    );
    const created = results.filter((r) => r.status === 201).length;
    const refused = results.filter((r) => r.status === 409 && r.body.code === "ANALYTICS_ACCOUNT_LIMIT").length;
    expect(created).toBe(10);
    expect(refused).toBe(10);
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM analytics_accounts WHERE workspace_id = $1;`, [WS_CONC])).toBe(10);
  });

  it("POST accounts honours Idempotency-Key: a repeat with the same key replays the first account", async () => {
    const key = `acct-key-${run}`;
    const body = { provider: "simulated", brandLabel: "Keyed brand" };
    const token = await ownerTokenFor(WS_NY);
    const first = await api("POST", `/api/workspaces/${WS_NY}/analytics/accounts`, token, body, { "Idempotency-Key": key });
    expect(first.status).toBe(201);
    for (let i = 0; i < 4; i += 1) {
      const again = await api("POST", `/api/workspaces/${WS_NY}/analytics/accounts`, token, body, { "Idempotency-Key": key });
      expect(again.status).toBe(201);
      expect(again.body.id).toBe(first.body.id);
    }
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM analytics_accounts WHERE workspace_id = $1 AND brand_label = 'Keyed brand';`, [WS_NY])).toBe(1);
  });

  it("a workspace holds at most 10 accounts (409 ANALYTICS_ACCOUNT_LIMIT beyond that)", async () => {
    for (let i = 0; i < 10; i += 1) {
      await createAnalyticsAccount(WS_CAP, { provider: "simulated", brandLabel: `Cap ${i}` }, { type: "owner", id: "owner-cap" });
    }
    const res = await api("POST", `/api/workspaces/${WS_CAP}/analytics/accounts`, ownerCap, { provider: "simulated", brandLabel: "Eleventh" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ANALYTICS_ACCOUNT_LIMIT");
  });
});

describe("sync is an idempotent upsert", () => {
  it("syncing twice leaves the stored post count as it was: the second run inserts nothing", async () => {
    const syncedRows = () => countRows(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'analytics.synced';`, [WS_SOCIAL]);
    const auditBefore = await syncedRows();
    const first = await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/accounts/${accountId}/sync`, ownerSocial);
    expect(first.status).toBe(200);
    expect(first.body.simulated).toBe(true);
    // The first sync stored new posts: exactly one audit row. (An at-least check here would let a duplicate row pass.)
    expect((await syncedRows()) - auditBefore).toBe(1);
    expect(first.body.posts).toBeGreaterThan(40);
    expect(first.body.inserted).toBe(first.body.posts);
    expect(first.body.updated).toBe(0);
    const rowsAfterFirst = await countRows(`SELECT COUNT(*)::int AS n FROM analytics_posts WHERE workspace_id = $1 AND account_id = $2;`, [WS_SOCIAL, accountId]);
    expect(rowsAfterFirst).toBe(first.body.posts);

    const second = await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/accounts/${accountId}/sync`, ownerSocial);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ posts: first.body.posts, inserted: 0, updated: first.body.posts });
    // Nothing changed between the two syncs: no new audit row (exactly zero, not 'at most one').
    expect((await syncedRows()) - auditBefore).toBe(1);
    const rowsAfterSecond = await countRows(`SELECT COUNT(*)::int AS n FROM analytics_posts WHERE workspace_id = $1 AND account_id = $2;`, [WS_SOCIAL, accountId]);
    expect(rowsAfterSecond).toBe(rowsAfterFirst);
  });

  it("a later sync updates the stored rows, not only their count: the sync time moves forward", async () => {
    const before = await query<{ latest: Date }>(`SELECT MAX(synced_at) AS latest FROM analytics_posts WHERE workspace_id = $1 AND account_id = $2;`, [WS_SOCIAL, accountId]);
    const later = new Date(Date.now() + 3600_000);
    const result = await syncAccount(WS_SOCIAL, accountId, { type: "owner", id: "test" }, later);
    expect(result.updated).toBeGreaterThan(0);
    const after = await query<{ latest: Date }>(`SELECT MAX(synced_at) AS latest FROM analytics_posts WHERE workspace_id = $1 AND account_id = $2;`, [WS_SOCIAL, accountId]);
    expect(new Date(after.rows[0].latest).getTime()).toBeGreaterThan(new Date(before.rows[0].latest).getTime());
    expect(new Date(after.rows[0].latest).toISOString()).toBe(later.toISOString());
    // The attempt was recorded at a future time; clear it so the next sync of this account is not throttled.
    await query(`UPDATE analytics_accounts SET last_sync_attempt_at = NULL WHERE workspace_id = $1 AND id = $2;`, [WS_SOCIAL, accountId]);
  });

  it("the account lists when it was last synced, and how many posts it holds", async () => {
    const list = await api("GET", `/api/workspaces/${WS_SOCIAL}/analytics/accounts`, ownerSocial);
    const mine = list.body.find((a: { id: string }) => a.id === accountId);
    expect(mine.postCount).toBeGreaterThan(40);
    expect(mine.lastSyncedAt).toEqual(expect.any(String));
  });

  it("the sync audit row holds counts and ids only", async () => {
    const rows = await query(`SELECT evidence::text AS evidence FROM audit_logs WHERE workspace_id = $1 AND action = 'analytics.synced';`, [WS_SOCIAL]);
    // A sync is audited only when it changed a stored post (review S-A), so one real change is one row, and the re-syncs add none.
    expect(rows.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows.rows) {
      const evidence = JSON.parse(row.evidence);
      expect(Object.keys(evidence).sort()).toEqual(["accountId", "inserted", "posts", "status", "updated"]);
      expect(typeof evidence.posts).toBe("number");
      expect(row.evidence).not.toMatch(/caption|comment|text/i);
    }
  });

  it("a repeated request with the same Idempotency-Key is replayed, and runs the sync once", async () => {
    const key = `sync-key-${run}`;
    const before = await countRows(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'analytics.synced';`, [WS_SOCIAL]);
    const a = await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/accounts/${accountId}/sync`, ownerSocial, undefined, { "Idempotency-Key": key });
    const b = await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/accounts/${accountId}/sync`, ownerSocial, undefined, { "Idempotency-Key": key });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // The replay carries its own request id in _meta; the answer itself is the first one.
    const withoutMeta = (body: Record<string, unknown>) => Object.fromEntries(Object.entries(body).filter(([k]) => k !== "_meta"));
    expect(withoutMeta(b.body)).toEqual(withoutMeta(a.body));
    const after = await countRows(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'analytics.synced';`, [WS_SOCIAL]);
    // The sync is audited only when it changes a post, and the posts of this day are already stored, so the replay adds at most
    // one row. The replayed body and the throttle (a second real run would be refused with 429) show it ran once.
    // Run once: one row when it inserted something, none when the stored posts already matched. Never two.
    expect(after - before).toBeLessThanOrEqual(1);
    if (a.body.inserted > 0) expect(after - before).toBe(1);
  });

  it("a provider that is no longer available for a stored account is refused with a typed 400, and nothing changes", async () => {
    const other = await createAnalyticsAccount(WS_SOCIAL, { provider: "simulated", brandLabel: "Stored" }, { type: "owner", id: "owner-social" });
    await query(`UPDATE analytics_accounts SET provider = 'instagram' WHERE workspace_id = $1 AND id = $2;`, [WS_SOCIAL, other.id]);
    const before = await countRows(`SELECT COUNT(*)::int AS n FROM analytics_posts WHERE workspace_id = $1 AND account_id = $2;`, [WS_SOCIAL, other.id]);
    const res = await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/accounts/${other.id}/sync`, ownerSocial);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ANALYTICS_PROVIDER_NOT_AVAILABLE");
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM analytics_posts WHERE workspace_id = $1 AND account_id = $2;`, [WS_SOCIAL, other.id])).toBe(before);
  });

  it("the service sync and an overlapping sync leave the same rows (the posts are a function of the day)", async () => {
    const at = new Date();
    const one = await syncAccount(WS_SOCIAL, accountId, { type: "owner", id: "test" }, at);
    const countA = await countRows(`SELECT COUNT(*)::int AS n FROM analytics_posts WHERE workspace_id = $1 AND account_id = $2;`, [WS_SOCIAL, accountId]);
    const two = await syncAccount(WS_SOCIAL, accountId, { type: "owner", id: "test" }, at);
    expect(two).toMatchObject({ inserted: 0, updated: one.posts });
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM analytics_posts WHERE workspace_id = $1 AND account_id = $2;`, [WS_SOCIAL, accountId])).toBe(countA);
  });
});

describe("reports: once per period", () => {
  it("writes the report for the default period (the last seven full UTC days), with the simulated marking", async () => {
    const res = await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/reports`, ownerSocial, { kind: "on_demand", accountId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: "on_demand", accountId, simulated: true, created: true });
    expect(res.body.text.startsWith("Simulated data:")).toBe(true);
    expect(res.body.text).not.toMatch(/because|due to/i);
    expect(res.body.findings.postCount).toBeGreaterThan(0);
  });

  it("asking again for the same period returns the same report with 200 and created false", async () => {
    const first = await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/reports`, ownerSocial, { kind: "on_demand", accountId });
    const again = await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/reports`, ownerSocial, { kind: "on_demand", accountId });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.id).toBe(first.body.id);
  });

  it("ten concurrent requests for one new period write exactly one report and one audit row", async () => {
    const body = { kind: "on_demand", accountId, periodStart: day(14), periodEnd: day(7) };
    const results = await Promise.all(Array.from({ length: 10 }, () => api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/reports`, ownerSocial, body)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(9);
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    const id = [...ids][0];
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM analytics_reports WHERE workspace_id = $1 AND account_id = $2 AND period_start = $3::date AND period_end = $4::date;`, [WS_SOCIAL, accountId, body.periodStart, body.periodEnd])).toBe(1);
    const audits = await query(`SELECT evidence::text AS evidence FROM audit_logs WHERE workspace_id = $1 AND action = 'analytics.report_generated' AND evidence->>'reportId' = $2;`, [WS_SOCIAL, id]);
    expect(audits.rows).toHaveLength(1);
  });

  it("an all-brands report (no account) is also written once: the NULL account does not defeat the unique key", async () => {
    const body = { kind: "on_demand", periodStart: day(21), periodEnd: day(14) };
    const a = await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/reports`, ownerSocial, body);
    const b = await api("POST", `/api/workspaces/${WS_SOCIAL}/analytics/reports`, ownerSocial, body);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.id).toBe(b.body.id);
    expect(a.body.accountId).toBeNull();
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM analytics_reports WHERE workspace_id = $1 AND account_id IS NULL AND period_start = $2::date;`, [WS_SOCIAL, body.periodStart])).toBe(1);
  });

  it("the period must be whole days, at most 92 days, and end by today; the kind must be on_demand", async () => {
    const path = `/api/workspaces/${WS_SOCIAL}/analytics/reports`;
    expect((await api("POST", path, ownerSocial, { kind: "on_demand", periodStart: day(4) })).body.code).toBe("INVALID_INPUT");
    expect((await api("POST", path, ownerSocial, { kind: "on_demand", periodStart: "2026-02-30", periodEnd: day(1) })).body.code).toBe("INVALID_INPUT");
    expect((await api("POST", path, ownerSocial, { kind: "on_demand", periodStart: day(200), periodEnd: day(1) })).body.code).toBe("INVALID_INPUT");
    expect((await api("POST", path, ownerSocial, { kind: "on_demand", periodStart: day(1), periodEnd: day(-3) })).body.code).toBe("INVALID_INPUT");
    expect((await api("POST", path, ownerSocial, { kind: "weekly" })).status).toBe(400);
    expect((await api("POST", path, ownerSocial, { kind: "on_demand", accountId: "ana_none" })).body.code).toBe("ANALYTICS_ACCOUNT_NOT_FOUND");
  });

  it("the report lists newest first, reads one by id, and refuses another workspace's id with 404", async () => {
    const list = await api("GET", `/api/workspaces/${WS_SOCIAL}/analytics/reports`, staffSocial);
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(3);
    const createdAt = list.body.map((r: any) => new Date(r.createdAt).getTime());
    expect([...createdAt].sort((a, b) => b - a)).toEqual(createdAt);
    const one = await api("GET", `/api/workspaces/${WS_SOCIAL}/analytics/reports/${list.body[0].id}`, staffSocial);
    expect(one.status).toBe(200);
    expect(one.body.id).toBe(list.body[0].id);
    expect((await api("GET", `/api/workspaces/${WS_SOCIAL}/analytics/reports/rpt_missing`, staffSocial)).body.code).toBe("ANALYTICS_REPORT_NOT_FOUND");
    expect((await api("GET", `/api/workspaces/${WS_OTHER}/analytics/reports/${list.body[0].id}`, ownerOther)).status).toBe(404);
  });

  it("a report over a New York account reads its hours in New York time, not UTC", async () => {
    const token = await ownerTokenFor(WS_NY);
    const ny = await api("POST", `/api/workspaces/${WS_NY}/analytics/accounts`, token, { provider: "simulated", brandLabel: "NY", timeZone: "America/New_York" });
    expect(ny.status).toBe(201);
    expect(ny.body.timeZone).toBe("America/New_York");
    const synced = await api("POST", `/api/workspaces/${WS_NY}/analytics/accounts/${ny.body.id}/sync`, token);
    expect(synced.status).toBe(200);
    const report = await api("POST", `/api/workspaces/${WS_NY}/analytics/reports`, token, { kind: "on_demand", accountId: ny.body.id, periodStart: day(20), periodEnd: day(1) });
    expect(report.status).toBe(201);
    expect(report.body.findings.timeZone).toBe("America/New_York");
    expect(report.body.findings.hours.timeZone).toBe("America/New_York");
  });

  it("a report holds no brand label, no account label and no platform text", async () => {
    const list = await api("GET", `/api/workspaces/${WS_SOCIAL}/analytics/reports`, ownerSocial);
    const stored = await query(`SELECT findings::text AS findings, report_text FROM analytics_reports WHERE workspace_id = $1;`, [WS_SOCIAL]);
    for (const row of stored.rows) {
      expect(row.findings).not.toContain(BRAND);
      expect(row.report_text).not.toContain(BRAND);
    }
    expect(JSON.stringify(list.body)).not.toContain(BRAND);
  });

  it("a period with no stored posts is refused with 409 ANALYTICS_NO_DATA_YET, and no empty report is kept for it", async () => {
    const res = await api("POST", `/api/workspaces/${WS_CAP}/analytics/reports`, ownerCap, { kind: "on_demand", periodStart: day(40), periodEnd: day(39) });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ANALYTICS_NO_DATA_YET");
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM analytics_reports WHERE workspace_id = $1 AND period_start = $2::date;`, [WS_CAP, day(40)])).toBe(0);
    // Once the account has posts for the period, the same request writes the report.
    const cap = await api("GET", `/api/workspaces/${WS_CAP}/analytics/accounts`, ownerCap);
    await syncAccount(WS_CAP, cap.body[0].id, { type: "owner", id: "test" }, new Date());
    const later = await api("POST", `/api/workspaces/${WS_CAP}/analytics/reports`, ownerCap, { kind: "on_demand", periodStart: day(21), periodEnd: day(14) });
    expect([200, 201]).toContain(later.status);
  });

  it("the generator refuses a period that ends after today, through the service as well", async () => {
    const now = new Date();
    await expect(
      generateReport(WS_SOCIAL, { accountId: null, kind: "on_demand", periodStart: new Date(now.getTime() - 2 * DAY), periodEnd: new Date(now.getTime() + 2 * DAY) }, { type: "owner", id: "t" }, now)
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("the responses of the routes the contract sweep does not reach match their schemas", () => {
  it("create account, sync, create report and get report parse with the registry's schemas", async () => {
    const token = await ownerTokenFor(WS_NY);
    const created = await api("POST", `/api/workspaces/${WS_NY}/analytics/accounts`, token, { provider: "simulated", brandLabel: "Schema brand" });
    expect(created.status).toBe(201);
    expect(AnalyticsAccountSchema.safeParse(created.body).success).toBe(true);
    const synced = await api("POST", `/api/workspaces/${WS_NY}/analytics/accounts/${created.body.id}/sync`, token);
    expect(synced.status).toBe(200);
    expect(AnalyticsSyncResultSchema.safeParse(synced.body).success).toBe(true);
    const report = await api("POST", `/api/workspaces/${WS_NY}/analytics/reports`, token, { kind: "on_demand", accountId: created.body.id, periodStart: day(20), periodEnd: day(1) });
    expect([200, 201]).toContain(report.status);
    expect(AnalyticsReportCreatedSchema.safeParse(report.body).success).toBe(true);
    const one = await api("GET", `/api/workspaces/${WS_NY}/analytics/reports/${report.body.id}`, token);
    expect(one.status).toBe(200);
    expect(AnalyticsReportSchema.safeParse(one.body).success).toBe(true);
  });
});

describe("sync attempts: the minimum interval, the timeout and the backoff", () => {
  const SAME_DAY = new Date("2026-11-04T10:00:00Z");

  it("a second sync inside the minimum interval is refused with 429 ANALYTICS_SYNC_TOO_SOON and Retry-After; the throttle holds for the API", async () => {
    const token = await ownerTokenFor(WS_OTHER);
    const account = await createAnalyticsAccount(WS_OTHER, { provider: "simulated", brandLabel: "Throttle" }, { type: "owner", id: "test" });
    config.BIND_ANALYTICS_MIN_SYNC_INTERVAL_MS = 300_000;
    try {
      const first = await api("POST", `/api/workspaces/${WS_OTHER}/analytics/accounts/${account.id}/sync`, token);
      expect(first.status).toBe(200);
      const second = await fetch(`${baseUrl}/api/workspaces/${WS_OTHER}/analytics/accounts/${account.id}/sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(second.status).toBe(429);
      expect(((await second.json()) as { code: string }).code).toBe("ANALYTICS_SYNC_TOO_SOON");
      const retryAfter = Number(second.headers.get("retry-after"));
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(300);
    } finally {
      config.BIND_ANALYTICS_MIN_SYNC_INTERVAL_MS = 0;
    }
  });

  it("a provider that hangs is abandoned after the timeout: 502, nothing stored, and the account backs off", async () => {
    const account = await createAnalyticsAccount(WS_OTHER, { provider: "simulated", brandLabel: "Hangs" }, { type: "owner", id: "test" });
    setAnalyticsProviderForTests(
      (acc) =>
        acc.id === account.id
          ? { id: "simulated", isSimulated: true, capabilities: { perPostReach: true, followerSplit: true, hourOfDay: true, country: true, mediaType: true }, listAccounts: async () => [], fetchPosts: () => new Promise(() => undefined) }
          : null,
      200
    );
    const started = Date.now();
    try {
      await expect(syncAccount(WS_OTHER, account.id, { type: "owner", id: "test" }, SAME_DAY)).rejects.toMatchObject({ code: "ANALYTICS_PROVIDER_UNAVAILABLE", status: 502 });
    } finally {
      setAnalyticsProviderForTests(null);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await countRows(`SELECT COUNT(*)::int AS n FROM analytics_posts WHERE workspace_id = $1 AND account_id = $2;`, [WS_OTHER, account.id])).toBe(0);
    const row = await query<{ consecutive_failures: number; next_attempt_at: Date }>(
      `SELECT consecutive_failures, next_attempt_at FROM analytics_accounts WHERE workspace_id = $1 AND id = $2;`,
      [WS_OTHER, account.id]
    );
    expect(row.rows[0].consecutive_failures).toBe(1);
    expect(new Date(row.rows[0].next_attempt_at).getTime()).toBe(SAME_DAY.getTime() + 15 * 60 * 1000);
  });

  it("backoff doubles per failure, capped at 12 hours; a provider that answers invalid data waits the longest at once", async () => {
    const account = await createAnalyticsAccount(WS_OTHER, { provider: "simulated", brandLabel: "Backoff" }, { type: "owner", id: "test" });
    const failing = (mode: "throws" | "invalid") => ({
      id: "simulated",
      isSimulated: true,
      capabilities: { perPostReach: true, followerSplit: true, hourOfDay: true, country: true, mediaType: true },
      listAccounts: async () => [],
      fetchPosts: async () => {
        if (mode === "throws") throw new Error("upstream said no");
        return [{ externalId: "bad id with spaces", publishedAt: "x", mediaType: "reel", metrics: {} }] as unknown as never;
      },
    });
    setAnalyticsProviderForTests((acc) => (acc.id === account.id ? failing("throws") : null), 1000);
    const offsets: number[] = [];
    try {
      for (let i = 0; i < 3; i += 1) {
        const at = new Date(SAME_DAY.getTime() + i * 13 * 3600 * 1000);
        await expect(syncAccount(WS_OTHER, account.id, { type: "owner", id: "test" }, at)).rejects.toMatchObject({ code: "ANALYTICS_PROVIDER_UNAVAILABLE" });
        const row = await query<{ next_attempt_at: Date }>(`SELECT next_attempt_at FROM analytics_accounts WHERE workspace_id = $1 AND id = $2;`, [WS_OTHER, account.id]);
        offsets.push((new Date(row.rows[0].next_attempt_at).getTime() - at.getTime()) / 1000);
      }
    } finally {
      setAnalyticsProviderForTests(null);
    }
    expect(offsets).toEqual([15 * 60, 30 * 60, 60 * 60]);

    setAnalyticsProviderForTests((acc) => (acc.id === account.id ? failing("invalid") : null), 1000);
    const invalidAt = new Date(SAME_DAY.getTime() + 2 * 24 * 3600 * 1000);
    try {
      await expect(syncAccount(WS_OTHER, account.id, { type: "owner", id: "test" }, invalidAt)).rejects.toMatchObject({ code: "ANALYTICS_PROVIDER_OUTPUT_INVALID" });
    } finally {
      setAnalyticsProviderForTests(null);
    }
    const slow = await query<{ next_attempt_at: Date; consecutive_failures: number }>(
      `SELECT next_attempt_at, consecutive_failures FROM analytics_accounts WHERE workspace_id = $1 AND id = $2;`,
      [WS_OTHER, account.id]
    );
    expect(slow.rows[0].consecutive_failures).toBe(4);
    expect((new Date(slow.rows[0].next_attempt_at).getTime() - invalidAt.getTime()) / 1000).toBe(12 * 3600);
  });

  it("a good sync after failures resets the backoff and writes exactly one analytics.synced row for that sync", async () => {
    const account = await createAnalyticsAccount(WS_OTHER, { provider: "simulated", brandLabel: "Recovers" }, { type: "owner", id: "test" });
    setAnalyticsProviderForTests((acc) => (acc.id === account.id ? { id: "simulated", isSimulated: true, capabilities: { perPostReach: true, followerSplit: true, hourOfDay: true, country: true, mediaType: true }, listAccounts: async () => [], fetchPosts: async () => { throw new Error("down"); } } : null), 1000);
    try {
      await expect(syncAccount(WS_OTHER, account.id, { type: "owner", id: "test" }, SAME_DAY)).rejects.toThrow();
    } finally {
      setAnalyticsProviderForTests(null);
    }
    const before = await countRows(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'analytics.synced' AND evidence->>'accountId' = $2;`, [WS_OTHER, account.id]);
    const later = new Date(SAME_DAY.getTime() + 3 * 24 * 3600 * 1000);
    await syncAccount(WS_OTHER, account.id, { type: "owner", id: "test" }, later);
    const after = await countRows(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'analytics.synced' AND evidence->>'accountId' = $2;`, [WS_OTHER, account.id]);
    expect(after - before).toBe(1);
    const row = await query<{ consecutive_failures: number; next_attempt_at: Date | null }>(`SELECT consecutive_failures, next_attempt_at FROM analytics_accounts WHERE workspace_id = $1 AND id = $2;`, [WS_OTHER, account.id]);
    expect(row.rows[0].consecutive_failures).toBe(0);
    expect(row.rows[0].next_attempt_at).toBeNull();
  });
});

describe("events and the MCP read tools", () => {
  it("the analytics events are visible to staff (member visibility)", async () => {
    const res = await api("GET", `/api/workspaces/${WS_SOCIAL}/events/poll?limit=200`, staffSocial);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain("analytics.synced");
    expect(JSON.stringify(res.body)).toContain("analytics.report_generated");
    expect(JSON.stringify(res.body)).not.toContain(BRAND);
  });

  it("the MCP tools list and get the reports through the staff key, and writing no audit row", async () => {
    const sdk = new BindClient({ baseUrl, token: staffSocial, timeoutMs: 10_000 });
    const mcp = createBindMcpServer({ client: sdk, workspaceId: WS_SOCIAL, log: createLogger({ secrets: [staffSocial], write: () => undefined }), secrets: [staffSocial] });
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await mcp.connect(serverSide);
    const client = new Client({ name: "analytics-test", version: "0.0.0" });
    await client.connect(clientSide);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["list_analytics_reports", "get_analytics_report"]));
      const auditBefore = await countRows(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1;`, [WS_SOCIAL]);
      const listed = (await client.callTool({ name: "list_analytics_reports", arguments: {} })) as CallToolResult;
      expect(listed.isError).not.toBe(true);
      const listedBody = JSON.parse((listed.content[0] as { text: string }).text) as { data: Array<{ id: string }> };
      expect(listedBody.data.length).toBeGreaterThan(0);
      const got = (await client.callTool({ name: "get_analytics_report", arguments: { reportId: listedBody.data[0].id } })) as CallToolResult;
      expect(got.isError).not.toBe(true);
      const gotBody = JSON.parse((got.content[0] as { text: string }).text) as { data: { id: string } };
      expect(gotBody.data.id).toBe(listedBody.data[0].id);
      const auditAfter = await countRows(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1;`, [WS_SOCIAL]);
      expect(auditAfter).toBe(auditBefore);
      // An id from another workspace is a 404 through the tool too.
      const refused = (await client.callTool({ name: "get_analytics_report", arguments: { reportId: "rpt_not_here" } })) as CallToolResult;
      expect(refused.isError).toBe(true);
    } finally {
      await client.close();
      await mcp.close();
    }
  });
});
