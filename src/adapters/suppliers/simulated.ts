import { randomBytes } from "crypto";
import {
  SupplierAdapter,
  QuoteRequest,
  QuoteResponse,
  OrderRequest,
  OrderResponse,
} from "./types.js";

export class SimulatedSupplierAdapter implements SupplierAdapter {
  constructor(
    public readonly supplierId: string,
    public readonly supplierName: string,
    private readonly priceModifier: number = 1.0, // multiplier for quote variation
    public readonly isSimulated: boolean = true
  ) {}

  async requestQuote(req: QuoteRequest): Promise<QuoteResponse> {
    // Unique per call: the supplier id is shared by every workspace, so a millisecond timestamp alone collides on quotes.id.
    // quotes.id is VARCHAR(64); 12 hex characters keep the id shorter than the old timestamp form.
    const quoteId = `quote_${this.supplierId}_${randomBytes(6).toString("hex")}`;
    const basePrices: Record<string, bigint> = {
      "FOOD-FLOUR-50LB": 2450n,
      "FOOD-MILK-CASE": 1680n,
      "FOOD-BUTTER-36LB": 9800n,
      "FOOD-COFFEE-5LB": 5200n,
      "SVC-DEV-FRONTEND": 6500n,
      "CREDIT-NEBIUS-TOKEN": 100n,
      "CREDIT-PARALLEL-TASK": 50n,
    };

    const baseUnit = basePrices[req.sku] || 2500n;
    const unitPriceCents = BigInt(Math.round(Number(baseUnit) * this.priceModifier));
    const totalPriceCents = unitPriceCents * BigInt(Math.round(req.quantity));
    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24hr validity

    return {
      quoteId,
      rfqId: req.rfqId,
      supplierId: req.supplierId || this.supplierId,
      supplierName: `${this.supplierName} (Simulated)`,
      sku: req.sku,
      quantity: req.quantity,
      unitPriceCents,
      totalPriceCents,
      validUntil,
      isSimulated: true,
    };
  }

  async submitOrder(req: OrderRequest): Promise<OrderResponse> {
    const externalOrderRef = `EXT-${this.supplierId.toUpperCase()}-${Math.random().toString(36).substring(2, 9).toUpperCase()}`;
    return {
      orderNumber: req.orderNumber,
      externalOrderRef,
      status: "confirmed",
      confirmedAt: new Date(),
      isSimulated: true,
    };
  }

  async generateDeliveryReceipt(orderId: string, sku: string, quantity: number) {
    return {
      receiptId: `dr_${orderId}_${Date.now()}`,
      orderId,
      sku,
      receivedQuantity: quantity,
      conditionNotes: "Inspected at loading dock. Packaging sealed and temperature compliant.",
      receivedAt: new Date(),
    };
  }

  async generateBill(orderId: string, sku: string, quantity: number, unitPriceCents: bigint, vendorId?: string) {
    const billedTotalCents = unitPriceCents * BigInt(Math.round(quantity));
    return {
      billId: `bill_${orderId}_${Date.now()}`,
      orderId,
      billNumber: `INV-${Date.now().toString().slice(-6)}`,
      vendorId: vendorId || this.supplierId,
      sku,
      billedQuantity: quantity,
      billedUnitPriceCents: unitPriceCents,
      billedTotalCents,
      receivedAt: new Date(),
    };
  }
}
