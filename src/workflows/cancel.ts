import { query } from "../db/client.js";
import { WorkflowEngine, ApprovalDecisionError } from "./engine.js";
import { ProcurementWorkflowRunner } from "./procurement.js";
import { WorkflowState } from "./types.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PolicyDecision } from "../policy/engine.js";

/**
 * The owner cancels a workflow (ADR 0030). A cancel never touches an order, a supplier or a payment, and a pause does
 * not block it.
 *
 * - Cancellable: draft, request_sent, quote_received, awaiting_approval, authorized.
 * - awaiting_approval: the pending approval is revoked through the approval path, which cancels the workflow in the same
 *   statement. If that approval was decided meanwhile, the answer is WORKFLOW_STATE_CHANGED with the current state.
 * - Other cancellable states: one guarded transition from the state that was read. A state that moved since is refused.
 * - Already cancelled: answered unchanged, with no second audit row.
 * - Not cancellable (submitted, confirmed, reconciled, failed): WORKFLOW_NOT_CANCELLABLE with a next-action code. A
 *   submitted or confirmed workflow may already have an order with the supplier, so the owner resolves it instead.
 *
 * The reason is data: it is stored (in the approval, or in the workflow's context) and never written to the audit row
 * `workflow.cancelled`, and never echoed in an error.
 */

export const CANCEL_REASON_MAX_CHARACTERS = 200;

export interface OwnerCancelActor {
  type: "owner";
  label: string;
}

export type CancelErrorCode = "WORKFLOW_NOT_FOUND" | "WORKFLOW_NOT_CANCELLABLE" | "WORKFLOW_STATE_CHANGED";

/** A cancel that cannot be done. The API maps the code to a status and sends the state and next action, when present. */
export class WorkflowCancelError extends Error {
  readonly code: CancelErrorCode;
  readonly state?: WorkflowState;
  readonly nextAction?: string;

  constructor(code: CancelErrorCode, message: string, extra: { state?: WorkflowState; nextAction?: string } = {}) {
    super(message);
    this.name = "WorkflowCancelError";
    this.code = code;
    this.state = extra.state;
    this.nextAction = extra.nextAction;
  }
}

export interface CancelResult {
  workflowId: string;
  state: WorkflowState.CANCELLED;
  alreadyCancelled: boolean;
  approvalId?: string;
}

const CANCELLABLE = new Set<WorkflowState>([
  WorkflowState.DRAFT,
  WorkflowState.REQUEST_SENT,
  WorkflowState.QUOTE_RECEIVED,
  WorkflowState.AWAITING_APPROVAL,
  WorkflowState.AUTHORIZED,
]);

/** What the owner does next for a workflow that can no longer be cancelled by this route. */
const NEXT_ACTION: Partial<Record<WorkflowState, string>> = {
  [WorkflowState.SUBMITTED]: "RESOLVE_ORDER_WITH_SUPPLIER",
  [WorkflowState.CONFIRMED]: "RECONCILE_OR_CONTACT_SUPPLIER",
  [WorkflowState.RECONCILED]: "NONE_FINISHED",
  [WorkflowState.FAILED]: "NONE_FINISHED",
};

async function currentState(workspaceId: string, workflowId: string): Promise<WorkflowState | null> {
  const res = await query(`SELECT state FROM workflows WHERE id = $1 AND workspace_id = $2;`, [workflowId, workspaceId]);
  return res.rows.length === 0 ? null : (res.rows[0].state as WorkflowState);
}

/** A cancel refused because the state moved since it was read. The answer carries the state as it is now. */
async function stateChanged(workspaceId: string, workflowId: string): Promise<WorkflowCancelError> {
  const state = await currentState(workspaceId, workflowId);
  return new WorkflowCancelError("WORKFLOW_STATE_CHANGED", "The workflow changed while it was being cancelled. Nothing was cancelled.", {
    state: state ?? undefined,
  });
}

/**
 * Cancels one workflow of the workspace. A workflow of another workspace, or a missing one, is "not found" with the
 * same error. The owner's label is recorded as the actor.
 */
export async function cancelWorkflow(
  workspaceId: string,
  workflowId: string,
  actor: OwnerCancelActor,
  reason?: string
): Promise<CancelResult> {
  const state = await currentState(workspaceId, workflowId);
  if (state === null) {
    throw new WorkflowCancelError("WORKFLOW_NOT_FOUND", "Workflow not found");
  }
  if (state === WorkflowState.CANCELLED) {
    return { workflowId, state: WorkflowState.CANCELLED, alreadyCancelled: true };
  }
  if (!CANCELLABLE.has(state)) {
    throw new WorkflowCancelError("WORKFLOW_NOT_CANCELLABLE", `Workflow is '${state}' and cannot be cancelled.`, {
      state,
      nextAction: NEXT_ACTION[state] ?? "NONE_FINISHED",
    });
  }

  const engine = new WorkflowEngine();
  const ownerId = `owner:${actor.label}`;

  if (state === WorkflowState.AWAITING_APPROVAL) {
    const pending = await query(
      `SELECT id FROM approvals
       WHERE workspace_id = $1 AND entity_id = $2 AND status = 'pending'
       ORDER BY created_at DESC, id DESC LIMIT 1;`,
      [workspaceId, workflowId]
    );
    if (pending.rows.length > 0) {
      const approvalId: string = pending.rows[0].id;
      try {
        await new ProcurementWorkflowRunner().declineApproval(approvalId, "revoked", ownerId, workspaceId, reason);
      } catch (err) {
        // The approval was decided, or expired, between the read and the revoke. Nothing is cancelled here.
        if (err instanceof ApprovalDecisionError) throw await stateChanged(workspaceId, workflowId);
        throw err;
      }
      await recordCancelled(engine, workspaceId, workflowId, ownerId, state);
      return { workflowId, state: WorkflowState.CANCELLED, alreadyCancelled: false, approvalId };
    }
    // No pending approval is left for a workflow that waits for one. There is nothing to revoke, so the guarded
    // transition below cancels the workflow on its own.
  }

  try {
    await engine.transition(workflowId, {
      fromState: state,
      toState: WorkflowState.CANCELLED,
      patchContext: reason ? { cancelReason: reason } : undefined,
      errorMessage: "Cancelled by the owner",
    });
  } catch (err) {
    // The guard is the state that was read. If the workflow moved, it is refused; any other failure is raised.
    const now = await currentState(workspaceId, workflowId);
    if (now !== state) throw await stateChanged(workspaceId, workflowId);
    throw err;
  }
  await recordCancelled(engine, workspaceId, workflowId, ownerId, state);
  return { workflowId, state: WorkflowState.CANCELLED, alreadyCancelled: false };
}

/** The audit row for a cancel. Evidence holds the ids and the state it came from. The reason text is not written. */
async function recordCancelled(
  engine: WorkflowEngine,
  workspaceId: string,
  workflowId: string,
  ownerId: string,
  fromState: WorkflowState
): Promise<void> {
  await engine.recordAudit(
    workspaceId,
    workflowId,
    "owner",
    ownerId,
    EffectClass.READ,
    "workflow.cancelled",
    PolicyDecision.ALLOW,
    { workflowId, fromState }
  );
}
