import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { log } from "../observability/logger.js";
import { rateLimited } from "../observability/metrics.js";
import type { RateLimitScope, RateLimitScopes } from "./rate-limit.js";

/**
 * The HTTP side of the rate limits (docs/decisions/0033). `rateLimitGate` runs early in createApp, before body parsing.
 * `tokenRateLimit` runs after authentication in the route middleware arrays. Both answer a refused request with the same
 * 429 body and a Retry-After header, count it in bind_rate_limited_total, and log it with a hash of the client address.
 *
 * The client address is `req.ip`. Express reads X-Forwarded-For only when the app trusts a proxy hop (BIND_TRUST_PROXY).
 * This module never reads that header itself.
 */

/** The only body a 429 carries (docs/decisions/0033): no scope, no count, no token. */
export const RATE_LIMITED_BODY = { error: "Too many requests", code: "RATE_LIMITED" } as const;

/**
 * Liveness and readiness are never refused by the block (docs/decisions/0033). They expose no data, and an orchestrator or a
 * load balancer behind the same address as a bad client must still see the instance. Metrics is not exempt.
 */
const MONITORING_PATH = /^\/(health|ready)\/?$/i;
const WEBHOOK_PATH = /^\/api\/webhooks\/incoming\/?$/i;
/** The two public creation routes share one scope. Express matches paths case-insensitively with an optional slash. */
const CREATE_PATHS = [/^\/api\/workspaces\/onboard\/?$/i, /^\/api\/workspaces\/?$/i];

/** The first 12 hex characters of the SHA-256 of a client address. The address itself is never logged. */
export function ipHashOf(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 12);
}

function clientIp(req: Request): string {
  return req.ip ?? "unknown";
}

function refuse(req: Request, res: Response, scope: RateLimitScope, retryAfterSeconds: number): void {
  rateLimited.inc({ scope });
  log.warn("rate_limited", { requestId: req.id, scope, ipHash: ipHashOf(clientIp(req)) });
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterSeconds))));
  res.status(429).json(RATE_LIMITED_BODY);
}

/**
 * Runs for every request except GET /health and GET /ready. A client over the auth-failure limit is refused on every route,
 * including with a valid token.
 * The webhook route also checks its own two scopes, and each public creation route counts an attempt.
 * A 401 is counted when its response finishes. A refusal is a 429, which is not a 401, so it is never counted.
 */
export function rateLimitGate(scopes: RateLimitScopes): RequestHandler {
  return (req, res, next) => {
    if ((req.method === "GET" || req.method === "HEAD") && MONITORING_PATH.test(req.path)) {
      next();
      return;
    }
    const ip = clientIp(req);
    const isWebhook = req.method === "POST" && WEBHOOK_PATH.test(req.path);
    const isCreate = req.method === "POST" && CREATE_PATHS.some((pattern) => pattern.test(req.path));

    res.on("finish", () => {
      if (res.statusCode !== 401) return;
      scopes.authFailures.hit(ip);
      if (isWebhook) scopes.webhookBadSignatures.hit(ip);
    });

    const failures = scopes.authFailures.peek(ip);
    if (failures.blocked) return refuse(req, res, "authFailures", failures.retryAfterSeconds);

    if (isWebhook) {
      const bad = scopes.webhookBadSignatures.peek(ip);
      if (bad.blocked) return refuse(req, res, "webhookBadSignatures", bad.retryAfterSeconds);
      const calls = scopes.webhookCalls.hit(ip);
      if (!calls.allowed) return refuse(req, res, "webhookCalls", calls.retryAfterSeconds);
    }

    if (isCreate) {
      const created = scopes.workspaceCreate.hit(ip);
      if (!created.allowed) return refuse(req, res, "workspaceCreate", created.retryAfterSeconds);
    }

    next();
  };
}

/**
 * Counts one request against the token that authenticated it (the token id, never the token). Placed after
 * `authenticate` in the route middleware arrays, so an unauthenticated request is never counted here. The limiters
 * are those createApp stored on the app; with limits off there are none and this passes the request on.
 */
export function tokenRateLimit(req: Request, res: Response, next: NextFunction): void {
  const scopes = req.app.locals.rateLimits as RateLimitScopes | undefined;
  if (!scopes || !req.actor) {
    next();
    return;
  }
  const decision = scopes.apiPerToken.hit(req.actor.tokenId);
  if (!decision.allowed) {
    refuse(req, res, "apiPerToken", decision.retryAfterSeconds);
    return;
  }
  next();
}
