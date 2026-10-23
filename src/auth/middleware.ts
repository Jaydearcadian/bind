import type { NextFunction, Request, RequestHandler, Response } from "express";
import { resolveToken, type Actor, type WorkspaceRole } from "./tokens.js";
import { upsertAccount, type Account } from "../accounts/service.js";
import type { PrivyVerifier } from "../accounts/privy.js";
import { responseMeta } from "../server/response-meta.js";
import { idempotency } from "../server/idempotency.js";
import { tokenRateLimit } from "../security/rate-limit-middleware.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `authenticate` when the bearer token is valid. Never set from the body or the query. */
      actor?: Actor;
      /** Set by `authenticateAccount` when a Privy access token is valid (ADR 0051). */
      account?: Account;
    }
  }
}

const UNAUTHENTICATED = { error: "Authentication required" };
const WORKSPACE_NOT_FOUND = { error: "Workspace not found" };

/** The token from `Authorization: Bearer <token>`, or null. The query string and cookies are never read. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer (\S+)$/.exec(header);
  return match ? match[1] : null;
}

/**
 * Requires a valid, unrevoked workspace token. A missing, malformed, unknown or revoked token gets the same 401
 * body, so a caller learns nothing about which case applied. A database failure is not an auth failure.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const raw = bearerToken(req);
  if (raw === null) {
    res.status(401).json(UNAUTHENTICATED);
    return;
  }
  let actor: Actor | null;
  try {
    actor = await resolveToken(raw);
  } catch {
    res.status(503).json({ error: "Authentication unavailable" });
    return;
  }
  if (!actor) {
    res.status(401).json(UNAUTHENTICATED);
    return;
  }
  req.actor = actor;
  next();
}

/**
 * For routes with `:id` as the workspace id. A token for another workspace gets 404 with the same body as a
 * workspace that does not exist, so existence is not revealed. The workspace id is taken from the path only.
 */
export function scopeToWorkspace(req: Request, res: Response, next: NextFunction): void {
  if (!req.actor) {
    res.status(401).json(UNAUTHENTICATED);
    return;
  }
  if (req.actor.workspaceId !== req.params.id) {
    res.status(404).json(WORKSPACE_NOT_FOUND);
    return;
  }
  next();
}

/** Allows only the given role. Run after `authenticate`, and after `scopeToWorkspace` where the path has a workspace. */
export function requireRole(role: WorkspaceRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.actor) {
      res.status(401).json(UNAUTHENTICATED);
      return;
    }
    if (req.actor.role !== role) {
      res.status(403).json({ error: role === "owner" ? "Owner role required" : "Role not permitted" });
      return;
    }
    next();
  };
}

// Each composition applies the per-token limit right after authentication (docs/decisions/0033).
/** Owner or staff of the workspace in the path. */
export const workspaceMember: RequestHandler[] = [authenticate, tokenRateLimit, scopeToWorkspace, responseMeta, idempotency];
/** Owner of the workspace in the path. */
export const workspaceOwner: RequestHandler[] = [authenticate, tokenRateLimit, scopeToWorkspace, requireRole("owner"), responseMeta, idempotency];
/** Owner of some workspace, for routes whose path names an approval or an order. The service checks the workspace. */
export const anyWorkspaceOwner: RequestHandler[] = [authenticate, tokenRateLimit, requireRole("owner"), responseMeta, idempotency];
/** Any valid token. The route itself scopes the answer to the caller's workspace. */
export const authenticated: RequestHandler[] = [authenticate, tokenRateLimit];

/**
 * Requires a valid Privy access token (ADR 0051). The verifier is the app's (`app.locals.privyVerifier`); when none is configured the
 * route answers 503 and nothing else is affected. A missing, malformed, expired or wrongly signed token gets the same 401 body as a
 * bad workspace token. The account is created on first sign-in.
 */
export async function authenticateAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
  const verifier = req.app.locals.privyVerifier as PrivyVerifier | null | undefined;
  if (!verifier) {
    res.status(503).json({ error: "Sign-in is not configured" });
    return;
  }
  const raw = bearerToken(req);
  if (raw === null) {
    res.status(401).json(UNAUTHENTICATED);
    return;
  }
  try {
    const identity = await verifier.verify(raw);
    if (!identity) {
      res.status(401).json(UNAUTHENTICATED);
      return;
    }
    req.account = await upsertAccount(identity.userId);
  } catch {
    res.status(503).json({ error: "Authentication unavailable" });
    return;
  }
  next();
}

/** A signed-in account. The per-IP limits in createApp apply; there is no token to count against yet. */
export const accountAuthenticated: RequestHandler[] = [authenticateAccount];
