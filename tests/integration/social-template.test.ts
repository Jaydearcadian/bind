import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";

// The social media manager template (docs/decisions/0083): created through the public API, listed, and refused the stock routes.
const run = Date.now();
const socialId = `ws-social-${run}`;
const otherSocialId = `ws-social-other-${run}`;
const kitchenId = `ws-social-kitchen-${run}`;

describe("social-v1 workspace: provisioning, listing and stock refusals (docs/decisions/0083)", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  let socialOwnerToken = "";
  let otherOwnerToken = "";
  let kitchenOwnerToken = "";

  async function api(method: string, routePath: string, token: string | null, body?: unknown) {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", body: (await res.json()) as any };
  }

  beforeAll(async () => {
    await runMigrations();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [[socialId, otherSocialId, kitchenId]]);
    await closePool();
  });

  it("creates a social-v1 workspace through POST /api/workspaces and returns its owner token once", async () => {
    const created = await api("POST", "/api/workspaces", null, { id: socialId, name: "Social Brand", templateId: "social-v1" });
    expect(created.status).toBe(201);
    expect(created.body.template.templateId).toBe("social-v1");
    expect(created.body.ownerToken).toEqual({ id: expect.any(String), token: expect.stringMatching(/^bnd_/) });
    socialOwnerToken = created.body.ownerToken.token;

    const other = await api("POST", "/api/workspaces", null, { id: otherSocialId, name: "Other Brand", templateId: "social-v1" });
    expect(other.status).toBe(201);
    otherOwnerToken = other.body.ownerToken.token;

    const kitchen = await api("POST", "/api/workspaces", null, { id: kitchenId, name: "Control Kitchen", templateId: "kitchen-v1" });
    expect(kitchen.status).toBe(201);
    kitchenOwnerToken = kitchen.body.ownerToken.token;
  });

  it("stores no stock and no spending authority for the social workspace", async () => {
    const ws = await query("SELECT template_id, budget_daily_limit_cents, approval_threshold_cents FROM workspaces WHERE id = $1;", [socialId]);
    expect(ws.rows[0].template_id).toBe("social-v1");
    expect(BigInt(ws.rows[0].budget_daily_limit_cents)).toBe(0n);
    expect(BigInt(ws.rows[0].approval_threshold_cents)).toBe(0n);

    const roles = await query("SELECT role_name, permitted_effects, spending_limit_cents FROM agent_roles WHERE workspace_id = $1 ORDER BY role_name;", [socialId]);
    expect(roles.rows.map((r) => r.role_name)).toEqual(["analytics_agent", "content_planner_agent", "reporting_agent"]);
    for (const role of roles.rows) {
      expect(role.permitted_effects).not.toContain("commercial_commitment");
      expect(BigInt(role.spending_limit_cents)).toBe(0n);
    }

    const stock = await query("SELECT COUNT(*)::int AS n FROM inventory_items WHERE workspace_id = $1;", [socialId]);
    expect(stock.rows[0].n).toBe(0);
  });

  it("lists social-v1 with its modules and descriptive metadata, and leaves the kitchen template's behaviour in place", async () => {
    const res = await api("GET", "/api/templates", null);
    expect(res.status).toBe(200);
    const social = res.body.find((t: any) => t.templateId === "social-v1");
    const kitchen = res.body.find((t: any) => t.templateId === "kitchen-v1");
    expect(social).toBeDefined();
    expect(social.name).toBe("Social media manager");
    expect(social.modules).toEqual({ stock: false, suppliers: false });
    expect(social.dataSources).toEqual([
      { id: "instagram_insights", label: "Instagram post insights", kind: "instagram_insights", readOnly: true },
    ]);
    expect(social.outputs).toEqual([expect.objectContaining({ id: "weekly_report", kind: "report" })]);
    expect(kitchen.modules).toEqual({ stock: true, suppliers: true });
    expect(kitchen.roles.map((r: any) => r.roleName)).toEqual([
      "procurement_agent",
      "fulfilment_agent",
      "menu_feedback_agent",
    ]);
  });

  it("refuses a replenishment for the social workspace with 400, the repo's error body, and starts no workflow", async () => {
    const res = await api("POST", `/api/workspaces/${socialId}/replenish`, socialOwnerToken, { sku: "FOOD-FLOUR-50LB" });
    expect(res.status).toBe(400);
    expect(res.contentType).toMatch(/application\/json/);
    // The repo's error body (error-contract v2): the message and the typed code, plus its category.
    expect(res.body.error).toBe("This workspace's template has no stock module.");
    expect(res.body.code).toBe("TEMPLATE_HAS_NO_STOCK");
    expect(typeof res.body.category).toBe("string");

    const wf = await query("SELECT COUNT(*)::int AS n FROM workflows WHERE workspace_id = $1;", [socialId]);
    expect(wf.rows[0].n).toBe(0);
  });

  it("refuses a stock write for the social workspace with 400 and writes no inventory row", async () => {
    const res = await api("POST", `/api/workspaces/${socialId}/inventory`, socialOwnerToken, {
      sku: "SOCIAL-STOCK-TEST",
      name: "Should not be stored",
      currentQuantity: 4,
      parLevel: 2,
      reorderQuantity: 3,
      unitPriceCents: 150,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("This workspace's template has no stock module.");
    expect(res.body.code).toBe("TEMPLATE_HAS_NO_STOCK");

    const rows = await query("SELECT COUNT(*)::int AS n FROM inventory_items WHERE workspace_id = $1;", [socialId]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("answers the stock read with an empty list, not an error", async () => {
    const res = await api("GET", `/api/workspaces/${socialId}/inventory`, socialOwnerToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("does not let another social workspace's owner refuse or read this one (tenancy)", async () => {
    const res = await api("POST", `/api/workspaces/${socialId}/replenish`, otherOwnerToken, { sku: "X" });
    expect([401, 403, 404]).toContain(res.status);
    expect(res.body.code).not.toBe("TEMPLATE_HAS_NO_STOCK");
  });

  it("keeps the kitchen replenishment path unchanged: an unknown sku is refused without the stock code", async () => {
    const res = await api("POST", `/api/workspaces/${kitchenId}/replenish`, kitchenOwnerToken, { sku: "NO-SUCH-SKU" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/);
    expect(res.body.code).not.toBe("TEMPLATE_HAS_NO_STOCK");
  });

  it("keeps the kitchen stock write working", async () => {
    const res = await api("POST", `/api/workspaces/${kitchenId}/inventory`, kitchenOwnerToken, {
      sku: "FOOD-CONTROL-SAMPLE",
      name: "Control Sample",
      currentQuantity: 4,
      parLevel: 2,
      reorderQuantity: 3,
      unitPriceCents: 150,
    });
    expect(res.status).toBe(201);
    expect(res.body.sku).toBe("FOOD-CONTROL-SAMPLE");
  });

  it("a social workspace provisioned directly from the template gets the same refusal", async () => {
    const directId = `ws-social-direct-${run}`;
    await provisionWorkspace(directId, "Direct Social", "social-v1");
    try {
      const token = (await issueToken(directId, "owner", "direct-owner")).token;
      const res = await api("POST", `/api/workspaces/${directId}/replenish`, token, { sku: "ANY-SKU" });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("TEMPLATE_HAS_NO_STOCK");
    } finally {
      await query("DELETE FROM workspaces WHERE id = $1;", [directId]);
    }
  });
});
