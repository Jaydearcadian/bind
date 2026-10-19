import pg from "pg";
import { config } from "../config/env.js";

/**
 * A PostgreSQL session advisory lock on a key, held on a dedicated connection until released.
 *
 * The connection is not taken from the shared pool, so a lock held for a long external call cannot starve it.
 * Waiters poll with short-lived connections and never hold one while they sleep. Ending the session drops the
 * lock, so a crashed process frees it. Used by the effects ledger (per idempotency key) and by the order
 * reservation (per workspace spend).
 */

export interface AdvisoryLock {
  release(): Promise<void>;
}

const DEFAULT_WAIT_MS = 5_000;
const TRY_LOCK_SQL = `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired;`;
const UNLOCK_SQL = `SELECT pg_advisory_unlock(hashtextextended($1, 0));`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Returns the lock, or null if it is still held after waitMs. */
export async function acquireAdvisoryLock(key: string, waitMs: number = DEFAULT_WAIT_MS): Promise<AdvisoryLock | null> {
  const deadline = Date.now() + waitMs;
  let delay = 2;
  for (;;) {
    const client = new pg.Client({ connectionString: config.DATABASE_URL });
    await client.connect();
    let acquired = false;
    try {
      const res = await client.query(TRY_LOCK_SQL, [key]);
      acquired = res.rows[0]?.acquired === true;
    } catch (err) {
      await client.end().catch(() => undefined);
      throw err;
    }
    if (acquired) {
      return {
        release: async () => {
          await client.query(UNLOCK_SQL, [key]).catch(() => undefined);
          // Ending the session also drops the lock if the unlock did not reach the server.
          await client.end().catch(() => undefined);
        },
      };
    }
    await client.end().catch(() => undefined);
    if (Date.now() >= deadline) return null;
    await sleep(delay);
    delay = Math.min(delay * 2, 50);
  }
}
