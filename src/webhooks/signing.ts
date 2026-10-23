import crypto from "node:crypto";

/**
 * Webhook signing (ADR 0022). Pure functions: no I/O, no configuration read, so every rule here is unit-testable.
 *
 * A signature proves that the sender held the secret for the workspace at the stated version, and that the bytes
 * were not changed after signing. It does not prove who the person behind the sender is: that comes only from a
 * surface binding in the database (see src/adapters/socialSurface.ts).
 */

/** Thrown when a route needs a signing secret and none is configured. The API maps it to 503 and processes nothing. */
export class WebhookNotConfiguredError extends Error {
  constructor() {
    super("Webhook signing is not configured");
    this.name = "WebhookNotConfiguredError";
  }
}

/** A signature is 32 bytes of HMAC-SHA256 in hex. */
const SIGNATURE_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Requests older than this, or dated further ahead than the future limit, are refused (replay window). */
export const MAX_SIGNATURE_AGE_SECONDS = 300;
export const MAX_SIGNATURE_FUTURE_SECONDS = 60;

/**
 * The signing secret of one workspace at one version. It is derived from the master secret, so no per-workspace
 * secret is stored. Rotation increments the version, which changes the derived secret.
 */
export function workspaceWebhookSecret(masterSecret: string, workspaceId: string, version: number): string {
  if (!masterSecret) throw new WebhookNotConfiguredError();
  return crypto
    .createHmac("sha256", masterSecret)
    .update(`bind-webhook-v1:${workspaceId}:${version}`)
    .digest("hex");
}

/** HMAC-SHA256 over `timestamp + "." + rawBody`, in hex. The raw bytes are signed, never a re-serialized body. */
export function signPayload(secret: string, timestamp: number, rawBody: string | Buffer): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(rawBody)
    .digest("hex");
}

export interface VerifySignatureInput {
  secret: string;
  timestamp: number;
  rawBody: string | Buffer;
  signature: string;
  /** Clock override for tests. Defaults to the current time in seconds. */
  nowSeconds?: number;
  maxAgeSeconds?: number;
  maxFutureSeconds?: number;
}

/**
 * True only when the timestamp is an integer inside the window, the signature is 64 hex characters, and it equals
 * the expected HMAC. Returns false on any bad input and never throws.
 */
export function verifySignature(input: VerifySignatureInput): boolean {
  try {
    const { secret, timestamp, rawBody, signature } = input;
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    const maxAge = input.maxAgeSeconds ?? MAX_SIGNATURE_AGE_SECONDS;
    const maxFuture = input.maxFutureSeconds ?? MAX_SIGNATURE_FUTURE_SECONDS;

    if (!secret) return false;
    if (!Number.isSafeInteger(timestamp)) return false;
    if (now - timestamp > maxAge) return false;
    if (timestamp - now > maxFuture) return false;
    if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) return false;

    const expected = Buffer.from(signPayload(secret, timestamp, rawBody), "hex");
    const given = Buffer.from(signature, "hex");
    if (expected.length !== given.length) return false;
    return crypto.timingSafeEqual(expected, given);
  } catch {
    return false;
  }
}
