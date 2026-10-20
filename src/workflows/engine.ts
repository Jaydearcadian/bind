import type { PoolClient } from "pg";
import { query } from "../db/client.js";
import { WorkflowRecord, WorkflowState, WorkflowType, TransitionOptions } from "./types.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PolicyDecision } from "../policy/engine.js";
import { newId } from "../utils/ids.js";
import { redactDeep } from "../utils/redact.js";

function safeJsonStringify(obj: any): string {
  return JSON.stringify(obj, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
}

export type ApprovalDecision = "approved" | "rejected" | "revoked";

const APPROVAL_DECISION_TARGETS: Record<
  ApprovalDecision,
  { workflowState: WorkflowState; errorMessage: (reason?: string) => string | null }
> = {
  approved: { workflowState: WorkflowState.AUTHORIZED, errorMessage: () => null },
  rejected: {
    workflowState: WorkflowState.CANCELLED,
    errorMessage: (reason) => reason || "Rejected by owner",
  },
  revoked: {
    workflowState: WorkflowState.CANCELLED,
    errorMessage: (reason) => reason || "Approval revoked by owner",
  },
};

export type ApprovalErrorCode = "APPROVAL_NOT_FOUND" | "APPROVAL_NOT_PENDING" | "APPROVAL_EXPIRED" | "POLICY_DENIED";

/** Typed failure for an approval decision, mapped to HTTP status by the API layer. */
export class ApprovalDecisionError extends Error {
  readonly code: ApprovalErrorCode;
  readonly reasonCodes?: string[];

  constructor(code: ApprovalErrorCode, message: string, reasonCodes?: string[]) {
    super(message);
    this.name = "ApprovalDecisionError";
    this.code = code;
    this.reasonCodes = reasonCodes;
  }
}

export class WorkflowEngine {
  private mapRow(row: any): WorkflowRecord {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      workflowType: row.workflow_type,
      state: row.state as WorkflowState,
      contextData: typeof row.context_data === "string" ? JSON.parse(row.context_data) : (row.context_data || {}),
      errorMessage: row.error_message,
      retryCount: row.retry_count,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Creates a new durable workflow record in DRAFT state, or returns the existing one with the same idempotency key.
   * `created` says which.
   */
  async createWorkflow(
    id: string,
    workspaceId: string,
    workflowType: WorkflowType,
    idempotencyKey: string,
    initialContext: Record<string, any> = {}
  ): Promise<WorkflowRecord & { created: boolean }> {
    const res = await query(
      `INSERT INTO workflows (id, workspace_id, workflow_type, state, context_data, idempotency_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = NOW()
       RETURNING *;`,
      [id, workspaceId, workflowType, WorkflowState.DRAFT, safeJsonStringify(initialContext), idempotencyKey]
    );
    // An existing row comes back with its own id. `created` is true only when the row is the one this call inserted (ADR 0040).
    const row = res.rows[0];
    return { ...this.mapRow(row), created: row.id === id };
  }

  /**
   * Fetches a workflow by ID.
   */
  async getWorkflow(id: string): Promise<WorkflowRecord | null> {
    const res = await query(
      `SELECT * FROM workflows WHERE id = $1;`,
      [id]
    );
    return res.rows[0] ? this.mapRow(res.rows[0]) : null;
  }

  /**
   * Performs an atomic, guarded state transition in PostgreSQL.
   */
  async transition(
    workflowId: string,
    options: TransitionOptions
  ): Promise<WorkflowRecord> {
    const fromStates = Array.isArray(options.fromState) ? options.fromState : [options.fromState];
    const patch = options.patchContext ? safeJsonStringify(options.patchContext) : "{}";

    const res = await query(
      `UPDATE workflows
       SET state = $1,
           context_data = context_data || $2::jsonb,
           error_message = $3,
           updated_at = NOW()
       WHERE id = $4 AND state = ANY($5::text[])
       RETURNING *;`,
      [options.toState, patch, options.errorMessage || null, workflowId, fromStates]
    );

    if (res.rowCount === 0) {
      const current = await this.getWorkflow(workflowId);
      throw new Error(
        `Invalid state transition for workflow ${workflowId}. Expected state [${fromStates.join(", ")}], but current state is '${current?.state}'.`
      );
    }

    return this.mapRow(res.rows[0]);
  }

  /**
   * Records a deterministic, redactable audit log entry.
   */
  async recordAudit(
    workspaceId: string,
    workflowId: string | null,
    actorType: "agent" | "owner" | "system" | "webhook",
    actorId: string,
    effectClass: EffectClass,
    action: string,
    policyDecision: PolicyDecision,
    evidence: Record<string, any> = {},
    txHash?: string,
    /** When given, the row is written in that client's transaction (ADR 0040). Without it, a plain pool statement. */
    client?: PoolClient
  ): Promise<void> {
    const auditId = newId("audit");
    // Redact any potential private keys or sensitive tokens before logging
    const sanitizedEvidence = redactDeep(evidence);

    const sql = `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, tx_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW());`;
    const params = [
      auditId,
      workspaceId,
      workflowId,
      actorType,
      actorId,
      effectClass,
      action,
      policyDecision,
      safeJsonStringify(sanitizedEvidence),
      txHash || null,
    ];
    if (client) {
      await client.query(sql, params);
    } else {
      await query(sql, params);
    }
  }

  /**
   * Creates a human-in-the-loop approval item.
   */
  async createApproval(
    approvalId: string,
    workspaceId: string,
    entityType: "order" | "payout" | "config_change",
    entityId: string,
    actionRequested: string,
    amountCents: bigint,
    requesterRole: string,
    expiresInHours: number = 24
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000);
    await query(
      `INSERT INTO approvals (id, workspace_id, entity_type, entity_id, action_requested, amount_cents, requester_role, status, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, NOW())
       ON CONFLICT (id) DO NOTHING;`,
      [approvalId, workspaceId, entityType, entityId, actionRequested, amountCents, requesterRole, expiresAt]
    );
  }

  /**
   * Owner resolves a pending approval. The approval decision and the workflow
   * transition happen in one statement, so a crash cannot leave an approved
   * approval attached to a workflow that is still waiting.
   *
   * Only a pending, unexpired approval whose workflow is AWAITING_APPROVAL can
   * be resolved. Anything else throws an ApprovalDecisionError.
   */
  async resolveApproval(
    approvalId: string,
    decision: ApprovalDecision,
    decidedBy: string,
    reason?: string,
    /** When given, the decision is written in that client's transaction, so its audit row can share it (ADR 0040). */
    client?: PoolClient
  ): Promise<{ workflowId: string }> {
    const target = APPROVAL_DECISION_TARGETS[decision];
    const patch = decision === "approved" ? { approvedBy: decidedBy } : {};
    const sql = `WITH decided AS (
         UPDATE approvals
         SET status = $1, decided_by = $2, reason = $3, decided_at = NOW()
         WHERE id = $4 AND status = 'pending' AND expires_at > NOW()
         RETURNING entity_id
       )
       UPDATE workflows
       SET state = $5,
           error_message = $6,
           context_data = context_data || $7::jsonb,
           updated_at = NOW()
       WHERE id IN (SELECT entity_id FROM decided) AND state = 'awaiting_approval'
       RETURNING id;`;
    const params = [
      decision,
      decidedBy,
      reason || null,
      approvalId,
      target.workflowState,
      target.errorMessage(reason),
      safeJsonStringify(patch),
    ];
    const res = client ? await client.query(sql, params) : await query(sql, params);

    if (res.rowCount === 0) {
      await this.explainUnresolvedApproval(approvalId);
    }
    return { workflowId: res.rows[0].id };
  }

  /**
   * Marks pending approvals past their window as expired and cancels their
   * waiting workflows. Optionally limited to one workspace or one approval.
   *
   * With `limit`, at most that many approvals are taken, oldest window first, and rows another
   * transaction has locked are skipped (the background worker, ADR 0029). Without it, every match is
   * expired, as before.
   */
  async expireApprovals(filter: { workspaceId?: string; approvalId?: string; limit?: number } = {}): Promise<number> {
    const matching = `status = 'pending'
           AND expires_at <= NOW()
           AND ($1::text IS NULL OR workspace_id = $1)
           AND ($2::text IS NULL OR id = $2)`;
    const bounded = filter.limit !== undefined;
    const candidates = bounded
      ? `SELECT id FROM approvals WHERE ${matching} ORDER BY expires_at ASC, id ASC LIMIT $3::int FOR UPDATE SKIP LOCKED`
      : `SELECT id FROM approvals WHERE ${matching}`;
    const params: unknown[] = [filter.workspaceId ?? null, filter.approvalId ?? null];
    if (bounded) params.push(filter.limit);

    const res = await query(
      `WITH expired AS (
         UPDATE approvals
         SET status = 'expired', reason = 'Owner approval window elapsed', decided_at = NOW()
         WHERE id IN (${candidates})
         RETURNING entity_id
       ),
       cancelled AS (
         UPDATE workflows
         SET state = 'cancelled', error_message = 'Owner approval window elapsed', updated_at = NOW()
         WHERE id IN (SELECT entity_id FROM expired) AND state = 'awaiting_approval'
         RETURNING id
       )
       SELECT (SELECT COUNT(*) FROM expired)::int AS expired_count;`,
      params
    );
    return res.rows[0].expired_count;
  }

  /**
   * Explains why a resolve call changed nothing. Expiry is applied here so a
   * late decision always leaves the approval and workflow in a final state.
   */
  private async explainUnresolvedApproval(approvalId: string): Promise<never> {
    const row = await query(
      `SELECT status, expires_at <= NOW() AS is_past_window FROM approvals WHERE id = $1;`,
      [approvalId]
    );
    if (row.rows.length === 0) {
      throw new ApprovalDecisionError("APPROVAL_NOT_FOUND", `Approval '${approvalId}' not found.`);
    }
    const { status, is_past_window } = row.rows[0];
    if (status === "pending" && is_past_window) {
      await this.expireApprovals({ approvalId });
      throw new ApprovalDecisionError("APPROVAL_EXPIRED", `Approval '${approvalId}' has expired.`);
    }
    throw new ApprovalDecisionError(
      "APPROVAL_NOT_PENDING",
      `Approval '${approvalId}' is '${status}' and cannot be decided.`
    );
  }
}
