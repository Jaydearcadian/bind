import { notificationEmitter } from "../adapters/web2/notifications.js";
import type { NotificationPayload } from "../adapters/web2/types.js";
import { EffectInDoubtError, runEffect } from "../effects/ledger.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PolicyDecision } from "../policy/engine.js";
import { WorkflowEngine } from "../workflows/engine.js";

const engine = new WorkflowEngine();

/**
 * Sends the owner an approval request, at most once per approval, through the effects ledger (ADR 0017, ADR 0020).
 *
 * - Sent: { sent: true }. A repeat call for the same approval replays the stored result and does not send again.
 * - A send whose outcome is unknown (a crash after the send, before the ledger recorded it): { sent: false,
 *   reason: "in_doubt" }, with an audit row. The message is not sent again. A message cannot be unsent, so the
 *   safe default is at most once.
 * - Any other error from the emitter is rethrown. The ledger marks the row failed. A later retry is then in doubt.
 */
export async function sendApprovalNotification(input: {
  workspaceId: string;
  workflowId: string;
  approvalId: string;
  payload: NotificationPayload;
}): Promise<{ sent: boolean; reason?: "in_doubt" }> {
  const { workspaceId, workflowId, approvalId, payload } = input;
  try {
    await runEffect(
      {
        workspaceId,
        workflowId,
        effectClass: EffectClass.EXTERNAL_REQUEST,
        operation: "notifications.send_approval_request",
        // The workspace id is part of the key, so a key cannot be probed or reused across tenants.
        idempotencyKey: `${workspaceId}:notify:approval:${approvalId}`,
        request: payload,
        externalDedupes: false,
      },
      () => notificationEmitter.send(payload)
    );
    return { sent: true };
  } catch (err) {
    if (err instanceof EffectInDoubtError) {
      // Evidence holds the ids only. The message text is never written to the audit log.
      await engine.recordAudit(
        workspaceId,
        workflowId,
        "system",
        "system:notifications",
        EffectClass.EXTERNAL_REQUEST,
        "notification.in_doubt",
        PolicyDecision.ALLOW,
        { approvalId, effectId: err.effectId }
      );
      return { sent: false, reason: "in_doubt" };
    }
    throw err;
  }
}
