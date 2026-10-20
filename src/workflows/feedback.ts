import type pg from "pg";
import { query, withTransaction } from "../db/client.js";
import { newId } from "../utils/ids.js";
import { summarizeTexts, type FeedbackSummary } from "./feedback-summary.js";
import { currentRequestId } from "../observability/request-context.js";

/**
 * Feedback ingestion (Task 9, ADR 0028). Guest and staff feedback is untrusted text. It is stored as data, counted by
 * summarizeFeedback, and returned by the reads. Nothing here, and nothing downstream, executes it or reads it as an
 * instruction. The audit row holds ids and flags only, never the text, the source or the external id.
 */

export type FeedbackErrorCode = "INVALID_INPUT";

/** A feedback operation that cannot be done. The message is the service's own text and never echoes the feedback. */
export class FeedbackError extends Error {
  readonly code: FeedbackErrorCode;

  constructor(code: FeedbackErrorCode, message?: string) {
    super(message ?? "Invalid input");
    this.name = "FeedbackError";
    this.code = code;
  }
}

export const FEEDBACK_TEXT_CHARACTERS = 2000;
const MAX_EXTERNAL_ID_CHARACTERS = 120;
const SOURCE_PATTERN = /^[a-z][a-z0-9_.:-]{1,39}$/;
const LIST_LIMIT = 100;

export interface FeedbackItemView {
  id: string;
  source: string;
  externalId: string;
  text: string;
  truncated: boolean;
  createdAt: Date;
}

function invalid(message: string): never {
  throw new FeedbackError("INVALID_INPUT", message);
}

/** Writes one audit row in the caller's transaction. The evidence holds ids and the source, never the feedback text. */
async function writeAudit(
  client: pg.PoolClient,
  workspaceId: string,
  actorId: string,
  action: string,
  evidence: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at, request_id)
     VALUES ($1, $2, NULL, 'system', $3, 'read', $4, 'ALLOW', $5::jsonb, NOW(), $6);`,
    [newId("audit"), workspaceId, actorId, action, JSON.stringify(evidence), currentRequestId()]
  );
}

/**
 * Stores one feedback item. A repeat of (source, externalId) in the workspace returns the stored id with `duplicate: true`
 * and stores nothing. Two concurrent first deliveries are one row: the second waits on the first insert and then finds it.
 */
export async function ingestFeedback(input: {
  workspaceId: string;
  source: string;
  externalId: string;
  text: string;
}): Promise<{ id: string; duplicate: boolean }> {
  const { workspaceId } = input;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) invalid("workspaceId is required.");
  if (typeof input.source !== "string" || !SOURCE_PATTERN.test(input.source)) {
    invalid("source must be 2 to 40 characters: a lowercase letter first, then lowercase letters, digits, '_', '.', ':' or '-'.");
  }
  const externalId = typeof input.externalId === "string" ? input.externalId.trim() : "";
  if (externalId.length === 0 || Array.from(externalId).length > MAX_EXTERNAL_ID_CHARACTERS) {
    invalid(`externalId must be 1 to ${MAX_EXTERNAL_ID_CHARACTERS} characters.`);
  }
  if (typeof input.text !== "string") invalid("text must be a string.");
  const trimmed = input.text.trim();
  if (trimmed.length === 0) invalid("text is required.");
  if (trimmed.includes("\u0000")) invalid("text contains a character that cannot be stored.");
  const characters = Array.from(trimmed);
  const truncated = characters.length > FEEDBACK_TEXT_CHARACTERS;
  const text = truncated ? characters.slice(0, FEEDBACK_TEXT_CHARACTERS).join("") : trimmed;

  return withTransaction(async (client) => {
    const id = newId("fb");
    const inserted = await client.query(
      `INSERT INTO feedback_items (id, workspace_id, source, external_id, text, truncated)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, source, external_id) DO NOTHING
       RETURNING id;`,
      [id, workspaceId, input.source, externalId, text, truncated]
    );
    if (inserted.rows.length === 0) {
      const existing = await client.query(
        `SELECT id FROM feedback_items WHERE workspace_id = $1 AND source = $2 AND external_id = $3;`,
        [workspaceId, input.source, externalId]
      );
      return { id: existing.rows[0].id as string, duplicate: true };
    }
    await writeAudit(client, workspaceId, "system:feedback", "feedback.ingested", { feedbackId: id, truncated });
    return { id, duplicate: false };
  });
}

/** The summary reads at most this many rows: the newest ones since `since` (ADR 0028). */
export const SUMMARY_ROW_LIMIT = 5000;

export interface FeedbackSummaryView extends FeedbackSummary {
  /** How many stored rows the summary was computed from. */
  rowsConsidered: number;
  /** True when more rows matched `since` than were considered, so the summary covers only the newest of them. */
  capped: boolean;
}

/**
 * The summary of the workspace's feedback received at or after `since`. It reads the newest SUMMARY_ROW_LIMIT rows (one
 * extra row tells whether the cap was hit), then passes them to the pure function in ascending order, so the sample is the
 * earliest of the rows considered. Reproducible from the stored rows.
 */
export async function summarizeFeedback(workspaceId: string, since: Date): Promise<FeedbackSummaryView> {
  if (!(since instanceof Date) || Number.isNaN(since.getTime())) invalid("since must be a valid date.");
  const res = await query(
    `SELECT id, text, created_at FROM feedback_items
     WHERE workspace_id = $1 AND created_at >= $2
     ORDER BY created_at DESC, id DESC LIMIT $3;`,
    [workspaceId, since, SUMMARY_ROW_LIMIT + 1]
  );
  const capped = res.rows.length > SUMMARY_ROW_LIMIT;
  const newest = res.rows.slice(0, SUMMARY_ROW_LIMIT).reverse();
  const summary = summarizeTexts(
    newest.map((r) => ({ id: r.id as string, text: r.text as string, createdAt: r.created_at as Date }))
  );
  return { ...summary, rowsConsidered: newest.length, capped };
}

/** The most recent feedback of the workspace, newest first. The text is returned as data. */
export async function listFeedback(workspaceId: string): Promise<FeedbackItemView[]> {
  const res = await query(
    `SELECT id, source, external_id, text, truncated, created_at FROM feedback_items
     WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2;`,
    [workspaceId, LIST_LIMIT]
  );
  return res.rows.map((r) => ({
    id: r.id as string,
    source: r.source as string,
    externalId: r.external_id as string,
    text: r.text as string,
    truncated: r.truncated === true,
    createdAt: r.created_at as Date,
  }));
}
