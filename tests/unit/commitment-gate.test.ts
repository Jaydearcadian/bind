import { describe, it, expect } from "vitest";
import {
  decideCommitment,
  type CommitmentFacts,
  type CommitmentInput,
} from "../../src/policy/commitment-gate.js";
import { PolicyDecision } from "../../src/policy/types.js";

const NOW = new Date("2026-10-19T12:00:00Z");
const WS = "ws_kitchen_a";
const SUPPLIER = "ws_kitchen_a_supp-sysco-metro";
const DAY_MS = 24 * 60 * 60 * 1000;

/** A fully permitted, unexpired, in-limit commitment. Each test overrides only what it is about. */
function facts(overrides: Partial<CommitmentFacts> = {}): CommitmentFacts {
  return {
    workspace: { workspaceId: WS, budgetDailyLimitCents: 100000n, approvalThresholdCents: 25000n },
    role: {
      id: "role_procurement",
      workspaceId: WS,
      roleName: "procurement_agent",
      enabled: true,
      permittedEffects: ["read", "external_request", "commercial_commitment"],
      spendingLimitCents: 50000n,
    },
    supplier: { workspaceId: WS, verified: true },
    quote: {
      workspaceId: WS,
      supplierId: SUPPLIER,
      quantity: 10,
      totalPriceCents: 24500n,
      validUntil: new Date(NOW.getTime() + DAY_MS),
    },
    committedSpendTodayCents: 0n,
    ...overrides,
  };
}

function input(overrides: Partial<CommitmentInput> = {}): CommitmentInput {
  return {
    workspaceId: WS,
    workflowId: "wf_test_1",
    actorRole: "procurement_agent",
    supplierId: SUPPLIER,
    quoteId: "quote_test_1",
    quantity: 10,
    totalPriceCents: 24500n,
    now: NOW,
    ...overrides,
  };
}

describe("Single commitment gate: pure decision", () => {
  it("allows a verified, unexpired quote inside every limit", () => {
    const d = decideCommitment(facts(), input());
    expect(d.decision).toBe(PolicyDecision.ALLOW);
    expect(d.reasonCodes).toEqual([]);
    expect(d.evidence).toMatchObject({
      amountCents: "24500",
      dailySpentCents: "0",
      dailyLimitCents: "100000",
      thresholdCents: "25000",
      roleLimitCents: "50000",
    });
  });

  it("denies a disabled role", () => {
    const f = facts({ role: { ...facts().role!, enabled: false } });
    const d = decideCommitment(f, input());
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["ROLE_NOT_PERMITTED"]);
  });

  it("denies a role without commercial_commitment", () => {
    const f = facts({ role: { ...facts().role!, permittedEffects: ["read", "external_request"] } });
    const d = decideCommitment(f, input());
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["ROLE_NOT_PERMITTED"]);
  });

  it("denies when the role row is missing", () => {
    const d = decideCommitment(facts({ role: null }), input());
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["ROLE_NOT_PERMITTED"]);
  });

  it("denies a role that belongs to another workspace", () => {
    const f = facts({ role: { ...facts().role!, workspaceId: "ws_other" } });
    const d = decideCommitment(f, input());
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["ROLE_NOT_PERMITTED"]);
  });

  it("denies an unverified supplier", () => {
    const d = decideCommitment(facts({ supplier: { workspaceId: WS, verified: false } }), input());
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["SUPPLIER_NOT_VERIFIED"]);
  });

  it("denies a missing supplier", () => {
    const d = decideCommitment(facts({ supplier: null }), input());
    expect(d.reasonCodes).toEqual(["SUPPLIER_NOT_VERIFIED"]);
  });

  it("denies a quote that is missing or belongs to another workspace", () => {
    expect(decideCommitment(facts({ quote: null }), input()).reasonCodes).toEqual(["QUOTE_NOT_FOUND"]);
    const other = facts({ quote: { ...facts().quote!, workspaceId: "ws_other" } });
    expect(decideCommitment(other, input()).reasonCodes).toEqual(["QUOTE_NOT_FOUND"]);
  });

  it("denies an expired quote", () => {
    const expired = facts({ quote: { ...facts().quote!, validUntil: new Date(NOW.getTime() - 1000) } });
    const d = decideCommitment(expired, input());
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["QUOTE_EXPIRED"]);
  });

  it("a quote whose validity ends exactly now is expired", () => {
    const edge = facts({ quote: { ...facts().quote!, validUntil: NOW } });
    expect(decideCommitment(edge, input()).reasonCodes).toEqual(["QUOTE_EXPIRED"]);
  });

  it("denies when the caller's price differs from the quote row (QUOTE_CHANGED)", () => {
    const d = decideCommitment(facts(), input({ totalPriceCents: 1n }));
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["QUOTE_CHANGED"]);
  });

  it("denies when the caller's quantity or supplier differs from the quote row", () => {
    expect(decideCommitment(facts(), input({ quantity: 11 })).reasonCodes).toEqual(["QUOTE_CHANGED"]);
    expect(decideCommitment(facts(), input({ supplierId: "someone_else" })).reasonCodes).toEqual([
      "QUOTE_CHANGED",
    ]);
  });

  it("denies when the daily limit would be exceeded", () => {
    const d = decideCommitment(facts({ committedSpendTodayCents: 90000n }), input());
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["DAILY_LIMIT_EXCEEDED"]);
  });

  it("the daily limit is inclusive: spend that lands exactly on the limit is allowed", () => {
    const d = decideCommitment(facts({ committedSpendTodayCents: 75500n }), input());
    expect(d.decision).toBe(PolicyDecision.ALLOW);
  });

  it("escalates above the approval threshold", () => {
    const f = facts({ workspace: { workspaceId: WS, budgetDailyLimitCents: 100000n, approvalThresholdCents: 20000n } });
    const d = decideCommitment(f, input());
    expect(d.decision).toBe(PolicyDecision.REQUIRE_APPROVAL);
    expect(d.reasonCodes).toEqual(["ABOVE_APPROVAL_THRESHOLD"]);
  });

  it("an amount equal to the approval threshold is allowed", () => {
    const f = facts({ workspace: { workspaceId: WS, budgetDailyLimitCents: 100000n, approvalThresholdCents: 24500n } });
    expect(decideCommitment(f, input()).decision).toBe(PolicyDecision.ALLOW);
  });

  it("escalates above the role limit", () => {
    const f = facts({ role: { ...facts().role!, spendingLimitCents: 20000n } });
    const d = decideCommitment(f, input());
    expect(d.decision).toBe(PolicyDecision.REQUIRE_APPROVAL);
    expect(d.reasonCodes).toEqual(["ROLE_LIMIT_EXCEEDED"]);
  });

  it("a role limit of zero escalates every positive amount", () => {
    const f = facts({
      role: { ...facts().role!, spendingLimitCents: 0n },
      workspace: { workspaceId: WS, budgetDailyLimitCents: 100000n, approvalThresholdCents: 25000n },
    });
    for (const amount of [1n, 100n, 24500n]) {
      const d = decideCommitment(
        facts({ ...f, quote: { ...facts().quote!, totalPriceCents: amount } }),
        input({ totalPriceCents: amount, quantity: 10 })
      );
      expect(d.decision, `amount ${amount}`).toBe(PolicyDecision.REQUIRE_APPROVAL);
      expect(d.reasonCodes, `amount ${amount}`).toEqual(["ROLE_LIMIT_EXCEEDED"]);
    }
  });

  it("denies while the workspace agents are paused", () => {
    const f = facts({
      workspace: { workspaceId: WS, budgetDailyLimitCents: 100000n, approvalThresholdCents: 25000n, agentsPaused: true },
    });
    const d = decideCommitment(f, input());
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["AGENTS_PAUSED"]);
    // A pause is a denial, not an escalation: an owner approval cannot resume a commitment while paused.
    const escalated = decideCommitment(f, input({ ownerReviewRequested: true }));
    expect(escalated.decision).toBe(PolicyDecision.DENY);
    expect(escalated.reasonCodes).toEqual(["AGENTS_PAUSED"]);
  });

  it("owner review requested escalates but never allows", () => {
    const d = decideCommitment(facts(), input({ ownerReviewRequested: true }));
    expect(d.decision).toBe(PolicyDecision.REQUIRE_APPROVAL);
    expect(d.reasonCodes).toEqual(["OWNER_REVIEW_REQUESTED"]);
  });

  it("a denial wins over an escalation and all reasons are reported", () => {
    const f = facts({
      supplier: { workspaceId: WS, verified: false },
      quote: { ...facts().quote!, validUntil: new Date(NOW.getTime() - 1000) },
      workspace: { workspaceId: WS, budgetDailyLimitCents: 100000n, approvalThresholdCents: 1000n },
    });
    const d = decideCommitment(f, input({ ownerReviewRequested: true }));
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["SUPPLIER_NOT_VERIFIED", "QUOTE_EXPIRED"]);
  });

  it("a model escalation cannot turn a deny into an allow", () => {
    const f = facts({ role: { ...facts().role!, enabled: false } });
    const d = decideCommitment(f, input({ ownerReviewRequested: true }));
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["ROLE_NOT_PERMITTED"]);
  });

  it("reports both escalation reasons when role limit and threshold are both exceeded", () => {
    const f = facts({
      role: { ...facts().role!, spendingLimitCents: 20000n },
      workspace: { workspaceId: WS, budgetDailyLimitCents: 100000n, approvalThresholdCents: 20000n },
    });
    const d = decideCommitment(f, input());
    expect(d.decision).toBe(PolicyDecision.REQUIRE_APPROVAL);
    expect(d.reasonCodes).toEqual(["ROLE_LIMIT_EXCEEDED", "ABOVE_APPROVAL_THRESHOLD"]);
  });
  it("denies a zero amount", () => {
    const f = facts({ quote: { ...facts().quote!, totalPriceCents: 0n } });
    const d = decideCommitment(f, input({ totalPriceCents: 0n }));
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["INVALID_AMOUNT"]);
  });

  it("denies a negative amount on the quote row", () => {
    const f = facts({ quote: { ...facts().quote!, totalPriceCents: -100n } });
    const d = decideCommitment(f, input({ totalPriceCents: -100n }));
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["INVALID_AMOUNT"]);
  });

  it("denies a negative quantity", () => {
    const onRow = facts({ quote: { ...facts().quote!, quantity: -10 } });
    expect(decideCommitment(onRow, input({ quantity: -10 })).reasonCodes).toEqual(["INVALID_AMOUNT"]);

    const zeroRow = facts({ quote: { ...facts().quote!, quantity: 0 } });
    expect(decideCommitment(zeroRow, input({ quantity: 0 })).reasonCodes).toEqual(["INVALID_AMOUNT"]);
  });

  it("denies a non-positive amount or quantity from the caller, and reports the mismatch too", () => {
    const d = decideCommitment(facts(), input({ totalPriceCents: 0n }));
    expect(d.decision).toBe(PolicyDecision.DENY);
    expect(d.reasonCodes).toEqual(["QUOTE_CHANGED", "INVALID_AMOUNT"]);

    const q = decideCommitment(facts({ quote: { ...facts().quote!, quantity: 0 } }), input({ quantity: 0 }));
    expect(q.reasonCodes).toEqual(["INVALID_AMOUNT"]);
  });

  it("one cent over the approval threshold escalates and exactly the threshold allows", () => {
    const oneCentOver = facts({
      workspace: { workspaceId: WS, budgetDailyLimitCents: 100000n, approvalThresholdCents: 24499n },
    });
    const over = decideCommitment(oneCentOver, input());
    expect(over.decision).toBe(PolicyDecision.REQUIRE_APPROVAL);
    expect(over.reasonCodes).toEqual(["ABOVE_APPROVAL_THRESHOLD"]);

    const exact = facts({
      workspace: { workspaceId: WS, budgetDailyLimitCents: 100000n, approvalThresholdCents: 24500n },
    });
    expect(decideCommitment(exact, input()).decision).toBe(PolicyDecision.ALLOW);
  });
});
