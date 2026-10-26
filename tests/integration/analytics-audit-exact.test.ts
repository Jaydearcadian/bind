import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { createAnalyticsAccount, syncAccount, setAnalyticsProviderForTests } from "../../src/analytics/service.js";
import type { ProviderPost } from "../../src/analytics/types.js";

const T0 = new Date("2026-11-04T10:00:00Z");
const MIN = 60_000;
const run = Date.now();
const ws = `ws-probe-${run}`;
let accountId = "";
let reach = 100;
const posts = (): ProviderPost[] =>
  [1, 2, 3, 4, 5].map((i) => ({
    externalId: `p${i}`,
    publishedAt: new Date(T0.getTime() - i * 86_400_000),
    mediaType: "image" as ProviderPost["mediaType"],
    metrics: { reach: i === 3 ? reach : 100, impressions: 120, likes: 3, comments: 1, saves: 1, shares: 0 },
  }));
async function audits() {
  const r = await query<{ evidence: any }>(`SELECT evidence FROM audit_logs WHERE workspace_id=$1 AND action='analytics.synced' ORDER BY created_at, id;`, [ws]);
  return r.rows.map((x) => x.evidence);
}
beforeAll(async () => {
  await runMigrations();
  await provisionWorkspace(ws, "Probe", "social-v1");
  accountId = (await createAnalyticsAccount(ws, { provider: "simulated", brandLabel: "B" }, { type: "owner", id: "o" })).id;
  setAnalyticsProviderForTests((a) => (a.provider === "simulated" ? { id: "simulated", isSimulated: true, fetchPosts: async () => posts() } as any : null));
});
afterAll(async () => { setAnalyticsProviderForTests(null); await query(`DELETE FROM workspaces WHERE id=$1`, [ws]); await closePool(); });

describe("precise audit rule", () => {
  it("first sync exactly 1 row; no-change resync 0 more; one changed post exactly 1 more", async () => {
    const a = await syncAccount(ws, accountId, { type: "owner", id: "o" }, T0);
    expect(a).toMatchObject({ posts: 5, inserted: 5, updated: 0 });
    expect(await audits()).toEqual([{ accountId, status: "synced", posts: 5, inserted: 5, updated: 0 }]);
    const b = await syncAccount(ws, accountId, { type: "owner", id: "o" }, new Date(T0.getTime() + 6 * MIN));
    console.log("RESYNC result", JSON.stringify(b));
    expect((await audits()).length).toBe(1);
    const st = await query<any>(`SELECT last_sync_attempt_at, last_sync_at, consecutive_failures FROM analytics_accounts WHERE workspace_id=$1 AND id=$2`, [ws, accountId]);
    console.log("ACCOUNT after no-change resync", JSON.stringify(st.rows[0]));
    expect(new Date(st.rows[0].last_sync_attempt_at).toISOString()).toBe(new Date(T0.getTime() + 6 * MIN).toISOString());
    const ps = await query<any>(`SELECT DISTINCT synced_at FROM analytics_posts WHERE workspace_id=$1 AND account_id=$2`, [ws, accountId]);
    expect(ps.rows.map((r) => new Date(r.synced_at).toISOString())).toEqual([new Date(T0.getTime() + 6 * MIN).toISOString()]);
    reach = 110;
    const c = await syncAccount(ws, accountId, { type: "owner", id: "o" }, new Date(T0.getTime() + 12 * MIN));
    console.log("CHANGE result", JSON.stringify(c));
    const rows = await audits();
    console.log("AUDITS", JSON.stringify(rows));
    expect(rows.length).toBe(2);
    const p3 = await query<any>(`SELECT reach FROM analytics_posts WHERE workspace_id=$1 AND external_id='p3'`, [ws]);
    expect(p3.rows[0].reach).toBe(110);
    // xmin churn: dead tuples written by a no-change sync
    const x1 = await query<any>(`SELECT external_id, xmin::text FROM analytics_posts WHERE workspace_id=$1 ORDER BY 1`, [ws]);
    await syncAccount(ws, accountId, { type: "owner", id: "o" }, new Date(T0.getTime() + 18 * MIN));
    const x2 = await query<any>(`SELECT external_id, xmin::text FROM analytics_posts WHERE workspace_id=$1 ORDER BY 1`, [ws]);
    console.log("ROWS REWRITTEN BY NO-CHANGE SYNC:", x1.rows.filter((r, i) => r.xmin !== x2.rows[i].xmin).length, "of", x1.rows.length);
    expect((await audits()).length).toBe(2);
  });
});
