/**
 * The two event routes (docs/decisions/0035): the stream, GET /api/workspaces/:id/events, and the poll fallback,
 * GET /api/workspaces/:id/events/poll. Both are member routes, and both take the token from the Authorization header only.
 *
 * The stream loop reads finished events after its cursor and writes each one. The cursor moves only after the write of
 * that event succeeds. A full batch is read again at once; otherwise the loop waits pollIntervalMs, sends a heartbeat when
 * the stream has been idle for heartbeatMs, and checks that its token is still active. The stream ends on its own after
 * maxStreamAgeMs, so a client reconnects with its last id.
 */
import type { Request, RequestHandler, Response } from "express";
import { query } from "../db/client.js";
import { log } from "../observability/logger.js";
import { sseEventsSent } from "../observability/metrics.js";
import {
  claimStream,
  writeWithBackpressure,
  type StreamCaps,
  type WriteOutcome,
} from "./event-streams.js";
import {
  DEFAULT_POLL_LIMIT,
  formatCursor,
  latestCursor,
  parseCursor,
  readEvents,
  readLatestEvents,
  type EventEnvelope,
} from "./events.js";

/** Options of createApp (docs/decisions/0035). Every field is optional; tests shorten the intervals. */
export interface EventsOptions {
  /** How long an idle stream waits before it reads again. Default 1000 ms. */
  pollIntervalMs?: number;
  /** An idle stream sends a comment after this long without a write. Default 15000 ms. */
  heartbeatMs?: number;
  /** A stream ends by itself after this long, so the client reconnects with its last id. Default one hour. */
  maxStreamAgeMs?: number;
  /** Open streams per token. Default 5. */
  perTokenStreams?: number;
  /** Open streams per workspace. Default 50. */
  perWorkspaceStreams?: number;
  /** Open streams per process. Default 500. */
  globalStreams?: number;
}

export interface ResolvedEventsOptions {
  pollIntervalMs: number;
  heartbeatMs: number;
  maxStreamAgeMs: number;
  caps: StreamCaps;
}

export const DEFAULT_EVENTS_OPTIONS = {
  pollIntervalMs: 1000,
  heartbeatMs: 15_000,
  maxStreamAgeMs: 60 * 60 * 1000,
  perTokenStreams: 5,
  perWorkspaceStreams: 50,
  globalStreams: 500,
} as const;

/** Events read per database query on a stream. */
const BATCH = 100;
/** A client that does not read for this long is disconnected (docs/decisions/0035). */
const DRAIN_TIMEOUT_MS = 10_000;
/** The Retry-After of a refused stream, in whole seconds. */
const RETRY_AFTER_SECONDS = 5;

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`events.${name} must be a positive integer`);
  return value;
}

/** Validates the options once, at createApp. A bad value stops startup and names the option. */
export function resolveEventsOptions(input: EventsOptions = {}): ResolvedEventsOptions {
  return {
    pollIntervalMs: positiveInteger("pollIntervalMs", input.pollIntervalMs, DEFAULT_EVENTS_OPTIONS.pollIntervalMs),
    heartbeatMs: positiveInteger("heartbeatMs", input.heartbeatMs, DEFAULT_EVENTS_OPTIONS.heartbeatMs),
    maxStreamAgeMs: positiveInteger("maxStreamAgeMs", input.maxStreamAgeMs, DEFAULT_EVENTS_OPTIONS.maxStreamAgeMs),
    caps: {
      perToken: positiveInteger("perTokenStreams", input.perTokenStreams, DEFAULT_EVENTS_OPTIONS.perTokenStreams),
      perWorkspace: positiveInteger("perWorkspaceStreams", input.perWorkspaceStreams, DEFAULT_EVENTS_OPTIONS.perWorkspaceStreams),
      global: positiveInteger("globalStreams", input.globalStreams, DEFAULT_EVENTS_OPTIONS.globalStreams),
    },
  };
}

/** One SSE frame for an event. The id is the cursor, so the browser or SDK reconnects with it. */
export function eventFrame(event: EventEnvelope): string {
  const type = event.type.replace(/[\r\n]/g, " ");
  return `id: ${event.id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The start cursor a client asked for: the Last-Event-ID header, else the lastEventId query parameter, else none. */
function requestedCursor(req: Request): { kind: "none" } | { kind: "cursor"; cursor: string } | { kind: "invalid" } {
  const header = req.headers["last-event-id"];
  const raw: unknown = header !== undefined ? header : req.query.lastEventId;
  if (raw === undefined) return { kind: "none" };
  const parsed = parseCursor(raw);
  if (parsed === null) return { kind: "invalid" };
  return { kind: "cursor", cursor: formatCursor(parsed.txid, parsed.seq) };
}

function sendInvalidCursor(res: Response): void {
  res.status(400).json({ error: "Invalid cursor", code: "INVALID_CURSOR" });
}

/**
 * True while the credential still works: a workspace token not revoked, or an account session not revoked and not expired, and in
 * either case its workspace is not an expired demo (docs/decisions/0057). Checked on every loop, so a revoked token, an expired
 * session or an expired demo ends its stream. The actor's tokenId is the token row id, or the session row id for a session.
 */
async function tokenStillActive(tokenId: string): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM workspace_tokens t JOIN workspaces w ON w.id = t.workspace_id
      WHERE t.id = $1 AND t.revoked_at IS NULL AND (NOT w.is_demo OR w.demo_expires_at > NOW())
     UNION ALL
     SELECT 1 FROM account_sessions s JOIN workspaces w ON w.id = s.workspace_id
       JOIN workspace_memberships m ON m.account_id = s.account_id AND m.workspace_id = s.workspace_id AND m.removed_at IS NULL
      WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW() AND (NOT w.is_demo OR w.demo_expires_at > NOW());`,
    [tokenId]
  );
  return res.rows.length >= 1;
}

/** GET /api/workspaces/:id/events (text/event-stream). Mounted after the member middleware. */
export function eventStreamHandler(settings: ResolvedEventsOptions): RequestHandler {
  return async (req: Request, res: Response) => {
    const actor = req.actor!;
    const requested = requestedCursor(req);
    if (requested.kind === "invalid") {
      sendInvalidCursor(res);
      return;
    }

    // The caps are checked before any header is sent, so a refused client gets a plain JSON answer it can retry.
    const entry = {
      tokenId: actor.tokenId,
      workspaceId: actor.workspaceId,
      close: (reason: string) => end(reason),
    };
    const claim = claimStream(entry, settings.caps);
    if (!claim.claimed) {
      res.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
      res.status(429).json({ error: "Too many event streams", code: "TOO_MANY_STREAMS" });
      return;
    }

    // All state and listeners are set up before the first await, so a client that leaves during that await is handled.
    const release = claim.release;
    const startedAt = Date.now();
    const endsAt = startedAt + settings.maxStreamAgeMs;
    const includeSensitive = actor.role === "owner";
    let cursor = "";
    let lastWrite = startedAt;
    let sent = 0;
    let ended = false;
    let wake: (() => void) | null = null;

    /** Ends the stream once. A shutdown tells the client to reconnect elsewhere first. */
    function end(reason: string): void {
      if (ended) return;
      ended = true;
      try {
        if (reason === "shutdown" && !res.writableEnded && !res.destroyed) res.write("event: shutdown\ndata: {}\n\n");
        if (reason !== "client" && !res.writableEnded && !res.destroyed) res.end();
      } catch {
        // The socket is already gone. The release below still runs.
      }
      release();
      wake?.();
      log.info("events.stream_ended", { requestId: req.id, reason, sent, durationMs: Date.now() - startedAt });
    }

    res.on("close", () => end("client"));
    res.on("error", () => end("error"));

    try {
      cursor = requested.kind === "cursor" ? requested.cursor : await latestCursor(actor.workspaceId);
    } catch (err) {
      // Nothing has been written yet, so the error handler answers this request with a 500.
      ended = true;
      release();
      throw err;
    }
    // The client may have left while the cursor was read. Nothing is written then.
    if (ended) return;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");

    /** Waits up to ms, or until the stream ends. */
    const waitFor = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        if (ended) {
          resolve();
          return;
        }
        const timer = setTimeout(done, ms);
        wake = done;
        function done(): void {
          clearTimeout(timer);
          wake = null;
          resolve();
        }
      });

    /** Writes one frame. Anything but a successful write ends the stream. */
    const send = async (frame: string): Promise<WriteOutcome> => {
      const outcome = await writeWithBackpressure(res, frame, { drainTimeoutMs: DRAIN_TIMEOUT_MS });
      if (outcome === "timed_out") end("backpressure");
      if (outcome === "closed") end("client");
      return outcome;
    };

    const run = async (): Promise<void> => {
      try {
        while (!ended) {
          if (Date.now() >= endsAt) {
            end("max_age");
            return;
          }
          if (!(await tokenStillActive(actor.tokenId))) {
            end("revoked");
            return;
          }
          if (ended) return;
          const page = await readEvents(actor.workspaceId, cursor, BATCH, { includeSensitive });
          if (ended) return;
          for (const event of page.events) {
            const outcome = await send(eventFrame(event));
            if (outcome !== "written" && outcome !== "drained") return;
            // The cursor moves only after this event has been written.
            cursor = event.id;
            sent += 1;
            lastWrite = Date.now();
            sseEventsSent.inc({});
          }
          // Rows the caller may not see still move the cursor on, so a page of hidden rows is not read again.
          cursor = page.lastCursor;
          if (page.more) continue;

          if (Date.now() - lastWrite >= settings.heartbeatMs) {
            const outcome = await send(": ping\n\n");
            if (outcome !== "written" && outcome !== "drained") return;
            lastWrite = Date.now();
          }
          await waitFor(Math.max(0, Math.min(settings.pollIntervalMs, endsAt - Date.now())));
        }
      } catch (err) {
        log.warn("events.stream_error", { requestId: req.id, error: err });
        end("error");
      }
    };

    await run();
  };
}

/** GET /api/workspaces/:id/events/poll. Without after: the newest events. With after: the events after that cursor. */
export function eventPollHandler(): RequestHandler {
  return async (req: Request, res: Response) => {
    const actor = req.actor!;
    const afterRaw: unknown = req.query.after;
    const limitRaw: unknown = req.query.limit;

    let limit = DEFAULT_POLL_LIMIT;
    if (limitRaw !== undefined) {
      const text = typeof limitRaw === "string" ? limitRaw : "";
      if (!/^\d{1,3}$/.test(text) || Number(text) < 1 || Number(text) > 200) {
        res.status(400).json({ error: "limit must be an integer from 1 to 200", code: "INVALID_LIMIT" });
        return;
      }
      limit = Number(text);
    }

    const options = { includeSensitive: actor.role === "owner" };
    if (afterRaw === undefined) {
      const page = await readLatestEvents(actor.workspaceId, limit, options);
      res.json({ events: page.events, nextCursor: page.lastCursor, hasMore: page.more });
      return;
    }
    const after = parseCursor(afterRaw);
    if (after === null) {
      sendInvalidCursor(res);
      return;
    }
    const page = await readEvents(actor.workspaceId, formatCursor(after.txid, after.seq), limit, options);
    res.json({ events: page.events, nextCursor: page.lastCursor, hasMore: page.more });
  };
}
