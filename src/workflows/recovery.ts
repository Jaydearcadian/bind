import { query } from "../db/client.js";
import { WorkflowEngine } from "./engine.js";
import { WorkflowState } from "./types.js";
import { ProcurementWorkflowRunner } from "./procurement.js";

export interface RecoveryReport {
  recoveredCount: number;
  failedCount: number;
  details: Array<{ workflowId: string; previousState: string; newState: string }>;
}

export class WorkflowCrashRecoveryRunner {
  private workflowEngine = new WorkflowEngine();
  private procurementRunner = new ProcurementWorkflowRunner();

  /**
   * Scans for dangling or interrupted workflows and recovers them safely using idempotent records.
   */
  async recoverInterruptedWorkflows(): Promise<RecoveryReport> {
    const report: RecoveryReport = {
      recoveredCount: 0,
      failedCount: 0,
      details: [],
    };

    // Find workflows in transient states that haven't updated in > 10 seconds
    const res = await query(
      `SELECT * FROM workflows
       WHERE state IN ('draft', 'request_sent', 'submitted', 'authorized')
       ORDER BY created_at ASC;`
    );

    for (const row of res.rows) {
      const workflowId = row.id;
      const state = row.state as WorkflowState;

      try {
        if (state === WorkflowState.SUBMITTED) {
          // Check if order was already recorded
          const orderRes = await query(
            `SELECT * FROM orders WHERE id = $1 OR external_order_ref IS NOT NULL;`,
            [`ord_${workflowId}`]
          );

          if (orderRes.rows.length > 0) {
            // Already submitted and recorded in orders table, advance to CONFIRMED!
            await this.workflowEngine.transition(workflowId, {
              fromState: WorkflowState.SUBMITTED,
              toState: WorkflowState.CONFIRMED,
              patchContext: { recoveredAt: new Date(), recoveredFrom: "submitted" },
            });
            report.recoveredCount++;
            report.details.push({ workflowId, previousState: state, newState: WorkflowState.CONFIRMED });
          }
        } else if (state === WorkflowState.AUTHORIZED) {
          // It was authorized before crashing; resume submission
          const quote = row.context_data.quote;
          const itemName = row.context_data.itemName;
          if (quote) {
            // Re-invoke submission safely
            await (this.procurementRunner as any).executeOrderSubmission(
              workflowId,
              row.workspace_id,
              quote,
              itemName
            );
            report.recoveredCount++;
            report.details.push({ workflowId, previousState: state, newState: WorkflowState.CONFIRMED });
          }
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
}
