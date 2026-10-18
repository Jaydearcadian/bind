import { describe, it, expect } from "vitest";
import { evaluateWithJevSystemOne } from "../../src/domain/jevScorer.js";

describe("TypeSafe Jev System One Decision Scorer", () => {
  const sampleCandidates = [
    {
      quoteId: "q_best",
      supplierId: "supp_01",
      supplierName: "Wholesale Prime",
      unitPriceCents: 2000,
      totalPriceCents: 20000, // $200.00
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      isExpired: false,
      isVerifiedSupplier: true,
      historicalMatchRate: 0.98,
    },
    {
      quoteId: "q_expensive",
      supplierId: "supp_02",
      supplierName: "Spot Express",
      unitPriceCents: 3500,
      totalPriceCents: 35000, // $350.00
      validUntil: new Date(Date.now() + 86400000).toISOString(),
      isExpired: false,
      isVerifiedSupplier: true,
      historicalMatchRate: 0.85,
    },
  ];

  it("calculates calibrated composite scores and selects optimal candidate", async () => {
    const result = await evaluateWithJevSystemOne({
      workspaceId: "ws_test",
      templateId: "kitchen-ops",
      sku: "FOOD-FLOUR-50LB",
      currentQuantity: 2,
      parLevel: 10,
      reorderQuantity: 10,
      approvalThresholdCents: 25000, // $250.00
      remainingDailyBudgetCents: 100000,
      candidates: sampleCandidates,
    });

    expect(result.recommendedQuoteId).toBe("q_best");
    expect(result.urgencyLevel).toBe(4); // (10-2)/10 = 0.8 * 5 = 4
    expect(result.scoreBreakdown["q_best"].compositeScore).toBeGreaterThan(
      result.scoreBreakdown["q_expensive"].compositeScore
    );
    expect(result.evaluationHash).toMatch(/^0x[a-f0-9]{64}$/);
    expect(result.holdForOwnerReview).toBe(false);
  });

  it("holds for owner review when spend exceeds autonomous threshold", async () => {
    const result = await evaluateWithJevSystemOne({
      workspaceId: "ws_test",
      templateId: "kitchen-ops",
      sku: "FOOD-BUTTER-36LB",
      currentQuantity: 1,
      parLevel: 5,
      reorderQuantity: 4,
      approvalThresholdCents: 15000, // $150.00 threshold (< $200.00 best quote)
      remainingDailyBudgetCents: 100000,
      candidates: sampleCandidates,
    });

    expect(result.holdForOwnerReview).toBe(true);
    expect(result.holdReasons.some((r) => r.includes("EXCEEDS_AUTONOMOUS_SPEND_THRESHOLD"))).toBe(
      true
    );
  });

  it("holds for owner review when no valid non-expired quotes exist", async () => {
    const expiredCandidates = sampleCandidates.map((c) => ({
      ...c,
      isExpired: true,
    }));

    const result = await evaluateWithJevSystemOne({
      workspaceId: "ws_test",
      templateId: "kitchen-ops",
      sku: "FOOD-TOMATO-CASE",
      currentQuantity: 0,
      parLevel: 10,
      reorderQuantity: 10,
      approvalThresholdCents: 50000,
      remainingDailyBudgetCents: 100000,
      candidates: expiredCandidates,
    });

    expect(result.holdForOwnerReview).toBe(true);
    expect(result.holdReasons).toContain(
      "NO_VALID_NON_EXPIRED_QUOTE_FROM_APPROVED_SUPPLIER"
    );
  });
});
