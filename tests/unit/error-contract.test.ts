import { describe, it, expect } from "vitest";
import { enrichErrorBody, ERROR_CODES } from "../../src/server/error-contract.js";

/** Error body v2 (ADR 0047): the pure step that rewrites an error body. The server wiring is tested in tests/integration/error-contract.test.ts. */
const ctx = { requestId: "req-12345678" };

describe("enrichErrorBody", () => {
  it("leaves success bodies, arrays, non-objects and bodies without a string error alone", () => {
    const ok = { id: "x" };
    expect(enrichErrorBody(200, ok, ctx)).toBe(ok);
    expect(enrichErrorBody(201, [1], ctx)).toEqual([1]);
    expect(enrichErrorBody(500, "text", ctx)).toBe("text");
    expect(enrichErrorBody(500, null, ctx)).toBeNull();
    const health = { status: "error" };
    expect(enrichErrorBody(500, health, ctx)).toBe(health);
    expect(enrichErrorBody(400, { error: "" }, ctx)).toEqual({ error: "" });
  });

  it("keeps every existing field and adds the v2 fields", () => {
    const out = enrichErrorBody(404, { error: "Approval not found", code: "APPROVAL_NOT_FOUND", reasonCodes: ["X"] }, ctx) as Record<string, unknown>;
    expect(out).toMatchObject({ error: "Approval not found", code: "APPROVAL_NOT_FOUND", reasonCodes: ["X"], category: "not_found", retryable: false, requestId: "req-12345678" });
    expect(out.recovery).toBeUndefined();
  });

  it("gives a code-less error a generic code by status", () => {
    const table: Array<[number, string, string]> = [
      [400, "VALIDATION_FAILED", "validation"],
      [401, "UNAUTHENTICATED", "authentication"],
      [403, "FORBIDDEN", "authorization"],
      [404, "NOT_FOUND", "not_found"],
      [409, "CONFLICT", "conflict"],
      [500, "INTERNAL_ERROR", "internal"],
      [503, "UNAVAILABLE", "unavailable"],
    ];
    for (const [status, code, category] of table) {
      const out = enrichErrorBody(status, { error: "x" }, ctx) as Record<string, unknown>;
      expect(out.code, String(status)).toBe(code);
      expect(out.category, String(status)).toBe(category);
    }
  });

  it("derives the category of a code the table does not know from the status", () => {
    const out = enrichErrorBody(409, { error: "Not held", code: "NOT_HELD" }, ctx) as Record<string, unknown>;
    expect(out).toMatchObject({ code: "NOT_HELD", category: "conflict", retryable: false });
  });

  it("a rate limit is retryable and always has retryAfterSeconds, from the header or 5", () => {
    expect(enrichErrorBody(429, { error: "Too many requests", code: "RATE_LIMITED" }, { ...ctx, retryAfterHeader: "12" })).toMatchObject({ retryable: true, retryAfterSeconds: 12, recovery: [{ action: "wait_and_retry" }] });
    expect(enrichErrorBody(429, { error: "Too many requests", code: "RATE_LIMITED" }, ctx)).toMatchObject({ retryAfterSeconds: 5 });
    expect(enrichErrorBody(429, { error: "x", code: "RATE_LIMITED" }, { ...ctx, retryAfterHeader: "abc" })).toMatchObject({ retryAfterSeconds: 5 });
  });

  it("a state change conflict is retryable and never a validation, authentication, authorization or not-found failure", () => {
    expect(enrichErrorBody(409, { error: "x", code: "WORKFLOW_STATE_CHANGED" }, ctx)).toMatchObject({ retryable: true });
    for (const [code, shape] of Object.entries(ERROR_CODES)) {
      if (["validation", "authentication", "authorization", "not_found", "policy"].includes(shape.category)) expect(shape.retryable, code).toBe(false);
    }
  });

  it("copies validation field names into details and never invents them", () => {
    const out = enrichErrorBody(400, { error: "Invalid request body", fields: ["sku", "quantity"] }, ctx) as Record<string, any>;
    expect(out.fields).toEqual(["sku", "quantity"]);
    expect(out.details).toEqual({ fields: ["sku", "quantity"] });
    expect((enrichErrorBody(400, { error: "x" }, ctx) as Record<string, unknown>).details).toBeUndefined();
    const many = enrichErrorBody(400, { error: "x", fields: Array.from({ length: 50 }, (_, i) => `f${i}`) }, ctx) as Record<string, any>;
    expect(many.details.fields).toHaveLength(20);
  });

  it("cuts a long message to 300 characters and does nothing to a body that already has a category", () => {
    const long = enrichErrorBody(400, { error: "a".repeat(500) }, ctx) as Record<string, string>;
    expect(long.error).toHaveLength(300);
    const done = { error: "x", code: "A", category: "validation", retryable: false, requestId: "r" };
    expect(enrichErrorBody(400, done, ctx)).toBe(done);
  });

  it("uses a placeholder request id only if the context has none, and ignores a malformed code", () => {
    expect((enrichErrorBody(500, { error: "x" }, { requestId: undefined }) as Record<string, string>).requestId).toBe("unknown-request");
    expect((enrichErrorBody(400, { error: "x", code: "bad code!" }, ctx) as Record<string, string>).code).toBe("VALIDATION_FAILED");
  });
});
