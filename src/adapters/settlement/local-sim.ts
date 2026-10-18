import { SettlementAdapter, TransferRequest, TransferResult } from "./types.js";
import crypto from "crypto";

export class LocalSettlementSimulator implements SettlementAdapter {
  readonly mode = "local";
  private balances = new Map<string, bigint>();
  private escrows = new Map<string, { amountCents: bigint; from: string; released: boolean }>();

  constructor() {
    // Seed default test treasury with 10,000.00 USDC ($10,000.00 = 1,000,000 cents)
    this.balances.set("0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2".toLowerCase(), 1000000n);
  }

  async getBalance(address: string): Promise<bigint> {
    return this.balances.get(address.toLowerCase()) || 500000n; // Default $5,000.00
  }

  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    const from = req.fromAddress.toLowerCase();
    const to = req.toAddress.toLowerCase();
    const currentFrom = await this.getBalance(from);

    if (currentFrom < req.amountCents) {
      throw new Error(`Insufficient USDC balance for ${req.fromAddress}. Required: ${req.amountCents}, Available: ${currentFrom}`);
    }

    this.balances.set(from, currentFrom - req.amountCents);
    const currentTo = this.balances.get(to) || 0n;
    this.balances.set(to, currentTo + req.amountCents);

    const txHash = `0x${crypto.randomBytes(32).toString("hex")}`;
    return {
      txHash,
      status: "settled",
      timestamp: new Date(),
      mode: "local",
      blockNumber: Math.floor(1000000 + Math.random() * 50000),
      explorerUrl: `http://127.0.0.1:8545/tx/${txHash}`,
    };
  }

  async depositEscrow(req: TransferRequest, milestoneId: string): Promise<TransferResult> {
    const from = req.fromAddress.toLowerCase();
    const currentFrom = await this.getBalance(from);
    if (currentFrom < req.amountCents) {
      throw new Error(`Insufficient funds for escrow deposit`);
    }

    this.balances.set(from, currentFrom - req.amountCents);
    this.escrows.set(milestoneId, {
      amountCents: req.amountCents,
      from,
      released: false,
    });

    const txHash = `0x${crypto.randomBytes(32).toString("hex")}`;
    return {
      txHash,
      status: "settled",
      timestamp: new Date(),
      mode: "local",
      blockNumber: Math.floor(1000000 + Math.random() * 50000),
      explorerUrl: `http://127.0.0.1:8545/tx/${txHash}`,
    };
  }

  async releaseEscrow(milestoneId: string, toAddress: string): Promise<TransferResult> {
    const escrow = this.escrows.get(milestoneId);
    if (!escrow) {
      throw new Error(`Escrow milestone '${milestoneId}' not found.`);
    }
    if (escrow.released) {
      throw new Error(`Escrow milestone '${milestoneId}' has already been released.`);
    }

    escrow.released = true;
    const to = toAddress.toLowerCase();
    const currentTo = this.balances.get(to) || 0n;
    this.balances.set(to, currentTo + escrow.amountCents);

    const txHash = `0x${crypto.randomBytes(32).toString("hex")}`;
    return {
      txHash,
      status: "settled",
      timestamp: new Date(),
      mode: "local",
      blockNumber: Math.floor(1000000 + Math.random() * 50000),
      explorerUrl: `http://127.0.0.1:8545/tx/${txHash}`,
    };
  }
}
