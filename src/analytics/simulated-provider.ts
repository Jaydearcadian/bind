/**
 * A deterministic, fabricated post analytics provider (docs/decisions/0090). It is labelled `simulated` everywhere it surfaces.
 * It exists so the analysis, storage, reports and notices can be built and tested without a real account. It makes no network
 * call and holds no credential.
 *
 * Determinism: the posts of a day are a function of (workspaceId, accountId, the absolute UTC day). The same seed and window
 * always give the same posts, and a post on a given day is the same whatever window asked for it. Its output still goes
 * through the same validator as a real provider's.
 *
 * Shape, so the analysis has something realistic to find: reels and video reach more than images, a few hours of the day
 * draw more reach, followers make up a smaller share of a reel's reach, and reach is spread over a few countries.
 */
import { createHash } from "node:crypto";
import { DAY_MS } from "./time.js";
import {
  type FetchPostsRequest,
  type MediaType,
  type PostAnalyticsProvider,
  type ProviderAccount,
  type ProviderCapabilities,
  type ProviderPost,
} from "./types.js";

export const SIMULATED_PROVIDER_ID = "simulated";
/** How far back a simulated history reaches from the window's end. */
export const SIMULATED_WINDOW_DAYS = 90;

const CAPABILITIES: ProviderCapabilities = {
  perPostReach: true,
  followerSplit: true,
  hourOfDay: true,
  country: true,
  mediaType: true,
};

/** Hours a post is published in, and how many times each is drawn. Most posts fall in these hours. */
const POSTING_HOURS: ReadonlyArray<readonly [hour: number, weight: number]> = [
  [7, 1],
  [8, 1],
  [12, 2],
  [13, 2],
  [18, 2],
  [19, 2],
  [20, 2],
  [21, 1],
];
/** Reach multiplier by hour: evenings draw more. */
const HOUR_REACH: Readonly<Record<number, number>> = { 7: 0.9, 8: 0.95, 12: 1.1, 13: 1.05, 18: 1.35, 19: 1.45, 20: 1.3, 21: 1.1 };

const TYPE_WEIGHTS: ReadonlyArray<readonly [MediaType, number]> = [
  ["reel", 35],
  ["image", 30],
  ["carousel", 20],
  ["video", 10],
  ["story", 5],
];
const BASE_REACH: Readonly<Record<MediaType, number>> = { reel: 2600, video: 2000, image: 1000, carousel: 1300, story: 600, other: 800 };
/** Share of a post's reach that comes from followers. Reels reach beyond the follower base. */
const FOLLOWER_SHARE: Readonly<Record<MediaType, number>> = { reel: 0.35, video: 0.4, image: 0.6, carousel: 0.55, story: 0.7, other: 0.5 };
const COUNTRY_WEIGHTS: ReadonlyArray<readonly [string, number]> = [
  ["GB", 40],
  ["US", 20],
  ["IE", 10],
  ["DE", 8],
  ["AU", 7],
  ["CA", 8],
  ["FR", 7],
];

/** A 32-bit generator seeded from a hex digest. Same seed, same sequence. */
function generatorFor(seedHex: string): () => number {
  let state = Number.parseInt(seedHex.slice(0, 8), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The provider's account id for a Bind analytics account. Stable for the same workspace and account. */
export function simulatedExternalAccountId(workspaceId: string, accountId: string): string {
  return `sim_${digest(`bind-simulated-account:${workspaceId}:${accountId}`).slice(0, 16)}`;
}

function pick<T>(next: () => number, items: ReadonlyArray<readonly [T, number]>): T {
  const total = items.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = next() * total;
  for (const [item, weight] of items) {
    roll -= weight;
    if (roll < 0) return item;
  }
  return items[items.length - 1][0];
}

function between(next: () => number, low: number, high: number): number {
  return low + (high - low) * next();
}

/** The posts published on one UTC day, in publish order. */
function postsOnDay(seedHex: string, dayIndex: number, dayStart: number): ProviderPost[] {
  const next = generatorFor(digest(`${seedHex}:day:${dayIndex}`));
  const roll = next();
  const count = roll < 0.45 ? 0 : roll < 0.85 ? 1 : 2;
  const posts: ProviderPost[] = [];
  for (let i = 0; i < count; i += 1) {
    const hour = pick(next, POSTING_HOURS);
    const minute = Math.floor(next() * 60);
    const publishedAt = new Date(dayStart + hour * 3_600_000 + minute * 60_000);
    const mediaType = pick(next, TYPE_WEIGHTS);
    const reach = Math.max(1, Math.round(BASE_REACH[mediaType] * HOUR_REACH[hour] * between(next, 0.6, 1.4)));
    const impressions = Math.round(reach * between(next, 1.05, 1.45));
    const engagement = (low: number, high: number) => Math.round(reach * between(next, low, high));
    const likes = engagement(0.02, 0.06);
    const comments = engagement(0.002, 0.01);
    const saves = engagement(mediaType === "carousel" ? 0.012 : 0.005, mediaType === "carousel" ? 0.03 : 0.02);
    const shares = engagement(0.001, 0.006);
    const followerShare = Math.min(0.95, Math.max(0.05, FOLLOWER_SHARE[mediaType] + between(next, -0.08, 0.08)));
    const followerReach = Math.round(reach * followerShare);
    const metrics: ProviderPost["metrics"] = { reach, impressions, likes, comments, saves, shares };
    if (mediaType === "reel" || mediaType === "video") {
      metrics.plays = Math.min(impressions, Math.round(impressions * between(next, 0.6, 0.9)));
    }
    // Country reach: each country takes its share of the post's reach, rounded down, so the total never exceeds reach.
    const weights = COUNTRY_WEIGHTS.map(([code, weight]) => [code, weight * between(next, 0.7, 1.3)] as const);
    const totalWeight = weights.reduce((sum, [, w]) => sum + w, 0);
    const countryReach: Record<string, number> = {};
    for (const [code, weight] of weights) {
      const share = Math.floor((reach * weight) / totalWeight);
      if (share > 0) countryReach[code] = share;
    }
    posts.push({
      externalId: `sim_${dayIndex}_${i}`,
      publishedAt,
      mediaType,
      metrics,
      followerReach,
      nonFollowerReach: reach - followerReach,
      countryReach,
    });
  }
  return posts;
}

/**
 * A simulated provider for one analytics account. The seed is (workspaceId, accountId). The external account id it answers to is
 * the one `simulatedExternalAccountId` derives from the same seed; any other id is refused.
 */
export function createSimulatedProvider(seed: { workspaceId: string; accountId: string }): PostAnalyticsProvider {
  const seedHex = digest(`bind-simulated:${seed.workspaceId}:${seed.accountId}`);
  const externalId = simulatedExternalAccountId(seed.workspaceId, seed.accountId);

  return {
    id: SIMULATED_PROVIDER_ID,
    isSimulated: true,
    capabilities: CAPABILITIES,

    async listAccounts(): Promise<ProviderAccount[]> {
      return [{ externalId }];
    },

    async fetchPosts(request: FetchPostsRequest): Promise<ProviderPost[]> {
      if (request.accountId !== externalId) throw new Error("The simulated provider has no such account");
      const { since, until } = request;
      if (!(until.getTime() > since.getTime())) throw new RangeError("until must be after since");
      // Days in the window, never more than SIMULATED_WINDOW_DAYS before `until`.
      const earliest = Math.max(since.getTime(), until.getTime() - SIMULATED_WINDOW_DAYS * DAY_MS);
      const firstDay = Math.floor(earliest / DAY_MS);
      const lastDay = Math.floor((until.getTime() - 1) / DAY_MS);
      const out: ProviderPost[] = [];
      for (let day = firstDay; day <= lastDay; day += 1) {
        for (const post of postsOnDay(seedHex, day, day * DAY_MS)) {
          const t = post.publishedAt.getTime();
          if (t >= since.getTime() && t < until.getTime()) out.push(post);
        }
      }
      return out.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime() || (a.externalId < b.externalId ? -1 : 1));
    },
  };
}
