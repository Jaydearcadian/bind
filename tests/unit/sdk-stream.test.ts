import { describe, it, expect } from "vitest";
import { BindClient, BindApiError } from "../../sdk/src/index.js";
import type { BindEvent } from "../../sdk/src/index.js";

/*
 * The event stream's reconnect rules, with a scripted fetch (docs/decisions/0036). These cases are about what the SDK does
 * with a replayed, backwards or fatal answer, which a real server does not produce on demand. The real server is in
 * tests/integration/sdk.test.ts.
 */

const BASE = "https://bind.example";
const TOKEN = "bnd_" + "Ab3".repeat(14) + "Z";
const WS = "ws-sdk-stream";

interface Scripted {
  headers: Record<string, string>;
  body: string[];
  /** Ends the body with this many milliseconds of silence instead of closing it. */
  hold?: boolean;
  status?: number;
  cancelled?: () => void;
}

/** One SSE frame for an event with this cursor. */
function frame(id: string, type = "approval.created"): string {
  const data = JSON.stringify({ id, type, at: "2026-10-20T00:00:00.000Z", effectClass: "read", decision: "ALLOW", actor: { type: "owner", id: "o" }, data: {} });
  return `id: ${id}\nevent: ${type}\ndata: ${data}\n\n`;
}

/** A fetch that serves the scripted answers in order. Each request is recorded with its headers and abort signal. */
function scripted(answers: Array<Scripted | Response>) {
  const requests: Array<{ headers: Record<string, string>; signal: AbortSignal | undefined }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    // The pin request (the poll endpoint) is answered on its own and is not part of the scripted stream answers.
    if (url.includes("/events/poll")) {
      return new Response(JSON.stringify({ events: [], nextCursor: "0.0", hasMore: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ headers, signal: init?.signal ?? undefined });
    const answer = answers[Math.min(requests.length - 1, answers.length - 1)];
    if (answer instanceof Response) return answer;
    if (answer.status && answer.status !== 200) {
      return new Response(JSON.stringify({ error: "refused" }), { status: answer.status, headers: { "content-type": "application/json" } });
    }
    const encoder = new TextEncoder();
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < answer.body.length) {
          controller.enqueue(encoder.encode(answer.body[index++]));
          return;
        }
        if (!answer.hold) controller.close();
      },
      cancel() {
        answer.cancelled?.();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", ...answer.headers } });
  }) as unknown as typeof fetch;
  return { fetch: impl, requests };
}

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

/** A 200 event-stream answer with the given frames. It stays open until the reader leaves. */
function eventStream(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of frames) controller.enqueue(encoder.encode(part));
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function take(iterable: AsyncIterable<BindEvent>, count: number): Promise<BindEvent[]> {
  const out: BindEvent[] = [];
  const iterator = iterable[Symbol.asyncIterator]();
  while (out.length < count) {
    const next = await iterator.next();
    if (next.done) break;
    out.push(next.value);
  }
  await iterator.return?.(undefined);
  return out;
}

describe("event stream reconnect rules (extra)", () => {
  it("a replayed event is yielded once and never goes backwards", async () => {
    // The first connection ends cleanly after 1.2. The second ignores Last-Event-ID and replays from the start, with a
    // repeat of 1.2 and an older 0.9 mixed in. The SDK must yield 1.1, 1.2, 1.3 once each and nothing else.
    const mock = scripted([
      { headers: {}, body: [frame("1.1"), frame("1.2")] },
      { headers: {}, body: [frame("1.1"), frame("1.2"), frame("1.2"), frame("1.3"), frame("0.9")], hold: true },
    ]);
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: mock.fetch, sleep: recordingSleep().sleep, random: () => 0 });
    const got = await take(client.events(WS, { reconnectMinMs: 1 }), 3);
    expect(got.map((e) => e.id)).toEqual(["1.1", "1.2", "1.3"]);
    expect(mock.requests[1].headers["last-event-id"]).toBe("1.2");
  });

  it("a 401 on reconnect ends the stream with BindApiError and makes no further request", async () => {
    const mock = scripted([{ headers: {}, body: [frame("2.1")] }, { headers: {}, body: [], status: 401 }]);
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: mock.fetch, sleep: recordingSleep().sleep });
    const iterator = client.events(WS, { reconnectMinMs: 1 })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ id: "2.1" });
    const error = await iterator.next().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BindApiError);
    expect((error as BindApiError).status).toBe(401);
    expect(mock.requests.length).toBe(2);
  });

  it("the server retry value is the minimum delay before a reconnect", async () => {
    const mock = scripted([
      { headers: {}, body: ["retry: 3000\n\n"] },
      { headers: {}, body: [frame("3.1")], hold: true },
    ]);
    const sleeps = recordingSleep();
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: mock.fetch, sleep: sleeps.sleep, random: () => 0 });
    const got = await take(client.events(WS, { reconnectMinMs: 1 }), 1);
    expect(got.map((e) => e.id)).toEqual(["3.1"]);
    expect(sleeps.waits.length).toBeGreaterThanOrEqual(1);
    expect(sleeps.waits[0]).toBeGreaterThanOrEqual(3000);
  });

  it("a shutdown event reconnects at once and is not yielded", async () => {
    const mock = scripted([
      { headers: {}, body: [frame("4.1"), "event: shutdown\ndata: {}\n\n"], hold: true },
      { headers: {}, body: [frame("4.2")], hold: true },
    ]);
    const sleeps = recordingSleep();
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: mock.fetch, sleep: sleeps.sleep });
    const got = await take(client.events(WS, { reconnectMinMs: 1 }), 2);
    expect(got.map((e) => e.id)).toEqual(["4.1", "4.2"]);
    expect(got.map((e) => e.type)).not.toContain("shutdown");
    expect(sleeps.waits).toEqual([]);
    expect(mock.requests[1].headers["last-event-id"]).toBe("4.1");
  });

  it("breaking out of the loop cancels the body and aborts the request", async () => {
    let cancelled = 0;
    const mock = scripted([{ headers: {}, body: [frame("5.1")], hold: true, cancelled: () => void cancelled++ }]);
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: mock.fetch, sleep: recordingSleep().sleep });
    for await (const event of client.events(WS, { reconnectMinMs: 1 })) {
      expect(event.id).toBe("5.1");
      break;
    }
    expect(cancelled).toBe(1);
    expect(mock.requests[0].signal?.aborted).toBe(true);
  });

  it("a stream answered with a non-stream content type is a fatal BindStreamError", async () => {
    const answer = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: scripted([answer]).fetch, sleep: recordingSleep().sleep });
    const error = await take(client.events(WS, { reconnectMinMs: 1 }), 1).catch((e: unknown) => e);
    expect((error as Error).name).toBe("BindStreamError");
  });

  it("a caller supplied lastEventId is not overridden by pinning", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.includes("/events/poll")) {
        return new Response(JSON.stringify({ events: [], nextCursor: "9.9", hasMore: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return eventStream([frame("2.1")]);
    }) as unknown as typeof fetch;
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: fetchImpl, sleep: recordingSleep().sleep });
    const got = await take(client.events(WS, { lastEventId: "1.1", reconnectMinMs: 1 }), 1);
    expect(got.map((e) => e.id)).toEqual(["2.1"]);
    expect(seen.some((r) => r.url.includes("/events/poll"))).toBe(false);
    const stream = seen.find((r) => !r.url.includes("/events/poll"));
    expect(stream?.headers["last-event-id"]).toBe("1.1");
  });

  it("pinning failure with 401 is fatal and with a network error is retried", async () => {
    // A 401 on the pin ends the stream with that error, and no stream is ever opened.
    const denied: string[] = [];
    const refused = (async (input: string | URL | Request) => {
      const url = String(input);
      denied.push(url);
      if (url.includes("/events/poll")) {
        return new Response(JSON.stringify({ error: "Authentication required" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      // Reached only if the stream were opened after a fatal pin. A 401 ends it at once, so a regression fails here, not in a loop.
      return new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const strict = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: refused, sleep: recordingSleep().sleep, maxRetries: 0 });
    const fatal = await take(strict.events(WS, { reconnectMinMs: 1 }), 1).catch((e: unknown) => e);
    expect(fatal).toBeInstanceOf(BindApiError);
    expect((fatal as BindApiError).status).toBe(401);
    expect(denied.every((url) => url.includes("/events/poll"))).toBe(true);

    // A network error on the pin is retried with backoff. The third pin answers, and the stream starts from its cursor.
    let polls = 0;
    const streamHeaders: Array<Record<string, string>> = [];
    const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/events/poll")) {
        polls += 1;
        if (polls <= 2) throw new TypeError("fetch failed");
        return new Response(JSON.stringify({ events: [], nextCursor: "5.0", hasMore: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      streamHeaders.push((init?.headers ?? {}) as Record<string, string>);
      return eventStream([frame("5.1")]);
    }) as unknown as typeof fetch;
    const waits = recordingSleep();
    const patient = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: flaky, sleep: waits.sleep, maxRetries: 0, random: () => 0.5 });
    const got = await take(patient.events(WS, { reconnectMinMs: 1 }), 1);
    expect(got.map((e) => e.id)).toEqual(["5.1"]);
    expect(polls).toBe(3);
    expect(waits.waits.length).toBeGreaterThanOrEqual(2);
    expect(streamHeaders[0]["last-event-id"]).toBe("5.0");
  });
});
