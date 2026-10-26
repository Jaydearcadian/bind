import { query } from "../db/client.js";
import { MICRO_PER_CENT } from "./units.js";
import { utcDayKey } from "../utils/utc-day.js";
import { tabLedger, type TabLedger } from "./ledger.js";

/**
 * The tab steps of the worker (docs/decisions/0081). Three jobs, each bounded by a batch:
 *   (a) resume settlements left `pending` by a process that died after the clear and before the send. The ledger decides
 *       each one: replay, adopt a transfer the adapter finds, or report it in doubt. Nothing is sent twice.
 *   (b) confirm settlements left `submitted`, one confirmation per settlement, after the confirmation interval.
 *   (c) settle tabs that are due: by default once per UTC day per counterparty (the end-of-day batch), or, when the
 *       settle-on-threshold option is set, every tick a tab holds at least one cent.
 *   (d) reconcile held settlements that own a clear and may have been sent (docs/decisions/0081, item a). Adoption only:
 *       the hash is found and confirmed through TabLedger.reconcileHeld. The worker never cancels or reverses.
 *
 * Nothing here calls a transfer except through TabLedger.executeSettlement, which runs the effects ledger. A paused
 * workspace is never sent to: its tabs are not picked for (c), and the ledger refuses (a) while it is paused. Step (d)
 * runs while paused, as order confirmation does (ADR 0023): it only reads and confirms, and it never pays.
 */

export interface TabWorkerOptions {
  /** The end-of-day batch (c). Default on, as the ADR sets it. */
  endOfDay?: boolean;
  /** Settles a tab as soon as it holds one cent, not once a day. Default off. */
  settleOnThreshold?: boolean;
  /** A pending settlement this old (by its last change) is resumed by (a). */
  staleAfterMs: number;
  /** A submitted settlement is confirmed by (b) once its last poll is this old. */
  confirmAfterMs: number;
  /**
   * The base backoff step of (d): a held settlement is reconciled once its last change is this old. A SETTLEMENT_FAILED hold
   * then waits 3, 12, 72 and 288 times the base for its successive attempts (see RECONCILE_STEP_FACTORS). Default 5 minutes.
   */
  reconcileAfterMs?: number;
  /** At most this many held settlements are reconciled per tick by (d). Default 5. */
  reconcileBatchSize?: number;
  batchSize: number;
  now: Date;
  ledger?: TabLedger;
}

export interface TabWorkerCounts {
  resumed: number;
  confirmed: number;
  held: number;
  cancelled: number;
  endOfDay: number;
  /** Held settlements that step (d) adopted or re-opened. */
  reconciled: number;
  failed: number;
  errors: string[];
}

const DEFAULT_RECONCILE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_RECONCILE_BATCH = 5;
/**
 * The backoff steps of a SETTLEMENT_FAILED hold, as multiples of the base step. With the default base these are 5 minutes,
 * 15 minutes, an hour, 6 hours and a day. The last step repeats. An attempt is counted on the settlement, so the next attempt
 * waits the next step: the reopen and re-hold audit rows of an attempt are written once per step, not once per tick.
 * SETTLEMENT_OUTCOME_UNKNOWN holds keep the base step. A SETTLEMENT_DROPPED hold (docs/decisions/0087, item 5) uses the same steps as
 * a failed one, so a transfer the node never knows does not write two audit rows every base step.
 */
const RECONCILE_STEP_FACTORS = [1, 3, 12, 72, 288];

export function emptyTabCounts(): TabWorkerCounts {
  return { resumed: 0, confirmed: 0, held: 0, cancelled: 0, endOfDay: 0, reconciled: 0, failed: 0, errors: [] };
}


function boundedMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.slice(0, 200);
}

export async function runTabSettlementStep(opts: TabWorkerOptions): Promise<TabWorkerCounts> {
  const ledger = opts.ledger ?? tabLedger;
  const counts = emptyTabCounts();
  const staleBefore = new Date(opts.now.getTime() - opts.staleAfterMs);
  const dueBefore = new Date(opts.now.getTime() - opts.confirmAfterMs);

  // (a) Pending settlements that were cleared but never sent, or whose send ended in an unknown outcome.
  const pending = await query(
    `SELECT id FROM tab_settlements WHERE status = 'pending' AND updated_at <= $1 ORDER BY updated_at ASC, id ASC LIMIT $2;`,
    [staleBefore, opts.batchSize]
  );
  for (const row of pending.rows) {
    try {
      const outcome = await ledger.executeSettlement(row.id);
      if (outcome.kind === "submitted") {
        counts.resumed += 1;
        const confirmed = await ledger.confirmSettlement(row.id);
        if (confirmed.kind === "confirmed") counts.confirmed += 1;
        else if (confirmed.kind === "held") counts.held += 1;
      } else if (outcome.kind === "held") counts.held += 1;
      else if (outcome.kind === "cancelled") counts.cancelled += 1;
    } catch (err) {
      counts.failed += 1;
      counts.errors.push(boundedMessage(err));
    }
  }

  // (b) Submitted settlements waiting for their confirmation.
  const submitted = await query(
    `SELECT id FROM tab_settlements WHERE status = 'submitted' AND updated_at <= $1 ORDER BY updated_at ASC, id ASC LIMIT $2;`,
    [dueBefore, opts.batchSize]
  );
  for (const row of submitted.rows) {
    try {
      const outcome = await ledger.confirmSettlement(row.id);
      if (outcome.kind === "confirmed") counts.confirmed += 1;
      else if (outcome.kind === "held") counts.held += 1;
    } catch (err) {
      counts.failed += 1;
      counts.errors.push(boundedMessage(err));
    }
  }

  // (d) Held settlements that own a clear. The ledger adopts a hash it can show and confirms it; a settlement it cannot resolve
  // stays held and is touched, so the next attempt waits its backoff. Nothing here cancels or reverses (ADR 0081).
  // SETTLEMENT_REQUEST_CONFLICT is not listed: a changed request is a person's decision, not a retry's.
  // A row is due when its last change is at least its step old. The step is the base for an UNKNOWN hold, and for a
  // SETTLEMENT_FAILED hold the step of its attempt count (capped at the last one). The steps are passed as an array.
  const base = opts.reconcileAfterMs ?? DEFAULT_RECONCILE_AFTER_MS;
  const steps = RECONCILE_STEP_FACTORS.map((factor) => base * factor);
  const heldRows = await query(
    `SELECT t.id FROM tab_settlements t
     WHERE t.status = 'held' AND t.hold_reason IN ('SETTLEMENT_OUTCOME_UNKNOWN', 'SETTLEMENT_FAILED', 'SETTLEMENT_DROPPED')
       AND t.updated_at <= $1::timestamptz - (($3::float8[])[
             CASE WHEN t.hold_reason IN ('SETTLEMENT_FAILED', 'SETTLEMENT_DROPPED') THEN LEAST(t.reconcile_attempts, cardinality($3::float8[]) - 1) ELSE 0 END + 1
           ] * INTERVAL '1 millisecond')
       AND EXISTS (SELECT 1 FROM tab_entries e WHERE e.settlement_id = t.id AND e.kind = 'clear')
     ORDER BY t.updated_at ASC, t.id ASC LIMIT $2;`,
    [opts.now, opts.reconcileBatchSize ?? DEFAULT_RECONCILE_BATCH, steps]
  );
  for (const row of heldRows.rows) {
    try {
      const outcome = await ledger.reconcileHeld(row.id);
      if (outcome.kind === "adopted") {
        counts.reconciled += 1;
        if (outcome.status === "confirmed") counts.confirmed += 1;
        else if (outcome.status === "held") {
          counts.held += 1;
          await countReconcileAttempt(row.id);
        }
      } else if (outcome.kind !== "busy" && outcome.kind !== "current") {
        // Still unresolved: the attempt is counted and the row is touched, so the next one waits the step it has reached.
        await countReconcileAttempt(row.id);
      }
    } catch (err) {
      counts.failed += 1;
      counts.errors.push(boundedMessage(err));
    }
  }

  // (c) Tabs that are due. A tab qualifies when it holds a cent, its supplier is verified with a payment address, its
  // workspace has a settlement address and is not paused. End-of-day: each tab is claimed once per UTC day, inside the reserve
  // transaction (tab_attempts). Threshold mode has no day claim. Both orders the batch by the least recently attempted tab,
  // so a tab refused every time cannot starve the rest.
  if (opts.endOfDay === false && opts.settleOnThreshold !== true) return counts;
  const dayKey = utcDayKey(opts.now);
  const endOfDay = opts.settleOnThreshold !== true;
  const due = await query(
    `SELECT s.workspace_id, s.id AS counterparty_id
     FROM suppliers s
     JOIN workspaces w ON w.id = s.workspace_id
     LEFT JOIN tab_attempts a ON a.workspace_id = s.workspace_id AND a.counterparty_id = s.id
     WHERE s.verified = TRUE AND s.payment_address IS NOT NULL
       AND w.settlement_address IS NOT NULL AND w.agents_paused = FALSE
       AND (SELECT COALESCE(SUM(CASE e.kind WHEN 'clear' THEN -e.amount_micro ELSE e.amount_micro END), 0)
            FROM tab_entries e WHERE e.workspace_id = s.workspace_id AND e.counterparty_id = s.id) >= $1
       AND ($2::boolean OR a.last_utc_day IS NULL OR a.last_utc_day < $3::date)
     ORDER BY COALESCE(a.last_attempt_at, '-infinity'::timestamptz) ASC, s.workspace_id ASC, s.id ASC
     LIMIT $4;`,
    [MICRO_PER_CENT.toString(), !endOfDay, dayKey, opts.batchSize]
  );
  for (const row of due.rows) {
    try {
      const result = await ledger.settleTab({
        workspaceId: row.workspace_id,
        counterpartyId: row.counterparty_id,
        actor: { type: "system", id: "system:tab-worker" },
        endOfDay: endOfDay ? { utcDay: dayKey } : undefined,
      });
      if (result.outcome === "settlement") {
        counts.endOfDay += 1;
        if (result.status === "held") counts.held += 1;
      }
    } catch (err) {
      counts.failed += 1;
      counts.errors.push(boundedMessage(err));
      // The attempt rolled back with the failed transaction, so it is recorded here, on its own, to rotate the batch order.
      await recordFailedAttempt(row.workspace_id, row.counterparty_id);
    }
  }
  return counts;
}

/** Counts one attempt on a held settlement that stays held, and touches it: the backoff is measured from this change. */
async function countReconcileAttempt(settlementId: string): Promise<void> {
  await query(
    `UPDATE tab_settlements SET reconcile_attempts = reconcile_attempts + 1, updated_at = NOW() WHERE id = $1 AND status = 'held';`,
    [settlementId]
  );
}

/**
 * Records that a tab was attempted and failed, outside any transaction, so the batch order moves past it (a failed reserve
 * rolls back its own attempt record). A failure here is logged by the caller's error count; it never masks that error.
 */
async function recordFailedAttempt(workspaceId: string, counterpartyId: string): Promise<void> {
  try {
    await query(
      `INSERT INTO tab_attempts (workspace_id, counterparty_id, last_attempt_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (workspace_id, counterparty_id) DO UPDATE SET last_attempt_at = NOW();`,
      [workspaceId, counterpartyId]
    );
  } catch {
    // Ignored on purpose: the failure is already counted and reported.
  }
}
