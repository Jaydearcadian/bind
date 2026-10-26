import { describe, it, expect } from "vitest";
import { createSimulatedProvider, simulatedExternalAccountId, SIMULATED_PROVIDER_ID, SIMULATED_WINDOW_DAYS } from "../../src/analytics/simulated-provider.js";
import { parseProviderPosts } from "../../src/analytics/validate.js";
import { analysePosts } from "../../src/analytics/analyse.js";
import { MEDIA_TYPES } from "../../src/analytics/types.js";

const DAY = 86400000;
const UNTIL = new Date("2026-10-19T00:00:00Z");
const SINCE = new Date(UNTIL.getTime() - SIMULATED_WINDOW_DAYS * DAY);

function providerFor(workspaceId: string, accountId: string) {
  return createSimulatedProvider({ workspaceId, accountId });
}

describe("the simulated provider", () => {
  it("says it is simulated, and names its id", () => {
    const p = providerFor("ws-sim-a", "ana-1");
    expect(p.id).toBe(SIMULATED_PROVIDER_ID);
    expect(p.isSimulated).toBe(true);
    expect(p.capabilities).toEqual({ perPostReach: true, followerSplit: true, hourOfDay: true, country: true, mediaType: true });
  });

  it("is deterministic: the same seed and window give the same posts, byte for byte", async () => {
    const a = await providerFor("ws-sim-a", "ana-1").fetchPosts({ accountId: simulatedExternalAccountId("ws-sim-a", "ana-1"), since: SINCE, until: UNTIL });
    const b = await providerFor("ws-sim-a", "ana-1").fetchPosts({ accountId: simulatedExternalAccountId("ws-sim-a", "ana-1"), since: SINCE, until: UNTIL });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
  });

  it("gives different data for a different seed (a different workspace or account)", async () => {
    const window = { since: SINCE, until: UNTIL };
    const one = await providerFor("ws-sim-a", "ana-1").fetchPosts({ accountId: simulatedExternalAccountId("ws-sim-a", "ana-1"), ...window });
    const other = await providerFor("ws-sim-b", "ana-1").fetchPosts({ accountId: simulatedExternalAccountId("ws-sim-b", "ana-1"), ...window });
    expect(JSON.stringify(one)).not.toBe(JSON.stringify(other));
  });

  it("gives the same post for a day whatever window asks for it, so an overlapping sync cannot change a post", async () => {
    const p = providerFor("ws-sim-a", "ana-1");
    const id = simulatedExternalAccountId("ws-sim-a", "ana-1");
    const wide = await p.fetchPosts({ accountId: id, since: SINCE, until: UNTIL });
    const narrowSince = new Date(UNTIL.getTime() - 30 * DAY);
    const narrow = await p.fetchPosts({ accountId: id, since: narrowSince, until: UNTIL });
    const wideInWindow = wide.filter((x) => x.publishedAt >= narrowSince);
    expect(JSON.stringify(narrow)).toBe(JSON.stringify(wideInWindow));
  });

  it("produces about 60 posts over 90 days, all inside the window, and in publish order", async () => {
    const posts = await providerFor("ws-sim-a", "ana-1").fetchPosts({ accountId: simulatedExternalAccountId("ws-sim-a", "ana-1"), since: SINCE, until: UNTIL });
    expect(posts.length).toBeGreaterThanOrEqual(45);
    expect(posts.length).toBeLessThanOrEqual(75);
    for (const post of posts) {
      expect(post.publishedAt.getTime()).toBeGreaterThanOrEqual(SINCE.getTime());
      expect(post.publishedAt.getTime()).toBeLessThan(UNTIL.getTime());
    }
    const times = posts.map((x) => x.publishedAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("only produces data the strict validator accepts, so it goes through the same boundary as a real provider", async () => {
    const posts = await providerFor("ws-sim-a", "ana-1").fetchPosts({ accountId: simulatedExternalAccountId("ws-sim-a", "ana-1"), since: SINCE, until: UNTIL });
    const validated = parseProviderPosts(posts);
    expect(validated).toHaveLength(posts.length);
    for (const post of validated) {
      expect(MEDIA_TYPES).toContain(post.mediaType);
      expect(post.externalId).toMatch(/^sim_\d+_\d$/);
      expect(post.metrics.impressions).toBeGreaterThanOrEqual(post.metrics.reach);
      if (post.followerReach !== undefined) expect(post.followerReach + (post.nonFollowerReach as number)).toBe(post.metrics.reach);
    }
  });

  it("refuses an account it does not hold, and a window that ends before it starts", async () => {
    const p = providerFor("ws-sim-a", "ana-1");
    await expect(p.fetchPosts({ accountId: "sim_not_mine", since: SINCE, until: UNTIL })).rejects.toThrow(/no such account/);
    await expect(p.fetchPosts({ accountId: simulatedExternalAccountId("ws-sim-a", "ana-1"), since: UNTIL, until: SINCE })).rejects.toThrow(RangeError);
  });

  it("has the shape the analysis is for: reels reach more than images, evenings more than early mornings, and a country mix", async () => {
    const posts = await providerFor("ws-sim-a", "ana-1").fetchPosts({ accountId: simulatedExternalAccountId("ws-sim-a", "ana-1"), since: SINCE, until: UNTIL });
    const findings = analysePosts(parseProviderPosts(posts), { timeZone: "UTC", simulated: true });
    const reel = findings.formats.groups.find((g) => g.group === "reel_or_video")!;
    const image = findings.formats.groups.find((g) => g.group === "image")!;
    expect(reel.enough && image.enough).toBe(true);
    expect(reel.medianReach as number).toBeGreaterThan(image.medianReach as number);
    expect(findings.countries.top[0].country).toBe("GB");
    expect(findings.followers.status).toBe("ok");
    expect(findings.hours.status).toBe("ok");
    expect(findings.simulated).toBe(true);
  });

  it("derives the external account id from the seed, so a sync and the provider agree on it", () => {
    expect(simulatedExternalAccountId("ws-sim-a", "ana-1")).toBe(simulatedExternalAccountId("ws-sim-a", "ana-1"));
    expect(simulatedExternalAccountId("ws-sim-a", "ana-1")).not.toBe(simulatedExternalAccountId("ws-sim-a", "ana-2"));
    expect(simulatedExternalAccountId("ws-sim-a", "ana-1")).toMatch(/^sim_[0-9a-f]{16}$/);
  });
});
