/**
 * The provider boundary (docs/decisions/0090). Every provider answer passes through here before anything is stored.
 *
 * - Only the keys named below are read. Any other key (a caption, a comment, a bio, a URL) is dropped without being looked at.
 * - Ids follow one pattern. An id with a space, a line break or a sentence is refused, so free text cannot pass as an id.
 * - Counts are whole numbers from 0 to MAX_COUNT. A NaN, an infinity, a fraction, a negative number or a huge number is refused.
 * - Reach cannot exceed impressions, and a follower or country share cannot exceed reach. Each is an inconsistent answer otherwise.
 * - A refusal throws AnalyticsProviderOutputError with a reason that names the field. It never repeats the value.
 */
import { AnalyticsProviderOutputError, MEDIA_TYPES, type MediaType, type ProviderAccount, type ProviderPost } from "./types.js";

/** The largest count accepted for any metric. A real account's reach is far below this. */
export const MAX_COUNT = 1_000_000_000;
/** Posts accepted from one fetch. Larger answers are refused rather than stored. */
export const MAX_POSTS_PER_FETCH = 5_000;
/** Countries accepted in one post's breakdown. */
export const MAX_COUNTRIES_PER_POST = 300;
/** Earliest and latest instants a post may carry. */
const MIN_PUBLISHED_MS = Date.UTC(2000, 0, 1);
const MAX_PUBLISHED_MS = Date.UTC(2100, 0, 1);

const EXTERNAL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const COUNTRY = /^[A-Z]{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;


function fail(reason: string): never {
  throw new AnalyticsProviderOutputError(reason);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An id the provider assigned. Refuses anything with a space, punctuation outside the set, or a length outside 1 to 128. */
export function parseExternalId(value: unknown, field: string): string {
  if (typeof value !== "string" || !EXTERNAL_ID.test(value)) {
    fail(`${field} must be 1 to 128 letters, digits or the characters _ . : -`);
  }
  return value;
}

/** A whole, finite count from 0 to MAX_COUNT. */
export function parseCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(`${field} must be a whole number`);
  if (value < 0) fail(`${field} must not be negative`);
  if (value > MAX_COUNT) fail(`${field} is larger than the allowed maximum`);
  return value;
}

/** The calendar date written in an ISO string must exist: 2026-02-30 is not a day. */
function isRealCalendarDate(text: string): boolean {
  const [year, month, day] = text.slice(0, 10).split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

function parseInstant(value: unknown, field: string): Date {
  let date: Date | null = null;
  if (value instanceof Date) date = value;
  else if (typeof value === "string" && ISO_INSTANT.test(value) && isRealCalendarDate(value)) date = new Date(value);
  if (date === null || Number.isNaN(date.getTime())) fail(`${field} must be an ISO 8601 date and time`);
  const ms = date.getTime();
  if (ms < MIN_PUBLISHED_MS || ms >= MAX_PUBLISHED_MS) fail(`${field} is outside the allowed years`);
  // "24" is not an hour of the day, although the parser would roll it to the next day.
  if (typeof value === "string" && value.slice(11, 13) === "24") fail(`${field} must be an ISO 8601 date and time`);
  return date;
}

function parseMediaType(value: unknown): MediaType {
  if (typeof value !== "string" || !(MEDIA_TYPES as readonly string[]).includes(value)) {
    fail(`mediaType must be one of ${MEDIA_TYPES.join(", ")}`);
  }
  return value as MediaType;
}

/** The metrics object, with its own allowlist. Unknown metric keys are dropped. */
function parseMetrics(value: unknown): ProviderPost["metrics"] {
  if (!isPlainObject(value)) fail("metrics must be an object");
  const picked = (name: string): unknown => value[name];
  const reach = parseCount(picked("reach"), "metrics.reach");
  const impressions = parseCount(picked("impressions"), "metrics.impressions");
  if (reach > impressions) fail("metrics.reach must not exceed metrics.impressions");
  const metrics: ProviderPost["metrics"] = {
    reach,
    impressions,
    likes: parseCount(picked("likes"), "metrics.likes"),
    comments: parseCount(picked("comments"), "metrics.comments"),
    saves: parseCount(picked("saves"), "metrics.saves"),
    shares: parseCount(picked("shares"), "metrics.shares"),
  };
  if (picked("plays") !== undefined && picked("plays") !== null) {
    metrics.plays = parseCount(picked("plays"), "metrics.plays");
  }
  return metrics;
}

function parseCountryReach(value: unknown, reach: number): Record<string, number> {
  if (!isPlainObject(value)) fail("countryReach must be an object of country codes to counts");
  const entries = Object.entries(value);
  if (entries.length > MAX_COUNTRIES_PER_POST) fail("countryReach lists too many countries");
  const out: Record<string, number> = {};
  for (const [code, count] of entries) {
    if (!COUNTRY.test(code)) fail("countryReach keys must be two capital letters (ISO 3166-1 alpha-2)");
    const n = parseCount(count, `countryReach.${code}`);
    if (n > reach) fail(`countryReach.${code} must not exceed the post's reach`);
    out[code] = n;
  }
  return out;
}

/**
 * One provider post, normalised. Unknown keys are ignored. The split and the country breakdown are optional, but the two split
 * counts come together or not at all.
 */
export function parseProviderPost(raw: unknown): ProviderPost {
  if (!isPlainObject(raw)) fail("a post must be an object");
  const externalId = parseExternalId(raw.externalId, "externalId");
  const publishedAt = parseInstant(raw.publishedAt, "publishedAt");
  const mediaType = parseMediaType(raw.mediaType);
  const metrics = parseMetrics(raw.metrics);

  const post: ProviderPost = { externalId, publishedAt, mediaType, metrics };
  const hasFollower = raw.followerReach !== undefined && raw.followerReach !== null;
  const hasNonFollower = raw.nonFollowerReach !== undefined && raw.nonFollowerReach !== null;
  if (hasFollower !== hasNonFollower) fail("followerReach and nonFollowerReach must be given together");
  if (hasFollower) {
    const followerReach = parseCount(raw.followerReach, "followerReach");
    const nonFollowerReach = parseCount(raw.nonFollowerReach, "nonFollowerReach");
    if (followerReach > metrics.reach || nonFollowerReach > metrics.reach) {
      fail("followerReach and nonFollowerReach must not exceed the post's reach");
    }
    post.followerReach = followerReach;
    post.nonFollowerReach = nonFollowerReach;
  }
  if (raw.countryReach !== undefined && raw.countryReach !== null) {
    post.countryReach = parseCountryReach(raw.countryReach, metrics.reach);
  }
  return post;
}

/** A fetch's answer: a list of posts, each validated, with no id repeated. */
export function parseProviderPosts(raw: unknown): ProviderPost[] {
  if (!Array.isArray(raw)) fail("the answer must be a list of posts");
  if (raw.length > MAX_POSTS_PER_FETCH) fail("the answer lists too many posts");
  const seen = new Set<string>();
  return raw.map((item) => {
    const post = parseProviderPost(item);
    if (seen.has(post.externalId)) fail("an externalId appears more than once");
    seen.add(post.externalId);
    return post;
  });
}

/** A provider's account list, with the same id rules. */
export function parseProviderAccounts(raw: unknown): ProviderAccount[] {
  if (!Array.isArray(raw)) fail("the answer must be a list of accounts");
  if (raw.length > 100) fail("the answer lists too many accounts");
  return raw.map((item) => {
    if (!isPlainObject(item)) fail("an account must be an object");
    return { externalId: parseExternalId(item.externalId, "externalId") };
  });
}
