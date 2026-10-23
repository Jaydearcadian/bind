import { describe, it, expect } from "vitest";
import { generateIdempotencyKey } from "../../src/utils/idempotency.js";

describe("Idempotency keys", () => {
  it("generates deterministic keys for identical inputs regardless of key ordering", () => {
    const key1 = generateIdempotencyKey("ws-1", "orders.submit", {
      sku: "FLOUR-50",
      qty: 10,
      vendor: "sysco",
    });

    const key2 = generateIdempotencyKey("ws-1", "orders.submit", {
      vendor: "sysco",
      qty: 10,
      sku: "FLOUR-50",
    });

    expect(key1).toBe(key2);
  });

  it("generates different keys for different workspaces or payloads", () => {
    const key1 = generateIdempotencyKey("ws-1", "orders.submit", { sku: "FLOUR-50" });
    const key2 = generateIdempotencyKey("ws-2", "orders.submit", { sku: "FLOUR-50" });
    const key3 = generateIdempotencyKey("ws-1", "orders.submit", { sku: "SUGAR-50" });

    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
  });
});
