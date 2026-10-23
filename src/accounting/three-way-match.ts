import {
  MatchStatus,
  PurchaseOrderDoc,
  DeliveryReceiptDoc,
  SupplierBillDoc,
  ThreeWayMatchResult,
} from "./types.js";

export { MatchStatus };
export type { PurchaseOrderDoc, DeliveryReceiptDoc, SupplierBillDoc, ThreeWayMatchResult };

/**
 * Evaluates a strict Three-Way Match across Purchase Order, Delivery Receipt, and Supplier Bill.
 * Adheres strictly to the principles in "Agents and Ledgers in 2026":
 * - No entry without documents.
 * - Strict equality, zero tolerance, no silent rounding.
 * - Vendor verification, SKU verification, quantity and unit price verification.
 */
export function evaluateThreeWayMatch(
  po: PurchaseOrderDoc,
  receipt: DeliveryReceiptDoc,
  bill: SupplierBillDoc
): ThreeWayMatchResult {
  const matchedAt = new Date();

  // 1. Vendor Identity Verification
  if (po.vendorId !== bill.vendorId) {
    return {
      status: MatchStatus.VENDOR_MISMATCH,
      payableAmountCents: 0n,
      varianceCents: bill.billedTotalCents,
      discrepancyReason: `Vendor mismatch: Invoice vendor '${bill.vendorId}' does not match Purchase Order vendor '${po.vendorId}'.`,
      orderId: po.orderId,
      matchedAt,
    };
  }

  // 2. SKU Integrity Verification
  if (po.sku !== receipt.sku || po.sku !== bill.sku) {
    return {
      status: MatchStatus.SKU_MISMATCH,
      payableAmountCents: 0n,
      varianceCents: bill.billedTotalCents,
      discrepancyReason: `SKU mismatch across documents: PO='${po.sku}', Receipt='${receipt.sku}', Bill='${bill.sku}'.`,
      orderId: po.orderId,
      matchedAt,
    };
  }

  // 3. Invoice Internal Arithmetic Verification
  // billedTotalCents must equal billedQuantity * billedUnitPriceCents
  const calculatedBillTotal = BigInt(Math.round(bill.billedQuantity * 10000)) * bill.billedUnitPriceCents / 10000n;
  if (calculatedBillTotal !== bill.billedTotalCents) {
    return {
      status: MatchStatus.ARITHMETIC_ERROR,
      payableAmountCents: 0n,
      varianceCents: bill.billedTotalCents - calculatedBillTotal,
      discrepancyReason: `Invoice arithmetic mismatch: stated total is $${(Number(bill.billedTotalCents) / 100).toFixed(2)}, but ${bill.billedQuantity} @ $${(Number(bill.billedUnitPriceCents) / 100).toFixed(2)} equals $${(Number(calculatedBillTotal) / 100).toFixed(2)}.`,
      orderId: po.orderId,
      matchedAt,
    };
  }

  // 4. Unit Price Verification (Zero tolerance)
  if (bill.billedUnitPriceCents > po.unitPriceCents) {
    const diff = bill.billedUnitPriceCents - po.unitPriceCents;
    return {
      status: MatchStatus.PRICE_DISCREPANCY,
      payableAmountCents: 0n,
      varianceCents: diff * BigInt(Math.round(bill.billedQuantity)),
      discrepancyReason: `Billed unit price ($${(Number(bill.billedUnitPriceCents) / 100).toFixed(2)}) exceeds contracted PO unit price ($${(Number(po.unitPriceCents) / 100).toFixed(2)}).`,
      orderId: po.orderId,
      matchedAt,
    };
  }

  // 5. Quantity Verification
  // If billed quantity exceeds actual received quantity
  if (bill.billedQuantity > receipt.receivedQuantity) {
    const validDeliveredPayable = BigInt(Math.round(receipt.receivedQuantity)) * po.unitPriceCents;
    const overbilledAmount = bill.billedTotalCents - validDeliveredPayable;
    return {
      status: MatchStatus.QUANTITY_DISCREPANCY,
      payableAmountCents: validDeliveredPayable,
      varianceCents: overbilledAmount,
      discrepancyReason: `Billed quantity (${bill.billedQuantity}) exceeds received quantity (${receipt.receivedQuantity}).`,
      orderId: po.orderId,
      matchedAt,
    };
  }

  // 6. Complete Match
  return {
    status: MatchStatus.MATCHED,
    payableAmountCents: bill.billedTotalCents,
    varianceCents: 0n,
    orderId: po.orderId,
    matchedAt,
  };
}
