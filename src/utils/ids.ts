import crypto from "crypto";

const PREFIX_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * A new row id: `${prefix}_${uuid v4}`. Random, so it cannot collide between two inserts in the same millisecond,
 * and not guessable. Use it for row ids only. Keys that must be stable across retries are derived elsewhere.
 */
export function newId(prefix: string): string {
  if (typeof prefix !== "string" || !PREFIX_PATTERN.test(prefix)) {
    throw new TypeError(`Invalid id prefix '${String(prefix)}': use lowercase letters, digits and underscores, starting with a letter`);
  }
  return `${prefix}_${crypto.randomUUID()}`;
}
