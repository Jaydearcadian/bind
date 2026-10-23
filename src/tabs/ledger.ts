import { query, withTransaction } from "../db/client.js";
import { acquireAdvisoryLock } from "../db/advisory-lock.js";
import { EffectConflictError, EffectInDoubtError, runEffect } from "../effects/ledger.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PolicyDecision } from "../policy/engine.js";
import { SettlementPayerMismatchError, SettlementRejectedError } from "../adapters/settlement/errors.js";
import { getSettlementAdapter } from "../adapters/settlement/index.js";
import type { SettlementAdapter, TransferRequest, TransferResult } from "../adapters/settlement/types.js";
import { effectiveSettlementMode } from "../demo/policy.js";
import { spendStatusesSql } from "../orders/statuses.js";
import { spendLockKey } from "../orders/reservation.js";
import { UTC_DAY_START_SQL } from "../utils/utc-day.js";
import { newId } from "../utils/ids.js";
import { log } from "../observability/logger.js";
import { currentRequestId } from "../observability/request-context.js";
import { TabError, TabIdempotencyConflictError } from "./errors.js";
import {
  COUNTERPARTY_ID_PATTERN,
  DESCRIPTION_MAX_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
  assertChargeAmountMicro,
  centsToMicro,
  ledgerKeys,
  settleableCents,
  tabAdapterOrderId,
  tabMatchHash,
} from "./units.js";

/**
 * The tab ledger (docs/decisions/0081). Sub-cent charges are recorded per counterparty in micro-USDC and settled in whole
 * cents through the settlement adapter and the effects ledger. The rules that matter for money, in code and not in a model:
 *
 * - A charge is an append-only entry. Its idempotency key is unique per workspace: the same key with the same data adds
 *   nothing, and the same key with different data is a conflict.
 * - A settlement clears whole cents from the balance in the SAME transaction that creates its settlement row, under a row
 *   lock on the counterparty, so two settle calls cannot clear the same balance. From that commit on the settlement owns
 *   the cleared amount: a crash never lets the same balance be paid twice.
 * - Nothing is sent before the gates pass (workspace not paused, counterparty verified with a payment address, workspace
 *   with a settlement address, amount within the approval threshold, daily budget not exceeded). A gate that refuses before
 *   the clear writes nothing that owns money. A gate that refuses after a reserve does not happen.
 * - The transfer runs through runEffect with operation `settlement.transfer_usdc`, so a repeated attempt replays, adopts a
 *   transfer the adapter can find, or reports the outcome in doubt. It is never sent twice.
 * - Sent is recorded (`submitted`) before confirmation is asked for. Confirmation claims the settlement with a per-settlement
 *   advisory lock, asks the adapter once, and finishes on `confirmed` only.
 * - A transfer rejected before anything was sent cancels the settlement and writes one reversal entry. A failed or unknown
 *   outcome is held and its clear is never reversed here.
 */

/** Who an audit row names. Owner and staff tokens are recorded as they are; the worker and the settle path use `system`. */
export interface TabActor {
  type: "owner" | "agent" | "system";
  id: string;
}

export const SYSTEM_ACTOR: TabActor = { type: "system", id: "tab_ledger" };

/** A settlement's status as stored. `held` may own a cleared balance (a failed or unknown outcome) or own none (a refused gate). */
export type TabSettlementStatus = "pending" | "submitted" | "confirmed" | "held" | "cancelled";

export interface TabEntry {
  id: string;
  workspaceId: string;
  counterpartyId: string;
  kind: "charge" | "clear" | "reversal";
  amountMicro: bigint;
  idempotencyKey: string;
  settlementId: string | null;
  description: string;
  createdAt: Date;
}

export interface TabSettlementRecord {
  id: string;
  workspaceId: string;
  counterpartyId: string;
  amountCents: bigint;
  status: TabSettlementStatus;
  txHash: string | null;
  holdReason: string | null;
  submittedAt: Date | null;
  confirmedAt: Date | null;
  confirmedBlock: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AccrueInput {
  workspaceId: string;
  counterpartyId: string;
  amountMicro: bigint;
  idempotencyKey: string;
  description: string;
  actor?: TabActor;
}

export interface AccrueResult {
  entry: TabEntry;
  /** false when the same key with the same data was already recorded: nothing was added. */
  created: boolean;
}

export interface TabBalance {
  counterpartyId: string;
  balanceMicro: bigint;
  /** floor(balanceMicro / 10_000): what a settlement would clear now. */
  settleableCents: bigint;
}

export interface TabSummary extends TabBalance {
  name: string;
  entryCount: number;
}

export interface SettleInput {
  workspaceId: string;
  counterpartyId: string;
  actor?: TabActor;
}

/** What a settle call did. Amounts are bigint; the API turns them into strings. */
export type SettleResult =
  | { outcome: "below_threshold"; balanceMicro: bigint }
  | { outcome: "needs_approval"; amountCents: bigint; thresholdCents: bigint }
  | { outcome: "refused"; reason: "AGENTS_PAUSED" | "DAILY_LIMIT_EXCEEDED"; balanceMicro: bigint }
  | {
      outcome: "settlement";
      settlementId: string;
      status: TabSettlementStatus;
      amountCents: bigint;
      txHash: string | null;
      holdReason: string | null;
    };

/** A reserved settlement: its clear is committed, nothing is sent yet. */
export interface ReservedSettlement {
  settlementId: string;
  workspaceId: string;
  counterpartyId: string;
  amountCents: bigint;
}

export type ExecuteOutcome =
  | { kind: "busy" }
  | { kind: "submitted"; txHash: string }
  | { kind: "held"; hold: string }
  | { kind: "cancelled"; code: string }
  | { kind: "paused" }
  | { kind: "not_pending"; status: TabSettlementStatus };

export type ConfirmOutcome =
  | { kind: "confirmed"; txHash: string }
  | { kind: "held"; hold: string }
  | { kind: "awaiting"; txHash: string }
  | { kind: "in_progress" }
  | { kind: "current"; status: TabSettlementStatus };

export interface TabLedgerDeps {
  /** The adapter for a settlement mode. Defaults to the configured adapter, exactly as orders use it. */
  settlementFor?: (mode: string) => SettlementAdapter;
  /**
   * Test seam: runs inside a reserve transaction after the committed spend is read, before anything is written. The
   * budget race test uses it to hold every reserve at the same point. Not set in production.
   */
  afterBudgetRead?: () => Promise<void>;
}

/** How long a reserve waits for the workspace spend lock. A busy lock is refused, never skipped. */
const SPEND_LOCK_WAIT_MS = 10_000;

interface Db {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}

const ENTRY_COLUMNS = `id, workspace_id, counterparty_id, kind, amount_micro::text AS amount_micro, idempotency_key, settlement_id, description, created_at`;

/** Balance in micro-USDC of one counterparty's tab: charges and reversals add, clears subtract. */
async function balanceOf(db: Db, workspaceId: string, counterpartyId: string): Promise<bigint> {
  const res = await db.query(
    `SELECT COALESCE(SUM(CASE kind WHEN 'clear' THEN -amount_micro ELSE amount_micro END), 0)::text AS balance
     FROM tab_entries WHERE workspace_id = $1 AND counterparty_id = $2;`,
    [workspaceId, counterpartyId]
  );
  return BigInt(res.rows[0].balance);
}

/**
 * What the daily budget already commits today: order spend on the spend-counting statuses (as the commitment gate counts
 * it) plus each tab settlement that owns a clear (pending, submitted, confirmed or held). A cancelled settlement and a
 * gate-refused hold own no balance and count for nothing.
 */
export async function committedSpendTodayCents(db: Db, workspaceId: string): Promise<bigint> {
  const res = await db.query(
    `SELECT (
        COALESCE((SELECT SUM(total_price_cents) FROM orders
                  WHERE workspace_id = $1 AND created_at >= ${UTC_DAY_START_SQL} AND status IN (${spendStatusesSql()})), 0)
      + COALESCE((SELECT SUM(t.amount_cents) FROM tab_settlements t
                  WHERE t.workspace_id = $1 AND t.created_at >= ${UTC_DAY_START_SQL}
                    AND t.status IN ('pending', 'submitted', 'confirmed', 'held')
                    AND EXISTS (SELECT 1 FROM tab_entries e WHERE e.settlement_id = t.id AND e.kind = 'clear')), 0)
     )::text AS spent;`,
    [workspaceId]
  );
  return BigInt(res.rows[0].spent);
}

async function writeAudit(
  db: Db,
  workspaceId: string,
  actor: TabActor,
  action: string,
  decision: PolicyDecision,
  evidence: Record<string, unknown>,
  txHash: string | null
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, tx_hash, created_at, request_id)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8, $9, NOW(), $10);`,
    [
      newId("audit"),
      workspaceId,
      actor.type,
      actor.id,
      EffectClass.COMMERCIAL_COMMITMENT,
      action,
      decision,
      JSON.stringify(evidence),
      txHash,
      currentRequestId(),
    ]
  );
}

function toEntry(row: any): TabEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    counterpartyId: row.counterparty_id,
    kind: row.kind,
    amountMicro: BigInt(row.amount_micro),
    idempotencyKey: row.idempotency_key,
    settlementId: row.settlement_id ?? null,
    description: row.description,
    createdAt: row.created_at,
  };
}

function toSettlement(row: any): TabSettlementRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    counterpartyId: row.counterparty_id,
    amountCents: BigInt(row.amount_cents),
    status: row.status,
    txHash: row.tx_hash ?? null,
    holdReason: row.hold_reason ?? null,
    submittedAt: row.submitted_at ?? null,
    confirmedAt: row.confirmed_at ?? null,
    confirmedBlock: row.confirmed_block === null || row.confirmed_block === undefined ? null : Number(row.confirmed_block),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SETTLEMENT_COLUMNS = `id, workspace_id, counterparty_id, amount_cents::text AS amount_cents, status, tx_hash, hold_reason,
  submitted_at, confirmed_at, confirmed_block::text AS confirmed_block, created_at, updated_at`;

function assertWorkspaceId(workspaceId: unknown): void {
  if (typeof workspaceId !== "string" || workspaceId.length === 0 || workspaceId.length > 64) {
    throw new TabError("INVALID_CHARGE", "The workspace id is not valid.");
  }
}

function assertIds(workspaceId: unknown, counterpartyId: unknown): void {
  assertWorkspaceId(workspaceId);
  if (typeof counterpartyId !== "string" || !COUNTERPARTY_ID_PATTERN.test(counterpartyId)) {
    throw new TabError("INVALID_CHARGE", "The counterparty id is not valid.");
  }
}

function normaliseDescription(value: unknown): string {
  if (typeof value !== "string") throw new TabError("INVALID_CHARGE", "The description must be text.");
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > DESCRIPTION_MAX_LENGTH) {
    throw new TabError("INVALID_CHARGE", `The description must be 1 to ${DESCRIPTION_MAX_LENGTH} characters.`);
  }
  return trimmed;
}

/** Re-throws an unexpected error with only its type logged: an adapter error can carry transport detail. */
function logOutcomeUnknown(event: string, settlementId: string, err: unknown): void {
  log.warn(event, { settlementId, errorName: err instanceof Error ? err.name : "unknown" });
}

/**
 * Adapter refusals that are raised strictly BEFORE the adapter can have sent anything, so a cancel and a reversal on the
 * first attempt are safe. Read from src/adapters/settlement/arc-l1.ts, transferUSDC:
 * - INVALID_REQUEST: the recipient address, the order id or the match hash is malformed. Checked before any chain call.
 * - SUB_CENT_AMOUNT_NOT_SUPPORTED: assertPayableCentAmount, the first line, before any settings check or RPC call.
 * - PAYER_MISMATCH: the payer is not the configured signer (SettlementPayerMismatchError), thrown before the pre-flight.
 * Not in this set, on purpose: OrderAlreadySettled and UNKNOWN_REVERT (both decoded from the chain, so the transfer may
 * have moved money), any other decoded revert name, and transport errors. Those hold the clear.
 */
export const PRE_SEND_REJECTION_CODES: ReadonlySet<string> = new Set([
  "INVALID_REQUEST",
  "SUB_CENT_AMOUNT_NOT_SUPPORTED",
  "PAYER_MISMATCH",
]);

/** The rejection code of an adapter refusal, or null for any other error. */
function rejectionCodeOf(err: unknown): string | null {
  if (err instanceof SettlementRejectedError) return err.code;
  if (err instanceof SettlementPayerMismatchError) return "PAYER_MISMATCH";
  return null;
}

export class TabLedger {
  private readonly settlementFor: (mode: string) => SettlementAdapter;

  private readonly afterBudgetRead?: () => Promise<void>;

  constructor(deps: TabLedgerDeps = {}) {
    this.afterBudgetRead = deps.afterBudgetRead;
    this.settlementFor =
      deps.settlementFor ?? ((mode: string) => getSettlementAdapter(mode as "local" | "arc-testnet"));
  }

  // ---- Charges and reads -------------------------------------------------------------------------------------------

  /**
   * Records one charge against a counterparty's tab. Charges are records of obligations, so they are recorded while the
   * workspace is paused as well; settlement never runs while paused (ADR 0023). The counterparty must be a verified
   * supplier of the same workspace, and the row lock on it serialises two charges (and a settle) for that counterparty.
   */
  async accrueCharge(input: AccrueInput): Promise<AccrueResult> {
    assertIds(input.workspaceId, input.counterpartyId);
    if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
      throw new TabError("INVALID_CHARGE", "The idempotency key must be 1 to 128 letters, digits, '_', '.', ':' or '-'.");
    }
    assertChargeAmountMicro(input.amountMicro);
    const description = normaliseDescription(input.description);
    const actor = input.actor ?? SYSTEM_ACTOR;
    const storedKey = ledgerKeys.charge(input.idempotencyKey);

    return withTransaction(async (client) => {
      const supplier = (
        await client.query(`SELECT verified FROM suppliers WHERE workspace_id = $1 AND id = $2 FOR UPDATE;`, [
          input.workspaceId,
          input.counterpartyId,
        ])
      ).rows[0];
      if (!supplier) throw new TabError("COUNTERPARTY_NOT_FOUND", "The counterparty is not found in this workspace.");
      if (supplier.verified !== true) {
        throw new TabError("COUNTERPARTY_NOT_VERIFIED", "The counterparty is not verified in this workspace.");
      }

      const existing = (
        await client.query(`SELECT ${ENTRY_COLUMNS} FROM tab_entries WHERE workspace_id = $1 AND idempotency_key = $2;`, [
          input.workspaceId,
          storedKey,
        ])
      ).rows[0];
      if (existing) {
        const sameData =
          existing.counterparty_id === input.counterpartyId &&
          BigInt(existing.amount_micro) === input.amountMicro &&
          existing.description === description;
        if (!sameData) throw new TabIdempotencyConflictError();
        return { entry: toEntry(existing), created: false };
      }

      const id = newId("tabent");
      const inserted = (
        await client.query(
          `INSERT INTO tab_entries (id, workspace_id, counterparty_id, kind, amount_micro, idempotency_key, settlement_id, description, created_at)
           VALUES ($1, $2, $3, 'charge', $4, $5, NULL, $6, NOW())
           RETURNING ${ENTRY_COLUMNS};`,
          [id, input.workspaceId, input.counterpartyId, input.amountMicro.toString(), storedKey, description]
        )
      ).rows[0];
      await writeAudit(client, input.workspaceId, actor, "tab.charge_accrued", PolicyDecision.ALLOW, {
        counterpartyId: input.counterpartyId,
        entryId: id,
        amountMicro: input.amountMicro.toString(),
        idempotencyKey: input.idempotencyKey,
      }, null);
      return { entry: toEntry(inserted), created: true };
    });
  }

  /** The balance of one tab. A counterparty of another workspace is COUNTERPARTY_NOT_FOUND, the same as a missing one. */
  async tabBalance(workspaceId: string, counterpartyId: string): Promise<TabBalance> {
    assertIds(workspaceId, counterpartyId);
    const exists = await query(`SELECT id FROM suppliers WHERE workspace_id = $1 AND id = $2;`, [workspaceId, counterpartyId]);
    if (exists.rowCount === 0) throw new TabError("COUNTERPARTY_NOT_FOUND", "The counterparty is not found in this workspace.");
    const balanceMicro = await balanceOf({ query: (t, p) => query(t, p) }, workspaceId, counterpartyId);
    return { counterpartyId, balanceMicro, settleableCents: settleableCents(balanceMicro) };
  }

  /** Every tab of this workspace that has at least one entry. Only this workspace's rows are read. */
  async listTabs(workspaceId: string): Promise<TabSummary[]> {
    assertWorkspaceId(workspaceId);
    const res = await query(
      `SELECT s.id, s.name, COUNT(e.id)::int AS entry_count,
              COALESCE(SUM(CASE e.kind WHEN 'clear' THEN -e.amount_micro ELSE e.amount_micro END), 0)::text AS balance
       FROM suppliers s
       JOIN tab_entries e ON e.workspace_id = s.workspace_id AND e.counterparty_id = s.id
       WHERE s.workspace_id = $1
       GROUP BY s.id, s.name
       ORDER BY s.name ASC, s.id ASC;`,
      [workspaceId]
    );
    return res.rows.map((row) => {
      const balanceMicro = BigInt(row.balance);
      return {
        counterpartyId: row.id,
        name: row.name,
        entryCount: row.entry_count,
        balanceMicro,
        settleableCents: settleableCents(balanceMicro),
      };
    });
  }

  /** The balance, the most recent entries and settlements of one tab. Workspace-scoped like every read here. */
  async tabDetail(workspaceId: string, counterpartyId: string) {
    const balance = await this.tabBalance(workspaceId, counterpartyId);
    const entries = await query(
      `SELECT ${ENTRY_COLUMNS} FROM tab_entries WHERE workspace_id = $1 AND counterparty_id = $2 ORDER BY created_at DESC, id DESC LIMIT 50;`,
      [workspaceId, counterpartyId]
    );
    const settlements = await query(
      `SELECT ${SETTLEMENT_COLUMNS} FROM tab_settlements WHERE workspace_id = $1 AND counterparty_id = $2 ORDER BY created_at DESC, id DESC LIMIT 20;`,
      [workspaceId, counterpartyId]
    );
    return {
      ...balance,
      entries: entries.rows.map(toEntry),
      settlements: settlements.rows.map(toSettlement),
    };
  }

  // ---- Settlement -------------------------------------------------------------------------------------------------

  /** Reads one settlement row, scoped to its workspace when one is given. */
  async loadSettlement(settlementId: string, workspaceId?: string): Promise<TabSettlementRecord | null> {
    const res = await query(
      `SELECT ${SETTLEMENT_COLUMNS} FROM tab_settlements WHERE id = $1 AND ($2::text IS NULL OR workspace_id = $2);`,
      [settlementId, workspaceId ?? null]
    );
    return res.rows[0] ? toSettlement(res.rows[0]) : null;
  }

  /** Settles a tab: reserve (clear, in one transaction), execute (the transfer, through the ledger), confirm. */
  async settleTab(input: SettleInput): Promise<SettleResult> {
    const reserved = await this.reserveSettlement(input);
    if (reserved.kind === "final") return reserved.result;
    return this.finishSettlement(reserved.settlement);
  }

  /**
   * Refuses or reserves a settlement. Every refusal writes nothing that owns money. A reserve writes the settlement row
   * (pending) and its clear entry in one transaction, under a row lock on the counterparty.
   */
  async reserveSettlement(
    input: SettleInput
  ): Promise<{ kind: "final"; result: SettleResult } | { kind: "reserved"; settlement: ReservedSettlement }> {
    assertIds(input.workspaceId, input.counterpartyId);
    // The same spend lock the order reservation takes (src/orders/reservation.ts). Every settle in a workspace, across all of
    // its counterparties, decides the daily budget one at a time, so two settles cannot both see room for the same cents.
    const lock = await acquireAdvisoryLock(spendLockKey(input.workspaceId), SPEND_LOCK_WAIT_MS);
    if (!lock) throw new TabError("SPEND_LOCK_BUSY", "The workspace spend is being decided by another request. Retry later.");
    try {
      return await this.reserveUnderSpendLock(input);
    } finally {
      await lock.release();
    }
  }

  private async reserveUnderSpendLock(
    input: SettleInput
  ): Promise<{ kind: "final"; result: SettleResult } | { kind: "reserved"; settlement: ReservedSettlement }> {
    const actor = input.actor ?? SYSTEM_ACTOR;
    const ws = input.workspaceId;
    const cpId = input.counterpartyId;

    return withTransaction(async (client) => {
      const workspace = (
        await client.query(
          `SELECT id, settlement_address, settlement_mode, is_demo, agents_paused, budget_daily_limit_cents, approval_threshold_cents
           FROM workspaces WHERE id = $1;`,
          [ws]
        )
      ).rows[0];
      const supplier = (
        await client.query(
          `SELECT id, verified, payment_address FROM suppliers WHERE workspace_id = $1 AND id = $2 FOR UPDATE;`,
          [ws, cpId]
        )
      ).rows[0];
      if (!workspace || !supplier) throw new TabError("COUNTERPARTY_NOT_FOUND", "The counterparty is not found in this workspace.");

      const balanceMicro = await balanceOf(client, ws, cpId);
      const cents = settleableCents(balanceMicro);
      if (cents === 0n) return { kind: "final" as const, result: { outcome: "below_threshold" as const, balanceMicro } };

      // The owner's pause switch (ADR 0023): nothing is cleared or sent while paused.
      if (workspace.agents_paused === true) {
        await writeAudit(client, ws, actor, "tab.settlement_paused_hold", PolicyDecision.DENY, {
          counterpartyId: cpId,
          hold: "AGENTS_PAUSED",
          amountCents: cents.toString(),
        }, null);
        return { kind: "final" as const, result: { outcome: "refused" as const, reason: "AGENTS_PAUSED" as const, balanceMicro } };
      }

      // Gates that name a hold. The settlement row records the refusal, and it owns no balance (no clear entry).
      const hold =
        supplier.verified !== true
          ? "SUPPLIER_NOT_VERIFIED"
          : !supplier.payment_address
            ? "SUPPLIER_PAYMENT_ADDRESS_MISSING"
            : !workspace.settlement_address
              ? "WORKSPACE_SETTLEMENT_ADDRESS_MISSING"
              : null;
      if (hold) {
        const settlementId = newId("tabset");
        await client.query(
          `INSERT INTO tab_settlements (id, workspace_id, counterparty_id, amount_cents, status, hold_reason, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'held', $5, NOW(), NOW());`,
          [settlementId, ws, cpId, cents.toString(), hold]
        );
        await writeAudit(client, ws, actor, "tab.settlement_held", PolicyDecision.DENY, {
          settlementId,
          counterpartyId: cpId,
          hold,
          amountCents: cents.toString(),
        }, null);
        return {
          kind: "final" as const,
          result: { outcome: "settlement" as const, settlementId, status: "held" as const, amountCents: cents, txHash: null, holdReason: hold },
        };
      }

      const thresholdCents = BigInt(workspace.approval_threshold_cents);
      if (cents > thresholdCents) {
        await writeAudit(client, ws, actor, "tab.settlement_needs_approval", PolicyDecision.REQUIRE_APPROVAL, {
          counterpartyId: cpId,
          amountCents: cents.toString(),
          thresholdCents: thresholdCents.toString(),
        }, null);
        return { kind: "final" as const, result: { outcome: "needs_approval" as const, amountCents: cents, thresholdCents } };
      }

      const spent = await committedSpendTodayCents(client, ws);
      if (this.afterBudgetRead) await this.afterBudgetRead();
      const dailyLimitCents = BigInt(workspace.budget_daily_limit_cents);
      if (spent + cents > dailyLimitCents) {
        await writeAudit(client, ws, actor, "tab.settlement_refused", PolicyDecision.DENY, {
          counterpartyId: cpId,
          reason: "DAILY_LIMIT_EXCEEDED",
          amountCents: cents.toString(),
          dailySpentCents: spent.toString(),
          dailyLimitCents: dailyLimitCents.toString(),
        }, null);
        return { kind: "final" as const, result: { outcome: "refused" as const, reason: "DAILY_LIMIT_EXCEEDED" as const, balanceMicro } };
      }

      const settlementId = newId("tabset");
      await client.query(
        `INSERT INTO tab_settlements (id, workspace_id, counterparty_id, amount_cents, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW());`,
        [settlementId, ws, cpId, cents.toString()]
      );
      // The clear and the settlement row commit together: from this commit the settlement owns the cleared amount.
      await client.query(
        `INSERT INTO tab_entries (id, workspace_id, counterparty_id, kind, amount_micro, idempotency_key, settlement_id, description, created_at)
         VALUES ($1, $2, $3, 'clear', $4, $5, $6, $7, NOW());`,
        [
          newId("tabent"),
          ws,
          cpId,
          centsToMicro(cents).toString(),
          ledgerKeys.clear(settlementId),
          settlementId,
          `Settlement ${settlementId}`,
        ]
      );
      await writeAudit(client, ws, actor, "tab.settlement_reserved", PolicyDecision.ALLOW, {
        settlementId,
        counterpartyId: cpId,
        amountCents: cents.toString(),
      }, null);
      return {
        kind: "reserved" as const,
        settlement: { settlementId, workspaceId: ws, counterpartyId: cpId, amountCents: cents },
      };
    });
  }

  /**
   * Sends the transfer of a pending settlement through the effects ledger, then records it as submitted.
   *
   * Under the settlement's execution lock, so the gate check, the cancel and a send can never interleave. The rules that
   * keep money safe:
   * - A settlement is cancelled (and its clear reversed) only when nothing can have been sent: this is the first attempt
   *   (no effect row existed before this call) AND the adapter refused with a code in PRE_SEND_REJECTION_CODES.
   * - A gate that fails after an effect row exists is a hold, not a cancel: a send may already have happened.
   * - Every other rejection, and every unknown outcome, is a hold with the clear kept.
   * - Nothing is sent while the workspace is paused, and nothing is sent for a settlement that is not pending.
   */
  async executeSettlement(settlementId: string): Promise<ExecuteOutcome> {
    const lock = await acquireAdvisoryLock(`tab_exec:${settlementId}`, 0);
    if (!lock) return { kind: "busy" };
    try {
      return await this.executeLocked(settlementId);
    } finally {
      await lock.release();
    }
  }

  private async executeLocked(settlementId: string): Promise<ExecuteOutcome> {
    const row = (
      await query(
        `SELECT t.id, t.workspace_id, t.counterparty_id, t.amount_cents::text AS amount_cents, t.status,
                w.settlement_address, w.settlement_mode, w.is_demo, w.agents_paused,
                s.verified, s.payment_address
         FROM tab_settlements t
         JOIN workspaces w ON w.id = t.workspace_id
         JOIN suppliers s ON s.workspace_id = t.workspace_id AND s.id = t.counterparty_id
         WHERE t.id = $1;`,
        [settlementId]
      )
    ).rows[0];
    if (!row) throw new Error(`Tab settlement '${settlementId}' is not found.`);
    if (row.status !== "pending") return { kind: "not_pending", status: row.status };
    if (row.agents_paused === true) return { kind: "paused" };

    // Whether an effect row exists is read before anything else in this call. No row means runEffect has never been
    // entered for this settlement, so nothing can have been sent: that is the only state in which a cancel is safe.
    const priorEffect =
      (await query(`SELECT status, attempts FROM effects WHERE idempotency_key = $1;`, [ledgerKeys.effect(row.workspace_id, row.id)]))
        .rows[0] ?? null;

    const gate =
      row.verified !== true
        ? "SUPPLIER_NOT_VERIFIED"
        : !row.payment_address
          ? "SUPPLIER_PAYMENT_ADDRESS_MISSING"
          : !row.settlement_address
            ? "WORKSPACE_SETTLEMENT_ADDRESS_MISSING"
            : null;
    if (gate) {
      if (priorEffect === null) {
        await this.cancelPending(row.id, gate);
        return { kind: "cancelled", code: gate };
      }
      // An earlier attempt was entered and may have sent. The gate is not evidence that nothing moved, so the clear is
      // kept and the settlement is held. The reconcile of that outcome is a required follow-up (see the ADR addendum).
      await this.hold(row.id, ["pending"], "SETTLEMENT_OUTCOME_UNKNOWN", null, { gate, priorEffectStatus: priorEffect.status });
      return { kind: "held", hold: "SETTLEMENT_OUTCOME_UNKNOWN" };
    }

    const amountCents = BigInt(row.amount_cents);
    if (amountCents <= 0n) throw new Error("A tab settlement must be a positive whole number of cents.");
    const request: TransferRequest = {
      fromAddress: row.settlement_address,
      toAddress: row.payment_address,
      amountCents,
      currency: "USDC",
      orderId: tabAdapterOrderId(row.id),
      idempotencyKey: ledgerKeys.adapterIdempotency(row.id),
      matchHash: tabMatchHash(row.id),
    };
    const adapter = this.settlementFor(effectiveSettlementMode(row));
    const lookup = adapter.findTransfer?.bind(adapter);

    let transfer: TransferResult;
    try {
      ({ result: transfer } = await runEffect<TransferResult>(
        {
          workspaceId: row.workspace_id,
          effectClass: EffectClass.COMMERCIAL_COMMITMENT,
          operation: "settlement.transfer_usdc",
          idempotencyKey: ledgerKeys.effect(row.workspace_id, row.id),
          request,
        },
        () => adapter.transferUSDC(request),
        {
          reconcile: lookup
            ? async () => {
                const found = await lookup({ orderId: request.orderId });
                return found ? { found: true, result: found, externalRef: found.txHash } : { found: false };
              }
            : undefined,
          externalRef: (t) => t.txHash,
        }
      ));
    } catch (err) {
      const code = rejectionCodeOf(err);
      if (code !== null) {
        if (priorEffect === null && PRE_SEND_REJECTION_CODES.has(code)) {
          // The first attempt was refused before anything was sent (see PRE_SEND_REJECTION_CODES): safe to reverse.
          await this.cancelPending(row.id, code);
          return { kind: "cancelled", code };
        }
        // Any other refusal, or any refusal after an earlier attempt: the outcome is not known to be "not sent".
        await this.hold(row.id, ["pending"], "SETTLEMENT_REJECTED", null, { code, retry: priorEffect !== null });
        return { kind: "held", hold: "SETTLEMENT_REJECTED" };
      }
      if (err instanceof EffectInDoubtError) {
        // An earlier attempt may have moved the money and the adapter cannot show it. Held; never sent again here.
        await this.hold(row.id, ["pending"], "SETTLEMENT_OUTCOME_UNKNOWN", null, { effectId: err.effectId, attempts: err.attempts });
        return { kind: "held", hold: "SETTLEMENT_OUTCOME_UNKNOWN" };
      }
      if (err instanceof EffectConflictError) {
        // The request now differs from the one this settlement was first sent with (for example, a changed address).
        // Nothing is sent for it; the settlement is held for a person to look at.
        await this.hold(row.id, ["pending"], "SETTLEMENT_REQUEST_CONFLICT", null, {});
        return { kind: "held", hold: "SETTLEMENT_REQUEST_CONFLICT" };
      }
      throw err;
    }

    if (transfer.status === "failed") {
      // The adapter reports the transfer as failed outright (ADR 0014). The hash is kept; the clear is not reversed.
      await this.hold(row.id, ["pending"], "SETTLEMENT_FAILED", transfer.txHash, { failureCode: transfer.failureCode ?? null });
      return { kind: "held", hold: "SETTLEMENT_FAILED" };
    }

    const recorded = await this.recordSubmitted(row.id, transfer.txHash);
    if (!recorded) {
      // The transfer was sent, so the money moved, and the row is no longer pending. This is surfaced, never retried.
      throw new Error(`Tab settlement '${row.id}' changed while its transfer was sent; it needs review.`);
    }
    return { kind: "submitted", txHash: transfer.txHash };
  }

  /**
   * Confirms a submitted settlement. An advisory lock on the settlement is the claim: a second confirmer returns
   * `in_progress` without calling the adapter. The adapter is asked once. Only `confirmed` finishes the settlement.
   * A failed outcome holds it and keeps the clear. An unresolved outcome leaves it submitted.
   */
  async confirmSettlement(settlementId: string): Promise<ConfirmOutcome> {
    const lock = await acquireAdvisoryLock(`tab_confirm:${settlementId}`, 0);
    if (!lock) return { kind: "in_progress" };
    try {
      const row = (
        await query(
          `SELECT t.id, t.workspace_id, t.counterparty_id, t.status, t.tx_hash, w.settlement_mode, w.is_demo
           FROM tab_settlements t JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = $1;`,
          [settlementId]
        )
      ).rows[0];
      if (!row) throw new Error(`Tab settlement '${settlementId}' is not found.`);
      if (row.status !== "submitted") return { kind: "current", status: row.status };

      const adapter = this.settlementFor(effectiveSettlementMode(row));
      let outcome = await this.confirmOnce(adapter, settlementId, row.tx_hash);
      let settledHash: string = row.tx_hash;
      if (outcome.kind === "failed" && outcome.failureCode === "REVERTED") {
        // A second broadcast can revert with OrderAlreadySettled-style errors while the first transfer moved the money.
        const adopted = await this.adoptConfirmedDuplicate(row, adapter);
        if (adopted) {
          settledHash = adopted.txHash;
          outcome = { kind: "confirmed", timestamp: adopted.timestamp, blockNumber: adopted.blockNumber };
        }
      }

      if (outcome.kind === "failed") {
        await this.hold(settlementId, ["submitted"], "SETTLEMENT_FAILED", row.tx_hash, { failureCode: outcome.failureCode ?? null });
        return { kind: "held", hold: "SETTLEMENT_FAILED" };
      }
      if (outcome.kind === "unconfirmed") {
        // Touch the row so the worker polls again after its interval, not on every tick.
        await query(`UPDATE tab_settlements SET updated_at = NOW() WHERE id = $1 AND status = 'submitted';`, [settlementId]);
        return { kind: "awaiting", txHash: row.tx_hash };
      }

      await withTransaction(async (client) => {
        const upd = await client.query(
          `UPDATE tab_settlements SET status = 'confirmed', tx_hash = $2, confirmed_at = $3, confirmed_block = $4, updated_at = NOW()
           WHERE id = $1 AND status = 'submitted' AND tx_hash = $2;`,
          [settlementId, settledHash, outcome.timestamp, outcome.blockNumber ?? null]
        );
        if (upd.rowCount !== 1) return;
        await writeAudit(client, row.workspace_id, SYSTEM_ACTOR, "tab.settlement_confirmed", PolicyDecision.ALLOW, {
          settlementId,
          counterpartyId: row.counterparty_id,
          blockNumber: outcome.blockNumber ?? null,
        }, settledHash);
      });
      return { kind: "confirmed", txHash: settledHash };
    } finally {
      await lock.release();
    }
  }

  /** Executes, then confirms when the transfer was sent. Returns the settlement as stored afterwards. */
  private async finishSettlement(reserved: ReservedSettlement): Promise<SettleResult> {
    const exec = await this.executeSettlement(reserved.settlementId);
    if (exec.kind === "submitted") await this.confirmSettlement(reserved.settlementId);
    const row = await this.loadSettlement(reserved.settlementId);
    if (!row) throw new Error(`Tab settlement '${reserved.settlementId}' is not found after settlement.`);
    return {
      outcome: "settlement",
      settlementId: row.id,
      status: row.status,
      amountCents: row.amountCents,
      txHash: row.txHash,
      holdReason: row.holdReason ?? (exec.kind === "paused" ? "AGENTS_PAUSED" : null),
    };
  }

  // ---- Internal transitions (each guarded on the status it expects) ------------------------------------------------

  /** Cancels a pending settlement that was refused before anything was sent, and writes its one reversal entry. */
  private async cancelPending(settlementId: string, code: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE tab_settlements SET status = 'cancelled', hold_reason = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'pending' RETURNING workspace_id, counterparty_id, amount_cents::text AS amount_cents;`,
        [settlementId, code]
      );
      if (upd.rowCount !== 1) return false;
      const settled = upd.rows[0];
      await client.query(
        `INSERT INTO tab_entries (id, workspace_id, counterparty_id, kind, amount_micro, idempotency_key, settlement_id, description, created_at)
         VALUES ($1, $2, $3, 'reversal', $4, $5, $6, $7, NOW());`,
        [
          newId("tabent"),
          settled.workspace_id,
          settled.counterparty_id,
          centsToMicro(BigInt(settled.amount_cents)).toString(),
          ledgerKeys.reversal(settlementId),
          settlementId,
          `Reversal of ${settlementId}: ${code}`,
        ]
      );
      await writeAudit(client, settled.workspace_id, SYSTEM_ACTOR, "tab.settlement_cancelled", PolicyDecision.DENY, {
        settlementId,
        counterpartyId: settled.counterparty_id,
        code,
      }, null);
      return true;
    });
  }

  /** Records the transfer as submitted: the hash and the submitted time, guarded on pending, with its audit row. */
  private async recordSubmitted(settlementId: string, txHash: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE tab_settlements SET status = 'submitted', tx_hash = $2, submitted_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'pending' RETURNING workspace_id, counterparty_id, amount_cents::text AS amount_cents;`,
        [settlementId, txHash]
      );
      if (upd.rowCount !== 1) return false;
      const row = upd.rows[0];
      await writeAudit(client, row.workspace_id, SYSTEM_ACTOR, "tab.settlement_submitted", PolicyDecision.ALLOW, {
        settlementId,
        counterpartyId: row.counterparty_id,
        amountCents: row.amount_cents,
      }, txHash);
      return true;
    });
  }

  /** Moves a settlement from one of `from` to held, keeping its clear. Guarded: a row in another state is left alone. */
  private async hold(
    settlementId: string,
    from: TabSettlementStatus[],
    hold: string,
    txHash: string | null,
    evidence: Record<string, unknown>
  ): Promise<boolean> {
    return withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE tab_settlements SET status = 'held', hold_reason = $2, tx_hash = COALESCE($3, tx_hash), updated_at = NOW()
         WHERE id = $1 AND status = ANY($4::text[]) RETURNING workspace_id, counterparty_id;`,
        [settlementId, hold, txHash, from]
      );
      if (upd.rowCount !== 1) return false;
      await writeAudit(client, upd.rows[0].workspace_id, SYSTEM_ACTOR, "tab.settlement_held", PolicyDecision.DENY, {
        settlementId,
        counterpartyId: upd.rows[0].counterparty_id,
        hold,
        ...evidence,
      }, txHash);
      return true;
    });
  }

  /** One confirm call. A call that throws leaves the outcome unknown; it is never read as a failure. */
  private async confirmOnce(
    adapter: SettlementAdapter,
    settlementId: string,
    txHash: string
  ): Promise<{ kind: "confirmed"; timestamp: Date; blockNumber?: number } | { kind: "failed"; failureCode?: string } | { kind: "unconfirmed" }> {
    try {
      const result = await adapter.confirm(txHash);
      if (result.status === "confirmed") return { kind: "confirmed", timestamp: result.timestamp, blockNumber: result.blockNumber };
      if (result.status === "failed") return { kind: "failed", failureCode: result.failureCode };
      return { kind: "unconfirmed" };
    } catch (err) {
      logOutcomeUnknown("tab.settlement.outcome_unknown", settlementId, err);
      return { kind: "unconfirmed" };
    }
  }

  /**
   * ADR 0079's duplicate rule for tabs. A REVERTED outcome for the stored hash may be the second broadcast of one
   * settlement while the first moved the money. The adapter's findTransfer for the tab's order id is asked; the other hash
   * is adopted only when it is CONFIRMED and differs. Anything else returns null and the caller holds the settlement.
   */
  private async adoptConfirmedDuplicate(
    row: { id: string; workspace_id: string; tx_hash: string },
    adapter: SettlementAdapter
  ): Promise<TransferResult | null> {
    if (!adapter.findTransfer) return null;
    let found: TransferResult | null;
    try {
      found = await adapter.findTransfer({ orderId: tabAdapterOrderId(row.id) });
    } catch (err) {
      logOutcomeUnknown("tab.settlement.duplicate_lookup_failed", row.id, err);
      return null;
    }
    if (found === null || found.status !== "confirmed") return null;
    if (found.txHash.toLowerCase() === String(row.tx_hash).toLowerCase()) return null;

    const adopted = await withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE tab_settlements SET tx_hash = $2, updated_at = NOW() WHERE id = $1 AND status = 'submitted' AND tx_hash = $3;`,
        [row.id, found!.txHash, row.tx_hash]
      );
      if (upd.rowCount !== 1) return false;
      await client.query(`UPDATE effects SET external_ref = $2, updated_at = NOW() WHERE idempotency_key = $1;`, [
        ledgerKeys.effect(row.workspace_id, row.id),
        found!.txHash,
      ]);
      await writeAudit(client, row.workspace_id, SYSTEM_ACTOR, "tab.settlement_reverted_duplicate_adopted", PolicyDecision.ALLOW, {
        settlementId: row.id,
        revertedTxHash: row.tx_hash,
        adoptedTxHash: found!.txHash,
      }, found!.txHash);
      return true;
    });
    return adopted ? found : null;
  }
}

/** The ledger used by the API and the worker when no adapter is injected. Tests build their own with a spy adapter. */
export const tabLedger = new TabLedger();

