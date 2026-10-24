export type SettlementStatus = "submitted" | "confirmed" | "failed";

export interface TransferRequest {
  fromAddress: string;
  toAddress: string;
  amountCents: bigint; // USDC cents; the Arc contract settles native 18-decimal USDC, 1 cent = 1e16 wei
  currency: string;
  orderId: string;
  idempotencyKey: string;
  matchHash?: string; // 0x + 64 hex; required by the Arc adapter
}

export interface TransferResult {
  txHash: string;
  status: SettlementStatus;
  timestamp: Date;
  mode: "local" | "arc-testnet";
  simulated: boolean;
  blockNumber?: number;
  explorerUrl?: string;
  failureCode?: string;
}

export interface SettlementAdapter {
  mode: "local" | "arc-testnet";
  getBalance(address: string): Promise<bigint>;
  transferUSDC(req: TransferRequest): Promise<TransferResult>;
  confirm(txHash: string): Promise<TransferResult>;
  /**
   * Looks up the transfer made for an order id. Returns null when this adapter has no settlement for that
   * order. Throws when the answer is unknown (for example an RPC failure): it never returns null for that.
   * Optional: an adapter without it cannot reconcile a transfer whose outcome is unknown.
   */
  findTransfer?(req: { orderId: string }): Promise<TransferResult | null>;
  /**
   * Whether the settlement contract has settled this order id (a read; it sends nothing). Throws when the answer is
   * unknown, for example an RPC failure: it never answers false for that. Optional. The tab ledger needs it to restore a
   * held settlement whose outcome is unknown (docs/decisions/0081). An adapter without it cannot restore one.
   */
  isOrderSettled?(orderId: string): Promise<boolean>;
  depositEscrow(req: TransferRequest, milestoneId: string): Promise<TransferResult>;
  releaseEscrow(milestoneId: string, toAddress: string): Promise<TransferResult>;
}
