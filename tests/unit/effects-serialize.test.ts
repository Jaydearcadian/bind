import { describe, it, expect } from "vitest";
import { encodeResult, decodeResult, requestHash } from "../../src/effects/serialize.js";

describe("effect result serialization", () => {
  it("round-trips bigint and Date", () => {
    const when = new Date("2026-10-19T12:34:56.789Z");
    const decoded = decodeResult<{ cents: bigint; when: Date; nested: { big: bigint } }>(
      encodeResult({ cents: 24500n, when, nested: { big: -9007199254740993n } })
    );

    expect(typeof decoded.cents).toBe("bigint");
    expect(decoded.cents).toBe(24500n);
    expect(decoded.when).toBeInstanceOf(Date);
    expect(decoded.when.getTime()).toBe(when.getTime());
    expect(decoded.nested.big).toBe(-9007199254740993n);
  });

  it("does not revive a string that looks like a bigint", () => {
    const decoded = decodeResult<{ id: string; digits: string; iso: string }>(
      encodeResult({ id: "123", digits: "0042", iso: "2026-10-19T00:00:00.000Z" })
    );

    expect(decoded).toEqual({ id: "123", digits: "0042", iso: "2026-10-19T00:00:00.000Z" });
    expect(typeof decoded.id).toBe("string");
    expect(decoded.iso).not.toBeInstanceOf(Date);
  });

  it("keeps a user object that looks like a tag as an object", () => {
    const value = { $bigint: "7", $date: "2026-10-19T00:00:00.000Z", $object: { x: 1 } };
    const decoded = decodeResult<typeof value>(encodeResult(value));

    expect(decoded).toEqual(value);
    expect(typeof decoded.$bigint).toBe("string");
  });

  it("drops undefined fields", () => {
    const json = encodeResult({ a: 1, b: undefined, c: { d: undefined, e: "x" } });

    expect(json).not.toContain('"b"');
    expect(json).not.toContain('"d"');
    expect(Object.keys(decodeResult<any>(json))).toEqual(["a", "c"]);
    expect(Object.keys(decodeResult<any>(json).c)).toEqual(["e"]);
  });

  it("rejects NaN, Infinity and cycles", () => {
    expect(() => encodeResult({ n: NaN })).toThrow();
    expect(() => encodeResult({ n: Infinity })).toThrow();
    expect(() => encodeResult([-Infinity])).toThrow();

    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => encodeResult(cyclic)).toThrow();
  });

  it("rejects objects that are not plain data", () => {
    expect(() => encodeResult({ m: new Map([["a", 1]]) })).toThrow();
    expect(() => encodeResult({ f: () => 1 })).toThrow();
  });

  it("request hash ignores key order", () => {
    const a = requestHash({ sku: "FLOUR-50", qty: 10, vendor: { id: "v1", region: "west" } });
    const b = requestHash({ vendor: { region: "west", id: "v1" }, qty: 10, sku: "FLOUR-50" });

    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("request hash distinguishes bigint 1 from string \"1\"", () => {
    expect(requestHash({ a: 1n })).not.toBe(requestHash({ a: "1" }));
    expect(requestHash({ a: 1n })).not.toBe(requestHash({ a: 1 }));
  });

  it("request hash distinguishes a Date from its ISO string", () => {
    const when = new Date("2026-10-19T00:00:00.000Z");
    expect(requestHash({ when })).not.toBe(requestHash({ when: when.toISOString() }));
  });

  it("request hash distinguishes a user object shaped like a bigint tag from the bigint", () => {
    expect(requestHash({ a: 1n })).not.toBe(requestHash({ a: { $bigint: "1" } }));
  });
});
