/**
 * The errors the client throws (docs/decisions/0036). None of them carries the token, the Authorization header or a URL:
 * a path can name a customer or an order, and a query can carry an event cursor, so neither is copied into an error.
 * A server's own error text is copied, but with the token replaced if it ever appears in it.
 */

/** The base of every error the client throws. Each subclass sets its own stable `name`. */
export class BindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BindError";
  }
}

export interface BindApiErrorInit {
  status: number;
  message: string;
  body: unknown;
  code?: string;
  requestId?: string;
  reasonCodes?: string[];
  retryAfterSeconds?: number;
}

/** A non-2xx answer from the API. `body` is the parsed answer (the standard shape is `{ error, code?, reasonCodes? }`). */
export class BindApiError extends BindError {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;
  readonly reasonCodes?: string[];
  readonly body: unknown;
  readonly retryAfterSeconds?: number;

  constructor(init: BindApiErrorInit) {
    super(init.message);
    this.name = "BindApiError";
    this.status = init.status;
    this.body = init.body;
    if (init.code !== undefined) this.code = init.code;
    if (init.requestId !== undefined) this.requestId = init.requestId;
    if (init.reasonCodes !== undefined) this.reasonCodes = init.reasonCodes;
    if (init.retryAfterSeconds !== undefined) this.retryAfterSeconds = init.retryAfterSeconds;
  }
}

/** The request did not get an answer: a refused or dropped connection, or a fetch that failed. */
export class BindNetworkError extends BindError {
  readonly method: string;

  constructor(method: string) {
    super("The request did not complete: the network failed before an answer arrived");
    this.name = "BindNetworkError";
    this.method = method;
  }
}

/** The request ran past timeoutMs and was aborted. */
export class BindTimeoutError extends BindError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`The request timed out after ${timeoutMs} ms`);
    this.name = "BindTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** An event stream failed in a way that reconnecting cannot fix: malformed events, or an answer that is not a stream. */
export class BindStreamError extends BindError {
  readonly reason: string;

  constructor(reason: string) {
    super(`The event stream failed: ${reason}`);
    this.name = "BindStreamError";
    this.reason = reason;
  }
}

const REDACTED = "[redacted]";

/** Replaces every occurrence of each secret in a text. An empty secret is ignored, so nothing is replaced everywhere. */
export function scrubText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** The same replacement through a parsed JSON value, at any depth (depth-limited, so a hostile answer cannot recurse forever). */
export function scrubValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === "string") return scrubText(value, secrets);
  if (depth > 50 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, secrets, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[scrubText(key, secrets)] = scrubValue(item, secrets, depth + 1);
  }
  return out;
}

/** Retry-After as whole seconds: a number of seconds, or an HTTP date (converted from now). Undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const when = Date.parse(trimmed);
  if (Number.isNaN(when)) return undefined;
  return Math.max(0, Math.ceil((when - now) / 1000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The BindApiError for a non-2xx response. Reads the body (and so consumes it). The token is removed from the message and
 * the body. Never throws: an unreadable body is reported with the status alone.
 */
export async function apiErrorFrom(res: Response, secrets: readonly string[]): Promise<BindApiError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    // The body could not be read. The status, request id and retry-after are still reported.
  }
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  const body = scrubValue(parsed, secrets);
  const fields = isRecord(body) ? body : undefined;
  const message = typeof fields?.error === "string" && fields.error.length > 0 ? fields.error : `HTTP ${res.status}`;
  const reasonCodes =
    Array.isArray(fields?.reasonCodes) && fields.reasonCodes.every((item) => typeof item === "string")
      ? (fields.reasonCodes as string[])
      : undefined;
  return new BindApiError({
    status: res.status,
    message: scrubText(message, secrets),
    body,
    code: typeof fields?.code === "string" ? fields.code : undefined,
    requestId: res.headers.get("x-request-id") ?? undefined,
    reasonCodes,
    retryAfterSeconds: parseRetryAfter(res.headers.get("retry-after")),
  });
}
