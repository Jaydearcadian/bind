import type { SettlementAdapter, TransferResult } from "./types.js";

/**
 * How long a submitted transfer must have been submitted before the node's "not found" can count as dropped (docs/decisions/0087,
 * item 5). A transaction that was just broadcast may not be visible to the node yet, so the node's answer is trusted only after
 * this age. Default 120 seconds. The services take an option to change it (tests use 0).
 */
export const DROPPED_AFTER_MS = 120_000;

export type DroppedVerdict =
  /** Every condition holds: the node reports the hash missing, the settlement is old enough, no transfer is found for the order
   * and the contract does not show it settled. The caller holds the settlement. It never sends again. */
  | { kind: "dropped" }
  /** A transfer for the order id was found by the lookup. The caller adopts it when it is confirmed. */
  | { kind: "found"; result: TransferResult }
  /** Not dropped. The caller leaves the settlement submitted, as before. */
  | { kind: "not_dropped"; reason: "node_has_it" | "too_young" | "lookup_unavailable" | "settled_on_contract" };

/**
 * Decides whether a `submitted` transfer may be called dropped. Pure apart from the two adapter reads, which it makes only when the
 * adapter has them. `ageMs` is read by the caller from the database clock, so no clock skew between hosts can change the answer.
 * A lookup or read that throws is "not dropped", never "not found" or "not settled".
 */
export async function assessDropped(
  adapter: SettlementAdapter,
  input: { orderId: string; ageMs: number | null; afterMs: number; notFoundOnNode: boolean }
): Promise<DroppedVerdict> {
  if (!input.notFoundOnNode) return { kind: "not_dropped", reason: "node_has_it" };
  if (input.ageMs === null || !(input.ageMs >= input.afterMs)) return { kind: "not_dropped", reason: "too_young" };

  if (adapter.findTransfer) {
    let found: TransferResult | null;
    try {
      found = await adapter.findTransfer({ orderId: input.orderId });
    } catch {
      return { kind: "not_dropped", reason: "lookup_unavailable" };
    }
    if (found !== null) return { kind: "found", result: found };
  }

  if (adapter.isOrderSettled) {
    let settled: boolean;
    try {
      settled = await adapter.isOrderSettled(input.orderId);
    } catch {
      return { kind: "not_dropped", reason: "lookup_unavailable" };
    }
    if (settled !== false) return { kind: "not_dropped", reason: "settled_on_contract" };
  }

  return { kind: "dropped" };
}
