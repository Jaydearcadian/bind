import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { query, withTransaction } from "../db/client.js";
import { newId } from "../utils/ids.js";
import { boundedErrorMessage } from "../effects/ledger.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PolicyDecision } from "../policy/engine.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { effectiveIntegrationStatus, surfaceBindingId } from "../adapters/socialSurface.js";
import { configuredEmailTransport, emailDeliveryOn, maskEmailAddress, normaliseEmailAddress, buildVerificationEmail } from "./email.js";

/**
 * Owner email addresses for notices (ADR 0074). An address is added by a code that the owner receives at that address, so
 * nobody can make the server send notices to someone else's address by typing it. Only a verified address receives notices.
 *
 * The rules: a code is six digits, valid for 10 minutes, and stored only as a salted SHA-256. A new code replaces the old one.
 * Five wrong codes end the code, and a new one is needed. At most three codes per address per workspace per hour are sent.
 * An audit row names the address only in masked form. No row, log or response carries a code.
 */

export const CODE_TTL_MINUTES = 10;
export const MAX_SENDS_PER_HOUR = 3;
export const MAX_ATTEMPTS = 5;

const engine = new WorkflowEngine();

export type OwnerEmailErrorCode =
  | "EMAIL_NOT_CONFIGURED"
  | "INVALID_INPUT"
  | "EMAIL_NOT_FOUND"
  | "EMAIL_SEND_LIMITED"
  | "EMAIL_SEND_FAILED"
  | "EMAIL_CODE_INVALID"
  | "EMAIL_CODE_EXPIRED"
  | "EMAIL_ATTEMPTS_EXCEEDED";

/** A refusal with its HTTP status. The message is safe to show: it never names a code, a key or a full address. */
export class OwnerEmailError extends Error {
  readonly code: OwnerEmailErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(code: OwnerEmailErrorCode, status: number, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "OwnerEmailError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export type OwnerEmailStatus = "pending" | "verified";

export interface OwnerEmailSummary {
  id: string;
  email: string;
  status: OwnerEmailStatus;
  expiresAt: string | null;
  verifiedAt: string | null;
  attemptsRemaining: number | null;
  createdAt: string;
}

interface OwnerEmailRow {
  id: string;
  workspace_id: string;
  email: string;
  code_salt: string | null;
  code_hash: string | null;
  code_expires_at: Date | null;
  attempts: number;
  verified_at: Date | null;
  binding_id: string | null;
  created_at: Date;
  removed_at: Date | null;
}

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

function requireDelivery(): void {
  if (!emailDeliveryOn()) {
    throw new OwnerEmailError("EMAIL_NOT_CONFIGURED", 503, "Email notices are not set up on this server. Nothing was sent.");
  }
}

/** The channels view: whether email is on for this server, and the workspace's email addresses (never a code or a hash). */
export async function listNotificationChannels(workspaceId: string): Promise<{
  emailDelivery: "on" | "simulated";
  emails: OwnerEmailSummary[];
}> {
  const res = await query<OwnerEmailRow>(
    `SELECT id, workspace_id, email, code_salt, code_hash, code_expires_at, attempts, verified_at, binding_id, created_at, removed_at
       FROM owner_emails WHERE workspace_id = $1 AND removed_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 100;`,
    [workspaceId]
  );
  return {
    emailDelivery: emailDeliveryOn() ? "on" : "simulated",
    emails: res.rows.map(summaryOf),
  };
}

function summaryOf(row: OwnerEmailRow): OwnerEmailSummary {
  const verified = row.verified_at !== null;
  return {
    id: row.id,
    email: row.email,
    status: verified ? "verified" : "pending",
    expiresAt: verified || !row.code_expires_at ? null : row.code_expires_at.toISOString(),
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    attemptsRemaining: verified ? null : Math.max(0, MAX_ATTEMPTS - row.attempts),
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Starts (or re-sends) the verification for an address. The response shape is the same whether or not the address is
 * verified elsewhere, because the check is only within this workspace. An address already verified here is answered as
 * verified and nothing is sent.
 */
export async function requestOwnerEmailVerification(
  workspaceId: string,
  rawEmail: unknown,
  actorLabel: string
): Promise<{ id: string; email: string; status: OwnerEmailStatus; expiresAt: string | null }> {
  requireDelivery();
  const email = normaliseEmailAddress(rawEmail);
  if (!email) throw new OwnerEmailError("INVALID_INPUT", 400, "email must be a valid address of up to 120 characters.");

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const prepared = await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO owner_emails (id, workspace_id, added_by, email) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, email) WHERE removed_at IS NULL DO NOTHING;`,
      [newId("oem"), workspaceId, actorLabel, email]
    );
    // Locks the live row, so two requests for one address run one after the other.
    const row = (
      await client.query<OwnerEmailRow>(
        `SELECT id, workspace_id, email, code_salt, code_hash, code_expires_at, attempts, verified_at, binding_id, created_at, removed_at
           FROM owner_emails WHERE workspace_id = $1 AND email = $2 AND removed_at IS NULL FOR UPDATE;`,
        [workspaceId, email]
      )
    ).rows[0];
    if (!row) throw new Error("owner email row missing after insert");
    if (row.verified_at) {
      return { kind: "verified" as const, row };
    }

    const sends = (
      await client.query<{ n: number; retry_after: number | null }>(
        `SELECT COUNT(*)::int AS n,
                CEIL(EXTRACT(EPOCH FROM (MIN(sent_at) + INTERVAL '1 hour' - NOW())))::int AS retry_after
           FROM owner_email_sends WHERE workspace_id = $1 AND email = $2 AND sent_at > NOW() - INTERVAL '1 hour';`,
        [workspaceId, email]
      )
    ).rows[0];
    if (sends.n >= MAX_SENDS_PER_HOUR) {
      throw new OwnerEmailError(
        "EMAIL_SEND_LIMITED",
        429,
        "Too many codes were sent to this address. Try again later.",
        Math.max(1, sends.retry_after ?? 60)
      );
    }

    const salt = randomBytes(16).toString("hex");
    const updated = await client.query<OwnerEmailRow>(
      `UPDATE owner_emails
          SET code_salt = $2, code_hash = $3, code_expires_at = NOW() + make_interval(mins => $4), attempts = 0
        WHERE id = $1
        RETURNING id, workspace_id, email, code_salt, code_hash, code_expires_at, attempts, verified_at, binding_id, created_at, removed_at;`,
      [row.id, salt, sha256Hex(`${salt}:${code}`), CODE_TTL_MINUTES]
    );
    await client.query(`INSERT INTO owner_email_sends (id, workspace_id, email) VALUES ($1, $2, $3);`, [newId("oes"), workspaceId, email]);
    return { kind: "pending" as const, row: updated.rows[0] };
  });

  if (prepared.kind === "verified") {
    return { id: prepared.row.id, email, status: "verified", expiresAt: null };
  }

  const masked = maskEmailAddress(email);
  try {
    await configuredEmailTransport().send({
      to: email,
      ...buildVerificationEmail({ code, expiresMinutes: CODE_TTL_MINUTES }),
    });
  } catch (err) {
    // The row keeps its code, which the owner never received. A new request sends a new one (and counts against the limit).
    await engine.recordAudit(
      workspaceId,
      null,
      "owner",
      actorLabel,
      EffectClass.EXTERNAL_REQUEST,
      "notification.email_send_failed",
      PolicyDecision.ALLOW,
      { emailId: prepared.row.id, maskedEmail: masked, error: boundedErrorMessage(err) }
    );
    throw new OwnerEmailError("EMAIL_SEND_FAILED", 502, "The verification email could not be sent. Try again.");
  }
  await engine.recordAudit(workspaceId, null, "owner", actorLabel, EffectClass.EXTERNAL_REQUEST, "notification.email_code_sent", PolicyDecision.ALLOW, {
    emailId: prepared.row.id,
    maskedEmail: masked,
  });
  return {
    id: prepared.row.id,
    email,
    status: "pending",
    expiresAt: prepared.row.code_expires_at ? prepared.row.code_expires_at.toISOString() : null,
  };
}

/**
 * Checks a code. On success the address is verified, and (when none exists) the owner's email surface binding is created
 * in the same transaction. Verifying an address that is already verified changes nothing and says so.
 */
export async function verifyOwnerEmail(
  workspaceId: string,
  emailId: string,
  rawCode: unknown,
  actorLabel: string
): Promise<{ id: string; email: string; status: "verified"; verifiedAt: string }> {
  requireDelivery();
  if (typeof rawCode !== "string" || !/^\d{6}$/.test(rawCode)) {
    throw new OwnerEmailError("INVALID_INPUT", 400, "code must be six digits.");
  }

  type Outcome =
    | { kind: "not_found" }
    | { kind: "already_verified"; row: OwnerEmailRow }
    | { kind: "attempts_exceeded"; row: OwnerEmailRow }
    | { kind: "expired"; row: OwnerEmailRow }
    | { kind: "wrong"; row: OwnerEmailRow; attempts: number }
    | { kind: "verified"; row: OwnerEmailRow; bindingCreated: boolean; verifiedAt: Date };

  const outcome: Outcome = await withTransaction(async (client: PoolClient) => {
    const row = (
      await client.query<OwnerEmailRow>(
        `SELECT id, workspace_id, email, code_salt, code_hash, code_expires_at, attempts, verified_at, binding_id, created_at, removed_at,
                (code_expires_at IS NOT NULL AND code_expires_at > NOW()) AS code_live
           FROM owner_emails WHERE id = $1 AND workspace_id = $2 AND removed_at IS NULL FOR UPDATE;`,
        [emailId, workspaceId]
      )
    ).rows[0] as (OwnerEmailRow & { code_live: boolean }) | undefined;
    if (!row) return { kind: "not_found" };
    if (row.verified_at) return { kind: "already_verified", row };
    if (row.attempts >= MAX_ATTEMPTS) return { kind: "attempts_exceeded", row };
    if (!row.code_hash || !row.code_salt || !row.code_live) return { kind: "expired", row };

    // Constant-time comparison of two fixed-length digests.
    const given = Buffer.from(sha256Hex(`${row.code_salt}:${rawCode}`), "hex");
    const stored = Buffer.from(row.code_hash, "hex");
    if (!timingSafeEqual(given, stored)) {
      const updated = await client.query<{ attempts: number }>(
        `UPDATE owner_emails SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts;`,
        [row.id]
      );
      return { kind: "wrong", row, attempts: updated.rows[0].attempts };
    }

    const verifiedRow = (
      await client.query<{ verified_at: Date }>(
        `UPDATE owner_emails SET verified_at = NOW(), code_salt = NULL, code_hash = NULL, code_expires_at = NULL, attempts = 0
          WHERE id = $1 RETURNING verified_at;`,
        [row.id]
      )
    ).rows[0];
    // The surface binding that the existing recipient path reads. It is created only when none exists, so an owner's or a
    // staff member's own binding for this address is never changed here (its role and status stay as they were).
    const existing = (
      await client.query<{ id: string }>(
        `SELECT id FROM surface_bindings WHERE workspace_id = $1 AND surface = 'email' AND actor_id = $2 LIMIT 1;`,
        [workspaceId, row.email]
      )
    ).rows[0];
    let bindingCreated = false;
    if (!existing) {
      const bindingId = surfaceBindingId(workspaceId, "email", row.email);
      await client.query(
        `INSERT INTO surface_bindings (id, workspace_id, surface, actor_id, actor_label, actor_role, integration_status, created_at, updated_at)
         VALUES ($1, $2, 'email', $3, $3, 'owner', $4, NOW(), NOW());`,
        [bindingId, workspaceId, row.email, effectiveIntegrationStatus("verified")]
      );
      await client.query(`UPDATE owner_emails SET binding_id = $2 WHERE id = $1;`, [row.id, bindingId]);
      bindingCreated = true;
    }
    return { kind: "verified", row, bindingCreated, verifiedAt: verifiedRow.verified_at };
  });

  const masked = (row: OwnerEmailRow) => maskEmailAddress(row.email);
  switch (outcome.kind) {
    case "not_found":
      throw new OwnerEmailError("EMAIL_NOT_FOUND", 404, "That email address was not found for this workspace.");
    case "already_verified":
      return { id: outcome.row.id, email: outcome.row.email, status: "verified", verifiedAt: outcome.row.verified_at!.toISOString() };
    case "attempts_exceeded":
      throw new OwnerEmailError("EMAIL_ATTEMPTS_EXCEEDED", 409, "Too many wrong codes. Ask for a new one.");
    case "expired":
      throw new OwnerEmailError("EMAIL_CODE_EXPIRED", 409, "The code has expired. Ask for a new one.");
    case "wrong": {
      await engine.recordAudit(workspaceId, null, "owner", actorLabel, EffectClass.EXTERNAL_REQUEST, "notification.email_verify_failed", PolicyDecision.ALLOW, {
        emailId: outcome.row.id,
        maskedEmail: masked(outcome.row),
        attempts: outcome.attempts,
      });
      if (outcome.attempts >= MAX_ATTEMPTS) {
        throw new OwnerEmailError("EMAIL_ATTEMPTS_EXCEEDED", 409, "Too many wrong codes. Ask for a new one.");
      }
      throw new OwnerEmailError("EMAIL_CODE_INVALID", 400, `The code is not right. ${MAX_ATTEMPTS - outcome.attempts} attempts left.`);
    }
    case "verified": {
      await engine.recordAudit(workspaceId, null, "owner", actorLabel, EffectClass.EXTERNAL_REQUEST, "notification.email_verified", PolicyDecision.ALLOW, {
        emailId: outcome.row.id,
        maskedEmail: masked(outcome.row),
        bindingCreated: outcome.bindingCreated,
      });
      return { id: outcome.row.id, email: outcome.row.email, status: "verified", verifiedAt: outcome.verifiedAt.toISOString() };
    }
  }
}

/**
 * Removes an address (soft). The surface binding it created goes with it; a binding that was there before stays.
 * An address that is removed stops receiving notices at once.
 */
export async function removeOwnerEmail(workspaceId: string, emailId: string, actorLabel: string): Promise<{ id: string; removed: true }> {
  const result = await withTransaction(async (client: PoolClient) => {
    const row = (
      await client.query<{ email: string; binding_id: string | null }>(
        `UPDATE owner_emails SET removed_at = NOW()
          WHERE id = $1 AND workspace_id = $2 AND removed_at IS NULL
          RETURNING email, binding_id;`,
        [emailId, workspaceId]
      )
    ).rows[0];
    if (!row) return null;
    if (row.binding_id) {
      await client.query(`DELETE FROM surface_bindings WHERE id = $1 AND workspace_id = $2 AND surface = 'email' AND actor_role = 'owner';`, [
        row.binding_id,
        workspaceId,
      ]);
    }
    await engine.recordAudit(
      workspaceId,
      null,
      "owner",
      actorLabel,
      EffectClass.EXTERNAL_REQUEST,
      "notification.email_removed",
      PolicyDecision.ALLOW,
      { emailId, maskedEmail: maskEmailAddress(row.email), bindingRemoved: row.binding_id !== null },
      undefined,
      client
    );
    return row;
  });
  if (!result) throw new OwnerEmailError("EMAIL_NOT_FOUND", 404, "That email address was not found for this workspace.");
  return { id: emailId, removed: true };
}
