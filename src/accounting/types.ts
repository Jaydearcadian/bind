export enum MatchStatus {
  MATCHED = "MATCHED",
  VENDOR_MISMATCH = "VENDOR_MISMATCH",
  SKU_MISMATCH = "SKU_MISMATCH",
  QUANTITY_DISCREPANCY = "QUANTITY_DISCREPANCY",
  PRICE_DISCREPANCY = "PRICE_DISCREPANCY",
  ARITHMETIC_ERROR = "ARITHMETIC_ERROR",
  UNMATCHED = "UNMATCHED",
}

export interface PurchaseOrderDoc {
  orderId: string;
  orderNumber: string;
  vendorId: string;
  sku: string;
  quantity: number;
  unitPriceCents: bigint;
  totalPriceCents: bigint;
}

export interface DeliveryReceiptDoc {
  receiptId: string;
  orderId: string;
  sku: string;
  receivedQuantity: number;
  conditionNotes?: string;
}

export interface SupplierBillDoc {
  billId: string;
  orderId: string;
  billNumber: string;
  vendorId: string;
  sku: string;
  billedQuantity: number;
  billedUnitPriceCents: bigint;
  billedTotalCents: bigint;
}

export interface ThreeWayMatchResult {
  status: MatchStatus;
  payableAmountCents: bigint;
  varianceCents: bigint;
  discrepancyReason?: string;
  orderId: string;
  matchedAt: Date;
}
