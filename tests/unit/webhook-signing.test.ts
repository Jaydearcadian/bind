import { describe, it, expect } from "vitest";
import {
  signPayload,
  verifySignature,
  workspaceWebhookSecret,
} from "../../src/webhooks/signing.js";

const MASTER = "test-master-secret-0123456789abcdef0123456789";
const NOW = 1_800_000_000; // a fixed clock, in seconds
const BODY = JSON.stringify({ eventId: "evt_sign_01", workspaceId: "ws_a", paused: true });

function signedAt(timestamp: number, body = BODY, secret = workspaceWebhookSecret(MASTER, "ws_a", 1)) {
  return { secret, timestamp, rawBody: body, signature: signPayload(secret, timestamp, body), nowSeconds: NOW };
}

describe("Webhook signing: what a signature proves", () => {
  it("a valid signature verifies", () => {
    expect(verifySignature(signedAt(NOW))).toBe(true);
  });

  it("a wrong signature does not", () => {
    const input = signedAt(NOW);
    const other = signPayload(input.secret, NOW, "a different body");
    expect(verifySignature({ ...input, signature: other })).toBe(false);
  });

  it("a signature of the wrong length is false, not an exception", () => {
    const input = signedAt(NOW);
    expect(() => verifySignature({ ...input, signature: "abcd" })).not.toThrow();
    expect(verifySignature({ ...input, signature: "abcd" })).toBe(false);
    expect(verifySignature({ ...input, signature: `${input.signature}00` })).toBe(false);
    expect(verifySignature({ ...input, signature: "" })).toBe(false);
  });

  it("a non-hex signature is false", () => {
    const input = signedAt(NOW);
    expect(verifySignature({ ...input, signature: "g".repeat(64) })).toBe(false);
    expect(verifySignature({ ...input, signature: `${input.signature.slice(0, 63)}z` })).toBe(false);
  });

  it("a timestamp older than five minutes is refused", () => {
    expect(verifySignature(signedAt(NOW - 300))).toBe(true);
    expect(verifySignature(signedAt(NOW - 301))).toBe(false);
  });

  it("a timestamp more than a minute in the future is refused", () => {
    expect(verifySignature(signedAt(NOW + 60))).toBe(true);
    expect(verifySignature(signedAt(NOW + 61))).toBe(false);
  });

  it("a non-integer timestamp is refused and does not throw", () => {
    const input = signedAt(NOW);
    expect(verifySignature({ ...input, timestamp: NOW + 0.5 })).toBe(false);
    expect(verifySignature({ ...input, timestamp: Number.NaN })).toBe(false);
  });

  it("the workspace secret differs per workspace and per version", () => {
    const a1 = workspaceWebhookSecret(MASTER, "ws_a", 1);
    expect(a1).toMatch(/^[0-9a-f]{64}$/);
    expect(workspaceWebhookSecret(MASTER, "ws_a", 1)).toBe(a1);
    expect(workspaceWebhookSecret(MASTER, "ws_b", 1)).not.toBe(a1);
    expect(workspaceWebhookSecret(MASTER, "ws_a", 2)).not.toBe(a1);
    expect(workspaceWebhookSecret(`${MASTER}x`, "ws_a", 1)).not.toBe(a1);
  });

  it("changing one byte of the body breaks the signature", () => {
    const input = signedAt(NOW);
    const flipped = BODY.replace("true", "trud"); // one byte changed
    expect(flipped.length).toBe(BODY.length);
    expect(flipped).not.toBe(BODY);
    expect(verifySignature({ ...input, rawBody: flipped })).toBe(false);
    expect(verifySignature({ ...input, rawBody: Buffer.from(BODY) })).toBe(true);
  });
});
