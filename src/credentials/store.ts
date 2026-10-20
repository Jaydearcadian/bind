import type pg from "pg";
import { query, withTransaction } from "../db/client.js";
import { newId } from "../utils/ids.js";
import { redactText, redactUrls } from "../utils/redact.js";
import {
  decryptSecret,
  encryptSecret,
  keyringFromConfig,
  type StoredCiphertext,
} from "./crypto.js";
import { findVerifier, type VerifierResult } from "./verifiers.js";

/**
 * Connector credentials (ADR 0024): the owner's keys for external services, encrypted at rest.
 *
 * SERVER-SIDE ONLY. getCredentialForAdapter returns a plaintext secret. It must never be imported by a route, a model-facing
 * tool or the UI: an ESLint rule enforces that (eslint.config.mjs). Routes import src/credentials/admin.ts, which does not
 * export it.
 *
 * Status is honest: a credential is `verified` only after a registered verifier returned ok, and nothing is verified until
 * a live connector exists (no verifier is registered today).
 */

export const CONNECTOR_KINDS = ["messaging", "supplier", "accounting", "llm", "other"] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];
export type ConnectorStatus = "configured_unverified" | "verified" | "revoked";

const CONNECTOR_ID_PATTERN = /^[a-z][a-z0-9_.:-]{1,63}$/;
const MAX_SECRET_LENGTH = 8192;
const VERIFIER_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_REASON_LENGTH = 200;

/** Who made the change. The owner is the token label (`alice`), never the token. */
export interface CredentialActor {
  type: "owner" | "system";
  id: string;
}

/** A credential as the API may show it. Never a secret, ciphertext, nonce or tag. */
export interface ConnectorSummary {
  connectorId: string;
  kind: ConnectorKind;
  status: ConnectorStatus;
  lastVerifiedAt: Date | null;
  fingerprint: string | null;
  updatedAt: Date;
}

export interface SetCredentialInput {
  workspaceId: string;
  connectorId: string;
  kind: ConnectorKind;
  secret: string;
  actor: CredentialActor;
}

export interface VerifyOutcome {
  connectorId: string;
  status: ConnectorStatus;
  verification: "NOT_AVAILABLE" | "VERIFIED" | "FAILED";
  code?: string;
}

export interface RotationReport {
  rotated: number;
  skipped: number;
  failed: number;
}

/** The input is not acceptable. The message names the rule, never the submitted value. */
export class CredentialInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialInputError";
  }
}

/** No live credential exists for the workspace and connector (missing, or revoked). */
export class CredentialNotFoundError extends Error {
  constructor() {
    super("Connector credential not found");
    this.name = "CredentialNotFoundError";
  }
}

function checkConnectorId(connectorId: unknown): string {
  if (typeof connectorId !== "string" || !CONNECTOR_ID_PATTERN.test(connectorId)) {
    throw new CredentialInputError(
      "connectorId must be 2 to 64 characters: lowercase letters, digits, '.', '_', ':' or '-', starting with a letter."
    );
  }
  return connectorId;
}

function checkKind(kind: unknown): ConnectorKind {
  if (typeof kind !== "string" || !(CONNECTOR_KINDS as readonly string[]).includes(kind)) {
    throw new CredentialInputError(`kind must be one of: ${CONNECTOR_KINDS.join(", ")}.`);
  }
  return kind as ConnectorKind;
}

function checkSecret(secret: unknown): string {
  if (typeof secret !== "string" || secret.trim().length === 0 || secret.length > MAX_SECRET_LENGTH) {
    throw new CredentialInputError(`secret must be a non-empty string of at most ${MAX_SECRET_LENGTH} characters.`);
  }
  return secret;
}

function summaryOf(row: any): ConnectorSummary {
  return {
    connectorId: row.connector_id,
    kind: row.kind,
    status: row.status,
    lastVerifiedAt: row.last_verified_at ?? null,
    fingerprint: row.fingerprint ?? null,
    updatedAt: row.updated_at,
  };
}

const SUMMARY_COLUMNS = `connector_id, kind, status, last_verified_at, fingerprint, updated_at`;

/** Every credential change writes its audit row in the same transaction. Evidence never holds a secret. */
async function writeCredentialAudit(
  client: pg.PoolClient,
  workspaceId: string,
  actor: CredentialActor,
  effectClass: "commercial_commitment" | "external_request",
  action: string,
  evidence: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, 'ALLOW', $7::jsonb, NOW());`,
    [newId("audit"), workspaceId, actor.type, actor.id, effectClass, action, JSON.stringify(evidence)]
  );
}

/**
 * Stores a credential, replacing any earlier one for the same connector. The old ciphertext is gone; the status returns to
 * configured_unverified; the revocation (if any) is cleared.
 */
export async function setCredential(input: SetCredentialInput): Promise<ConnectorSummary> {
  const keyring = keyringFromConfig();
  const connectorId = checkConnectorId(input.connectorId);
  const kind = checkKind(input.kind);
  const secret = checkSecret(input.secret);
  const enc = encryptSecret(secret, { workspaceId: input.workspaceId, connectorId }, keyring);

  return withTransaction(async (client) => {
    const res = await client.query(
      `INSERT INTO connector_credentials
         (id, workspace_id, connector_id, kind, ciphertext, nonce, auth_tag, key_id, fingerprint, status, last_verified_at, created_at, updated_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'configured_unverified', NULL, NOW(), NOW(), NULL)
       ON CONFLICT (workspace_id, connector_id) DO UPDATE SET
         kind = EXCLUDED.kind,
         ciphertext = EXCLUDED.ciphertext,
         nonce = EXCLUDED.nonce,
         auth_tag = EXCLUDED.auth_tag,
         key_id = EXCLUDED.key_id,
         fingerprint = EXCLUDED.fingerprint,
         status = 'configured_unverified',
         last_verified_at = NULL,
         revoked_at = NULL,
         updated_at = NOW()
       RETURNING ${SUMMARY_COLUMNS};`,
      [newId("cred"), input.workspaceId, connectorId, kind, enc.ciphertext, enc.nonce, enc.authTag, enc.keyId, enc.fingerprint]
    );
    await writeCredentialAudit(client, input.workspaceId, input.actor, "commercial_commitment", "connector.credential_set", {
      connectorId,
      kind,
      fingerprint: enc.fingerprint,
    });
    return summaryOf(res.rows[0]);
  });
}

/** The credentials of a workspace. Never a secret, ciphertext, nonce or tag. Throws when the store is disabled. */
export async function listConnectors(workspaceId: string): Promise<ConnectorSummary[]> {
  keyringFromConfig();
  const res = await query(
    `SELECT ${SUMMARY_COLUMNS} FROM connector_credentials WHERE workspace_id = $1 ORDER BY connector_id ASC;`,
    [workspaceId]
  );
  return res.rows.map(summaryOf);
}

/**
 * Destroys a credential: the ciphertext, nonce, tag, key id and fingerprint are cleared, and the status is revoked. Returns
 * null when the workspace has no such connector.
 */
export async function revokeCredential(
  workspaceId: string,
  connectorId: string,
  actor: CredentialActor
): Promise<ConnectorSummary | null> {
  keyringFromConfig();
  const conn = checkConnectorId(connectorId);
  return withTransaction(async (client) => {
    const res = await client.query(
      `UPDATE connector_credentials SET
         status = 'revoked',
         revoked_at = COALESCE(revoked_at, NOW()),
         ciphertext = NULL, nonce = NULL, auth_tag = NULL, key_id = NULL, fingerprint = NULL,
         updated_at = NOW()
       WHERE workspace_id = $1 AND connector_id = $2
       RETURNING ${SUMMARY_COLUMNS};`,
      [workspaceId, conn]
    );
    if (res.rows.length === 0) return null;
    await writeCredentialAudit(client, workspaceId, actor, "commercial_commitment", "connector.credential_revoked", {
      connectorId: conn,
    });
    return summaryOf(res.rows[0]);
  });
}

/**
 * SERVER-SIDE ONLY. The plaintext secret for an adapter. No caching: a replacement or a revocation takes effect on the
 * next call. Null when there is no row or it is revoked. Throws CredentialDecryptError if the stored record does not
 * authenticate for this workspace and connector.
 */
export async function getCredentialForAdapter(
  workspaceId: string,
  connectorId: string
): Promise<{ secret: string; status: ConnectorStatus } | null> {
  const keyring = keyringFromConfig();
  const res = await query(
    `SELECT ciphertext, nonce, auth_tag, key_id, status FROM connector_credentials
     WHERE workspace_id = $1 AND connector_id = $2;`,
    [workspaceId, connectorId]
  );
  const row = res.rows[0];
  if (!row || row.status === "revoked" || !row.ciphertext) return null;
  const record: StoredCiphertext = {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.auth_tag,
    keyId: row.key_id,
  };
  const secret = decryptSecret(record, { workspaceId, connectorId }, keyring);
  return { secret, status: row.status };
}

/**
 * Runs the registered verifier for the connector (by id, then kind) on the decrypted secret. Only an ok result writes
 * `verified`. A failure, a thrown error or an invalid result leaves or returns the status to configured_unverified. With
 * no verifier registered nothing changes and the answer is NOT_AVAILABLE. The response carries a code, never a message.
 */
export async function verifyCredential(
  workspaceId: string,
  connectorId: string,
  actor: CredentialActor
): Promise<VerifyOutcome> {
  const keyring = keyringFromConfig();
  const conn = checkConnectorId(connectorId);
  const res = await query(
    `SELECT kind, status, ciphertext, nonce, auth_tag, key_id, fingerprint FROM connector_credentials
     WHERE workspace_id = $1 AND connector_id = $2;`,
    [workspaceId, conn]
  );
  const row = res.rows[0];
  if (!row || row.status === "revoked" || !row.ciphertext) throw new CredentialNotFoundError();

  const verifier = findVerifier(conn, row.kind);
  if (!verifier) {
    return { connectorId: conn, status: row.status, verification: "NOT_AVAILABLE" };
  }

  const secret = decryptSecret(
    { ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag, keyId: row.key_id },
    { workspaceId, connectorId: conn },
    keyring
  );

  let outcome: VerifierResult;
  let reason: string | undefined;
  try {
    outcome = await verifier(secret, { workspaceId, connectorId: conn, kind: row.kind });
  } catch (err) {
    const raw = err instanceof Error ? err.message : "the verifier failed";
    reason = redactText(redactUrls(raw), [secret]).slice(0, MAX_REASON_LENGTH);
    outcome = { ok: false, code: "VERIFIER_THREW" };
  }
  if (!outcome || typeof outcome !== "object") {
    outcome = { ok: false, code: "VERIFIER_INVALID_RESULT" };
  } else if (!outcome.ok) {
    const code = typeof outcome.code === "string" ? outcome.code : "";
    const safe = VERIFIER_CODE_PATTERN.test(code) && redactText(code, [secret]) === code;
    outcome = { ok: false, code: safe ? code : "VERIFIER_INVALID_RESULT" };
  }

  // The write is conditional on this exact ciphertext (its nonce is unique), so a verification of a replaced or revoked
  // credential cannot mark its successor verified.
  return withTransaction(async (client) => {
    const ok = outcome.ok === true;
    const updated = await client.query(
      `UPDATE connector_credentials SET
         status = $4,
         last_verified_at = CASE WHEN $4 = 'verified' THEN NOW() ELSE last_verified_at END,
         updated_at = NOW()
       WHERE workspace_id = $1 AND connector_id = $2 AND nonce = $3 AND status <> 'revoked'
       RETURNING status;`,
      [workspaceId, conn, row.nonce, ok ? "verified" : "configured_unverified"]
    );
    if (updated.rows.length === 0) {
      // Replaced or revoked while the verifier ran. Nothing is marked, and the caller sees the failure.
      const now = await client.query(`SELECT status FROM connector_credentials WHERE workspace_id = $1 AND connector_id = $2;`, [
        workspaceId,
        conn,
      ]);
      return {
        connectorId: conn,
        status: (now.rows[0]?.status ?? "configured_unverified") as ConnectorStatus,
        verification: "FAILED",
        code: "CREDENTIAL_CHANGED",
      } satisfies VerifyOutcome;
    }
    const current = updated.rows[0].status as ConnectorStatus;
    if (ok) {
      await writeCredentialAudit(client, workspaceId, actor, "external_request", "connector.credential_verified", {
        connectorId: conn,
        kind: row.kind,
        fingerprint: row.fingerprint,
      });
      return { connectorId: conn, status: current, verification: "VERIFIED" };
    }
    const failure = outcome as { ok: false; code: string };
    await writeCredentialAudit(client, workspaceId, actor, "external_request", "connector.credential_verification_failed", {
      connectorId: conn,
      kind: row.kind,
      code: failure.code,
      ...(reason !== undefined ? { reason } : {}),
    });
    return { connectorId: conn, status: current, verification: "FAILED", code: failure.code };
  });
}

/**
 * Re-encrypts every live credential that is not under the current key, with the old key as BIND_CREDENTIAL_KEY_PREVIOUS.
 * Each row is its own transaction: a row that cannot be decrypted is counted as failed and left unchanged. Only counts
 * are returned, never a secret.
 */
export async function rotateCredentialKeys(): Promise<RotationReport> {
  const keyring = keyringFromConfig();
  const live = await query(
    `SELECT id, workspace_id, connector_id FROM connector_credentials
     WHERE status <> 'revoked' AND ciphertext IS NOT NULL ORDER BY workspace_id ASC, connector_id ASC;`
  );
  const report: RotationReport = { rotated: 0, skipped: 0, failed: 0 };
  const system: CredentialActor = { type: "system", id: "system:credential-rotation" };

  for (const target of live.rows) {
    const ctx = { workspaceId: target.workspace_id as string, connectorId: target.connector_id as string };
    try {
      const outcome = await withTransaction(async (client) => {
        const locked = await client.query(
          `SELECT ciphertext, nonce, auth_tag, key_id FROM connector_credentials WHERE id = $1 FOR UPDATE;`,
          [target.id]
        );
        const row = locked.rows[0];
        if (!row || !row.ciphertext) return "skipped" as const;
        if (row.key_id === keyring.current.keyId) return "skipped" as const;

        const plaintext = decryptSecret(
          { ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag, keyId: row.key_id },
          ctx,
          keyring
        );
        const enc = encryptSecret(plaintext, ctx, keyring);
        await client.query(
          `UPDATE connector_credentials SET ciphertext = $2, nonce = $3, auth_tag = $4, key_id = $5, fingerprint = $6, updated_at = NOW()
           WHERE id = $1;`,
          [target.id, enc.ciphertext, enc.nonce, enc.authTag, enc.keyId, enc.fingerprint]
        );
        await writeCredentialAudit(client, ctx.workspaceId, system, "commercial_commitment", "connector.credential_rotated", {
          connectorId: ctx.connectorId,
          keyId: enc.keyId,
        });
        return "rotated" as const;
      });
      if (outcome === "rotated") report.rotated += 1;
      else report.skipped += 1;
    } catch {
      // A row that does not decrypt, or a write that failed: unchanged, and counted.
      report.failed += 1;
    }
  }
  return report;
}
