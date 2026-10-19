import { describe, it, expect } from "vitest";
import { classifyRequestEvidence } from "../../src/agents/evidence-classification.js";

// Every order status the schema defines, plus the "no order" case.
const ORDER_STATUSES: Array<string | null> = [
  null,
  "draft",
  "awaiting_approval",
  "authorized",
  "submitted",
  "confirmed",
  "settling",
  "payment_hold",
  "settlement_submitted",
  "fulfilled",
  "reconciled",
  "cancelled",
];

describe("Request evidence classification", () => {
  it("local workspaces are LOCAL_PASS", () => {
    for (const orderStatus of ORDER_STATUSES) {
      expect(classifyRequestEvidence({ settlementMode: "local", orderStatus })).toBe("LOCAL_PASS");
      expect(classifyRequestEvidence({ settlementMode: "", orderStatus })).toBe("LOCAL_PASS");
    }
  });

  it("an arc-testnet request is NOT_RUN until its order is reconciled", () => {
    for (const orderStatus of ORDER_STATUSES) {
      if (orderStatus === "reconciled") continue;
      expect(classifyRequestEvidence({ settlementMode: "arc-testnet", orderStatus })).toBe("NOT_RUN");
    }
    expect(classifyRequestEvidence({ settlementMode: "arc-testnet", orderStatus: null })).toBe("NOT_RUN");
    expect(classifyRequestEvidence({ settlementMode: "arc-testnet", orderStatus: "settlement_submitted" })).toBe("NOT_RUN");
  });

  it("a reconciled arc-testnet order is LIVE_READ_PASS", () => {
    expect(classifyRequestEvidence({ settlementMode: "arc-testnet", orderStatus: "reconciled" })).toBe("LIVE_READ_PASS");
  });

  it("VERIFIED_REMOTE is never produced", () => {
    const modes = ["arc-testnet", "local", "", "ARC-TESTNET", "arc-mainnet"];
    for (const settlementMode of modes) {
      for (const orderStatus of ORDER_STATUSES) {
        const result = classifyRequestEvidence({ settlementMode, orderStatus });
        expect(result).not.toBe("VERIFIED_REMOTE");
        expect(["LOCAL_PASS", "LIVE_READ_PASS", "NOT_RUN"]).toContain(result);
      }
    }
  });
});
