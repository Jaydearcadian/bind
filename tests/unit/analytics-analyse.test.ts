import { describe, it, expect } from "vitest";
import { analysePosts, engagementRate, renderReportText, MIN_GROUP_POSTS, type Findings } from "../../src/analytics/analyse.js";
import { hourInZone, parseDay, startOfIsoWeek, startOfUtcDay } from "../../src/analytics/time.js";
import type { MediaType, ProviderPost } from "../../src/analytics/types.js";

/* Hand-built posts. Each expected value below is worked out from these numbers, not copied from the output. */

function post(opts: {
  id: string;
  at: string;
  type: MediaType;
  reach: number;
  impressions?: number;
  likes?: number;
  comments?: number;
  saves?: number;
  shares?: number;
  follower?: number;
  country?: Record<string, number>;
}): ProviderPost {
  const reach = opts.reach;
  const p: ProviderPost = {
    externalId: opts.id,
    publishedAt: new Date(opts.at),
    mediaType: opts.type,
    metrics: {
      reach,
      impressions: opts.impressions ?? reach,
      likes: opts.likes ?? 0,
      comments: opts.comments ?? 0,
      saves: opts.saves ?? 0,
      shares: opts.shares ?? 0,
    },
  };
  if (opts.follower !== undefined) {
    p.followerReach = opts.follower;
    p.nonFollowerReach = reach - opts.follower;
  }
  if (opts.country) p.countryReach = opts.country;
  return p;
}

/** Five reels, five images, five carousels, all at 12:00 UTC on different days, with reach that makes the medians plain. */
function fifteenPosts(): ProviderPost[] {
  const posts: ProviderPost[] = [];
  const reach = { reel: [1000, 2000, 3000, 4000, 5000], image: [100, 200, 300, 400, 500], carousel: [200, 400, 600, 800, 1000] } as const;
  let day = 1;
  for (const type of ["reel", "image", "carousel"] as const) {
    reach[type].forEach((r, i) => {
      posts.push(
        post({
          id: `${type}-${i}`,
          at: `2026-03-${String(day).padStart(2, "0")}T12:00:00Z`,
          type,
          reach: r,
          likes: r / 10,
          comments: 0,
          saves: 0,
          shares: 0,
        })
      );
      day += 1;
    });
  }
  return posts;
}

describe("engagement rate", () => {
  it("is (likes + comments + saves + shares) / reach", () => {
    const p = post({ id: "a", at: "2026-01-01T00:00:00Z", type: "image", reach: 200, likes: 10, comments: 2, saves: 3, shares: 5 });
    expect(engagementRate(p)).toBeCloseTo(20 / 200, 10);
  });

  it("is null for a post with no reach, and is never a division by zero", () => {
    const p = post({ id: "z", at: "2026-01-01T00:00:00Z", type: "image", reach: 0, likes: 4 });
    expect(engagementRate(p)).toBeNull();
  });
});

describe("format groups (reels and video against images and carousels)", () => {
  it("takes the median reach and median engagement rate per group, and says did better when the reel group is higher", () => {
    const f = analysePosts(fifteenPosts(), { timeZone: "UTC" });
    const reel = f.formats.groups.find((g) => g.group === "reel_or_video")!;
    const image = f.formats.groups.find((g) => g.group === "image")!;
    const carousel = f.formats.groups.find((g) => g.group === "carousel")!;
    expect(reel).toMatchObject({ posts: 5, enough: true, medianReach: 3000 });
    expect(image).toMatchObject({ posts: 5, enough: true, medianReach: 300 });
    expect(carousel).toMatchObject({ posts: 5, enough: true, medianReach: 600 });
    // Every post has likes = reach / 10, so every rate is 0.1 and the medians are 0.1.
    expect(reel.medianEngagementRate).toBe(0.1);
    expect(f.formats.comparisons).toEqual([
      { against: "image", reach: { outcome: "did_better", reelMedian: 3000, otherMedian: 300 }, engagement: { outcome: "about_the_same", reelRate: 0.1, otherRate: 0.1 } },
      { against: "carousel", reach: { outcome: "did_better", reelMedian: 3000, otherMedian: 600 }, engagement: { outcome: "about_the_same", reelRate: 0.1, otherRate: 0.1 } },
    ]);
  });

  it("does not state a comparison from fewer than 5 posts in a group", () => {
    const posts = fifteenPosts().filter((p) => !(p.mediaType === "reel" && p.externalId === "reel-4"));
    expect(posts.filter((p) => p.mediaType === "reel")).toHaveLength(4);
    const f = analysePosts(posts, { timeZone: "UTC" });
    const reel = f.formats.groups.find((g) => g.group === "reel_or_video")!;
    expect(reel).toMatchObject({ posts: 4, enough: false, medianReach: null, medianEngagementRate: null });
    expect(f.formats.comparisons.every((c) => c.reach === null && c.engagement === null)).toBe(true);
    const text = renderReportText(f);
    expect(text).toContain("Not enough posts yet to compare reels and videos with images");
    expect(text).not.toMatch(/did better than images on median reach/);
  });

  it("counts a video with the reels, and leaves stories out of every format comparison", () => {
    const posts = [
      ...fifteenPosts(),
      post({ id: "video-x", at: "2026-03-20T12:00:00Z", type: "video", reach: 9000 }),
      post({ id: "story-x", at: "2026-03-21T12:00:00Z", type: "story", reach: 1 }),
    ];
    const f = analysePosts(posts, { timeZone: "UTC" });
    const reel = f.formats.groups.find((g) => g.group === "reel_or_video")!;
    expect(reel.posts).toBe(6);
    expect(f.postCount).toBe(17);
    // Six values 1000..5000 and 9000: the median is the mean of the 3rd and 4th: (3000 + 4000) / 2 = 3500.
    expect(reel.medianReach).toBe(3500);
  });
});

describe("hour of day in the workspace time zone", () => {
  it("names the best and worst hour by median reach, over the hours with at least 5 posts", () => {
    const posts: ProviderPost[] = [];
    // Hour 20 UTC: five posts, reach 3000. Hour 8 UTC: five posts, reach 500. Hour 9 UTC: four posts (not eligible).
    for (let i = 0; i < 5; i += 1) posts.push(post({ id: `e${i}`, at: `2026-04-0${i + 1}T20:00:00Z`, type: "image", reach: 3000 }));
    for (let i = 0; i < 5; i += 1) posts.push(post({ id: `m${i}`, at: `2026-04-0${i + 1}T08:00:00Z`, type: "image", reach: 500 }));
    for (let i = 0; i < 4; i += 1) posts.push(post({ id: `n${i}`, at: `2026-04-1${i}T09:00:00Z`, type: "image", reach: 9999 }));
    const f = analysePosts(posts, { timeZone: "UTC" });
    expect(f.hours.status).toBe("ok");
    expect(f.hours.eligibleHours.map((h) => h.hour)).toEqual([8, 20]);
    expect(f.hours.best).toEqual({ hour: 20, posts: 5, medianReach: 3000 });
    expect(f.hours.worst).toEqual({ hour: 8, posts: 5, medianReach: 500 });
    expect(renderReportText(f)).toContain("Posts published at 20:00 in UTC did better than posts published at 08:00 on median reach (3,000 against 500).");
  });

  it("reads the hour in the account's zone, not in UTC", () => {
    // 2026-07-01T23:30Z is 00:30 the next day in Europe/London (BST, UTC+1).
    const instant = new Date("2026-07-01T23:30:00Z");
    expect(hourInZone(instant, "UTC")).toBe(23);
    expect(hourInZone(instant, "Europe/London")).toBe(0);
  });

  it("handles the spring daylight saving change: 02:00 to 03:00 on 8 March 2026 in New York", () => {
    // 06:30Z is 01:30 EST. 07:30Z is 03:30 EDT: the hour 02 does not exist that day.
    expect(hourInZone(new Date("2026-03-08T06:30:00Z"), "America/New_York")).toBe(1);
    expect(hourInZone(new Date("2026-03-08T07:30:00Z"), "America/New_York")).toBe(3);
  });

  it("handles the autumn change on 1 November 2026 in New York, where 01:xx happens twice", () => {
    // 05:30Z is 01:30 EDT, and 06:30Z is 01:30 EST: both are hour 1 on the wall clock.
    expect(hourInZone(new Date("2026-11-01T05:30:00Z"), "America/New_York")).toBe(1);
    expect(hourInZone(new Date("2026-11-01T06:30:00Z"), "America/New_York")).toBe(1);
  });

  it("gives midnight as hour 0, never 24", () => {
    expect(hourInZone(new Date("2026-05-05T00:10:00Z"), "UTC")).toBe(0);
  });

  it("says no hour stood out when every eligible hour has the same median reach, with a fixed tie order", () => {
    const posts: ProviderPost[] = [];
    for (let i = 0; i < 5; i += 1) posts.push(post({ id: `a${i}`, at: `2026-04-0${i + 1}T09:00:00Z`, type: "image", reach: 700 }));
    for (let i = 0; i < 5; i += 1) posts.push(post({ id: `b${i}`, at: `2026-04-0${i + 1}T10:00:00Z`, type: "image", reach: 700 }));
    const f = analysePosts(posts, { timeZone: "UTC" });
    expect(f.hours.sameMedianReach).toBe(true);
    expect(f.hours.best?.hour).toBe(9);
    expect(renderReportText(f)).toContain("No hour of the day stood out in UTC");
    expect(renderReportText(f)).not.toContain("did better than posts");
  });

  it("is not stated with fewer than two eligible hours", () => {
    const posts: ProviderPost[] = [];
    for (let i = 0; i < 6; i += 1) posts.push(post({ id: `c${i}`, at: `2026-04-0${i + 1}T09:00:00Z`, type: "image", reach: 700 }));
    const f = analysePosts(posts, { timeZone: "UTC" });
    expect(f.hours).toMatchObject({ status: "not_enough_posts", best: null, worst: null });
    expect(renderReportText(f)).toContain("Not enough posts yet to compare hours of the day");
  });

  it("rejects an unknown time zone with a RangeError and never a partial answer", () => {
    expect(() => analysePosts([], { timeZone: "Mars/Olympus" })).toThrow(RangeError);
  });
});

describe("follower and country breakdowns", () => {
  it("gives the follower share of reach, by total, over posts that carry the split", () => {
    const posts: ProviderPost[] = [];
    for (let i = 0; i < 5; i += 1) posts.push(post({ id: `f${i}`, at: `2026-05-0${i + 1}T12:00:00Z`, type: "image", reach: 100, follower: 60 }));
    const f = analysePosts(posts, { timeZone: "UTC" });
    expect(f.followers).toEqual({ status: "ok", posts: 5, followerShare: 0.6, nonFollowerShare: 0.4 });
    expect(renderReportText(f)).toContain("Followers made up 60.0% of reach and non-followers 40.0%.");
  });

  it("reports the split as not enough posts when fewer than 5 carry it, and not supplied when the provider cannot", () => {
    const few = analysePosts([post({ id: "x", at: "2026-05-01T12:00:00Z", type: "image", reach: 100, follower: 60 })], { timeZone: "UTC" });
    expect(few.followers.status).toBe("not_enough_posts");
    const none = analysePosts(fifteenPosts().map((p) => ({ ...p, followerReach: 1, nonFollowerReach: 1 })), {
      timeZone: "UTC",
      capabilities: { followerSplit: false },
    });
    expect(none.followers.status).toBe("not_supplied");
    expect(renderReportText(none)).toContain("This source does not supply a split between followers and non-followers.");
  });

  it("lists the top three countries by reach, ties by country code, with their shares of all country reach", () => {
    const posts: ProviderPost[] = [];
    for (let i = 0; i < 5; i += 1) {
      posts.push(post({ id: `c${i}`, at: `2026-06-0${i + 1}T12:00:00Z`, type: "image", reach: 1000, country: { GB: 500, IE: 200, US: 200, FR: 100 } }));
    }
    const f = analysePosts(posts, { timeZone: "UTC" });
    // Totals: GB 2500, IE 1000, US 1000, FR 500. Grand total 5000. IE and US tie: IE first by code.
    expect(f.countries.top).toEqual([
      { country: "GB", reach: 2500, share: 0.5 },
      { country: "IE", reach: 1000, share: 0.2 },
      { country: "US", reach: 1000, share: 0.2 },
    ]);
    expect(renderReportText(f)).toContain("The countries with the most reach were GB (50.0%), IE (20.0%), US (20.0%).");
  });
});

describe("top and bottom posts by engagement rate", () => {
  it("lists the best and the worst three, never the same post in both lists, and ties by id", () => {
    const posts: ProviderPost[] = [];
    // Rates: 0.5, 0.4, 0.3, 0.3, 0.2, 0.1 (two posts tie at 0.3, the lower id is ranked first).
    const likes = [50, 40, 30, 30, 20, 10];
    likes.forEach((l, i) => posts.push(post({ id: `r${String(i).padStart(2, "0")}`, at: `2026-07-0${i + 1}T12:00:00Z`, type: "image", reach: 100, likes: l })));
    const f = analysePosts(posts, { timeZone: "UTC" });
    expect(f.rankings.eligible).toBe(6);
    expect(f.rankings.top.map((p) => p.externalId)).toEqual(["r00", "r01", "r02"]);
    // Bottom three, lowest first: 0.1 (r05), 0.2 (r04), then the 0.3 post ranked last among ties (r03).
    expect(f.rankings.bottom.map((p) => p.externalId)).toEqual(["r05", "r04", "r03"]);
  });

  it("uses fewer entries when there are fewer posts, so the lists never overlap", () => {
    const posts = [0, 1, 2, 3, 4].map((i) => post({ id: `s${i}`, at: `2026-07-0${i + 1}T12:00:00Z`, type: "image", reach: 100, likes: i * 10 }));
    const f = analysePosts(posts, { timeZone: "UTC" });
    expect(f.rankings.top).toHaveLength(2);
    expect(f.rankings.bottom).toHaveLength(2);
    const topIds = new Set(f.rankings.top.map((p) => p.externalId));
    expect(f.rankings.bottom.some((p) => topIds.has(p.externalId))).toBe(false);
  });

  it("leaves out posts with no reach, and says not enough posts when fewer than 5 remain", () => {
    const posts = [0, 1, 2, 3].map((i) => post({ id: `q${i}`, at: `2026-07-0${i + 1}T12:00:00Z`, type: "image", reach: 100, likes: 5 }));
    posts.push(post({ id: "zero", at: "2026-07-05T12:00:00Z", type: "image", reach: 0, likes: 999 }));
    const f = analysePosts(posts, { timeZone: "UTC" });
    expect(f.rankings).toMatchObject({ status: "not_enough_posts", eligible: 4, top: [], bottom: [] });
    expect(JSON.stringify(f)).not.toMatch(/NaN|Infinity/);
  });
});

describe("determinism and ordering", () => {
  it("gives the same findings whatever order the posts arrive in", () => {
    const posts = fifteenPosts();
    const reversed = [...posts].reverse();
    expect(analysePosts(reversed, { timeZone: "UTC" })).toEqual(analysePosts(posts, { timeZone: "UTC" }));
  });

  it("is a pure function of its input: the same call twice gives the same text", () => {
    const posts = fifteenPosts();
    expect(renderReportText(analysePosts(posts, { timeZone: "UTC", simulated: true }))).toBe(
      renderReportText(analysePosts(posts, { timeZone: "UTC", simulated: true }))
    );
  });

  it("handles no posts at all, with no comparison and no error", () => {
    const f = analysePosts([], { timeZone: "UTC" });
    expect(f.postCount).toBe(0);
    expect(renderReportText(f)).toBe("Not enough posts yet to say anything about this period: no posts were published in it.");
  });
});

describe("the report text", () => {
  it("is a golden text for a small, fully known input, and says did better, never because", () => {
    const posts = fifteenPosts();
    const f: Findings = analysePosts(posts, { timeZone: "UTC", simulated: true });
    expect(renderReportText(f)).toBe(
      [
        "Simulated data: these numbers are generated for testing and do not come from a real account.",
        "This period has 15 posts.",
        "Reels and videos did better than images on median reach (3,000 against 300). Reels and videos had about the same engagement rate as images (10.0% against 10.0%). Reels and videos did better than carousels on median reach (3,000 against 600). Reels and videos had about the same engagement rate as carousels (10.0% against 10.0%).",
        "Not enough posts yet to compare hours of the day: at least two hours need 5 posts each.",
        "Not enough posts yet to split reach between followers and non-followers.",
        "Not enough posts yet to compare countries.",
        "Highest engagement rate: carousel from 11 Mar 2026 (10.0%); carousel from 12 Mar 2026 (10.0%); carousel from 13 Mar 2026 (10.0%). Lowest engagement rate: reel from 5 Mar 2026 (10.0%); reel from 4 Mar 2026 (10.0%); reel from 3 Mar 2026 (10.0%).",
      ].join("\n\n")
    );
  });

  it("marks simulated data at the top and in every findings object", () => {
    const f = analysePosts(fifteenPosts(), { timeZone: "UTC", simulated: true });
    expect(f.simulated).toBe(true);
    expect(renderReportText(f).startsWith("Simulated data:")).toBe(true);
    expect(renderReportText(analysePosts(fifteenPosts(), { timeZone: "UTC" }))).not.toMatch(/Simulated/);
  });

  it("never gives a cause: no 'because' and no 'due to' in any text", () => {
    const f = analysePosts(fifteenPosts(), { timeZone: "UTC", simulated: true });
    expect(renderReportText(f)).not.toMatch(/because|due to|caused|driven by/i);
  });

  it("uses the same window arithmetic for ISO weeks and UTC days", () => {
    // Wednesday 2026-10-28 14:00Z: its ISO week starts on Monday 2026-10-26.
    expect(startOfIsoWeek(new Date("2026-10-28T14:00:00Z")).toISOString()).toBe("2026-10-26T00:00:00.000Z");
    expect(startOfUtcDay(new Date("2026-10-28T23:59:59Z")).toISOString()).toBe("2026-10-28T00:00:00.000Z");
    expect(parseDay("2026-02-30")).toBeNull();
    expect(parseDay("2026-10-26")?.toISOString()).toBe("2026-10-26T00:00:00.000Z");
  });

  it("uses the minimum group size from one place", () => {
    expect(MIN_GROUP_POSTS).toBe(5);
  });
});
