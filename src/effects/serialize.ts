import crypto from "crypto";
import { canonicalStringify } from "../utils/idempotency.js";

/**
 * JSON encoding for effect results and request hashes.
 *
 * Plain JSON cannot carry bigint (supplier adapters return cents as bigint) or Date. Those become tagged
 * objects: `{"$bigint":"123"}` and `{"$date":"2026-..."}`. A plain object that has any key starting with `$`
 * is wrapped as `{"$object":{...}}`, so a user object that looks like a tag is never mistaken for one. A
 * plain string such as "123" is never revived.
 *
 * Undefined object fields are dropped, as JSON.stringify does. NaN, Infinity, cycles, functions, symbols and
 * non-plain objects (Map, Set, class instances) throw, because silently losing data would corrupt a replay.
 */

const TAG_BIGINT = "$bigint";
const TAG_DATE = "$date";
const TAG_OBJECT = "$object";

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Converts a value to JSON-safe data with tags. Returns undefined only for an undefined input. */
function toTagged(value: unknown, ancestors: object[]): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Effect data cannot contain ${String(value)}`);
    return value;
  }
  if (typeof value === "bigint") return { [TAG_BIGINT]: value.toString() };
  if (typeof value !== "object") throw new TypeError(`Effect data cannot contain a ${typeof value}`);

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("Effect data cannot contain an invalid Date");
    return { [TAG_DATE]: value.toISOString() };
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError("Effect data must be plain data (object, array, string, number, boolean, bigint, Date, null)");
  }
  if (ancestors.includes(value)) throw new TypeError("Effect data cannot contain a cycle");

  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => {
        const tagged = toTagged(item, ancestors);
        return tagged === undefined ? null : tagged;
      });
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const tagged = toTagged((value as Record<string, unknown>)[key], ancestors);
      if (tagged !== undefined) out[key] = tagged;
    }
    return Object.keys(out).some((key) => key.startsWith("$")) ? { [TAG_OBJECT]: out } : out;
  } finally {
    ancestors.pop();
  }
}

function fromTagged(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(fromTagged);
  if (node === null || typeof node !== "object") return node;

  const keys = Object.keys(node);
  if (keys.length === 1) {
    const [key] = keys;
    const inner = (node as Record<string, unknown>)[key];
    if (key === TAG_BIGINT) {
      if (typeof inner !== "string" || !/^-?\d+$/.test(inner)) throw new SyntaxError("Malformed bigint tag");
      return BigInt(inner);
    }
    if (key === TAG_DATE) {
      if (typeof inner !== "string") throw new SyntaxError("Malformed date tag");
      const date = new Date(inner);
      if (Number.isNaN(date.getTime())) throw new SyntaxError("Malformed date tag");
      return date;
    }
    if (key === TAG_OBJECT && inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
      // The wrapped object's own keys are data, not tags.
      return mapValues(inner as Record<string, unknown>);
    }
  }
  return mapValues(node as Record<string, unknown>);
}

function mapValues(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) out[key] = fromTagged(obj[key]);
  return out;
}

/**
 * Encodes a result for storage. A top-level undefined is stored as null and decodes to null.
 * Throws on data that cannot round-trip (see the header comment).
 */
export function encodeResult(value: unknown): string {
  const tagged = toTagged(value, []);
  return JSON.stringify(tagged === undefined ? null : tagged);
}

/** Decodes the output of encodeResult. */
export function decodeResult<T>(json: string): T {
  return fromTagged(JSON.parse(json)) as T;
}

/**
 * sha256 of the canonical (sorted-key) tagged form of a request. Two requests hash equal only when they are
 * the same data: key order is ignored, but 1n and "1" (or a Date and its ISO string) are different.
 */
export function requestHash(request: unknown): string {
  const tagged = toTagged(request, []);
  if (tagged === undefined) throw new TypeError("An effect request must not be undefined");
  return crypto.createHash("sha256").update(canonicalStringify(tagged)).digest("hex");
}
