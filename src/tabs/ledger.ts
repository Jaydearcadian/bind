import { query, withTransaction } from "../db/client.js";
import { acquireAdvisoryLock } from "../db/advisory-lock.js";
import { EffectConflictError, EffectInDoubtError, runEffect } from "../effects/ledger.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PolicyDecision } from "../policy/engine.js";
import { SettlementPayerMismatchError, SettlementRejectedError } from "../adapters/settlement/errors.js";
import { getSettlementAdapter } from "../adapters/settlement/index.js";
import type { SettlementAdapter, TransferRequest, TransferResult } from "../adapters/settlement/types.js";
import { DROPPED_AFTER_MS, assessDropped } from "../adapters/settlement/dropped.js";
import { ZERO_ADDRESS_RECIPIENT } from "../adapters/settlement/errors.js";
import { effectiveSettlementMode } from "../demo/policy.js";
import { spendStatusesSql } from "../orders/statuses.js";
import { spendLockKey } from "../orders/reservation.js";
import { UTC_DAY_START_SQL, utcDayStart } from "../utils/utc-day.js";
import { TAB_SPEND_TODAY_CENTS_SQL } from "./spend-sql.js";
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

/** One held settlement, as the operator's list shows it (docs/decisions/0081). */
export interface HeldSettlementRow {
  id: string;
  counterpartyId: string;
  amountCents: bigint;
  holdReason: string | null;
  txHash: string | null;
  createdAt: Date;
  updatedAt: Date;
  hasEffect: boolean;
  effectStatus: string | null;
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
  /**
   * Set by the end-of-day batch: the UTC day it is claiming. The claim is taken in the reserve transaction, so one tab is
   * attempted at most once per UTC day, and a crash leaves no claim behind without a settlement.
   */
  endOfDay?: { utcDay: string };
}

/** What a settle call did. Amounts are bigint; the API turns them into strings. */
export type SettleResult =
  | { outcome: "below_threshold"; balanceMicro: bigint }
  | { outcome: "needs_approval"; amountCents: bigint; thresholdCents: bigint }
  | { outcome: "refused"; reason: "AGENTS_PAUSED" | "DAILY_LIMIT_EXCEEDED"; balanceMicro: bigint }
  | { outcome: "already_attempted"; utcDay: string }
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

/** What reconcileHeld did. Only `adopted` moved anything: it re-opened the settlement with a hash and ran the confirmation. */
export type ReconcileOutcome =
  | { kind: "not_found" }
  | { kind: "busy" }
  | { kind: "current"; status: TabSettlementStatus }
  | { kind: "no_clear" }
  | { kind: "lookup_unavailable"; holdReason: string | null }
  | { kind: "nothing_found"; holdReason: string | null }
  | { kind: "lookup_unconfirmed"; holdReason: string | null }
  | { kind: "hash_conflict"; holdReason: string | null }
  | {
      kind: "adopted";
      source: "stored" | "effect" | "lookup";
      txHash: string;
      status: TabSettlementStatus;
      holdReason: string | null;
      confirm: ConfirmOutcome["kind"];
    };

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function isTxHash(value: unknown): value is string {
  return typeof value === "string" && TX_HASH_PATTERN.test(value);
}

/** Which proof allowed a restore (see cancelHeldAndRestore). */
export type RestoreProof =
  | "NO_EFFECT_ROW"
  | "DEFINITIVE_REVERT"
  | "UNKNOWN_NOT_SETTLED_ACKNOWLEDGED"
  /** Proof (iii) for a SETTLEMENT_DROPPED hold (docs/decisions/0087, item 5). Its own label, so the audit names the case. */
  | "DROPPED_NOT_SETTLED_ACKNOWLEDGED";

/** What cancelHeldAndRestore did. `replayed` is true when the settlement was already cancelled: nothing was written. */
export type RestoreOutcome =
  | { kind: "not_found" }
  | { kind: "busy" }
  | { kind: "cancelled"; proof: RestoreProof; amountCents: bigint; replayed: false }
  | { kind: "already_cancelled"; proof: string | null; amountCents: bigint; replayed: true }
  | { kind: "not_held"; status: TabSettlementStatus }
  | { kind: "no_clear" }
  | { kind: "refused"; code: "NOT_PROVABLY_UNSENT"; reason: string }
  /** The row changed between the proof and the write (a status or a hash). Nothing was cancelled or reversed. */
  | { kind: "changed" };

/** The age an unknown outcome's effect row must reach before a restore may use proof (iii). */
export const RESTORE_MIN_AGE_MS = 30 * 60 * 1000;

export interface TabLedgerDeps {
  /** The adapter for a settlement mode. Defaults to the configured adapter, exactly as orders use it. */
  settlementFor?: (mode: string) => SettlementAdapter;
  /**
   * Test seam: runs inside a reserve transaction after the committed spend is read, before anything is written. The
   * budget race test uses it to hold every reserve at the same point. Not set in production.
   */
  afterBudgetRead?: (at: { workspaceId: string; counterpartyId: string }) => Promise<void>;
  /**
   * Test seam, never set in production: runs after a restore's proof is established and before its write. The restore
   * tests use it to change the row in that window and assert that nothing is cancelled or reversed.
   */
  afterRestoreProof?: (at: { settlementId: string }) => Promise<void>;
  /**
   * How long a submitted transfer must be unseen by the node before it may be called dropped (docs/decisions/0087, item 5).
   * Default 120 seconds. Tests set it to 0 or to a larger window.
   */
  droppedAfterMs?: number;
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
    `SELECT ((SELECT COALESCE(SUM(total_price_cents), 0) FROM orders
               WHERE workspace_id = $1 AND created_at >= ${UTC_DAY_START_SQL} AND status IN (${spendStatusesSql()}))
             + ${TAB_SPEND_TODAY_CENTS_SQL})::text AS spent;`,
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
 * - ZERO_ADDRESS_RECIPIENT: the recipient is the zero address, refused before any settings check or RPC call (docs/decisions/0087, item 4).
 * Not in this set, on purpose: OrderAlreadySettled and UNKNOWN_REVERT (both decoded from the chain, so the transfer may
 * have moved money), any other decoded revert name, TRANSFER_FAILED_RECIPIENT (a revert, not proof that nothing was sent),
 * and transport errors. Those hold the clear.
 */
export const PRE_SEND_REJECTION_CODES: ReadonlySet<string> = new Set([
  "INVALID_REQUEST",
  "SUB_CENT_AMOUNT_NOT_SUPPORTED",
  "PAYER_MISMATCH",
  ZERO_ADDRESS_RECIPIENT,
]);

/**
 * Writes an audit row at most once per counterparty per UTC day, in the same transaction. A batch that visits a refused tab
 * again on the same day writes nothing more: the first row says what happened, and the day's state is in the ledger.
 */
async function auditOncePerDay(
  db: Db,
  workspaceId: string,
  actor: TabActor,
  action: string,
  decision: PolicyDecision,
  evidence: { counterpartyId: string } & Record<string, unknown>,
  dayStart: Date
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, tx_hash, created_at, request_id)
     SELECT $1::varchar, $2::varchar, NULL, $3::text, $4::text, $5::text, $6::text, $7::text, $8::jsonb, NULL, NOW(), $9::text
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_logs WHERE workspace_id = $2::varchar AND action = $6::text AND evidence->>'counterpartyId' = $10::text AND created_at >= $11::timestamptz
     );`,
    [
      newId("audit"),
      workspaceId,
      actor.type,
      actor.id,
      EffectClass.COMMERCIAL_COMMITMENT,
      action,
      decision,
      JSON.stringify(evidence),
      currentRequestId(),
      evidence.counterpartyId,
      dayStart,
    ]
  );
}

/** The rejection code of an adapter refusal, or null for any other error. */
function rejectionCodeOf(err: unknown): string | null {
  if (err instanceof SettlementRejectedError) return err.code;
  if (err instanceof SettlementPayerMismatchError) return "PAYER_MISMATCH";
  return null;
}

/** The lookup must answer null. A transfer found, or a lookup that throws, refuses. Never read as "not found". */
async function lookupForRestore(
  adapter: SettlementAdapter,
  orderId: string,
  unavailable: string
): Promise<{ kind: "ok" } | { kind: "refused"; reason: string }> {
  let found: TransferResult | null;
  try {
    found = await adapter.findTransfer!({ orderId });
  } catch {
    return { kind: "refused", reason: unavailable };
  }
  if (found !== null) return { kind: "refused", reason: "a transfer for the order was found" };
  return { kind: "ok" };
}

/** The contract must say the order is not settled. True refuses; a read that throws refuses. */
async function settledForRestore(
  adapter: SettlementAdapter,
  orderId: string,
  unavailable: string
): Promise<{ kind: "ok" } | { kind: "refused"; reason: string }> {
  let settled: boolean;
  try {
    settled = await adapter.isOrderSettled!(orderId);
  } catch {
    return { kind: "refused", reason: unavailable };
  }
  if (settled !== false) return { kind: "refused", reason: "the order is settled on the contract" };
  return { kind: "ok" };
}

export class TabLedger {
  private readonly settlementFor: (mode: string) => SettlementAdapter;

  private readonly afterBudgetRead?: (at: { workspaceId: string; counterpartyId: string }) => Promise<void>;

  private readonly afterRestoreProof?: (at: { settlementId: string }) => Promise<void>;

  private readonly droppedAfterMs: number;

  constructor(deps: TabLedgerDeps = {}) {
    this.afterBudgetRead = deps.afterBudgetRead;
    this.afterRestoreProof = deps.afterRestoreProof;
    this.droppedAfterMs = deps.droppedAfterMs ?? DROPPED_AFTER_MS;
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

  /**
   * The held settlements of one workspace, oldest change first, bounded. For the operator's list: the row, and whether an
   * effect row exists for it and in which state. Workspace-scoped; nothing of another workspace is read.
   */
  async listHeldSettlements(workspaceId: string, limit = 50): Promise<HeldSettlementRow[]> {
    assertWorkspaceId(workspaceId);
    const res = await query(
      `SELECT t.id, t.counterparty_id, t.amount_cents::text AS amount_cents, t.hold_reason, t.tx_hash, t.created_at, t.updated_at,
              (e.id IS NOT NULL) AS has_effect, e.status AS effect_status
       FROM tab_settlements t
       LEFT JOIN effects e ON e.idempotency_key = t.workspace_id || ':tab_settle:' || t.id
       WHERE t.workspace_id = $1 AND t.status = 'held'
       ORDER BY t.updated_at ASC, t.id ASC
       LIMIT $2;`,
      [workspaceId, Math.min(Math.max(limit, 1), 100)]
    );
    return res.rows.map((row) => ({
      id: row.id,
      counterpartyId: row.counterparty_id,
      amountCents: BigInt(row.amount_cents),
      holdReason: row.hold_reason ?? null,
      txHash: row.tx_hash ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      hasEffect: row.has_effect === true,
      effectStatus: row.effect_status ?? null,
    }));
  }

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
    const dayStart = utcDayStart(new Date());

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

      // The owner's pause switch (ADR 0023): nothing is cleared or sent while paused. A paused attempt uses no end-of-day claim.
      if (workspace.agents_paused === true) {
        await auditOncePerDay(client, ws, actor, "tab.settlement_paused_hold", PolicyDecision.DENY, {
          counterpartyId: cpId,
          hold: "AGENTS_PAUSED",
          amountCents: cents.toString(),
        }, dayStart);
        return { kind: "final" as const, result: { outcome: "refused" as const, reason: "AGENTS_PAUSED" as const, balanceMicro } };
      }

      // The attempt is recorded in this transaction. An end-of-day attempt also claims its UTC day: one conditional upsert,
      // so a second batch on the same day finds the day claimed and returns, and a crash rolls the claim back with the rest.
      if (input.endOfDay) {
        const claimed = await client.query(
          `INSERT INTO tab_attempts (workspace_id, counterparty_id, last_attempt_at, last_utc_day)
           VALUES ($1, $2, NOW(), $3::date)
           ON CONFLICT (workspace_id, counterparty_id) DO UPDATE
             SET last_attempt_at = NOW(), last_utc_day = EXCLUDED.last_utc_day
             WHERE tab_attempts.last_utc_day IS NULL OR tab_attempts.last_utc_day < EXCLUDED.last_utc_day
           RETURNING 1;`,
          [ws, cpId, input.endOfDay.utcDay]
        );
        if (claimed.rowCount === 0) {
          return { kind: "final" as const, result: { outcome: "already_attempted" as const, utcDay: input.endOfDay.utcDay } };
        }
      } else {
        await client.query(
          `INSERT INTO tab_attempts (workspace_id, counterparty_id, last_attempt_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (workspace_id, counterparty_id) DO UPDATE SET last_attempt_at = NOW();`,
          [ws, cpId]
        );
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

      // One chunk: at most the approval threshold. A balance above it settles chunk by chunk, each chunk its own settlement
      // through every gate and the budget. The rest carries over to the next attempt.
      const thresholdCents = BigInt(workspace.approval_threshold_cents);
      if (!hold && thresholdCents < 1n) {
        await auditOncePerDay(client, ws, actor, "tab.settlement_needs_approval", PolicyDecision.REQUIRE_APPROVAL, {
          counterpartyId: cpId,
          amountCents: cents.toString(),
          thresholdCents: thresholdCents.toString(),
        }, dayStart);
        return { kind: "final" as const, result: { outcome: "needs_approval" as const, amountCents: cents, thresholdCents } };
      }
      const chunk = cents > thresholdCents ? thresholdCents : cents;

      if (hold) {
        const settlementId = newId("tabset");
        await client.query(
          `INSERT INTO tab_settlements (id, workspace_id, counterparty_id, amount_cents, status, hold_reason, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'held', $5, NOW(), NOW());`,
          [settlementId, ws, cpId, chunk.toString(), hold]
        );
        await writeAudit(client, ws, actor, "tab.settlement_held", PolicyDecision.DENY, {
          settlementId,
          counterpartyId: cpId,
          hold,
          amountCents: chunk.toString(),
        }, null);
        return {
          kind: "final" as const,
          result: { outcome: "settlement" as const, settlementId, status: "held" as const, amountCents: chunk, txHash: null, holdReason: hold },
        };
      }

      // One lock covers the budget check and the write: the spend lock is held by the caller (reserveSettlement).
      const spent = await committedSpendTodayCents(client, ws);
      if (this.afterBudgetRead) await this.afterBudgetRead({ workspaceId: ws, counterpartyId: cpId });
      const dailyLimitCents = BigInt(workspace.budget_daily_limit_cents);
      if (spent + chunk > dailyLimitCents) {
        await auditOncePerDay(client, ws, actor, "tab.settlement_refused", PolicyDecision.DENY, {
          counterpartyId: cpId,
          reason: "DAILY_LIMIT_EXCEEDED",
          amountCents: chunk.toString(),
          dailySpentCents: spent.toString(),
          dailyLimitCents: dailyLimitCents.toString(),
        }, dayStart);
        return { kind: "final" as const, result: { outcome: "refused" as const, reason: "DAILY_LIMIT_EXCEEDED" as const, balanceMicro } };
      }

      const settlementId = newId("tabset");
      await client.query(
        `INSERT INTO tab_settlements (id, workspace_id, counterparty_id, amount_cents, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', NOW(), NOW());`,
        [settlementId, ws, cpId, chunk.toString()]
      );
      // The clear and the settlement row commit together: from this commit the settlement owns the cleared amount.
      await client.query(
        `INSERT INTO tab_entries (id, workspace_id, counterparty_id, kind, amount_micro, idempotency_key, settlement_id, description, created_at)
         VALUES ($1, $2, $3, 'clear', $4, $5, $6, $7, NOW());`,
        [
          newId("tabent"),
          ws,
          cpId,
          centsToMicro(chunk).toString(),
          ledgerKeys.clear(settlementId),
          settlementId,
          `Settlement ${settlementId}`,
        ]
      );
      await writeAudit(client, ws, actor, "tab.settlement_reserved", PolicyDecision.ALLOW, {
        settlementId,
        counterpartyId: cpId,
        amountCents: chunk.toString(),
      }, null);
      return {
        kind: "reserved" as const,
        settlement: { settlementId, workspaceId: ws, counterpartyId: cpId, amountCents: chunk },
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
    if (!recorded) return this.unrecordedHash(row.id, transfer.txHash);
    return { kind: "submitted", txHash: transfer.txHash };
  }

  /**
   * The transfer was sent, so the money moved, but the settlement is no longer pending: another caller holds it (a busy
   * lock, see docs/decisions/0081). The hash is not lost. The effect row completed with it, and an audit row names it here.
   * Nothing is retried and nothing is thrown: the caller gets the held state and reconcileHeld adopts the hash.
   */
  private async unrecordedHash(settlementId: string, txHash: string): Promise<ExecuteOutcome> {
    return withTransaction(async (client) => {
      const cur = (
        await client.query(`SELECT workspace_id, counterparty_id, status, hold_reason FROM tab_settlements WHERE id = $1 FOR UPDATE;`, [
          settlementId,
        ])
      ).rows[0];
      if (!cur) throw new Error(`Tab settlement '${settlementId}' is not found.`);
      await writeAudit(client, cur.workspace_id, SYSTEM_ACTOR, "tab.settlement_hash_unrecorded", PolicyDecision.DENY, {
        settlementId,
        counterpartyId: cur.counterparty_id,
        currentStatus: cur.status,
        holdReason: cur.hold_reason ?? null,
      }, txHash);
      if (cur.status === "held") return { kind: "held" as const, hold: cur.hold_reason ?? "SETTLEMENT_OUTCOME_UNKNOWN" };
      return { kind: "not_pending" as const, status: cur.status as TabSettlementStatus };
    });
  }

  /**
   * Reconciles one held settlement that owns a clear (docs/decisions/0081, items a and b). It finds the hash of the transfer,
   * moves the settlement to submitted with that hash, and runs the normal confirmation, so `confirmed` is only ever set from
   * the adapter's confirm(). It never sends (transferUSDC is not called) and it never cancels or reverses a clear.
   *
   * Where the hash comes from, in order: the settlement's own tx_hash (a hold after a failed confirmation, which is asked
   * again), the effect row's external_ref (the hash of the call that was made), then the adapter's findTransfer for the order
   * id. A lookup that throws, answers null, or answers a transfer that is not confirmed leaves the settlement held. Under the
   * settlement's execution lock; a busy lock is reported, not waited for. Running it again is a no-op once it has moved on.
   */
  async reconcileHeld(settlementId: string, actor: TabActor = SYSTEM_ACTOR): Promise<ReconcileOutcome> {
    const lock = await acquireAdvisoryLock(`tab_exec:${settlementId}`, 0);
    if (!lock) return { kind: "busy" };
    try {
      return await this.reconcileLocked(settlementId, actor);
    } finally {
      await lock.release();
    }
  }

  private async reconcileLocked(settlementId: string, actor: TabActor): Promise<ReconcileOutcome> {
    const row = await this.settlementWithMode(settlementId);
    if (!row) return { kind: "not_found" };
    if (row.status !== "held") return { kind: "current", status: row.status as TabSettlementStatus };
    const clears = await query(`SELECT 1 FROM tab_entries WHERE settlement_id = $1 AND kind = 'clear' LIMIT 1;`, [settlementId]);
    if (clears.rowCount !== 1) return { kind: "no_clear" };

    const holdReason: string | null = row.hold_reason ?? null;
    const effect =
      (await query(`SELECT external_ref FROM effects WHERE idempotency_key = $1;`, [ledgerKeys.effect(row.workspace_id, settlementId)]))
        .rows[0] ?? null;
    const effectHash: string | null = isTxHash(effect?.external_ref) ? effect.external_ref : null;
    const adapter = this.settlementFor(effectiveSettlementMode(row));

    let hash: string;
    let source: "stored" | "effect" | "lookup";
    if (row.tx_hash) {
      if (effectHash !== null && effectHash.toLowerCase() !== String(row.tx_hash).toLowerCase()) {
        return { kind: "hash_conflict", holdReason };
      }
      hash = row.tx_hash;
      source = "stored";
    } else if (effectHash !== null) {
      hash = effectHash;
      source = "effect";
    } else {
      if (!adapter.findTransfer) return { kind: "lookup_unavailable", holdReason };
      let found: TransferResult | null;
      try {
        found = await adapter.findTransfer({ orderId: tabAdapterOrderId(settlementId) });
      } catch (err) {
        logOutcomeUnknown("tab.settlement.reconcile_lookup_failed", settlementId, err);
        return { kind: "lookup_unavailable", holdReason };
      }
      if (found === null) return { kind: "nothing_found", holdReason };
      if (found.status !== "confirmed" || !isTxHash(found.txHash)) return { kind: "lookup_unconfirmed", holdReason };
      hash = found.txHash;
      source = "lookup";
    }

    // Adoption: held to submitted with this hash, guarded on the state read above. The hold reason is cleared; the confirmation
    // below decides the next state. A settlement re-opened from its own hash is audited as such, not as an adoption.
    const adopted = await withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE tab_settlements
         SET status = 'submitted', tx_hash = $2, submitted_at = COALESCE(submitted_at, NOW()), hold_reason = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'held' AND (tx_hash IS NULL OR tx_hash = $2)
         RETURNING workspace_id, counterparty_id;`,
        [settlementId, hash]
      );
      if (upd.rowCount !== 1) return false;
      await writeAudit(
        client,
        upd.rows[0].workspace_id,
        actor,
        source === "stored" ? "tab.settlement_reopened" : "tab.settlement_hash_adopted",
        PolicyDecision.ALLOW,
        { settlementId, counterpartyId: upd.rows[0].counterparty_id, source, previousHoldReason: holdReason },
        hash
      );
      return true;
    });
    if (!adopted) return { kind: "current", status: (await this.loadSettlement(settlementId))?.status ?? "held" };

    const confirmed = await this.confirmSettlement(settlementId);
    const final = await this.loadSettlement(settlementId);
    if (!final) throw new Error(`Tab settlement '${settlementId}' is not found after reconcile.`);
    return {
      kind: "adopted",
      source,
      txHash: hash,
      status: final.status,
      holdReason: final.holdReason,
      confirm: confirmed.kind,
    };
  }

  private async settlementWithMode(settlementId: string) {
    return (
      (
        await query(
          `SELECT t.id, t.workspace_id, t.counterparty_id, t.status, t.tx_hash, t.hold_reason, t.amount_cents::text AS amount_cents,
                  w.settlement_mode, w.is_demo
           FROM tab_settlements t JOIN workspaces w ON w.id = t.workspace_id WHERE t.id = $1;`,
          [settlementId]
        )
      ).rows[0] ?? null
    );
  }

  /**
   * Cancels a held settlement that owns a clear, and restores the clear with exactly one reversal entry (docs/decisions/0081,
   * item a). The owner's action. It is refused unless one of three proofs holds, each checked by this code and not by a model:
   *
   * (i) NO_EFFECT_ROW: no effect row exists, so runEffect was never entered for the settlement and nothing was sent.
   * (ii) DEFINITIVE_REVERT: the stored hash's confirmation reports failed with REVERTED, findTransfer finds no confirmed
   *      transfer for the order id, and isOrderSettled is false. A reverted transaction moved nothing.
   * (iii) UNKNOWN_NOT_SETTLED_ACKNOWLEDGED: the outcome is unknown (SETTLEMENT_OUTCOME_UNKNOWN), no hash is recorded anywhere,
   *      the effect row was last updated at least 30 minutes ago, findTransfer finds nothing, isOrderSettled is false, and the
   *      owner acknowledged the residual risk. The residual: a transaction still in a mempool, not yet mined, has no log and
   *      no settled order yet. If it mines later it would move money that this restore has already given back. The 30 minute
   *      window and the owner's acknowledgement are the only guards against that. It is stated in docs/CONTRACT_SCOPE.md.
   *
   * Any other state is refused with NOT_PROVABLY_UNSENT, and the refusal is audited. A lookup or read that throws refuses: it
   * is never read as "not found" or "not settled". Under the settlement's execution lock, so no send can interleave.
   * Repeating the call on a cancelled settlement returns the stored result and writes nothing more.
   */
  async cancelHeldAndRestore(
    settlementId: string,
    opts: { actor: TabActor; acknowledgeNotSent: boolean }
  ): Promise<RestoreOutcome> {
    const lock = await acquireAdvisoryLock(`tab_exec:${settlementId}`, 0);
    if (!lock) return { kind: "busy" };
    try {
      return await this.restoreLocked(settlementId, opts);
    } finally {
      await lock.release();
    }
  }

  private async restoreLocked(
    settlementId: string,
    opts: { actor: TabActor; acknowledgeNotSent: boolean }
  ): Promise<RestoreOutcome> {
    const row = await this.settlementWithMode(settlementId);
    if (!row) return { kind: "not_found" };
    const amountCents = BigInt(row.amount_cents);
    if (row.status === "cancelled") {
      return { kind: "already_cancelled", proof: row.hold_reason ?? null, amountCents, replayed: true };
    }
    if (row.status !== "held") return { kind: "not_held", status: row.status as TabSettlementStatus };
    const clears = await query(`SELECT 1 FROM tab_entries WHERE settlement_id = $1 AND kind = 'clear' LIMIT 1;`, [settlementId]);
    if (clears.rowCount !== 1) return { kind: "no_clear" };

    const effect =
      (
        await query(`SELECT status, external_ref, updated_at FROM effects WHERE idempotency_key = $1;`, [
          ledgerKeys.effect(row.workspace_id, settlementId),
        ])
      ).rows[0] ?? null;
    const adapter = this.settlementFor(effectiveSettlementMode(row));
    const verdict = await this.proveRestore(settlementId, row, effect, opts.acknowledgeNotSent, adapter);
    if (verdict.kind === "refused") {
      await withTransaction(async (client) => {
        await writeAudit(client, row.workspace_id, opts.actor, "tab.settlement_restore_refused", PolicyDecision.DENY, {
          settlementId,
          counterpartyId: row.counterparty_id,
          code: "NOT_PROVABLY_UNSENT",
          reason: verdict.reason,
          holdReason: row.hold_reason ?? null,
        }, row.tx_hash ?? null);
      });
      return { kind: "refused", code: "NOT_PROVABLY_UNSENT", reason: verdict.reason };
    }

    if (this.afterRestoreProof) await this.afterRestoreProof({ settlementId });

    const restored = await withTransaction(async (client) => {
      // The write is bound to the state the proof examined: still held, with the same hash (none, for proof iii). A row that
      // changed in between matches nothing, returns false before any reversal is written, and the transaction writes nothing.
      const upd = await client.query(
        `UPDATE tab_settlements SET status = 'cancelled', hold_reason = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'held' AND tx_hash IS NOT DISTINCT FROM $3 RETURNING workspace_id, counterparty_id;`,
        [settlementId, verdict.proof, row.tx_hash ?? null]
      );
      if (upd.rowCount !== 1) return false;
      // The reversal's key is one per settlement, so a second reversal for it cannot be written at all.
      await client.query(
        `INSERT INTO tab_entries (id, workspace_id, counterparty_id, kind, amount_micro, idempotency_key, settlement_id, description, created_at)
         VALUES ($1, $2, $3, 'reversal', $4, $5, $6, $7, NOW());`,
        [
          newId("tabent"),
          row.workspace_id,
          row.counterparty_id,
          centsToMicro(amountCents).toString(),
          ledgerKeys.reversal(settlementId),
          settlementId,
          `Restore of ${settlementId}: ${verdict.proof}`,
        ]
      );
      await writeAudit(client, row.workspace_id, opts.actor, "tab.settlement_restored", PolicyDecision.ALLOW, {
        settlementId,
        counterpartyId: row.counterparty_id,
        proof: verdict.proof,
        priorHoldReason: row.hold_reason ?? null,
        amountCents: amountCents.toString(),
        acknowledgeNotSent: opts.acknowledgeNotSent,
      }, row.tx_hash ?? null);
      return true;
    });
    if (!restored) return { kind: "changed" };
    return { kind: "cancelled", proof: verdict.proof, amountCents, replayed: false };
  }

  /** The restore proof for a held settlement that owns a clear, or the reason it is refused. Reads only; sends nothing. */
  private async proveRestore(
    settlementId: string,
    row: { tx_hash: string | null; hold_reason: string | null },
    effect: { external_ref: string | null; updated_at: Date } | null,
    acknowledgeNotSent: boolean,
    adapter: SettlementAdapter
  ): Promise<{ kind: "proved"; proof: RestoreProof } | { kind: "refused"; reason: string }> {
    const orderId = tabAdapterOrderId(settlementId);
    // (i) Nothing was ever entered for this settlement, so nothing can have been sent. No adapter call is needed.
    if (effect === null) return { kind: "proved", proof: "NO_EFFECT_ROW" };
    if (typeof adapter.isOrderSettled !== "function" || typeof adapter.findTransfer !== "function") {
      return { kind: "refused", reason: "the settlement adapter cannot prove the order is unsettled" };
    }

    if (row.hold_reason === "SETTLEMENT_DROPPED") {
      // (iii) for a dropped transfer (docs/decisions/0087, item 5): same window, acknowledgement and reads as an unknown
      // outcome, and the stored hash must still be one the node does not know, asked now.
      return this.proveDroppedRestore(settlementId, row, effect, acknowledgeNotSent, adapter, orderId);
    }

    if (row.tx_hash) {
      // (ii) The stored hash, asked again: a reverted transaction moved nothing. Every restore except proof (i) needs the
      // owner's acknowledgement of the residual risk, so this is checked before any read of the adapter.
      if (!acknowledgeNotSent) {
        return { kind: "refused", reason: "the owner has not acknowledged the residual risk (acknowledgeNotSent)" };
      }
      let outcome: TransferResult;
      try {
        outcome = await adapter.confirm(row.tx_hash);
      } catch {
        return { kind: "refused", reason: "the stored transaction could not be read" };
      }
      if (!(outcome.status === "failed" && outcome.failureCode === "REVERTED")) {
        return { kind: "refused", reason: "the stored transaction is not reported as reverted" };
      }
      const lookup = await lookupForRestore(adapter, orderId, "a transfer for the order could not be looked up");
      if (lookup.kind === "refused") return lookup;
      const settled = await settledForRestore(adapter, orderId, "the order could not be read on the contract");
      if (settled.kind === "refused") return settled;
      return { kind: "proved", proof: "DEFINITIVE_REVERT" };
    }

    // (iii) An unknown outcome with no hash recorded anywhere, judged by the lookup, the contract and the owner.
    if (row.hold_reason !== "SETTLEMENT_OUTCOME_UNKNOWN") {
      return { kind: "refused", reason: "the hold is not an unknown outcome" };
    }
    if (effect.external_ref !== null && effect.external_ref !== undefined) {
      return { kind: "refused", reason: "a transaction hash is recorded for the effect; reconcile it first" };
    }
    if (!acknowledgeNotSent) {
      return { kind: "refused", reason: "the owner has not acknowledged the residual risk (acknowledgeNotSent)" };
    }
    const ageMs = Date.now() - new Date(effect.updated_at).getTime();
    if (!(ageMs >= RESTORE_MIN_AGE_MS)) {
      return { kind: "refused", reason: "the effect was last updated less than 30 minutes ago" };
    }
    const lookup = await lookupForRestore(adapter, orderId, "a transfer for the order could not be looked up");
    if (lookup.kind === "refused") return lookup;
    const settled = await settledForRestore(adapter, orderId, "the order could not be read on the contract");
    if (settled.kind === "refused") return settled;
    return { kind: "proved", proof: "UNKNOWN_NOT_SETTLED_ACKNOWLEDGED" };
  }

  /**
   * Proof (iii) for a SETTLEMENT_DROPPED hold (docs/decisions/0087, item 5). The hold keeps the hash, so the hash must be the one
   * the effect recorded, and the node must still answer not found for it, now. Then the same rules as (iii): the owner's
   * acknowledgement, the dropped hold made at least 30 minutes ago (measured from the hold, not the submission), findTransfer finds
   * nothing and isOrderSettled is false. Any read that
   * throws refuses. Reads only.
   */
  private async proveDroppedRestore(
    settlementId: string,
    row: { tx_hash: string | null },
    effect: { external_ref: string | null; updated_at: Date },
    acknowledgeNotSent: boolean,
    adapter: SettlementAdapter,
    orderId: string
  ): Promise<{ kind: "proved"; proof: RestoreProof } | { kind: "refused"; reason: string }> {
    if (!row.tx_hash) return { kind: "refused", reason: "a dropped settlement has no recorded hash" };
    if (String(effect.external_ref ?? "").toLowerCase() !== row.tx_hash.toLowerCase()) {
      return { kind: "refused", reason: "the recorded hash does not match the effect" };
    }
    if (!acknowledgeNotSent) {
      return { kind: "refused", reason: "the owner has not acknowledged the residual risk (acknowledgeNotSent)" };
    }
    // The window runs from the drop, not from the submission: the latest SETTLEMENT_DROPPED hold audit row (a re-drop adds one).
    const heldFor = await query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(created_at))) * 1000 AS age_ms FROM audit_logs
       WHERE action = 'tab.settlement_held' AND evidence->>'settlementId' = $1 AND evidence->>'hold' = 'SETTLEMENT_DROPPED';`,
      [settlementId]
    );
    const heldAge = heldFor.rows[0]?.age_ms;
    if (heldAge === null || heldAge === undefined || !(Number(heldAge) >= RESTORE_MIN_AGE_MS)) {
      return { kind: "refused", reason: "the dropped hold was made less than 30 minutes ago" };
    }
    let outcome: TransferResult;
    try {
      outcome = await adapter.confirm(row.tx_hash);
    } catch {
      return { kind: "refused", reason: "the stored transaction could not be read" };
    }
    if (outcome.notFoundOnNode !== true) {
      return { kind: "refused", reason: "the node reports the stored transaction, so it is not dropped" };
    }
    const lookup = await lookupForRestore(adapter, orderId, "a transfer for the order could not be looked up");
    if (lookup.kind === "refused") return lookup;
    const settled = await settledForRestore(adapter, orderId, "the order could not be read on the contract");
    if (settled.kind === "refused") return settled;
    return { kind: "proved", proof: "DROPPED_NOT_SETTLED_ACKNOWLEDGED" };
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
          `SELECT t.id, t.workspace_id, t.counterparty_id, t.status, t.tx_hash, w.settlement_mode, w.is_demo,
                  EXTRACT(EPOCH FROM (NOW() - t.submitted_at)) * 1000 AS submitted_age_ms
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

      if (outcome.kind === "unconfirmed" && outcome.notFoundOnNode === true) {
        // The node does not know the hash (docs/decisions/0087, item 5). Dropped only when every condition of the shared rule holds.
        const ageMs = row.submitted_age_ms === null || row.submitted_age_ms === undefined ? null : Number(row.submitted_age_ms);
        const verdict = await assessDropped(adapter, {
          orderId: tabAdapterOrderId(settlementId),
          ageMs,
          afterMs: this.droppedAfterMs,
          notFoundOnNode: true,
        });
        if (verdict.kind === "dropped") {
          // Held with its hash and its clear. Never sent again; reconcileHeld may adopt it if a transfer appears.
          await this.hold(settlementId, ["submitted"], "SETTLEMENT_DROPPED", row.tx_hash, { txHash: row.tx_hash });
          return { kind: "held", hold: "SETTLEMENT_DROPPED" };
        }
        if (verdict.kind === "found" && verdict.result.status === "confirmed") {
          const found = verdict.result;
          if (found.txHash.toLowerCase() !== String(row.tx_hash).toLowerCase()) {
            const adopted = await this.writeAdoptedHash(row, found, "tab.settlement_found_transfer_adopted");
            if (!adopted) return { kind: "awaiting", txHash: row.tx_hash };
          }
          settledHash = found.txHash;
          outcome = { kind: "confirmed", timestamp: found.timestamp, blockNumber: found.blockNumber };
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
  ): Promise<
    | { kind: "confirmed"; timestamp: Date; blockNumber?: number }
    | { kind: "failed"; failureCode?: string }
    | { kind: "unconfirmed"; notFoundOnNode?: boolean }
  > {
    try {
      const result = await adapter.confirm(txHash);
      if (result.status === "confirmed") return { kind: "confirmed", timestamp: result.timestamp, blockNumber: result.blockNumber };
      if (result.status === "failed") return { kind: "failed", failureCode: result.failureCode };
      return result.notFoundOnNode === true ? { kind: "unconfirmed", notFoundOnNode: true } : { kind: "unconfirmed" };
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

    const adopted = await this.writeAdoptedHash(row, found, "tab.settlement_reverted_duplicate_adopted");
    return adopted ? found : null;
  }

  /**
   * Moves a submitted settlement's stored hash to a confirmed transfer the adapter found for its order, with the effect row's
   * external ref and one audit row, in one transaction. Guarded on `submitted` and on the hash read. Returns false when the
   * guard did not match, and writes nothing then.
   */
  private async writeAdoptedHash(row: { id: string; workspace_id: string; tx_hash: string }, found: TransferResult, action: string): Promise<boolean> {
    return withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE tab_settlements SET tx_hash = $2, updated_at = NOW() WHERE id = $1 AND status = 'submitted' AND tx_hash = $3;`,
        [row.id, found.txHash, row.tx_hash]
      );
      if (upd.rowCount !== 1) return false;
      await client.query(`UPDATE effects SET external_ref = $2, updated_at = NOW() WHERE idempotency_key = $1;`, [
        ledgerKeys.effect(row.workspace_id, row.id),
        found.txHash,
      ]);
      await writeAudit(client, row.workspace_id, SYSTEM_ACTOR, action, PolicyDecision.ALLOW, {
        settlementId: row.id,
        revertedTxHash: row.tx_hash,
        adoptedTxHash: found.txHash,
      }, found.txHash);
      return true;
    });
  }
}

/** The ledger used by the API and the worker when no adapter is injected. Tests build their own with a spy adapter. */
export const tabLedger = new TabLedger();

