import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";

describe("three_way_matches de-duplication migration", () => {
  const wsId = `ws-twm-migration-${Date.now()}`;
  const orderId = `ord_twm_migration_${Date.now()}`;
  const oldId = `match_old_${orderId}`;
  const newId = `match_new_${orderId}`;

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsId, "Migration Kitchen", "kitchen-v1", {
      customDailyLimitCents: 100000n,
      customApprovalThresholdCents: 25000n,
    });
    await query(
      `INSERT INTO orders (id, workspace_id, order_number, supplier_name, item_sku, item_name, quantity, unit_price_cents, total_price_cents, status, idempotency_key)
       VALUES ($1, $2, 'PO-MIG001', 'Test Supplier', 'FOOD-X', 'X', 1, 100, 100, 'confirmed', $3);`,
      [orderId, wsId, `idem_${orderId}`]
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM workspaces WHERE id = $1;`, [wsId]);
    await query(`DELETE FROM three_way_matches_archive WHERE order_id = $1;`, [orderId]);
    await closePool();
  });

  it("keeps the latest row, archives the older one first, restores the index, and is idempotent", async () => {
    await query(`DROP INDEX IF EXISTS ux_three_way_matches_order;`);
    await query(
      `INSERT INTO three_way_matches (id, order_id, match_status, variance_cents, notes, matched_at)
       VALUES ($1, $3, 'PRICE_DISCREPANCY', 100, 'older discrepancy', NOW() - INTERVAL '1 hour'),
              ($2, $3, 'MATCHED', 0, 'newer match', NOW());`,
      [oldId, newId, orderId]
    );

    await runMigrations();

    const live = await query(`SELECT id, match_status FROM three_way_matches WHERE order_id = $1;`, [orderId]);
    expect(live.rows).toEqual([{ id: newId, match_status: "MATCHED" }]);

    const archived = await query(
      `SELECT id, match_status, variance_cents, notes, archived_at FROM three_way_matches_archive WHERE order_id = $1;`,
      [orderId]
    );
    expect(archived.rows.length).toBe(1);
    expect(archived.rows[0].id).toBe(oldId);
    expect(archived.rows[0].match_status).toBe("PRICE_DISCREPANCY");
    expect(archived.rows[0].notes).toBe("older discrepancy");
    expect(archived.rows[0].archived_at).toBeInstanceOf(Date);

    const index = await query(`SELECT 1 FROM pg_indexes WHERE indexname = 'ux_three_way_matches_order';`);
    expect(index.rows.length).toBe(1);

    const archivedAt = archived.rows[0].archived_at;
    await runMigrations();
    const liveAgain = await query(`SELECT id FROM three_way_matches WHERE order_id = $1;`, [orderId]);
    const archivedAgain = await query(
      `SELECT id, archived_at FROM three_way_matches_archive WHERE order_id = $1;`,
      [orderId]
    );
    expect(liveAgain.rows).toEqual([{ id: newId }]);
    expect(archivedAgain.rows.length).toBe(1);
    expect(archivedAgain.rows[0].archived_at).toEqual(archivedAt);
  });
});
