import { SettlementAdapter, TransferRequest, TransferResult } from "./types.js";
import { SettlementRejectedError, assertPayableCentAmount } from "./errors.js";
import crypto from "crypto";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * In-process ledger for local development. It has no chain, so it holds no state across restarts.
 * It reports the same submitted/confirmed model as the Arc adapter, with `simulated: true`, and it
 * never builds an explorer link.
 *
 * Idempotency is held in memory, like the balances. A transfer is remembered under its idempotency key and
 * under its order id. The same key returns the remembered transfer and moves no money. A second key for an
 * order that is already settled returns the earlier transfer and moves nothing, as the Arc contract does with
 * OrderAlreadySettled. A transfer that fails (insufficient balance) is not remembered.
 */
export class LocalSettlementSimulator implements SettlementAdapter {
  readonly mode = "local";
  private balances = new Map<string, bigint>();
  private escrows = new Map<string, { amountCents: bigint; from: string; released: boolean }>();
  private transfersByKey = new Map<string, TransferResult>();
  private transfersByOrder = new Map<string, TransferResult>();

  constructor() {
    // Seed default test treasury with 10,000.00 USDC ($10,000.00 = 1,000,000 cents)
    this.balances.set("0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2".toLowerCase(), 1000000n);
  }

  async getBalance(address: string): Promise<bigint> {
    return this.balances.get(address.toLowerCase()) || 500000n; // Default $5,000.00
  }

  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    // Parity with the Arc adapter: refused before the replay lookup and before any balance change.
    assertPayableCentAmount(req.amountCents);
    const replay = this.transfersByKey.get(req.idempotencyKey) ?? this.transfersByOrder.get(req.orderId);
    if (replay) {
      this.transfersByKey.set(req.idempotencyKey, replay);
      return replay;
    }

    const from = req.fromAddress.toLowerCase();
    const to = req.toAddress.toLowerCase();
    const currentFrom = await this.getBalance(from);

    if (currentFrom < req.amountCents) {
      throw new Error(`Insufficient USDC balance for ${req.fromAddress}. Required: ${req.amountCents}, Available: ${currentFrom}`);
    }

    this.balances.set(from, currentFrom - req.amountCents);
    const currentTo = this.balances.get(to) || 0n;
    this.balances.set(to, currentTo + req.amountCents);

    const result = this.submitted();
    this.transfersByKey.set(req.idempotencyKey, result);
    this.transfersByOrder.set(req.orderId, result);
    return result;
  }

  /** The transfer remembered for this order id, or null. Only in-process memory: a restart forgets it. */
  async findTransfer(req: { orderId: string }): Promise<TransferResult | null> {
    return this.transfersByOrder.get(req.orderId) ?? null;
  }

  async confirm(txHash: string): Promise<TransferResult> {
    if (!HASH_RE.test(txHash)) throw new SettlementRejectedError("INVALID_REQUEST");
    return { txHash, status: "confirmed", timestamp: new Date(), mode: "local", simulated: true };
  }

  async depositEscrow(req: TransferRequest, milestoneId: string): Promise<TransferResult> {
    assertPayableCentAmount(req.amountCents);
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

    return this.submitted();
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

    return this.submitted();
  }

  private submitted(): TransferResult {
    return {
      txHash: `0x${crypto.randomBytes(32).toString("hex")}`,
      status: "submitted",
      timestamp: new Date(),
      mode: "local",
      simulated: true,
    };
  }
}
