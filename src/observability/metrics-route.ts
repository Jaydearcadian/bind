import { createHash, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { query } from "../db/client.js";
import { log } from "./logger.js";
import {
  approvalsOldestPendingAge,
  approvalsPending,
  effectsRetried,
  effectsUnresolved,
  ordersByStatus,
  registry,
  workerLag,
  workerLagSeconds,
  workflowsByState,
} from "./metrics.js";

/**
 * `GET /metrics` (docs/decisions/0032). Bearer token only: BIND_METRICS_TOKEN, never a workspace token.
 *
 * - No token configured: 404, as if the route did not exist.
 * - Missing or wrong token: 401 with the workspace 401 body.
 * - Otherwise the database-backed gauges are read with a few aggregate queries (cached for cacheMs, 5 seconds by default),
 *   and the registry is rendered. A database failure during the read answers 503 with no detail.
 */

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
export const DEFAULT_METRICS_CACHE_MS = 5000;

interface DatabaseSnapshot {
  workflows: Array<{ state: string; count: number }>;
  approvalsPending: number;
  oldestPendingAgeSeconds: number;
  effectsUnresolved: Array<{ status: string; count: number }>;
  effectsRetried: number;
  orders: Array<{ status: string; count: number }>;
}

async function readSnapshot(): Promise<DatabaseSnapshot> {
  const workflows = await query(`SELECT state, COUNT(*)::int AS n FROM workflows GROUP BY state;`);
  const approvals = await query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)::float8 AS oldest
     FROM approvals WHERE status = 'pending';`
  );
  const effects = await query(
    `SELECT status, COUNT(*)::int AS n FROM effects WHERE status IN ('started', 'failed') GROUP BY status;`
  );
  const retried = await query(`SELECT COUNT(*)::int AS n FROM effects WHERE attempts > 1;`);
  const orders = await query(`SELECT status, COUNT(*)::int AS n FROM orders GROUP BY status;`);
  return {
    workflows: workflows.rows.map((r) => ({ state: String(r.state), count: Number(r.n) })),
    approvalsPending: Number(approvals.rows[0]?.n ?? 0),
    oldestPendingAgeSeconds: Math.max(0, Number(approvals.rows[0]?.oldest ?? 0)),
    effectsUnresolved: effects.rows.map((r) => ({ status: String(r.status), count: Number(r.n) })),
    effectsRetried: Number(retried.rows[0]?.n ?? 0),
    orders: orders.rows.map((r) => ({ status: String(r.status), count: Number(r.n) })),
  };
}

/** Writes a snapshot into the gauges. Each family is replaced whole, so a state that emptied disappears. */
function applySnapshot(snapshot: DatabaseSnapshot): void {
  workflowsByState.replaceAll(snapshot.workflows.map((w) => ({ labels: { state: w.state }, value: w.count })));
  approvalsPending.set({}, snapshot.approvalsPending);
  approvalsOldestPendingAge.set({}, snapshot.oldestPendingAgeSeconds);
  // Both statuses are always present, so a zero is visible rather than absent.
  const unresolved = new Map(snapshot.effectsUnresolved.map((e) => [e.status, e.count]));
  effectsUnresolved.replaceAll(
    ["started", "failed"].map((status) => ({ labels: { status }, value: unresolved.get(status) ?? 0 }))
  );
  effectsRetried.set({}, snapshot.effectsRetried);
  ordersByStatus.replaceAll(snapshot.orders.map((o) => ({ labels: { status: o.status }, value: o.count })));
}

/** True when the Authorization header is `Bearer <token>` and the token equals the expected one. Constant time. */
export function bearerMatches(header: unknown, expected: string): boolean {
  if (typeof header !== "string") return false;
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match) return false;
  // Both sides are hashed to the same length first, so timingSafeEqual never sees different lengths.
  const given = createHash("sha256").update(match[1]).digest();
  const wanted = createHash("sha256").update(expected).digest();
  return timingSafeEqual(given, wanted);
}

export interface MetricsRouteOptions {
  /** The metrics token. Null or empty disables the route (404). */
  token: string | null;
  /** How long a database snapshot may be reused. */
  cacheMs?: number;
}

export function createMetricsHandler(options: MetricsRouteOptions) {
  const token = options.token && options.token.length > 0 ? options.token : null;
  const cacheMs = options.cacheMs ?? DEFAULT_METRICS_CACHE_MS;
  let cached: { at: number; snapshot: DatabaseSnapshot } | null = null;

  return async function metricsRoute(req: Request, res: Response): Promise<void> {
    if (token === null) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!bearerMatches(req.headers.authorization, token)) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    try {
      const now = Date.now();
      if (!cached || now - cached.at >= cacheMs) {
        cached = { at: now, snapshot: await readSnapshot() };
      }
      applySnapshot(cached.snapshot);
    } catch (err) {
      cached = null;
      log.error("metrics.scrape_failed", { error: err });
      res.status(503).json({ error: "Metrics unavailable" });
      return;
    }
    workerLag.set({}, workerLagSeconds());
    res.setHeader("Content-Type", METRICS_CONTENT_TYPE);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(registry.render());
  };
}
