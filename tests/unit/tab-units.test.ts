import { describe, it, expect } from "vitest";
import {
  MAX_CHARGE_MICRO,
  MICRO_PER_CENT,
  assertChargeAmountMicro,
  centsToMicro,
  COUNTERPARTY_ID_PATTERN,
  IDEMPOTENCY_KEY_PATTERN,
  ledgerKeys,
  parseChargeAmountMicro,
  settleableCents,
  tabAdapterOrderId,
  tabMatchHash,
} from "../../src/tabs/units.js";
import { TabError } from "../../src/tabs/errors.js";

/** ADR 0081: integer micro-USDC, 1 cent = 10_000 micro. A settlement is always the floor of the balance in whole cents. */
describe("tab units (ADR 0081)", () => {
  it("one cent is 10_000 micro-USDC and converts both ways for whole cents", () => {
    expect(MICRO_PER_CENT).toBe(10_000n);
    expect(centsToMicro(1n)).toBe(10_000n);
    expect(centsToMicro(250n)).toBe(2_500_000n);
  });

  it("refuses to convert a zero, negative or fractional-by-type amount to micro", () => {
    expect(() => centsToMicro(0n)).toThrow(TypeError);
    expect(() => centsToMicro(-1n)).toThrow(TypeError);
  });

  it("the settleable amount is the floor of the balance in whole cents", () => {
    expect(settleableCents(0n)).toBe(0n);
    expect(settleableCents(9_999n)).toBe(0n); // just under a cent carries over
    expect(settleableCents(10_000n)).toBe(1n);
    expect(settleableCents(15_000n)).toBe(1n); // 1.5 cents: pays 1 cent, 0.5 carries
    expect(settleableCents(19_999n)).toBe(1n);
    expect(settleableCents(20_000n)).toBe(2n);
  });

  it("a negative balance is an inconsistency, never a settleable amount", () => {
    expect(() => settleableCents(-1n)).toThrow(/inconsistent/);
  });

  it("the largest single charge is 25 USDC: one tenth of the default approval threshold, so no charge is large in one step", () => {
    expect(MAX_CHARGE_MICRO).toBe(25_000_000n);
  });

  it("parses a charge amount only as a decimal string of whole micro-USDC", () => {
    expect(parseChargeAmountMicro("1")).toBe(1n);
    expect(parseChargeAmountMicro("3000")).toBe(3000n);
    expect(parseChargeAmountMicro(String(MAX_CHARGE_MICRO))).toBe(MAX_CHARGE_MICRO);
  });

  it("refuses every other amount shape with INVALID_CHARGE_AMOUNT", () => {
    const bad: unknown[] = [
      "0",
      "00",
      "01",
      "-5",
      "+5",
      "1.5",
      "1e6",
      " 5",
      "",
      "abc",
      5,
      1.5,
      5n,
      null,
      undefined,
      {},
      "1".repeat(21),
      String(MAX_CHARGE_MICRO + 1n),
    ];
    for (const value of bad) {
      let caught: unknown = null;
      try {
        parseChargeAmountMicro(value);
      } catch (err) {
        caught = err;
      }
      expect(caught, JSON.stringify(String(value))).toBeInstanceOf(TabError);
      expect((caught as TabError).code).toBe("INVALID_CHARGE_AMOUNT");
      expect((caught as TabError).httpStatus).toBe(400);
    }
  });

  it("the typed check applies the same rules to a bigint: positive and at most the 100 USDC limit", () => {
    expect(() => assertChargeAmountMicro(1n)).not.toThrow();
    expect(() => assertChargeAmountMicro(MAX_CHARGE_MICRO)).not.toThrow();
    expect(() => assertChargeAmountMicro(0n)).toThrow(TabError);
    expect(() => assertChargeAmountMicro(-1n)).toThrow(TabError);
    expect(() => assertChargeAmountMicro(MAX_CHARGE_MICRO + 1n)).toThrow(TabError);
    expect(() => assertChargeAmountMicro(1)).toThrow(TabError);
  });

  it("the match hash is deterministic per settlement, is 32 bytes, and differs between settlements", () => {
    const a = tabMatchHash("tabset_1");
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
    expect(tabMatchHash("tabset_1")).toBe(a);
    expect(tabMatchHash("tabset_2")).not.toBe(a);
  });

  it("the adapter order id of a tab is prefixed, so it can never equal an order id", () => {
    expect(tabAdapterOrderId("tabset_abc")).toBe("tab_tabset_abc");
    expect(tabAdapterOrderId("tabset_abc").startsWith("ord_")).toBe(false);
  });

  it("ledger keys are namespaced by kind, so a client key cannot collide with a settlement's entries", () => {
    expect(ledgerKeys.charge("clear:tabset_1")).toBe("charge:clear:tabset_1");
    expect(ledgerKeys.clear("tabset_1")).toBe("clear:tabset_1");
    expect(ledgerKeys.reversal("tabset_1")).toBe("reversal:tabset_1");
    expect(ledgerKeys.effect("ws-a", "tabset_1")).toBe("ws-a:tab_settle:tabset_1");
    expect(ledgerKeys.adapterIdempotency("tabset_1")).toBe("idem_pay_tab_tabset_1");
    expect(ledgerKeys.charge("k")).not.toBe(ledgerKeys.clear("k"));
  });

  it("client idempotency keys and counterparty ids have bounded shapes", () => {
    expect(IDEMPOTENCY_KEY_PATTERN.test("charge-2026.10.23:order_7")).toBe(true);
    expect(IDEMPOTENCY_KEY_PATTERN.test("")).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test("a".repeat(129))).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test("has space")).toBe(false);
    expect(IDEMPOTENCY_KEY_PATTERN.test("semi;colon")).toBe(false);
    expect(COUNTERPARTY_ID_PATTERN.test("sup-1")).toBe(true);
    expect(COUNTERPARTY_ID_PATTERN.test("x".repeat(65))).toBe(false);
  });
});
