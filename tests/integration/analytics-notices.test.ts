import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { config } from "../../src/config/env.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { notificationEmitter } from "../../src/adapters/web2/notifications.js";
import { upsertSurfaceBinding } from "../../src/adapters/socialSurface.js";
import { requestOwnerEmailVerification, verifyOwnerEmail } from "../../src/notifications/owner-emails.js";
import { setEffectFault } from "../../src/effects/faults.js";
import { runTick } from "../../src/workers/runner.js";
import {
  createAnalyticsAccount,
  deliverReportNotice,
  generateReport,
  runWeeklyAnalyticsReports,
  syncAccount,
  SYSTEM_ACTOR,
} from "../../src/analytics/service.js";
import { startFakeResend, codeIn, type FakeResend } from "../helpers/fake-resend.js";

/*
 * Analytics reports and the owner's notice (docs/decisions/0090, ADR 0017, ADR 0074), against a local fake email provider.
 * The notice is at most once per (workspace, report, recipient): a replay, a concurrent call, a crash before the notice, and a
 * crash during the send are each tested. The weekly job is tested for its bounds, its isolation and its replay.
 */

const run = Date.now();
const NOTICE_SUBJECT = "Something is waiting for you in Bind";
/** A fixed instant in the week after 26 October 2026: the period is Monday 26 October to Monday 2 November 2026. */
const NOW = new Date("2026-11-04T10:00:00Z");
const PERIOD_START = new Date("2026-10-26T00:00:00Z");
const PERIOD_END = new Date("2026-11-02T00:00:00Z");
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
});

afterAll(async () => {
  config.BIND_EMAIL_PROVIDER = saved.provider;
  config.BIND_EMAIL_API_KEY = saved.key;
  config.BIND_EMAIL_FROM = saved.from;
  config.BIND_EMAIL_API_BASE = saved.base;
  setEffectFault(null);
  await fake.close();
  for (const id of wsIds.splice(0)) await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
  await closePool();
});

/** A fresh social workspace with one analytics account, synced. Each test decides what else it has. */
async function socialWorkspace(): Promise<{ wsId: string; accountId: string }> {
  counter += 1;
  const wsId = `ws-ann-${run}-${counter}`;
  wsIds.push(wsId);
  await provisionWorkspace(wsId, "Notice Brand", "social-v1");
  const account = await createAnalyticsAccount(wsId, { provider: "simulated", brandLabel: "Brand" }, SYNC_ACTOR);
  await syncAccount(wsId, account.id, SYNC_ACTOR, NOW);
  return { wsId, accountId: account.id };
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
    expect(text).toContain("Your report is ready.");
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
    expect(recorded[0]).toMatchObject({ title: "Your report is ready", message: "Your report is ready. Open Bind to read it." });
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

    const replay = await runWeeklyAnalyticsReports({ now: NOW, batchSize: 1000 });
    expect(replay.errors.filter((e) => e.includes(wsId))).toEqual([]);
    expect(noticesTo(address)).toHaveLength(1);
    const again = await runWeeklyAnalyticsReports({ now: NOW, batchSize: 1000 });
    expect(again.errors.filter((e) => e.includes(wsId))).toEqual([]);
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
    // The injected crash is thrown after the provider answered: this call sees a failure, and the row is left started.
    expect(first).toMatchObject({ sent: 0, failed: 1 });
    expect(noticesTo(address)).toHaveLength(1);
    expect(await ledgerRows(key)).toEqual([{ status: "started" }]);

    // The next delivery finds the started row: it is reported in doubt and audited, and nothing is sent.
    const second = await deliverReportNotice(wsId, generated.report.id);
    expect(second).toMatchObject({ sent: 0, inDoubt: 1 });
    expect(noticesTo(address)).toHaveLength(1);
    const inDoubt = await query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'notification.in_doubt';`, [wsId]);
    expect(Number(inDoubt.rows[0].n)).toBe(1);
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
    expect(second).toMatchObject({ sent: 0, inDoubt: 1 });
    // The provider saw one request (the refused one) and no later one.
    expect(noticesTo(address)).toHaveLength(1);
  });
});

describe("the weekly job: bounded, isolated, and replay-safe", () => {
  it("the worker does nothing with analytics unless it is switched on", async () => {
    const { wsId } = await socialWorkspace();
    const off = await runTick({ now: NOW });
    expect(off.analyticsReports.skipped).toBe(true);
    expect(await weeklyReportsFor(wsId)).toBe(0);
  });

  it("with the job on, a broken account is counted and the others still run; a replay does nothing new", async () => {
    const good = await socialWorkspace();
    const broken = await socialWorkspace();
    await query(`UPDATE analytics_accounts SET provider = 'instagram' WHERE workspace_id = $1;`, [broken.wsId]);
    const pass = await runWeeklyAnalyticsReports({ now: NOW, batchSize: 1000 });
    expect(pass.failed).toBeGreaterThanOrEqual(1);
    expect(pass.errors.some((e) => e.includes("not available"))).toBe(true);
    expect(await weeklyReportsFor(good.wsId)).toBe(1);
    expect(await weeklyReportsFor(broken.wsId)).toBe(0);
    const before = await query(`SELECT COUNT(*)::int AS n FROM analytics_reports WHERE workspace_id = $1;`, [good.wsId]);
    await runWeeklyAnalyticsReports({ now: NOW, batchSize: 1000 });
    const after = await query(`SELECT COUNT(*)::int AS n FROM analytics_reports WHERE workspace_id = $1;`, [good.wsId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("a disabled account is not synced by the job, and a demo workspace is not touched", async () => {
    const disabled = await socialWorkspace();
    await query(`UPDATE analytics_accounts SET status = 'disabled' WHERE workspace_id = $1;`, [disabled.wsId]);
    const demo = await socialWorkspace();
    await query(`UPDATE workspaces SET is_demo = TRUE, demo_expires_at = NOW() + INTERVAL '1 day' WHERE id = $1;`, [demo.wsId]);
    await runWeeklyAnalyticsReports({ now: NOW, batchSize: 1000 });
    expect(await weeklyReportsFor(disabled.wsId)).toBe(0);
    expect(await weeklyReportsFor(demo.wsId)).toBe(0);
    await expect(syncAccount(disabled.wsId, disabled.accountId, SYNC_ACTOR, NOW)).rejects.toMatchObject({ code: "ANALYTICS_ACCOUNT_DISABLED" });
  });

  it("the job's sync step is bounded by its batch size", async () => {
    await socialWorkspace();
    await socialWorkspace();
    const pass = await runWeeklyAnalyticsReports({ now: NOW, batchSize: 1 });
    expect(pass.synced).toBeLessThanOrEqual(1);
  });

  it("the worker runs the job, and reports it, when BIND_ANALYTICS_REPORTS is on", async () => {
    const { wsId } = await socialWorkspace();
    const on = await runTick({ now: NOW, analyticsReports: true });
    expect(on.analyticsReports.skipped).toBe(false);
    expect(await weeklyReportsFor(wsId)).toBe(1);
  });
});
