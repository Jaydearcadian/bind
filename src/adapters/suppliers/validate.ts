import type { OrderRequest, OrderResponse, QuoteRequest, QuoteResponse } from "./types.js";

/**
 * Checks on what a supplier returns (Task 11, docs/decisions/0031). A supplier's answer is untrusted input: it must match
 * the request that was sent, stay within bounds, and carry only bounded plain tokens where an identifier is expected.
 * Pure: no I/O, no clock unless one is passed. A failure carries a fixed reason, never the supplier's text.
 */

/** The largest amount accepted from a supplier or a document, in cents (1e12, about 10 billion dollars). */
export const MAX_AMOUNT_CENTS = 1_000_000_000_000n;
/** The largest quantity accepted from a supplier or a document. */
export const MAX_QUANTITY = 1_000_000;
/** A quote may be valid for at most this long from the moment it is received. */
export const MAX_QUOTE_VALIDITY_MS = 30 * 24 * 3_600_000;
/** Longest supplier or product name accepted from a quote. */
export const MAX_SUPPLIER_NAME_CHARACTERS = 200;

/** A bounded plain token: an order reference, an identifier that is shown and stored as-is. */
const PLAIN_TOKEN_120 = /^[A-Za-z0-9._:-]{1,120}$/;
/** A quote or supplier id: the quotes table keeps at most 64 characters. */
const PLAIN_TOKEN_64 = /^[A-Za-z0-9._:-]{1,64}$/;
/** Any control character, NUL included. Names may hold HTML and SQL, which is stored as data. */
const CONTROL_CHARACTER = /[\p{Cc}]/u;

export type QuoteRejection =
  | "SUPPLIER_MISMATCH"
  | "RFQ_MISMATCH"
  | "SKU_MISMATCH"
  | "QUANTITY_MISMATCH"
  | "QUANTITY_INVALID"
  | "QUOTE_ID_INVALID"
  | "NAME_INVALID"
  | "PRICE_INVALID"
  | "TOTAL_INVALID"
  | "VALIDITY_INVALID"
  | "RESPONSE_INVALID";

export type OrderRejection = "RESPONSE_INVALID" | "STATUS_UNEXPECTED" | "ORDER_NUMBER_MISMATCH" | "EXTERNAL_REF_INVALID";

export type ValidationResult<R extends string> = { valid: true } | { valid: false; reason: R };

/** The fixed error a workflow carries when a supplier's answer is refused. The code is the only text that leaves. */
export class SupplierResponseInvalidError extends Error {
  readonly code = "SUPPLIER_RESPONSE_INVALID" as const;
  readonly reason: string;

  constructor(reason: string) {
    super(`SUPPLIER_RESPONSE_INVALID: ${reason}`);
    this.name = "SupplierResponseInvalidError";
    this.reason = reason;
  }
}

function isBoundedAmount(value: unknown): value is bigint {
  return typeof value === "bigint" && value > 0n && value <= MAX_AMOUNT_CENTS;
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * A quote is accepted only when it answers the request exactly: same supplier, rfq, sku and quantity; a bounded id; a
 * name without control characters; a positive, bounded unit price; a total equal to unit price times quantity; and a
 * validity that has not passed and is at most 30 days away.
 */
export function validateQuoteResponse(
  request: QuoteRequest,
  response: QuoteResponse,
  now: Date = new Date()
): ValidationResult<QuoteRejection> {
  if (!response || typeof response !== "object") return { valid: false, reason: "RESPONSE_INVALID" };
  if (request.supplierId !== undefined && response.supplierId !== request.supplierId) {
    return { valid: false, reason: "SUPPLIER_MISMATCH" };
  }
  if (typeof response.supplierId !== "string" || !PLAIN_TOKEN_64.test(response.supplierId)) {
    return { valid: false, reason: "SUPPLIER_MISMATCH" };
  }
  if (response.rfqId !== request.rfqId) return { valid: false, reason: "RFQ_MISMATCH" };
  if (response.sku !== request.sku) return { valid: false, reason: "SKU_MISMATCH" };
  if (!Number.isSafeInteger(request.quantity) || request.quantity <= 0 || request.quantity > MAX_QUANTITY) {
    return { valid: false, reason: "QUANTITY_INVALID" };
  }
  if (response.quantity !== request.quantity) return { valid: false, reason: "QUANTITY_MISMATCH" };
  if (typeof response.quoteId !== "string" || !PLAIN_TOKEN_64.test(response.quoteId)) {
    return { valid: false, reason: "QUOTE_ID_INVALID" };
  }
  if (typeof response.supplierName !== "string" || response.supplierName.length === 0) {
    return { valid: false, reason: "NAME_INVALID" };
  }
  if (response.supplierName.length > MAX_SUPPLIER_NAME_CHARACTERS || CONTROL_CHARACTER.test(response.supplierName)) {
    return { valid: false, reason: "NAME_INVALID" };
  }
  if (!isBoundedAmount(response.unitPriceCents)) return { valid: false, reason: "PRICE_INVALID" };
  if (!isBoundedAmount(response.totalPriceCents)) return { valid: false, reason: "TOTAL_INVALID" };
  if (response.totalPriceCents !== response.unitPriceCents * BigInt(request.quantity)) {
    return { valid: false, reason: "TOTAL_INVALID" };
  }
  if (!isValidDate(response.validUntil)) return { valid: false, reason: "VALIDITY_INVALID" };
  const untilMs = response.validUntil.getTime();
  if (untilMs <= now.getTime() || untilMs > now.getTime() + MAX_QUOTE_VALIDITY_MS) {
    return { valid: false, reason: "VALIDITY_INVALID" };
  }
  return { valid: true };
}

/**
 * An order answer is a confirmation or a rejection for this order number, with a bounded plain reference. Anything else
 * is an unknown outcome: the caller leaves the order submitted and does not treat the answer as a confirmation.
 */
export function validateOrderResponse(
  request: OrderRequest,
  response: OrderResponse
): ValidationResult<OrderRejection> {
  if (!response || typeof response !== "object") return { valid: false, reason: "RESPONSE_INVALID" };
  if (response.status !== "confirmed" && response.status !== "rejected") {
    return { valid: false, reason: "STATUS_UNEXPECTED" };
  }
  if (response.orderNumber !== request.orderNumber) return { valid: false, reason: "ORDER_NUMBER_MISMATCH" };
  if (typeof response.externalOrderRef !== "string" || !PLAIN_TOKEN_120.test(response.externalOrderRef)) {
    return { valid: false, reason: "EXTERNAL_REF_INVALID" };
  }
  return { valid: true };
}
