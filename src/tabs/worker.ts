import { query } from "../db/client.js";
import { newId } from "../utils/ids.js";
import { PolicyDecision } from "../policy/engine.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { currentRequestId } from "../observability/request-context.js";
import { MICRO_PER_CENT } from "./units.js";
import { SYSTEM_ACTOR, tabLedger, type TabLedger } from "./ledger.js";

/**
 * The tab steps of the worker (docs/decisions/0081). Three jobs, each bounded by a batch:
 *   (a) resume settlements left `pending` by a process that died after the clear and before the send. The ledger decides
 *       each one: replay, adopt a transfer the adapter finds, or report it in doubt. Nothing is sent twice.
 *   (b) confirm settlements left `submitted`, one confirmation per settlement, after the confirmation interval.
 *   (c) settle tabs that are due: by default once per UTC day per counterparty (the end-of-day batch), or, when the
 *       settle-on-threshold option is set, every tick a tab holds at least one cent.
 *
 * Nothing here calls a transfer except through TabLedger.executeSettlement, which runs the effects ledger. A paused
 * workspace is never sent to: its tabs are not picked for (c), and the ledger refuses (a) while it is paused.
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
  failed: number;
  errors: string[];
}

export function emptyTabCounts(): TabWorkerCounts {
  return { resumed: 0, confirmed: 0, held: 0, cancelled: 0, endOfDay: 0, failed: 0, errors: [] };
}

/** Start of the UTC day that holds `now`. The end-of-day rule counts settlement attempts from this instant. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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

  // (c) Tabs that are due. A tab qualifies when it holds a cent, its supplier is verified with a payment address, its
  // workspace has a settlement address and is not paused. The day rule counts the attempt marker written below.
  if (opts.endOfDay === false && opts.settleOnThreshold !== true) return counts;
  const dayStart = utcDayStart(opts.now);
  const due = await query(
    `SELECT s.workspace_id, s.id AS counterparty_id
     FROM suppliers s
     JOIN workspaces w ON w.id = s.workspace_id
     WHERE s.verified = TRUE AND s.payment_address IS NOT NULL
       AND w.settlement_address IS NOT NULL AND w.agents_paused = FALSE
       AND (SELECT COALESCE(SUM(CASE e.kind WHEN 'clear' THEN -e.amount_micro ELSE e.amount_micro END), 0)
            FROM tab_entries e WHERE e.workspace_id = s.workspace_id AND e.counterparty_id = s.id) >= $1
       AND ($2::boolean OR NOT EXISTS (
             SELECT 1 FROM audit_logs a
             WHERE a.workspace_id = s.workspace_id AND a.action = 'tab.end_of_day_attempt'
               AND a.evidence->>'counterpartyId' = s.id AND a.created_at >= $3))
     ORDER BY s.workspace_id ASC, s.id ASC
     LIMIT $4;`,
    [MICRO_PER_CENT.toString(), opts.settleOnThreshold === true, dayStart, opts.batchSize]
  );
  for (const row of due.rows) {
    try {
      // One attempt marker per tab per UTC day, written before the attempt, so a retry does not settle the tab twice.
      await query(
        `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, tx_hash, created_at, request_id)
         VALUES ($1, $2, NULL, $3, $4, $5, 'tab.end_of_day_attempt', $6, $7, NULL, NOW(), $8);`,
        [
          newId("audit"),
          row.workspace_id,
          SYSTEM_ACTOR.type,
          "system:tab-worker",
          EffectClass.COMMERCIAL_COMMITMENT,
          PolicyDecision.ALLOW,
          JSON.stringify({ counterpartyId: row.counterparty_id }),
          currentRequestId(),
        ]
      );
      const result = await ledger.settleTab({
        workspaceId: row.workspace_id,
        counterpartyId: row.counterparty_id,
        actor: { type: "system", id: "system:tab-worker" },
      });
      if (result.outcome === "settlement") {
        counts.endOfDay += 1;
        if (result.status === "held") counts.held += 1;
      }
    } catch (err) {
      counts.failed += 1;
      counts.errors.push(boundedMessage(err));
    }
  }
  return counts;
}
