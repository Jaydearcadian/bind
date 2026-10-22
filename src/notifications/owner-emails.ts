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
 * Limits, all enforced here in the database transaction:
 * - a code is six digits, valid 10 minutes, stored only as a salted SHA-256; a new request replaces the code;
 * - five wrong guesses end a code (per code);
 * - ten wrong guesses per address per 24 hours, across codes and re-sends, then the address is refused until the window
 *   passes (reset only by a successful verification);
 * - three codes per address per hour, five distinct addresses per workspace per 24 hours, ten codes per workspace per 24 hours;
 * - a demo workspace sends no email at all.
 * No row, log or response carries a code, and an audit row carries the address only in masked form.
 */

export const CODE_TTL_MINUTES = 10;
/** Codes sent to one address in one hour. */
export const MAX_SENDS_PER_HOUR = 3;
/** Wrong guesses for one code. */
export const MAX_ATTEMPTS = 5;
/** Distinct addresses a workspace may ask codes for in 24 hours. */
export const MAX_DISTINCT_ADDRESSES_PER_DAY = 5;
/** Codes a workspace may send in 24 hours. */
export const MAX_SENDS_PER_DAY = 10;
/** Wrong guesses for one address in 24 hours, across all its codes. */
export const MAX_FAILED_GUESSES_PER_DAY = 10;

const engine = new WorkflowEngine();

export type OwnerEmailErrorCode =
  | "EMAIL_NOT_CONFIGURED"
  | "EMAIL_DEMO_REFUSED"
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

const DEMO_REFUSED_MESSAGE = "Demo workspaces do not send email. Use a real workspace to get owner notices by email.";
const GUESSES_REFUSED_MESSAGE = "Too many wrong codes for this address. Try again in a day.";
const NOT_FOUND_MESSAGE = "That email address was not found for this workspace.";

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

function requireDelivery(): void {
  if (!emailDeliveryOn()) {
    throw new OwnerEmailError("EMAIL_NOT_CONFIGURED", 503, "Email notices are not set up on this server. Nothing was sent.");
  }
}

/** Demo workspaces never send or verify email (ADR 0057, ADR 0074). Throws inside the caller's transaction. */
async function refuseDemo(client: PoolClient, workspaceId: string): Promise<void> {
  const res = await client.query<{ is_demo: boolean }>(`SELECT is_demo FROM workspaces WHERE id = $1;`, [workspaceId]);
  if (res.rows[0]?.is_demo === true) {
    throw new OwnerEmailError("EMAIL_DEMO_REFUSED", 403, DEMO_REFUSED_MESSAGE);
  }
}

/**
 * The channels view: whether email is on for this server, and the workspace's email addresses (never a code or a hash).
 */
export async function listNotificationChannels(workspaceId: string): Promise<{
  emailDelivery: "on" | "simulated";
  emails: OwnerEmailSummary[];
}> {
  const res = await query<OwnerEmailRow>(
    `SELECT id, workspace_id, email, code_expires_at, attempts, verified_at, binding_id, created_at, removed_at
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
 * Starts (or re-sends) the verification for an address. The answer has the same shape whether or not the address is
 * verified elsewhere, because every check is within this workspace. An address already verified here is answered as
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
    await refuseDemo(client, workspaceId);
    // One request at a time per workspace: the workspace-wide caps below are counted, then a send is recorded, in one step.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0));`, [`owner_email:${workspaceId}`]);
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

    const guesses = (
      await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM owner_email_failures
          WHERE workspace_id = $1 AND email = $2 AND failed_at > NOW() - INTERVAL '1 day';`,
        [workspaceId, email]
      )
    ).rows[0];
    if (guesses.n >= MAX_FAILED_GUESSES_PER_DAY) {
      throw new OwnerEmailError("EMAIL_ATTEMPTS_EXCEEDED", 409, GUESSES_REFUSED_MESSAGE);
    }

    // The workspace's sends in the last 24 hours: the total, the distinct addresses, and when the oldest one ages out.
    const day = (
      await client.query<{ total: number; distinct_n: number; for_address: number; retry_after: number | null }>(
        `SELECT COUNT(*)::int AS total,
                COUNT(DISTINCT email)::int AS distinct_n,
                COUNT(*) FILTER (WHERE email = $2)::int AS for_address,
                CEIL(EXTRACT(EPOCH FROM (MIN(sent_at) + INTERVAL '1 day' - NOW())))::int AS retry_after
           FROM owner_email_sends WHERE workspace_id = $1 AND sent_at > NOW() - INTERVAL '1 day';`,
        [workspaceId, email]
      )
    ).rows[0];
    const dayRetry = Math.max(1, day.retry_after ?? 3600);
    if (day.total >= MAX_SENDS_PER_DAY) {
      throw new OwnerEmailError("EMAIL_SEND_LIMITED", 429, "This workspace has sent its verification codes for today. Try again later.", dayRetry);
    }
    if (day.for_address === 0 && day.distinct_n >= MAX_DISTINCT_ADDRESSES_PER_DAY) {
      throw new OwnerEmailError(
        "EMAIL_SEND_LIMITED",
        429,
        `This workspace has asked for codes for ${MAX_DISTINCT_ADDRESSES_PER_DAY} addresses today. Try again later.`,
        dayRetry
      );
    }

    const hour = (
      await client.query<{ n: number; retry_after: number | null }>(
        `SELECT COUNT(*)::int AS n,
                CEIL(EXTRACT(EPOCH FROM (MIN(sent_at) + INTERVAL '1 hour' - NOW())))::int AS retry_after
           FROM owner_email_sends WHERE workspace_id = $1 AND email = $2 AND sent_at > NOW() - INTERVAL '1 hour';`,
        [workspaceId, email]
      )
    ).rows[0];
    if (hour.n >= MAX_SENDS_PER_HOUR) {
      throw new OwnerEmailError(
        "EMAIL_SEND_LIMITED",
        429,
        "Too many codes were sent to this address. Try again later.",
        Math.max(1, hour.retry_after ?? 60)
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
    // The row keeps its code, which the owner never received. A new request sends a new one (and counts against the limits).
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
 * in the same transaction, with ON CONFLICT DO NOTHING so a concurrent /surfaces write never makes this fail. Verifying an
 * address that is already verified changes nothing and says so.
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
    | { kind: "guesses_refused"; row: OwnerEmailRow }
    | { kind: "attempts_exceeded"; row: OwnerEmailRow }
    | { kind: "expired"; row: OwnerEmailRow }
    | { kind: "wrong"; row: OwnerEmailRow; attempts: number }
    | { kind: "verified"; row: OwnerEmailRow; bindingCreated: boolean; verifiedAt: Date };

  const outcome: Outcome = await withTransaction(async (client: PoolClient) => {
    await refuseDemo(client, workspaceId);
    const row = (
      await client.query<OwnerEmailRow & { code_live: boolean }>(
        `SELECT id, workspace_id, email, code_salt, code_hash, code_expires_at, attempts, verified_at, binding_id, created_at, removed_at,
                (code_expires_at IS NOT NULL AND code_expires_at > NOW()) AS code_live
           FROM owner_emails WHERE id = $1 AND workspace_id = $2 AND removed_at IS NULL FOR UPDATE;`,
        [emailId, workspaceId]
      )
    ).rows[0];
    if (!row) return { kind: "not_found" };
    if (row.verified_at) return { kind: "already_verified", row };

    const guesses = (
      await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM owner_email_failures
          WHERE workspace_id = $1 AND email = $2 AND failed_at > NOW() - INTERVAL '1 day';`,
        [workspaceId, row.email]
      )
    ).rows[0];
    if (guesses.n >= MAX_FAILED_GUESSES_PER_DAY) return { kind: "guesses_refused", row };
    if (row.attempts >= MAX_ATTEMPTS) return { kind: "attempts_exceeded", row };
    if (!row.code_hash || !row.code_salt || !row.code_live) return { kind: "expired", row };

    // Constant-time comparison of two fixed-length digests.
    const given = Buffer.from(sha256Hex(`${row.code_salt}:${rawCode}`), "hex");
    const stored = Buffer.from(row.code_hash, "hex");
    if (!timingSafeEqual(given, stored)) {
      // The row lock serialises concurrent guesses, so the count is exact.
      const updated = await client.query<{ attempts: number }>(
        `UPDATE owner_emails SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts;`,
        [row.id]
      );
      await client.query(`INSERT INTO owner_email_failures (id, workspace_id, email) VALUES ($1, $2, $3);`, [newId("oef"), workspaceId, row.email]);
      return { kind: "wrong", row, attempts: updated.rows[0].attempts };
    }

    const verifiedRow = (
      await client.query<{ verified_at: Date }>(
        `UPDATE owner_emails SET verified_at = NOW(), code_salt = NULL, code_hash = NULL, code_expires_at = NULL, attempts = 0
          WHERE id = $1 RETURNING verified_at;`,
        [row.id]
      )
    ).rows[0];
    // A successful verification clears the address's wrong-guess history.
    await client.query(`DELETE FROM owner_email_failures WHERE workspace_id = $1 AND email = $2;`, [workspaceId, row.email]);

    // The binding the existing recipient path reads. It is created only when none exists, and a concurrent /surfaces write is
    // never a reason to fail (ON CONFLICT DO NOTHING). Its updated_at is kept as a marker: removal deletes the binding only
    // while it is unchanged, so a binding the owner touches later through /surfaces survives.
    const bindingId = surfaceBindingId(workspaceId, "email", row.email);
    const created = await client.query<{ id: string }>(
      `INSERT INTO surface_bindings (id, workspace_id, surface, actor_id, actor_label, actor_role, integration_status, created_at, updated_at)
       VALUES ($1, $2, 'email', $3, $3, 'owner', $4, NOW(), NOW())
       ON CONFLICT (workspace_id, surface, actor_id) DO NOTHING
       RETURNING id;`,
      [bindingId, workspaceId, row.email, effectiveIntegrationStatus("verified")]
    );
    const bindingCreated = created.rows.length === 1;
    if (bindingCreated) {
      await client.query(
        `UPDATE owner_emails AS oe SET binding_id = sb.id, binding_marker = sb.updated_at
           FROM surface_bindings AS sb
          WHERE oe.id = $1 AND sb.id = $2;`,
        [row.id, bindingId]
      );
    }
    return { kind: "verified", row, bindingCreated, verifiedAt: verifiedRow.verified_at };
  });

  const masked = (row: OwnerEmailRow) => maskEmailAddress(row.email);
  switch (outcome.kind) {
    case "not_found":
      throw new OwnerEmailError("EMAIL_NOT_FOUND", 404, NOT_FOUND_MESSAGE);
    case "already_verified":
      return { id: outcome.row.id, email: outcome.row.email, status: "verified", verifiedAt: outcome.row.verified_at!.toISOString() };
    case "guesses_refused":
      throw new OwnerEmailError("EMAIL_ATTEMPTS_EXCEEDED", 409, GUESSES_REFUSED_MESSAGE);
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
      // The fifth wrong guess is still a wrong code (0 attempts left). Only a guess after that is refused as exceeded.
      throw new OwnerEmailError(
        "EMAIL_CODE_INVALID",
        400,
        `The code is not right. ${Math.max(0, MAX_ATTEMPTS - outcome.attempts)} attempts left.`
      );
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
 * Removes an address (soft). An address stops receiving notices at once. The surface binding is deleted only when this row
 * created it and the binding has not been changed since (its updated_at is still the marker). A binding that existed before,
 * or that the owner set through /surfaces afterwards, is left in place.
 */
export async function removeOwnerEmail(workspaceId: string, emailId: string, actorLabel: string): Promise<{ id: string; removed: true }> {
  const result = await withTransaction(async (client: PoolClient) => {
    const row = (
      await client.query<{ email: string; binding_id: string | null; binding_removed: boolean }>(
        `WITH removed AS (
           UPDATE owner_emails SET removed_at = NOW()
            WHERE id = $1 AND workspace_id = $2 AND removed_at IS NULL
            RETURNING email, binding_id, binding_marker
         ), deleted AS (
           DELETE FROM surface_bindings sb
            USING removed r
            WHERE r.binding_id IS NOT NULL AND sb.id = r.binding_id AND sb.workspace_id = $2
              AND sb.surface = 'email' AND sb.actor_role = 'owner'
              AND r.binding_marker IS NOT NULL AND sb.updated_at = r.binding_marker
            RETURNING sb.id
         )
         SELECT r.email, r.binding_id, EXISTS (SELECT 1 FROM deleted) AS binding_removed FROM removed r;`,
        [emailId, workspaceId]
      )
    ).rows[0];
    if (!row) return null;
    await engine.recordAudit(
      workspaceId,
      null,
      "owner",
      actorLabel,
      EffectClass.EXTERNAL_REQUEST,
      "notification.email_removed",
      PolicyDecision.ALLOW,
      { emailId, maskedEmail: maskEmailAddress(row.email), bindingRemoved: row.binding_removed },
      undefined,
      client
    );
    return row;
  });
  if (!result) throw new OwnerEmailError("EMAIL_NOT_FOUND", 404, NOT_FOUND_MESSAGE);
  return { id: emailId, removed: true };
}
