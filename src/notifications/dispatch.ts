import { notificationEmitter } from "../adapters/web2/notifications.js";
import type { NotificationPayload } from "../adapters/web2/types.js";
import { EffectInDoubtError, runEffect } from "../effects/ledger.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PolicyDecision } from "../policy/engine.js";
import { WorkflowEngine } from "../workflows/engine.js";

const engine = new WorkflowEngine();

/**
 * What an owner notice is about (ADR 0027). `approval` is a commitment waiting for the owner (ADR 0020, ADR 0025).
 * The three order kinds are customer orders that were held, declined or only partly covered (ADR 0026, Task 8b).
 */
export type OwnerNoticeKind = "approval" | "order_held" | "order_declined" | "order_partially_available";

/** The effect-map operation for each kind. Both are external requests, so neither commits money or stock. */
const OPERATION_FOR_KIND: Record<OwnerNoticeKind, string> = {
  approval: "notifications.send_approval_request",
  order_held: "notifications.send_summary",
  order_declined: "notifications.send_summary",
  order_partially_available: "notifications.send_summary",
};

/**
 * Sends the owner one notice, at most once per (kind, refId), through the effects ledger (ADR 0017, ADR 0020, ADR 0027).
 *
 * - Sent: { sent: true }. A repeat call for the same key replays the stored result and does not send again.
 * - A send whose outcome is unknown (a crash after the send, before the ledger recorded it): { sent: false,
 *   reason: "in_doubt" }, with audit row `notification.in_doubt`. The message is not sent again. A message cannot be
 *   unsent, so the safe default is at most once. The audit evidence holds ids only, never the message text.
 * - Any other error from the emitter is rethrown. The ledger marks the row failed. A later retry is then in doubt.
 */
export async function sendOwnerNotification(input: {
  workspaceId: string;
  workflowId?: string;
  kind: OwnerNoticeKind;
  refId: string;
  payload: NotificationPayload;
}): Promise<{ sent: boolean; reason?: "in_doubt" }> {
  const { workspaceId, workflowId, kind, refId, payload } = input;
  try {
    await runEffect(
      {
        workspaceId,
        workflowId,
        effectClass: EffectClass.EXTERNAL_REQUEST,
        operation: OPERATION_FOR_KIND[kind],
        // The workspace id is part of the key, so a key cannot be probed or reused across tenants.
        idempotencyKey: `${workspaceId}:notify:${kind}:${refId}`,
        request: payload,
        externalDedupes: false,
      },
      () => notificationEmitter.send(payload)
    );
    return { sent: true };
  } catch (err) {
    if (err instanceof EffectInDoubtError) {
      // Evidence holds the ids only. The message text is never written to the audit log.
      // An approval keeps its original evidence key (approvalId), so existing audit readers are unchanged.
      const evidence =
        kind === "approval" ? { approvalId: refId, effectId: err.effectId } : { kind, refId, effectId: err.effectId };
      await engine.recordAudit(
        workspaceId,
        workflowId ?? null,
        "system",
        "system:notifications",
        EffectClass.EXTERNAL_REQUEST,
        "notification.in_doubt",
        PolicyDecision.ALLOW,
        evidence
      );
      return { sent: false, reason: "in_doubt" };
    }
    throw err;
  }
}

/**
 * Sends the owner an approval request, at most once per approval (ADR 0020). The key stays
 * `${workspaceId}:notify:approval:${approvalId}`. Delegates to sendOwnerNotification.
 */
export async function sendApprovalNotification(input: {
  workspaceId: string;
  workflowId: string;
  approvalId: string;
  payload: NotificationPayload;
}): Promise<{ sent: boolean; reason?: "in_doubt" }> {
  const { workspaceId, workflowId, approvalId, payload } = input;
  return sendOwnerNotification({ workspaceId, workflowId, kind: "approval", refId: approvalId, payload });
}
