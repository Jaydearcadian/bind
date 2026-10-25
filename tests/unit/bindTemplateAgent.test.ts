import { describe, it, expect } from "vitest";
import { generateVerifiableDecisionRecord } from "../../src/agents/bindTemplateAgent.js";
import {
  CircleAgentStackAdapter,
  BIND_SETTLEMENT_CONTRACT,
  WHITELISTED_VENDOR,
} from "../../src/adapters/circleAgentStack.js";
import { HybridMarketBenchmarkAdapter } from "../../src/adapters/marketBenchmark.js";
import {
  writeWorkflowAntiDriftFiles,
  assertNoSpecDrift,
} from "../../src/agents/antiDriftWriter.js";

describe("Bind Template DeepAgent & Verifiable Decision Record", () => {
  const sampleQuotes = [
    {
      vendorId: "v_clean_01",
      vendorName: "Arc Testnet Whitelisted Produce Co.",
      vendorWallet: "0xa8358AED200D6CB6C856F972D853C1be833006ea",
      unitPriceUsdc: "0.0001",
      totalPriceUsdc: "0.0010",
      leadTimeDays: 2,
      isWhitelistedOnChain: true,
    },
    {
      vendorId: "v_unapproved_02",
      vendorName: "Unverified Spot Vendor",
      vendorWallet: "0x000000000000000000000000000000000000dead",
      unitPriceUsdc: "0.00005",
      totalPriceUsdc: "0.0005",
      leadTimeDays: 1,
      isWhitelistedOnChain: false,
    },
  ];

  it("loads both kitchen-ops and coffee-roaster templates and enforces honesty invariants", async () => {
    const kitchenDecision = await generateVerifiableDecisionRecord({
      workflowId: "wf_test_001",
      templateId: "kitchen-ops",
      skuName: "San Marzano Tomatoes (Case)",
      quantityRequested: 10,
      candidateQuotes: sampleQuotes,
      dailyLimitUsdc: "1.0",
    });

    expect(kitchenDecision.supplierIntegrationMode).toBe("SIMULATED_SUPPLIER_ADAPTER");
    expect(kitchenDecision.selectedVendor.vendorWallet).toBe(
      "0xa8358AED200D6CB6C856F972D853C1be833006ea"
    );
    expect(kitchenDecision.onChainPolicyPreFlight.contractAddress).toBe(
      "0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29"
    );
    expect(kitchenDecision.onChainPolicyPreFlight.withinDailyLimit).toBe(true);
    expect(kitchenDecision.lifecycleSeparation.goodsFulfilmentStatus).toBe(
      "NOT_FULFILLED_AWAITING_3WAY_MATCH"
    );
    expect(kitchenDecision.decisionHash).toMatch(/^0x[a-f0-9]{64}$/);

    const roasterDecision = await generateVerifiableDecisionRecord({
      workflowId: "wf_test_002",
      templateId: "coffee-roaster",
      skuName: "Washed Yirgacheffe Green Lot (60kg)",
      quantityRequested: 1,
      candidateQuotes: sampleQuotes,
      dailyLimitUsdc: "1.0",
    });

    expect(roasterDecision.templateId).toBe("coffee-roaster");
    expect(roasterDecision.decisionHash).not.toBe(kitchenDecision.decisionHash);
  });

  it("triggers owner override requirement when spend exceeds daily limit", async () => {
    const expensiveQuotes = [
      {
        vendorId: "v_clean_01",
        vendorName: "Arc Testnet Whitelisted Produce Co.",
        vendorWallet: "0xa8358AED200D6CB6C856F972D853C1be833006ea",
        unitPriceUsdc: "1.5000",
        totalPriceUsdc: "1.5000",
        leadTimeDays: 1,
        isWhitelistedOnChain: true,
      },
    ];

    const decision = await generateVerifiableDecisionRecord({
      workflowId: "wf_test_exceed",
      templateId: "kitchen-ops",
      skuName: "Organic Olive Oil 5L",
      quantityRequested: 1,
      candidateQuotes: expensiveQuotes,
      dailyLimitUsdc: "1.0",
    });

    expect(decision.onChainPolicyPreFlight.withinDailyLimit).toBe(false);
    expect(decision.onChainPolicyPreFlight.requiresOwnerOverride).toBe(true);
  });

  it("verifies MarketBenchmarkAdapter returns deterministic fallback when offline", async () => {
    const adapter = new HybridMarketBenchmarkAdapter();
    const benchmark = await adapter.fetchBenchmark("Butter 36lb", "commercial restaurant");

    expect(benchmark.integrationMode).toBe("OFFLINE_DETERMINISTIC_FALLBACK");
    expect(benchmark.provider).toBe("deterministic-fallback");
    expect(benchmark.benchmarks.length).toBeGreaterThan(0);
    expect(benchmark.benchmarks[0].url).toContain("0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29");
  });

  it("queries the BindSettlement vendor allowlist read-only (the Circle settlement path was removed, ADR 0085)", async () => {
    const circleAdapter = new CircleAgentStackAdapter();

    // Check query fallback
    const queryRes = await circleAdapter.queryVendorWhitelistStatus(WHITELISTED_VENDOR);
    expect(queryRes.command).toContain("whitelistedVendors");
    expect(queryRes.command).toContain(BIND_SETTLEMENT_CONTRACT);
    expect(queryRes.whitelisted).toBeNull();
    expect(queryRes.executionMode).toBe("SIMULATED_NO_LIVE_CLI");
  });

  it("writes and locks STATE_ANCHOR.md and DECISION_EVIDENCE.md and blocks spec drift", async () => {
    const decision = await generateVerifiableDecisionRecord({
      workflowId: "wf_test_antidrift",
      templateId: "kitchen-ops",
      skuName: "Organic Semolina Flour",
      quantityRequested: 5,
      candidateQuotes: sampleQuotes,
      dailyLimitUsdc: "1.0",
    });

    const { stateAnchorMarkdown, decisionEvidenceMarkdown } =
      await writeWorkflowAntiDriftFiles(decision, {
        settlementTxHash: "0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb",
        paymentStatusOverride: "SETTLED_ON_ARC_TESTNET",
      });

    expect(stateAnchorMarkdown).toContain("Workflow State Anchor: wf_test_antidrift");
    expect(stateAnchorMarkdown).toContain("0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29");
    expect(stateAnchorMarkdown).toContain("SETTLED_ON_ARC_TESTNET");
    expect(decisionEvidenceMarkdown).toContain("Verifiable Procurement Decision Record");
    expect(decisionEvidenceMarkdown).toContain("SIMULATED_SUPPLIER_ADAPTER");
    expect(decisionEvidenceMarkdown).toContain("NOT_FULFILLED_AWAITING_3WAY_MATCH");

    // Test drift detection
    const driftedRecord = {
      ...decision,
      onChainPolicyPreFlight: {
        ...decision.onChainPolicyPreFlight,
        contractAddress: "0x0000000000000000000000000000000000000bad" as any,
      },
    };

    expect(() => assertNoSpecDrift(driftedRecord)).toThrowError(/Contract address drifted/);
  });
  it("renders an unchecked on-chain whitelist as 'not checked', never as true or false, and does not force an owner override", async () => {
    const decision = await generateVerifiableDecisionRecord({
      workflowId: "wf_test_null_whitelist",
      templateId: "kitchen-ops",
      skuName: "Organic Semolina Flour",
      quantityRequested: 1,
      candidateQuotes: [
        {
          vendorId: "v_unchecked",
          vendorName: "Unchecked Supplier",
          vendorWallet: "0x000000000000000000000000000000000000beef",
          unitPriceUsdc: "1.0000",
          totalPriceUsdc: "1.0000",
          leadTimeDays: 1,
          isWhitelistedOnChain: null,
        },
      ],
      dailyLimitUsdc: "1.0",
    });

    expect(decision.selectedVendor.isWhitelistedOnChain).toBeNull();
    expect(decision.onChainPolicyPreFlight.vendorWhitelisted).toBeNull();
    expect(decision.onChainPolicyPreFlight.withinDailyLimit).toBe(true);
    expect(decision.onChainPolicyPreFlight.requiresOwnerOverride).toBe(false);
    if (decision.reasoningProvider === "deterministic-policy-engine") {
      expect(decision.agentRationale).toContain("On-chain whitelist=not checked by Bind");
      expect(decision.agentRationale).not.toContain("On-chain whitelist=true");
      expect(decision.agentRationale).not.toContain("On-chain whitelist=false");
    }

    const { stateAnchorMarkdown } = await writeWorkflowAntiDriftFiles(decision);
    expect(stateAnchorMarkdown).toContain("NOT_CHECKED_BY_BIND");
    expect(stateAnchorMarkdown).not.toContain("UNWHITELISTED_0x65e822e9");
    expect(stateAnchorMarkdown).not.toMatch(/Vendor Whitelist Check:\*\*\s*`PASS`/);
  });
});
