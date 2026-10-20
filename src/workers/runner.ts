import { query, withTransaction } from "../db/client.js";
import { acquireAdvisoryLock, type AdvisoryLock } from "../db/advisory-lock.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { WorkflowCrashRecoveryRunner } from "../workflows/recovery.js";
import { AgentsPausedError, ProcurementWorkflowRunner, type ProcurementRunnerDeps } from "../workflows/procurement.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PolicyDecision } from "../policy/engine.js";
import { redactText } from "../utils/redact.js";
import { newId } from "../utils/ids.js";
import { log } from "../observability/logger.js";
import { recordWorkerTick } from "../observability/metrics.js";

/**
 * The background worker (ADR 0029, ADR 0030). One tick runs five steps in order, each bounded by a batch size:
 *   1. approval expiry, 2. interrupted-workflow recovery, 3. settlement confirmation polling,
 *   4. recovery of orders left in `settling`, 5. the restock sweep (off unless enabled).
 * Every step first takes a non-blocking session lock named `worker:<step>`. A step whose lock is busy is skipped
 * and reported as skipped. The operations are idempotent regardless, so the locks only avoid duplicate work.
 *
 * A tick never throws. A step's error is caught, redacted, bounded, recorded in the report, and the other steps
 * still run. Nothing here sends money: the stuck-claim step never sends a transfer, confirmation only asks the
 * adapter for an outcome, and the sweep only starts replenishments, which go through the commitment gate and
 * approvals like a manual one.
 */

export type WorkerStep = "expiry" | "recovery" | "settlement_poll" | "stuck_settling" | "restock_sweep";

export interface TickError {
  step: WorkerStep;
  error: string;
}

export interface TickReport {
  expiry: { skipped: boolean; expired: number };
  recovery: { skipped: boolean; recovered: number; failed: number; inDoubt: number };
  settlementPoll: { skipped: boolean; polled: number; finished: number; pending: number; held: number; failed: number };
  stuckSettling: { skipped: boolean; toSubmitted: number; toHold: number; failed: number };
  /** `skipped` is true when the sweep did not run: it is off, or its lock was busy. */
  restockSweep: { skipped: boolean; started: number; failed: number };
  errors: TickError[];
}

export interface TickOptions {
  batchSize?: number;
  /** Anchors the settlement and stuck-claim windows. The expiry and recovery steps read the database clock. */
  now?: Date;
  deps?: ProcurementRunnerDeps;
  /** Recovery skips a workflow updated more recently than this, because a live request may still be handling it. */
  staleAfterMs?: number;
  /** A settlement is polled only once its last answer is at least this old. */
  confirmAfterMs?: number;
  /** A settlement whose transfer was sent longer ago than this is not polled here (Task 10b surfaces it). */
  maxPollAgeMs?: number;
  /** An order in `settling` this long without an update is treated as left by a dead process. */
  stuckSettlingAfterMs?: number;
  /** Runs the restock sweep (step 5). Off by default, so a bare tick does not start replenishments (ADR 0030). */
  restockSweep?: boolean;
  /** The sweep looks only at these workspaces. Unset means every workspace that is not paused. */
  restockWorkspaceIds?: string[];
  /** A sku with any workflow created this recently is not swept again (default 6 hours). */
  restockCooldownMs?: number;
}

export interface WorkerOptions extends TickOptions {
  /** Delay between the end of one tick and the start of the next. The first tick runs after one interval. */
  intervalMs?: number;
}

export interface Worker {
  /** Cancels the timer and resolves once any tick in progress has finished. No tick starts after it resolves. */
  stop(): Promise<void>;
  /** Runs a tick now, or joins the tick in progress. Rejects once the worker is stopped. */
  tickNow(): Promise<TickReport>;
}

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_STALE_AFTER_MS = 60_000;
const DEFAULT_CONFIRM_AFTER_MS = 30_000;
const DEFAULT_MAX_POLL_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STUCK_SETTLING_AFTER_MS = 10 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_RESTOCK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ERROR_LIMIT = 200;
/** The actor on the sweep's audit rows. */
const SWEEP_ACTOR = "system:restock-sweep";

const STEP_KEY: Record<WorkerStep, keyof Omit<TickReport, "errors">> = {
  expiry: "expiry",
  recovery: "recovery",
  settlement_poll: "settlementPoll",
  stuck_settling: "stuckSettling",
  restock_sweep: "restockSweep",
};

function emptyReport(): TickReport {
  return {
    expiry: { skipped: false, expired: 0 },
    recovery: { skipped: false, recovered: 0, failed: 0, inDoubt: 0 },
    settlementPoll: { skipped: false, polled: 0, finished: 0, pending: 0, held: 0, failed: 0 },
    stuckSettling: { skipped: false, toSubmitted: 0, toHold: 0, failed: 0 },
    restockSweep: { skipped: false, started: 0, failed: 0 },
    errors: [],
  };
}

/** The message as it may be reported: redacted first, then bounded. */
function boundedMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactText(raw || "unknown error").slice(0, ERROR_LIMIT);
}

function resolved(opts: TickOptions) {
  return {
    batchSize: Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH_SIZE)),
    now: opts.now ?? new Date(),
    deps: opts.deps ?? {},
    staleAfterMs: opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    confirmAfterMs: opts.confirmAfterMs ?? DEFAULT_CONFIRM_AFTER_MS,
    maxPollAgeMs: opts.maxPollAgeMs ?? DEFAULT_MAX_POLL_AGE_MS,
    stuckSettlingAfterMs: opts.stuckSettlingAfterMs ?? DEFAULT_STUCK_SETTLING_AFTER_MS,
    restockSweep: opts.restockSweep ?? false,
    restockWorkspaceIds: opts.restockWorkspaceIds,
    restockCooldownMs: opts.restockCooldownMs ?? DEFAULT_RESTOCK_COOLDOWN_MS,
  };
}

type Resolved = ReturnType<typeof resolved>;

/**
 * Runs one step under its own lock. A busy lock skips the step. A thrown error is recorded and does not escape.
 */
async function runStep(step: WorkerStep, report: TickReport, body: () => Promise<void>): Promise<void> {
  const counts = report[STEP_KEY[step]];
  let lock: AdvisoryLock | null;
  try {
    lock = await acquireAdvisoryLock(`worker:${step}`, 0);
  } catch (err) {
    report.errors.push({ step, error: boundedMessage(err) });
    return;
  }
  if (lock === null) {
    counts.skipped = true;
    return;
  }
  try {
    await body();
  } catch (err) {
    report.errors.push({ step, error: boundedMessage(err) });
  } finally {
    await lock.release();
  }
}

async function expiryStep(cfg: Resolved, report: TickReport): Promise<void> {
  report.expiry.expired = await new WorkflowEngine().expireApprovals({ limit: cfg.batchSize });
}

async function recoveryStep(cfg: Resolved, report: TickReport): Promise<void> {
  const result = await new WorkflowCrashRecoveryRunner(cfg.deps).recoverInterruptedWorkflows({
    limit: cfg.batchSize,
    staleAfterMs: cfg.staleAfterMs,
  });
  report.recovery.recovered = result.recoveredCount;
  report.recovery.failed = result.failedCount;
  // In doubt is reported, never retried: the ledger keeps the call from being repeated.
  report.recovery.inDoubt = result.inDoubt.length;
}

/**
 * Asks the adapter for the outcome of each submitted payment that is due. The transfer is joined to its ledger row
 * for the age, because every poll refreshes orders.updated_at. Confirmation pays nothing, so a paused workspace is
 * polled too (ADR 0023).
 */
async function settlementPollStep(cfg: Resolved, report: TickReport): Promise<void> {
  const dueBefore = new Date(cfg.now.getTime() - cfg.confirmAfterMs);
  const sentAfter = new Date(cfg.now.getTime() - cfg.maxPollAgeMs);
  const due = await query(
    `SELECT o.id, o.workspace_id
     FROM orders o
     JOIN effects e ON e.idempotency_key = o.workspace_id || ':settle:' || o.id
                   AND e.operation = 'settlement.transfer_usdc'
     WHERE o.status = 'settlement_submitted'
       AND o.updated_at <= $1
       AND e.created_at >= $2
     ORDER BY o.updated_at ASC, o.id ASC
     LIMIT $3;`,
    [dueBefore, sentAfter, cfg.batchSize]
  );

  const procurement = new ProcurementWorkflowRunner(cfg.deps);
  for (const row of due.rows) {
    report.settlementPoll.polled += 1;
    try {
      const result = await procurement.confirmSettlement(row.id, row.workspace_id);
      if (result.reconciled) report.settlementPoll.finished += 1;
      else if (result.pending) report.settlementPoll.pending += 1;
      else report.settlementPoll.held += 1;
    } catch (err) {
      report.settlementPoll.failed += 1;
      report.errors.push({ step: "settlement_poll", error: boundedMessage(err) });
    }
  }
}

/**
 * Settles the claim left by a process that died. With a transaction hash, the transfer was made and recorded, so the
 * order goes back to `settlement_submitted` for step 3. Without one, the transfer may or may not have gone out, so
 * the order is held as payment_hold and never paid again by the worker.
 */
async function stuckSettlingStep(cfg: Resolved, report: TickReport): Promise<void> {
  const staleBefore = new Date(cfg.now.getTime() - cfg.stuckSettlingAfterMs);
  const stuck = await query(
    `SELECT id FROM orders WHERE status = 'settling' AND updated_at <= $1 ORDER BY updated_at ASC, id ASC LIMIT $2;`,
    [staleBefore, cfg.batchSize]
  );

  for (const row of stuck.rows) {
    try {
      const outcome = await recoverStuckOrder(row.id, staleBefore);
      if (outcome === "submitted") report.stuckSettling.toSubmitted += 1;
      else if (outcome === "hold") report.stuckSettling.toHold += 1;
    } catch (err) {
      report.stuckSettling.failed += 1;
      report.errors.push({ step: "stuck_settling", error: boundedMessage(err) });
    }
  }
}

/**
 * One transaction: lock the row, re-check that it is still `settling` and still stale, move it, and audit the move.
 * A settle that is merely slow and then finishes its guarded `WHERE status = 'settling'` write finds the row moved
 * and changes nothing. Evidence holds ids and codes only.
 */
async function recoverStuckOrder(orderId: string, staleBefore: Date): Promise<"submitted" | "hold" | "skipped"> {
  return withTransaction(async (client) => {
    const locked = await client.query(
      `SELECT id, workspace_id, tx_hash FROM orders
       WHERE id = $1 AND status = 'settling' AND updated_at <= $2
       FOR UPDATE SKIP LOCKED;`,
      [orderId, staleBefore]
    );
    const row = locked.rows[0];
    if (!row) return "skipped";

    const submitted = Boolean(row.tx_hash);
    const nextStatus = submitted ? "settlement_submitted" : "payment_hold";
    const moved = await client.query(
      `UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1 AND status = 'settling' RETURNING id;`,
      [orderId, nextStatus]
    );
    if (moved.rowCount !== 1) return "skipped";

    const action = submitted ? "settlement.recovered_to_submitted" : "settlement.recovered_to_hold";
    const evidence = submitted ? { orderId } : { orderId, hold: "SETTLEMENT_OUTCOME_UNKNOWN" };
    await client.query(
      `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, tx_hash, created_at)
       VALUES ($1, $2, NULL, 'system', 'system:worker', $3, $4, $5, $6, $7, NOW());`,
      [
        newId("audit"),
        row.workspace_id,
        EffectClass.COMMERCIAL_COMMITMENT,
        action,
        submitted ? PolicyDecision.ALLOW : PolicyDecision.DENY,
        JSON.stringify(evidence),
        submitted ? row.tx_hash : null,
      ]
    );
    return submitted ? "submitted" : "hold";
  });
}

/**
 * Starts a replenishment for each low sku that is not already covered (ADR 0030). A sku is low when its available
 * quantity (on hand less active reservations, as ADR 0027) is below par. It is skipped when any workflow for it was
 * created within the cooldown, or when one is still active. Paused workspaces are not looked at. The oldest deficit
 * (the stock row unchanged the longest) comes first, and at most batchSize skus are tried per tick.
 * A failing sku is audited and counted; the others still run.
 */
async function restockSweepStep(cfg: Resolved, report: TickReport): Promise<void> {
  const cooldownStart = new Date(cfg.now.getTime() - cfg.restockCooldownMs);
  const candidates = await query(
    `WITH levels AS (
       SELECT i.workspace_id, i.sku, i.updated_at,
              i.par_level::float8 AS par,
              (i.current_quantity - COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r
                                              WHERE r.workspace_id = i.workspace_id AND r.sku = i.sku AND r.status = 'active'), 0))::float8 AS available
       FROM inventory_items i
       JOIN workspaces w ON w.id = i.workspace_id
       WHERE w.agents_paused = FALSE
         AND ($1::text[] IS NULL OR i.workspace_id = ANY($1::text[]))
     )
     SELECT l.workspace_id, l.sku, l.available
     FROM levels l
     WHERE l.available < l.par
       AND NOT EXISTS (
         SELECT 1 FROM workflows wf
         WHERE wf.workspace_id = l.workspace_id
           AND wf.context_data->>'sku' = l.sku
           AND (wf.created_at > $2 OR wf.state NOT IN ('reconciled', 'failed', 'cancelled'))
       )
     ORDER BY l.updated_at ASC, l.workspace_id ASC, l.sku ASC
     LIMIT $3;`,
    [cfg.restockWorkspaceIds ?? null, cooldownStart, cfg.batchSize]
  );

  const procurement = new ProcurementWorkflowRunner(cfg.deps);
  const engine = new WorkflowEngine();
  for (const row of candidates.rows) {
    try {
      await procurement.startReplenishment(row.workspace_id, row.sku, "worker_sweep", {
        availableQuantity: Number(row.available),
      });
      report.restockSweep.started += 1;
    } catch (err) {
      if (err instanceof AgentsPausedError) {
        // The pause was set after the candidates were read. The sweep does not retry it (ADR 0023).
        await engine.recordAudit(row.workspace_id, null, "system", SWEEP_ACTOR, EffectClass.READ, "replenishment.sweep_skipped", PolicyDecision.DENY, {
          sku: row.sku,
          reason: "AGENTS_PAUSED",
        });
      } else {
        report.restockSweep.failed += 1;
        await engine.recordAudit(row.workspace_id, null, "system", SWEEP_ACTOR, EffectClass.READ, "replenishment.sweep_failed", PolicyDecision.ALLOW, {
          sku: row.sku,
          error: boundedMessage(err),
        });
      }
    }
  }
}

/**
 * Runs one tick: the steps in order. Never throws. The restock sweep runs only when it is enabled. The tick's duration,
 * its finish time and its step errors are recorded in the metrics registry (docs/decisions/0032).
 */
export async function runTick(opts: TickOptions = {}): Promise<TickReport> {
  const startedAt = process.hrtime.bigint();
  const cfg = resolved(opts);
  const report = emptyReport();
  await runStep("expiry", report, () => expiryStep(cfg, report));
  await runStep("recovery", report, () => recoveryStep(cfg, report));
  await runStep("settlement_poll", report, () => settlementPollStep(cfg, report));
  await runStep("stuck_settling", report, () => stuckSettlingStep(cfg, report));
  if (cfg.restockSweep) {
    await runStep("restock_sweep", report, () => restockSweepStep(cfg, report));
  } else {
    report.restockSweep.skipped = true;
  }
  recordWorkerTick(
    Number(process.hrtime.bigint() - startedAt) / 1e9,
    report.errors.map((entry) => entry.step)
  );
  return report;
}

/**
 * Starts a worker that ticks on a self-rescheduling timer, so two ticks never overlap in one process. Errors in a
 * scheduled tick are logged (redacted) and the timer continues.
 */
export function startWorker(opts: WorkerOptions = {}): Worker {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const tickOpts: TickOptions = { ...opts };
  let stopped = false;
  let inFlight: Promise<TickReport> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopping: Promise<void> | null = null;

  const runOnce = (): Promise<TickReport> => {
    if (inFlight) return inFlight;
    const tick: Promise<TickReport> = runTick(tickOpts).finally(() => {
      if (inFlight === tick) inFlight = null;
    });
    inFlight = tick;
    return tick;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      runOnce()
        .then((report) => {
          for (const entry of report.errors) {
            log.warn("worker.step_failed", { step: entry.step, error: entry.error });
          }
        })
        .catch(() => undefined)
        .finally(schedule);
    }, intervalMs);
  };

  schedule();

  return {
    stop(): Promise<void> {
      if (!stopping) {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        stopping = (inFlight ?? Promise.resolve()).then(() => undefined);
      }
      return stopping;
    },
    tickNow(): Promise<TickReport> {
      if (stopped) {
        return Promise.reject(new Error("The worker is stopped. No new tick can start."));
      }
      return runOnce();
    },
  };
}
