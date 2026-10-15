import { z } from "zod";

export const SocialSurfaceEventSchema = z.discriminatedUnion("eventType", [
  // 1. Staff or POS reports a stock count from WhatsApp, Slack, or Square/Toast POS
  z.object({
    eventType: z.literal("SURFACE_STOCK_OBSERVED"),
    eventId: z.string().min(4),
    workspaceId: z.string(),
    surface: z.enum(["whatsapp", "slack", "pos_webhook", "email", "web_ui"]),
    actorId: z.string(),
    actorRole: z.enum(["owner", "staff"]),
    sku: z.string(),
    observedQuantity: z.number().int().nonnegative(),
  }),

  // 2. Owner approves or rejects a held request from a WhatsApp/Slack interactive card or magic link
  z.object({
    eventType: z.literal("SURFACE_OWNER_APPROVAL_DECISION"),
    eventId: z.string().min(4),
    workspaceId: z.string(),
    surface: z.enum(["whatsapp", "slack", "email_magic_link", "web_ui"]),
    actorId: z.string(),
    actorRole: z.enum(["owner", "staff"]),
    approvalId: z.string(),
    decision: z.enum(["approve", "reject"]),
    reason: z.string().optional(),
  }),

  // 3. Owner pauses or resumes autonomous agent execution remotely
  z.object({
    eventType: z.literal("SURFACE_AGENT_PAUSE_TOGGLE"),
    eventId: z.string().min(4),
    workspaceId: z.string(),
    surface: z.enum(["whatsapp", "slack", "web_ui"]),
    actorId: z.string(),
    actorRole: z.enum(["owner", "staff"]),
    paused: z.boolean(),
  }),
]);

export type SocialSurfaceEvent = z.infer<typeof SocialSurfaceEventSchema>;

export class SurfaceAuthorizationError extends Error {
  constructor(message: string) {
    super(`[SURFACE_ROLE_VIOLATION] ${message}`);
    this.name = "SurfaceAuthorizationError";
  }
}

/**
 * Enforces Spec Section 5 & 12.1 role boundaries on inbound social/endpoint events.
 */
export function assertSurfaceRoleAuthorized(event: SocialSurfaceEvent): void {
  if (
    event.eventType === "SURFACE_OWNER_APPROVAL_DECISION" &&
    event.actorRole !== "owner"
  ) {
    throw new SurfaceAuthorizationError(
      `Actor ${event.actorId} (role=${event.actorRole}) on ${event.surface} cannot approve or reject spend requests. Only 'owner' is authorized.`
    );
  }

  if (
    event.eventType === "SURFACE_AGENT_PAUSE_TOGGLE" &&
    event.actorRole !== "owner"
  ) {
    throw new SurfaceAuthorizationError(
      `Actor ${event.actorId} (role=${event.actorRole}) on ${event.surface} cannot toggle agent execution pause state.`
    );
  }
}
