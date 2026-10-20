import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { runTick } from "../../src/workers/runner.js";

describe("worker: idempotency sweep (ADR 0049)", () => {
  const wsId = `ws-idem-sweep-${Date.now()}`;

  beforeAll(async () => {
    await runMigrations();
    await query(
      `INSERT INTO workspaces (id, name, template_id, budget_daily_limit_cents, approval_threshold_cents) VALUES ($1, 'Sweep', 'kitchen-v1', 100000, 50000);`,
      [wsId]
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM workspaces WHERE id = $1;`, [wsId]);
    await closePool();
  });

  it("removes outcomes older than 24 hours and keeps newer ones", async () => {
    for (const [key, age] of [["old-1", "25 hours"], ["old-2", "3 days"], ["fresh", "1 hour"]] as const) {
      await query(
        `INSERT INTO api_idempotency (workspace_id, token_id, key, operation, fingerprint, state, created_at)
         VALUES ($1, 'tok', $2, 'PUT /x', 'f', 'done', NOW() - $3::interval);`,
        [wsId, key, age]
      );
    }
    const report = await runTick({ batchSize: 5 });
    expect(report.idempotencySweep.removed).toBeGreaterThanOrEqual(2);
    const left = await query(`SELECT key FROM api_idempotency WHERE workspace_id = $1 ORDER BY key;`, [wsId]);
    expect(left.rows.map((r) => r.key)).toEqual(["fresh"]);
    expect(report.errors.filter((e) => e.step === "idempotency_sweep")).toEqual([]);
  });
});
