import { describe, it, expect } from "vitest";
import {
  MAX_AMOUNT_CENTS,
  MAX_QUANTITY,
  MAX_QUOTE_VALIDITY_MS,
  SupplierResponseInvalidError,
  validateOrderResponse,
  validateQuoteResponse,
} from "../../src/adapters/suppliers/validate.js";
import type { OrderRequest, OrderResponse, QuoteRequest, QuoteResponse } from "../../src/adapters/suppliers/types.js";

/** Pure rules for what a supplier may return (Task 11, docs/decisions/0031). No database, no network. */

const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 24 * 3_600_000;

const request: QuoteRequest = {
  workspaceId: "ws-1",
  sku: "FOOD-FLOUR-50LB",
  quantity: 10,
  rfqId: "rfq_1",
  supplierId: "ws-1_supp-sysco-metro",
};

function goodQuote(overrides: Partial<QuoteResponse> = {}): QuoteResponse {
  return {
    quoteId: "quote_supp-sysco-metro_abc123",
    rfqId: "rfq_1",
    supplierId: "ws-1_supp-sysco-metro",
    supplierName: "Sysco Metro Distribution (Simulated)",
    sku: "FOOD-FLOUR-50LB",
    quantity: 10,
    unitPriceCents: 2450n,
    totalPriceCents: 24500n,
    validUntil: new Date(NOW.getTime() + DAY),
    isSimulated: true,
    ...overrides,
  };
}

const orderRequest: OrderRequest = {
  workspaceId: "ws-1",
  orderId: "ord_wf_1",
  orderNumber: "ORD-0001",
  supplierId: "ws-1_supp-sysco-metro",
  sku: "FOOD-FLOUR-50LB",
  quantity: 10,
  unitPriceCents: 2450n,
  totalPriceCents: 24500n,
  idempotencyKey: "idem_ord_ord_wf_1",
};

function goodOrder(overrides: Partial<OrderResponse> = {}): OrderResponse {
  return {
    orderNumber: "ORD-0001",
    externalOrderRef: "EXT-SUPP-SYSCO-METRO-ABC123",
    status: "confirmed",
    confirmedAt: NOW,
    isSimulated: true,
    ...overrides,
  };
}

describe("validateQuoteResponse", () => {
  it("accepts a quote that answers the request exactly", () => {
    expect(validateQuoteResponse(request, goodQuote(), NOW)).toEqual({ valid: true });
  });

  it("refuses a quote for another supplier, sku, quantity or rfq", () => {
    expect(validateQuoteResponse(request, goodQuote({ supplierId: "other" }), NOW)).toEqual({ valid: false, reason: "SUPPLIER_MISMATCH" });
    expect(validateQuoteResponse(request, goodQuote({ sku: "FOOD-MILK-CASE" }), NOW)).toEqual({ valid: false, reason: "SKU_MISMATCH" });
    expect(validateQuoteResponse(request, goodQuote({ quantity: 11 }), NOW)).toEqual({ valid: false, reason: "QUANTITY_MISMATCH" });
    expect(validateQuoteResponse(request, goodQuote({ rfqId: "rfq_2" }), NOW)).toEqual({ valid: false, reason: "RFQ_MISMATCH" });
  });

  it("refuses a zero, negative, non-integer-looking or absurd price", () => {
    const price = (unit: unknown) => validateQuoteResponse(request, goodQuote({ unitPriceCents: unit as bigint, totalPriceCents: 1n }), NOW);
    expect(price(0n)).toEqual({ valid: false, reason: "PRICE_INVALID" });
    expect(price(-1n)).toEqual({ valid: false, reason: "PRICE_INVALID" });
    expect(price(24.5)).toEqual({ valid: false, reason: "PRICE_INVALID" });
    expect(price("2450")).toEqual({ valid: false, reason: "PRICE_INVALID" });
    expect(price(MAX_AMOUNT_CENTS + 1n)).toEqual({ valid: false, reason: "PRICE_INVALID" });
  });

  it("refuses a total that is not unit price times quantity, or an absurd total", () => {
    expect(validateQuoteResponse(request, goodQuote({ totalPriceCents: 24501n }), NOW)).toEqual({ valid: false, reason: "TOTAL_INVALID" });
    expect(validateQuoteResponse(request, goodQuote({ totalPriceCents: 0n }), NOW)).toEqual({ valid: false, reason: "TOTAL_INVALID" });
    expect(validateQuoteResponse(request, goodQuote({ totalPriceCents: 1.5 as unknown as bigint }), NOW)).toEqual({ valid: false, reason: "TOTAL_INVALID" });
  });

  it("refuses a validity that has passed or is more than 30 days away", () => {
    expect(validateQuoteResponse(request, goodQuote({ validUntil: new Date(NOW.getTime() - 1) }), NOW)).toEqual({ valid: false, reason: "VALIDITY_INVALID" });
    expect(validateQuoteResponse(request, goodQuote({ validUntil: NOW }), NOW)).toEqual({ valid: false, reason: "VALIDITY_INVALID" });
    expect(
      validateQuoteResponse(request, goodQuote({ validUntil: new Date(NOW.getTime() + MAX_QUOTE_VALIDITY_MS + 1) }), NOW)
    ).toEqual({ valid: false, reason: "VALIDITY_INVALID" });
    expect(validateQuoteResponse(request, goodQuote({ validUntil: new Date("not a date") }), NOW)).toEqual({ valid: false, reason: "VALIDITY_INVALID" });
    expect(validateQuoteResponse(request, goodQuote({ validUntil: new Date(NOW.getTime() + MAX_QUOTE_VALIDITY_MS) }), NOW)).toEqual({ valid: true });
  });

  it("bounds the name and the quote id, and refuses control characters", () => {
    expect(validateQuoteResponse(request, goodQuote({ supplierName: "S".repeat(10_000) }), NOW)).toEqual({ valid: false, reason: "NAME_INVALID" });
    expect(validateQuoteResponse(request, goodQuote({ supplierName: "Sysco\u0000Metro" }), NOW)).toEqual({ valid: false, reason: "NAME_INVALID" });
    expect(validateQuoteResponse(request, goodQuote({ supplierName: "" }), NOW)).toEqual({ valid: false, reason: "NAME_INVALID" });
    expect(validateQuoteResponse(request, goodQuote({ quoteId: "q".repeat(65) }), NOW)).toEqual({ valid: false, reason: "QUOTE_ID_INVALID" });
    expect(validateQuoteResponse(request, goodQuote({ quoteId: "q 1" }), NOW)).toEqual({ valid: false, reason: "QUOTE_ID_INVALID" });
  });

  it("stores HTML and SQL in a name as data: they are allowed, because they are inert once stored", () => {
    const name = `<img src=x onerror=alert(1)> ' OR 1=1 --`;
    expect(validateQuoteResponse(request, goodQuote({ supplierName: name }), NOW)).toEqual({ valid: true });
  });

  it("refuses a response that is not an object", () => {
    expect(validateQuoteResponse(request, null as unknown as QuoteResponse, NOW)).toEqual({ valid: false, reason: "RESPONSE_INVALID" });
  });

  it("refuses a requested quantity that is not a positive integer within the bound", () => {
    for (const q of [0, -1, 1.5, MAX_QUANTITY + 1]) {
      expect(validateQuoteResponse({ ...request, quantity: q }, goodQuote({ quantity: q }), NOW)).toEqual({ valid: false, reason: "QUANTITY_INVALID" });
    }
  });

  it("accepts the largest quantity the request may carry", () => {
    const big = { ...request, quantity: MAX_QUANTITY };
    expect(validateQuoteResponse(big, goodQuote({ quantity: MAX_QUANTITY, totalPriceCents: 2450n * BigInt(MAX_QUANTITY) }), NOW)).toEqual({ valid: true });
  });
});

describe("validateOrderResponse", () => {
  it("accepts a confirmation and a rejection for this order number", () => {
    expect(validateOrderResponse(orderRequest, goodOrder())).toEqual({ valid: true });
    expect(validateOrderResponse(orderRequest, goodOrder({ status: "rejected" }))).toEqual({ valid: true });
  });

  it("refuses any status other than confirmed or rejected", () => {
    for (const status of ["pending", "CONFIRMED", "", "shipped"]) {
      expect(validateOrderResponse(orderRequest, goodOrder({ status: status as OrderResponse["status"] }))).toEqual({
        valid: false,
        reason: "STATUS_UNEXPECTED",
      });
    }
  });

  it("refuses an order number that differs from the one sent", () => {
    expect(validateOrderResponse(orderRequest, goodOrder({ orderNumber: "ORD-0002" }))).toEqual({
      valid: false,
      reason: "ORDER_NUMBER_MISMATCH",
    });
  });

  it("refuses an external reference that is not a bounded plain token", () => {
    for (const ref of ["", "R".repeat(121), "EXT 1", "<b>x</b>", "a'OR'1", "x\u0000"]) {
      expect(validateOrderResponse(orderRequest, goodOrder({ externalOrderRef: ref }))).toEqual({
        valid: false,
        reason: "EXTERNAL_REF_INVALID",
      });
    }
    expect(validateOrderResponse(orderRequest, goodOrder({ externalOrderRef: "R".repeat(120) }))).toEqual({ valid: true });
    expect(validateOrderResponse(orderRequest, goodOrder({ externalOrderRef: "a.b:c-d_e" }))).toEqual({ valid: true });
  });
});

describe("SupplierResponseInvalidError", () => {
  it("carries the code and a fixed reason, and never more text than that", () => {
    const err = new SupplierResponseInvalidError("PRICE_INVALID");
    expect(err.code).toBe("SUPPLIER_RESPONSE_INVALID");
    expect(err.reason).toBe("PRICE_INVALID");
    expect(err.message).toBe("SUPPLIER_RESPONSE_INVALID: PRICE_INVALID");
  });
});
