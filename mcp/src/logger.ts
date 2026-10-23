/**
 * One JSON object per line, for stderr (docs/decisions/0037). Stdout belongs to the MCP protocol and is never written here.
 * Every string in an entry, its keys included, has the configured secrets and any `bnd_` token pattern replaced.
 */

/** A log entry: an event name and plain fields. Callers never pass arguments or results of a tool call. */
export interface LogEntry {
  event: string;
  level?: "info" | "error";
  [field: string]: unknown;
}

export const REDACTED = "[redacted]";

/** The shape of a Bind workspace token and of any other `bnd_` value. Redacted wherever it appears. */
export const BND_PATTERN = /bnd_[A-Za-z0-9_-]{8,}/g;

const MAX_DEPTH = 20;

/** Replaces every configured secret, and every `bnd_` value, in a text. An empty secret is ignored. */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join(REDACTED);
  }
  return out.replace(BND_PATTERN, REDACTED);
}

/** The same redaction through a value: strings, keys, arrays and objects, to a fixed depth. */
export function redactValue(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[redactText(key, secrets)] = redactValue(item, secrets, depth + 1);
  }
  return out;
}

export interface LoggerOptions {
  /** Values that must never be written (the workspace token). */
  secrets: readonly string[];
  /** Writes one complete line, including its newline. */
  write: (line: string) => void;
  /** Clock for the `ts` field. */
  now?: () => Date;
}

/** A logger that writes each entry as one redacted JSON line. It never throws. */
export function createLogger(options: LoggerOptions): (entry: LogEntry) => void {
  const now = options.now ?? (() => new Date());
  return (entry) => {
    try {
      const line = JSON.stringify({ ts: now().toISOString(), ...(redactValue(entry, options.secrets) as object) });
      options.write(`${line}\n`);
    } catch {
      options.write(`${JSON.stringify({ ts: now().toISOString(), event: "log.failed", level: "error" })}\n`);
    }
  };
}
