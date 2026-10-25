import { describe, it, expect } from "vitest";
import { DROPPED_AFTER_MS, assessDropped } from "../../src/adapters/settlement/dropped.js";
import type { SettlementAdapter, TransferResult } from "../../src/adapters/settlement/types.js";

/**
 * The shared rule that decides whether a submitted transfer is dropped (docs/decisions/0087, item 5). Each condition is
 * tested alone: the node's answer, the age, the lookup and the contract read. A throw is never "not found" or "not settled".
 */

const FOUND: TransferResult = {
  txHash: `0x${"aa".repeat(32)}`,
  status: "confirmed",
  timestamp: new Date(0),
  mode: "arc-testnet",
  simulated: false,
  blockNumber: 3,
};

function adapter(opts: {
  find?: TransferResult | null | "throw";
  settled?: boolean | "throw";
  withFind?: boolean;
  withSettled?: boolean;
}): SettlementAdapter {
  const base: Partial<SettlementAdapter> = {};
  if (opts.withFind !== false) {
    base.findTransfer = async () => {
      if (opts.find === "throw") throw new Error("lookup down");
      return opts.find ?? null;
    };
  }
  if (opts.withSettled !== false) {
    base.isOrderSettled = async () => {
      if (opts.settled === "throw") throw new Error("read down");
      return opts.settled ?? false;
    };
  }
  return { mode: "arc-testnet", ...base } as unknown as SettlementAdapter;
}

const OLD = DROPPED_AFTER_MS + 1;
const base = { orderId: "ord_drop_1", afterMs: DROPPED_AFTER_MS, notFoundOnNode: true };

describe("assessDropped", () => {
  it("the default age is 120 seconds", () => {
    expect(DROPPED_AFTER_MS).toBe(120_000);
  });

  it("dropped only when the node reports not found, the age is met, and both lookups agree", async () => {
    const verdict = await assessDropped(adapter({ find: null, settled: false }), { ...base, ageMs: OLD });
    expect(verdict).toEqual({ kind: "dropped" });
  });

  it("not dropped while the node still has it, whatever the lookups say", async () => {
    const verdict = await assessDropped(adapter({ find: null, settled: false }), { ...base, notFoundOnNode: false, ageMs: OLD });
    expect(verdict).toEqual({ kind: "not_dropped", reason: "node_has_it" });
  });

  it("not dropped when the transfer is younger than the age, even with no lookup answer", async () => {
    const young = await assessDropped(adapter({ find: null, settled: false }), { ...base, ageMs: DROPPED_AFTER_MS - 1 });
    expect(young).toEqual({ kind: "not_dropped", reason: "too_young" });
    const unknown = await assessDropped(adapter({ find: null, settled: false }), { ...base, ageMs: null });
    expect(unknown).toEqual({ kind: "not_dropped", reason: "too_young" });
  });

  it("a transfer the lookup finds is found, not dropped, so the caller can adopt it", async () => {
    const verdict = await assessDropped(adapter({ find: FOUND, settled: false }), { ...base, ageMs: OLD });
    expect(verdict).toEqual({ kind: "found", result: FOUND });
  });

  it("a settled order on the contract is not dropped", async () => {
    const verdict = await assessDropped(adapter({ find: null, settled: true }), { ...base, ageMs: OLD });
    expect(verdict).toEqual({ kind: "not_dropped", reason: "settled_on_contract" });
  });

  it("a lookup that throws is not dropped: it is never read as not found", async () => {
    const verdict = await assessDropped(adapter({ find: "throw", settled: false }), { ...base, ageMs: OLD });
    expect(verdict).toEqual({ kind: "not_dropped", reason: "lookup_unavailable" });
  });

  it("a contract read that throws is not dropped: it is never read as not settled", async () => {
    const verdict = await assessDropped(adapter({ find: null, settled: "throw" }), { ...base, ageMs: OLD });
    expect(verdict).toEqual({ kind: "not_dropped", reason: "lookup_unavailable" });
  });

  // Rewritten (was: "judged on the node's answer and the age", which failed open). Both reads are required (ADR 0087).
  it("an adapter without the lookups is never dropped, whatever the node's answer and the age", async () => {
    for (const opts of [{ withFind: false, withSettled: false }, { withFind: false }, { withSettled: false }]) {
      const verdict = await assessDropped(adapter(opts), { ...base, ageMs: OLD });
      expect(verdict).toEqual({ kind: "not_dropped", reason: "reads_unavailable" });
    }
  });
});
