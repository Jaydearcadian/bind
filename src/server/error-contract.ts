import type { NextFunction, Request, Response } from "express";

/**
 * Error body v2 (docs/ecosystem/RESPONSE_AND_EVENT_SPEC.md section 4, ADR 0047). Every JSON error keeps the fields it has today
 * (`error`, `code`, `reasonCodes`, `fields`) and gains `code` where it had none, plus `category`, `retryable`, `requestId`,
 * `retryAfterSeconds` where a Retry-After header was set, `details.fields` for validation, and one typed `recovery` action.
 *
 * It is one response-level step, not a change at ninety call sites: `errorContract` wraps `res.json` and rewrites only a body
 * that is an object with a string `error` and a status of 400 or more. A body without `error` (the health and readiness
 * answers) is left alone. The message is never made longer or less safe: it was produced by `publicErrorMessage` (ADR 0031).
 */

export type ErrorCategory =
  | "validation"
  | "authentication"
  | "authorization"
  | "not_found"
  | "conflict"
  | "policy"
  | "rate_limited"
  | "upstream"
  | "unavailable"
  | "internal";

export interface ErrorShape {
  category: ErrorCategory;
  retryable: boolean;
}

/** The codes the server sends, with their category and retryability. docs/ecosystem/spec/error-catalogue.json mirrors this table (a test compares them). */
export const ERROR_CODES: Readonly<Record<string, ErrorShape>> = {
  MALFORMED_JSON: { category: "validation", retryable: false },
  INVALID_CHARACTERS: { category: "validation", retryable: false },
  INVALID_INPUT: { category: "validation", retryable: false },
  INVALID_CURSOR: { category: "validation", retryable: false },
  INVALID_LIMIT: { category: "validation", retryable: false },
  BODY_TOO_LARGE: { category: "validation", retryable: false },
  VALIDATION_FAILED: { category: "validation", retryable: false },
  UNAUTHENTICATED: { category: "authentication", retryable: false },
  FORBIDDEN: { category: "authorization", retryable: false },
  NOT_FOUND: { category: "not_found", retryable: false },
  APPROVAL_NOT_FOUND: { category: "not_found", retryable: false },
  WORKFLOW_NOT_FOUND: { category: "not_found", retryable: false },
  ORDER_NOT_FOUND: { category: "not_found", retryable: false },
  TOKEN_NOT_FOUND: { category: "not_found", retryable: false },
  CONFLICT: { category: "conflict", retryable: false },
  APPROVAL_NOT_PENDING: { category: "conflict", retryable: false },
  APPROVAL_EXPIRED: { category: "conflict", retryable: false },
  WORKFLOW_NOT_CANCELLABLE: { category: "conflict", retryable: false },
  WORKFLOW_STATE_CHANGED: { category: "conflict", retryable: true },
  ORDER_NOT_AWAITING_CONFIRMATION: { category: "conflict", retryable: false },
  LAST_OWNER_TOKEN: { category: "conflict", retryable: false },
  IDEMPOTENCY_KEY_INVALID: { category: "validation", retryable: false },
  IDEMPOTENCY_KEY_REUSED: { category: "validation", retryable: false },
  IDEMPOTENCY_IN_PROGRESS: { category: "conflict", retryable: true },
  RATE_LIMITED: { category: "rate_limited", retryable: true },
  TOO_MANY_STREAMS: { category: "rate_limited", retryable: true },
  UNAVAILABLE: { category: "unavailable", retryable: true },
  INTERNAL_ERROR: { category: "internal", retryable: false },
};

/** The code a body gets when it carries none, by status. */
function genericCode(status: number): string {
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  if (status === 503) return "UNAVAILABLE";
  if (status >= 500) return "INTERNAL_ERROR";
  return "VALIDATION_FAILED";
}

/** The shape of a code the table does not know (a service code such as NOT_HELD), from the status alone. */
function shapeFromStatus(status: number): ErrorShape {
  if (status === 401) return { category: "authentication", retryable: false };
  if (status === 403) return { category: "authorization", retryable: false };
  if (status === 404) return { category: "not_found", retryable: false };
  if (status === 409) return { category: "conflict", retryable: false };
  if (status === 429) return { category: "rate_limited", retryable: true };
  if (status === 502 || status === 504) return { category: "upstream", retryable: true };
  if (status === 503) return { category: "unavailable", retryable: true };
  if (status >= 500) return { category: "internal", retryable: false };
  return { category: "validation", retryable: false };
}

function recoveryFor(category: ErrorCategory, retryAfterSeconds: number | undefined): { action: string; description: string } | undefined {
  switch (category) {
    case "validation":
      return { action: "fix_request", description: "Correct the request and send it again." };
    case "authentication":
      return { action: "authenticate", description: "Send a valid token in the Authorization header." };
    case "authorization":
      return { action: "use_other_role", description: "Use a token with the role this action needs, or ask an owner." };
    case "conflict":
      return { action: "refresh_and_retry", description: "Read the current state, then decide whether to send the request again." };
    case "rate_limited":
      return { action: "wait_and_retry", description: `Wait ${retryAfterSeconds ?? 5} seconds, then send the same request.` };
    case "unavailable":
    case "upstream":
      return { action: "retry", description: "Try again shortly." };
    case "internal":
      return { action: "contact_support", description: "Quote the request id when you ask for help." };
    default:
      return undefined;
  }
}

const MAX_MESSAGE = 300;
const MAX_FIELDS = 20;

function retryAfterFrom(header: unknown): number | undefined {
  const text = Array.isArray(header) ? header[0] : header;
  const n = typeof text === "number" ? text : typeof text === "string" ? Number(text) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 86400 ? n : undefined;
}

/** Pure: the v2 body for a status and a body, or the same body when it is not an error with a string `error`. */
export function enrichErrorBody(
  status: number,
  body: unknown,
  context: { requestId: string | undefined; retryAfterHeader?: unknown },
): unknown {
  if (status < 400 || body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const original = body as Record<string, unknown>;
  if (typeof original.error !== "string" || original.error.length === 0) return body;
  if (typeof original.category === "string") return body;

  const code = typeof original.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(original.code) ? original.code : genericCode(status);
  const shape = ERROR_CODES[code] ?? shapeFromStatus(status);
  let retryAfterSeconds = retryAfterFrom(context.retryAfterHeader);
  if (shape.category === "rate_limited" && retryAfterSeconds === undefined) retryAfterSeconds = 5;

  const out: Record<string, unknown> = { ...original, error: original.error.slice(0, MAX_MESSAGE), code, category: shape.category, retryable: shape.retryable };
  if (retryAfterSeconds !== undefined) out.retryAfterSeconds = retryAfterSeconds;
  out.requestId = context.requestId ?? "unknown-request";
  if (Array.isArray(original.fields) && original.fields.every((f) => typeof f === "string") && original.details === undefined) {
    out.details = { fields: (original.fields as string[]).slice(0, MAX_FIELDS) };
  }
  const recovery = recoveryFor(shape.category, retryAfterSeconds);
  if (recovery !== undefined && original.recovery === undefined) out.recovery = [recovery];
  return out;
}

/** Wraps `res.json` so every JSON error leaves as error body v2. Registered right after the request context. */
export function errorContract(req: Request, res: Response, next: NextFunction): void {
  const send = res.json.bind(res);
  res.json = ((body?: unknown) =>
    send(enrichErrorBody(res.statusCode, body, { requestId: req.id, retryAfterHeader: res.getHeader("Retry-After") }))) as Response["json"];
  next();
}
