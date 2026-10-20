import { createHash, randomBytes } from "node:crypto";
import { query } from "../db/client.js";
import { newId } from "../utils/ids.js";
import type { Actor, WorkspaceRole } from "../auth/tokens.js";

/**
 * Account sessions (ADR 0051). A session is `bns_` plus 32 random bytes in base64url, scoped to one workspace and short
 * lived. Only its SHA-256 hash is stored. It resolves to the same Actor a workspace token does, so every route's
 * authorization is unchanged. The role is read from the membership on each request, so removing a member or changing
 * the role takes effect at once, and a session can never outlive its membership.
 */
export const SESSION_PREFIX = "bns_";
const SESSION_PATTERN = /^bns_[A-Za-z0-9_-]{43}$/;

export function isSessionToken(raw: unknown): raw is string {
  return typeof raw === "string" && SESSION_PATTERN.test(raw);
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface IssuedSession {
  token: string;
  id: string;
  expiresAt: Date;
  role: WorkspaceRole;
  workspaceId: string;
}

/** Starts a session for an account in a workspace it belongs to. Returns null when there is no active membership. */
export async function createSession(accountId: string, workspaceId: string, ttlMinutes: number): Promise<IssuedSession | null> {
  const member = await query(
    `SELECT role FROM workspace_memberships WHERE account_id = $1 AND workspace_id = $2 AND removed_at IS NULL;`,
    [accountId, workspaceId]
  );
  const role = member.rows[0]?.role as WorkspaceRole | undefined;
  if (!role) return null;
  const token = `${SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = newId("ses");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);
  await query(
    `INSERT INTO account_sessions (id, account_id, workspace_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, $5);`,
    [id, accountId, workspaceId, hash(token), expiresAt]
  );
  return { token, id, expiresAt, role, workspaceId };
}

/** The actor for a live session, or null. An expired, revoked, unknown or orphaned session is the same null. */
export async function resolveSession(raw: string): Promise<Actor | null> {
  if (!isSessionToken(raw)) return null;
  const res = await query(
    `SELECT s.id, s.workspace_id, m.role, COALESCE(a.display_name, 'member-' || right(a.id, 6)) AS label
       FROM account_sessions s
       JOIN accounts a ON a.id = s.account_id
       JOIN workspace_memberships m ON m.account_id = s.account_id AND m.workspace_id = s.workspace_id AND m.removed_at IS NULL
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW();`,
    [hash(raw)]
  );
  const row = res.rows[0];
  if (!row) return null;
  return { workspaceId: row.workspace_id, role: row.role as WorkspaceRole, tokenId: row.id, label: row.label };
}

export async function revokeSession(sessionId: string): Promise<boolean> {
  const res = await query(`UPDATE account_sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL;`, [sessionId]);
  return (res.rowCount ?? 0) === 1;
}
