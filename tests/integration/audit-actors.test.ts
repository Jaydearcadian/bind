import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";

/*
 * Audit rows name the real actor (ADR 0023). A document extraction is recorded under the token that made it, its
 * role and its label. Onboarding is recorded as the system actor that created the workspace. An agent role change is
 * recorded under the owner token's label. The literal owner@bind.local is never written.
 */

const run = Date.now();
const wsA = `ws-audit-actors-${run}`;
const wsNew = `ws-audit-onboard-${run}`;
const OWNER_LABEL = `alice-audit-${run}`;
const STAFF_LABEL = `cook-audit-${run}`;
const SUPPLIER_TEXT = "Supplier: Sysco Metro Distribution\nSKU: FOOD-FLOUR-50LB\nQty: 2\nUnit Price: $24.50\nTotal: $49.00";

describe("Audit rows record the real actor, not a fixed owner literal", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  let ownerA: { id: string; token: string };
  let staffA: { id: string; token: string };

  async function call(method: string, routePath: string, opts: { token?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  }

  async function auditRows(workspaceId: string, action: string): Promise<any[]> {
    return (
      await query(
        `SELECT actor_type, actor_id, effect_class, policy_decision, evidence FROM audit_logs
         WHERE workspace_id = $1 AND action = $2 ORDER BY created_at ASC;`,
        [workspaceId, action]
      )
    ).rows;
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsA, "Audit Actors Kitchen", "kitchen-v1");
    ownerA = await issueToken(wsA, "owner", OWNER_LABEL);
    staffA = await issueToken(wsA, "staff", STAFF_LABEL);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const id of [wsA, wsNew]) {
      await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
      await fs.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    }
    await closePool();
  });

  it("document extraction is audited under the token label and role", async () => {
    const byStaff = await call("POST", `/api/workspaces/${wsA}/documents/extract`, {
      token: staffA.token,
      body: { docType: "supplier_bill", sourceLabel: "audit_actor_staff", rawText: SUPPLIER_TEXT },
    });
    expect(byStaff.status).toBe(201);
    const byOwner = await call("POST", `/api/workspaces/${wsA}/documents/extract`, {
      token: ownerA.token,
      body: { docType: "supplier_bill", sourceLabel: "audit_actor_owner", rawText: SUPPLIER_TEXT },
    });
    expect(byOwner.status).toBe(201);

    const rows = await auditRows(wsA, "document.extract_staged");
    const staffRow = rows.find((r) => r.evidence.docId === byStaff.body.docId);
    const ownerRow = rows.find((r) => r.evidence.docId === byOwner.body.docId);

    expect(staffRow).toMatchObject({ actor_type: "staff", actor_id: STAFF_LABEL, effect_class: "read", policy_decision: "ALLOW" });
    expect(ownerRow).toMatchObject({ actor_type: "owner", actor_id: OWNER_LABEL, effect_class: "read", policy_decision: "ALLOW" });
    expect(rows.filter((r) => r.actor_id === "owner@bind.local")).toHaveLength(0);
  });

  it("onboarding is audited as the workspace-create system actor", async () => {
    const created = await call("POST", "/api/workspaces/onboard", {
      body: {
        workspaceId: wsNew,
        name: "Audit Onboard Kitchen",
        businessType: "kitchen",
        budgetDailyLimitCents: 100000,
        approvalThresholdCents: 25000,
      },
    });
    expect(created.status).toBe(201);
    expect(created.body.ownerToken.token).toMatch(/^bnd_/);

    const rows = await auditRows(wsNew, "workspace.onboard_configured");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: "system", actor_id: "system:workspace-create", effect_class: "commercial_commitment" });
    expect(rows.filter((r) => r.actor_id === "owner@bind.local")).toHaveLength(0);
  });

  it("agent role changes are audited under the owner token label", async () => {
    const res = await call("POST", `/api/workspaces/${wsA}/agents`, {
      token: ownerA.token,
      body: {
        roleName: "line_cook",
        displayName: "Line Cook",
        description: "Reads stock and asks for quotes; never pays.",
        permittedEffects: ["read"],
        spendingLimitCents: 0,
        allowedTools: ["get_stock_snapshot"],
      },
    });
    expect(res.status).toBe(201);

    const rows = await auditRows(wsA, "agent_role.configure");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[rows.length - 1]).toMatchObject({ actor_type: "owner", actor_id: OWNER_LABEL, effect_class: "commercial_commitment" });
    expect(rows.filter((r) => r.actor_id === "owner@bind.local")).toHaveLength(0);
  });
});
