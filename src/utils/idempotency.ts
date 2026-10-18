import crypto from "crypto";
import { query } from "../db/client.js";

export class DuplicateExecutionError extends Error {
  constructor(key: string) {
    super(`Duplicate execution blocked: operation with idempotency key '${key}' is already in progress or completed.`);
    this.name = "DuplicateExecutionError";
  }
}

/**
 * Deterministically serializes an object with sorted keys.
 */
function canonicalStringify(obj: any): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k])).join(",") + "}";
}

/**
 * Generates a collision-resistant deterministic idempotency key.
 */
export function generateIdempotencyKey(
  workspaceId: string,
  action: string,
  payload: Record<string, any>
): string {
  const canonical = canonicalStringify(payload);
  const hash = crypto
    .createHash("sha256")
    .update(`${workspaceId}:${action}:${canonical}`)
    .digest("hex");
  return `idem_${action.replace(/[^a-zA-Z0-9]/g, "_")}_${hash.slice(0, 24)}`;
}

export interface IdempotencyStore {
  acquireLock(key: string, workspaceId: string, scope: string): Promise<boolean>;
  complete(key: string, result: any): Promise<void>;
  getCompletedResult(key: string): Promise<any | null>;
  execute<T>(key: string, workspaceId: string, scope: string, fn: () => Promise<T>): Promise<T>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private locks = new Map<string, { lockedAt: Date; result?: any; status: "locked" | "completed" }>();

  async acquireLock(key: string, _workspaceId: string, _scope: string): Promise<boolean> {
    const existing = this.locks.get(key);
    if (existing) {
      throw new DuplicateExecutionError(key);
    }
    this.locks.set(key, { lockedAt: new Date(), status: "locked" });
    return true;
  }

  async complete(key: string, result: any): Promise<void> {
    const lock = this.locks.get(key);
    if (lock) {
      lock.status = "completed";
      lock.result = result;
    }
  }

  async getCompletedResult(key: string): Promise<any | null> {
    const lock = this.locks.get(key);
    if (lock && lock.status === "completed") {
      return lock.result;
    }
    return null;
  }

  async execute<T>(key: string, workspaceId: string, scope: string, fn: () => Promise<T>): Promise<T> {
    const completed = await this.getCompletedResult(key);
    if (completed !== null && completed !== undefined) {
      return completed;
    }

    await this.acquireLock(key, workspaceId, scope);
    try {
      const res = await fn();
      await this.complete(key, res);
      return res;
    } catch (err) {
      // Release lock on error so it can be retried if appropriate
      this.locks.delete(key);
      throw err;
    }
  }
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  async acquireLock(key: string, workspaceId: string, scope: string): Promise<boolean> {
    try {
      const res = await query(
        `INSERT INTO idempotency_keys (key, workspace_id, scope, locked_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (key) DO NOTHING
         RETURNING key;`,
        [key, workspaceId, scope]
      );
      if (res.rowCount === 0) {
        throw new DuplicateExecutionError(key);
      }
      return true;
    } catch (err: any) {
      if (err instanceof DuplicateExecutionError) throw err;
      if (err.code === "23505") { // unique constraint violation
        throw new DuplicateExecutionError(key);
      }
      throw err;
    }
  }

  async complete(key: string, result: any): Promise<void> {
    await query(
      `UPDATE idempotency_keys
       SET completed_at = NOW(), response_payload = $2
       WHERE key = $1;`,
      [key, JSON.stringify(result)]
    );
  }

  async getCompletedResult(key: string): Promise<any | null> {
    const res = await query(
      `SELECT response_payload, completed_at FROM idempotency_keys WHERE key = $1;`,
      [key]
    );
    if (res.rows.length > 0 && res.rows[0].completed_at) {
      return res.rows[0].response_payload;
    }
    return null;
  }

  async execute<T>(key: string, workspaceId: string, scope: string, fn: () => Promise<T>): Promise<T> {
    const completed = await this.getCompletedResult(key);
    if (completed !== null && completed !== undefined) {
      return completed;
    }

    await this.acquireLock(key, workspaceId, scope);
    try {
      const res = await fn();
      await this.complete(key, res);
      return res;
    } catch (err) {
      await query(`DELETE FROM idempotency_keys WHERE key = $1 AND completed_at IS NULL;`, [key]);
      throw err;
    }
  }
}
