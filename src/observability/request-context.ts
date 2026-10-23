import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import { log } from "./logger.js";
import { httpDuration, httpRequests } from "./metrics.js";

/**
 * Request identity and the request log (docs/decisions/0032). The first middleware of createApp.
 *
 * - `req.id` is the incoming x-request-id when it matches the safe pattern, otherwise a fresh UUID. It is echoed in the
 *   x-request-id response header on every response, including errors and static files.
 * - On finish, one `http.request` line is written: the id, method, route pattern, status, duration and, when a token
 *   authenticated the request, its workspace id. The raw URL, the query string, headers and body are never logged.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The request id: the incoming x-request-id when it is safe, otherwise a new UUID. */
      id?: string;
    }
  }
}

export const REQUEST_ID_HEADER = "x-request-id";
/** A client id is kept only when it is 8 to 64 characters of letters, digits, underscore and hyphen. */
const SAFE_INCOMING_ID = /^[A-Za-z0-9_-]{8,64}$/;
const KNOWN_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/** A known HTTP method, or OTHER, so a client cannot create a label value. */
export function methodLabel(method: string | undefined): string {
  const upper = (method ?? "").toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : "OTHER";
}

/** The Express route pattern that answered the request (mount path plus route path), or "unmatched". Never the URL. */
export function routePattern(req: Request): string {
  const routePath = req.route?.path;
  if (typeof routePath !== "string") return "unmatched";
  return `${req.baseUrl ?? ""}${routePath}`;
}

/** 2xx, 4xx and so on. */
export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const id = typeof incoming === "string" && SAFE_INCOMING_ID.test(incoming) ? incoming : crypto.randomUUID();
  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const method = methodLabel(req.method);
    const route = routePattern(req);
    const status = res.statusCode;
    httpRequests.inc({ method, route, status_class: statusClass(status) });
    httpDuration.observe({}, durationSeconds);
    log.info("http.request", {
      requestId: id,
      method,
      route,
      status,
      durationMs: Math.round(durationSeconds * 10_000) / 10,
      ...(req.actor ? { workspaceId: req.actor.workspaceId } : {}),
    });
  });

  next();
}

const requestIds = new AsyncLocalStorage<{ requestId: string }>();

/**
 * The id of the request being handled, or null outside one (the worker, a script, a test calling a service directly). It lets an
 * audit row record which request caused it (`request_id`, the event's `correlationId`). Set by `bindRequestId`, which runs after
 * body parsing: a context opened before the body is read can be lost in the parser's stream callbacks.
 */
export function currentRequestId(): string | null {
  return requestIds.getStore()?.requestId ?? null;
}

/** Makes `req.id` the current request id for everything the route does, including its awaits. */
export function bindRequestId(req: Request, _res: Response, next: NextFunction): void {
  requestIds.run({ requestId: req.id ?? "" }, next);
}
