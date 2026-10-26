import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { config } from "../../src/config/env.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { notificationEmitter } from "../../src/adapters/web2/notifications.js";
import { upsertSurfaceBinding } from "../../src/adapters/socialSurface.js";
import { requestOwnerEmailVerification, verifyOwnerEmail } from "../../src/notifications/owner-emails.js";
import { setEffectFault } from "../../src/effects/faults.js";
import { runTick, ANALYTICS_PASS_DEADLINE_MS } from "../../src/workers/runner.js";
import { workerOptionsFromEnv } from "../../src/workers/options.js";
import {
  createAnalyticsAccount,
  deliverReportNotice,
  generateReport,
  MAX_NOTICE_ATTEMPTS,
  runWeeklyAnalyticsReports,
  setAnalyticsProviderForTests,
  syncAccount,
  SYSTEM_ACTOR,
  upsertArrays,
} from "../../src/analytics/service.js";
import { createSimulatedProvider } from "../../src/analytics/simulated-provider.js";
import type { PostAnalyticsProvider, ProviderPost } from "../../src/analytics/types.js";
import { startFakeResend, codeIn, type FakeResend } from "../helpers/fake-resend.js";

/*
 * Analytics reports and the owner's notice (docs/decisions/0091, ADR 0017, ADR 0074), against a local fake email provider.
 * The notice is at most once per (workspace, report, recipient): a replay, a concurrent call, a crash before the notice, and a
 * crash during the send are each tested. The weekly job is tested for its bounds, its isolation, its backoff and its replay.
 *
 * The suite shares one database with every other integration file, and the tests here run the weekly job at a fixed clock. So
 * every pass is scoped to the workspaces this file made (`workspaceIds`), and the worker tick uses the real clock, so nothing
 * here can expire another file's rows (review S-C).
 */

const run = Date.now();
const NOTICE_SUBJECT = "Something is waiting for you in Bind";
/** A fixed instant in the week after 26 October 2026: the period is Monday 26 October to Monday 2 November 2026. */
const NOW = new Date("2026-11-04T10:00:00Z");
const PERIOD_START = new Date("2026-10-26T00:00:00Z");
const PERIOD_END = new Date("2026-11-02T00:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const SYNC_ACTOR = { type: "owner" as const, id: "owner-notices" };
const wsIds: string[] = [];
let counter = 0;
let fake: FakeResend;

const saved = {
  provider: config.BIND_EMAIL_PROVIDER,
  key: config.BIND_EMAIL_API_KEY,
  from: config.BIND_EMAIL_FROM,
  base: config.BIND_EMAIL_API_BASE,
};

function enableEmail(): void {
  config.BIND_EMAIL_PROVIDER = "resend";
  config.BIND_EMAIL_API_KEY = "re_analytics_test_key_0123456789";
  config.BIND_EMAIL_FROM = "Bind <notices@example.test>";
  config.BIND_EMAIL_API_BASE = fake.baseUrl;
}

function disableEmail(): void {
  config.BIND_EMAIL_PROVIDER = undefined;
  config.BIND_EMAIL_API_KEY = undefined;
  config.BIND_EMAIL_FROM = undefined;
  config.BIND_EMAIL_API_BASE = undefined;
}

beforeAll(async () => {
  await runMigrations();
  fake = await startFakeResend();
});

beforeEach(() => {
  fake.received.length = 0;
  fake.status = 200;
  fake.delayMs = 0;
  fake.rawBody = null;
  notificationEmitter.clear();
  enableEmail();
  useDefaultProvider();
});

afterEach(() => {
  setAnalyticsProviderForTests(null);
});

/** A post inside the test period (26 October to 2 November 2026), whatever the simulator gives for an account's seed. */
const ANCHOR_POST: ProviderPost = {
  externalId: "anchor_post",
  publishedAt: new Date("2026-10-28T12:00:00Z"),
  mediaType: "image" as ProviderPost["mediaType"],
  metrics: { reach: 100, impressions: 120, likes: 3, comments: 1, saves: 1, shares: 0 },
};

/**
 * The default provider for this file's simulated accounts: the simulator, plus one post inside the test period. The simulator
 * publishes nothing on about 45% of days, so a seed can have no posts for a whole week (about 0.4%). Then the report has no data
 * and never reaches the insert the tests rely on. Anchoring the period makes every report's data independent of the seed.
 * A test that needs another provider replaces this for its own account.
 */
function useDefaultProvider(): void {
  setAnalyticsProviderForTests((account) => {
    if (account.provider !== "simulated") return null;
    const inner = createSimulatedProvider({ workspaceId: account.workspace_id, accountId: account.id });
    return { ...inner, fetchPosts: async (request) => [ANCHOR_POST, ...(await inner.fetchPosts(request))] };
  });
}

afterAll(async () => {
  config.BIND_EMAIL_PROVIDER = saved.provider;
  config.BIND_EMAIL_API_KEY = saved.key;
  config.BIND_EMAIL_FROM = saved.from;
  config.BIND_EMAIL_API_BASE = saved.base;
  setEffectFault(null);
  setAnalyticsProviderForTests(null);
  await fake.close();
  for (const id of wsIds.splice(0)) await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
  await closePool();
});

/** A fresh social workspace with one analytics account, synced at NOW. Each test decides what else it has. */
async function socialWorkspace(): Promise<{ wsId: string; accountId: string }> {
  const made = await workspaceWithAccount();
  await syncAccount(made.wsId, made.accountId, SYNC_ACTOR, NOW);
  return made;
}

/** A fresh social workspace with one analytics account that has never been synced. */
async function workspaceWithAccount(): Promise<{ wsId: string; accountId: string }> {
  counter += 1;
  const wsId = `ws-ann-${run}-${counter}`;
  wsIds.push(wsId);
  await provisionWorkspace(wsId, "Notice Brand", "social-v1");
  const account = await createAnalyticsAccount(wsId, { provider: "simulated", brandLabel: "Brand" }, SYNC_ACTOR);
  return { wsId, accountId: account.id };
}

/** One pass of the weekly job, scoped to the given workspaces. */
function pass(workspaceIds: string[], batchSize = 1000, now: Date = NOW) {
  return runWeeklyAnalyticsReports({ now, batchSize, workspaceIds });
}

/** Verifies an owner address through the real service; the code comes from the fake provider's email. */
async function verifiedOwner(wsId: string, address: string): Promise<void> {
  const requested = await requestOwnerEmailVerification(wsId, address, "owner-notices");
  const sent = fake.received.at(-1);
  if (!sent) throw new Error("no verification email was sent");
  const verified = await verifyOwnerEmail(wsId, requested.id, codeIn(sent), "owner-notices");
  expect(verified.status).toBe("verified");
}

/** The report notices the fake provider received for one address. */
function noticesTo(address: string) {
  return fake.received.filter((r) => r.body?.subject === NOTICE_SUBJECT && (r.body?.to ?? []).includes(address));
}

async function ledgerRows(key: string): Promise<Array<{ status: string }>> {
  const res = await query<{ status: string }>(`SELECT status FROM effects WHERE idempotency_key = $1;`, [key]);
  return res.rows;
}

async function weeklyReportsFor(wsId: string): Promise<number> {
  const res = await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM analytics_reports WHERE workspace_id = $1 AND kind = 'weekly' AND period_start = $2::date AND period_end = $3::date;`,
    [wsId, "2026-10-26", "2026-11-02"]
  );
  return Number(res.rows[0].n);
}

async function auditCount(wsId: string, action: string): Promise<number> {
  const res = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = $2;`, [wsId, action]);
  return Number(res.rows[0].n);
}

/**
 * Makes an insert into `table` fail for the rows the condition names, until the returned function is called. A database-level
 * fixture: the service sees a real database error, not a stub. Each call uses its own function and trigger name.
 */
async function refuseInserts(table: "analytics_reports" | "effects", condition: string, name: string): Promise<() => Promise<void>> {
  await query(`CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused by test fixture'; END $$;`);
  await query(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION ${name}();`);
  return async () => {
    await query(`DROP TRIGGER IF EXISTS ${name} ON ${table};`);
    await query(`DROP FUNCTION IF EXISTS ${name}();`);
  };
}

describe("the owner's notice: at most once, naming nothing", () => {
  it("a verified owner is emailed once for a report; a second delivery sends nothing and says it was already attempted", async () => {
    const { wsId, accountId } = await socialWorkspace();
    const address = `owner.once.${run}@notices.example.test`;
    await verifiedOwner(wsId, address);
    const generated = await generateReport(wsId, { accountId, kind: "weekly", periodStart: PERIOD_START, periodEnd: PERIOD_END }, SYSTEM_ACTOR, NOW);
    expect(generated.created).toBe(true);

    const first = await deliverReportNotice(wsId, generated.report.id);
    expect(first).toMatchObject({ recipients: 1, sent: 1, alreadySent: 0 });
    const second = await deliverReportNotice(wsId, generated.report.id);
    expect(second).toMatchObject({ recipients: 1, sent: 0, alreadySent: 1 });

    const sent = noticesTo(address);
    expect(sent).toHaveLength(1);
    const text = sent[0].body?.text ?? "";
    // The account is simulated, so the notice says the report is sample data (review S5).
    expect(text).toContain("Your report is ready (sample data).");
    expect(text).toContain("/app/");
    // The notice names no finding, no figure, no brand and no account.
    expect(text).not.toMatch(/%|median|reach|engagement|Brand|Simulated|posts/i);
    expect(await ledgerRows(`${wsId}:notify:analytics_report:${generated.report.id}`)).toEqual([{ status: "completed" }]);
  });

  it("ten concurrent deliveries for one report send one email", async () => {
    const { wsId, accountId } = await socialWorkspace();
    const address = `owner.race.${run}@notices.example.test`;
    await verifiedOwner(wsId, address);
    const generated = await generateReport(wsId, { accountId, kind: "weekly", periodStart: PERIOD_START, periodEnd: PERIOD_END }, SYSTEM_ACTOR, NOW);
    await Promise.all(Array.from({ length: 10 }, () => deliverReportNotice(wsId, generated.report.id)));
    expect(noticesTo(address)).toHaveLength(1);
    expect(await ledgerRows(`${wsId}:notify:analytics_report:${generated.report.id}`)).toHaveLength(1);
  });

  it("with email delivery off, the notice is recorded as simulated for the owner's binding, and nothing leaves the server", async () => {
    counter += 1;
    const wsId = `ws-ann-${run}-${counter}`;
    wsIds.push(wsId);
    await provisionWorkspace(wsId, "Sim Brand", "social-v1");
    await upsertSurfaceBinding(wsId, { surface: "email", actorId: `owner.sim.${run}@notices.example.test`, actorRole: "owner" }, SYNC_ACTOR);
    const account = await createAnalyticsAccount(wsId, { provider: "simulated", brandLabel: "Sim" }, SYNC_ACTOR);
    await syncAccount(wsId, account.id, SYNC_ACTOR, NOW);
    const generated = await generateReport(wsId, { accountId: account.id, kind: "weekly", periodStart: PERIOD_START, periodEnd: PERIOD_END }, SYSTEM_ACTOR, NOW);
    disableEmail();
    const outcome = await deliverReportNotice(wsId, generated.report.id);
    expect(outcome).toMatchObject({ recipients: 1, sent: 1 });
    expect(fake.received).toHaveLength(0);
    const recorded = notificationEmitter.getSentNotifications("email");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ title: "Your report is ready (sample data).", message: "Your report is ready (sample data). Open Bind to read it." });
    expect(JSON.stringify(recorded[0])).not.toMatch(/%|median|reach/i);
  });

  it("a workspace with no owner contact is told nothing and records nothing", async () => {
    const { wsId, accountId } = await socialWorkspace();
    const generated = await generateReport(wsId, { accountId, kind: "weekly", periodStart: PERIOD_START, periodEnd: PERIOD_END }, SYSTEM_ACTOR, NOW);
    const outcome = await deliverReportNotice(wsId, generated.report.id);
    expect(outcome).toMatchObject({ recipients: 0, sent: 0 });
    expect(await ledgerRows(`${wsId}:notify:analytics_report:${generated.report.id}`)).toEqual([]);
    expect(fake.received).toHaveLength(0);
  });
});

describe("crash safety", () => {
  it("a crash after the report is written and before the notice: the replay sends it once, and a second replay sends nothing", async () => {
    const { wsId, accountId } = await socialWorkspace();
    const address = `owner.replay.${run}@notices.example.test`;
    await verifiedOwner(wsId, address);
    // The report is written, then the process "dies" before any notice is sent.
    await generateReport(wsId, { accountId, kind: "weekly", periodStart: PERIOD_START, periodEnd: PERIOD_END }, SYSTEM_ACTOR, NOW);
    expect(noticesTo(address)).toHaveLength(0);

    const replay = await pass([wsId]);
    expect(replay.errors).toEqual([]);
    expect(noticesTo(address)).toHaveLength(1);
    const again = await pass([wsId]);
    expect(again.errors).toEqual([]);
    expect(noticesTo(address)).toHaveLength(1);
    expect(await weeklyReportsFor(wsId)).toBe(1);
  });

  it("a crash during the send, after the provider accepted the message: the notice is in doubt and is never sent again", async () => {
    const { wsId, accountId } = await socialWorkspace();
    const address = `owner.doubt.${run}@notices.example.test`;
    await verifiedOwner(wsId, address);
    const generated = await generateReport(wsId, { accountId, kind: "weekly", periodStart: PERIOD_START, periodEnd: PERIOD_END }, SYSTEM_ACTOR, NOW);
    const key = `${wsId}:notify:analytics_report:${generated.report.id}`;
    // The send reaches the provider, and the process dies before the ledger records it.
    setEffectFault({ point: "after_call_before_complete", match: (spec) => spec.idempotencyKey === key });
    const first = await deliverReportNotice(wsId, generated.report.id);
    // The injected crash is thrown after the provider answered: the ledger row is left started, so the outcome is unknown.
    // That is in doubt, not a refusal, and it is audited at once.
    expect(first).toMatchObject({ sent: 0, inDoubt: 1 });
    expect(await auditCount(wsId, "notification.in_doubt")).toBe(1);
    expect(noticesTo(address)).toHaveLength(1);
    expect(await ledgerRows(key)).toEqual([{ status: "started" }]);

    // The next delivery finds the started row: it is reported in doubt and audited, and nothing is sent.
    // A later delivery finds the row recorded: nothing is sent, and nothing is audited a second time.
    const second = await deliverReportNotice(wsId, generated.report.id);
    expect(second).toMatchObject({ sent: 0, alreadyRecorded: 1, inDoubt: 0 });
    expect(noticesTo(address)).toHaveLength(1);
    expect(await auditCount(wsId, "notification.in_doubt")).toBe(1);
  });

  it("a send the provider refuses is recorded as failed, and is not retried by the next delivery", async () => {
    const { wsId, accountId } = await socialWorkspace();
    const address = `owner.refused.${run}@notices.example.test`;
    await verifiedOwner(wsId, address);
    const generated = await generateReport(wsId, { accountId, kind: "weekly", periodStart: PERIOD_START, periodEnd: PERIOD_END }, SYSTEM_ACTOR, NOW);
    fake.status = 500;
    const first = await deliverReportNotice(wsId, generated.report.id);
    expect(first).toMatchObject({ sent: 0, failed: 1 });
    fake.status = 200;
    const second = await deliverReportNotice(wsId, generated.report.id);
    expect(second).toMatchObject({ sent: 0, alreadyRecorded: 1 });
    // The provider saw one request (the refused one) and no later one.
    expect(noticesTo(address)).toHaveLength(1);
  });
});

describe("the weekly job: bounded, isolated, and replay-safe", () => {
  it("the worker does nothing with analytics unless it is switched on", async () => {
    const { wsId } = await workspaceWithAccount();
    // The real clock: the tick's other steps run against the shared database, so they are never run at the fixture's clock.
    const off = await runTick({});
    expect(off.analyticsReports.skipped).toBe(true);
    expect(await weeklyReportsFor(wsId)).toBe(0);
    const reports = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM analytics_reports WHERE workspace_id = $1;`, [wsId]);
    expect(Number(reports.rows[0].n)).toBe(0);
  });

  it("with the job on, a broken account is counted and the others still run; a replay does nothing new", async () => {
    const good = await socialWorkspace();
    const broken = await socialWorkspace();
    // The account was synced a moment ago, so it is throttled; clear its attempt time so the pass attempts it and it fails.
    await query(`UPDATE analytics_accounts SET provider = 'instagram', last_sync_attempt_at = NULL WHERE workspace_id = $1;`, [broken.wsId]);
    const scope = [good.wsId, broken.wsId];
    const first = await pass(scope);
    expect(first.failed).toBeGreaterThanOrEqual(1);
    expect(first.errors).toContain("ANALYTICS_PROVIDER_NOT_AVAILABLE");
    expect(await weeklyReportsFor(good.wsId)).toBe(1);
    expect(await weeklyReportsFor(broken.wsId)).toBe(0);
    const before = await query(`SELECT COUNT(*)::int AS n FROM analytics_reports WHERE workspace_id = $1;`, [good.wsId]);
    await pass(scope);
    const after = await query(`SELECT COUNT(*)::int AS n FROM analytics_reports WHERE workspace_id = $1;`, [good.wsId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("a disabled account is not synced by the job, and a demo workspace is not touched", async () => {
    const disabled = await socialWorkspace();
    await query(`UPDATE analytics_accounts SET status = 'disabled' WHERE workspace_id = $1;`, [disabled.wsId]);
    const demo = await socialWorkspace();
    await query(`UPDATE workspaces SET is_demo = TRUE, demo_expires_at = NOW() + INTERVAL '1 day' WHERE id = $1;`, [demo.wsId]);
    const scope = [disabled.wsId, demo.wsId];
    const outcome = await pass(scope);
    // Neither account is selected, so neither is attempted and nothing fails for them (review W/X).
    expect(outcome.failed).toBe(0);
    expect(await weeklyReportsFor(disabled.wsId)).toBe(0);
    expect(await weeklyReportsFor(demo.wsId)).toBe(0);
    await expect(syncAccount(disabled.wsId, disabled.accountId, SYNC_ACTOR, NOW)).rejects.toMatchObject({ code: "ANALYTICS_ACCOUNT_DISABLED" });
  });

  it("the job's sync step is bounded by its batch size", async () => {
    const a = await workspaceWithAccount();
    const b = await workspaceWithAccount();
    const outcome = await pass([a.wsId, b.wsId], 1);
    // One account is taken, not both: it is synced and its report written, and the other waits for the next pass.
    expect(outcome.synced + outcome.skippedRecentSync).toBe(1);
    expect(outcome.reports).toBe(1);
    expect((await weeklyReportsFor(a.wsId)) + (await weeklyReportsFor(b.wsId))).toBe(1);
  });

  it("the worker runs the job, and reports it, when BIND_ANALYTICS_REPORTS is on", async () => {
    const { wsId } = await workspaceWithAccount();
    // The options come from the same function the entry point uses, so the environment decides the job, as in production.
    const on = await runTick({ ...workerOptionsFromEnv({ BIND_ANALYTICS_REPORTS: "true" }), analyticsWorkspaceIds: [wsId] });
    expect(on.analyticsReports.skipped).toBe(false);
    expect(on.analyticsReports.failed).toBe(0);
    expect(on.analyticsReports.reports).toBe(1);
    const reports = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM analytics_reports WHERE workspace_id = $1 AND kind = 'weekly';`, [wsId]);
    expect(Number(reports.rows[0].n)).toBe(1);
  });
});

describe("the weekly job reports what it could not do (review B1, S2)", () => {
  it("a send that started and then lost its outcome is audited as in doubt by the worker, and is not sent again", async () => {
    const { wsId } = await socialWorkspace();
    const address = `owner.wdoubt.${run}@notices.example.test`;
    await verifiedOwner(wsId, address);
    const key = (): string => `${wsId}:notify:analytics_report:`;
    setEffectFault({ point: "after_call_before_complete", match: (spec) => spec.idempotencyKey.startsWith(key()) });
    const first = await pass([wsId]);
    expect(noticesTo(address)).toHaveLength(1);
    const rows = await ledgerRows(`${wsId}:notify:analytics_report:${(await query<{ id: string }>(`SELECT id FROM analytics_reports WHERE workspace_id = $1 AND kind = 'weekly';`, [wsId])).rows[0].id}`);
    expect(rows).toEqual([{ status: "started" }]);
    expect(await auditCount(wsId, "notification.in_doubt")).toBe(1);
    expect(first.noticesInDoubt).toBeGreaterThanOrEqual(1);

    const second = await pass([wsId]);
    expect(noticesTo(address)).toHaveLength(1);
    expect(second.failed).toBe(0);
    expect(await auditCount(wsId, "notification.in_doubt")).toBe(1);
  });

  it("a provider that refuses the notice is counted as failed and audited at once, and the next pass does not resend it", async () => {
    const { wsId } = await socialWorkspace();
    const address = `owner.wrefused.${run}@notices.example.test`;
    await verifiedOwner(wsId, address);
    fake.status = 500;
    let first;
    try {
      first = await pass([wsId]);
    } finally {
      fake.status = 200;
    }
    expect(first.failed).toBeGreaterThanOrEqual(1);
    expect(await auditCount(wsId, "notification.failed")).toBe(1);
    const rows = await query<{ status: string }>(`SELECT status FROM effects WHERE workspace_id = $1 AND operation = 'notifications.send_summary';`, [wsId]);
    expect(rows.rows).toEqual([{ status: "failed" }]);
    const requests = noticesTo(address).length;

    const second = await pass([wsId]);
    expect(noticesTo(address)).toHaveLength(requests);
    expect(second.failed).toBe(0);
    expect(second.notices).toBe(0);
  });

  it("an owner who cannot be mailed does not hold the batch: with a batch of one, the verified owner is still mailed", async () => {
    // Workspace A has an owner email binding but no verified address, with email delivery on: no recipient, so nothing to send.
    const a = await socialWorkspace();
    await upsertSurfaceBinding(a.wsId, { surface: "email", actorId: `owner.binding.${run}@notices.example.test`, actorRole: "owner" }, SYNC_ACTOR);
    await generateReport(a.wsId, { accountId: a.accountId, kind: "weekly", periodStart: PERIOD_START, periodEnd: PERIOD_END }, SYSTEM_ACTOR, NOW);
    // Workspace B has a verified owner, and its report is written after A's, so A is the older one.
    const b = await socialWorkspace();
    const address = `owner.starve.${run}@notices.example.test`;
    await verifiedOwner(b.wsId, address);
    await generateReport(b.wsId, { accountId: b.accountId, kind: "weekly", periodStart: PERIOD_START, periodEnd: PERIOD_END }, SYSTEM_ACTOR, NOW);

    for (let p = 0; p < 10 && noticesTo(address).length === 0; p += 1) {
      await pass([a.wsId, b.wsId], 1);
    }
    expect(noticesTo(address)).toHaveLength(1);
    const aLedger = await query(`SELECT COUNT(*)::int AS n FROM effects WHERE workspace_id = $1 AND operation = 'notifications.send_summary';`, [a.wsId]);
    expect(Number(aLedger.rows[0].n)).toBe(0);
  });
});

describe("a notice that cannot be handed over is tried again, then audited (review S-D)", () => {
  it("a recipient that fails before its ledger row exists is tried again on later passes, then audited once and stopped", async () => {
    const { wsId, accountId } = await socialWorkspace();
    const address = `owner.untried.${run}@notices.example.test`;
    await verifiedOwner(wsId, address);
    const generated = await generateReport(wsId, { accountId, kind: "weekly", periodStart: PERIOD_START, periodEnd: PERIOD_END }, SYSTEM_ACTOR, NOW);
    const reportId = generated.report.id;
    const restore = await refuseInserts("effects", `NEW.idempotency_key LIKE '${wsId}:notify:analytics_report:%'`, "analytics_test_refuse_notice_a");
    const outcomes = [];
    try {
      for (let i = 0; i < MAX_NOTICE_ATTEMPTS; i += 1) outcomes.push(await deliverReportNotice(wsId, reportId));
    } finally {
      await restore();
    }
    // Each try finds the recipient untried. The report stays not done until the last try, which audits it once.
    expect(outcomes.map((o) => o.untried)).toEqual([1, 1, 1]);
    expect(outcomes.map((o) => o.failed)).toEqual([0, 0, 1]);
    expect(noticesTo(address)).toHaveLength(0);
    expect(await ledgerRows(`${wsId}:notify:analytics_report:${reportId}`)).toEqual([]);
    expect(await auditCount(wsId, "notification.failed")).toBe(1);
    const state = await query<{ done: boolean; attempts: number }>(
      `SELECT notice_done AS done, notice_attempts AS attempts FROM analytics_reports WHERE workspace_id = $1 AND id = $2;`,
      [wsId, reportId]
    );
    expect(state.rows[0]).toEqual({ done: true, attempts: MAX_NOTICE_ATTEMPTS });
    // Done: the job does not look at it again, so a later pass neither sends nor audits anything.
    const later = await pass([wsId]);
    expect(later.notices).toBe(0);
    expect(later.failed).toBe(0);
    expect(await auditCount(wsId, "notification.failed")).toBe(1);
  });

  it("a recipient that fails once before its ledger row exists is sent on the next pass", async () => {
    const { wsId, accountId } = await socialWorkspace();
    const address = `owner.retried.${run}@notices.example.test`;
    await verifiedOwner(wsId, address);
    const generated = await generateReport(wsId, { accountId, kind: "weekly", periodStart: PERIOD_START, periodEnd: PERIOD_END }, SYSTEM_ACTOR, NOW);
    const restore = await refuseInserts("effects", `NEW.idempotency_key LIKE '${wsId}:notify:analytics_report:%'`, "analytics_test_refuse_notice_b");
    try {
      const failed = await deliverReportNotice(wsId, generated.report.id);
      expect(failed).toMatchObject({ untried: 1, sent: 0 });
    } finally {
      await restore();
    }
    const retried = await deliverReportNotice(wsId, generated.report.id);
    expect(retried).toMatchObject({ untried: 0, sent: 1 });
    expect(noticesTo(address)).toHaveLength(1);
    expect(await auditCount(wsId, "notification.failed")).toBe(0);
    const state = await query<{ done: boolean }>(`SELECT notice_done AS done FROM analytics_reports WHERE workspace_id = $1 AND id = $2;`, [wsId, generated.report.id]);
    expect(state.rows[0].done).toBe(true);
  });
});

describe("a failing account cannot starve the others (review S1)", () => {
  it("30 permanently broken accounts, all older than one healthy account: the healthy report is still written, and each broken account is tried once per backoff", async () => {
    const brokenWorkspaces: string[] = [];
    // The broken accounts are created first, so they are the oldest. Three workspaces of ten, the limit per workspace.
    for (let w = 0; w < 3; w += 1) {
      counter += 1;
      const ws = `ws-ann-${run}-${counter}`;
      wsIds.push(ws);
      brokenWorkspaces.push(ws);
      await provisionWorkspace(ws, "Broken Brand", "social-v1");
      for (let i = 0; i < 10; i += 1) {
        await createAnalyticsAccount(ws, { provider: "simulated", brandLabel: `Broken ${i}` }, SYNC_ACTOR);
      }
    }
    await query(`UPDATE analytics_accounts SET provider = 'instagram' WHERE workspace_id = ANY($1::text[]);`, [brokenWorkspaces]);
    // The healthy account is the youngest.
    const healthy = await socialWorkspace();
    const scope = [...brokenWorkspaces, healthy.wsId];

    const first = await pass(scope, 25);
    expect(first.failed).toBeGreaterThanOrEqual(25);
    const afterFirst = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM analytics_reports WHERE workspace_id = $1 AND kind = 'weekly';`, [healthy.wsId]);
    expect(Number(afterFirst.rows[0].n)).toBe(0);

    for (let p = 0; p < 5 && (await weeklyReportsFor(healthy.wsId)) === 0; p += 1) {
      await pass(scope, 25);
    }
    expect(await weeklyReportsFor(healthy.wsId)).toBe(1);

    // Every broken account failed once, and is now in backoff: a later pass at the same instant does not retry it.
    const counts = await query<{ consecutive_failures: number }>(
      `SELECT consecutive_failures FROM analytics_accounts WHERE workspace_id = ANY($1::text[]) AND provider = 'instagram';`,
      [brokenWorkspaces]
    );
    expect(counts.rows).toHaveLength(30);
    expect(counts.rows.every((r) => r.consecutive_failures === 1)).toBe(true);
    const again = await pass(scope, 25);
    expect(again.failed).toBe(0);
  });

  it("an account in backoff is not called again before it ends: six minutes later it waits, twelve hours later it is tried", async () => {
    const { wsId, accountId } = await workspaceWithAccount();
    let calls = 0;
    const failing = createSimulatedProvider({ workspaceId: wsId, accountId });
    setAnalyticsProviderForTests((account) => {
      if (account.id !== accountId) return null;
      return {
        ...failing,
        fetchPosts: async () => {
          calls += 1;
          throw new Error("the provider is down");
        },
      } satisfies PostAnalyticsProvider;
    });
    const first = await pass([wsId], 1000, NOW);
    expect(first).toMatchObject({ failed: 1, synced: 0 });
    expect(calls).toBe(1);
    // The minimum interval is five minutes, so six minutes later the account is due by the throttle alone. Its backoff (12 hours,
    // as a provider that is not available) is what keeps it waiting.
    await pass([wsId], 1000, new Date(NOW.getTime() + 6 * MIN));
    expect(calls).toBe(1);
    await pass([wsId], 1000, new Date(NOW.getTime() + 12 * HOUR + MIN));
    expect(calls).toBe(2);
  });

  it("the backoff grows with each failed report and stops at 12 hours, and the audit row is written only when a sync changes data (48 hours, simulated clock)", async () => {
    const { wsId, accountId } = await socialWorkspace();
    // The sync succeeds and the report always fails: the account must still back off, one step longer each time.
    const restore = await refuseInserts("analytics_reports", `NEW.workspace_id = '${wsId}'`, "analytics_test_refuse_reports");
    const inner = createSimulatedProvider({ workspaceId: wsId, accountId });
    let clock = NOW;
    const calls: number[] = [];
    setAnalyticsProviderForTests((account) => {
      if (account.id !== accountId) return null;
      return {
        ...inner,
        fetchPosts: async (request) => {
          calls.push(clock.getTime());
          return inner.fetchPosts(request);
        },
      } satisfies PostAnalyticsProvider;
    });
    let passes = 0;
    try {
      // The worker wakes every 16 minutes for 48 hours, which is about once in every backoff step.
      for (let t = NOW.getTime() + 16 * MIN; t <= NOW.getTime() + 48 * HOUR; t += 16 * MIN) {
        clock = new Date(t);
        await pass([wsId], 1000, clock);
        passes += 1;
      }
    } finally {
      await restore();
    }
    // Calls follow the schedule, not the passes: 15, 30, 60, 120, 240, 480 minutes, then 12 hours at most.
    const gaps = calls.slice(1).map((t, i) => (t - calls[i]) / MIN);
    expect(passes).toBe(180);
    expect(calls.length).toBeLessThan(passes / 4);
    expect(gaps.every((g, i) => i === 0 || g >= gaps[i - 1])).toBe(true);
    expect(Math.max(...gaps)).toBe(12 * 60);
    // Every failed report is one more failure: the count carries through the sync that succeeded before it.
    const state = await query<{ consecutive_failures: number }>(`SELECT consecutive_failures FROM analytics_accounts WHERE workspace_id = $1 AND id = $2;`, [wsId, accountId]);
    expect(state.rows[0].consecutive_failures).toBe(calls.length);
    expect(await query(`SELECT 1 FROM analytics_reports WHERE workspace_id = $1;`, [wsId]).then((r) => r.rows.length)).toBe(0);
    // The simulated window moves a day at a time, so the sync audit rows are at most one per call and one per day.
    expect(await auditCount(wsId, "analytics.synced")).toBeLessThanOrEqual(calls.length + 1);
  }, 120_000);

  it("a sync that keeps failing with an ordinary provider error also stops at 12 hours (48 hours, simulated clock)", async () => {
    const { wsId, accountId } = await workspaceWithAccount();
    let clock = NOW;
    const calls: number[] = [];
    // An error that is not a refusal code: the account backs off from 15 minutes, doubling, on the plain sync-failure path.
    setAnalyticsProviderForTests((account) => {
      if (account.id !== accountId) return null;
      return {
        ...createSimulatedProvider({ workspaceId: wsId, accountId }),
        fetchPosts: async () => {
          calls.push(clock.getTime());
          throw new Error("the provider is down");
        },
      } satisfies PostAnalyticsProvider;
    });
    for (let t = NOW.getTime() + 16 * MIN; t <= NOW.getTime() + 48 * HOUR; t += 16 * MIN) {
      clock = new Date(t);
      await pass([wsId], 1000, clock);
    }
    const gaps = calls.slice(1).map((t, i) => (t - calls[i]) / MIN);
    // The steps reach 480 minutes and then the cap: 720 minutes is the longest gap, and no gap is longer.
    expect(Math.max(...gaps)).toBe(12 * 60);
    expect(gaps.every((g, i) => i === 0 || g >= gaps[i - 1])).toBe(true);
    expect(calls.length).toBeLessThan(15);
    const state = await query<{ consecutive_failures: number }>(`SELECT consecutive_failures FROM analytics_accounts WHERE workspace_id = $1 AND id = $2;`, [wsId, accountId]);
    expect(state.rows[0].consecutive_failures).toBe(calls.length);
  }, 120_000);

  it("a provider that never answers is sent the abort signal at the timeout, and the sync stores nothing", async () => {
    const { wsId, accountId } = await workspaceWithAccount();
    let signal: AbortSignal | undefined;
    setAnalyticsProviderForTests(
      (account) => {
        if (account.id !== accountId) return null;
        const inner = createSimulatedProvider({ workspaceId: wsId, accountId });
        return {
          ...inner,
          fetchPosts: (request) => {
            signal = request.signal;
            return new Promise<ProviderPost[]>(() => undefined);
          },
        } satisfies PostAnalyticsProvider;
      },
      50
    );
    await expect(syncAccount(wsId, accountId, SYNC_ACTOR, NOW)).rejects.toMatchObject({ code: "ANALYTICS_PROVIDER_UNAVAILABLE" });
    expect(signal?.aborted).toBe(true);
    const stored = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM analytics_posts WHERE workspace_id = $1;`, [wsId]);
    expect(Number(stored.rows[0].n)).toBe(0);
  });

  it("the upsert arrays are in provider-id order, whatever order the provider answered in, and the input is not reordered", () => {
    const make = (id: string): ProviderPost => ({
      externalId: id,
      publishedAt: new Date(NOW),
      mediaType: "image" as ProviderPost["mediaType"],
      metrics: { reach: 1, impressions: 2, likes: 0, comments: 0, saves: 0, shares: 0 },
    });
    const posts = [make("post-c"), make("post-a"), make("post-b")];
    expect(upsertArrays(posts).externalIds).toEqual(["post-a", "post-b", "post-c"]);
    expect(posts.map((p) => p.externalId)).toEqual(["post-c", "post-a", "post-b"]);
  });

  it("an account with no posts for the week is deferred an hour, not failed, and is not called again before then", async () => {
    const { wsId, accountId } = await workspaceWithAccount();
    let calls = 0;
    const empty = createSimulatedProvider({ workspaceId: wsId, accountId });
    setAnalyticsProviderForTests((account) => {
      if (account.id !== accountId) return null;
      return {
        ...empty,
        fetchPosts: async () => {
          calls += 1;
          return [];
        },
      } satisfies PostAnalyticsProvider;
    });
    const first = await pass([wsId], 1000, NOW);
    expect(first).toMatchObject({ deferred: 1, failed: 0, reports: 0 });
    expect(calls).toBe(1);
    const soon = await pass([wsId], 1000, new Date(NOW.getTime() + 6 * MIN));
    expect(soon).toMatchObject({ deferred: 0, failed: 0 });
    expect(calls).toBe(1);
    const later = await pass([wsId], 1000, new Date(NOW.getTime() + 61 * MIN));
    expect(later).toMatchObject({ deferred: 1, failed: 0 });
    expect(calls).toBe(2);
  });

  it("the weekly pass has a 120 second budget, and a pass already past its deadline starts nothing", async () => {
    expect(ANALYTICS_PASS_DEADLINE_MS).toBe(120_000);
    const { wsId } = await workspaceWithAccount();
    const outcome = await runWeeklyAnalyticsReports({ now: NOW, batchSize: 1000, deadlineMs: -1, workspaceIds: [wsId] });
    expect(outcome).toMatchObject({ synced: 0, reports: 0, failed: 0 });
    expect(await weeklyReportsFor(wsId)).toBe(0);
  });

  it("a re-sync that brings no new data stores nothing new and writes no analytics.synced row", async () => {
    const { wsId, accountId } = await socialWorkspace();
    expect(await auditCount(wsId, "analytics.synced")).toBe(1);
    const again = await syncAccount(wsId, accountId, SYNC_ACTOR, new Date(NOW.getTime() + 6 * MIN));
    expect(again).toMatchObject({ inserted: 0 });
    expect(await auditCount(wsId, "analytics.synced")).toBe(1);
  });
});
