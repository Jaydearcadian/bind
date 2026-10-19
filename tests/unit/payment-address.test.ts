import { describe, it, expect } from "vitest";
import { simulatedPaymentAddress, normalizePaymentAddress } from "../../src/adapters/suppliers/payment-address.js";

describe("simulatedPaymentAddress", () => {
  it("is deterministic for the same id", () => {
    expect(simulatedPaymentAddress("ws-a_supp-sysco-metro")).toBe(simulatedPaymentAddress("ws-a_supp-sysco-metro"));
  });

  it("returns a lowercase 0x address of 42 characters", () => {
    const addr = simulatedPaymentAddress("ws-a_supp-sysco-metro");
    expect(addr).toMatch(/^0x[0-9a-f]{40}$/);
    expect(addr.length).toBe(42);
  });

  it("gives different ids different addresses", () => {
    expect(simulatedPaymentAddress("ws-a_supp-sysco-metro")).not.toBe(simulatedPaymentAddress("ws-a_supp-baldor-metro"));
    expect(simulatedPaymentAddress("ws-a_supp-sysco-metro")).not.toBe(simulatedPaymentAddress("ws-b_supp-sysco-metro"));
  });
});

describe("normalizePaymentAddress", () => {
  const lower = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
  const checksummed = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  it("accepts a valid lower-case address and returns the checksummed form", () => {
    expect(normalizePaymentAddress(lower)).toBe(checksummed);
  });

  it("keeps an already checksummed address unchanged", () => {
    expect(normalizePaymentAddress(checksummed)).toBe(checksummed);
  });

  it("rejects a short address", () => {
    expect(normalizePaymentAddress("0x1234")).toBeNull();
  });

  it("rejects a non-hex address of the right length", () => {
    expect(normalizePaymentAddress("0x" + "z".repeat(40))).toBeNull();
  });

  it("rejects non-string input", () => {
    expect(normalizePaymentAddress(undefined)).toBeNull();
    expect(normalizePaymentAddress(null)).toBeNull();
    expect(normalizePaymentAddress(123)).toBeNull();
    expect(normalizePaymentAddress(["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"])).toBeNull();
  });
});
