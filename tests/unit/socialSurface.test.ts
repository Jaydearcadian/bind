import { describe, it, expect } from "vitest";
import {
  SocialSurfaceEventSchema,
  assertSurfaceRoleAuthorized,
  SurfaceAuthorizationError,
} from "../../src/adapters/socialSurface.js";

describe("Social & Business Surface Webhook Adapter", () => {
  it("validates and parses valid SURFACE_STOCK_OBSERVED from staff", () => {
    const raw = {
      eventType: "SURFACE_STOCK_OBSERVED",
      eventId: "evt_stock_01",
      workspaceId: "ws_kitchen",
      surface: "whatsapp",
      actorId: "+12125550199",
      actorRole: "staff",
      sku: "FOOD-FLOUR-50LB",
      observedQuantity: 3,
    };

    const parsed = SocialSurfaceEventSchema.parse(raw);
    expect(parsed.eventType).toBe("SURFACE_STOCK_OBSERVED");
    expect(() => assertSurfaceRoleAuthorized(parsed)).not.toThrow();
  });

  it("permits owner to execute approval decision", () => {
    const raw = {
      eventType: "SURFACE_OWNER_APPROVAL_DECISION",
      eventId: "evt_appr_01",
      workspaceId: "ws_kitchen",
      surface: "slack",
      actorId: "owner@lebistro.example.com",
      actorRole: "owner",
      approvalId: "appr_123",
      decision: "approve",
    };

    const parsed = SocialSurfaceEventSchema.parse(raw);
    expect(parsed.eventType).toBe("SURFACE_OWNER_APPROVAL_DECISION");
    expect(() => assertSurfaceRoleAuthorized(parsed)).not.toThrow();
  });

  it("strictly bars staff from approving spend requests", () => {
    const raw = {
      eventType: "SURFACE_OWNER_APPROVAL_DECISION",
      eventId: "evt_staff_rogue_appr",
      workspaceId: "ws_kitchen",
      surface: "whatsapp",
      actorId: "staff_cook_01",
      actorRole: "staff",
      approvalId: "appr_123",
      decision: "approve",
    };

    const parsed = SocialSurfaceEventSchema.parse(raw);
    expect(() => assertSurfaceRoleAuthorized(parsed)).toThrow(SurfaceAuthorizationError);
    expect(() => assertSurfaceRoleAuthorized(parsed)).toThrow(/cannot approve or reject spend requests/);
  });

  it("strictly bars staff from toggling agent execution pause state", () => {
    const raw = {
      eventType: "SURFACE_AGENT_PAUSE_TOGGLE",
      eventId: "evt_pause_01",
      workspaceId: "ws_kitchen",
      surface: "web_ui",
      actorId: "staff_cook_01",
      actorRole: "staff",
      paused: true,
    };

    const parsed = SocialSurfaceEventSchema.parse(raw);
    expect(() => assertSurfaceRoleAuthorized(parsed)).toThrow(SurfaceAuthorizationError);
    expect(() => assertSurfaceRoleAuthorized(parsed)).toThrow(/cannot toggle agent execution pause state/);
  });
});
