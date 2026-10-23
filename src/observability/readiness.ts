import { query } from "../db/client.js";

/**
 * Readiness for `GET /ready` (docs/decisions/0032). Ready means: `SELECT 1` answers within the budget, and the schema the
 * server needs is present. The result carries a reason for the log only; the route answers a fixed body.
 */

export const READY_BUDGET_MS = 2000;

export type ReadinessResult =
  | { ready: true }
  | { ready: false; reason: "database_unavailable" | "database_timeout" | "schema_missing"; error?: unknown };

class DeadlineExceeded extends Error {}

/** Settles with the work, or rejects with DeadlineExceeded after ms. The timer is always cleared. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded("deadline exceeded")), Math.max(1, ms));
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

export async function checkReadiness(): Promise<ReadinessResult> {
  const deadline = Date.now() + READY_BUDGET_MS;
  try {
    await withDeadline(query("SELECT 1;"), deadline - Date.now());
  } catch (err) {
    if (err instanceof DeadlineExceeded) return { ready: false, reason: "database_timeout" };
    return { ready: false, reason: "database_unavailable", error: err };
  }
  try {
    const res = await withDeadline(
      query(
        `SELECT (to_regclass('public.workspaces') IS NOT NULL AND to_regclass('public.effects') IS NOT NULL) AS schema_present;`
      ),
      deadline - Date.now()
    );
    if (res.rows[0]?.schema_present !== true) return { ready: false, reason: "schema_missing" };
  } catch (err) {
    if (err instanceof DeadlineExceeded) return { ready: false, reason: "database_timeout" };
    return { ready: false, reason: "database_unavailable", error: err };
  }
  return { ready: true };
}
