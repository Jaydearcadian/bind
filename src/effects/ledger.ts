import crypto from "crypto";
import pg from "pg";
import { query } from "../db/client.js";
import { config } from "../config/env.js";
import { redactSecrets } from "../adapters/settlement/errors.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { encodeResult, decodeResult, requestHash } from "./serialize.js";
import { takeEffectFault } from "./faults.js";

/**
 * Durable ledger for external effects (supplier quote and order, settlement transfer, owner notification).
 *
 * Guarantees, per idempotency key:
 * - A non-dedupe effect (externalDedupes not set) runs fn at most once. A row that is `started` or `failed`
 *   is a call that may or may not have reached the outside world. It is reported as EffectInDoubtError and
 *   is repeated only when opts.reconcile proves it did not happen.
 * - An externalDedupes effect may run again after a failure, because the external system dedupes on the key.
 * - Callers for one key are serialized by a PostgreSQL session advisory lock, held on a dedicated connection
 *   for the whole call. A recovery caller cannot reconcile a call that another caller is still making, so
 *   reconcile never races a live attempt (also across processes). The lock is released when the connection
 *   closes, so a crashed process frees it and leaves the row in doubt.
 * - Each row stores the hash of the request, never the request. The same key with a different request, or
 *   from another workspace, is refused with EffectConflictError.
 *
 * Not guaranteed: the ledger does not make an unknown outcome known. It records it, reports it, and waits for
 * reconcile or an operator. See docs/decisions/0017-effects-ledger.md.
 */

export interface EffectSpec {
  workspaceId: string;
  workflowId?: string;
  effectClass: EffectClass;
  operation: string;
  idempotencyKey: string;
  request: unknown;
  /** The external system dedupes on idempotencyKey, so repeating the call after a crash is safe. */
  externalDedupes?: boolean;
}

export interface EffectOptions<T> {
  /** Ask the external system whether the effect already happened. Return { found: true, result } to adopt it. */
  reconcile?: () => Promise<{ found: true; result: T; externalRef?: string } | { found: false }>;
  externalRef?: (result: T) => string | undefined;
}

export type EffectStatus = "started" | "completed" | "failed";

export interface EffectRow {
  id: string;
  workspaceId: string;
  workflowId: string | null;
  effectClass: EffectClass;
  operation: string;
  idempotencyKey: string;
  requestHash: string;
  status: EffectStatus;
  errorMessage: string | null;
  externalRef: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

const CONFLICT_MESSAGE = "The idempotency key is already in use and cannot be reused for this request.";
const ERROR_MESSAGE_LIMIT = 500;
/** How long a caller waits for another caller's in-flight call on the same key before reporting it in doubt. */
const LOCK_WAIT_MS = 5_000;

/** Same key, different request, or a key owned by another workspace. The message never names the other workspace. */
export class EffectConflictError extends Error {
  constructor(message: string = CONFLICT_MESSAGE) {
    super(message);
    this.name = "EffectConflictError";
  }
}

/** A previous attempt is `started` or `failed`, so it may have reached the outside world. It was not repeated. */
export class EffectInDoubtError extends Error {
  readonly effectId: string;
  readonly status: "started" | "failed";
  readonly attempts: number;

  constructor(effectId: string, status: "started" | "failed", attempts: number) {
    super(
      `Effect ${effectId} is in doubt: an earlier attempt is '${status}' after ${attempts} attempt(s). ` +
        "It was not repeated. Reconcile it with the external system."
    );
    this.name = "EffectInDoubtError";
    this.effectId = effectId;
    this.status = status;
    this.attempts = attempts;
  }
}

interface StoredEffect {
  id: string;
  workspaceId: string;
  requestHash: string;
  status: EffectStatus;
  attempts: number;
  resultJson: string | null;
}

interface KeyLock {
  release(): Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function newEffectId(): string {
  return `eff_${crypto.randomUUID()}`;
}

function validateSpec(spec: EffectSpec): void {
  if (!spec.workspaceId) throw new TypeError("An effect requires a workspaceId");
  if (!spec.operation) throw new TypeError("An effect requires an operation");
  if (!spec.idempotencyKey) throw new TypeError("An effect requires an idempotencyKey");
  if (!Object.values(EffectClass).includes(spec.effectClass)) {
    throw new TypeError(`Unknown effect class '${String(spec.effectClass)}'`);
  }
}

/** Secrets that must never reach effects.error_message. Read from configuration at call time. */
function knownSecrets(): string[] {
  return [
    config.DATABASE_URL,
    config.RPC_URL,
    config.ARC_RPC_URL,
    config.ARC_SIGNER_PRIVATE_KEY,
    config.PARALLEL_API_KEY,
    config.NEBIUS_API_KEY,
    config.GEMINI_API_KEY,
    config.LANGSMITH_API_KEY,
    config.SESSION_SECRET,
  ].filter((secret): secret is string => typeof secret === "string" && secret.length > 0);
}

function boundedErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw || "unknown error", knownSecrets()).slice(0, ERROR_MESSAGE_LIMIT);
}

function assertSameRequest(row: StoredEffect, spec: EffectSpec, hash: string): void {
  if (row.workspaceId !== spec.workspaceId || row.requestHash !== hash) {
    throw new EffectConflictError();
  }
}

async function loadByKey(key: string): Promise<StoredEffect | null> {
  const res = await query(
    `SELECT id, workspace_id, request_hash, status, attempts, result::text AS result_json
     FROM effects WHERE idempotency_key = $1;`,
    [key]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    requestHash: row.request_hash,
    status: row.status,
    attempts: row.attempts,
    resultJson: row.result_json,
  };
}

const TRY_LOCK_SQL = `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired;`;
const UNLOCK_SQL = `SELECT pg_advisory_unlock(hashtextextended($1, 0));`;

/**
 * Takes the session advisory lock for an idempotency key. A dedicated connection holds it, so it is not
 * taken from the shared pool for the length of an external call. Returns null if the lock is still held after
 * LOCK_WAIT_MS. Waiters poll with short-lived connections and never hold a connection while they sleep.
 */
async function acquireKeyLock(key: string): Promise<KeyLock | null> {
  const deadline = Date.now() + LOCK_WAIT_MS;
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

async function markCompleted<T>(effectId: string, result: T, externalRef: string | undefined): Promise<void> {
  const encoded = encodeResult(result);
  await query(
    `UPDATE effects SET status = 'completed', result = $2::jsonb, external_ref = $3, error_message = NULL, updated_at = NOW()
     WHERE id = $1;`,
    [effectId, encoded, externalRef ?? null]
  );
}

async function markFailed(effectId: string, err: unknown): Promise<void> {
  try {
    await query(
      `UPDATE effects SET status = 'failed', error_message = $2, updated_at = NOW() WHERE id = $1;`,
      [effectId, boundedErrorMessage(err)]
    );
  } catch {
    // The row stays 'started', which is the in-doubt state. The caller still sees the original error.
  }
}

/** Runs fn for an effect row this caller owns. A throw is recorded as failed and rethrown unchanged. */
async function executeCall<T>(effectId: string, spec: EffectSpec, fn: () => Promise<T>, opts: EffectOptions<T>): Promise<T> {
  const beforeCall = takeEffectFault("before_call", spec);
  if (beforeCall) throw beforeCall;

  let result: T;
  try {
    result = await fn();
  } catch (err) {
    await markFailed(effectId, err);
    throw err;
  }

  const afterCall = takeEffectFault("after_call_before_complete", spec);
  if (afterCall) throw afterCall;

  await markCompleted(effectId, result, opts.externalRef?.(result));
  return result;
}

async function runLocked<T>(
  spec: EffectSpec,
  hash: string,
  fn: () => Promise<T>,
  opts: EffectOptions<T>
): Promise<{ result: T; replayed: boolean }> {
  const id = newEffectId();
  const inserted = await query(
    `INSERT INTO effects (id, workspace_id, workflow_id, effect_class, operation, idempotency_key, request_hash, status, attempts)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'started', 1)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id;`,
    [id, spec.workspaceId, spec.workflowId ?? null, spec.effectClass, spec.operation, spec.idempotencyKey, hash]
  );
  if (inserted.rowCount === 1) {
    const result = await executeCall(id, spec, fn, opts);
    return { result, replayed: false };
  }

  const row = await loadByKey(spec.idempotencyKey);
  if (!row) throw new Error("The effect for this idempotency key is not available; retry later.");
  assertSameRequest(row, spec, hash);

  if (row.status === "completed") {
    return { result: decodeResult<T>(row.resultJson ?? "null"), replayed: true };
  }

  if (opts.reconcile) {
    const found = await opts.reconcile();
    if (found.found) {
      await markCompleted(row.id, found.result, found.externalRef ?? opts.externalRef?.(found.result));
      return { result: found.result, replayed: true };
    }
  } else if (!spec.externalDedupes) {
    throw new EffectInDoubtError(row.id, row.status, row.attempts);
  }

  // Claim the retry. The row must still be in the state we read, so only one caller can start the attempt.
  const claimed = await query(
    `UPDATE effects SET status = 'started', attempts = attempts + 1, error_message = NULL, updated_at = NOW()
     WHERE id = $1 AND status IN ('started', 'failed') AND attempts = $2
     RETURNING id;`,
    [row.id, row.attempts]
  );
  if (claimed.rowCount !== 1) {
    const current = await loadByKey(spec.idempotencyKey);
    const status = current?.status ?? row.status;
    if (status === "completed") {
      return { result: decodeResult<T>(current?.resultJson ?? "null"), replayed: true };
    }
    throw new EffectInDoubtError(row.id, status, current?.attempts ?? row.attempts);
  }

  const result = await executeCall(row.id, spec, fn, opts);
  return { result, replayed: false };
}

/** Reports a key whose lock stayed busy for LOCK_WAIT_MS. Never runs fn. */
async function reportBusy<T>(spec: EffectSpec, hash: string): Promise<{ result: T; replayed: boolean }> {
  const row = await loadByKey(spec.idempotencyKey);
  if (!row) throw new Error("Another caller is preparing this effect; retry later.");
  assertSameRequest(row, spec, hash);
  if (row.status === "completed") {
    return { result: decodeResult<T>(row.resultJson ?? "null"), replayed: true };
  }
  throw new EffectInDoubtError(row.id, row.status, row.attempts);
}

/**
 * Runs an external effect at most once per idempotency key, or reports it in doubt.
 * fn is never called for a key that is completed, held by another caller, or in doubt (unless externalDedupes).
 */
export async function runEffect<T>(
  spec: EffectSpec,
  fn: () => Promise<T>,
  opts: EffectOptions<T> = {}
): Promise<{ result: T; replayed: boolean }> {
  validateSpec(spec);
  // Hash first: a request that cannot be hashed is rejected before anything is written or called.
  const hash = requestHash(spec.request);

  const lock = await acquireKeyLock(spec.idempotencyKey);
  if (!lock) return reportBusy<T>(spec, hash);
  try {
    return await runLocked(spec, hash, fn, opts);
  } finally {
    await lock.release();
  }
}

/** Effects that started or failed and have no completed result, oldest first. Optionally one workspace only. */
export async function listUnresolvedEffects(workspaceId?: string): Promise<EffectRow[]> {
  const res = await query(
    `SELECT id, workspace_id, workflow_id, effect_class, operation, idempotency_key, request_hash, status,
            error_message, external_ref, attempts, created_at, updated_at
     FROM effects
     WHERE status IN ('started', 'failed') AND ($1::text IS NULL OR workspace_id = $1)
     ORDER BY created_at ASC, id ASC;`,
    [workspaceId ?? null]
  );
  return res.rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    workflowId: row.workflow_id,
    effectClass: row.effect_class as EffectClass,
    operation: row.operation,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status as EffectStatus,
    errorMessage: row.error_message,
    externalRef: row.external_ref,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}
