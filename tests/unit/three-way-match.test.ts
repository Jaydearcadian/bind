import { describe, it, expect } from "vitest";
import {
  evaluateThreeWayMatch,
  MatchStatus,
  PurchaseOrderDoc,
  DeliveryReceiptDoc,
  SupplierBillDoc,
} from "../../src/accounting/three-way-match.js";

describe("Three-Way Match Accounting Engine (Agents & Ledgers)", () => {
  const samplePO: PurchaseOrderDoc = {
    orderId: "po-101",
    orderNumber: "PO-2026-001",
    vendorId: "vendor-sysco",
    sku: "FOOD-FLOUR-50LB",
    quantity: 10, // 10 bags
    unitPriceCents: 2500n, // $25.00
    totalPriceCents: 25000n, // $250.00
  };

  const sampleReceipt: DeliveryReceiptDoc = {
    receiptId: "dr-101",
    orderId: "po-101",
    sku: "FOOD-FLOUR-50LB",
    receivedQuantity: 10,
    conditionNotes: "All 10 bags intact and dry",
  };

  const sampleBill: SupplierBillDoc = {
    billId: "sb-101",
    orderId: "po-101",
    billNumber: "INV-SYS-9948",
    vendorId: "vendor-sysco",
    sku: "FOOD-FLOUR-50LB",
    billedQuantity: 10,
    billedUnitPriceCents: 2500n,
    billedTotalCents: 25000n,
  };

  it("passes cleanly on exact 3-way match", () => {
    const result = evaluateThreeWayMatch(samplePO, sampleReceipt, sampleBill);
    expect(result.status).toBe(MatchStatus.MATCHED);
    expect(result.payableAmountCents).toBe(25000n);
    expect(result.varianceCents).toBe(0n);
    expect(result.discrepancyReason).toBeUndefined();
  });

  it("fails on vendor mismatch (invoice from wrong supplier)", () => {
    const fraudBill: SupplierBillDoc = {
      ...sampleBill,
      vendorId: "impostor-vendor-llc",
    };
    const result = evaluateThreeWayMatch(samplePO, sampleReceipt, fraudBill);
    expect(result.status).toBe(MatchStatus.VENDOR_MISMATCH);
    expect(result.discrepancyReason).toMatch(/Vendor mismatch/i);
    expect(result.payableAmountCents).toBe(0n);
  });

  it("fails on SKU mismatch between receipt and invoice", () => {
    const wrongSkuReceipt: DeliveryReceiptDoc = {
      ...sampleReceipt,
      sku: "FOOD-SUGAR-50LB",
    };
    const result = evaluateThreeWayMatch(samplePO, wrongSkuReceipt, sampleBill);
    expect(result.status).toBe(MatchStatus.SKU_MISMATCH);
    expect(result.discrepancyReason).toMatch(/SKU mismatch/i);
  });

  it("detects quantity discrepancy when bill charges for more than delivered", () => {
    // Only 7 bags actually arrived, but vendor billed for 10 bags
    const partialReceipt: DeliveryReceiptDoc = {
      ...sampleReceipt,
      receivedQuantity: 7,
    };
    const result = evaluateThreeWayMatch(samplePO, partialReceipt, sampleBill);
    expect(result.status).toBe(MatchStatus.QUANTITY_DISCREPANCY);
    expect(result.discrepancyReason).toMatch(/Billed quantity \(10\) exceeds received quantity \(7\)/i);
    // Adjusted payable amount should only be for goods received
    expect(result.payableAmountCents).toBe(17500n); // 7 * 2500
    expect(result.varianceCents).toBe(7500n); // $75.00 overcharge
  });

  it("detects price discrepancy with zero tolerance (no silent rounding or price hikes)", () => {
    // Supplier billed $25.50 instead of contracted $25.00
    const overchargedBill: SupplierBillDoc = {
      ...sampleBill,
      billedUnitPriceCents: 2550n,
      billedTotalCents: 25500n,
    };
    const result = evaluateThreeWayMatch(samplePO, sampleReceipt, overchargedBill);
    expect(result.status).toBe(MatchStatus.PRICE_DISCREPANCY);
    expect(result.discrepancyReason).toMatch(/Billed unit price \(\$25\.50\) exceeds contracted PO unit price \(\$25\.00\)/i);
    expect(result.varianceCents).toBe(500n); // $5.00 variance
  });

  it("detects total calculation arithmetic error on invoice", () => {
    // 10 * 2500 = 25000, but bill states 26000
    const mathErrorBill: SupplierBillDoc = {
      ...sampleBill,
      billedTotalCents: 26000n,
    };
    const result = evaluateThreeWayMatch(samplePO, sampleReceipt, mathErrorBill);
    expect(result.status).toBe(MatchStatus.ARITHMETIC_ERROR);
    expect(result.discrepancyReason).toMatch(/Invoice arithmetic mismatch/i);
  });
});
