import { describe, it, expect, beforeEach } from "vitest";
import {
  generateIdempotencyKey,
  MemoryIdempotencyStore,
  DuplicateExecutionError,
} from "../../src/utils/idempotency.js";

describe("Idempotency Engine & Deduplication", () => {
  let store: MemoryIdempotencyStore;

  beforeEach(() => {
    store = new MemoryIdempotencyStore();
  });

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

  it("locks and executes once, returning cached result on replay", async () => {
    const key = "test-idem-key-101";
    let executions = 0;

    const executeOnce = async () => {
      return store.execute(key, "ws-1", "order", async () => {
        executions++;
        return { orderId: "po-real-42", status: "confirmed" };
      });
    };

    const res1 = await executeOnce();
    expect(res1).toEqual({ orderId: "po-real-42", status: "confirmed" });
    expect(executions).toBe(1);

    // Replay with exact same idempotency key
    const res2 = await executeOnce();
    expect(res2).toEqual({ orderId: "po-real-42", status: "confirmed" });
    expect(executions).toBe(1); // Did not re-execute!
  });

  it("throws DuplicateExecutionError if a concurrent execution holds the lock", async () => {
    const key = "test-concurrent-key";

    // Acquire lock without completing yet
    await store.acquireLock(key, "ws-1", "order");

    // Second attempt should fail with lock collision
    await expect(store.acquireLock(key, "ws-1", "order")).rejects.toThrow(
      DuplicateExecutionError
    );
  });
});
