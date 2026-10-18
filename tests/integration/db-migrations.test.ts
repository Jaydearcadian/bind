import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";

describe("Database Migrations & Tenancy (PostgreSQL)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("applies migrations idempotently without error", async () => {
    await expect(runMigrations()).resolves.not.toThrow();
  });

  it("proves all required tables exist in public schema", async () => {
    const res = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';`
    );
    const tableNames = res.rows.map((r) => r.table_name);

    const requiredTables = [
      "workspaces",
      "agent_roles",
      "inventory_items",
      "suppliers",
      "quotes",
      "orders",
      "delivery_receipts",
      "supplier_bills",
      "three_way_matches",
      "approvals",
      "workflows",
      "audit_logs",
      "idempotency_keys",
      "inbound_webhooks",
    ];

    for (const table of requiredTables) {
      expect(tableNames).toContain(table);
    }
  });

  it("enforces relational integrity and cascading deletes across workspaces", async () => {
    const testWsId = "test-ws-" + Date.now();
    await query(
      `INSERT INTO workspaces (id, name, template_id, budget_daily_limit_cents, approval_threshold_cents)
       VALUES ($1, $2, $3, $4, $5);`,
      [testWsId, "Test Kitchen Workspace", "kitchen-v1", 100000, 25000]
    );

    const testRoleId = "test-role-" + Date.now();
    await query(
      `INSERT INTO agent_roles (id, workspace_id, role_name, display_name, permitted_effects, spending_limit_cents)
       VALUES ($1, $2, $3, $4, $5, $6);`,
      [testRoleId, testWsId, "procurement_agent", "Procurement Agent", ["read", "external_request", "commercial_commitment"], 50000]
    );

    // Verify role exists
    const roleCheck = await query(`SELECT * FROM agent_roles WHERE id = $1;`, [testRoleId]);
    expect(roleCheck.rows.length).toBe(1);
    expect(roleCheck.rows[0].permitted_effects).toEqual(["read", "external_request", "commercial_commitment"]);

    // Delete workspace and verify cascade deleted role
    await query(`DELETE FROM workspaces WHERE id = $1;`, [testWsId]);
    const cascadeCheck = await query(`SELECT * FROM agent_roles WHERE id = $1;`, [testRoleId]);
    expect(cascadeCheck.rows.length).toBe(0);
  });
});
