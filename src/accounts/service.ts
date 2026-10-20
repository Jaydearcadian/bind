import { createHash, randomBytes } from "node:crypto";
import { query, withTransaction } from "../db/client.js";
import { acquireAdvisoryLock } from "../db/advisory-lock.js";
import { newId } from "../utils/ids.js";
import { provisionWorkspace } from "../templates/registry.js";
import type { WorkspaceRole } from "../auth/tokens.js";

/**
 * Accounts, memberships and invitations (ADR 0051). Privy proves who a person is; everything here is what Bind decides:
 * which workspaces an account belongs to, in what role, and who may bring someone in. Invitation codes and sessions are
 * stored as hashes only. Every membership change is audited with ids only.
 */

export type AccountErrorCode =
  | "INVALID_INPUT"
  | "WORKSPACE_ID_TAKEN"
  | "INVITE_NOT_FOUND"
  | "INVITE_UNUSABLE"
  | "ALREADY_MEMBER"
  | "MEMBER_NOT_FOUND"
  | "LAST_OWNER";

export class AccountError extends Error {
  readonly code: AccountErrorCode;
  constructor(code: AccountErrorCode, message: string) {
    super(message);
    this.name = "AccountError";
    this.code = code;
  }
}

const INVITE_PREFIX = "bni_";
const INVITE_PATTERN = /^bni_[A-Za-z0-9_-]{43}$/;
const DEFAULT_INVITE_HOURS = 72;
const MAX_INVITE_HOURS = 24 * 14;

/** True when the text has a control character (including NUL, tab and newline) or DEL. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

interface Queryable {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}

async function audit(client: Queryable, workspaceId: string, actor: { type: "owner" | "system"; id: string }, action: string, evidence: Record<string, unknown>): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
     VALUES ($1, $2, NULL, $3, $4, 'commercial_commitment', $5, 'ALLOW', $6::jsonb, NOW());`,
    [newId("audit"), workspaceId, actor.type, actor.id, action, JSON.stringify(evidence)]
  );
}

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 80 || hasControl(trimmed)) throw new AccountError("INVALID_INPUT", "displayName must be 1 to 80 printable characters.");
  return trimmed;
}

export interface Account {
  id: string;
  privyUserId: string;
  displayName: string | null;
}

/** Finds the account for a Privy user id, creating it on first sign-in. A display name is kept only if none is set yet. */
export async function upsertAccount(privyUserId: string, displayName?: unknown): Promise<Account> {
  const name = cleanName(displayName);
  const res = await query(
    `INSERT INTO accounts (id, privy_user_id, display_name) VALUES ($1, $2, $3)
     ON CONFLICT (privy_user_id) DO UPDATE SET display_name = COALESCE(accounts.display_name, EXCLUDED.display_name)
     RETURNING id, privy_user_id, display_name;`,
    [newId("acct"), privyUserId, name]
  );
  const row = res.rows[0];
  return { id: row.id, privyUserId: row.privy_user_id, displayName: row.display_name };
}

export interface AccountWorkspace {
  id: string;
  name: string;
  role: WorkspaceRole;
}

export async function listAccountWorkspaces(accountId: string): Promise<AccountWorkspace[]> {
  const res = await query(
    `SELECT w.id, w.name, m.role FROM workspace_memberships m JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.account_id = $1 AND m.removed_at IS NULL ORDER BY m.created_at ASC, w.id ASC;`,
    [accountId]
  );
  return res.rows.map((r) => ({ id: r.id, name: r.name, role: r.role as WorkspaceRole }));
}

/**
 * Creates a workspace from a template and makes the account its owner, with no owner token. If the membership cannot be written
 * the workspace is removed, so no workspace is left without an owner. Returns false when the id is taken.
 */
export async function createAccountWorkspace(accountId: string, id: string, name: string, templateId: string): Promise<boolean> {
  const lock = await acquireAdvisoryLock(`workspace-create:${id}`);
  if (!lock) return false;
  try {
    const existing = await query("SELECT 1 FROM workspaces WHERE id = $1;", [id]);
    if (existing.rows.length > 0) return false;
    await provisionWorkspace(id, name, templateId);
    try {
      await withTransaction(async (client) => {
        await client.query(`INSERT INTO workspace_memberships (account_id, workspace_id, role) VALUES ($1, $2, 'owner');`, [accountId, id]);
        await audit(client, id, { type: "system", id: "system:workspace-create" }, "auth.member_joined", { accountId, role: "owner", via: "workspace_create" });
      });
    } catch (err) {
      await query("DELETE FROM workspaces WHERE id = $1;", [id]);
      throw err;
    }
    return true;
  } finally {
    await lock.release();
  }
}

export interface InviteSummary {
  id: string;
  role: "staff";
  label: string;
  createdBy: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

/** Creates a single-use staff invitation. The code is returned once and only its hash is stored. */
export async function createInvite(
  workspaceId: string,
  label: unknown,
  createdBy: string,
  hours: unknown
): Promise<{ id: string; code: string; expiresAt: Date; label: string }> {
  const name = typeof label === "string" ? label.trim() : "";
  if (name.length < 1 || name.length > 80 || hasControl(name)) throw new AccountError("INVALID_INPUT", "label must be 1 to 80 printable characters.");
  const h = hours === undefined ? DEFAULT_INVITE_HOURS : hours;
  if (typeof h !== "number" || !Number.isInteger(h) || h < 1 || h > MAX_INVITE_HOURS) {
    throw new AccountError("INVALID_INPUT", `expiresInHours must be a whole number from 1 to ${MAX_INVITE_HOURS}.`);
  }
  const code = `${INVITE_PREFIX}${randomBytes(32).toString("base64url")}`;
  const id = newId("inv");
  const expiresAt = new Date(Date.now() + h * 3_600_000);
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO workspace_invites (id, workspace_id, code_hash, role, label, created_by, expires_at) VALUES ($1, $2, $3, 'staff', $4, $5, $6);`,
      [id, workspaceId, sha256(code), name, createdBy, expiresAt]
    );
    await audit(client, workspaceId, { type: "owner", id: createdBy }, "auth.invite_created", { inviteId: id, role: "staff", label: name });
  });
  return { id, code, expiresAt, label: name };
}

export async function listInvites(workspaceId: string): Promise<InviteSummary[]> {
  const res = await query(
    `SELECT id, role, label, created_by, expires_at, used_at, revoked_at FROM workspace_invites WHERE workspace_id = $1 ORDER BY created_at DESC, id ASC LIMIT 100;`,
    [workspaceId]
  );
  return res.rows.map((r) => ({ id: r.id, role: r.role, label: r.label, createdBy: r.created_by, expiresAt: r.expires_at, usedAt: r.used_at, revokedAt: r.revoked_at }));
}

export async function revokeInvite(workspaceId: string, inviteId: string, by: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const res = await client.query(
      `UPDATE workspace_invites SET revoked_at = NOW() WHERE id = $1 AND workspace_id = $2 AND used_at IS NULL AND revoked_at IS NULL RETURNING id;`,
      [inviteId, workspaceId]
    );
    if (res.rowCount !== 1) return false;
    await audit(client, workspaceId, { type: "owner", id: by }, "auth.invite_revoked", { inviteId });
    return true;
  });
}

/**
 * Uses an invitation for an account. One statement claims the invitation, so two people racing for one code cannot both
 * get in. An unknown, used, revoked or expired code is one error (INVITE_UNUSABLE), so a caller learns nothing about which.
 * An account that already belongs to the workspace does not consume the code.
 */
export async function acceptInvite(accountId: string, code: unknown): Promise<AccountWorkspace> {
  if (typeof code !== "string" || !INVITE_PATTERN.test(code)) throw new AccountError("INVITE_UNUSABLE", "This invitation cannot be used.");
  return withTransaction(async (client) => {
    const invite = await client.query(
      `SELECT id, workspace_id FROM workspace_invites
        WHERE code_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > NOW() FOR UPDATE;`,
      [sha256(code)]
    );
    const row = invite.rows[0];
    if (!row) throw new AccountError("INVITE_UNUSABLE", "This invitation cannot be used.");
    const member = await client.query(
      `SELECT role, removed_at FROM workspace_memberships WHERE account_id = $1 AND workspace_id = $2 FOR UPDATE;`,
      [accountId, row.workspace_id]
    );
    const existing = member.rows[0];
    if (existing && existing.removed_at === null) throw new AccountError("ALREADY_MEMBER", "You already belong to this workspace.");
    if (existing) {
      await client.query(`UPDATE workspace_memberships SET role = 'staff', removed_at = NULL, created_at = NOW() WHERE account_id = $1 AND workspace_id = $2;`, [accountId, row.workspace_id]);
    } else {
      await client.query(`INSERT INTO workspace_memberships (account_id, workspace_id, role) VALUES ($1, $2, 'staff');`, [accountId, row.workspace_id]);
    }
    await client.query(`UPDATE workspace_invites SET used_at = NOW(), used_by_account = $2 WHERE id = $1;`, [row.id, accountId]);
    await audit(client, row.workspace_id, { type: "system", id: "system:invite" }, "auth.member_joined", { accountId, role: "staff", via: "invite", inviteId: row.id });
    const ws = await client.query(`SELECT id, name FROM workspaces WHERE id = $1;`, [row.workspace_id]);
    return { id: ws.rows[0].id, name: ws.rows[0].name, role: "staff" as WorkspaceRole };
  });
}

export interface MemberSummary {
  accountId: string;
  displayName: string | null;
  role: WorkspaceRole;
  joinedAt: Date;
}

export async function listMembers(workspaceId: string): Promise<MemberSummary[]> {
  const res = await query(
    `SELECT m.account_id, a.display_name, m.role, m.created_at FROM workspace_memberships m JOIN accounts a ON a.id = m.account_id
      WHERE m.workspace_id = $1 AND m.removed_at IS NULL ORDER BY m.created_at ASC, m.account_id ASC;`,
    [workspaceId]
  );
  return res.rows.map((r) => ({ accountId: r.account_id, displayName: r.display_name, role: r.role as WorkspaceRole, joinedAt: r.created_at }));
}

/** The owner credentials a workspace has: owner tokens plus owner memberships. A workspace must always keep at least one. */
async function activeOwnerCredentials(client: Queryable, workspaceId: string): Promise<number> {
  const tokens = await client.query(`SELECT id FROM workspace_tokens WHERE workspace_id = $1 AND role = 'owner' AND revoked_at IS NULL FOR UPDATE;`, [workspaceId]);
  const members = await client.query(`SELECT account_id FROM workspace_memberships WHERE workspace_id = $1 AND role = 'owner' AND removed_at IS NULL FOR UPDATE;`, [workspaceId]);
  return tokens.rows.length + members.rows.length;
}

/** Changes a member's role. Refuses to demote the last owner credential. Sessions follow at once: the role is read per request. */
export async function setMemberRole(workspaceId: string, accountId: string, role: WorkspaceRole, by: string): Promise<MemberSummary> {
  if (role !== "owner" && role !== "staff") throw new AccountError("INVALID_INPUT", "role must be 'owner' or 'staff'.");
  return withTransaction(async (client) => {
    const owners = await activeOwnerCredentials(client, workspaceId);
    const target = await client.query(
      `SELECT m.role, m.created_at, a.display_name FROM workspace_memberships m JOIN accounts a ON a.id = m.account_id
        WHERE m.account_id = $1 AND m.workspace_id = $2 AND m.removed_at IS NULL FOR UPDATE OF m;`,
      [accountId, workspaceId]
    );
    const row = target.rows[0];
    if (!row) throw new AccountError("MEMBER_NOT_FOUND", "Member not found.");
    if (row.role === "owner" && role === "staff" && owners <= 1) throw new AccountError("LAST_OWNER", "The last owner of a workspace cannot be demoted.");
    if (row.role !== role) {
      await client.query(`UPDATE workspace_memberships SET role = $3 WHERE account_id = $1 AND workspace_id = $2;`, [accountId, workspaceId, role]);
      await audit(client, workspaceId, { type: "owner", id: by }, "auth.member_role_changed", { accountId, from: row.role, to: role });
    }
    return { accountId, displayName: row.display_name, role, joinedAt: row.created_at };
  });
}

/** Removes a member and ends their sessions. Refuses to remove the last owner credential. */
export async function removeMember(workspaceId: string, accountId: string, by: string): Promise<void> {
  await withTransaction(async (client) => {
    const owners = await activeOwnerCredentials(client, workspaceId);
    const target = await client.query(
      `SELECT role FROM workspace_memberships WHERE account_id = $1 AND workspace_id = $2 AND removed_at IS NULL FOR UPDATE;`,
      [accountId, workspaceId]
    );
    const row = target.rows[0];
    if (!row) throw new AccountError("MEMBER_NOT_FOUND", "Member not found.");
    if (row.role === "owner" && owners <= 1) throw new AccountError("LAST_OWNER", "The last owner of a workspace cannot be removed.");
    await client.query(`UPDATE workspace_memberships SET removed_at = NOW() WHERE account_id = $1 AND workspace_id = $2;`, [accountId, workspaceId]);
    await client.query(`UPDATE account_sessions SET revoked_at = NOW() WHERE account_id = $1 AND workspace_id = $2 AND revoked_at IS NULL;`, [accountId, workspaceId]);
    await audit(client, workspaceId, { type: "owner", id: by }, "auth.member_removed", { accountId, role: row.role });
  });
}
