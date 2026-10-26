import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { redactText } from "../utils/redact.js";
import { log } from "../observability/logger.js";

/**
 * The one place that decides what an error may say to a client (Task 11, docs/decisions/0031).
 *
 * A database driver error, a Node system error (ECONNREFUSED...) and any non-Error throw never reach the client as their
 * own text: they become a fixed message. A domain error keeps its message, after redaction and a 300-character cut.
 * Stacks are never sent. The real error is logged once, as a redacted message.
 */

export const GENERIC_ERROR_MESSAGE = "Request could not be processed";
const MAX_CLIENT_MESSAGE_CHARACTERS = 300;
/** A PostgreSQL SQLSTATE: five characters, digits and capitals (for example 22021 or 23505). */
const SQLSTATE = /^[0-9A-Z]{5}$/;
/** A Node system error code: E followed by capitals only (ECONNREFUSED, ETIMEDOUT). Domain codes use underscores. */
const SYSTEM_ERROR_CODE = /^E[A-Z]+$/;

/** True for a database driver error or a Node system error. Its text is never sent to a client. */
export function isInfrastructureError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, name } = err as { code?: unknown; name?: unknown };
  if (name === "DatabaseError") return true;
  return typeof code === "string" && (SQLSTATE.test(code) || SYSTEM_ERROR_CODE.test(code));
}

/**
 * The `fields` of a 400 answer: the path of each issue, in order. zod 4 also runs a field's length and format checks on a
 * value of the wrong type (an empty array for a string with min(1) gives a type error and a too-small error), where zod 3
 * stopped at the type error. So a field with a type error is named once, by that error, as it always was. A field that
 * repeats for two checks on a right-typed value (an empty string fails min and the pattern) is still named twice, as before.
 */
export function validationFields(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: string }>): string[] {
  const fieldOf = (issue: { path: ReadonlyArray<PropertyKey> }) => issue.path.map(String).join(".");
  const typed = new Set(issues.filter((issue) => issue.code === "invalid_type").map(fieldOf));
  const named = new Set<string>();
  const fields: string[] = [];
  for (const issue of issues) {
    const field = fieldOf(issue);
    if (typed.has(field)) {
      if (issue.code !== "invalid_type" || named.has(field)) continue;
      named.add(field);
    }
    fields.push(field);
  }
  return fields;
}

/**
 * The message a route may send for an error. Zod errors name fields only (the route adds them), so the rule text is never
 * echoed. A plain Error keeps its message, redacted and cut to 300 characters.
 */
export function publicErrorMessage(err: unknown): string {
  if (err instanceof ZodError) return "Invalid request body";
  if (!(err instanceof Error)) return GENERIC_ERROR_MESSAGE;
  if (isInfrastructureError(err)) return GENERIC_ERROR_MESSAGE;
  return redactText(err.message || "").slice(0, MAX_CLIENT_MESSAGE_CHARACTERS);
}

/** True when any string in a value (at any depth, in keys or values) contains a NUL character. Iterative: no recursion. */
export function containsNul(value: unknown): boolean {
  const stack: unknown[] = [value];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === "string") {
      if (current.includes("\u0000")) return true;
      continue;
    }
    if (current === null || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const [key, item] of Object.entries(current)) {
      if (key.includes("\u0000")) return true;
      stack.push(item);
    }
  }
  return false;
}

/**
 * Refuses a request whose parsed body, query or path contains a NUL character before any route reads it. PostgreSQL
 * cannot store NUL in text, so it would otherwise fail inside the database with its own message.
 */
export function rejectNulInput(req: Request, res: Response, next: NextFunction): void {
  let decodedPath = req.originalUrl;
  try {
    decodedPath = decodeURIComponent(req.originalUrl);
  } catch {
    // A malformed escape is left as it is: the encoded form is still checked below.
  }
  const pathHasNul = decodedPath.includes("\u0000") || /%00/i.test(req.originalUrl);
  if (pathHasNul || containsNul(req.body) || containsNul(req.query)) {
    res.status(400).json({ error: "Invalid characters in request", code: "INVALID_CHARACTERS" });
    return;
  }
  next();
}

/**
 * The last middleware of createApp. Body-parser and routing errors become their fixed JSON bodies. Any other error is
 * logged as a redacted message and answered as 500 with no detail.
 */
export function requestErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const { type, status, statusCode } = (err ?? {}) as { type?: unknown; status?: unknown; statusCode?: unknown };
  if (type === "entity.parse.failed") {
    res.status(400).json({ error: "Malformed JSON body", code: "MALFORMED_JSON" });
    return;
  }
  if (type === "entity.too.large") {
    res.status(413).json({ error: "Request body too large", code: "BODY_TOO_LARGE" });
    return;
  }
  const httpStatus = Number(status ?? statusCode);
  if (Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 500) {
    // For example a path that is not valid percent-encoding, or an unsupported charset. The fixed text is enough.
    res.status(httpStatus).json({ error: "Invalid request" });
    return;
  }
  // The real error goes to the log once, redacted, with the request id and no stack (docs/decisions/0032).
  log.error("http.error", {
    requestId: req.id,
    // A non-Error throw is logged as a fixed text, never stringified: a value's own toString may throw inside this handler.
    error: err instanceof Error ? err : { name: "NonError", message: typeof err === "string" ? err.slice(0, MAX_CLIENT_MESSAGE_CHARACTERS) : "non-error value" },
  });
  res.status(500).json({ error: "Internal error" });
}

/** Marks a handler that `wrapAsyncHandlers` has wrapped. The route-failure guard checks for it on every registered handler. */
export const ASYNC_SAFE = Symbol.for("bind.asyncSafe");

type RouteHandler = (req: Request, res: Response, next: NextFunction) => unknown;

/**
 * Wraps one handler so that a rejected promise (or a synchronous throw) reaches `next`, and so the central error handler.
 * Express 4 does not do this, and on Node 22 an unhandled rejection ends the process (Task 11 follow-up, docs/decisions/0031).
 * A handler that takes four arguments is an error handler and is left as it is.
 */
export function wrapAsyncHandler(handler: RouteHandler): RouteHandler {
  if (typeof handler !== "function" || handler.length >= 4) return handler;
  const wrapped: RouteHandler & { [ASYNC_SAFE]?: true } = function wrappedHandler(this: unknown, req, res, next) {
    let outcome: unknown;
    try {
      outcome = handler.call(this, req, res, next);
    } catch (err) {
      next(err);
      return undefined;
    }
    if (outcome && typeof (outcome as Promise<unknown>).then === "function") {
      (outcome as Promise<unknown>).then(undefined, (err: unknown) => next(err));
    }
    return outcome;
  };
  wrapped[ASYNC_SAFE] = true;
  return wrapped;
}

/**
 * Makes every handler registered with `get`, `post`, `put`, `delete` or `patch` on this app async-safe. Call it before any
 * route is registered. Middleware order, paths and arguments are unchanged: a route call with no handlers (Express's setting
 * lookup, `app.get("env")`) passes straight through.
 */
export function wrapAsyncHandlers(app: { [key: string]: any }): void {
  for (const method of ["get", "post", "put", "delete", "patch"]) {
    const original = app[method].bind(app);
    app[method] = (...args: unknown[]) => {
      if (args.length < 2) return original(...args);
      const [routePath, ...handlers] = args;
      const wrapped = handlers.flat().map((h) => (typeof h === "function" ? wrapAsyncHandler(h as RouteHandler) : h));
      return original(routePath, ...wrapped);
    };
  }
}
