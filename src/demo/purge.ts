import fs from "node:fs/promises";
import path from "node:path";
import { query, withTransaction } from "../db/client.js";
import { templatesArtifactsDir, workflowsArtifactsDir } from "../utils/artifacts.js";
import { isDemoWorkspaceId } from "./policy.js";

/**
 * Removing demo workspaces (docs/decisions/0057). Two things are removed for a demo: its database rows, and the files the
 * demo itself generated. The rows cascade from `workspaces` (every workspace table references it with ON DELETE CASCADE);
 * `idempotency_keys` has no foreign key, so its rows of this workspace are deleted here.
 *
 * The files are, exactly: the template folder `templates/<demo id>` (written by syncWorkspaceDerivedTemplateFiles when the
 * owner changes policy or roles) and `workflows/<workflow id>` for each workflow of the demo (written only when a settled
 * demo order has decision evidence). Nothing else is removed. Each path is built from a validated name under its root and
 * must resolve inside that root, so a damaged id can never reach another folder.
 *
 * Files go first, then rows. A failure removing a file leaves the rows in place, so the next tick tries again. Removing a
 * folder that is already gone is not an error.
 */

/** A plain name: letters, digits, underscore and hyphen. No separator, no dot segment. */
const SAFE_NAME = /^[A-Za-z0-9_-]{1,128}$/;

/** The path of `name` directly under `root`. Throws if the name is not a plain segment or the path would leave `root`. */
export function childOfRoot(root: string, name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error("refusing to remove a path that is not a plain artifact name");
  const base = path.resolve(root);
  const target = path.resolve(base, name);
  if (path.dirname(target) !== base) throw new Error("refusing to remove a path outside the artifacts folder");
  return target;
}

/** Removes the files one demo generated. Refuses an id that is not a demo id. Idempotent: missing folders are fine. */
export async function removeDemoArtifacts(workspaceId: string): Promise<void> {
  if (!isDemoWorkspaceId(workspaceId)) throw new Error("refusing to remove artifacts of a workspace that is not a demo");
  const templateDir = childOfRoot(templatesArtifactsDir(), workspaceId);
  const workflows = await query(`SELECT id FROM workflows WHERE workspace_id = $1;`, [workspaceId]);
  const workflowDirs = workflows.rows.map((row) => childOfRoot(workflowsArtifactsDir(), String(row.id)));
  await fs.rm(templateDir, { recursive: true, force: true });
  for (const dir of workflowDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Deletes a demo's rows. With `onlyExpired`, the delete happens only when the demo has expired, so a demo that was reset or
 * extended meanwhile is never removed by the worker. Returns the number of workspace rows removed (0 or 1).
 */
export async function deleteDemoRows(workspaceId: string, onlyExpired: boolean): Promise<number> {
  return withTransaction(async (client) => {
    const expiry = onlyExpired ? "AND demo_expires_at <= NOW()" : "";
    const removed = await client.query(`DELETE FROM workspaces WHERE id = $1 AND is_demo ${expiry} RETURNING id;`, [workspaceId]);
    if ((removed.rowCount ?? 0) === 0) return 0;
    await client.query(`DELETE FROM idempotency_keys WHERE workspace_id = $1;`, [workspaceId]);
    return 1;
  });
}

export interface ExpiredDemoPurge {
  /** Demo workspaces whose rows and files were removed. */
  removed: number;
  /** One entry per demo that could not be removed this time. Each is the raw error, for the caller to redact and report. */
  failures: unknown[];
}

/** Removes up to `limit` expired demo workspaces, oldest expiry first. A failing demo is counted and the rest still run. */
export async function purgeExpiredDemos(limit: number): Promise<ExpiredDemoPurge> {
  const due = await query(
    `SELECT id FROM workspaces WHERE is_demo AND demo_expires_at <= NOW() ORDER BY demo_expires_at ASC, id ASC LIMIT $1;`,
    [limit]
  );
  let removed = 0;
  const failures: unknown[] = [];
  for (const row of due.rows) {
    try {
      const id = String(row.id);
      await removeDemoArtifacts(id);
      removed += await deleteDemoRows(id, true);
    } catch (err) {
      failures.push(err);
    }
  }
  return { removed, failures };
}
