import { describe, it, expect } from "vitest";
import { createSseParser, type SseEvent } from "../../sdk/src/events.js";

/*
 * The incremental Server-Sent Events parser (docs/decisions/0036). It follows the WHATWG event-stream rules: any chunking,
 * three line endings, comments and unknown fields ignored, and an event is dispatched only by a blank line.
 */

function parseChunks(chunks: string[]): SseEvent[] {
  const parser = createSseParser();
  const events: SseEvent[] = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  return events;
}

describe("SSE parser", () => {
  it("parses events split across arbitrary chunk boundaries", () => {
    // Non-ASCII text, a comment, a multi-line data field, and a CRLF pair, so every boundary kind is exercised.
    const stream =
      "retry: 1000\n: keep-alive\n\nid: 1.1\nevent: approval.created\ndata: {\"note\":\"café\"}\ndata: second line\n\n" +
      "id: 1.2\r\nevent: order.updated\r\ndata: two\r\n\r\n";
    const expected = parseChunks([stream]);
    expect(expected.map((e) => [e.lastEventId, e.type, e.data])).toEqual([
      ["1.1", "approval.created", '{"note":"café"}\nsecond line'],
      ["1.2", "order.updated", "two"],
    ]);

    const bytes = new TextEncoder().encode(stream);
    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new TextDecoder();
      const parser = createSseParser();
      const events: SseEvent[] = [];
      for (const part of [bytes.slice(0, split), bytes.slice(split)]) {
        events.push(...parser.push(decoder.decode(part, { stream: true })));
      }
      events.push(...parser.push(decoder.decode()));
      expect(events, `split at byte ${split}`).toEqual(expected);
    }

    // One character at a time: the most fragmented input a network can produce.
    const oneByOne = parseChunks(stream.split(""));
    expect(oneByOne).toEqual(expected);
  });

  it("handles crlf, lf and cr line ends", () => {
    const lines = ["id: 3.1", "event: x", "data: a", "data: b", "", "data: c", "", ""];
    const expected = [
      { lastEventId: "3.1", type: "x", data: "a\nb" },
      { lastEventId: "3.1", type: "message", data: "c" },
    ];
    for (const eol of ["\n", "\r\n", "\r"]) {
      const events = parseChunks([lines.join(eol)]);
      expect(events.map((e) => ({ lastEventId: e.lastEventId, type: e.type, data: e.data })), JSON.stringify(eol)).toEqual(expected);
    }
  });

  it("joins multi-line data", () => {
    const [event] = parseChunks(["data: one\ndata: two\ndata: three\n\n"]);
    expect(event.data).toBe("one\ntwo\nthree");
    expect(event.type).toBe("message");
    const [empty] = parseChunks(["data:\n\n"]);
    expect(empty.data).toBe("");
  });

  it("ignores comments and unknown fields", () => {
    const events = parseChunks([": a comment\nfoo: bar\nbare-field\nretry: soon\ndata: kept\n\n"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "message", data: "kept" });
    // A block with only comments and unknown fields dispatches nothing.
    expect(parseChunks([": ping\n\nfoo: bar\n\n"])).toEqual([]);
  });

  it("a trailing partial event is dropped", () => {
    const parser = createSseParser();
    const events = parser.push("data: one\n\ndata: two\n");
    expect(events.map((e) => e.data)).toEqual(["one"]);
    // No blank line ever arrives for "two", so it is never dispatched, however the stream then ends.
    expect(parser.push("data: three")).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it("id and retry are tracked", () => {
    const parser = createSseParser();
    const first = parser.push("id: 7.1\nretry: 2500\ndata: a\n\n");
    expect(first).toHaveLength(1);
    expect(first[0].lastEventId).toBe("7.1");
    expect(parser.lastEventId).toBe("7.1");
    expect(parser.retry).toBe(2500);

    // The last event id persists until another id arrives.
    const second = parser.push("data: b\n\n");
    expect(second[0].lastEventId).toBe("7.1");

    // An id containing NUL is ignored, and a retry that is not digits is ignored.
    parser.push("id: 8.1\u0000x\ndata: c\n\n");
    parser.push("retry: soon\ndata: d\n\n");
    expect(parser.lastEventId).toBe("7.1");
    expect(parser.retry).toBe(2500);

    parser.push("id: 9.2\ndata: e\n\n");
    expect(parser.lastEventId).toBe("9.2");
  });
});
