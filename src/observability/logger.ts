import { config } from "../config/env.js";
import { redactDeep, redactText } from "../utils/redact.js";

/**
 * The one structured logger (docs/decisions/0032). Each call writes one JSON line: `{ ts, level, event, ...fields }`.
 *
 * - Every field value passes through redactDeep, and the event name through redactText, so a configured secret, a
 *   workspace token, a bearer value or a URL with credentials never reaches a log line.
 * - A string is cut to 500 characters after redaction. An Error becomes `{ name, message }`: no stack.
 * - debug, info and warn go to stdout; error goes to stderr. The level comes from LOG_LEVEL (default info).
 * - A call never throws. A value that cannot be encoded is replaced by a fixed note.
 *
 * The sink exists for tests. It is honoured only when NODE_ENV is "test", the same guard as src/effects/faults.ts.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogSink = (line: string, level: LogLevel) => void;

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_STRING_CHARACTERS = 500;
/** Fields may not overwrite the three fixed keys. */
const RESERVED_KEYS = new Set(["ts", "level", "event"]);

let sink: LogSink | null = null;

/** Replaces the output with a function (tests only). `null` restores stdout and stderr. Refused outside NODE_ENV=test. */
export function setLogSink(next: LogSink | null): void {
  if (next !== null && process.env.NODE_ENV !== "test") {
    throw new Error("The log sink can only be replaced when NODE_ENV is 'test'");
  }
  sink = next;
}

function thresholdLevel(): LogLevel {
  return config.LOG_LEVEL ?? "info";
}

/** A JSON replacer: bounds strings, and writes values JSON cannot carry (BigInt, symbols, non-finite numbers). */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_STRING_CHARACTERS ? value.slice(0, MAX_STRING_CHARACTERS) : value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "[function]";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return value;
}

function encode(level: LogLevel, event: string, fields: unknown): string {
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event: redactText(event),
  };
  const cleaned = redactDeep(fields);
  if (cleaned && typeof cleaned === "object" && !Array.isArray(cleaned)) {
    for (const [key, value] of Object.entries(cleaned)) {
      if (!RESERVED_KEYS.has(key)) record[key] = value;
    }
  }
  return JSON.stringify(record, replacer);
}

/** The line written when the fields cannot be encoded. Fixed text plus the redacted event name. */
function fallbackLine(level: LogLevel, event: string): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event: redactText(String(event)).slice(0, MAX_STRING_CHARACTERS),
    note: "fields omitted: not serialisable",
  });
}

function write(level: LogLevel, event: string, fields: unknown): void {
  try {
    if (RANK[level] < RANK[thresholdLevel()]) return;
    let line: string;
    try {
      line = encode(level, event, fields);
    } catch {
      line = fallbackLine(level, event);
    }
    if (sink !== null && process.env.NODE_ENV === "test") {
      sink(line, level);
      return;
    }
    const stream = level === "error" ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  } catch {
    // Logging must never break the caller. A failed write is dropped.
  }
}

export const log = {
  debug(event: string, fields?: Record<string, unknown>): void {
    write("debug", event, fields);
  },
  info(event: string, fields?: Record<string, unknown>): void {
    write("info", event, fields);
  },
  warn(event: string, fields?: Record<string, unknown>): void {
    write("warn", event, fields);
  },
  error(event: string, fields?: Record<string, unknown>): void {
    write("error", event, fields);
  },
};
