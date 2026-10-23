import { createHash, randomBytes } from "crypto";
import {
  SupplierAdapter,
  QuoteRequest,
  QuoteResponse,
  OrderRequest,
  OrderResponse,
  OrderLookupRequest,
} from "./types.js";

/**
 * Simulated supplier. Accepted orders are kept in memory, which is the simulation's own state: a process restart
 * forgets them, so lookupOrder then reports them as not found. That is acceptable for a simulation and is the
 * reason real suppliers must be looked up by their own records. Orders are keyed by workspace and idempotency key,
 * so the same key always returns the same accepted order.
 */
export class SimulatedSupplierAdapter implements SupplierAdapter {
  private readonly acceptedOrders = new Map<string, { orderId: string; response: OrderResponse }>();

  constructor(
    public readonly supplierId: string,
    public readonly supplierName: string,
    private readonly priceModifier: number = 1.0, // multiplier for quote variation
    public readonly isSimulated: boolean = true
  ) {}

  private acceptedKey(workspaceId: string, idempotencyKey: string): string {
    return `${workspaceId}\u0000${idempotencyKey}`;
  }

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

  /** The same idempotency key always returns the same accepted order, with the same external reference. */
  async submitOrder(req: OrderRequest): Promise<OrderResponse> {
    const key = this.acceptedKey(req.workspaceId, req.idempotencyKey);
    const existing = this.acceptedOrders.get(key);
    if (existing) return { ...existing.response };

    const digest = createHash("sha256").update(req.idempotencyKey).digest("hex").slice(0, 9).toUpperCase();
    const response: OrderResponse = {
      orderNumber: req.orderNumber,
      externalOrderRef: `EXT-${this.supplierId.toUpperCase()}-${digest}`,
      status: "confirmed",
      confirmedAt: new Date(),
      isSimulated: true,
    };
    this.acceptedOrders.set(key, { orderId: req.orderId, response });
    return { ...response };
  }

  /** Returns the accepted order for this key, or null if this simulation never accepted it. */
  async lookupOrder(req: OrderLookupRequest): Promise<OrderResponse | null> {
    const found = this.acceptedOrders.get(this.acceptedKey(req.workspaceId, req.idempotencyKey));
    if (!found || found.orderId !== req.orderId) return null;
    return { ...found.response };
  }

  async generateDeliveryReceipt(orderId: string, sku: string, quantity: number) {
    return {
      // A new document is a new row, so the id is random. Eight hex characters keep it within VARCHAR(64).
      receiptId: `dr_${orderId}_${randomBytes(4).toString("hex")}`,
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
      billId: `bill_${orderId}_${randomBytes(4).toString("hex")}`,
      orderId,
      billNumber: `INV-${randomBytes(4).toString("hex").toUpperCase()}`,
      vendorId: vendorId || this.supplierId,
      sku,
      billedQuantity: quantity,
      billedUnitPriceCents: unitPriceCents,
      billedTotalCents,
      receivedAt: new Date(),
    };
  }
}
