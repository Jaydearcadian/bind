export interface TransferRequest {
  fromAddress: string;
  toAddress: string;
  amountCents: bigint; // USDC 6 decimals, so cents * 10^4 = micro-USDC
  currency: string;
  orderId: string;
  idempotencyKey: string;
}

export interface TransferResult {
  txHash: string;
  status: "settled" | "failed";
  timestamp: Date;
  mode: "local" | "arc-testnet";
  blockNumber?: number;
  explorerUrl?: string;
}

export interface SettlementAdapter {
  mode: "local" | "arc-testnet";
  getBalance(address: string): Promise<bigint>;
  transferUSDC(req: TransferRequest): Promise<TransferResult>;
  depositEscrow(req: TransferRequest, milestoneId: string): Promise<TransferResult>;
  releaseEscrow(milestoneId: string, toAddress: string): Promise<TransferResult>;
}
