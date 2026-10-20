import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { config } from "../../src/config/env.js";
import { log, setLogSink, type LogLevel } from "../../src/observability/logger.js";

/*
 * The structured logger (docs/decisions/0032). One JSON line per call, every field redacted, strings bounded, no stacks,
 * and it never throws. Tests capture lines through the test-only sink.
 */

const WORKSPACE_TOKEN = "bnd_" + "Ab0_-".repeat(8) + "Ab0"; // bnd_ + 43 base64url characters

let captured: Array<{ line: string; level: LogLevel }> = [];
const originalNodeEnv = process.env.NODE_ENV;

function parsed(): Array<Record<string, any>> {
  return captured.map((entry) => JSON.parse(entry.line));
}

beforeEach(() => {
  captured = [];
  setLogSink((line, level) => {
    captured.push({ line, level });
  });
});

afterEach(() => {
  setLogSink(null);
  config.LOG_LEVEL = undefined;
  process.env.NODE_ENV = originalNodeEnv;
});

describe("structured logger", () => {
  it("writes one json line with ts, level and event", () => {
    log.info("boot.ready", { port: 3000 });

    expect(captured).toHaveLength(1);
    expect(captured[0].line.includes("\n")).toBe(false);
    const entry = parsed()[0];
    expect(entry.event).toBe("boot.ready");
    expect(entry.level).toBe("info");
    expect(entry.port).toBe(3000);
    expect(new Date(entry.ts).toISOString()).toBe(entry.ts);
    expect(captured[0].level).toBe("info");
  });

  it("redacts a seeded secret, a token and a bearer header in any field", () => {
    const seeded = config.SESSION_SECRET;
    expect(seeded.length).toBeGreaterThanOrEqual(8);

    log.warn("probe.fields", {
      note: `contains ${seeded} inside`,
      token: WORKSPACE_TOKEN,
      header: "Bearer abc.def-123_xyz",
      nested: { deep: [seeded, { again: WORKSPACE_TOKEN }] },
      apiKey: "not-a-real-key-value",
    });

    const text = captured[0].line;
    expect(text).not.toContain(seeded);
    expect(text).not.toContain(WORKSPACE_TOKEN);
    expect(text).not.toContain("abc.def-123_xyz");
    expect(text).not.toContain("not-a-real-key-value");
    expect(text).toContain("[redacted]");
    expect(text).toContain("[redacted-token]");
  });

  it("errors are logged as name and message without a stack", () => {
    const err = new TypeError("the thing broke");
    log.error("probe.error", { error: err });

    const entry = parsed()[0];
    expect(entry.error).toEqual({ name: "TypeError", message: "the thing broke" });
    expect(captured[0].line).not.toMatch(/\n\s+at /);
    expect(captured[0].line).not.toContain("stack");
    expect(captured[0].level).toBe("error");
  });

  it("bounds long strings", () => {
    log.info("probe.long", { text: "a".repeat(2000) });

    const entry = parsed()[0];
    expect(typeof entry.text).toBe("string");
    expect(entry.text.length).toBe(500);
  });

  it("respects LOG_LEVEL", () => {
    config.LOG_LEVEL = "warn";
    log.debug("level.debug");
    log.info("level.info");
    log.warn("level.warn");
    log.error("level.error");
    expect(parsed().map((e) => e.event)).toEqual(["level.warn", "level.error"]);

    captured = [];
    config.LOG_LEVEL = "debug";
    log.debug("level.debug");
    expect(parsed().map((e) => e.event)).toEqual(["level.debug"]);

    captured = [];
    config.LOG_LEVEL = undefined;
    log.debug("level.debug");
    log.info("level.info");
    expect(parsed().map((e) => e.event)).toEqual(["level.info"]);
  });

  it("never throws on a circular or odd value", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("getter exploded");
        },
        ownKeys() {
          throw new Error("keys exploded");
        },
      }
    );
    const withThrowingJson = { toJSON() { throw new Error("toJSON exploded"); } };

    expect(() => {
      log.info("odd.values", {
        circular,
        big: 10n,
        symbol: Symbol("s"),
        fn: () => "x",
        nan: Number.NaN,
        undef: undefined,
        hostile,
        withThrowingJson,
        date: new Date(0),
        bytes: new Uint8Array([1, 2]),
      });
      log.error("odd.nothing");
      log.info("odd.null", null as unknown as Record<string, unknown>);
      log.info("odd.string", "not an object" as unknown as Record<string, unknown>);
    }).not.toThrow();
    expect(captured.length).toBeGreaterThanOrEqual(3);
    for (const entry of parsed()) {
      expect(typeof entry.event).toBe("string");
    }
  });

  it("the sink override is refused outside the test environment", () => {
    process.env.NODE_ENV = "production";
    expect(() => setLogSink(() => undefined)).toThrow();
    process.env.NODE_ENV = "test";
    expect(() => setLogSink(() => undefined)).not.toThrow();
    // Clearing the sink is always allowed.
    process.env.NODE_ENV = "production";
    expect(() => setLogSink(null)).not.toThrow();
  });
});
