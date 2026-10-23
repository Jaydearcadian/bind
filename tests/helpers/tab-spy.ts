import crypto from "crypto";
import { query } from "../../src/db/client.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { SettlementRejectedError, assertPayableCentAmount } from "../../src/adapters/settlement/errors.js";
import type {
  SettlementAdapter,
  SettlementStatus,
  TransferRequest,
  TransferResult,
} from "../../src/adapters/settlement/types.js";

/**
 * A spy settlement adapter for the tab ledger tests. Nothing is broadcast: transfers are local hashes. The spy records
 * every call, every transfer that actually moved money (once per order id, as the Arc contract's OrderAlreadySettled guard
 * does), and what the database held when confirm() was called (confirm() catches its own errors, so assertions must be
 * made on what the spy recorded, not inside it).
 */

export const PAYER = `0x${"11".repeat(20)}`;
export const PAYEE = `0x${"22".repeat(20)}`;
export const BLOCK = 4242;

export type ConfirmMode = "confirmed" | "submitted" | "failed" | "throws";

export interface ConfirmSnapshot {
  txHash: string;
  settlementStatus: string | null;
  submittedAuditRows: number;
}

export interface MovedTransfer {
  txHash: string;
  amountCents: bigint;
  idempotencyKey: string;
}

export class TabSpy implements SettlementAdapter {
  readonly mode = "local" as const;
  /** Every call to transferUSDC, in order. */
  readonly calls: TransferRequest[] = [];
  /** Transfers that moved money, keyed by the adapter order id. */
  readonly moved = new Map<string, MovedTransfer>();
  /** Calls for an order that had already moved money. Must stay zero: the ledger never sends twice. */
  duplicateCalls = 0;
  readonly confirmCalls: string[] = [];
  readonly confirmSnapshots: ConfirmSnapshot[] = [];
  /** Amounts that were not a whole positive number of cents when the adapter was called. Must stay empty. */
  readonly subCentAttempts: unknown[] = [];
  transferStatus: SettlementStatus = "submitted";
  confirmMode: ConfirmMode = "confirmed";
  /** When set, the next transfer is refused before anything is sent. */
  rejectNext: SettlementRejectedError | null = null;
  /** When true, the next transfer moves money and then throws a plain error, so the result is lost. */
  throwAfterSendNext = false;
  /**
   * When false, the lookup is unavailable: findTransfer throws for an order that moved money, as the adapter contract
   * requires (it never answers null for a transfer it cannot rule out). An order that never moved is always null.
   */
  lookupAvailable = true;
  /** When set, findTransfer answers with this hash instead (a duplicate adoption), as CONFIRMED. */
  adoptHash: string | null = null;

  private readonly sentHashes = new Set<string>();

  async getBalance(): Promise<bigint> {
    return 1_000_000_000n;
  }

  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    this.calls.push(req);
    try {
      assertPayableCentAmount(req.amountCents);
    } catch (err) {
      this.subCentAttempts.push(req.amountCents);
      throw err;
    }
    if (this.rejectNext) {
      const err = this.rejectNext;
      this.rejectNext = null;
      throw err;
    }
    const previous = this.moved.get(req.orderId);
    if (previous) {
      // The adapter refuses to pay an order twice and answers with the earlier transfer, moving nothing.
      this.duplicateCalls += 1;
      return this.result(previous.txHash, "submitted");
    }
    const txHash = `0x${crypto.createHash("sha256").update(`${req.idempotencyKey}:${this.calls.length}`).digest("hex")}`;
    this.moved.set(req.orderId, { txHash, amountCents: req.amountCents, idempotencyKey: req.idempotencyKey });
    this.sentHashes.add(txHash);
    if (this.throwAfterSendNext) {
      this.throwAfterSendNext = false;
      throw new Error("transport lost after the transfer was sent");
    }
    return this.result(txHash, this.transferStatus, this.transferStatus === "failed" ? "REVERTED" : undefined);
  }

  async findTransfer(req: { orderId: string }): Promise<TransferResult | null> {
    if (this.adoptHash) return this.result(this.adoptHash, "confirmed");
    const moved = this.moved.get(req.orderId);
    if (!moved) return null;
    if (!this.lookupAvailable) throw new Error("lookup unavailable");
    return this.result(moved.txHash, "confirmed");
  }

  async confirm(txHash: string): Promise<TransferResult> {
    this.confirmCalls.push(txHash);
    const row = (
      await query(`SELECT status FROM tab_settlements WHERE tx_hash = $1;`, [txHash])
    ).rows[0];
    const audit = await query(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'tab.settlement_submitted' AND tx_hash = $1;`,
      [txHash]
    );
    this.confirmSnapshots.push({
      txHash,
      settlementStatus: row?.status ?? null,
      submittedAuditRows: audit.rows[0].n,
    });
    if (!this.sentHashes.has(txHash)) return this.result(txHash, "submitted");
    if (this.confirmMode === "throws") throw new Error("confirm: rpc unreachable");
    if (this.confirmMode === "failed") return this.result(txHash, "failed", "REVERTED");
    if (this.confirmMode === "submitted") return this.result(txHash, "submitted");
    return this.result(txHash, "confirmed");
  }

  async depositEscrow(): Promise<TransferResult> {
    throw new Error("not used by the tab ledger");
  }

  async releaseEscrow(): Promise<TransferResult> {
    throw new Error("not used by the tab ledger");
  }

  /** Total cents that moved, across every order. */
  movedCents(): bigint {
    let total = 0n;
    for (const transfer of this.moved.values()) total += transfer.amountCents;
    return total;
  }

  private result(txHash: string, status: SettlementStatus, failureCode?: string): TransferResult {
    return {
      txHash,
      status,
      timestamp: new Date(),
      mode: this.mode,
      simulated: true,
      blockNumber: status === "confirmed" ? BLOCK : undefined,
      ...(failureCode ? { failureCode } : {}),
    };
  }
}

const RUN = Date.now().toString(36);
let counter = 0;

/** A new workspace with a settlement address, unless one is given. Ids are unique per run and short enough for VARCHAR(64). */
export async function newTabWorkspace(
  label: string,
  opts: { budgetCents?: number; thresholdCents?: number; settlementAddress?: string | null; paused?: boolean } = {}
): Promise<string> {
  counter += 1;
  const id = `wstab-${label}-${RUN}-${counter}`;
  await provisionWorkspace(id, `Tab ${label}`, "kitchen-v1", {
    customDailyLimitCents: BigInt(opts.budgetCents ?? 10_000_000),
    customApprovalThresholdCents: BigInt(opts.thresholdCents ?? 10_000_000),
  });
  const settlementAddress = opts.settlementAddress === undefined ? PAYER : opts.settlementAddress;
  await query(`UPDATE workspaces SET settlement_address = $2, agents_paused = $3 WHERE id = $1;`, [
    id,
    settlementAddress,
    opts.paused === true,
  ]);
  return id;
}

/** A counterparty (supplier) of one workspace. Verified and payable unless told otherwise. */
export async function newCounterparty(
  workspaceId: string,
  opts: { verified?: boolean; paymentAddress?: string | null } = {}
): Promise<string> {
  counter += 1;
  const id = `cp-${RUN}-${counter}`;
  const paymentAddress = opts.paymentAddress === undefined ? PAYEE : opts.paymentAddress;
  await query(
    `INSERT INTO suppliers (id, workspace_id, name, adapter_type, verified, is_simulated, payment_address)
     VALUES ($1, $2, $3, 'simulated_sysco', $4, TRUE, $5);`,
    [id, workspaceId, `Counterparty ${counter}`, opts.verified !== false, paymentAddress]
  );
  return id;
}

/** Deletes the workspaces made by a test. Every child row goes with them (ON DELETE CASCADE). */
export async function removeWorkspaces(ids: string[]): Promise<void> {
  for (const id of ids) await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
}

/** Sum of every entry of one tab in micro-USDC, computed the long way for invariant checks. */
export async function tabSums(workspaceId: string, counterpartyId: string) {
  const res = await query(
    `SELECT
        COALESCE(SUM(amount_micro) FILTER (WHERE kind = 'charge'), 0)::text AS charges,
        COALESCE(SUM(amount_micro) FILTER (WHERE kind = 'clear'), 0)::text AS clears,
        COALESCE(SUM(amount_micro) FILTER (WHERE kind = 'reversal'), 0)::text AS reversals
     FROM tab_entries WHERE workspace_id = $1 AND counterparty_id = $2;`,
    [workspaceId, counterpartyId]
  );
  return {
    charges: BigInt(res.rows[0].charges),
    clears: BigInt(res.rows[0].clears),
    reversals: BigInt(res.rows[0].reversals),
  };
}

export async function settlementsOf(workspaceId: string, counterpartyId?: string): Promise<any[]> {
  return (
    await query(
      `SELECT id, amount_cents::text AS amount_cents, status, hold_reason, tx_hash, confirmed_block::text AS confirmed_block
       FROM tab_settlements WHERE workspace_id = $1 AND ($2::text IS NULL OR counterparty_id = $2) ORDER BY created_at, id;`,
      [workspaceId, counterpartyId ?? null]
    )
  ).rows;
}

export async function auditCount(workspaceId: string, action: string): Promise<number> {
  return (
    await query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = $2;`, [workspaceId, action])
  ).rows[0].n;
}

export function randomBytesHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}
