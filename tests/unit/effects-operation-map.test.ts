import { describe, it, expect, vi, beforeEach } from "vitest";
import { EffectClass } from "../../src/policy/effect-classifier.js";
import { runEffect, type EffectSpec } from "../../src/effects/ledger.js";
import { query } from "../../src/db/client.js";

// Pure refusal checks run before any database access. The accept case runs the ledger against a stub
// database, so this file needs no PostgreSQL.
vi.mock("../../src/db/client.js", () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
}));
vi.mock("../../src/db/advisory-lock.js", () => ({
  acquireAdvisoryLock: vi.fn(async () => ({ release: async () => undefined })),
}));

function specWith(overrides: Partial<EffectSpec>): EffectSpec {
  return {
    workspaceId: "ws-operation-map",
    effectClass: EffectClass.EXTERNAL_REQUEST,
    operation: "suppliers.request_quote",
    idempotencyKey: "ws-operation-map:quote:rfq_map_1",
    request: { sku: "FOOD-FLOUR-50LB", quantity: 10, rfqId: "rfq_map_1" },
    ...overrides,
  };
}

describe("effects ledger operation map", () => {
  beforeEach(() => {
    vi.mocked(query).mockClear();
  });

  it("refuses an operation that is not in the map", async () => {
    const fn = vi.fn(async () => "ok");
    const spec = specWith({
      operation: "supplier.submit_order",
      effectClass: EffectClass.COMMERCIAL_COMMITMENT,
    });

    await expect(runEffect(spec, fn)).rejects.toBeInstanceOf(TypeError);
    expect(fn).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses an operation whose declared class differs from the map", async () => {
    const fn = vi.fn(async () => "ok");
    // orders.submit is a commercial commitment in the map. Declaring it as an external request is refused.
    const spec = specWith({ operation: "orders.submit", effectClass: EffectClass.EXTERNAL_REQUEST });

    await expect(runEffect(spec, fn)).rejects.toBeInstanceOf(TypeError);
    expect(fn).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts a mapped operation with its class", async () => {
    const fn = vi.fn(async () => ({ quoteId: "quote_map_1" }));
    const spec = specWith({ operation: "suppliers.request_quote", effectClass: EffectClass.EXTERNAL_REQUEST });

    const out = await runEffect(spec, fn);

    expect(out.result).toEqual({ quoteId: "quote_map_1" });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
