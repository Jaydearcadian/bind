/**
 * Fixed-window rate limits (docs/decisions/0033). Pure: no HTTP, no metrics and no configuration read, so every rule here
 * is unit-testable with a fake clock. The HTTP glue is in rate-limit-middleware.ts.
 *
 * The state is in memory and per process. A key has one window, which starts at its first hit and ends windowMs later.
 * The store is bounded: an expired key is removed when it is next touched and by a sweep every SWEEP_EVERY hits, and when
 * more than maxKeys keys are live the oldest windows are removed first.
 */

export interface RateLimiterOptions {
  windowMs: number;
  max: number;
  /** Clock in milliseconds. Defaults to Date.now. Tests pass a fake clock. */
  now?: () => number;
  /** Most keys held at once. Default 10000. */
  maxKeys?: number;
}

export interface HitResult {
  /** False once the count in this window is above max. */
  allowed: boolean;
  remaining: number;
  /** Whole seconds until the window ends, never less than 1. */
  retryAfterSeconds: number;
}

export interface PeekResult {
  /** True when the count in this window has reached max. Reading never counts. */
  blocked: boolean;
  /** Whole seconds until the window ends when blocked (at least 1), 0 otherwise. */
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Counts one attempt for the key and reports whether it is within the limit. */
  hit(key: string): HitResult;
  /** Reports whether the key is blocked without counting anything. */
  peek(key: string): PeekResult;
  /** Clears one key, or every key when none is given. */
  reset(key?: string): void;
  /** Number of keys currently held. */
  size(): number;
}

interface Window {
  count: number;
  resetAt: number;
}

export const DEFAULT_MAX_KEYS = 10_000;
const SWEEP_EVERY = 256;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { windowMs, max } = options;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  const now = options.now ?? Date.now;
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new Error("windowMs must be a positive number");
  if (!Number.isInteger(max) || max < 1) throw new Error("max must be a positive integer");
  if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error("maxKeys must be a positive integer");

  // Insertion order is window-start order: a window is inserted when it starts and is never moved. So the oldest
  // window is always first, and a sweep can stop at the first live one.
  const windows = new Map<string, Window>();
  let hits = 0;

  /** The live window for a key, or undefined. An expired window is removed here. */
  function live(key: string, t: number): Window | undefined {
    const found = windows.get(key);
    if (found === undefined) return undefined;
    if (found.resetAt <= t) {
      windows.delete(key);
      return undefined;
    }
    return found;
  }

  function sweep(t: number): void {
    for (const [key, found] of windows) {
      if (found.resetAt > t) break;
      windows.delete(key);
    }
  }

  function enforceBound(): void {
    while (windows.size > maxKeys) {
      const oldest = windows.keys().next();
      if (oldest.done) break;
      windows.delete(oldest.value);
    }
  }

  function retryAfter(resetAt: number, t: number): number {
    return Math.max(1, Math.ceil((resetAt - t) / 1000));
  }

  return {
    hit(key: string): HitResult {
      const t = now();
      hits += 1;
      if (hits % SWEEP_EVERY === 0) sweep(t);
      let found = live(key, t);
      if (found === undefined) {
        found = { count: 0, resetAt: t + windowMs };
        windows.set(key, found);
        enforceBound();
      }
      found.count += 1;
      return {
        allowed: found.count <= max,
        remaining: Math.max(0, max - found.count),
        retryAfterSeconds: retryAfter(found.resetAt, t),
      };
    },

    peek(key: string): PeekResult {
      const t = now();
      const found = live(key, t);
      if (found === undefined || found.count < max) return { blocked: false, retryAfterSeconds: 0 };
      return { blocked: true, retryAfterSeconds: retryAfter(found.resetAt, t) };
    },

    reset(key?: string): void {
      if (key === undefined) windows.clear();
      else windows.delete(key);
    },

    size(): number {
      return windows.size;
    },
  };
}

export interface RateLimitsEnabledInput {
  /** NODE_ENV. */
  nodeEnv: string;
  /** createApp's rateLimits.enabled, when given. */
  option: boolean | undefined;
  /** BIND_RATE_LIMITS, when set (only "off" is accepted at config load). */
  envFlag: string | undefined;
}

/**
 * Whether limits apply (docs/decisions/0033). An explicit option decides. Without one the default is on, except in tests
 * (so the existing suites, which share one client address and create many workspaces, are unaffected) and except when
 * BIND_RATE_LIMITS is "off", which is for local development only.
 */
export function rateLimitsEnabled(input: RateLimitsEnabledInput): boolean {
  if (typeof input.option === "boolean") return input.option;
  if (input.envFlag === "off") return false;
  return input.nodeEnv !== "test";
}

/** The five scopes (docs/decisions/0033). Each has its own limiter, so a key counted in one never counts in another. */
export const RATE_LIMIT_SCOPES = [
  "authFailures",
  "webhookCalls",
  "webhookBadSignatures",
  "workspaceCreate",
  "apiPerToken",
] as const;
export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

export interface RateLimitRule {
  windowMs: number;
  max: number;
}

const MINUTE_MS = 60_000;

export const DEFAULT_RATE_LIMIT_RULES: Record<RateLimitScope, RateLimitRule> = {
  // Per client address: 401 responses. Over the limit, every request from it is refused until the window ends.
  authFailures: { windowMs: MINUTE_MS, max: 10 },
  // Per client address: every call to the standard webhook route.
  webhookCalls: { windowMs: MINUTE_MS, max: 300 },
  // Per client address: 401 responses from the webhook route.
  webhookBadSignatures: { windowMs: MINUTE_MS, max: 10 },
  // Per client address: attempts at the two public creation routes, successful or not.
  workspaceCreate: { windowMs: 60 * MINUTE_MS, max: 5 },
  // Per token id: authenticated requests. Applied after authentication succeeds.
  apiPerToken: { windowMs: MINUTE_MS, max: 600 },
};

export type RateLimitScopes = Record<RateLimitScope, RateLimiter>;

/** The `rateLimits` option of createApp. Every field is optional. */
export interface RateLimitOptions extends Partial<Record<RateLimitScope, RateLimitRule>> {
  enabled?: boolean;
  /** Clock in milliseconds, shared by every scope. Tests pass a fake clock. */
  now?: () => number;
}

/** One limiter per scope, with the defaults unless an override is given. */
export function buildRateLimitScopes(options: RateLimitOptions = {}): RateLimitScopes {
  const scopes = {} as RateLimitScopes;
  for (const scope of RATE_LIMIT_SCOPES) {
    const rule = { ...DEFAULT_RATE_LIMIT_RULES[scope], ...options[scope] };
    scopes[scope] = createRateLimiter({ windowMs: rule.windowMs, max: rule.max, now: options.now });
  }
  return scopes;
}
