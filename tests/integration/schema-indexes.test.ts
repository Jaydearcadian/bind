import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";

/** The indexes added by the cleanup round (ADR 0040). Each query is served by one of them. */
const EXPECTED: Record<string, RegExp> = {
  idx_audit_order: /ON public\.audit_logs USING btree \(\(\(evidence ->> 'orderId'::text\)\)\)/,
  idx_workflows_state_global: /ON public\.workflows USING btree \(state\)/,
  idx_orders_status: /ON public\.orders USING btree \(status\)/,
  idx_effects_status: /ON public\.effects USING btree \(status, updated_at\)/,
};

describe("the query indexes exist and the migration stays idempotent (ADR 0040)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("creates the four indexes, and a second migration run leaves them as they are", async () => {
    const first = await query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[]);`, [
      Object.keys(EXPECTED),
    ]);
    const byName = new Map(first.rows.map((row) => [row.indexname as string, row.indexdef as string]));
    expect([...byName.keys()].sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [name, pattern] of Object.entries(EXPECTED)) {
      expect(byName.get(name), name).toMatch(pattern);
    }

    await runMigrations();
    const second = await query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1::text[]);`, [
      Object.keys(EXPECTED),
    ]);
    expect(second.rows.length).toBe(first.rows.length);
  });
});
