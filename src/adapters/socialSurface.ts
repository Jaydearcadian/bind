import { z } from "zod";
import { query } from "../db/client.js";

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

export const SocialSurfaceEventSchema = z.discriminatedUnion("eventType", [
  // 1. Staff or POS reports a stock count from WhatsApp, Telegram, Instagram, Slack, Email, or POS
  z.object({
    eventType: z.literal("SURFACE_STOCK_OBSERVED"),
    eventId: z.string().min(4),
    workspaceId: z.string(),
    surface: SupportedSurfaceEnum,
    actorId: z.string().min(2),
    actorRole: z.enum(["owner", "staff"]),
    sku: z.string().min(1),
    observedQuantity: z.number().int().nonnegative(),
    note: z.string().optional(),
  }),

  // 2. Owner approves or rejects a held request from a messaging card or magic link
  z.object({
    eventType: z.literal("SURFACE_OWNER_APPROVAL_DECISION"),
    eventId: z.string().min(4),
    workspaceId: z.string(),
    surface: SupportedSurfaceEnum,
    actorId: z.string().min(2),
    actorRole: z.enum(["owner", "staff"]),
    approvalId: z.string().min(2),
    decision: z.enum(["approve", "reject"]),
    reason: z.string().optional(),
  }),

  // 3. Owner pauses or resumes autonomous agent execution remotely
  z.object({
    eventType: z.literal("SURFACE_AGENT_PAUSE_TOGGLE"),
    eventId: z.string().min(4),
    workspaceId: z.string(),
    surface: SupportedSurfaceEnum,
    actorId: z.string().min(2),
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
 * Verifies inbound surface event against canonical PostgreSQL surface_bindings for the workspace.
 * If the actor is registered in surface_bindings, their database-assigned role overrides any role claimed in the payload.
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

  const registeredRole = res.rows[0]?.actor_role as "owner" | "staff" | undefined;
  const bindingStatus = res.rows[0]?.integration_status || "simulated_unregistered";
  const effectiveRole = registeredRole || event.actorRole;

  assertSurfaceRoleAuthorized(event, effectiveRole);

  return { effectiveRole, bindingStatus };
}

export async function upsertSurfaceBinding(workspaceId: string, rawInput: unknown) {
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
    `INSERT INTO audit_logs (id, workspace_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
     VALUES ($1, $2, 'owner', 'owner@bind.local', 'commercial_commitment', 'surface.bind_identity', 'ALLOW', $3::jsonb, NOW());`,
    [
      `audit_surf_${Date.now()}`,
      workspaceId,
      JSON.stringify({
        surface: input.surface,
        actorId: input.actorId,
        actorRole: input.actorRole,
        integrationStatus: safeStatus,
      }),
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
