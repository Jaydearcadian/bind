/**
 * Post analytics service (docs/decisions/0091). Connects an analytics account, syncs its posts through a provider, writes one
 * report per period, and tells the owner that the report is ready.
 *
 * Guarantees:
 * - A sync is an idempotent upsert keyed by (workspace, account, external post id). Running it twice leaves the row count as it was.
 * - A sync attempt is claimed by one conditional update, so two attempts of one account are at least the minimum interval apart,
 *   whether they come from the API or the worker. A failing account backs off (15 minutes, doubling, capped at 12 hours; 12 hours
 *   for a provider that is not available or answers invalid data). A timeout bounds the provider call.
 * - A report is written at most once per (workspace, account or all brands, kind, period). Concurrent requests get the same row.
 *   A period with no stored posts is refused (ANALYTICS_NO_DATA_YET) rather than stored as an empty report.
 * - The owner is told at most once per (workspace, report) and recipient, through the effects ledger (ADR 0017, ADR 0074). A send
 *   that fails or is in doubt is audited at the first sight and is never sent again. The notice names no finding, no brand and no
 *   account; for simulated data it says so.
 * - Every query is scoped to the workspace. An id of another workspace is "not found".
 * - Only the simulated provider is available. Any other provider is refused before anything is read or written.
 */
import type { PoolClient } from "pg";
import { query, withTransaction } from "../db/client.js";
import { config } from "../config/env.js";
import { newId } from "../utils/ids.js";
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
  PROVIDER_OUTPUT_INVALID_CODE,
  type FetchPostsRequest,
  type PostAnalyticsProvider,
  type ProviderPost,
} from "./types.js";

export const TEMPLATE_NO_ANALYTICS_CODE = "TEMPLATE_HAS_NO_ANALYTICS" as const;
export const SYNC_TOO_SOON_CODE = "ANALYTICS_SYNC_TOO_SOON" as const;
export const NO_DATA_CODE = "ANALYTICS_NO_DATA_YET" as const;
export const PROVIDER_UNAVAILABLE_CODE = "ANALYTICS_PROVIDER_UNAVAILABLE" as const;
export const MAX_ACCOUNTS_PER_WORKSPACE = 10;
/** The window a sync reads: the last 90 UTC days, ending at the start of the sync's day. */
export const SYNC_WINDOW_DAYS = 90;
/** The longest a provider call may take before the sync gives up (the provider is also sent the abort signal). */
export const SYNC_TIMEOUT_MS = 20_000;
/** Backoff after a failed sync or report: 15 minutes, doubling, capped at 12 hours. */
export const BACKOFF_BASE_SECONDS = 15 * 60;
export const BACKOFF_CAP_SECONDS = 12 * 60 * 60;
/** A report that has no posts yet is looked at again in an hour. It is not a failure. */
export const NO_DATA_DEFER_SECONDS = 60 * 60;
/** A recipient the notice could not be handed to (failed before its ledger row existed) is tried this many times, then audited. */
export const MAX_NOTICE_ATTEMPTS = 3;
/** The weekly report's actor, on its audit rows. */
export const SYSTEM_ACTOR = { type: "system" as const, id: "system:analytics" };
const ENGINE = new WorkflowEngine();
const BRAND_LABEL_MAX = 80;
const MAX_LIST = 50;
const SLOW_FAILURE_CODES: ReadonlySet<string> = new Set([PROVIDER_NOT_AVAILABLE_CODE, PROVIDER_OUTPUT_INVALID_CODE]);

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

/** The module check, then the demo refusal for every write. A demo workspace is read-only for analytics. */
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

/**
 * Test seam: replaces the provider for accounts, so a test can make a provider hang or fail. It works only when NODE_ENV is
 * `test`; production code cannot arm it.
 */
let providerOverride: ((account: { workspace_id: string; id: string; provider: string }) => PostAnalyticsProvider | null) | null = null;
let syncTimeoutMs = SYNC_TIMEOUT_MS;
export function setAnalyticsProviderForTests(
  override: ((account: { workspace_id: string; id: string; provider: string }) => PostAnalyticsProvider | null) | null,
  timeoutMs?: number
): void {
  if (process.env.NODE_ENV !== "test") throw new Error("The analytics provider can only be replaced when NODE_ENV is 'test'");
  providerOverride = override;
  syncTimeoutMs = timeoutMs ?? SYNC_TIMEOUT_MS;
}

/** The provider for a stored account. Only `simulated` exists in this slice; any other stored value is refused, not guessed. */
export function providerForAccount(account: Pick<AccountRow, "workspace_id" | "id" | "provider">): PostAnalyticsProvider {
  const overridden = providerOverride?.(account) ?? null;
  if (overridden) return overridden;
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
 * ANALYTICS_PROVIDER_NOT_AVAILABLE before the workspace is read. The count of accounts is taken under the workspace's row lock,
 * so concurrent requests cannot take the account count past the limit. The audit row holds ids and the provider's name only.
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
    // The workspace row is locked for the rest of this transaction: two creates for one workspace run one after the other.
    await client.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE;`, [workspaceId]);
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
 * Sync attempts: the throttle, the timeout and the backoff
 * ------------------------------------------------------------------------------------------------------------------------- */

/**
 * Claims the account's next sync attempt. One conditional update: it succeeds only when the last attempt is at least the minimum
 * interval old, so two attempts (API or worker) cannot both pass. Returns the seconds to wait when it refuses.
 */
async function claimSyncAttempt(workspaceId: string, accountId: string, now: Date): Promise<{ claimed: true } | { claimed: false; retryAfterSeconds: number }> {
  const minIntervalMs = config.BIND_ANALYTICS_MIN_SYNC_INTERVAL_MS;
  const claimed = await query(
    `UPDATE analytics_accounts SET last_sync_attempt_at = $3::timestamptz
     WHERE workspace_id = $1 AND id = $2 AND (last_sync_attempt_at IS NULL OR last_sync_attempt_at <= $4::timestamptz)
     RETURNING id;`,
    [workspaceId, accountId, now.toISOString(), new Date(now.getTime() - minIntervalMs).toISOString()]
  );
  if ((claimed.rowCount ?? 0) === 1) return { claimed: true };
  const last = await query<{ last: Date }>(`SELECT last_sync_attempt_at AS last FROM analytics_accounts WHERE workspace_id = $1 AND id = $2;`, [workspaceId, accountId]);
  const lastMs = last.rows[0]?.last ? new Date(last.rows[0].last).getTime() : now.getTime();
  return { claimed: false, retryAfterSeconds: Math.max(1, Math.ceil((lastMs + minIntervalMs - now.getTime()) / 1000)) };
}

/**
 * Records a failed attempt: the account waits before its next attempt. Provider-level failures wait the longest.
 * `priorFailures` is the count the account had before this attempt. The weekly job passes it when a report fails after its sync
 * succeeded (a good sync resets the count), so a failing report still backs off further each time.
 */
async function recordFailure(workspaceId: string, accountId: string, code: string, now: Date, priorFailures?: number): Promise<void> {
  if (priorFailures !== undefined) {
    const seconds = SLOW_FAILURE_CODES.has(code) ? BACKOFF_CAP_SECONDS : Math.min(BACKOFF_BASE_SECONDS * 2 ** priorFailures, BACKOFF_CAP_SECONDS);
    await query(
      `UPDATE analytics_accounts SET consecutive_failures = $3::int + 1, next_attempt_at = $4::timestamptz + make_interval(secs => $5::float8)
       WHERE workspace_id = $1 AND id = $2;`,
      [workspaceId, accountId, priorFailures, now.toISOString(), seconds]
    );
    return;
  }
  await query(
    `UPDATE analytics_accounts
     SET consecutive_failures = consecutive_failures + 1,
         next_attempt_at = $3::timestamptz + make_interval(secs => CASE WHEN $4::boolean
           THEN $5::float8
           ELSE LEAST($6::float8 * power(2::float8, consecutive_failures::float8), $5::float8) END)
     WHERE workspace_id = $1 AND id = $2;`,
    [workspaceId, accountId, now.toISOString(), SLOW_FAILURE_CODES.has(code), BACKOFF_CAP_SECONDS, BACKOFF_BASE_SECONDS]
  );
}

/** A report was written from the account's posts: the account's backoff is over. */
async function clearBackoff(workspaceId: string, accountId: string): Promise<void> {
  await query(`UPDATE analytics_accounts SET consecutive_failures = 0, next_attempt_at = NULL WHERE workspace_id = $1 AND id = $2;`, [workspaceId, accountId]);
}

/** Puts the account off for a fixed time without counting a failure (a report with no posts yet). */
async function deferAccount(workspaceId: string, accountId: string, now: Date, seconds: number): Promise<void> {
  await query(
    `UPDATE analytics_accounts SET next_attempt_at = $3::timestamptz + make_interval(secs => $4::float8) WHERE workspace_id = $1 AND id = $2;`,
    [workspaceId, accountId, now.toISOString(), seconds]
  );
}

/** The provider's answer within the timeout, validated. A provider that hangs is abandoned with a fixed message. */
async function fetchWithTimeout(provider: PostAnalyticsProvider, request: Omit<FetchPostsRequest, "signal">): Promise<ProviderPost[]> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AnalyticsError(PROVIDER_UNAVAILABLE_CODE, 502, "The analytics provider did not answer in time. Nothing was stored."));
    }, syncTimeoutMs);
  });
  try {
    const raw = await Promise.race([provider.fetchPosts({ ...request, signal: controller.signal }), timeout]);
    return parseProviderPosts(raw);
  } catch (err) {
    if (err instanceof AnalyticsError || err instanceof AnalyticsProviderOutputError) throw err;
    // The provider's own message is not logged or repeated: with a real provider it is untrusted text.
    log.warn("analytics.provider_failed", { provider: provider.id, reason: err instanceof Error ? err.name : "unknown" });
    throw new AnalyticsError(PROVIDER_UNAVAILABLE_CODE, 502, "The analytics provider did not answer. Nothing was stored.");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  -- A row already stored with the same values is left alone (and not returned): a sync with no new data changes nothing.
  WHERE ROW(analytics_posts.media_type, analytics_posts.published_at, analytics_posts.reach, analytics_posts.impressions,
            analytics_posts.likes, analytics_posts.comments, analytics_posts.saves, analytics_posts.shares, analytics_posts.plays,
            analytics_posts.follower_reach, analytics_posts.non_follower_reach, analytics_posts.country_reach)
        IS DISTINCT FROM
        ROW(EXCLUDED.media_type, EXCLUDED.published_at, EXCLUDED.reach, EXCLUDED.impressions,
            EXCLUDED.likes, EXCLUDED.comments, EXCLUDED.saves, EXCLUDED.shares, EXCLUDED.plays,
            EXCLUDED.follower_reach, EXCLUDED.non_follower_reach, EXCLUDED.country_reach)
  RETURNING (xmax = 0) AS inserted;`;

/** Sorted by the provider's id, so two syncs take the upsert's row locks in the same order. */
function byExternalId(a: ProviderPost, b: ProviderPost): number {
  return a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0;
}

/**
 * The posts as parallel arrays, one entry per post, for a single unnest insert, in provider-id order. Nullable values are NULL.
 * The order is part of this function, so every caller that writes posts gets it.
 */
export function upsertArrays(input: readonly ProviderPost[]) {
  const posts = [...input].sort(byExternalId);
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
 * Fetches the account's recent posts from its provider and stores them. An attempt is claimed first (the minimum interval). A
 * failed fetch or an invalid answer stores nothing and puts the account into backoff. A good sync writes its rows, its audit row
 * (`analytics.synced`, once per real sync) and resets the backoff, in one transaction.
 */
export async function syncAccount(workspaceId: string, accountId: string, actor: AnalyticsActor, now: Date = new Date()): Promise<SyncResult> {
  await assertWritable(workspaceId);
  const account = await loadAccount(workspaceId, accountId);
  if (account.status !== "active") throw new AnalyticsError("ANALYTICS_ACCOUNT_DISABLED", 409, "This analytics account is disabled.");

  const claim = await claimSyncAttempt(workspaceId, accountId, now);
  if (!claim.claimed) {
    throw new AnalyticsError(SYNC_TOO_SOON_CODE, 429, "This account was synced too recently. Try again later.", claim.retryAfterSeconds);
  }

  const until = startOfUtcDay(now);
  const since = addDays(until, -SYNC_WINDOW_DAYS);
  let posts: ProviderPost[];
  let provider: PostAnalyticsProvider;
  try {
    // A stored provider that is no longer available is a failure like any other: the account backs off.
    provider = providerForAccount(account);
    posts = await fetchWithTimeout(provider, { accountId: account.external_account_id, since, until });
  } catch (err) {
    const code = err instanceof AnalyticsError || err instanceof AnalyticsProviderOutputError ? err.code : PROVIDER_UNAVAILABLE_CODE;
    await recordFailure(workspaceId, accountId, code, now);
    throw err;
  }
  const arrays = upsertArrays(posts);

  return withTransaction(async (client: PoolClient) => {
    let inserted = 0;
    let changed = 0;
    if (posts.length > 0) {
      const res = await client.query<{ inserted: boolean }>(UPSERT_POSTS, [
        workspaceId,
        accountId,
        now.toISOString(),
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
      changed = res.rows.length;
      // Every post this sync covered is stamped with its time, changed or not: the account view shows the latest stamp.
      await client.query(
        `UPDATE analytics_posts SET synced_at = $3::timestamptz WHERE workspace_id = $1 AND account_id = $2 AND external_id = ANY($4::text[]);`,
        [workspaceId, accountId, now.toISOString(), arrays.externalIds]
      );
    }
    const updated = posts.length - inserted;
    await client.query(
      `UPDATE analytics_accounts SET last_sync_at = $3::timestamptz, consecutive_failures = 0, next_attempt_at = NULL
       WHERE workspace_id = $1 AND id = $2;`,
      [workspaceId, accountId, now.toISOString()]
    );
    // A sync that brought no new or changed post is not audited: the backoff and the attempt time above still record it.
    if (changed > 0) {
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
    }
    return { accountId, posts: posts.length, inserted, updated, syncedAt: now.toISOString(), simulated: provider.isSimulated };
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

async function findReportRow(workspaceId: string, accountId: string | null, kind: string, start: Date, end: Date): Promise<ReportRow | null> {
  const existing = await query<ReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM analytics_reports
     WHERE workspace_id = $1 AND COALESCE(account_id, '') = $2 AND kind = $3
       AND period_start = $4::date AND period_end = $5::date;`,
    [workspaceId, accountId ?? "", kind, dayString(start), dayString(end)]
  );
  return existing.rows[0] ?? null;
}

/**
 * Writes the report for one period, once. A period that already has its report returns that row. Otherwise the stored posts of
 * the period are analysed; a period with no stored posts is refused (409 ANALYTICS_NO_DATA_YET) and nothing is written, so an
 * empty report is never kept for the period. The insert is `ON CONFLICT DO NOTHING` on the period key; the audit row is written
 * only with the insert, in the same transaction.
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

  const stored = await findReportRow(workspaceId, input.accountId, input.kind, start, end);
  if (stored) return { report: toReportView(stored), created: false };

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
  if (rows.rows.length === 0) {
    throw new AnalyticsError(NO_DATA_CODE, 409, "No posts are stored for this period yet. Sync the account, then ask again.");
  }
  const simulated = rows.rows.some((row) => row.is_simulated);
  // A report over all brands is read in UTC: each brand has its own zone, and one hour must mean one thing.
  const findings = analysePosts(rows.rows.map(rowToPost), { timeZone: input.accountId === null ? "UTC" : timeZone, simulated });
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
  if (written) return { report: await loadReportView(workspaceId, id), created: true };
  const existing = await findReportRow(workspaceId, input.accountId, input.kind, start, end);
  if (!existing) throw new Error("The report for this period is not available; retry later.");
  return { report: toReportView(existing), created: false };
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
  /** A send that started and has no recorded outcome. Not sent again; audited as `notification.in_doubt`. */
  inDoubt: number;
  skipped: number;
  /** Already sent to this recipient by an earlier call: nothing was sent now. */
  alreadySent: number;
  /** The provider refused, or the call failed before it was recorded. Audited as `notification.failed`; not sent again. */
  failed: number;
  /** A started or failed send recorded by an earlier call: not sent again, and not audited again. */
  alreadyRecorded: number;
  /**
   * The send failed before its ledger row existed, so nothing is recorded as sent or refused. The report stays not done and the
   * next pass tries again, up to MAX_NOTICE_ATTEMPTS deliveries; then it is audited (`notification.failed`) and the report is done.
   */
  untried: number;
}

/**
 * Tells the owner that a report is ready. Each recipient is told at most once, through the effects ledger: a recipient whose row
 * is completed is not contacted again, and a row that started or failed is not sent again either. A failure or an in-doubt send is
 * audited at the first sight (the dispatcher audits an in-doubt result it sees itself; a thrown failure is audited here). When every
 * recipient has been dealt with, the report is marked done, so the weekly job stops looking at it.
 *
 * The message names no finding and no brand. For simulated data it says "(sample data)". The owner-notice path is the one approval
 * notices use, so email delivery off or simulated, and demo refusal, apply as they do there (ADR 0074).
 */
export async function deliverReportNotice(workspaceId: string, reportId: string): Promise<NoticeOutcome> {
  const report = await loadReportView(workspaceId, reportId);
  const recipients = await resolveOwnerRecipients(workspaceId);
  const outcome: NoticeOutcome = {
    recipients: recipients.length,
    sent: 0,
    inDoubt: 0,
    skipped: 0,
    alreadySent: 0,
    failed: 0,
    alreadyRecorded: 0,
    untried: 0,
  };
  const label = report.simulated ? "Your report is ready (sample data)." : "Your report is ready.";
  for (const recipient of recipients) {
    const key = ownerNoticeIdempotencyKey(workspaceId, "analytics_report", reportId, recipient.recipientId);
    const existing = await query<{ id: string; status: string }>(`SELECT id, status FROM effects WHERE idempotency_key = $1;`, [key]);
    const status = existing.rows[0]?.status;
    if (status === "completed") {
      outcome.alreadySent += 1;
      continue;
    }
    if (status === "started" || status === "failed") {
      // Already recorded by an earlier call: the send is not repeated, and the audit row written then stands.
      outcome.alreadyRecorded += 1;
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
          title: label,
          message: `${label} Open Bind to read it.`,
          metadata: { simulated: report.simulated },
        },
      });
      if (result.sent) outcome.sent += 1;
      else if (result.reason === "in_doubt") outcome.inDoubt += 1;
      else outcome.skipped += 1;
    } catch (err) {
      // The ledger says which it was: a row left `started` is in doubt (the send may have happened); a row marked `failed` is a refusal.
      const after = await query<{ id: string; status: string }>(`SELECT id, status FROM effects WHERE idempotency_key = $1;`, [key]);
      const row = after.rows[0];
      if (!row) {
        // Failed before the ledger row was written: nothing was sent and nothing is recorded. Not audited yet (see below).
        outcome.untried += 1;
        log.warn("analytics.notice_not_tried", { workspaceId, reportId, reason: err instanceof Error ? err.name : "unknown" });
        continue;
      }
      const inDoubt = row.status === "started";
      const evidence: Record<string, unknown> = { kind: "analytics_report", refId: reportId, effectId: row.id };
      await ENGINE.recordAudit(
        workspaceId,
        null,
        "system",
        SYSTEM_ACTOR.id,
        EffectClass.EXTERNAL_REQUEST,
        inDoubt ? "notification.in_doubt" : "notification.failed",
        PolicyDecision.ALLOW,
        evidence
      );
      if (inDoubt) outcome.inDoubt += 1;
      else outcome.failed += 1;
      log.warn("analytics.notice_not_sent", { workspaceId, reportId, outcome: inDoubt ? "in_doubt" : "failed", reason: err instanceof Error ? err.name : "unknown" });
    }
  }
  if (outcome.untried > 0) {
    const tries = await query<{ attempts: number }>(
      `UPDATE analytics_reports SET notice_attempts = notice_attempts + 1 WHERE workspace_id = $1 AND id = $2 RETURNING notice_attempts AS attempts;`,
      [workspaceId, reportId]
    );
    // Not done: the next pass tries the untried recipients again.
    if (Number(tries.rows[0]?.attempts ?? 0) < MAX_NOTICE_ATTEMPTS) return outcome;
    // The tries have run out. The recipients that were never reached are audited once, here, and the report is done.
    await ENGINE.recordAudit(
      workspaceId,
      null,
      "system",
      SYSTEM_ACTOR.id,
      EffectClass.EXTERNAL_REQUEST,
      "notification.failed",
      PolicyDecision.ALLOW,
      { kind: "analytics_report", refId: reportId, reason: "not_attempted", untried: outcome.untried, attempts: MAX_NOTICE_ATTEMPTS }
    );
    outcome.failed += outcome.untried;
  }
  await query(`UPDATE analytics_reports SET notice_done = TRUE WHERE workspace_id = $1 AND id = $2;`, [workspaceId, reportId]);
  return outcome;
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * The weekly job (called by the worker, docs/decisions/0091)
 * ------------------------------------------------------------------------------------------------------------------------- */

export interface WeeklyReportsResult {
  /** Accounts whose sync was stored in this pass. */
  synced: number;
  /** Accounts whose sync was skipped because it was attempted within the minimum interval. */
  skippedRecentSync: number;
  reports: number;
  notices: number;
  noticesInDoubt: number;
  /** Accounts or notices that failed in this pass (each one is audited or recorded, and backs off or is not retried). */
  failed: number;
  /** Accounts that had no posts yet for the period; looked at again later, and not a failure. */
  deferred: number;
  errors: string[];
}

/** The template ids whose template has an analytics data source. */
export function templateIdsWithAnalytics(): string[] {
  return listTemplates().filter(templateHasAnalytics).map((t) => t.templateId);
}

function errorCode(err: unknown): string | null {
  return err instanceof AnalyticsError || err instanceof AnalyticsProviderOutputError ? err.code : null;
}

/**
 * One pass of the weekly job. The period is the last full ISO week (Monday to Monday, UTC).
 *
 * Step one takes the active accounts of real analytics workspaces that have no weekly report for that week and are not in backoff,
 * oldest-due first, at most `batchSize` of them. For each it syncs (unless the account was attempted within the minimum interval) and
 * writes the week's report. A failing account is recorded and backs off, so the next pass serves the others. Step two tells the owner
 * about each weekly report of that week that is not yet done. Both steps stop starting new work after `deadlineMs`.
 * A replay of a pass does nothing that was already done.
 */
export async function runWeeklyAnalyticsReports(opts: {
  now: Date;
  batchSize: number;
  deadlineMs?: number;
  /** Restricts the pass to these workspaces. Tests use it so one file's pass does not reach another file's rows. Omitted in production. */
  workspaceIds?: string[];
}): Promise<WeeklyReportsResult> {
  const result: WeeklyReportsResult = { synced: 0, skippedRecentSync: 0, reports: 0, notices: 0, noticesInDoubt: 0, failed: 0, deferred: 0, errors: [] };
  const templateIds = templateIdsWithAnalytics();
  if (templateIds.length === 0) return result;
  const periodEnd = startOfIsoWeek(opts.now);
  const periodStart = addDays(periodEnd, -7);
  const startedAt = Date.now();
  const outOfTime = () => opts.deadlineMs !== undefined && Date.now() - startedAt > opts.deadlineMs;
  const note = (err: unknown) => result.errors.push(`${errorCode(err) ?? "ERROR"}`);

  const scope = opts.workspaceIds ?? null;
  const due = await query<{ workspace_id: string; id: string; consecutive_failures: number }>(
    `SELECT a.workspace_id, a.id, a.consecutive_failures
     FROM analytics_accounts a
     JOIN workspaces w ON w.id = a.workspace_id
     WHERE a.status = 'active' AND NOT w.is_demo AND w.template_id = ANY($1::text[])
       AND (a.next_attempt_at IS NULL OR a.next_attempt_at <= $5::timestamptz)
       AND NOT EXISTS (
         SELECT 1 FROM analytics_reports r
         WHERE r.workspace_id = a.workspace_id AND r.account_id = a.id AND r.kind = 'weekly'
           AND r.period_start = $2::date AND r.period_end = $3::date)
       AND ($6::text[] IS NULL OR a.workspace_id = ANY($6::text[]))
     ORDER BY a.next_attempt_at ASC NULLS FIRST, a.created_at ASC, a.id ASC
     LIMIT $4;`,
    [templateIds, dayString(periodStart), dayString(periodEnd), opts.batchSize, opts.now.toISOString(), scope]
  );
  for (const row of due.rows) {
    if (outOfTime()) break;
    let stage: "sync" | "report" | "notice" = "sync";
    try {
      try {
        await syncAccount(row.workspace_id, row.id, SYSTEM_ACTOR, opts.now);
        result.synced += 1;
      } catch (err) {
        // A sync refused for the interval is not a failure: the report is written from the posts already stored.
        if (errorCode(err) !== SYNC_TOO_SOON_CODE) throw err;
        result.skippedRecentSync += 1;
      }
      stage = "report";
      const generated = await generateReport(row.workspace_id, { accountId: row.id, kind: "weekly", periodStart, periodEnd }, SYSTEM_ACTOR, opts.now);
      if (generated.created) result.reports += 1;
      await clearBackoff(row.workspace_id, row.id);
      stage = "notice";
      const notice = await deliverReportNotice(row.workspace_id, generated.report.id);
      result.notices += notice.sent;
      result.noticesInDoubt += notice.inDoubt;
      result.failed += notice.failed;
    } catch (err) {
      if (errorCode(err) === NO_DATA_CODE) {
        result.deferred += 1;
        await deferAccount(row.workspace_id, row.id, opts.now, NO_DATA_DEFER_SECONDS);
        continue;
      }
      result.failed += 1;
      note(err);
      // A sync failure was recorded by syncAccount. A failure after a good sync is recorded here with the count the account had
      // before this pass, because the sync reset it: the wait keeps doubling while the report keeps failing (review S-A).
      if (stage !== "sync") await recordFailure(row.workspace_id, row.id, errorCode(err) ?? "ERROR", opts.now, Number(row.consecutive_failures));
    }
  }

  // Weekly reports of this week whose owners have not all been dealt with. Oldest first, bounded by the same batch size.
  const pending = await query<{ workspace_id: string; id: string }>(
    `SELECT r.workspace_id, r.id
     FROM analytics_reports r
     JOIN workspaces w ON w.id = r.workspace_id
     WHERE r.kind = 'weekly' AND r.period_start = $1::date AND r.period_end = $2::date
       AND NOT w.is_demo AND w.template_id = ANY($3::text[])
       AND r.notice_done = FALSE
       AND ($5::text[] IS NULL OR r.workspace_id = ANY($5::text[]))
     ORDER BY r.created_at ASC, r.id ASC
     LIMIT $4;`,
    [dayString(periodStart), dayString(periodEnd), templateIds, opts.batchSize, scope]
  );
  for (const row of pending.rows) {
    if (outOfTime()) break;
    try {
      const notice = await deliverReportNotice(row.workspace_id, row.id);
      result.notices += notice.sent;
      result.noticesInDoubt += notice.inDoubt;
      result.failed += notice.failed;
    } catch (err) {
      result.failed += 1;
      note(err);
    }
  }
  return result;
}
