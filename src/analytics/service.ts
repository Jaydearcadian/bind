/**
 * Post analytics service (docs/decisions/0090). Connects an analytics account, syncs its posts through a provider, writes one
 * report per period, and tells the owner that the report is ready.
 *
 * Guarantees:
 * - A sync is an idempotent upsert keyed by (workspace, account, external post id). Running it twice leaves the row count as it was.
 * - A report is written at most once per (workspace, account or all brands, kind, period). Concurrent requests get the same row.
 * - The owner is told at most once per (workspace, report) and recipient, through the effects ledger (ADR 0017, ADR 0074). The
 *   notice names no finding, no brand and no account.
 * - Every query is scoped to the workspace. A id of another workspace is "not found".
 * - Only the simulated provider is available. Any other provider is refused before anything is read or written.
 */
import type { PoolClient } from "pg";
import { query, withTransaction } from "../db/client.js";
import { newId } from "../utils/ids.js";
import { redactText } from "../utils/redact.js";
import { log } from "../observability/logger.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PolicyDecision } from "../policy/engine.js";
import { resolveOwnerRecipients } from "../notifications/recipients.js";
import { ownerNoticeIdempotencyKey, sendOwnerNotification } from "../notifications/dispatch.js";
import { getTemplate, listTemplates, templateHasAnalytics } from "../templates/registry.js";
import { analysePosts, renderReportText, type Findings } from "./analyse.js";
import { createSimulatedProvider, SIMULATED_PROVIDER_ID, simulatedExternalAccountId } from "./simulated-provider.js";
import { addDays, dayString, isValidTimeZone, parseDay, startOfIsoWeek, startOfUtcDay, MAX_PERIOD_DAYS } from "./time.js";
import { parseProviderPosts } from "./validate.js";
import {
  AnalyticsError,
  AnalyticsProviderOutputError,
  PROVIDER_NOT_AVAILABLE_CODE,
  type PostAnalyticsProvider,
  type ProviderPost,
} from "./types.js";

export const TEMPLATE_NO_ANALYTICS_CODE = "TEMPLATE_HAS_NO_ANALYTICS" as const;
export const MAX_ACCOUNTS_PER_WORKSPACE = 10;
/** The window a sync reads: the last 90 UTC days, ending at the start of the sync's day. */
export const SYNC_WINDOW_DAYS = 90;
/** The weekly report's actor, on its audit rows. */
export const SYSTEM_ACTOR = { type: "system" as const, id: "system:analytics" };
const ENGINE = new WorkflowEngine();
const BRAND_LABEL_MAX = 80;
const MAX_LIST = 50;

export interface AnalyticsActor {
  type: "owner" | "system";
  /** The owner token's label, or `system:analytics`. */
  id: string;
}

export interface AnalyticsAccountView {
  id: string;
  provider: string;
  brandLabel: string;
  timeZone: string;
  isSimulated: boolean;
  status: string;
  createdAt: string;
  lastSyncedAt: string | null;
  postCount: number;
}

export interface SyncResult {
  accountId: string;
  posts: number;
  inserted: number;
  updated: number;
  syncedAt: string;
  simulated: boolean;
}

export interface AnalyticsReportView {
  id: string;
  accountId: string | null;
  kind: "weekly" | "on_demand";
  periodStart: string;
  periodEnd: string;
  createdAt: string;
  simulated: boolean;
  text: string;
  findings: Findings;
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * Guards
 * ------------------------------------------------------------------------------------------------------------------------- */

/**
 * Whether the workspace's template has an analytics data source. A workspace that names no template (a blank one) has none.
 * Returns null when the workspace does not exist.
 */
async function analyticsModuleOf(workspaceId: string): Promise<{ hasModule: boolean; isDemo: boolean } | null> {
  const res = await query<{ template_id: string; is_demo: boolean }>(`SELECT template_id, is_demo FROM workspaces WHERE id = $1;`, [workspaceId]);
  const row = res.rows[0];
  if (!row) return null;
  const template = getTemplate(row.template_id);
  return { hasModule: template !== undefined && templateHasAnalytics(template), isDemo: row.is_demo === true };
}

/** The workspace's template has an analytics data source, or the refusal (400 TEMPLATE_HAS_NO_ANALYTICS, used by every write). */
export async function assertAnalyticsModule(workspaceId: string): Promise<{ isDemo: boolean }> {
  const state = await analyticsModuleOf(workspaceId);
  if (!state) throw new AnalyticsError("NOT_FOUND", 404, "Workspace not found");
  if (!state.hasModule) {
    throw new AnalyticsError(TEMPLATE_NO_ANALYTICS_CODE, 400, "This workspace's template has no post analytics module.");
  }
  return { isDemo: state.isDemo };
}

/** The module check, then the demo refusal for every write. A demo workspace is read-only for analytics. Used by every write. */
async function assertWritable(workspaceId: string): Promise<void> {
  const { isDemo } = await assertAnalyticsModule(workspaceId);
  if (isDemo) {
    throw new AnalyticsError("ANALYTICS_DEMO_REFUSED", 403, "Demo workspaces do not change analytics. Use a real workspace to connect an account.");
  }
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * Provider selection
 * ------------------------------------------------------------------------------------------------------------------------- */

interface AccountRow {
  workspace_id: string;
  id: string;
  provider: string;
  external_account_id: string;
  brand_label: string;
  time_zone: string;
  is_simulated: boolean;
  status: string;
  created_at: Date;
}

/** The provider for a stored account. Only `simulated` exists in this slice; any other stored value is refused, not guessed. */
export function providerForAccount(account: Pick<AccountRow, "workspace_id" | "id" | "provider">): PostAnalyticsProvider {
  if (account.provider === SIMULATED_PROVIDER_ID) {
    return createSimulatedProvider({ workspaceId: account.workspace_id, accountId: account.id });
  }
  throw new AnalyticsError(PROVIDER_NOT_AVAILABLE_CODE, 400, "That analytics provider is not available on this server.");
}

async function loadAccount(workspaceId: string, accountId: string): Promise<AccountRow> {
  const res = await query<AccountRow>(
    `SELECT workspace_id, id, provider, external_account_id, brand_label, time_zone, is_simulated, status, created_at
     FROM analytics_accounts WHERE workspace_id = $1 AND id = $2;`,
    [workspaceId, accountId]
  );
  const row = res.rows[0];
  if (!row) throw new AnalyticsError("ANALYTICS_ACCOUNT_NOT_FOUND", 404, "No such analytics account in this workspace.");
  return row;
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * Accounts
 * ------------------------------------------------------------------------------------------------------------------------- */

/** A brand label as the owner typed it: trimmed, 1 to 80 characters, no control characters. */
export function parseBrandLabel(value: unknown): string {
  if (typeof value !== "string") throw new AnalyticsError("INVALID_INPUT", 400, "brandLabel must be text of 1 to 80 characters");
  const label = value.trim();
  // eslint-disable-next-line no-control-regex
  if (label.length === 0 || label.length > BRAND_LABEL_MAX || /[\u0000-\u001f\u007f]/.test(label)) {
    throw new AnalyticsError("INVALID_INPUT", 400, "brandLabel must be text of 1 to 80 characters without control characters");
  }
  return label;
}

export function toAccountView(row: AccountRow & { last_synced_at?: Date | null; post_count?: number }): AnalyticsAccountView {
  return {
    id: row.id,
    provider: row.provider,
    brandLabel: row.brand_label,
    timeZone: row.time_zone,
    isSimulated: row.is_simulated,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    lastSyncedAt: row.last_synced_at ? new Date(row.last_synced_at).toISOString() : null,
    postCount: Number(row.post_count ?? 0),
  };
}

/** The accounts of a workspace. A workspace with no analytics module has none, so the list is empty (the stock reads do the same). */
export async function listAnalyticsAccounts(workspaceId: string): Promise<AnalyticsAccountView[]> {
  const state = await analyticsModuleOf(workspaceId);
  if (!state) throw new AnalyticsError("NOT_FOUND", 404, "Workspace not found");
  if (!state.hasModule) return [];
  const res = await query(
    `SELECT a.workspace_id, a.id, a.provider, a.external_account_id, a.brand_label, a.time_zone, a.is_simulated, a.status, a.created_at,
            (SELECT MAX(p.synced_at) FROM analytics_posts p WHERE p.workspace_id = a.workspace_id AND p.account_id = a.id) AS last_synced_at,
            (SELECT COUNT(*)::int FROM analytics_posts p WHERE p.workspace_id = a.workspace_id AND p.account_id = a.id) AS post_count
     FROM analytics_accounts a WHERE a.workspace_id = $1 ORDER BY a.created_at ASC, a.id ASC;`,
    [workspaceId]
  );
  return res.rows.map((row) => toAccountView(row));
}

/**
 * Connects an analytics account. Only the simulated provider is accepted; anything else is refused with
 * ANALYTICS_PROVIDER_NOT_AVAILABLE before the workspace is read. The audit row holds ids and the provider's name only.
 */
export async function createAnalyticsAccount(
  workspaceId: string,
  input: { provider: unknown; brandLabel: unknown; timeZone?: unknown },
  actor: AnalyticsActor
): Promise<AnalyticsAccountView> {
  if (input.provider !== SIMULATED_PROVIDER_ID) {
    if (typeof input.provider !== "string" || input.provider.length === 0 || input.provider.length > 40) {
      throw new AnalyticsError("INVALID_INPUT", 400, "provider must be the name of an analytics provider");
    }
    throw new AnalyticsError(PROVIDER_NOT_AVAILABLE_CODE, 400, "Only the simulated analytics provider is available on this server.");
  }
  const brandLabel = parseBrandLabel(input.brandLabel);
  const timeZone = input.timeZone === undefined || input.timeZone === null ? "UTC" : input.timeZone;
  if (!isValidTimeZone(timeZone)) throw new AnalyticsError("INVALID_INPUT", 400, "timeZone must be an IANA time zone, such as Europe/London");
  await assertWritable(workspaceId);

  const id = newId("ana");
  const externalAccountId = simulatedExternalAccountId(workspaceId, id);
  return withTransaction(async (client: PoolClient) => {
    const count = await client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM analytics_accounts WHERE workspace_id = $1;`, [workspaceId]);
    if ((count.rows[0]?.n ?? 0) >= MAX_ACCOUNTS_PER_WORKSPACE) {
      throw new AnalyticsError("ANALYTICS_ACCOUNT_LIMIT", 409, `A workspace can have at most ${MAX_ACCOUNTS_PER_WORKSPACE} analytics accounts.`);
    }
    const inserted = await client.query<AccountRow>(
      `INSERT INTO analytics_accounts (workspace_id, id, provider, external_account_id, brand_label, time_zone, is_simulated, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, 'active', NOW())
       RETURNING workspace_id, id, provider, external_account_id, brand_label, time_zone, is_simulated, status, created_at;`,
      [workspaceId, id, SIMULATED_PROVIDER_ID, externalAccountId, brandLabel, timeZone]
    );
    await ENGINE.recordAudit(
      workspaceId,
      null,
      actor.type,
      actor.id,
      EffectClass.READ,
      "analytics.account_created",
      PolicyDecision.ALLOW,
      { accountId: id, kind: SIMULATED_PROVIDER_ID },
      undefined,
      client
    );
    return toAccountView(inserted.rows[0]);
  });
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * Sync
 * ------------------------------------------------------------------------------------------------------------------------- */

const UPSERT_POSTS = `
  INSERT INTO analytics_posts (
    workspace_id, account_id, external_id, media_type, published_at, reach, impressions, likes, comments, saves, shares,
    plays, follower_reach, non_follower_reach, country_reach, synced_at)
  SELECT $1::varchar, $2::varchar, t.external_id, t.media_type, t.published_at, t.reach, t.impressions, t.likes, t.comments, t.saves, t.shares,
         t.plays, t.follower_reach, t.non_follower_reach, t.country_reach::jsonb, $3::timestamptz
  FROM unnest($4::text[], $5::text[], $6::timestamptz[], $7::int[], $8::int[], $9::int[], $10::int[], $11::int[], $12::int[],
              $13::int[], $14::int[], $15::int[], $16::text[])
       AS t(external_id, media_type, published_at, reach, impressions, likes, comments, saves, shares, plays, follower_reach,
            non_follower_reach, country_reach)
  ON CONFLICT (workspace_id, account_id, external_id) DO UPDATE SET
    media_type = EXCLUDED.media_type,
    published_at = EXCLUDED.published_at,
    reach = EXCLUDED.reach,
    impressions = EXCLUDED.impressions,
    likes = EXCLUDED.likes,
    comments = EXCLUDED.comments,
    saves = EXCLUDED.saves,
    shares = EXCLUDED.shares,
    plays = EXCLUDED.plays,
    follower_reach = EXCLUDED.follower_reach,
    non_follower_reach = EXCLUDED.non_follower_reach,
    country_reach = EXCLUDED.country_reach,
    synced_at = EXCLUDED.synced_at
  RETURNING (xmax = 0) AS inserted;`;

/** The posts as parallel arrays, one entry per post, for a single unnest insert. Nullable values are NULL. */
function postArrays(posts: readonly ProviderPost[]) {
  const col = <T>(f: (p: ProviderPost) => T) => posts.map(f);
  return {
    externalIds: col((p) => p.externalId),
    mediaTypes: col((p) => p.mediaType),
    publishedAt: col((p) => p.publishedAt.toISOString()),
    reach: col((p) => p.metrics.reach),
    impressions: col((p) => p.metrics.impressions),
    likes: col((p) => p.metrics.likes),
    comments: col((p) => p.metrics.comments),
    saves: col((p) => p.metrics.saves),
    shares: col((p) => p.metrics.shares),
    plays: col((p) => p.metrics.plays ?? null),
    followerReach: col((p) => p.followerReach ?? null),
    nonFollowerReach: col((p) => p.nonFollowerReach ?? null),
    countryReach: col((p) => (p.countryReach ? JSON.stringify(p.countryReach) : null)),
  };
}

/**
 * Fetches the account's recent posts from its provider and stores them. The provider's answer is validated first; a malformed
 * answer stores nothing. The write and its audit row share one transaction.
 */
export async function syncAccount(workspaceId: string, accountId: string, actor: AnalyticsActor, now: Date = new Date()): Promise<SyncResult> {
  await assertWritable(workspaceId);
  const account = await loadAccount(workspaceId, accountId);
  if (account.status !== "active") throw new AnalyticsError("ANALYTICS_ACCOUNT_DISABLED", 409, "This analytics account is disabled.");
  const provider = providerForAccount(account);

  const until = startOfUtcDay(now);
  const since = addDays(until, -SYNC_WINDOW_DAYS);
  let raw: unknown;
  try {
    raw = await provider.fetchPosts({ accountId: account.external_account_id, since, until });
  } catch (err) {
    if (err instanceof AnalyticsProviderOutputError) throw err;
    // The provider's own message is not repeated: it can carry text the owner never sent.
    log.warn("analytics.provider_failed", { provider: provider.id, error: redactText(err instanceof Error ? err.message : String(err)).slice(0, 200) });
    throw new AnalyticsError("ANALYTICS_PROVIDER_UNAVAILABLE", 502, "The analytics provider did not answer. Nothing was stored.");
  }
  const posts = parseProviderPosts(raw);
  const arrays = postArrays(posts);
  const syncedAt = now;

  return withTransaction(async (client: PoolClient) => {
    let inserted = 0;
    if (posts.length > 0) {
      const res = await client.query<{ inserted: boolean }>(UPSERT_POSTS, [
        workspaceId,
        accountId,
        syncedAt.toISOString(),
        arrays.externalIds,
        arrays.mediaTypes,
        arrays.publishedAt,
        arrays.reach,
        arrays.impressions,
        arrays.likes,
        arrays.comments,
        arrays.saves,
        arrays.shares,
        arrays.plays,
        arrays.followerReach,
        arrays.nonFollowerReach,
        arrays.countryReach,
      ]);
      inserted = res.rows.filter((row) => row.inserted).length;
    }
    const updated = posts.length - inserted;
    await ENGINE.recordAudit(
      workspaceId,
      null,
      actor.type,
      actor.id,
      EffectClass.EXTERNAL_REQUEST,
      "analytics.synced",
      PolicyDecision.ALLOW,
      { accountId, status: "synced", posts: posts.length, inserted, updated },
      undefined,
      client
    );
    return { accountId, posts: posts.length, inserted, updated, syncedAt: syncedAt.toISOString(), simulated: provider.isSimulated };
  });
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * Reports
 * ------------------------------------------------------------------------------------------------------------------------- */

interface PostRow {
  external_id: string;
  media_type: ProviderPost["mediaType"];
  published_at: Date;
  reach: number;
  impressions: number;
  likes: number;
  comments: number;
  saves: number;
  shares: number;
  plays: number | null;
  follower_reach: number | null;
  non_follower_reach: number | null;
  country_reach: Record<string, number> | null;
  is_simulated: boolean;
  time_zone: string;
}

function rowToPost(row: PostRow): ProviderPost {
  const post: ProviderPost = {
    externalId: row.external_id,
    publishedAt: new Date(row.published_at),
    mediaType: row.media_type,
    metrics: { reach: row.reach, impressions: row.impressions, likes: row.likes, comments: row.comments, saves: row.saves, shares: row.shares },
  };
  if (row.plays !== null) post.metrics.plays = row.plays;
  if (row.follower_reach !== null && row.non_follower_reach !== null) {
    post.followerReach = row.follower_reach;
    post.nonFollowerReach = row.non_follower_reach;
  }
  if (row.country_reach !== null) post.countryReach = row.country_reach;
  return post;
}

interface ReportRow {
  id: string;
  account_id: string | null;
  kind: "weekly" | "on_demand";
  period_start: string;
  period_end: string;
  findings: Findings;
  report_text: string;
  created_at: Date;
}

export function toReportView(row: ReportRow): AnalyticsReportView {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    createdAt: new Date(row.created_at).toISOString(),
    simulated: row.findings.simulated,
    text: row.report_text,
    findings: row.findings,
  };
}

const REPORT_COLUMNS = `id, account_id, kind, to_char(period_start, 'YYYY-MM-DD') AS period_start, to_char(period_end, 'YYYY-MM-DD') AS period_end,
  findings, report_text, created_at`;

/** The period a report covers, as UTC days. It must be whole days, at most MAX_PERIOD_DAYS long, and end by today (UTC). */
export function parsePeriod(input: { periodStart: unknown; periodEnd: unknown }, now: Date): { start: Date; end: Date } {
  const start = parseDay(input.periodStart);
  const end = parseDay(input.periodEnd);
  if (!start || !end) throw new AnalyticsError("INVALID_INPUT", 400, "periodStart and periodEnd must be dates, such as 2026-10-19");
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  if (days < 1 || days > MAX_PERIOD_DAYS) throw new AnalyticsError("INVALID_INPUT", 400, `A period must be 1 to ${MAX_PERIOD_DAYS} days long`);
  if (end.getTime() > startOfUtcDay(now).getTime()) throw new AnalyticsError("INVALID_INPUT", 400, "A period must end on or before today (UTC)");
  return { start, end };
}

/** The last seven full UTC days before today, for an on-demand report with no period given. */
export function defaultOnDemandPeriod(now: Date): { start: Date; end: Date } {
  const end = startOfUtcDay(now);
  return { start: addDays(end, -7), end };
}

export interface GenerateResult {
  report: AnalyticsReportView;
  /** True when this call wrote the report. False when the period already had one (the same row is returned). */
  created: boolean;
}

/**
 * Writes the report for one period, once. The posts are read from storage (no provider call). The insert is `ON CONFLICT DO
 * NOTHING` on the period key; when nothing was inserted, the existing row is returned. The audit row is written only with the
 * insert, in the same transaction.
 */
export async function generateReport(
  workspaceId: string,
  input: { accountId: string | null; kind: "weekly" | "on_demand"; periodStart: Date; periodEnd: Date },
  actor: AnalyticsActor,
  now: Date = new Date()
): Promise<GenerateResult> {
  await assertWritable(workspaceId);
  if (input.kind !== "weekly" && input.kind !== "on_demand") throw new AnalyticsError("INVALID_INPUT", 400, "kind must be weekly or on_demand");
  const start = input.periodStart;
  const end = input.periodEnd;
  if (!(end.getTime() > start.getTime())) throw new AnalyticsError("INVALID_INPUT", 400, "periodEnd must be after periodStart");
  if (end.getTime() > startOfUtcDay(now).getTime()) throw new AnalyticsError("INVALID_INPUT", 400, "A period must end on or before today (UTC)");

  let timeZone = "UTC";
  if (input.accountId !== null) {
    const account = await loadAccount(workspaceId, input.accountId);
    timeZone = account.time_zone;
  }
  const rows = await query<PostRow & { is_simulated: boolean; time_zone: string }>(
    `SELECT p.external_id, p.media_type, p.published_at, p.reach, p.impressions, p.likes, p.comments, p.saves, p.shares, p.plays,
            p.follower_reach, p.non_follower_reach, p.country_reach, a.is_simulated, a.time_zone
     FROM analytics_posts p
     JOIN analytics_accounts a ON a.workspace_id = p.workspace_id AND a.id = p.account_id
     WHERE p.workspace_id = $1 AND ($2::text IS NULL OR p.account_id = $2)
       AND p.published_at >= $3 AND p.published_at < $4
     ORDER BY p.published_at ASC, p.external_id ASC;`,
    [workspaceId, input.accountId, start.toISOString(), end.toISOString()]
  );
  const simulated = rows.rows.some((row) => row.is_simulated);
  // A report over all brands is read in UTC: each brand has its own zone, and one hour must mean one thing.
  const findings = analysePosts(
    rows.rows.map(rowToPost),
    { timeZone: input.accountId === null ? "UTC" : timeZone, simulated }
  );
  const text = renderReportText(findings);

  const id = newId("rpt");
  const written = await withTransaction(async (client: PoolClient) => {
    const insert = await client.query(
      `INSERT INTO analytics_reports (workspace_id, id, account_id, kind, period_start, period_end, findings, report_text, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW())
       ON CONFLICT DO NOTHING
       RETURNING id;`,
      [workspaceId, id, input.accountId, input.kind, dayString(start), dayString(end), JSON.stringify(findings), text]
    );
    if (insert.rowCount !== 1) return false;
    await ENGINE.recordAudit(
      workspaceId,
      null,
      actor.type,
      actor.id,
      EffectClass.READ,
      "analytics.report_generated",
      PolicyDecision.ALLOW,
      { reportId: id, accountId: input.accountId ?? undefined, kind: input.kind, status: "created" },
      undefined,
      client
    );
    return true;
  });
  if (written) {
    return { report: await loadReportView(workspaceId, id), created: true };
  }
  const existing = await query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM analytics_reports
     WHERE workspace_id = $1 AND COALESCE(account_id, '') = $2 AND kind = $3
       AND period_start = $4::date AND period_end = $5::date;`,
    [workspaceId, input.accountId ?? "", input.kind, dayString(start), dayString(end)]
  );
  const row = existing.rows[0];
  if (!row) throw new Error("The report for this period is not available; retry later.");
  return { report: toReportView(row), created: false };
}

async function loadReportView(workspaceId: string, reportId: string): Promise<AnalyticsReportView> {
  const res = await query<ReportRow>(`SELECT ${REPORT_COLUMNS} FROM analytics_reports WHERE workspace_id = $1 AND id = $2;`, [workspaceId, reportId]);
  const row = res.rows[0];
  if (!row) throw new AnalyticsError("ANALYTICS_REPORT_NOT_FOUND", 404, "No such analytics report in this workspace.");
  return toReportView(row);
}

export async function listAnalyticsReports(workspaceId: string): Promise<AnalyticsReportView[]> {
  const state = await analyticsModuleOf(workspaceId);
  if (!state) throw new AnalyticsError("NOT_FOUND", 404, "Workspace not found");
  if (!state.hasModule) return [];
  const res = await query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM analytics_reports WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2;`,
    [workspaceId, MAX_LIST]
  );
  return res.rows.map(toReportView);
}

/** One report. A workspace with no module has no reports, so the id is not found there. */
export async function getAnalyticsReport(workspaceId: string, reportId: string): Promise<AnalyticsReportView> {
  const state = await analyticsModuleOf(workspaceId);
  if (!state) throw new AnalyticsError("NOT_FOUND", 404, "Workspace not found");
  if (!state.hasModule) throw new AnalyticsError("ANALYTICS_REPORT_NOT_FOUND", 404, "No such analytics report in this workspace.");
  return loadReportView(workspaceId, reportId);
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * The owner's notice
 * ------------------------------------------------------------------------------------------------------------------------- */

export interface NoticeOutcome {
  recipients: number;
  /** Sent by this call. */
  sent: number;
  /** A send that started before and has no recorded outcome. It is not sent again; the dispatcher audits it (ADR 0074). */
  inDoubt: number;
  skipped: number;
  /** Already sent to this recipient by an earlier call: nothing was sent now. */
  alreadySent: number;
  /** The provider refused, or the call failed before it was recorded. The ledger holds the row as failed. */
  failed: number;
}

/**
 * Tells the owner that a report is ready. Each recipient is told at most once, through the effects ledger: a recipient whose row
 * is completed is not contacted again. A row that started or failed is not sent again either; the dispatcher reports it in doubt
 * and audits it. The message names no finding. It goes out through the same owner-notice path as the approval notices, so email
 * delivery off or simulated, and demo refusal, apply as they do there (ADR 0074).
 */
export async function deliverReportNotice(workspaceId: string, reportId: string): Promise<NoticeOutcome> {
  await loadReportView(workspaceId, reportId);
  const recipients = await resolveOwnerRecipients(workspaceId);
  const outcome: NoticeOutcome = { recipients: recipients.length, sent: 0, inDoubt: 0, skipped: 0, alreadySent: 0, failed: 0 };
  for (const recipient of recipients) {
    const key = ownerNoticeIdempotencyKey(workspaceId, "analytics_report", reportId, recipient.recipientId);
    const existing = await query<{ status: string }>(`SELECT status FROM effects WHERE idempotency_key = $1;`, [key]);
    if (existing.rows[0]?.status === "completed") {
      outcome.alreadySent += 1;
      continue;
    }
    try {
      const result = await sendOwnerNotification({
        workspaceId,
        kind: "analytics_report",
        refId: reportId,
        recipientId: recipient.recipientId,
        payload: {
          workspaceId,
          channel: recipient.channel,
          recipient: recipient.recipient,
          title: "Your report is ready",
          message: "Your report is ready. Open Bind to read it.",
        },
      });
      if (result.sent) outcome.sent += 1;
      else if (result.reason === "in_doubt") outcome.inDoubt += 1;
      else outcome.skipped += 1;
    } catch (err) {
      outcome.failed += 1;
      log.warn("analytics.notice_failed", { workspaceId, reportId, error: redactText(err instanceof Error ? err.message : String(err)).slice(0, 200) });
    }
  }
  return outcome;
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * The weekly job (called by the worker, docs/decisions/0090)
 * ------------------------------------------------------------------------------------------------------------------------- */

export interface WeeklyReportsResult {
  synced: number;
  reports: number;
  notices: number;
  failed: number;
  errors: string[];
}

/** The template ids whose template has an analytics data source. */
export function templateIdsWithAnalytics(): string[] {
  return listTemplates().filter(templateHasAnalytics).map((t) => t.templateId);
}

/**
 * One pass of the weekly job. The period is the last full ISO week (Monday to Monday, UTC). Step one syncs and writes the report
 * for each active account of a real analytics workspace that has none for that week. Step two tells the owner about each weekly
 * report of that week that no recipient was told about yet. Both steps are bounded by `batchSize`, and each account or report
 * is isolated: one failure is counted and does not stop the rest. Replaying a pass does nothing that was already done.
 */
export async function runWeeklyAnalyticsReports(opts: { now: Date; batchSize: number }): Promise<WeeklyReportsResult> {
  const result: WeeklyReportsResult = { synced: 0, reports: 0, notices: 0, failed: 0, errors: [] };
  const templateIds = templateIdsWithAnalytics();
  if (templateIds.length === 0) return result;
  const periodEnd = startOfIsoWeek(opts.now);
  const periodStart = addDays(periodEnd, -7);
  const fail = (err: unknown) => {
    result.failed += 1;
    result.errors.push(redactText(err instanceof Error ? err.message : String(err)).slice(0, 200));
  };

  const due = await query<{ workspace_id: string; id: string }>(
    `SELECT a.workspace_id, a.id
     FROM analytics_accounts a
     JOIN workspaces w ON w.id = a.workspace_id
     WHERE a.status = 'active' AND NOT w.is_demo AND w.template_id = ANY($1::text[])
       AND NOT EXISTS (
         SELECT 1 FROM analytics_reports r
         WHERE r.workspace_id = a.workspace_id AND r.account_id = a.id AND r.kind = 'weekly'
           AND r.period_start = $2::date AND r.period_end = $3::date)
     ORDER BY a.created_at ASC, a.id ASC
     LIMIT $4;`,
    [templateIds, dayString(periodStart), dayString(periodEnd), opts.batchSize]
  );
  for (const row of due.rows) {
    try {
      await syncAccount(row.workspace_id, row.id, SYSTEM_ACTOR, opts.now);
      result.synced += 1;
      const generated = await generateReport(
        row.workspace_id,
        { accountId: row.id, kind: "weekly", periodStart, periodEnd },
        SYSTEM_ACTOR,
        opts.now
      );
      if (generated.created) result.reports += 1;
      const notice = await deliverReportNotice(row.workspace_id, generated.report.id);
      result.notices += notice.sent;
    } catch (err) {
      fail(err);
    }
  }

  // Reports of this week whose primary recipient has no ledger row yet. A row is a send, a failure or an in-doubt send, and
  // none of those is tried again. A report whose workspace has no owner contact is not listed.
  const pending = await query<{ workspace_id: string; id: string }>(
    `SELECT r.workspace_id, r.id
     FROM analytics_reports r
     JOIN workspaces w ON w.id = r.workspace_id
     WHERE r.kind = 'weekly' AND r.period_start = $1::date AND r.period_end = $2::date
       AND NOT w.is_demo AND w.template_id = ANY($3::text[])
       AND NOT EXISTS (SELECT 1 FROM effects e WHERE e.idempotency_key = r.workspace_id || ':notify:analytics_report:' || r.id)
       AND (
         EXISTS (SELECT 1 FROM owner_emails oe WHERE oe.workspace_id = r.workspace_id AND oe.verified_at IS NOT NULL AND oe.removed_at IS NULL)
         OR EXISTS (SELECT 1 FROM surface_bindings sb WHERE sb.workspace_id = r.workspace_id AND sb.actor_role = 'owner'
                    AND sb.surface IN ('whatsapp', 'telegram', 'email'))
       )
     ORDER BY r.created_at ASC, r.id ASC
     LIMIT $4;`,
    [dayString(periodStart), dayString(periodEnd), templateIds, opts.batchSize]
  );
  for (const row of pending.rows) {
    try {
      const notice = await deliverReportNotice(row.workspace_id, row.id);
      result.notices += notice.sent;
    } catch (err) {
      fail(err);
    }
  }
  return result;
}
