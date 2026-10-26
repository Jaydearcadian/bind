import { describe, it, expect } from "vitest";
import { MAX_COUNT, MAX_POSTS_PER_FETCH, parseProviderAccounts, parseProviderPost, parseProviderPosts } from "../../src/analytics/validate.js";
import { AnalyticsProviderOutputError, PROVIDER_OUTPUT_INVALID_CODE } from "../../src/analytics/types.js";

/** A valid provider post. Each test changes one thing. */
function good(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    externalId: "post_123",
    publishedAt: "2026-05-01T18:30:00Z",
    mediaType: "reel",
    metrics: { reach: 1000, impressions: 1500, likes: 40, comments: 3, saves: 5, shares: 2, plays: 900 },
    ...over,
  };
}

function refused(raw: unknown, pattern: RegExp): void {
  let caught: unknown = null;
  try {
    parseProviderPost(raw);
  } catch (err) {
    caught = err;
  }
  expect(caught, "the post should be refused").toBeInstanceOf(AnalyticsProviderOutputError);
  expect((caught as AnalyticsProviderOutputError).code).toBe(PROVIDER_OUTPUT_INVALID_CODE);
  expect((caught as Error).message).toMatch(pattern);
}

describe("provider post validation: numbers", () => {
  it("accepts a well-formed post and returns the normalised shape", () => {
    const post = parseProviderPost(good());
    expect(post.externalId).toBe("post_123");
    expect(post.publishedAt).toEqual(new Date("2026-05-01T18:30:00Z"));
    expect(post.metrics).toEqual({ reach: 1000, impressions: 1500, likes: 40, comments: 3, saves: 5, shares: 2, plays: 900 });
  });

  it("refuses NaN and infinities", () => {
    refused(good({ metrics: { reach: Number.NaN, impressions: 1, likes: 0, comments: 0, saves: 0, shares: 0 } }), /metrics\.reach must be a whole number/);
    refused(good({ metrics: { reach: 1, impressions: Number.POSITIVE_INFINITY, likes: 0, comments: 0, saves: 0, shares: 0 } }), /metrics\.impressions/);
    refused(good({ metrics: { reach: 1, impressions: 1, likes: Number.NEGATIVE_INFINITY, comments: 0, saves: 0, shares: 0 } }), /metrics\.likes/);
  });

  it("refuses a negative count", () => {
    refused(good({ metrics: { reach: -1, impressions: 1, likes: 0, comments: 0, saves: 0, shares: 0 } }), /must not be negative/);
  });

  it("refuses a fraction, a numeric string and a boolean", () => {
    refused(good({ metrics: { reach: 10.5, impressions: 20, likes: 0, comments: 0, saves: 0, shares: 0 } }), /whole number/);
    refused(good({ metrics: { reach: "10", impressions: 20, likes: 0, comments: 0, saves: 0, shares: 0 } }), /whole number/);
    refused(good({ metrics: { reach: true, impressions: 20, likes: 0, comments: 0, saves: 0, shares: 0 } }), /whole number/);
  });

  it("refuses a count above the maximum, and accepts the maximum", () => {
    refused(good({ metrics: { reach: MAX_COUNT + 1, impressions: MAX_COUNT + 2, likes: 0, comments: 0, saves: 0, shares: 0 } }), /larger than the allowed maximum/);
    const atMax = parseProviderPost(good({ metrics: { reach: MAX_COUNT, impressions: MAX_COUNT, likes: 0, comments: 0, saves: 0, shares: 0 } }));
    expect(atMax.metrics.reach).toBe(MAX_COUNT);
  });

  it("refuses reach above impressions, and a split above reach", () => {
    refused(good({ metrics: { reach: 100, impressions: 99, likes: 0, comments: 0, saves: 0, shares: 0 } }), /must not exceed metrics\.impressions/);
    refused(
      good({ metrics: { reach: 100, impressions: 200, likes: 0, comments: 0, saves: 0, shares: 0 }, followerReach: 101, nonFollowerReach: 0 }),
      /must not exceed the post's reach/
    );
  });

  it("refuses a follower split given without its other half", () => {
    refused(good({ followerReach: 10 }), /must be given together/);
  });

  it("refuses a country count above the post's reach, and a country key that is not two capital letters", () => {
    refused(good({ countryReach: { GB: 1001 } }), /must not exceed the post's reach/);
    refused(good({ countryReach: { gb: 10 } }), /two capital letters/);
    refused(good({ countryReach: { "GB; DROP": 10 } }), /two capital letters/);
    refused(good({ countryReach: [10] }), /object of country codes/);
  });

  it("refuses a publish time that is not an ISO instant, or is outside the allowed years", () => {
    refused(good({ publishedAt: "yesterday" }), /ISO 8601/);
    refused(good({ publishedAt: "2026-02-30T00:00:00Z" }), /ISO 8601/);
    refused(good({ publishedAt: "1999-12-31T23:59:59Z" }), /outside the allowed years/);
    refused(good({ publishedAt: 1_750_000_000_000 }), /ISO 8601/);
  });
});

describe("provider post validation: ids and enums", () => {
  it("refuses a media type that is not on the list, and never stores the provider's own word for it", () => {
    refused(good({ mediaType: "live_stream" }), /mediaType must be one of/);
    refused(good({ mediaType: "REEL" }), /mediaType must be one of/);
  });

  it("refuses a post id with a space, a sentence, a line break or a link: free text cannot pass as an id", () => {
    refused(good({ externalId: "great reel about soup" }), /externalId must be/);
    refused(good({ externalId: "post\nnext" }), /externalId must be/);
    refused(good({ externalId: "https://example.test/p/1" }), /externalId must be/);
    refused(good({ externalId: "" }), /externalId must be/);
    refused(good({ externalId: "x".repeat(129) }), /externalId must be/);
  });

  it("drops a caption, a comment and any other text field without reading it, so it never reaches the stored shape", () => {
    const raw = good({
      caption: "Buy our soup! <script>alert(1)</script>",
      comments: [{ text: "Nice soup" }],
      author: { bio: "Chef" },
      permalink: "https://instagram.example/p/x",
    });
    const post = parseProviderPost(raw);
    const serialised = JSON.stringify(post);
    // The metric named `comments` is a count, and is kept. The text, the link and the author are not.
    expect(serialised).not.toMatch(/soup|script|Chef|permalink|instagram|example\.test/i);
    expect(Object.keys(post).sort()).toEqual(["externalId", "mediaType", "metrics", "publishedAt"]);
    expect(post.metrics.comments).toBe(3);
  });

  it("drops an unknown metric, and keeps plays only when it is given", () => {
    const post = parseProviderPost(good({ metrics: { reach: 1, impressions: 1, likes: 0, comments: 0, saves: 0, shares: 0, note: "hello" } }));
    expect(post.metrics).toEqual({ reach: 1, impressions: 1, likes: 0, comments: 0, saves: 0, shares: 0 });
  });

  it("refuses a post that is not an object, and metrics that are not one", () => {
    refused("a post", /must be an object/);
    refused(good({ metrics: [1, 2, 3] }), /metrics must be an object/);
  });
});

describe("provider answers as a whole", () => {
  it("refuses an answer that is not a list, and one with too many posts", () => {
    expect(() => parseProviderPosts({ posts: [] })).toThrow(AnalyticsProviderOutputError);
    const many = Array.from({ length: MAX_POSTS_PER_FETCH + 1 }, (_, i) => good({ externalId: `p${i}` }));
    expect(() => parseProviderPosts(many)).toThrow(/too many posts/);
  });

  it("refuses an id that appears twice in one answer", () => {
    expect(() => parseProviderPosts([good(), good()])).toThrow(/more than once/);
  });

  it("accepts an empty answer", () => {
    expect(parseProviderPosts([])).toEqual([]);
  });

  it("validates accounts with the same id rules", () => {
    expect(parseProviderAccounts([{ externalId: "acc_1" }])).toEqual([{ externalId: "acc_1" }]);
    expect(() => parseProviderAccounts([{ externalId: "two words" }])).toThrow(AnalyticsProviderOutputError);
  });

  it("does not repeat a refused value in its message", () => {
    let message = "";
    try {
      parseProviderPost(good({ externalId: "secret value with spaces" }));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toMatch(/secret value/);
  });
});

describe("a publish time at 24:00 is not an hour of the day (review N7)", () => {
  it("refuses 2026-10-28T24:00:00Z and accepts 23:59:59Z", () => {
    expect(() => parseProviderPost(good({ publishedAt: "2026-10-28T24:00:00Z" }))).toThrow(/ISO 8601/);
    expect(parseProviderPost(good({ publishedAt: "2026-10-28T23:59:59Z" })).publishedAt.toISOString()).toBe("2026-10-28T23:59:59.000Z");
  });
});
