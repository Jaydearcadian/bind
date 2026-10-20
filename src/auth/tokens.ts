import { createHash, randomBytes } from "crypto";
import { query, withTransaction } from "../db/client.js";
import { newId } from "../utils/ids.js";
import { isSessionToken, resolveSession } from "../accounts/sessions.js";
import { currentRequestId } from "../observability/request-context.js";

/**
 * Per-workspace access tokens (ADR 0021). A token is `bnd_` followed by 32 random bytes in base64url. Only its
 * SHA-256 hash is stored. The plaintext is returned once by issueToken and is never logged or stored.
 */

export const TOKEN_PREFIX = "bnd_";
/** Exactly the shape generateToken produces: 4 prefix characters and 43 base64url characters for 32 bytes. */
const TOKEN_PATTERN = /^bnd_[A-Za-z0-9_-]{43}$/;

export type WorkspaceRole = "owner" | "staff";
const ROLES: readonly WorkspaceRole[] = ["owner", "staff"];

/** Who is recorded on the audit row that a token issue or revoke writes. */
export interface TokenAuditActor {
  type: "owner" | "system";
  id: string;
}

const SYSTEM_ACTOR: TokenAuditActor = { type: "system", id: "system:operator" };

/**
 * Who is recorded on an audit row written by a studio action. `owner` or `staff` with the token's label (never the
 * token), or `system` with a `system:*` name. Every studio writer takes one explicitly; there is no fixed default (ADR 0023).
 */
export interface AuditActor {
  type: "owner" | "staff" | "system";
  id: string;
}

export interface Actor {
  workspaceId: string;
  role: WorkspaceRole;
  tokenId: string;
  label: string;
}

export interface TokenSummary {
  id: string;
  role: WorkspaceRole;
  label: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export type TokenErrorCode = "INVALID_INPUT" | "TOKEN_NOT_FOUND" | "LAST_OWNER_TOKEN";

/** A token operation that cannot be done. The API maps the code to a status. */
export class TokenError extends Error {
  readonly code: TokenErrorCode;

  constructor(code: TokenErrorCode, message: string) {
    super(message);
    this.name = "TokenError";
    this.code = code;
  }
}

export function generateToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isWellFormedToken(raw: unknown): raw is string {
  return typeof raw === "string" && TOKEN_PATTERN.test(raw);
}

function validateIssue(role: unknown, label: unknown): { role: WorkspaceRole; label: string } {
  if (!ROLES.includes(role as WorkspaceRole)) {
    throw new TokenError("INVALID_INPUT", "role must be 'owner' or 'staff'.");
  }
  const trimmed = typeof label === "string" ? label.trim() : "";
  if (trimmed.length < 1 || trimmed.length > 80) {
    throw new TokenError("INVALID_INPUT", "label must be 1 to 80 characters.");
  }
  return { role: role as WorkspaceRole, label: trimmed };
}

async function writeTokenAudit(
  client: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  workspaceId: string,
  action: "auth.token_issued" | "auth.token_revoked",
  actor: TokenAuditActor,
  evidence: { tokenId: string; role: WorkspaceRole; label: string }
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at, request_id)
     VALUES ($1, $2, NULL, $3, $4, 'commercial_commitment', $5, 'ALLOW', $6::jsonb, NOW(), $7);`,
    [newId("audit"), workspaceId, actor.type, actor.id, action, JSON.stringify(evidence), currentRequestId()]
  );
}

/**
 * Issues a token for a workspace. The token row and its audit row are written in one transaction.
 * The returned plaintext is the only copy.
 */
export async function issueToken(
  workspaceId: string,
  role: WorkspaceRole,
  label: string,
  actor: TokenAuditActor = SYSTEM_ACTOR
): Promise<{ token: string; id: string; role: WorkspaceRole; label: string }> {
  const checked = validateIssue(role, label);
  const token = generateToken();
  const id = newId("tok");
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO workspace_tokens (id, workspace_id, role, token_hash, label)
       VALUES ($1, $2, $3, $4, $5);`,
      [id, workspaceId, checked.role, hashToken(token), checked.label]
    );
    await writeTokenAudit(client, workspaceId, "auth.token_issued", actor, {
      tokenId: id,
      role: checked.role,
      label: checked.label,
    });
  });
  return { token, id, role: checked.role, label: checked.label };
}

/**
 * Resolves a bearer token to its actor. A malformed token is refused without a database lookup. A revoked or
 * unknown token resolves to null, and the caller cannot tell the two apart. A `bns_` token is an account session
 * (ADR 0051) and is resolved by the account service; the actor it yields is the same shape.
 */
export async function resolveToken(raw: string): Promise<Actor | null> {
  if (isSessionToken(raw)) return resolveSession(raw);
  if (!isWellFormedToken(raw)) return null;
  // An expired demo workspace (docs/decisions/0057) resolves to nothing, the same as an unknown token. The worker deletes it later.
  const res = await query(
    `SELECT t.id, t.workspace_id, t.role, t.label FROM workspace_tokens t
     JOIN workspaces w ON w.id = t.workspace_id
     WHERE t.token_hash = $1 AND t.revoked_at IS NULL
       AND (NOT w.is_demo OR w.demo_expires_at > NOW());`,
    [hashToken(raw)]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    workspaceId: row.workspace_id,
    role: row.role as WorkspaceRole,
    tokenId: row.id,
    label: row.label,
  };
}

/**
 * Revokes a token of this workspace. Refuses a token of another workspace or an unknown one (TOKEN_NOT_FOUND),
 * and refuses to leave the workspace without an active owner (LAST_OWNER_TOKEN). The active owner rows are locked
 * first, so two concurrent revokes cannot both pass the last-owner check.
 */
export async function revokeToken(
  workspaceId: string,
  tokenId: string,
  actor: TokenAuditActor = SYSTEM_ACTOR
): Promise<{ id: string; role: WorkspaceRole; label: string; revokedAt: Date }> {
  return withTransaction(async (client) => {
    const owners = await client.query(
      `SELECT id FROM workspace_tokens
       WHERE workspace_id = $1 AND role = 'owner' AND revoked_at IS NULL
       FOR UPDATE;`,
      [workspaceId]
    );
    // An owner who signed in as a person (ADR 0051) is an owner credential too.
    const ownerMembers = await client.query(
      `SELECT account_id FROM workspace_memberships WHERE workspace_id = $1 AND role = 'owner' AND removed_at IS NULL FOR UPDATE;`,
      [workspaceId]
    );
    const target = await client.query(
      `SELECT id, role, label FROM workspace_tokens
       WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL
       FOR UPDATE;`,
      [tokenId, workspaceId]
    );
    const row = target.rows[0];
    if (!row) {
      throw new TokenError("TOKEN_NOT_FOUND", "Token not found.");
    }
    const isLastOwner = row.role === "owner" && owners.rows.length + ownerMembers.rows.length <= 1;
    if (isLastOwner) {
      throw new TokenError("LAST_OWNER_TOKEN", "The last active owner token of a workspace cannot be revoked.");
    }
    const updated = await client.query(
      `UPDATE workspace_tokens SET revoked_at = NOW() WHERE id = $1 RETURNING revoked_at;`,
      [tokenId]
    );
    const revokedAt = updated.rows[0].revoked_at as Date;
    await writeTokenAudit(client, workspaceId, "auth.token_revoked", actor, {
      tokenId,
      role: row.role as WorkspaceRole,
      label: row.label,
    });
    return { id: tokenId, role: row.role as WorkspaceRole, label: row.label, revokedAt };
  });
}

/** Lists a workspace's tokens. Never returns a hash or a plaintext. */
export async function listTokens(workspaceId: string): Promise<TokenSummary[]> {
  const res = await query(
    `SELECT id, role, label, created_at, revoked_at FROM workspace_tokens
     WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC;`,
    [workspaceId]
  );
  return res.rows.map((row) => ({
    id: row.id,
    role: row.role as WorkspaceRole,
    label: row.label,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  }));
}

/**
 * Makes sure a token supplied through configuration (BIND_DEMO_OWNER_TOKEN) is stored as an owner token of the
 * workspace. Only its hash is written, and a second call with the same value stores nothing new. A token that
 * was revoked stays revoked.
 */
export async function ensureSecretOwnerToken(workspaceId: string, rawToken: string, label: string): Promise<boolean> {
  if (!isWellFormedToken(rawToken)) {
    throw new TokenError("INVALID_INPUT", "The configured owner token is not in the issued token format.");
  }
  const checked = validateIssue("owner", label);
  const res = await query(
    `INSERT INTO workspace_tokens (id, workspace_id, role, token_hash, label)
     VALUES ($1, $2, 'owner', $3, $4)
     ON CONFLICT (token_hash) DO NOTHING
     RETURNING id;`,
    [newId("tok"), workspaceId, hashToken(rawToken), checked.label]
  );
  return (res.rowCount ?? 0) === 1;
}
