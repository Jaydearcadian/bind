import { describe, it, expect, afterAll } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { acquireAdvisoryLock } from "../../src/db/advisory-lock.js";

/*
 * The migration lock (docs/decisions/0032). Several instances that start together must not run the schema at once.
 */

describe("migration lock", () => {
  afterAll(async () => {
    await closePool();
  });

  it("two migrations started together both finish and the schema is intact", async () => {
    await expect(Promise.all([runMigrations(), runMigrations()])).resolves.toBeDefined();

    const res = await query<{ name: string | null }>(
      `SELECT to_regclass('public.workspaces')::text AS name
       UNION ALL SELECT to_regclass('public.effects')::text
       UNION ALL SELECT to_regclass('public.workflows')::text
       UNION ALL SELECT to_regclass('public.approvals')::text;`
    );
    expect(res.rows.map((r) => r.name)).toEqual(["workspaces", "effects", "workflows", "approvals"]);
  });

  it("a migration that cannot get the lock fails with a clear error", async () => {
    const held = await acquireAdvisoryLock("migrations", 1000);
    expect(held).not.toBeNull();
    try {
      await expect(runMigrations({ lockWaitMs: 200 })).rejects.toThrow(/another process is running migrations/);
    } finally {
      await held!.release();
    }
  });
});
