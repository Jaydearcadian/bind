import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { simulatedPaymentAddress } from "../../src/adapters/suppliers/payment-address.js";

describe("suppliers.payment_address migration", () => {
  const wsId = `ws-payment-migration-${Date.now()}`;

  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await query(`DELETE FROM workspaces WHERE id = $1;`, [wsId]);
    await closePool();
  });

  async function columnExists(): Promise<boolean> {
    const res = await query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'suppliers' AND column_name = 'payment_address';`
    );
    return res.rows.length > 0;
  }

  it("adds the column to an existing suppliers table, keeps rows, and a second run changes nothing", async () => {
    await query(`DELETE FROM workspaces WHERE id = $1;`, [wsId]);
    await query(`INSERT INTO workspaces (id, name, template_id) VALUES ($1, 'Migration Check', 'kitchen-v1');`, [wsId]);
    const simId = `${wsId}_supp-sim`;
    const realId = `${wsId}_supp-real`;
    await query(
      `INSERT INTO suppliers (id, workspace_id, name, adapter_type, is_simulated)
       VALUES ($1, $2, 'Simulated', 'simulated_sysco', TRUE), ($3, $2, 'Real', 'manual_quote', FALSE);`,
      [simId, wsId, realId]
    );

    // Recreate the pre-change table shape, then migrate.
    await query(`ALTER TABLE suppliers DROP COLUMN IF EXISTS payment_address;`);
    expect(await columnExists()).toBe(false);

    await runMigrations();
    expect(await columnExists()).toBe(true);

    const snapshot = async () =>
      (
        await query(
          `SELECT id, name, is_simulated, payment_address FROM suppliers WHERE workspace_id = $1 ORDER BY id;`,
          [wsId]
        )
      ).rows;

    const first = await snapshot();
    expect(first.length).toBe(2);
    expect(first.find((r: any) => r.id === simId)).toMatchObject({
      name: "Simulated",
      is_simulated: true,
      payment_address: simulatedPaymentAddress(simId),
    });
    expect(first.find((r: any) => r.id === realId)).toMatchObject({
      name: "Real",
      is_simulated: false,
      payment_address: null,
    });

    await runMigrations();
    expect(await snapshot()).toEqual(first);
  });
});
