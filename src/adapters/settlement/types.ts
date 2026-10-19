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
  depositEscrow(req: TransferRequest, milestoneId: string): Promise<TransferResult>;
  releaseEscrow(milestoneId: string, toAddress: string): Promise<TransferResult>;
}
