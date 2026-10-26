/**
 * Deterministic post analysis (docs/decisions/0090). Pure: no model, no I/O, no clock. The same posts and options always give the
 * same findings and the same text.
 *
 * Rules that the tests pin:
 * - No comparison is stated from fewer than MIN_GROUP_POSTS posts. The text says "not enough posts yet" instead.
 * - An engagement rate is (likes + comments + saves + shares) / reach. A post with no reach has no rate and is left out of every
 *   rate, never divided by zero.
 * - Ties are broken by a fixed order (the hour, the post id), and the input is sorted before anything is counted, so the order
 *   the caller gives posts in does not change the answer.
 * - Hours are read in the account's time zone (Intl), so a daylight saving change is handled by the runtime.
 * - The text says "did better" or "did worse". It never gives a cause. It names the numbers, not the words of any post.
 * - Simulated data is marked as simulated in the findings and at the top of the text.
 */
import { hourInZone, isValidTimeZone, readableDay } from "./time.js";
import type { MediaType, ProviderCapabilities, ProviderPost } from "./types.js";

export const MIN_GROUP_POSTS = 5;
/** How many top and bottom posts are listed. Capped at half the ranked posts, so the two lists never overlap. */
export const RANKED_POSTS = 3;
export const COUNTRY_LIMIT = 3;
export const DEFAULT_TIME_ZONE = "UTC";

export type FormatGroup = "reel_or_video" | "image" | "carousel";
export type Outcome = "did_better" | "did_worse" | "about_the_same";
export type Status = "ok" | "not_enough_posts" | "not_supplied";

export interface GroupStat {
  group: FormatGroup;
  posts: number;
  enough: boolean;
  /** Null when the group has fewer than MIN_GROUP_POSTS posts. */
  medianReach: number | null;
  /** Median of the per-post rates, over the posts with reach. Null when the group is not enough, or has no reach. */
  medianEngagementRate: number | null;
}

export interface FormatComparison {
  against: "image" | "carousel";
  /** Null unless both groups have enough posts. */
  reach: { outcome: Outcome; reelMedian: number; otherMedian: number } | null;
  engagement: { outcome: Outcome; reelRate: number; otherRate: number } | null;
}

export interface FormatFindings {
  status: Status;
  groups: GroupStat[];
  comparisons: FormatComparison[];
}

export interface HourStat {
  hour: number;
  posts: number;
  medianReach: number;
}

export interface HourFindings {
  status: Status;
  timeZone: string;
  /** Hours with at least MIN_GROUP_POSTS posts, in hour order. */
  eligibleHours: HourStat[];
  best: HourStat | null;
  worst: HourStat | null;
  /** True when every eligible hour has the same median reach, so no hour stood out. */
  sameMedianReach: boolean;
}

export interface FollowerFindings {
  status: Status;
  posts: number;
  followerShare: number | null;
  nonFollowerShare: number | null;
}

export interface CountryStat {
  country: string;
  reach: number;
  share: number;
}

export interface CountryFindings {
  status: Status;
  posts: number;
  top: CountryStat[];
}

export interface RankedPost {
  externalId: string;
  mediaType: MediaType;
  publishedAt: string;
  reach: number;
  engagementRate: number;
}

export interface RankFindings {
  status: Status;
  eligible: number;
  top: RankedPost[];
  bottom: RankedPost[];
}

export interface Findings {
  simulated: boolean;
  timeZone: string;
  postCount: number;
  minimumGroupPosts: number;
  formats: FormatFindings;
  hours: HourFindings;
  followers: FollowerFindings;
  countries: CountryFindings;
  rankings: RankFindings;
}

export interface AnalyseOptions {
  timeZone?: string;
  simulated?: boolean;
  capabilities?: Partial<ProviderCapabilities>;
}

const ALL_CAPABILITIES: ProviderCapabilities = {
  perPostReach: true,
  followerSplit: true,
  hourOfDay: true,
  country: true,
  mediaType: true,
};

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The engagement rate of one post, or null when it has no reach. */
export function engagementRate(post: Pick<ProviderPost, "metrics">): number | null {
  const { reach, likes, comments, saves, shares } = post.metrics;
  if (reach <= 0) return null;
  return (likes + comments + saves + shares) / reach;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The fixed order every count uses: publish time, then the provider's id. */
function canonical(posts: readonly ProviderPost[]): ProviderPost[] {
  return [...posts].sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime() || compareIds(a.externalId, b.externalId));
}

function groupOf(mediaType: MediaType): FormatGroup | null {
  if (mediaType === "reel" || mediaType === "video") return "reel_or_video";
  if (mediaType === "image") return "image";
  if (mediaType === "carousel") return "carousel";
  return null;
}

/**
 * Two values are "about the same" unless they differ by at least MATERIAL_RELATIVE_DIFFERENCE of the larger one. A five-post
 * comparison can differ by a fraction of a percent by chance; that is not a finding. The inputs are the rounded values the text
 * prints, so the text never says "did worse" for two numbers it shows as equal.
 */
export const MATERIAL_RELATIVE_DIFFERENCE = 0.05;

function outcomeOf(subject: number, other: number): Outcome {
  const base = Math.max(Math.abs(subject), Math.abs(other));
  if (base === 0 || Math.abs(subject - other) / base < MATERIAL_RELATIVE_DIFFERENCE) return "about_the_same";
  return subject > other ? "did_better" : "did_worse";
}

/** Reach is printed to one decimal place (whole numbers print without one). */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** A rate is printed as a percentage to one decimal place, so it is compared at 0.1% (0.001). */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatFindings(posts: readonly ProviderPost[], supplied: boolean): FormatFindings {
  if (!supplied) return { status: "not_supplied", groups: [], comparisons: [] };
  const order: FormatGroup[] = ["reel_or_video", "image", "carousel"];
  const groups = order.map((group): GroupStat => {
    const members = posts.filter((p) => groupOf(p.mediaType) === group);
    const enough = members.length >= MIN_GROUP_POSTS;
    const rates = members.map(engagementRate).filter((r): r is number => r !== null);
    return {
      group,
      posts: members.length,
      enough,
      medianReach: enough ? median(members.map((p) => p.metrics.reach)) : null,
      medianEngagementRate: enough && rates.length > 0 ? round4(median(rates) as number) : null,
    };
  });
  const byGroup = new Map(groups.map((g) => [g.group, g]));
  const reel = byGroup.get("reel_or_video") as GroupStat;
  const comparisons: FormatComparison[] = (["image", "carousel"] as const).map((against) => {
    const other = byGroup.get(against) as GroupStat;
    const bothEnough = reel.enough && other.enough;
    const reach =
      bothEnough && reel.medianReach !== null && other.medianReach !== null
        ? (() => {
            const reelMedian = round1(reel.medianReach);
            const otherMedian = round1(other.medianReach);
            return { outcome: outcomeOf(reelMedian, otherMedian), reelMedian, otherMedian };
          })()
        : null;
    const engagement =
      bothEnough && reel.medianEngagementRate !== null && other.medianEngagementRate !== null
        ? (() => {
            const reelRate = round3(reel.medianEngagementRate);
            const otherRate = round3(other.medianEngagementRate);
            return { outcome: outcomeOf(reelRate, otherRate), reelRate, otherRate };
          })()
        : null;
    return { against, reach, engagement };
  });
  const anyEnough = groups.some((g) => g.enough);
  return { status: anyEnough ? "ok" : "not_enough_posts", groups, comparisons };
}

function hourFindings(posts: readonly ProviderPost[], timeZone: string, supplied: boolean): HourFindings {
  if (!supplied) return { status: "not_supplied", timeZone, eligibleHours: [], best: null, worst: null, sameMedianReach: false };
  const byHour = new Map<number, number[]>();
  for (const post of posts) {
    const hour = hourInZone(post.publishedAt, timeZone);
    byHour.set(hour, [...(byHour.get(hour) ?? []), post.metrics.reach]);
  }
  const eligibleHours: HourStat[] = [...byHour.entries()]
    .filter(([, reaches]) => reaches.length >= MIN_GROUP_POSTS)
    .map(([hour, reaches]) => ({ hour, posts: reaches.length, medianReach: median(reaches) as number }))
    .sort((a, b) => a.hour - b.hour);
  if (eligibleHours.length < 2) {
    return { status: "not_enough_posts", timeZone, eligibleHours, best: null, worst: null, sameMedianReach: false };
  }
  const byBest = [...eligibleHours].sort((a, b) => b.medianReach - a.medianReach || a.hour - b.hour);
  const byWorst = [...eligibleHours].sort((a, b) => a.medianReach - b.medianReach || a.hour - b.hour);
  const best = byBest[0];
  const worst = byWorst[0];
  return {
    status: "ok",
    timeZone,
    eligibleHours,
    best,
    worst,
    // "Same" is the materiality rule, on the values the text prints: two hours 1% apart do not stand out.
    sameMedianReach: outcomeOf(round1(best.medianReach), round1(worst.medianReach)) === "about_the_same",
  };
}

function followerFindings(posts: readonly ProviderPost[], supplied: boolean): FollowerFindings {
  if (!supplied) return { status: "not_supplied", posts: 0, followerShare: null, nonFollowerShare: null };
  const split = posts.filter((p) => p.followerReach !== undefined && p.nonFollowerReach !== undefined);
  if (split.length < MIN_GROUP_POSTS) return { status: "not_enough_posts", posts: split.length, followerShare: null, nonFollowerShare: null };
  let follower = 0;
  let nonFollower = 0;
  for (const post of split) {
    follower += post.followerReach as number;
    nonFollower += post.nonFollowerReach as number;
  }
  const total = follower + nonFollower;
  return {
    status: "ok",
    posts: split.length,
    followerShare: total > 0 ? round4(follower / total) : null,
    nonFollowerShare: total > 0 ? round4(nonFollower / total) : null,
  };
}

function countryFindings(posts: readonly ProviderPost[], supplied: boolean): CountryFindings {
  if (!supplied) return { status: "not_supplied", posts: 0, top: [] };
  const withCountries = posts.filter((p) => p.countryReach !== undefined);
  if (withCountries.length < MIN_GROUP_POSTS) return { status: "not_enough_posts", posts: withCountries.length, top: [] };
  const totals = new Map<string, number>();
  for (const post of withCountries) {
    for (const [code, reach] of Object.entries(post.countryReach as Record<string, number>)) {
      totals.set(code, (totals.get(code) ?? 0) + reach);
    }
  }
  const grand = [...totals.values()].reduce((sum, value) => sum + value, 0);
  const top = [...totals.entries()]
    .filter(([, reach]) => reach > 0)
    .sort((a, b) => b[1] - a[1] || compareIds(a[0], b[0]))
    .slice(0, COUNTRY_LIMIT)
    .map(([country, reach]) => ({ country, reach, share: grand > 0 ? round4(reach / grand) : 0 }));
  return { status: "ok", posts: withCountries.length, top };
}

function rankFindings(posts: readonly ProviderPost[]): RankFindings {
  const rated = posts
    .map((post) => ({ post, rate: engagementRate(post) }))
    .filter((row): row is { post: ProviderPost; rate: number } => row.rate !== null);
  if (rated.length < MIN_GROUP_POSTS) return { status: "not_enough_posts", eligible: rated.length, top: [], bottom: [] };
  const ranked = [...rated].sort((a, b) => b.rate - a.rate || compareIds(a.post.externalId, b.post.externalId));
  const count = Math.min(RANKED_POSTS, Math.floor(ranked.length / 2));
  const toRow = (row: { post: ProviderPost; rate: number }): RankedPost => ({
    externalId: row.post.externalId,
    mediaType: row.post.mediaType,
    publishedAt: row.post.publishedAt.toISOString(),
    reach: row.post.metrics.reach,
    engagementRate: round4(row.rate),
  });
  return {
    status: "ok",
    eligible: rated.length,
    top: ranked.slice(0, count).map(toRow),
    bottom: ranked.slice(ranked.length - count).reverse().map(toRow),
  };
}

/** The findings for a set of posts. Throws RangeError for an unknown time zone; it never returns a partial answer. */
export function analysePosts(posts: readonly ProviderPost[], options: AnalyseOptions = {}): Findings {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(timeZone)) throw new RangeError("The time zone is not a known IANA zone");
  const capabilities: ProviderCapabilities = { ...ALL_CAPABILITIES, ...(options.capabilities ?? {}) };
  const ordered = canonical(posts);
  return {
    simulated: options.simulated === true,
    timeZone,
    postCount: ordered.length,
    minimumGroupPosts: MIN_GROUP_POSTS,
    formats: formatFindings(ordered, capabilities.mediaType),
    hours: hourFindings(ordered, timeZone, capabilities.hourOfDay),
    followers: followerFindings(ordered, capabilities.followerSplit),
    countries: countryFindings(ordered, capabilities.country),
    rankings: rankFindings(ordered),
  };
}

/* ---------------------------------------------------------------------------------------------------------------------------
 * The text. Short paragraphs of numbers and plain words. A missing comparison says "not enough posts yet", never a guess.
 * ------------------------------------------------------------------------------------------------------------------------- */

const SIMULATED_NOTE = "Simulated data: these numbers are generated for testing and do not come from a real account.";
const NOT_ENOUGH = "Not enough posts yet";

function count(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A median: a whole number as a count, anything else with one decimal place. */
function amount(value: number): string {
  return Number.isInteger(value) ? count(value) : value.toFixed(1);
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

const FORMAT_WORD: Record<MediaType, string> = { reel: "reel", video: "video", image: "image", carousel: "carousel", story: "story", other: "post" };

/** One comparison sentence. `did better` and `did worse` are the only words for a difference. No cause is ever given. */
function comparisonSentence(outcome: Outcome, subject: string, other: string, metric: string, values: string): string {
  if (outcome === "did_better") return `${subject} did better than ${other} ${metric} (${values}).`;
  if (outcome === "did_worse") return `${subject} did worse than ${other} ${metric} (${values}).`;
  return `${subject} had about the same ${metric.replace(/^on /, "")} as ${other} (${values}).`;
}

function formatParagraph(formats: FormatFindings, minimum: number): string[] {
  if (formats.status === "not_supplied") return ["This source does not supply post formats."];
  const reel = formats.groups.find((g) => g.group === "reel_or_video") as GroupStat;
  const lines: string[] = [];
  for (const comparison of formats.comparisons) {
    const other = formats.groups.find((g) => g.group === comparison.against) as GroupStat;
    const otherName = comparison.against === "image" ? "images" : "carousels";
    if (comparison.reach) {
      lines.push(
        comparisonSentence(
          comparison.reach.outcome,
          "Reels and videos",
          otherName,
          "on median reach",
          `${amount(comparison.reach.reelMedian)} against ${amount(comparison.reach.otherMedian)}`
        )
      );
    } else {
      lines.push(
        `${NOT_ENOUGH} to compare reels and videos with ${otherName} on reach: ${reel.posts} and ${other.posts} posts, and at least ${minimum} of each are needed.`
      );
    }
    if (comparison.engagement) {
      lines.push(
        comparisonSentence(
          comparison.engagement.outcome,
          "Reels and videos",
          otherName,
          "on engagement rate",
          `${percent(comparison.engagement.reelRate)} against ${percent(comparison.engagement.otherRate)}`
        )
      );
    }
  }
  return lines;
}

function hoursParagraph(hours: HourFindings): string {
  if (hours.status === "not_supplied") return "This source does not supply the hour a post was published.";
  if (hours.status === "not_enough_posts" || !hours.best || !hours.worst) {
    return `${NOT_ENOUGH} to compare hours of the day: at least two hours need ${MIN_GROUP_POSTS} posts each.`;
  }
  if (hours.sameMedianReach) {
    return `No hour of the day stood out in ${hours.timeZone}: the median reach was the same for every hour with enough posts.`;
  }
  return `Posts published at ${hourLabel(hours.best.hour)} in ${hours.timeZone} did better than posts published at ${hourLabel(hours.worst.hour)} on median reach (${amount(hours.best.medianReach)} against ${amount(hours.worst.medianReach)}).`;
}

function followersParagraph(followers: FollowerFindings): string {
  if (followers.status === "not_supplied") return "This source does not supply a split between followers and non-followers.";
  if (followers.status === "not_enough_posts") return `${NOT_ENOUGH} to split reach between followers and non-followers.`;
  if (followers.followerShare === null || followers.nonFollowerShare === null) return "There was no reach to split between followers and non-followers.";
  return `Followers made up ${percent(followers.followerShare)} of reach and non-followers ${percent(followers.nonFollowerShare)}.`;
}

function countriesParagraph(countries: CountryFindings): string {
  if (countries.status === "not_supplied") return "This source does not supply reach by country.";
  if (countries.status === "not_enough_posts") return `${NOT_ENOUGH} to compare countries.`;
  if (countries.top.length === 0) return "No country reach was recorded in this period.";
  return `The countries with the most reach were ${countries.top.map((c) => `${c.country} (${percent(c.share)})`).join(", ")}.`;
}

function rankingsParagraph(rankings: RankFindings, timeZone: string): string {
  if (rankings.status !== "ok") return `${NOT_ENOUGH} to rank posts by engagement rate: at least ${MIN_GROUP_POSTS} posts with reach are needed.`;
  const describe = (post: RankedPost) => `${FORMAT_WORD[post.mediaType]} from ${readableDay(new Date(post.publishedAt), timeZone)} (${percent(post.engagementRate)})`;
  return `Highest engagement rate: ${rankings.top.map(describe).join("; ")}. Lowest engagement rate: ${rankings.bottom.map(describe).join("; ")}.`;
}

/** The plain-English report for a set of findings. Each paragraph is one line of the text; paragraphs are separated by a blank line. */
export function renderReportText(findings: Findings): string {
  const paragraphs: string[] = [];
  if (findings.simulated) paragraphs.push(SIMULATED_NOTE);
  if (findings.postCount === 0) {
    paragraphs.push(`${NOT_ENOUGH} to say anything about this period: no posts were published in it.`);
    return paragraphs.join("\n\n");
  }
  paragraphs.push(`This period has ${count(findings.postCount)} ${findings.postCount === 1 ? "post" : "posts"}.`);
  paragraphs.push(formatParagraph(findings.formats, findings.minimumGroupPosts).join(" "));
  paragraphs.push(hoursParagraph(findings.hours));
  paragraphs.push(followersParagraph(findings.followers));
  paragraphs.push(countriesParagraph(findings.countries));
  paragraphs.push(rankingsParagraph(findings.rankings, findings.timeZone));
  return paragraphs.join("\n\n");
}
