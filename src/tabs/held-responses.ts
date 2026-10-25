import type { RestoreOutcome } from "./ledger.js";

/**
 * The HTTP answer for an operator's restore of a held tab settlement (docs/decisions/0081). Pure, so the mapping of every
 * outcome, including a row that changed between the proof and the write, is unit-tested without a server.
 */
export interface HeldAnswer {
  status: number;
  body: Record<string, unknown>;
}

export function restoreAnswer(outcome: RestoreOutcome): HeldAnswer {
  switch (outcome.kind) {
    case "cancelled":
    case "already_cancelled":
      return {
        status: 200,
        body: {
          action: "cancel_and_restore",
          outcome: { kind: outcome.kind, proof: outcome.proof, amountCents: outcome.amountCents.toString(), replayed: outcome.replayed },
        },
      };
    case "refused":
      return {
        status: 409,
        body: {
          error: "The settlement cannot be restored: it may already have been sent. Nothing was changed.",
          code: "NOT_PROVABLY_UNSENT",
          reason: outcome.reason,
        },
      };
    case "changed":
      return {
        status: 409,
        body: { error: "The settlement changed while it was being restored. Nothing was changed. Retry.", code: "SETTLEMENT_BUSY" },
      };
    case "busy":
      return { status: 409, body: { error: "The settlement is being processed by another request. Retry later.", code: "SETTLEMENT_BUSY" } };
    case "not_held":
      return { status: 409, body: { error: "Only a held settlement can be restored.", code: "SETTLEMENT_NOT_HELD", status: outcome.status } };
    case "no_clear":
      return { status: 409, body: { error: "The settlement holds no balance, so there is nothing to restore.", code: "SETTLEMENT_OWNS_NO_BALANCE" } };
    case "not_found":
      return { status: 404, body: { error: "The settlement is not found in your workspace.", code: "SETTLEMENT_NOT_FOUND" } };
  }
}
