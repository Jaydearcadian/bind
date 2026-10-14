import { describe, it, expect } from "vitest";
import { classifyOperation, EffectClass } from "../../src/policy/effect-classifier.js";

describe("Effect Classifier", () => {
  it("classifies read operations correctly", () => {
    expect(classifyOperation("inventory.read_stock")).toBe(EffectClass.READ);
    expect(classifyOperation("suppliers.list")).toBe(EffectClass.READ);
    expect(classifyOperation("quotes.view")).toBe(EffectClass.READ);
    expect(classifyOperation("orders.get_status")).toBe(EffectClass.READ);
    expect(classifyOperation("audit.query")).toBe(EffectClass.READ);
  });

  it("classifies external requests as non-committing requests", () => {
    expect(classifyOperation("suppliers.request_quote")).toBe(EffectClass.EXTERNAL_REQUEST);
    expect(classifyOperation("notifications.send_summary")).toBe(EffectClass.EXTERNAL_REQUEST);
    expect(classifyOperation("webhooks.ping")).toBe(EffectClass.EXTERNAL_REQUEST);
    expect(classifyOperation("suppliers.inquire_availability")).toBe(EffectClass.EXTERNAL_REQUEST);
  });

  it("classifies commercial commitments strictly", () => {
    expect(classifyOperation("orders.submit")).toBe(EffectClass.COMMERCIAL_COMMITMENT);
    expect(classifyOperation("quotes.accept")).toBe(EffectClass.COMMERCIAL_COMMITMENT);
    expect(classifyOperation("settlement.transfer_usdc")).toBe(EffectClass.COMMERCIAL_COMMITMENT);
    expect(classifyOperation("escrow.release_milestone")).toBe(EffectClass.COMMERCIAL_COMMITMENT);
    expect(classifyOperation("contractors.payout")).toBe(EffectClass.COMMERCIAL_COMMITMENT);
  });

  it("ensures RFQ / quote requests are never classified as commitments", () => {
    const rfqClass = classifyOperation("suppliers.request_quote");
    expect(rfqClass).not.toBe(EffectClass.COMMERCIAL_COMMITMENT);
    expect(rfqClass).toBe(EffectClass.EXTERNAL_REQUEST);
  });

  it("throws or returns unknown for unclassified operations to prevent fail-open", () => {
    expect(() => classifyOperation("unregistered.dangerous_action")).toThrow(/Unrecognized operation/);
  });
});
