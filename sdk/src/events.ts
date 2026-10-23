/**
 * The event stream (docs/decisions/0035, docs/decisions/0036): an incremental Server-Sent Events parser, and the reconnecting
 * stream that the client's events() method returns.
 *
 * The parser follows the WHATWG event-stream rules. Input can be split anywhere, the three line ends are all accepted, a
 * comment or an unknown field is ignored, and an event is dispatched only by a blank line, so a trailing partial event is
 * never delivered.
 *
 * The stream yields each event once and never goes backwards. It resumes from the last id it yielded (Last-Event-ID). It
 * stops, with the error, on a 401, 403, 404 or any other 4xx, and on an answer that is not a stream. It reconnects after a
 * network failure, a timeout, a 429 or a 5xx, after a clean close, and at once after a shutdown or reconnect event.
 */
import { BindApiError, BindNetworkError, BindStreamError, BindTimeoutError } from "./errors.js";

/** One event as the transport reads it: the SSE fields, before the envelope is checked. */
export interface SseEvent {
  /** The event field, or "message" when the block had none. */
  type: string;
  /** The data lines, joined with a line feed. */
  data: string;
  /** The last event id the stream has sent, as of this event. */
  lastEventId: string;
}

export interface SseParser {
  /** Feeds the next text of the stream and returns the events that it completed. */
  push(chunk: string): SseEvent[];
  /** The last id the stream sent. It persists until another id arrives. */
  readonly lastEventId: string;
  /** The last valid retry value, in milliseconds. */
  readonly retry: number | undefined;
}

const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;
const BYTE_ORDER_MARK = 0xfeff;

class Parser implements SseParser {
  private pending = "";
  private skipLeadingLineFeed = false;
  private checkedStart = false;
  private dataLines: string[] = [];
  private hasData = false;
  private eventType = "";
  private idBuffer = "";
  private retryBuffer: number | undefined;

  get lastEventId(): string {
    return this.idBuffer;
  }

  get retry(): number | undefined {
    return this.retryBuffer;
  }

  push(chunk: string): SseEvent[] {
    let text = chunk;
    if (!this.checkedStart && text.length > 0) {
      this.checkedStart = true;
      if (text.charCodeAt(0) === BYTE_ORDER_MARK) text = text.slice(1);
    }
    // A carriage return ended the last line of the previous chunk. A line feed that opens this chunk belongs to it.
    if (this.skipLeadingLineFeed && text.length > 0) {
      this.skipLeadingLineFeed = false;
      if (text.charCodeAt(0) === LINE_FEED) text = text.slice(1);
    }
    text = this.pending + text;
    this.pending = "";

    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code !== LINE_FEED && code !== CARRIAGE_RETURN) continue;
      const line = text.slice(start, i);
      if (code === CARRIAGE_RETURN) {
        if (i + 1 < text.length) {
          if (text.charCodeAt(i + 1) === LINE_FEED) i += 1;
        } else {
          this.skipLeadingLineFeed = true;
        }
      }
      start = i + 1;
      this.handleLine(line, out);
    }
    this.pending = text.slice(start);
    return out;
  }

  private handleLine(line: string, out: SseEvent[]): void {
    if (line.length === 0) {
      this.dispatch(out);
      return;
    }
    if (line.charCodeAt(0) === 58 /* : */) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32 /* space */) value = value.slice(1);
    switch (field) {
      case "event":
        this.eventType = value;
        break;
      case "data":
        this.dataLines.push(value);
        this.hasData = true;
        break;
      case "id":
        if (!value.includes("\u0000")) this.idBuffer = value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) this.retryBuffer = Number(value);
        break;
      default:
        break;
    }
  }

  private dispatch(out: SseEvent[]): void {
    if (this.hasData) {
      out.push({ type: this.eventType.length > 0 ? this.eventType : "message", data: this.dataLines.join("\n"), lastEventId: this.idBuffer });
    }
    this.dataLines = [];
    this.hasData = false;
    this.eventType = "";
  }
}

/** A new incremental parser. Feed it text in any pieces; it returns each event when its blank line arrives. */
export function createSseParser(): SseParser {
  return new Parser();
}

// -----------------------------------------------------------------------------------------------------------------------
// The reconnecting stream
// -----------------------------------------------------------------------------------------------------------------------

/** An event as the caller receives it (the envelope of docs/EVENTS.md). */
export interface BindEvent {
  id: string;
  type: string;
  at: string;
  effectClass: string;
  decision: string;
  actor: { type: string; id: string };
  workflowId?: string;
  data: Record<string, unknown>;
}

export interface EventStreamOptions {
  /** Resume after this event id. Without it, the stream starts after the newest event (the server's rule). */
  lastEventId?: string;
  /** Ends the stream quietly when aborted. */
  signal?: AbortSignal;
  /** The first reconnect waits about this long. Default 500 ms. */
  reconnectMinMs?: number;
  /** No reconnect waits longer than this (a server retry value may exceed it, up to 60 s). Default 10000 ms. */
  reconnectMaxMs?: number;
}

/** What the stream needs from its client: how to open a connection and how to wait. */
export interface EventTransport {
  /** Opens one connection with the cursor (or none). Resolves with any status; rejects on a network failure or timeout. */
  open(lastEventId: string | undefined, signal: AbortSignal): Promise<Response>;
  /** The error for a non-2xx answer. */
  describeError(res: Response): Promise<BindApiError>;
  /** Waits. Resolves early when the signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
  /**
   * Reads the workspace's current cursor (the poll endpoint, newest event). Used once, when the caller gave no lastEventId,
   * so the first connection starts from a known point (docs/decisions/0036). Undefined when the answer has no cursor.
   */
  pin(signal?: AbortSignal): Promise<string | undefined>;
}

/** The outcome of one pin request: its cursor, or the error it failed with. */
type PinOutcome = { ok: true; cursor: string | undefined } | { ok: false; error: unknown };

function settlePin(request: () => Promise<string | undefined>): Promise<PinOutcome> {
  // A synchronous throw becomes a rejection, and the rejection is always handled here, so nothing is left unhandled.
  return Promise.resolve()
    .then(request)
    .then(
      (cursor) => ({ ok: true, cursor }),
      (error: unknown) => ({ ok: false, error })
    );
}

/** A pin failure that a later attempt may cure: a network failure, a timeout, a 429 or a 5xx. Anything else is fatal. */
function retryablePinError(error: unknown): boolean {
  if (error instanceof BindNetworkError || error instanceof BindTimeoutError) return true;
  return error instanceof BindApiError && (error.status === 429 || error.status >= 500);
}

const MAX_SERVER_RETRY_MS = 60_000;
const MAX_RETRY_AFTER_MS = 60_000;
const CURSOR = /^(\d{1,19})\.(\d{1,19})$/;

interface Cursor {
  txid: bigint;
  seq: bigint;
}

/** A cursor "<txid>.<seq>", or null. */
export function parseCursor(text: string): Cursor | null {
  const match = CURSOR.exec(text);
  if (match === null) return null;
  return { txid: BigInt(match[1]), seq: BigInt(match[2]) };
}

function compareCursor(a: Cursor, b: Cursor): number {
  if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
  if (a.seq !== b.seq) return a.seq < b.seq ? -1 : 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The envelope of one data field. Anything that is not the documented shape is a fatal stream error. */
function toBindEvent(message: SseEvent): BindEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.data);
  } catch {
    throw new BindStreamError("an event's data is not JSON");
  }
  if (!isRecord(parsed)) throw new BindStreamError("an event's data is not an object");
  const { id, type, at, effectClass, decision, actor, data, workflowId } = parsed;
  if (typeof id !== "string" || parseCursor(id) === null) throw new BindStreamError("an event has no valid id");
  if (typeof type !== "string" || typeof at !== "string" || typeof effectClass !== "string" || typeof decision !== "string") {
    throw new BindStreamError("an event is missing a field of the envelope");
  }
  if (!isRecord(actor) || typeof actor.type !== "string" || typeof actor.id !== "string") {
    throw new BindStreamError("an event has no actor");
  }
  if (!isRecord(data)) throw new BindStreamError("an event has no data object");
  const event: BindEvent = { id, type, at, effectClass, decision, actor: { type: actor.type, id: actor.id }, data };
  if (typeof workflowId === "string") event.workflowId = workflowId;
  return event;
}

/** Exponential backoff, equal jitter: attempt 1 waits between half and all of minMs. */
export function backoffMs(attempt: number, minMs: number, maxMs: number, random: () => number): number {
  const cap = Math.min(maxMs, minMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(cap / 2 + (cap / 2) * random());
}

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

/**
 * The event stream of a workspace. Argument errors are thrown here, before the first read. The generator then does the
 * work: it is lazy, so no connection is made until the caller asks for an event.
 */
export function readEventStream(transport: EventTransport, options: EventStreamOptions = {}): AsyncIterable<BindEvent> {
  const minMs = positiveInteger("reconnectMinMs", options.reconnectMinMs, 500);
  const maxMs = positiveInteger("reconnectMaxMs", options.reconnectMaxMs, 10_000);
  if (minMs > maxMs) throw new TypeError("reconnectMinMs must not exceed reconnectMaxMs");
  if (options.lastEventId !== undefined && parseCursor(options.lastEventId) === null) {
    throw new TypeError("lastEventId must be an event id of the form <txid>.<seq>");
  }
  // Pinning (docs/decisions/0036). With no start point, the cursor is read now, at call time, so every event written after
  // this call is delivered, including those written before the first connection succeeds. One request is made here; a
  // retryable failure is retried by the stream, and the rest is the stream's own business.
  const pinned = options.lastEventId === undefined ? settlePin(() => transport.pin(options.signal)) : undefined;
  return run(transport, { ...options, minMs, maxMs }, pinned);
}

async function* run(
  transport: EventTransport,
  options: EventStreamOptions & { minMs: number; maxMs: number },
  pinned?: Promise<PinOutcome>
): AsyncGenerator<BindEvent, void, undefined> {
  const caller = options.signal;
  if (caller?.aborted) return;
  // Everything in flight is tied to this controller, so the caller's abort and the end of this generator both stop it.
  const outer = new AbortController();
  const onCallerAbort = () => outer.abort();
  caller?.addEventListener("abort", onCallerAbort, { once: true });

  let lastId = options.lastEventId;
  let highest = lastId !== undefined ? parseCursor(lastId) : null;
  let attempt = 0;
  let serverRetryMs: number | undefined;
  let delayMs = 0;
  const random = () => transport.random();

  try {
    if (pinned !== undefined) {
      let outcome = await pinned;
      while (!outcome.ok) {
        if (outer.signal.aborted) return;
        if (!retryablePinError(outcome.error)) throw outcome.error;
        attempt += 1;
        const retryAfterMs = Math.min(
          (outcome.error instanceof BindApiError ? outcome.error.retryAfterSeconds ?? 0 : 0) * 1000,
          MAX_RETRY_AFTER_MS
        );
        await transport.sleep(Math.max(backoffMs(attempt, options.minMs, options.maxMs, random), retryAfterMs), outer.signal);
        if (outer.signal.aborted) return;
        outcome = await settlePin(() => transport.pin(outer.signal));
      }
      if (outer.signal.aborted) return;
      // A cursor that is not in the id form cannot be used, so the stream then starts at the server's default (ADR 0036).
      if (outcome.cursor !== undefined && parseCursor(outcome.cursor) !== null) {
        lastId = outcome.cursor;
        highest = parseCursor(outcome.cursor);
      }
    }
    for (;;) {
      if (delayMs > 0) await transport.sleep(delayMs, outer.signal);
      if (outer.signal.aborted) return;
      delayMs = 0;

      let res: Response;
      try {
        res = await transport.open(lastId, outer.signal);
      } catch (err) {
        if (outer.signal.aborted) return;
        if (err instanceof BindNetworkError || err instanceof BindTimeoutError) {
          attempt += 1;
          delayMs = backoffMs(attempt, options.minMs, options.maxMs, random);
          continue;
        }
        throw err;
      }

      if (!res.ok) {
        const error = await transport.describeError(res);
        if (res.status === 429 || res.status >= 500) {
          attempt += 1;
          const retryAfterMs = Math.min((error.retryAfterSeconds ?? 0) * 1000, MAX_RETRY_AFTER_MS);
          delayMs = Math.max(backoffMs(attempt, options.minMs, options.maxMs, random), retryAfterMs, serverRetryMs ?? 0);
          continue;
        }
        // 401, 403 and 404 mean the token or the workspace is no longer valid, and every other 4xx is a request that will
        // not succeed as sent. None of these is retried.
        throw error;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("text/event-stream") || res.body === null) {
        await res.body?.cancel().catch(() => undefined);
        throw new BindStreamError("the server answered without an event stream");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = createSseParser();
      const cancelBody = () => {
        reader.cancel().catch(() => undefined);
      };
      outer.signal.addEventListener("abort", cancelBody, { once: true });
      let finished = false;
      let outcome: "closed" | "dropped" | "immediate" = "closed";
      try {
        readLoop: for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>;
          try {
            chunk = await reader.read();
          } catch {
            if (outer.signal.aborted) return;
            outcome = "dropped";
            finished = true;
            break;
          }
          if (chunk.done) {
            finished = true;
            outcome = "closed";
            break;
          }
          attempt = 0;
          const messages = parser.push(decoder.decode(chunk.value, { stream: true }));
          if (parser.retry !== undefined) serverRetryMs = Math.min(parser.retry, MAX_SERVER_RETRY_MS);
          for (const message of messages) {
            if (message.type === "shutdown" || message.type === "reconnect") {
              outcome = "immediate";
              break readLoop;
            }
            const event = toBindEvent(message);
            const cursor = parseCursor(event.id) as Cursor;
            // Never yield an id twice, and never step back: a replayed or older event is skipped.
            if (highest !== null && compareCursor(cursor, highest) <= 0) continue;
            highest = cursor;
            lastId = event.id;
            yield event;
            if (outer.signal.aborted) return;
          }
        }
      } finally {
        outer.signal.removeEventListener("abort", cancelBody);
        // The body is released whenever this read stops before its end: a break, an abort or a thrown error.
        if (!finished) reader.cancel().catch(() => undefined);
      }

      if (outer.signal.aborted) return;
      if (outcome === "immediate") {
        delayMs = 0;
        continue;
      }
      attempt += 1;
      delayMs = Math.max(backoffMs(attempt, options.minMs, options.maxMs, random), serverRetryMs ?? 0);
    }
  } finally {
    caller?.removeEventListener("abort", onCallerAbort);
    outer.abort();
  }
}
