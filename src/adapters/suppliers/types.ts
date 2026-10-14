export interface QuoteRequest {
  workspaceId: string;
  sku: string;
  quantity: number;
  rfqId: string;
  supplierId?: string;
}

export interface QuoteResponse {
  quoteId: string;
  rfqId: string;
  supplierId: string;
  supplierName: string;
  sku: string;
  quantity: number;
  unitPriceCents: bigint;
  totalPriceCents: bigint;
  validUntil: Date;
  isSimulated: boolean;
}

export interface OrderRequest {
  workspaceId: string;
  orderId: string;
  orderNumber: string;
  supplierId: string;
  sku: string;
  quantity: number;
  unitPriceCents: bigint;
  totalPriceCents: bigint;
  idempotencyKey: string;
}

export interface OrderResponse {
  orderNumber: string;
  externalOrderRef: string;
  status: "confirmed" | "rejected";
  confirmedAt: Date;
  isSimulated: boolean;
}

export interface SupplierAdapter {
  supplierId: string;
  supplierName: string;
  isSimulated: boolean;
  requestQuote(req: QuoteRequest): Promise<QuoteResponse>;
  submitOrder(req: OrderRequest): Promise<OrderResponse>;
  generateDeliveryReceipt(orderId: string, sku: string, quantity: number): Promise<any>;
  generateBill(orderId: string, sku: string, quantity: number, unitPriceCents: bigint, vendorId?: string): Promise<any>;
}
