import { describe, it, expect, afterEach, vi } from "vitest";
import { createRateLimiter, rateLimitsEnabled } from "../../src/security/rate-limit.js";

/** The fixed-window limiter and the default decision for rate limits (docs/decisions/0033). Pure: a fake clock, no HTTP. */

function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createRateLimiter", () => {
  it("allows up to the maximum and then blocks until the window ends", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ windowMs: 1000, max: 3, now: clock.now });

    expect(limiter.hit("a")).toMatchObject({ allowed: true, remaining: 2 });
    expect(limiter.hit("a")).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.hit("a")).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.hit("a").allowed).toBe(false);
    expect(limiter.peek("a").blocked).toBe(true);

    clock.advance(999);
    expect(limiter.peek("a").blocked).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);

    clock.advance(1);
    expect(limiter.peek("a").blocked).toBe(false);
    expect(limiter.hit("a")).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("reports a retry-after of at least one second", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1, now: clock.now });
    limiter.hit("a");

    expect(limiter.hit("a")).toMatchObject({ allowed: false, retryAfterSeconds: 60 });

    // One millisecond before the window ends is still a whole second of waiting, never zero.
    clock.advance(59_999);
    expect(limiter.hit("a")).toMatchObject({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.peek("a")).toEqual({ blocked: true, retryAfterSeconds: 1 });
  });

  it("counts keys separately", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: fakeClock().now });
    limiter.hit("a");
    limiter.hit("a");

    expect(limiter.hit("a").allowed).toBe(false);
    expect(limiter.hit("b").allowed).toBe(true);
    expect(limiter.peek("b").blocked).toBe(false);
  });

  it("peek does not count", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 2, now: fakeClock().now });
    for (let i = 0; i < 50; i++) {
      expect(limiter.peek("a")).toEqual({ blocked: false, retryAfterSeconds: 0 });
    }
    expect(limiter.size()).toBe(0);

    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(true);
    expect(limiter.hit("a").allowed).toBe(false);
  });

  it("a flood of distinct keys stays within the key bound", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 5, maxKeys: 100, now: fakeClock().now });

    // The first key is blocked before the flood, so it is the oldest entry in the store.
    for (let i = 0; i < 5; i++) limiter.hit("first");
    expect(limiter.peek("first").blocked).toBe(true);

    for (let i = 0; i < 20_000; i++) {
      limiter.hit(`flood-${i}`);
      if (i % 1000 === 0) expect(limiter.size()).toBeLessThanOrEqual(100);
    }
    expect(limiter.size()).toBeLessThanOrEqual(100);

    // The oldest key was evicted first, so it no longer counts. A recent key still does.
    expect(limiter.peek("first").blocked).toBe(false);
    for (let i = 0; i < 5; i++) limiter.hit("recent");
    expect(limiter.peek("recent").blocked).toBe(true);
  });

  it("expired keys are swept, so a long run of distinct keys does not grow the store", () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ windowMs: 1000, max: 5, maxKeys: 100_000, now: clock.now });
    for (let i = 0; i < 3000; i++) {
      limiter.hit(`k-${i}`);
      clock.advance(1);
    }
    // Each key lives for one second, so about a thousand are live. Without the sweep all 3000 would remain.
    expect(limiter.size()).toBeLessThan(1300);
  });

  it("reset clears one key or all", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, now: fakeClock().now });
    limiter.hit("a");
    limiter.hit("b");
    expect(limiter.peek("a").blocked).toBe(true);
    expect(limiter.peek("b").blocked).toBe(true);

    limiter.reset("a");
    expect(limiter.peek("a").blocked).toBe(false);
    expect(limiter.peek("b").blocked).toBe(true);

    limiter.reset();
    expect(limiter.peek("b").blocked).toBe(false);
    expect(limiter.size()).toBe(0);
  });

  it("refuses options that cannot form a window", () => {
    expect(() => createRateLimiter({ windowMs: 0, max: 1 })).toThrow();
    expect(() => createRateLimiter({ windowMs: 1000, max: 0 })).toThrow();
    expect(() => createRateLimiter({ windowMs: 1000, max: 1.5 })).toThrow();
    expect(() => createRateLimiter({ windowMs: 1000, max: 1, maxKeys: 0 })).toThrow();
  });
});

describe("rateLimitsEnabled", () => {
  it("rateLimitsEnabled is off in test by default, on with the option, on in production, and off with the env flag", () => {
    // Off in test unless the options say so, so the existing suites (one client IP, many workspaces) are unaffected.
    expect(rateLimitsEnabled({ nodeEnv: "test", option: undefined, envFlag: undefined })).toBe(false);
    expect(rateLimitsEnabled({ nodeEnv: "test", option: true, envFlag: undefined })).toBe(true);
    // On by default everywhere else.
    expect(rateLimitsEnabled({ nodeEnv: "production", option: undefined, envFlag: undefined })).toBe(true);
    // The local-development switch turns the default off.
    expect(rateLimitsEnabled({ nodeEnv: "production", option: undefined, envFlag: "off" })).toBe(false);
  });

  it("an explicit option decides, whatever the environment", () => {
    expect(rateLimitsEnabled({ nodeEnv: "production", option: false, envFlag: undefined })).toBe(false);
    expect(rateLimitsEnabled({ nodeEnv: "development", option: undefined, envFlag: undefined })).toBe(true);
    expect(rateLimitsEnabled({ nodeEnv: "test", option: true, envFlag: "off" })).toBe(true);
  });
});

describe("configuration loaded from the environment", () => {
  const touched = ["BIND_TRUST_PROXY", "BIND_RATE_LIMITS"] as const;

  afterEach(() => {
    for (const name of touched) delete process.env[name];
    vi.resetModules();
  });

  async function loadConfig(env: Partial<Record<(typeof touched)[number], string>>) {
    for (const name of touched) delete process.env[name];
    Object.assign(process.env, env);
    vi.resetModules();
    return (await import("../../src/config/env.js")).config;
  }

  it("BIND_TRUST_PROXY defaults to 0 and accepts a non-negative integer", async () => {
    expect((await loadConfig({})).BIND_TRUST_PROXY).toBe(0);
    expect((await loadConfig({ BIND_TRUST_PROXY: "2" })).BIND_TRUST_PROXY).toBe(2);
  });

  it("BIND_TRUST_PROXY rejects a value that is not a non-negative integer, naming the variable", async () => {
    for (const bad of ["1.5", "-1", "yes", " 1"]) {
      await expect(loadConfig({ BIND_TRUST_PROXY: bad }), bad).rejects.toThrow(/BIND_TRUST_PROXY/);
    }
  });

  it("BIND_RATE_LIMITS accepts only off, and rejects anything else naming the variable", async () => {
    expect((await loadConfig({ BIND_RATE_LIMITS: "off" })).BIND_RATE_LIMITS).toBe("off");
    expect((await loadConfig({})).BIND_RATE_LIMITS).toBeUndefined();
    for (const bad of ["OFF", "false", "0"]) {
      await expect(loadConfig({ BIND_RATE_LIMITS: bad }), bad).rejects.toThrow(/BIND_RATE_LIMITS/);
    }
  });
});
