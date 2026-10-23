import { describe, it, expect } from "vitest";
import { ZodError, z } from "zod";
import { GENERIC_ERROR_MESSAGE, containsNul, isInfrastructureError, publicErrorMessage } from "../../src/server/errors.js";

/** The client-facing error rules (Task 11, docs/decisions/0031). Pure: no database, no HTTP. */

describe("publicErrorMessage", () => {
  it("keeps a domain message", () => {
    expect(publicErrorMessage(new Error("sku is required"))).toBe("sku is required");
  });

  it("replaces a database driver error with the generic message", () => {
    const pgLike = Object.assign(new Error('value "1" is out of range for type bigint'), { code: "22003", name: "DatabaseError" });
    expect(publicErrorMessage(pgLike)).toBe(GENERIC_ERROR_MESSAGE);
    const withCodeOnly = Object.assign(new Error("relation \"workspaces\" does not exist"), { code: "42P01" });
    expect(publicErrorMessage(withCodeOnly)).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("replaces a Node system error (ECONNREFUSED...) with the generic message", () => {
    const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    expect(publicErrorMessage(refused)).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("keeps a domain error whose code is a word with an underscore", () => {
    const domain = Object.assign(new Error("External reference was already used"), { code: "EXTERNAL_REF_REUSED" });
    expect(isInfrastructureError(domain)).toBe(false);
    expect(publicErrorMessage(domain)).toBe("External reference was already used");
  });

  it("replaces a non-Error throw with the generic message", () => {
    expect(publicErrorMessage("boom")).toBe(GENERIC_ERROR_MESSAGE);
    expect(publicErrorMessage({ message: "not an error" })).toBe(GENERIC_ERROR_MESSAGE);
    expect(publicErrorMessage(undefined)).toBe(GENERIC_ERROR_MESSAGE);
  });

  it("names zod fields only, never the rule text", () => {
    const parsed = z.object({ sku: z.string().max(3) }).safeParse({ sku: "far too long" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(publicErrorMessage(parsed.error)).toBe("Invalid request body");
    expect(publicErrorMessage(new ZodError([]))).toBe("Invalid request body");
  });

  it("redacts and cuts a long message to 300 characters", () => {
    const text = publicErrorMessage(new Error("x".repeat(5000)));
    expect(text.length).toBe(300);
  });

  it("never returns a stack", () => {
    const err = new Error("visible");
    expect(publicErrorMessage(err)).not.toMatch(/\sat\s|stack/i);
  });
});

describe("containsNul", () => {
  it("finds a NUL in a value, a key, or any depth of an array or object", () => {
    expect(containsNul("a\u0000b")).toBe(true);
    expect(containsNul({ sku: "x\u0000" })).toBe(true);
    expect(containsNul({ "k\u0000": 1 })).toBe(true);
    expect(containsNul({ a: [{ b: { c: ["ok", "d\u0000"] } }] })).toBe(true);
  });

  it("is false for clean values, numbers and nulls", () => {
    expect(containsNul({ sku: "FOOD-FLOUR-50LB", n: 1, z: null, t: true, a: [1, "x"] })).toBe(false);
    expect(containsNul(undefined)).toBe(false);
  });

  it("walks a deep nesting without recursion", () => {
    let deep: unknown = "clean";
    for (let i = 0; i < 20_000; i++) deep = { next: deep };
    expect(containsNul(deep)).toBe(false);
  });
});
