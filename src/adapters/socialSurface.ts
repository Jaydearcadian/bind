import { z } from "zod";
import { query } from "../db/client.js";
import { newId } from "../utils/ids.js";
import { currentRequestId } from "../observability/request-context.js";

export const SupportedSurfaceEnum = z.enum([
  "whatsapp",
  "telegram",
  "instagram",
  "slack",
  "email",
  "email_magic_link",
  "pos_webhook",
  "web_ui",
]);

/** The largest stock count a surface may report. The inventory column is NUMERIC(12,4). */
export const MAX_OBSERVED_QUANTITY = 1_000_000;

export const SocialSurfaceEventSchema = z.discriminatedUnion("eventType", [
  // 1. Staff or POS reports a stock count from WhatsApp, Telegram, Instagram, Slack, Email, or POS
  z.object({
    eventType: z.literal("SURFACE_STOCK_OBSERVED"),
    eventId: z.string().min(4).max(120),
    workspaceId: z.string().min(1).max(64),
    surface: SupportedSurfaceEnum,
    actorId: z.string().min(2).max(120),
    actorRole: z.enum(["owner", "staff"]),
    sku: z.string().min(1).max(120),
    // Bounded to what the inventory column holds (NUMERIC(12,4)). A larger count is refused, not stored.
    observedQuantity: z.number().int().nonnegative().max(MAX_OBSERVED_QUANTITY),
    note: z.string().max(500).optional(),
  }),

  // 2. Owner approves or rejects a held request from a messaging card or magic link
  z.object({
    eventType: z.literal("SURFACE_OWNER_APPROVAL_DECISION"),
    eventId: z.string().min(4).max(120),
    workspaceId: z.string().min(1).max(64),
    surface: SupportedSurfaceEnum,
    actorId: z.string().min(2).max(120),
    actorRole: z.enum(["owner", "staff"]),
    approvalId: z.string().min(2).max(120),
    decision: z.enum(["approve", "reject"]),
    reason: z.string().max(500).optional(),
  }),

  // 3. Owner pauses or resumes autonomous agent execution remotely
  z.object({
    eventType: z.literal("SURFACE_AGENT_PAUSE_TOGGLE"),
    eventId: z.string().min(4).max(120),
    workspaceId: z.string().min(1).max(64),
    surface: SupportedSurfaceEnum,
    actorId: z.string().min(2).max(120),
    actorRole: z.enum(["owner", "staff"]),
    paused: z.boolean(),
  }),
]);

export type SocialSurfaceEvent = z.infer<typeof SocialSurfaceEventSchema>;

export const SurfaceBindingUpsertSchema = z.object({
  surface: SupportedSurfaceEnum,
  actorId: z.string().min(2).max(120),
  actorLabel: z.string().max(120).optional(),
  actorRole: z.enum(["owner", "staff"]),
  integrationStatus: z
    .enum(["simulated", "configured_unverified", "verified"])
    .default("simulated"),
});

export type SurfaceBindingUpsertInput = z.infer<typeof SurfaceBindingUpsertSchema>;

export class SurfaceAuthorizationError extends Error {
  constructor(message: string) {
    super(`[SURFACE_ROLE_VIOLATION] ${message}`);
    this.name = "SurfaceAuthorizationError";
  }
}

/**
 * Enforces Spec Section 5 & 12.1 role boundaries on inbound social/endpoint events.
 */
export function assertSurfaceRoleAuthorized(
  event: SocialSurfaceEvent,
  canonicalRoleOverride?: "owner" | "staff"
): void {
  const effectiveRole = canonicalRoleOverride || event.actorRole;

  if (
    event.eventType === "SURFACE_OWNER_APPROVAL_DECISION" &&
    effectiveRole !== "owner"
  ) {
    throw new SurfaceAuthorizationError(
      `Actor ${event.actorId} (role=${effectiveRole}) on ${event.surface} cannot approve or reject spend requests. Only 'owner' is authorized.`
    );
  }

  if (
    event.eventType === "SURFACE_AGENT_PAUSE_TOGGLE" &&
    effectiveRole !== "owner"
  ) {
    throw new SurfaceAuthorizationError(
      `Actor ${event.actorId} (role=${effectiveRole}) on ${event.surface} cannot toggle agent execution pause state.`
    );
  }
}

/**
 * Authorizes an inbound surface event against the canonical surface_bindings row for (workspace, surface, actor).
 * The role comes only from that row. The actorRole in the payload is never used for authority (ADR 0022). An actor
 * with no binding is refused for every event type, so an unknown sender cannot claim a role.
 */
export async function verifyAndAuthorizeSurfaceEvent(
  event: SocialSurfaceEvent
): Promise<{ effectiveRole: "owner" | "staff"; bindingStatus: string }> {
  const res = await query(
    `SELECT actor_role, integration_status FROM surface_bindings
     WHERE workspace_id = $1 AND surface = $2 AND actor_id = $3
     LIMIT 1;`,
    [event.workspaceId, event.surface, event.actorId]
  );

  const row = res.rows[0];
  if (!row) {
    throw new SurfaceAuthorizationError(
      `Actor ${event.actorId} on ${event.surface} has no binding in this workspace. Unbound actors cannot send events.`
    );
  }
  const effectiveRole = row.actor_role as "owner" | "staff";
  const bindingStatus: string = row.integration_status || "simulated";

  assertSurfaceRoleAuthorized(event, effectiveRole);

  return { effectiveRole, bindingStatus };
}

/** Who a binding change is recorded as: the owner token's label, passed in by the route. */
export interface SurfaceBindingActor {
  type: "owner";
  id: string;
}

export async function upsertSurfaceBinding(workspaceId: string, rawInput: unknown, actor: SurfaceBindingActor) {
  const input = SurfaceBindingUpsertSchema.parse(rawInput);
  // Never allow claiming 'verified' status unless provider verification secret is configured in env
  const safeStatus =
    input.integrationStatus === "verified" && !process.env.SURFACE_PROVIDER_VERIFIED
      ? "configured_unverified"
      : input.integrationStatus;

  const bindingId = `surf_${workspaceId}_${input.surface}_${input.actorId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const res = await query(
    `INSERT INTO surface_bindings (id, workspace_id, surface, actor_id, actor_label, actor_role, integration_status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (workspace_id, surface, actor_id) DO UPDATE SET
       actor_label = EXCLUDED.actor_label,
       actor_role = EXCLUDED.actor_role,
       integration_status = EXCLUDED.integration_status,
       updated_at = NOW()
     RETURNING *;`,
    [
      bindingId,
      workspaceId,
      input.surface,
      input.actorId,
      input.actorLabel || input.actorId,
      input.actorRole,
      safeStatus,
    ]
  );

  await query(
    `INSERT INTO audit_logs (id, workspace_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at, request_id)
     VALUES ($1, $2, $3, $4, 'commercial_commitment', 'surface.bind_identity', 'ALLOW', $5::jsonb, NOW(), $6);`,
    [
      newId("audit_surf"),
      workspaceId,
      actor.type,
      actor.id,
      JSON.stringify({
        surface: input.surface,
        actorId: input.actorId,
        actorRole: input.actorRole,
        integrationStatus: safeStatus,
      }),
      currentRequestId(),
    ]
  );

  return res.rows[0];
}

export async function listSurfaceBindings(workspaceId: string) {
  const res = await query(
    `SELECT * FROM surface_bindings WHERE workspace_id = $1 ORDER BY created_at DESC;`,
    [workspaceId]
  );
  return res.rows;
}
