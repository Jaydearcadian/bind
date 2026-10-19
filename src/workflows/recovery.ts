import { query } from "../db/client.js";
import { WorkflowEngine } from "./engine.js";
import { WorkflowState } from "./types.js";
import { ProcurementWorkflowRunner, type OrderSubmissionResult, type ProcurementRunnerDeps } from "./procurement.js";
import { authorizeCommitment, describeCommitmentDecision } from "../policy/commitment-gate.js";
import { PolicyDecision } from "../policy/engine.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PROCUREMENT_ACTOR_ROLE, hasApprovedEscalation } from "../orders/reservation.js";

export interface RecoveryReport {
  recoveredCount: number;
  failedCount: number;
  /** Submissions the effects ledger reports in doubt. Not counted as recovered or failed, and never resent. */
  inDoubt: Array<{ workflowId: string; effectId: string }>;
  details: Array<{ workflowId: string; previousState: string; newState: string }>;
}

/** Order statuses that mean the supplier accepted the order (the payment lifecycle has begun or finished). */
const ORDER_ACCEPTED_STATUSES = new Set([
  "confirmed",
  "settling",
  "payment_hold",
  "settlement_submitted",
  "fulfilled",
  "reconciled",
]);

const RECOVERY_ACTOR = "system:recovery";

export class WorkflowCrashRecoveryRunner {
  private workflowEngine = new WorkflowEngine();
  private procurementRunner: ProcurementWorkflowRunner;

  constructor(deps: ProcurementRunnerDeps = {}) {
    this.procurementRunner = new ProcurementWorkflowRunner(deps);
  }

  /**
   * Scans for dangling or interrupted workflows and resumes each one through its own records. A workflow is only ever
   * resumed through the order id derived from its own id, never through another order. An error in one workflow is
   * counted as failed and does not stop the scan. With a workspaceId, only that workspace's workflows are scanned.
   */
  async recoverInterruptedWorkflows(filter: { workspaceId?: string } = {}): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      recoveredCount: 0,
      failedCount: 0,
      inDoubt: [],
      details: [],
    };

    const res = await query(
      `SELECT * FROM workflows
       WHERE state IN ('draft', 'request_sent', 'submitted', 'authorized')
         AND ($1::text IS NULL OR workspace_id = $1)
       ORDER BY created_at ASC;`,
      [filter.workspaceId ?? null]
    );

    for (const row of res.rows) {
      const workflowId = row.id;
      const state = row.state as WorkflowState;

      try {
        if (state === WorkflowState.SUBMITTED) {
          await this.recoverSubmitted(row, report);
        } else if (state === WorkflowState.AUTHORIZED) {
          await this.recoverAuthorized(row, report);
        } else if (state === WorkflowState.DRAFT || state === WorkflowState.REQUEST_SENT) {
          // Incomplete pre-commitment request; mark as failed or restartable without liability
          await this.workflowEngine.transition(workflowId, {
            fromState: state,
            toState: WorkflowState.FAILED,
            errorMessage: "Workflow interrupted before external commitment. Safely aborted during recovery.",
          });
          report.recoveredCount++;
          report.details.push({ workflowId, previousState: state, newState: WorkflowState.FAILED });
        }
      } catch {
        report.failedCount++;
      }
    }

    return report;
  }

  private async recoverSubmitted(row: any, report: RecoveryReport): Promise<void> {
    const workflowId: string = row.id;
    const orderRes = await query(`SELECT status FROM orders WHERE id = $1 AND workspace_id = $2;`, [
      `ord_${workflowId}`,
      row.workspace_id,
    ]);
    const status: string | undefined = orderRes.rows[0]?.status;

    if (status !== undefined && ORDER_ACCEPTED_STATUSES.has(status)) {
      // The supplier accepted the order and the record exists: advance to CONFIRMED.
      await this.workflowEngine.transition(workflowId, {
        fromState: WorkflowState.SUBMITTED,
        toState: WorkflowState.CONFIRMED,
        patchContext: { recoveredAt: new Date(), recoveredFrom: "submitted" },
      });
      report.recoveredCount++;
      report.details.push({ workflowId, previousState: WorkflowState.SUBMITTED, newState: WorkflowState.CONFIRMED });
      return;
    }

    if (status === "cancelled") {
      // The supplier rejected the order and the release was recorded, but the workflow was not yet failed.
      await this.workflowEngine.transition(workflowId, {
        fromState: WorkflowState.SUBMITTED,
        toState: WorkflowState.FAILED,
        errorMessage: "The supplier rejected this order. Recovered as failed.",
      });
      report.recoveredCount++;
      report.details.push({ workflowId, previousState: WorkflowState.SUBMITTED, newState: WorkflowState.FAILED });
      return;
    }

    // No order yet, or the order is still submitted: resume through the workflow's own order id.
    await this.resume(workflowId, WorkflowState.SUBMITTED, report);
  }

  private async recoverAuthorized(row: any, report: RecoveryReport): Promise<void> {
    const workflowId: string = row.id;
    const workspaceId: string = row.workspace_id;
    const proposal = row.context_data?.replenishmentProposal || row.context_data?.quote || {};

    // Authorization was granted earlier. Limits, supplier status and the quote may have changed since, so the gate
    // decides again before anything is submitted. An escalation needs an owner approval for this workflow.
    const decision = await authorizeCommitment({
      workspaceId,
      workflowId,
      actorRole: PROCUREMENT_ACTOR_ROLE,
      supplierId: String(proposal.supplierId ?? ""),
      quoteId: String(proposal.quoteId ?? ""),
      quantity: Number(proposal.quantity),
      totalPriceCents: BigInt(proposal.totalPriceCents ?? 0),
    });
    const escalationUnapproved =
      decision.decision === PolicyDecision.REQUIRE_APPROVAL && !(await hasApprovedEscalation(workspaceId, workflowId));

    if (decision.decision === PolicyDecision.DENY || escalationUnapproved) {
      const reason = describeCommitmentDecision(decision);
      await this.workflowEngine.transition(workflowId, {
        fromState: WorkflowState.AUTHORIZED,
        toState: WorkflowState.FAILED,
        errorMessage: escalationUnapproved
          ? `${reason} Owner approval is required before this order can be placed.`
          : reason,
      });
      await this.workflowEngine.recordAudit(
        workspaceId,
        workflowId,
        "system",
        RECOVERY_ACTOR,
        EffectClass.COMMERCIAL_COMMITMENT,
        "commitment.recheck",
        escalationUnapproved ? PolicyDecision.REQUIRE_APPROVAL : PolicyDecision.DENY,
        { reasonCodes: decision.reasonCodes, reason, ...decision.evidence }
      );
      report.recoveredCount++;
      report.details.push({ workflowId, previousState: WorkflowState.AUTHORIZED, newState: WorkflowState.FAILED });
      return;
    }

    await this.resume(workflowId, WorkflowState.AUTHORIZED, report);
  }

  private async resume(workflowId: string, previousState: WorkflowState, report: RecoveryReport): Promise<void> {
    const result: OrderSubmissionResult = await this.procurementRunner.resumeOrderSubmission(workflowId);
    if (result.state === WorkflowState.SUBMITTED) {
      report.inDoubt.push({ workflowId, effectId: result.effectId });
      return;
    }
    report.recoveredCount++;
    report.details.push({ workflowId, previousState, newState: result.state });
  }
}
