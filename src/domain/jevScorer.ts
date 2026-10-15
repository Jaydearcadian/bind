import crypto from "node:crypto";

export interface JevQuoteCandidate {
  quoteId: string;
  supplierId: string;
  supplierName: string;
  unitPriceCents: number;
  totalPriceCents: number;
  validUntil: string;
  isExpired: boolean;
  isVerifiedSupplier: boolean;
  historicalMatchRate: number; // 0.0 to 1.0 from three_way_matches
}

export interface JevEvaluationInput {
  workspaceId: string;
  templateId: string;
  sku: string;
  currentQuantity: number;
  parLevel: number;
  reorderQuantity: number;
  approvalThresholdCents: number;
  remainingDailyBudgetCents: number;
  candidates: JevQuoteCandidate[];
}

export interface JevDecisionScoreResult {
  provider: "typesafe-jev-system-one" | "deterministic-calibrated-scorer";
  evidenceClassification: "LIVE_READ_PASS" | "LOCAL_PASS" | "BLOCKED";
  urgencyLevel: 1 | 2 | 3 | 4 | 5;
  recommendedQuoteId: string;
  choiceConfidence: number; // 0.00 to 1.00
  autonomousRouteProbability: number; // 0.00 to 1.00
  holdForOwnerReview: boolean;
  holdReasons: string[];
  scoreBreakdown: Record<
    string,
    {
      priceEfficiency: number;
      stockoutProtection: number;
      matchReliability: number;
      compositeScore: number;
    }
  >;
  evaluationHash: `0x${string}`;
}

const MIN_AUTONOMOUS_CONFIDENCE = 0.85;

export async function evaluateWithJevSystemOne(
  input: JevEvaluationInput
): Promise<JevDecisionScoreResult> {
  const holdReasons: string[] = [];

  // 1. Hard deterministic preconditions (Spec Section 6.3 & FR-03)
  const validCandidates = input.candidates.filter(
    (c) => !c.isExpired && c.isVerifiedSupplier
  );

  if (validCandidates.length === 0) {
    holdReasons.push("NO_VALID_NON_EXPIRED_QUOTE_FROM_APPROVED_SUPPLIER");
  }

  // Compute deterministic per-quote utility breakdown
  const minPrice =
    input.candidates.length > 0
      ? Math.min(...input.candidates.map((c) => Math.max(c.totalPriceCents, 1)))
      : 1;
  const scoreBreakdown: JevDecisionScoreResult["scoreBreakdown"] = {};

  for (const c of input.candidates) {
    const priceEfficiency = Number((minPrice / Math.max(c.totalPriceCents, 1)).toFixed(4));
    const stockoutProtection =
      input.currentQuantity <= 0
        ? 1.0
        : Number(Math.min(1, input.parLevel / Math.max(input.currentQuantity, 1)).toFixed(4));
    const matchReliability = Number(c.historicalMatchRate.toFixed(4));

    const compositeScore =
      c.isExpired || !c.isVerifiedSupplier
        ? 0
        : Number(
            (
              0.45 * priceEfficiency +
              0.30 * stockoutProtection +
              0.25 * matchReliability
            ).toFixed(4)
          );

    scoreBreakdown[c.quoteId] = {
      priceEfficiency,
      stockoutProtection,
      matchReliability,
      compositeScore,
    };
  }

  const ranked = [...validCandidates].sort(
    (a, b) =>
      (scoreBreakdown[b.quoteId]?.compositeScore ?? 0) -
      (scoreBreakdown[a.quoteId]?.compositeScore ?? 0)
  );

  const topCandidate = ranked[0] ?? input.candidates[0];
  const deficitRatio =
    (input.parLevel - input.currentQuantity) / Math.max(input.parLevel, 1);
  const urgencyLevel = Math.min(
    5,
    Math.max(1, Math.ceil(deficitRatio * 5))
  ) as 1 | 2 | 3 | 4 | 5;

  let provider: JevDecisionScoreResult["provider"] =
    "deterministic-calibrated-scorer";
  let evidenceClassification: JevDecisionScoreResult["evidenceClassification"] =
    "LOCAL_PASS";
  let recommendedQuoteId = topCandidate?.quoteId ?? "NONE";
  let choiceConfidence =
    validCandidates.length > 0 && topCandidate
      ? scoreBreakdown[topCandidate.quoteId]?.compositeScore ?? 0.9
      : 0.0;
  let autonomousRouteProbability =
    validCandidates.length > 0 &&
    topCandidate &&
    topCandidate.totalPriceCents <= input.approvalThresholdCents &&
    topCandidate.totalPriceCents <= input.remainingDailyBudgetCents
      ? 0.94
      : 0.15;

  // 2. If TYPESAFE_API_KEY is present, query TypeSafe's Jev ("System One") API
  if (process.env.TYPESAFE_API_KEY && validCandidates.length > 0) {
    const apiUrl =
      process.env.TYPESAFE_API_URL ?? "https://api.typesafe.ai/v1/evaluate";
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`,
      },
      body: JSON.stringify({
        model: process.env.TYPESAFE_JEV_MODEL ?? "jev-latest",
        state: {
          templateId: input.templateId,
          sku: input.sku,
          currentQuantity: input.currentQuantity,
          parLevel: input.parLevel,
          approvalThresholdCents: input.approvalThresholdCents,
          remainingDailyBudgetCents: input.remainingDailyBudgetCents,
          candidates: validCandidates,
        },
        questions: {
          urgency_score: {
            type: "score",
            instructions:
              "Rate replenishment urgency from 1 to 5 based on current stock deficit relative to par level.",
            levels: 5,
          },
          preferred_quote: {
            type: "choice",
            instructions:
              "Select the quoteId with the strongest balance of unit price efficiency and historical 3-way match reliability.",
            choices: validCandidates.map((c) => c.quoteId),
          },
          autonomous_execution_safe: {
            type: "noul",
            instructions:
              "Is this purchase unambiguous, within autonomous spend policy, and safe to execute without human intervention?",
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `[JEV_SYSTEM_ONE_ERROR] TypeSafe Jev API returned HTTP ${response.status}`
      );
    }

    const data = (await response.json()) as {
      answers?: {
        urgency_score?: { value?: number };
        preferred_quote?: { mode?: string; confidence?: number };
        autonomous_execution_safe?: { probability?: number };
      };
    };

    provider = "typesafe-jev-system-one";
    evidenceClassification = "LIVE_READ_PASS";
    if (data.answers?.preferred_quote?.mode) {
      recommendedQuoteId = data.answers.preferred_quote.mode;
    }
    if (typeof data.answers?.preferred_quote?.confidence === "number") {
      choiceConfidence = data.answers.preferred_quote.confidence;
    }
    if (typeof data.answers?.autonomous_execution_safe?.probability === "number") {
      autonomousRouteProbability =
        data.answers.autonomous_execution_safe.probability;
    }
  }

  // 3. Enforce calibrated confidence & policy gates
  if (choiceConfidence < MIN_AUTONOMOUS_CONFIDENCE) {
    holdReasons.push(
      `JEV_CONFIDENCE_BELOW_THRESHOLD (${choiceConfidence.toFixed(2)} < ${MIN_AUTONOMOUS_CONFIDENCE})`
    );
  }
  if (
    topCandidate &&
    topCandidate.totalPriceCents > input.approvalThresholdCents
  ) {
    holdReasons.push(
      `EXCEEDS_AUTONOMOUS_SPEND_THRESHOLD (${topCandidate.totalPriceCents}c > ${input.approvalThresholdCents}c)`
    );
  }

  const holdForOwnerReview = holdReasons.length > 0;

  const unsignedPayload = {
    workspaceId: input.workspaceId,
    sku: input.sku,
    provider,
    evidenceClassification,
    urgencyLevel,
    recommendedQuoteId,
    choiceConfidence,
    autonomousRouteProbability,
    holdForOwnerReview,
    holdReasons,
    scoreBreakdown,
  };

  const evaluationHash = (`0x` +
    crypto
      .createHash("sha256")
      .update(JSON.stringify(unsignedPayload))
      .digest("hex")) as `0x${string}`;

  return {
    ...unsignedPayload,
    evaluationHash,
  };
}
