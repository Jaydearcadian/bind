import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { generateIdempotencyKey } from "../../src/utils/idempotency.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { WorkflowState } from "../../src/workflows/types.js";

const run = Date.now();
const wsId = `ws-replenish-key-${run}`;
const SKU = "FOOD-KEY-FLOUR";

describe("a replenishment key does not collide with an earlier workflow (ADR 0027, ADR 0040)", () => {
  const runner = new ProcurementWorkflowRunner();

  async function restockWorkflows(sku: string) {
    return (
      await query(
        `SELECT id, state, idempotency_key FROM workflows WHERE workspace_id = $1 AND workflow_type = 'kitchen_replenishment' AND context_data->>'sku' = $2 ORDER BY created_at ASC, id ASC;`,
        [wsId, sku]
      )
    ).rows as Array<{ id: string; state: string; idempotency_key: string }>;
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsId, "Replenish Key Kitchen", "kitchen-v1");
    await query(
      `INSERT INTO inventory_items (id, workspace_id, sku, name, category, unit, current_quantity, par_level, reorder_quantity, unit_price_cents, updated_at)
       VALUES ($1, $2, $3, 'Key Test Flour', 'Dry Goods', 'bag', 2, 10, 5, 1000, NOW());`,
      [`inv_${wsId}_${SKU}`, wsId, SKU]
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM workspaces WHERE id = $1;`, [wsId]);
    await closePool();
  });

  it("a second replenishment after a cancelled one at the same quantity starts a new workflow", async () => {
    const first = await runner.startReplenishment(wsId, SKU, "owner_manual_trigger");
    // The first workflow ends. Only a terminal workflow lets a new attempt start (the active-workflow check).
    await query(`UPDATE workflows SET state = 'cancelled', error_message = 'test: cancelled' WHERE id = $1;`, [first.workflowId]);

    const second = await runner.startReplenishment(wsId, SKU, "owner_manual_trigger");

    expect(second.workflowId).not.toBe(first.workflowId);
    const rows = await restockWorkflows(SKU);
    expect(rows.map((r) => r.id)).toEqual([first.workflowId, second.workflowId]);
    expect(rows[0].idempotency_key).not.toBe(rows[1].idempotency_key);
    expect(rows[1].state).not.toBe(WorkflowState.CANCELLED);
  });

  it("two concurrent starts for one sku produce one workflow", async () => {
    const otherSku = "FOOD-KEY-SUGAR";
    await query(
      `INSERT INTO inventory_items (id, workspace_id, sku, name, category, unit, current_quantity, par_level, reorder_quantity, unit_price_cents, updated_at)
       VALUES ($1, $2, $3, 'Key Test Sugar', 'Dry Goods', 'bag', 1, 10, 5, 1000, NOW());`,
      [`inv_${wsId}_${otherSku}`, wsId, otherSku]
    );

    const results = await Promise.all([1, 2, 3, 4].map(() => runner.startReplenishment(wsId, otherSku, "owner_manual_trigger")));

    expect(new Set(results.map((r) => r.workflowId)).size).toBe(1);
    expect(await restockWorkflows(otherSku)).toHaveLength(1);
  });

  it("a start that finds an existing workflow by key returns that workflow", async () => {
    // A workflow with the key a start would compute for this sku and quantity, written by a concurrent start that committed
    // after this start had counted the earlier workflows. Its type is not counted, so this start's round is 0, the same key.
    const plantedSku = "FOOD-KEY-RICE";
    await query(
      `INSERT INTO inventory_items (id, workspace_id, sku, name, category, unit, current_quantity, par_level, reorder_quantity, unit_price_cents, updated_at)
       VALUES ($1, $2, $3, 'Key Test Rice', 'Dry Goods', 'bag', 2, 10, 5, 1000, NOW());`,
      [`inv_${wsId}_${plantedSku}`, wsId, plantedSku]
    );
    const plantedId = `wf_planted_${run}`;
    const key = generateIdempotencyKey(wsId, "procurement.replenish", { sku: plantedSku, currentQty: 2 });
    await query(
      `INSERT INTO workflows (id, workspace_id, workflow_type, state, context_data, idempotency_key, created_at, updated_at)
       VALUES ($1, $2, 'planted_for_key_test', 'failed', $3::jsonb, $4, NOW(), NOW());`,
      [plantedId, wsId, JSON.stringify({ sku: plantedSku }), key]
    );

    const result = await runner.startReplenishment(wsId, plantedSku, "owner_manual_trigger");

    expect(result).toEqual({ workflowId: plantedId, state: WorkflowState.FAILED, orderId: undefined, approvalId: undefined });
    // No second workflow was started for this sku.
    expect(await restockWorkflows(plantedSku)).toEqual([]);
    const planted = await query(`SELECT COUNT(*)::int AS n FROM workflows WHERE idempotency_key = $1;`, [key]);
    expect(planted.rows[0].n).toBe(1);
  });
});
