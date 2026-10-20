/**
 * The typed client for the Bind API (docs/decisions/0034, docs/decisions/0036).
 *
 * It has no authorization of its own: the server decides what each token may do, and the owner group is only a clearer name
 * for the owner-only operations. It has no cache. It retries only a GET or HEAD, and never a write, because a retry could
 * repeat an order, a payment or a decision.
 *
 * The token is held in a private field. It is never in a URL, a log line, an error or the output of JSON.stringify,
 * String() or util.inspect.
 */
import type { operations } from "./generated/api.js";
import { OPERATIONS, type OperationId } from "./generated/operations.js";
import { BindError, BindNetworkError, BindTimeoutError, apiErrorFrom } from "./errors.js";
import { readEventStream, type BindEvent, type EventStreamOptions, type EventTransport } from "./events.js";

export type { BindEvent, EventStreamOptions } from "./events.js";
export type { OperationId } from "./generated/operations.js";
export { OPERATIONS } from "./generated/operations.js";

// -----------------------------------------------------------------------------------------------------------------------
// Types derived from the generated operations
// -----------------------------------------------------------------------------------------------------------------------

type Ops = operations;
type Responses<K extends OperationId> = Ops[K] extends { responses: infer R } ? R : never;
type SuccessStatus<K extends OperationId> = Extract<keyof Responses<K>, 200 | 201 | 202 | 203 | 204>;

/** The value of a content map ({ "application/json": T }): T. */
type ContentValue<C> = [C] extends [never] ? never : C extends Record<string, infer V> ? V : never;
type BodyOfResponse<R> = [R] extends [never] ? undefined : R extends { content: infer C } ? ContentValue<C> : undefined;

/** The parsed 2xx answer of an operation (text for a text route, undefined for an answer with no body). */
export type SuccessOf<K extends OperationId> = {
  [S in SuccessStatus<K>]: BodyOfResponse<Responses<K>[S]>;
}[SuccessStatus<K>];

type Section<K extends OperationId, S extends "path" | "query"> = Ops[K] extends { parameters: infer P }
  ? S extends keyof P
    ? NonNullable<P[S]>
    : never
  : never;

/** The request body of an operation, or never when it takes none. */
export type BodyOf<K extends OperationId> = Ops[K] extends { requestBody?: infer B }
  ? [NonNullable<B>] extends [never]
    ? never
    : NonNullable<B> extends { content: infer C }
      ? ContentValue<C>
      : never
  : never;

/** What call() takes for an operation. Each part is typed from the contract, and a part the operation does not have is never. */
export interface CallOptions<K extends OperationId> {
  params?: Section<K, "path">;
  query?: Section<K, "query">;
  body?: BodyOf<K>;
  signal?: AbortSignal;
  /**
   * Sent as Idempotency-Key (1 to 128 characters from A-Z a-z 0-9 . _ : -). With a key, a network failure is retried with the
   * same key, which is safe: the server returns the first outcome instead of running the command twice. Without one, only reads
   * are retried. Operations that take no key ignore it.
   */
  idempotencyKey?: string;
}

export interface BindClientOptions {
  /** The API origin, for example https://bind.example. An optional path prefix is kept. No credentials, query or fragment. */
  baseUrl: string;
  /** A workspace token (bnd_...). The caller supplies it; the client never reads it from the environment. */
  token: string;
  /** The fetch to use. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Aborts a request (and each attempt of it) after this long. Default 30000 ms. */
  timeoutMs?: number;
  /** Extra attempts for a GET or HEAD after a network failure, a 502, 503 or 504. Default 2. Writes are never retried. */
  maxRetries?: number;
  /** Sent as the user-agent header when set. Browsers may ignore it. */
  userAgent?: string;
  /** Test seam: waits between attempts. Default: a timer that stops early when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Test seam: the jitter source, in [0, 1). Default Math.random. */
  random?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const RETRY_STATUSES = new Set([502, 503, 504]);
const RATE_LIMIT_WAIT_LIMIT_MS = 10_000;
const BACKOFF_BASE_MS = 200;
const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

function parseBaseUrl(raw: unknown): { origin: string; basePath: string } {
  // The error messages never repeat the input: a mistyped URL can carry credentials.
  if (typeof raw !== "string" || raw.length === 0) throw new TypeError("baseUrl must be an absolute http or https URL");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("baseUrl must be an absolute http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("baseUrl must use http or https");
  if (url.username !== "" || url.password !== "") throw new TypeError("baseUrl must not contain credentials");
  if (url.search !== "" || url.hash !== "") throw new TypeError("baseUrl must not carry a query or a fragment");
  return { origin: url.origin, basePath: url.pathname.replace(/\/+$/, "") };
}

function checkToken(token: unknown): string {
  if (typeof token !== "string" || !/^[\x21-\x7e]+$/.test(token)) {
    throw new TypeError("token must be a non-empty string without whitespace");
  }
  return token;
}

function checkInteger(name: string, value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum) throw new TypeError(`${name} must be an integer of at least ${minimum}`);
  return value;
}

/** The reason an aborted caller signal gives: its own reason when it has one, else an AbortError. */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}

/** A fresh request id for one attempt: "sdk-" and 32 hex digits, which matches the server's id rule. */
function newRequestId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `sdk-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Waits for a promise, or rejects when the signal aborts first (so a fetch that ignores its signal still ends). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        // A fetch can resolve just after the abort. Its body is then unwanted, so it is released here.
        if (signal.aborted) {
          if (value instanceof Response) void value.body?.cancel().catch(() => undefined);
          return;
        }
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

interface Exchange {
  res: Response;
  /** Clears the timer and the link to the caller's signal. Call it once the body has been read. */
  finish: () => void;
  timedOut: () => boolean;
}

/** One typed client. Create one per origin and token; it is cheap and holds no connection. */
export class BindClient {
  readonly #token: string;
  readonly #origin: string;
  readonly #basePath: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #userAgent: string | undefined;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #random: () => number;

  /** The owner-only operations. The server decides for each call; this group only names them. */
  readonly owner: OwnerOperations;

  constructor(options: BindClientOptions) {
    if (options === null || typeof options !== "object") throw new TypeError("options are required");
    const base = parseBaseUrl(options.baseUrl);
    this.#origin = base.origin;
    this.#basePath = base.basePath;
    this.#token = checkToken(options.token);
    // Called through an arrow so that the global fetch keeps its receiver (browsers reject a different one).
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = checkInteger("timeoutMs", options.timeoutMs, DEFAULT_TIMEOUT_MS, 1);
    this.#maxRetries = checkInteger("maxRetries", options.maxRetries, DEFAULT_MAX_RETRIES, 0);
    this.#userAgent = options.userAgent;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#random = options.random ?? Math.random;
    this.owner = new OwnerOperations(this);
  }

  /** The configuration without the token. JSON.stringify(client) uses this. */
  toJSON(): { baseUrl: string; timeoutMs: number; maxRetries: number; userAgent?: string } {
    return {
      baseUrl: this.#baseLabel(),
      timeoutMs: this.#timeoutMs,
      maxRetries: this.#maxRetries,
      ...(this.#userAgent !== undefined ? { userAgent: this.#userAgent } : {}),
    };
  }

  toString(): string {
    return `BindClient(${this.#baseLabel()})`;
  }

  [INSPECT](): string {
    return `BindClient { baseUrl: ${JSON.stringify(this.#baseLabel())} }`;
  }

  #baseLabel(): string {
    return `${this.#origin}${this.#basePath}`;
  }

  /**
   * Calls one operation of the contract. The path parameters fill the {name} segments (each value is encoded), the query
   * drops undefined values, and the body is sent as JSON. Resolves with the parsed 2xx answer. Rejects with a BindError
   * subclass for anything else, and with a TypeError for an argument the contract cannot take.
   */
  async call<K extends OperationId>(operationId: K, options: CallOptions<K> = {}): Promise<SuccessOf<K>> {
    const route = (OPERATIONS as Record<string, { method: string; path: string } | undefined>)[operationId];
    if (route === undefined) throw new TypeError(`unknown operation: ${String(operationId)}`);
    const url = this.#url(route.path, options.params as Record<string, unknown> | undefined, options.query as Record<string, unknown> | undefined);
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#userAgent !== undefined) headers["user-agent"] = this.#userAgent;
    let payload: string | undefined;
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(options.body);
    }
    if (options.idempotencyKey !== undefined) {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(options.idempotencyKey)) throw new TypeError("idempotencyKey must be 1 to 128 characters from A-Z a-z 0-9 . _ : -");
      headers["idempotency-key"] = options.idempotencyKey;
    }
    const signal = options.signal;
    const exchange = await this.#run(route.method, url, headers, payload, signal);
    try {
      return (await readBody(exchange.res)) as SuccessOf<K>;
    } catch (err) {
      if (exchange.timedOut()) throw new BindTimeoutError(this.#timeoutMs);
      if (signal?.aborted) throw abortReason(signal);
      if (err instanceof BindError) throw err;
      throw new BindNetworkError(route.method);
    } finally {
      exchange.finish();
    }
  }

  // ---- Convenience wrappers: thin, typed, and each one a call() --------------------------------------------------------

  workspace(id: string): Promise<SuccessOf<"getWorkspace">> {
    return this.call("getWorkspace", { params: { id } });
  }

  listInventory(id: string): Promise<SuccessOf<"listInventory">> {
    return this.call("listInventory", { params: { id } });
  }

  upsertInventory(id: string, body: BodyOf<"upsertInventoryItem">): Promise<SuccessOf<"upsertInventoryItem">> {
    return this.call("upsertInventoryItem", { params: { id }, body });
  }

  replenish(id: string, sku: string): Promise<SuccessOf<"replenish">> {
    return this.call("replenish", { params: { id }, body: { sku } });
  }

  listApprovals(id: string): Promise<SuccessOf<"listApprovals">> {
    return this.call("listApprovals", { params: { id } });
  }

  listOrders(id: string): Promise<SuccessOf<"listOrders">> {
    return this.call("listOrders", { params: { id } });
  }

  listWorkflows(id: string): Promise<SuccessOf<"listWorkflows">> {
    return this.call("listWorkflows", { params: { id } });
  }

  needsAttention(id: string): Promise<SuccessOf<"getNeedsAttention">> {
    return this.call("getNeedsAttention", { params: { id } });
  }

  createCustomerOrder(id: string, body: BodyOf<"createCustomerOrder">): Promise<SuccessOf<"createCustomerOrder">> {
    return this.call("createCustomerOrder", { params: { id }, body });
  }

  listCustomerOrders(id: string): Promise<SuccessOf<"listCustomerOrders">> {
    return this.call("listCustomerOrders", { params: { id } });
  }

  cancelCustomerOrder(id: string, orderId: string): Promise<SuccessOf<"cancelCustomerOrder">> {
    return this.call("cancelCustomerOrder", { params: { id, orderId } });
  }

  ingestFeedback(id: string, body: BodyOf<"ingestFeedback">): Promise<SuccessOf<"ingestFeedback">> {
    return this.call("ingestFeedback", { params: { id }, body });
  }

  feedbackSummary(id: string, since?: string): Promise<SuccessOf<"getFeedbackSummary">> {
    return this.call("getFeedbackSummary", { params: { id }, query: { since } });
  }

  proposeMenuChange(id: string, body: BodyOf<"proposeMenuChange">): Promise<SuccessOf<"proposeMenuChange">> {
    return this.call("proposeMenuChange", { params: { id }, body });
  }

  listMenu(id: string): Promise<SuccessOf<"listMenu">> {
    return this.call("listMenu", { params: { id } });
  }

  listAudit(id: string): Promise<SuccessOf<"listAudit">> {
    return this.call("listAudit", { params: { id } });
  }

  /** One page of the workspace's events, oldest first. Without `after`, the newest events. `limit` is 1 to 200. */
  pollEvents(id: string, options: { after?: string; limit?: number } = {}): Promise<SuccessOf<"pollEvents">> {
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200)) {
      return Promise.reject(new TypeError("limit must be an integer from 1 to 200"));
    }
    const limit = options.limit === undefined ? undefined : String(options.limit);
    return this.call("pollEvents", { params: { id }, query: { after: options.after, limit } });
  }

  /**
   * The workspace's live events, as an async iterable. Each event is yielded once, in order. A dropped connection is
   * resumed from the last event yielded, so nothing is skipped and nothing repeats. Without a lastEventId, the newest cursor
   * is read when this method is called (one poll request), so events written after the call are delivered too
   * (docs/decisions/0036). The stream ends quietly when the signal aborts or the loop breaks. It throws the BindApiError of a
   * 401, 403 or 404 (a revoked token ends it this way).
   *
   * Browsers cannot use the native EventSource for this: it cannot send an Authorization header. This method can.
   */
  events(workspaceId: string, options: EventStreamOptions = {}): AsyncIterable<BindEvent> {
    // Built here, so a bad workspace id is thrown at the call, before any connection.
    const url = this.#url("/api/workspaces/{id}/events", { id: workspaceId }, undefined);
    const transport: EventTransport = {
      open: async (lastEventId, signal) => {
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (this.#userAgent !== undefined) headers["user-agent"] = this.#userAgent;
        if (lastEventId !== undefined) headers["last-event-id"] = lastEventId;
        // Only the wait for the headers is timed: a stream is long-lived, so its body is not.
        const exchange = await this.#exchange("GET", url, headers, undefined, signal, true);
        return exchange.res;
      },
      describeError: (res) => apiErrorFrom(res, [this.#token]),
      sleep: (ms, signal) => this.#sleep(ms, signal),
      random: () => this.#random(),
      // The newest cursor, from the poll endpoint. It is read through call(), so it has the GET retry rules as well.
      pin: async (signal) => {
        const page = await this.call("pollEvents", { params: { id: workspaceId }, query: { limit: "1" }, signal });
        return typeof page.nextCursor === "string" ? page.nextCursor : undefined;
      },
    };
    return readEventStream(transport, options);
  }

  // ---- Internals --------------------------------------------------------------------------------------------------------

  /** Builds the request URL. Path values are encoded; a value that could change the target is refused. */
  #url(template: string, params: Record<string, unknown> | undefined, query: Record<string, unknown> | undefined): string {
    const pathname = this.#path(template, params);
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null) continue;
      search.append(key, String(value));
    }
    const text = search.toString();
    const url = `${this.#origin}${this.#basePath}${pathname}${text.length > 0 ? `?${text}` : ""}`;
    // The target must still be the configured origin: a path can never move the request elsewhere.
    if (new URL(url).origin !== this.#origin) throw new TypeError("the request would leave the configured origin");
    return url;
  }

  #path(template: string, params: Record<string, unknown> | undefined): string {
    return template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      const raw = params?.[name];
      if (raw === undefined || raw === null) throw new TypeError(`missing path parameter: ${name}`);
      const value = String(raw);
      if (value.length === 0 || value === "." || value === "..") {
        throw new TypeError(`path parameter ${name} must be a name, not an empty or dot segment`);
      }
      if (ABSOLUTE_URL.test(value) || value.startsWith("//") || value.includes("\\")) {
        throw new TypeError(`path parameter ${name} is an absolute URL, which is refused`);
      }
      return encodeURIComponent(value);
    });
  }

  /** One request, with retries for the methods that may repeat. Returns the successful answer, not yet read. */
  async #run(method: string, url: string, headers: Record<string, string>, body: string | undefined, signal: AbortSignal | undefined): Promise<Exchange> {
    const retryable = method === "GET" || method === "HEAD";
    // A command carrying a key may repeat after a network failure: the server replays the first outcome.
    const repeatable = retryable || headers["idempotency-key"] !== undefined;
    let attempts = 0;
    let rateLimitRetried = false;
    for (;;) {
      let exchange: Exchange;
      try {
        exchange = await this.#exchange(method, url, headers, body, signal, false);
      } catch (err) {
        if (repeatable && err instanceof BindNetworkError && attempts < this.#maxRetries) {
          attempts += 1;
          await this.#pause(this.#backoff(attempts), signal);
          continue;
        }
        throw err;
      }
      if (exchange.res.ok) return exchange;

      const error = await apiErrorFrom(exchange.res, [this.#token]);
      exchange.finish();
      if (retryable && error.status === 429 && !rateLimitRetried) {
        const waitMs = error.retryAfterSeconds === undefined ? this.#backoff(1) : error.retryAfterSeconds * 1000;
        if (waitMs <= RATE_LIMIT_WAIT_LIMIT_MS) {
          rateLimitRetried = true;
          await this.#pause(waitMs, signal);
          continue;
        }
      }
      if (retryable && RETRY_STATUSES.has(error.status) && attempts < this.#maxRetries) {
        attempts += 1;
        await this.#pause(this.#backoff(attempts), signal);
        continue;
      }
      throw error;
    }
  }

  /**
   * One HTTP exchange. The timer covers the headers, and the body too unless headersOnly is set. The link to the caller's
   * signal stays until finish() is called, so an abort reaches the request while it is in flight.
   */
  async #exchange(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal | undefined,
    headersOnly: boolean
  ): Promise<Exchange> {
    if (signal?.aborted) throw abortReason(signal);
    // Each attempt is a request of its own, so it gets its own id.
    const sent = {
      ...headers,
      authorization: `Bearer ${this.#token}`,
      "x-request-id": newRequestId(),
    };
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    const release = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onCallerAbort);
    };
    let res: Response;
    try {
      res = await abortable(
        this.#fetch(url, {
          method,
          headers: sent,
          body,
          signal: controller.signal,
          // No cookies, and no redirect: a redirect could carry the Authorization header to another origin.
          credentials: "omit",
          redirect: "error",
        }),
        controller.signal
      );
    } catch {
      release();
      if (timedOut) throw new BindTimeoutError(this.#timeoutMs);
      if (signal?.aborted) throw abortReason(signal);
      throw new BindNetworkError(method);
    }
    if (headersOnly) clearTimeout(timer);
    return { res, finish: release, timedOut: () => timedOut };
  }

  #backoff(attempt: number): number {
    return Math.round(BACKOFF_BASE_MS * 2 ** (attempt - 1) * (0.5 + this.#random()));
  }

  async #pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) throw abortReason(signal);
    await this.#sleep(ms, signal);
    if (signal?.aborted) throw abortReason(signal);
  }
}

/** The body of a 2xx answer: parsed JSON, the text of a text route, or undefined for no body. */
async function readBody(res: Response): Promise<unknown> {
  if (res.status === 204 || res.status === 205) return undefined;
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const text = await res.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new BindError("The response body is not valid JSON");
    }
  }
  return res.text();
}

/**
 * The owner-only operations. The server refuses a staff token for each of them with a BindApiError 403. They are grouped so
 * a caller can see which calls need an owner token. The client adds no check of its own.
 */
export class OwnerOperations {
  readonly #client: BindClient;

  constructor(client: BindClient) {
    this.#client = client;
  }

  approveApproval(id: string): Promise<SuccessOf<"approveApproval">> {
    return this.#client.call("approveApproval", { params: { id } });
  }

  rejectApproval(id: string, reason?: string): Promise<SuccessOf<"rejectApproval">> {
    return this.#client.call("rejectApproval", { params: { id }, body: { reason } });
  }

  revokeApproval(id: string, reason?: string): Promise<SuccessOf<"revokeApproval">> {
    return this.#client.call("revokeApproval", { params: { id }, body: { reason } });
  }

  /** Reconciles an order by its own id (the route is /api/orders/{id}/reconcile, not workspace-scoped). */
  reconcileOrder(orderId: string): Promise<SuccessOf<"reconcileOrder">> {
    return this.#client.call("reconcileOrder", { params: { id: orderId } });
  }

  /** Confirms an order's settlement by its own id. The owner's confirmation is the evidence; the SDK does not verify it. */
  confirmOrderSettlement(orderId: string): Promise<SuccessOf<"confirmOrderSettlement">> {
    return this.#client.call("confirmOrderSettlement", { params: { id: orderId } });
  }

  acceptCustomerOrder(id: string, orderId: string): Promise<SuccessOf<"acceptCustomerOrder">> {
    return this.#client.call("acceptCustomerOrder", { params: { id, orderId } });
  }

  cancelWorkflow(id: string, workflowId: string, reason?: string): Promise<SuccessOf<"cancelWorkflow">> {
    return this.#client.call("cancelWorkflow", { params: { id, workflowId }, body: { reason } });
  }

  recoverWorkflows(id: string): Promise<SuccessOf<"recoverWorkflows">> {
    return this.#client.call("recoverWorkflows", { params: { id } });
  }

  updatePolicy(id: string, body: BodyOf<"updatePolicy">): Promise<SuccessOf<"updatePolicy">> {
    return this.#client.call("updatePolicy", { params: { id }, body });
  }

  setKitchenCapacity(id: string, body: BodyOf<"setKitchenCapacity">): Promise<SuccessOf<"setKitchenCapacity">> {
    return this.#client.call("setKitchenCapacity", { params: { id }, body });
  }

  upsertSupplier(id: string, body: BodyOf<"upsertSupplier">): Promise<SuccessOf<"upsertSupplier">> {
    return this.#client.call("upsertSupplier", { params: { id }, body });
  }

  upsertAgentRole(id: string, body: BodyOf<"upsertAgentRole">): Promise<SuccessOf<"upsertAgentRole">> {
    return this.#client.call("upsertAgentRole", { params: { id }, body });
  }

  upsertSurfaceBinding(id: string, body: BodyOf<"upsertSurfaceBinding">): Promise<SuccessOf<"upsertSurfaceBinding">> {
    return this.#client.call("upsertSurfaceBinding", { params: { id }, body });
  }

  /** Pauses or resumes the workspace's agents. */
  setAgentsPaused(id: string, paused: boolean): Promise<SuccessOf<"setAgentsPaused">> {
    return this.#client.call("setAgentsPaused", { params: { id }, body: { paused } });
  }

  issueToken(id: string, body: BodyOf<"issueToken">): Promise<SuccessOf<"issueToken">> {
    return this.#client.call("issueToken", { params: { id }, body });
  }

  listTokens(id: string): Promise<SuccessOf<"listTokens">> {
    return this.#client.call("listTokens", { params: { id } });
  }

  revokeToken(id: string, tokenId: string): Promise<SuccessOf<"revokeToken">> {
    return this.#client.call("revokeToken", { params: { id, tokenId } });
  }

  getWebhookSecret(id: string): Promise<SuccessOf<"getWebhookSecret">> {
    return this.#client.call("getWebhookSecret", { params: { id } });
  }

  rotateWebhookSecret(id: string): Promise<SuccessOf<"rotateWebhookSecret">> {
    return this.#client.call("rotateWebhookSecret", { params: { id } });
  }

  listConnectors(id: string): Promise<SuccessOf<"listConnectors">> {
    return this.#client.call("listConnectors", { params: { id } });
  }

  setConnector(id: string, connectorId: string, body: BodyOf<"setConnector">): Promise<SuccessOf<"setConnector">> {
    return this.#client.call("setConnector", { params: { id, connectorId }, body });
  }

  revokeConnector(id: string, connectorId: string): Promise<SuccessOf<"revokeConnector">> {
    return this.#client.call("revokeConnector", { params: { id, connectorId } });
  }

  verifyConnector(id: string, connectorId: string): Promise<SuccessOf<"verifyConnector">> {
    return this.#client.call("verifyConnector", { params: { id, connectorId } });
  }

  confirmDocument(id: string, docId: string, body: BodyOf<"confirmDocument">): Promise<SuccessOf<"confirmDocument">> {
    return this.#client.call("confirmDocument", { params: { id, docId }, body });
  }

  approveMenuProposal(id: string, proposalId: string): Promise<SuccessOf<"approveMenuProposal">> {
    return this.#client.call("approveMenuProposal", { params: { id, proposalId } });
  }

  rejectMenuProposal(id: string, proposalId: string): Promise<SuccessOf<"rejectMenuProposal">> {
    return this.#client.call("rejectMenuProposal", { params: { id, proposalId } });
  }

  cancelMenuProposal(id: string, proposalId: string): Promise<SuccessOf<"cancelMenuProposal">> {
    return this.#client.call("cancelMenuProposal", { params: { id, proposalId } });
  }

  publishMenuProposal(id: string, proposalId: string): Promise<SuccessOf<"publishMenuProposal">> {
    return this.#client.call("publishMenuProposal", { params: { id, proposalId } });
  }
}

