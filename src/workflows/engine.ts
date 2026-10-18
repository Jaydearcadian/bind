import { query } from "../db/client.js";
import { WorkflowRecord, WorkflowState, WorkflowType, TransitionOptions } from "./types.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PolicyDecision } from "../policy/engine.js";

function safeJsonStringify(obj: any): string {
  return JSON.stringify(obj, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
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
   * Creates a new durable workflow record in DRAFT state.
   */
  async createWorkflow(
    id: string,
    workspaceId: string,
    workflowType: WorkflowType,
    idempotencyKey: string,
    initialContext: Record<string, any> = {}
  ): Promise<WorkflowRecord> {
    const res = await query(
      `INSERT INTO workflows (id, workspace_id, workflow_type, state, context_data, idempotency_key, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
       ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = NOW()
       RETURNING *;`,
      [id, workspaceId, workflowType, WorkflowState.DRAFT, safeJsonStringify(initialContext), idempotencyKey]
    );
    return this.mapRow(res.rows[0]);
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
    txHash?: string
  ): Promise<void> {
    const auditId = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    // Redact any potential private keys or sensitive tokens before logging
    const sanitizedEvidence = this.sanitizeEvidence(evidence);

    await query(
      `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, tx_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW());`,
      [
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
      ]
    );
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
   * Owner resolves an approval (approved or rejected).
   */
  async decideApproval(
    approvalId: string,
    status: "approved" | "rejected",
    decidedBy: string,
    reason?: string
  ): Promise<void> {
    await query(
      `UPDATE approvals
       SET status = $1, decided_by = $2, reason = $3, decided_at = NOW()
       WHERE id = $4 AND status = 'pending';`,
      [status, decidedBy, reason || null, approvalId]
    );
  }

  private sanitizeEvidence(obj: any): any {
    if (!obj || typeof obj !== "object") return obj;
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/secret|token|password|private_key|key/i.test(k) && typeof v === "string") {
        clean[k] = "[REDACTED]";
      } else if (typeof v === "object") {
        clean[k] = this.sanitizeEvidence(v);
      } else {
        clean[k] = v;
      }
    }
    return clean;
  }
}
