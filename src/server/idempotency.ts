import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { query } from "../db/client.js";
import { log } from "../observability/logger.js";

/**
 * Client idempotency keys on the API boundary (ADR 0049, docs/ecosystem/RESPONSE_AND_EVENT_SPEC.md section 2).
 * A retry of a command after a timeout returns the first outcome instead of running it again. Scope is
 * (workspace, token, key). The effects ledger still makes external effects at-most-once; this protects the request.
 *
 * Runs after authentication and role checks, so an unauthorized caller never touches the table.
 */

/** Express route patterns of the operations that take a key: the economic or irreversible writes of the public API. */
export const IDEMPOTENT_ROUTES: ReadonlySet<string> = new Set([
  "POST /api/workspaces/:id/customer-orders/:orderId/accept",
  "POST /api/approvals/:id/approve",
  "POST /api/workspaces/:id/customer-orders/:orderId/cancel",
  "POST /api/workspaces/:id/workflows/:workflowId/cancel",
  "POST /api/workspaces/:id/documents/:docId/confirm",
  "POST /api/workspaces/:id/customer-orders",
  "POST /api/workspaces/:id/customer-orders/:orderId/fulfil",
  "POST /api/workspaces/:id/menu-proposals/:proposalId/publish",
  "POST /api/approvals/:id/reject",
  "POST /api/workspaces/:id/replenish",
  "POST /api/approvals/:id/revoke",
  "DELETE /api/workspaces/:id/connectors/:connectorId",
  "DELETE /api/workspaces/:id/tokens/:tokenId",
  "POST /api/workspaces/:id/webhook-secret/rotate",
  "PUT /api/workspaces/:id/agents-paused",
  "PUT /api/workspaces/:id/policy",
  "POST /api/workspaces/:id/agents",
  "POST /api/workspaces/:id/suppliers",
  // A sync writes the account's posts and an audit row, so a retried request replays its first answer (docs/decisions/0090).
  "POST /api/workspaces/:id/analytics/accounts/:accountId/sync",
  // Tab ledger (ADR 0081): a charge is an obligation and a settle moves money, so a retried request replays its answer.
  "POST /api/workspaces/:id/tabs/charges",
  "POST /api/workspaces/:id/tabs/:counterpartyId/settle",
  // A resolve may send nothing (reconcile adopts and confirms only) or may restore a clear (cancel_and_restore): a retried request replays.
  "POST /api/workspaces/:id/tabs/settlements/:settlementId/resolve",
]);

/**
 * Fields that are never stored. A secret the API returns once must not sit in the database for a day: the webhook secret is
 * derived, so nothing else stores it. A replay returns the rest of the answer with `secretOmitted: true`; the owner reads the
 * current secret from the secret route.
 */
const SECRET_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "POST /api/workspaces/:id/webhook-secret/rotate": ["secret"],
};

function withoutSecrets(operation: string, body: unknown): unknown {
  const fields = SECRET_FIELDS[operation];
  if (!fields || body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const copy: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  let removed = false;
  for (const f of fields) if (f in copy) { delete copy[f]; removed = true; }
  if (removed) copy.secretOmitted = true;
  return copy;
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
/** A stored outcome is replayed for this long. */
export const RETENTION_HOURS = 24;
/** A first request that never finished (a crash) releases its key after this long. */
const STALE_LOCK_SECONDS = 300;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)])
    );
  }
  return value;
}

export function fingerprintOf(method: string, path: string, body: unknown): string {
  return createHash("sha256").update(JSON.stringify([method, path, canonical(body ?? null)])).digest("hex");
}

/** Outcomes a retry would repeat are stored; throttling and server failures are not. */
function isStorable(status: number): boolean {
  if (status >= 200 && status < 300) return true;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export async function idempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
  const operation = `${req.method} ${req.route?.path ?? ""}`;
  const header = req.headers["idempotency-key"];
  if (!IDEMPOTENT_ROUTES.has(operation) || header === undefined || !req.actor) {
    next();
    return;
  }
  const key = Array.isArray(header) ? "" : header;
  if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
    res.status(400).json({
      error: "Idempotency-Key must be 1 to 128 characters from A-Z a-z 0-9 . _ : -",
      code: "IDEMPOTENCY_KEY_INVALID",
    });
    return;
  }

  const { workspaceId, tokenId } = req.actor;
  const fingerprint = fingerprintOf(req.method, req.path, req.body);
  try {
    let claimed = await claim(workspaceId, tokenId, key, operation, fingerprint);
    if (!claimed) {
      const row = (
        await query<{ fingerprint: string; state: string; status_code: number | null; response_body: unknown; age: number }>(
          `SELECT fingerprint, state, status_code, response_body,
                  EXTRACT(EPOCH FROM (NOW() - created_at))::int AS age
             FROM api_idempotency WHERE workspace_id = $1 AND token_id = $2 AND key = $3;`,
          [workspaceId, tokenId, key]
        )
      ).rows[0];
      if (row && row.age >= RETENTION_HOURS * 3600) {
        await query(`DELETE FROM api_idempotency WHERE workspace_id = $1 AND token_id = $2 AND key = $3;`, [workspaceId, tokenId, key]);
        claimed = await claim(workspaceId, tokenId, key, operation, fingerprint);
      } else if (row) {
        if (row.fingerprint !== fingerprint) {
          res.status(422).json({ error: "This Idempotency-Key was already used for a different request", code: "IDEMPOTENCY_KEY_REUSED" });
          return;
        }
        if (row.state === "done" && row.status_code !== null) {
          res.setHeader("Idempotent-Replayed", "true");
          res.status(row.status_code).json(row.response_body);
          return;
        }
        // In progress. A lock older than the stale limit belongs to a request that never finished: take it over.
        const taken = await query(
          `UPDATE api_idempotency SET locked_at = NOW()
            WHERE workspace_id = $1 AND token_id = $2 AND key = $3 AND state = 'in_progress'
              AND locked_at < NOW() - make_interval(secs => $4);`,
          [workspaceId, tokenId, key, STALE_LOCK_SECONDS]
        );
        if (taken.rowCount === 1) {
          claimed = true;
        } else {
          res.setHeader("Retry-After", "1");
          res.status(409).json({ error: "The first request with this Idempotency-Key has not finished", code: "IDEMPOTENCY_IN_PROGRESS" });
          return;
        }
      }
    }
    if (!claimed) {
      // The row vanished between the insert and the read (swept): run the request without a key rather than fail.
      next();
      return;
    }
  } catch (err) {
    log.error("idempotency.unavailable", { requestId: req.id, error: err instanceof Error ? err.message : String(err) });
    res.status(503).json({ error: "Idempotency store unavailable" });
    return;
  }

  // Record the outcome the moment the handler produces it; release the key when a retry should run again.
  const send = res.json.bind(res);
  let settled = false;
  res.json = ((body: unknown) => {
    if (!settled) {
      settled = true;
      const status = res.statusCode;
      const save = isStorable(status)
        ? query(
            `UPDATE api_idempotency SET state = 'done', status_code = $4, response_body = $5::jsonb
              WHERE workspace_id = $1 AND token_id = $2 AND key = $3;`,
            [workspaceId, tokenId, key, status, JSON.stringify(withoutSecrets(operation, body) ?? null)]
          )
        : query(`DELETE FROM api_idempotency WHERE workspace_id = $1 AND token_id = $2 AND key = $3;`, [workspaceId, tokenId, key]);
      // Send only after the outcome is stored, so a client that retries at once finds it.
      save
        .catch((err) => log.error("idempotency.record_failed", { requestId: req.id, error: err instanceof Error ? err.message : String(err) }))
        .finally(() => send(body));
      return res;
    }
    return send(body);
  }) as Response["json"];
  next();
}

async function claim(workspaceId: string, tokenId: string, key: string, operation: string, fingerprint: string): Promise<boolean> {
  const inserted = await query(
    `INSERT INTO api_idempotency (workspace_id, token_id, key, operation, fingerprint, state)
     VALUES ($1, $2, $3, $4, $5, 'in_progress')
     ON CONFLICT DO NOTHING;`,
    [workspaceId, tokenId, key, operation, fingerprint]
  );
  return inserted.rowCount === 1;
}
