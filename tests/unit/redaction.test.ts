import { describe, it, expect } from "vitest";
import { redactText, redactDeep } from "../../src/utils/redact.js";
import { config } from "../../src/config/env.js";

/*
 * The one redaction module (src/utils/redact.ts). Tests name the behaviour the brief fixes; keep the titles exact.
 */

const WORKSPACE_TOKEN = "bnd_" + "Ab0_-".repeat(8) + "Ab0"; // bnd_ + 43 base64url characters

describe("redaction: one module for text and evidence", () => {
  it("redacts a configured secret anywhere in a string", () => {
    const secret = config.SESSION_SECRET;
    expect(secret.length).toBeGreaterThanOrEqual(8);
    expect(redactText(`start ${secret} middle ${secret} end`)).toBe("start [redacted] middle [redacted] end");
    expect(redactText(`prefix${secret}suffix`)).toBe("prefix[redacted]suffix");
  });

  it("redacts a workspace token", () => {
    expect(redactText(`token ${WORKSPACE_TOKEN} was used`)).toBe("token [redacted-token] was used");
    expect(redactText(`two ${WORKSPACE_TOKEN} and ${WORKSPACE_TOKEN}`)).toBe(
      "two [redacted-token] and [redacted-token]"
    );
  });

  it("redacts a bearer header value", () => {
    expect(redactText("Authorization: Bearer abc.def-123_xyz")).toBe("Authorization: Bearer [redacted]");
    expect(redactText(`header Bearer ${WORKSPACE_TOKEN}, next`)).toBe("header Bearer [redacted], next");
  });

  it("redacts a url with credentials or a token parameter and keeps a plain url", () => {
    expect(
      redactText(
        "a https://user:pw@api.example.test/x b https://api.example.test/v1/quotes?key=ABC c https://supplier.example.test/quotes/123"
      )
    ).toBe("a [redacted-url] b [redacted-url] c https://supplier.example.test/quotes/123");
    expect(redactText("see https://hooks.example.test/in?access_token=zz and https://a.example.test/docs")).toBe(
      "see [redacted-url] and https://a.example.test/docs"
    );
  });

  it("redacts an opaque rpc path url", () => {
    const opaque = "Aa0_-".repeat(5); // 25 characters in one path segment
    expect(redactText(`call https://rpc.example.test/v1/${opaque} failed`)).toBe("call [redacted-url] failed");
    // A shorter segment is not treated as an opaque endpoint key.
    expect(redactText(`https://rpc.example.test/v1/${"a".repeat(19)}`)).toBe(
      `https://rpc.example.test/v1/${"a".repeat(19)}`
    );
  });

  it("redacts a private key assignment but keeps a transaction hash", () => {
    const privateKey = "0x" + "ab".repeat(32);
    const txHash = "0x" + "cd".repeat(32);
    expect(redactText(`PRIVATE_KEY=${privateKey} tx ${txHash}`)).toBe(`PRIVATE_KEY=[redacted] tx ${txHash}`);
    expect(redactText(`privateKey: ${privateKey}`)).toBe("privateKey: [redacted]");
    expect(redactText(`{"privateKey": "${privateKey}"}`)).toBe(`{"privateKey": "[redacted]"}`);
    expect(redactText(`settled in ${txHash}`)).toBe(`settled in ${txHash}`);
  });

  it("redacts values under secret-like keys at any depth", () => {
    const out = redactDeep({
      outer: { list: [{ apiKey: "k-1", nested: { clientSecret: "s-1", label: "fine" } }] },
      accessToken: "t-1",
      password: 123,
      privateKey: "p-1",
      auth_token: "a-1",
      cookie: "c-1",
      SIGNING_KEY: "g-1",
    });
    expect(out).toEqual({
      outer: { list: [{ apiKey: "[REDACTED]", nested: { clientSecret: "[REDACTED]", label: "fine" } }] },
      accessToken: "[REDACTED]",
      password: "[REDACTED]",
      privateKey: "[REDACTED]",
      auth_token: "[REDACTED]",
      cookie: "[REDACTED]",
      SIGNING_KEY: "[REDACTED]",
    });
  });

  it("does not redact idempotencyKey, publicKey, keyId, tokenId, txHash or matchHash", () => {
    const input = {
      idempotencyKey: "idem_kitchen_abc123",
      publicKey: "pub-1",
      keyId: "key-1",
      tokenId: "tok_1",
      txHash: "0x" + "ef".repeat(32),
      matchHash: "match-1",
      orderId: "ord_1",
    };
    expect(redactDeep(input)).toEqual(input);
  });

  it("handles cycles and deep nesting without throwing", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => redactDeep(cyclic)).not.toThrow();
    const out = redactDeep(cyclic);
    expect(out.name).toBe("loop");
    expect(out.self).not.toBe(cyclic);

    let deep: Record<string, unknown> = { leaf: `value ${config.SESSION_SECRET}` };
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    expect(() => redactDeep(deep)).not.toThrow();
    expect(JSON.stringify(redactDeep(deep))).not.toContain(config.SESSION_SECRET);
  });

  it("returns a copy and leaves the input unchanged", () => {
    const original = { token: "abc-visible", nested: { note: `has ${config.SESSION_SECRET}` } };
    const snapshot = JSON.stringify(original);
    const out = redactDeep(original);
    expect(out).not.toBe(original);
    expect(out.nested).not.toBe(original.nested);
    expect(JSON.stringify(original)).toBe(snapshot);
    expect(out.nested.note).toBe("has [redacted]");
  });

  it("redacts a secret that appears inside an array of strings", () => {
    const secret = config.SESSION_SECRET;
    expect(redactDeep({ lines: ["ok", `leak ${secret}`] })).toEqual({ lines: ["ok", "leak [redacted]"] });
    expect(redactDeep([`top ${secret}`, 1, null])).toEqual(["top [redacted]", 1, null]);
  });

  it("never throws on odd input", () => {
    const hostile = {
      toString() {
        throw new Error("no string for you");
      },
    };
    const inputs: unknown[] = [undefined, null, 42, true, Symbol("odd"), Object.create(null), hostile, () => 1, BigInt(7)];
    for (const input of inputs) {
      expect(() => redactText(input as string)).not.toThrow();
      expect(typeof redactText(input as string)).toBe("string");
      expect(() => redactDeep(input)).not.toThrow();
    }
    expect(redactDeep(undefined)).toBeUndefined();
    expect(redactDeep(null)).toBeNull();
    expect(redactDeep(new Date(0))).toEqual(new Date(0));
  });
});
