/**
 * The workspace event stream, its cursor and its envelope (docs/decisions/0035). An event is a persisted audit row: nothing
 * is invented, and an action that writes no audit row has no event.
 *
 * Cursor. An event id is "<txid>.<seq>": the transaction id that wrote the row, then the row's sequence number. Rows are
 * ordered by (txid, seq). A reader sees only rows whose transaction has finished: `txid < pg_snapshot_xmin(...)`, the
 * oldest transaction still running. A transaction that is still open holds back every later transaction too, so when it
 * commits, its row is delivered before any row that committed after it began. A sequence number alone would not be safe:
 * a transaction can take seq 5, another can take seq 6 and commit first, and a reader that had moved past 6 would never
 * see 5.
 *
 * Envelope. The audit action is the event type. `data` is the audit evidence reduced to an allowlist of keys and value
 * shapes, then redacted. Free text (reason, error, note, label, message, rationale, raw objects) is never sent.
 *
 * Staff do not receive events whose type starts with auth., connector. or kitchen_capacity.; an owner receives all.
 */
import { query } from "../db/client.js";
import { redactDeep, redactText } from "../utils/redact.js";
import { EVENT_CATALOGUE, eventNameOf } from "./event-catalogue.js";

export const ZERO_CURSOR = "0.0";
export const DEFAULT_POLL_LIMIT = 50;
export const MAX_POLL_LIMIT = 200;

const CURSOR_PATTERN = /^(\d{1,19})\.(\d{1,19})$/;
const BIGINT_MAX = 9223372036854775807n;

/**
 * The evidence keys that may leave the server (docs/decisions/0035). Identifiers, codes, statuses and quantities. Anything
 * else, including every free-text key, is dropped.
 */
const ALLOWED_EVIDENCE_KEY =
  /^(?:[A-Za-z]*Id|[A-Za-z]*Ids|status|state|fromState|toState|hold|code|codes|reasonCodes|kind|decision|connectorId|txHash|orderNumber|attempts|effectId|units|sku|channel|surface|promisedFor|slotId)$/;
const MAX_VALUE_CHARACTERS = 200;
const MAX_ARRAY_ITEMS = 20;

/** Event types staff never receive. The prefix includes its dot, so a type that only starts with the same letters is not hidden. */
const OWNER_ONLY_PREFIXES = ["auth.", "connector.", "kitchen_capacity."] as const;

export type WorkspaceRoleName = "owner" | "staff";

/** A parsed cursor. The parts are decimal strings, so they go to PostgreSQL unchanged. */
export interface EventCursor {
  txid: string;
  seq: string;
}

/**
 * Reads "<txid>.<seq>". Anything else is null: digits only, at most 19 digits each, and no value above the largest bigint
 * (PostgreSQL could not compare it). The result is normalised, so "007.1" and "7.1" are the same cursor.
 */
export function parseCursor(raw: unknown): EventCursor | null {
  if (typeof raw !== "string") return null;
  const match = CURSOR_PATTERN.exec(raw);
  if (match === null) return null;
  const txid = BigInt(match[1]);
  const seq = BigInt(match[2]);
  if (txid > BIGINT_MAX || seq > BIGINT_MAX) return null;
  return { txid: txid.toString(), seq: seq.toString() };
}

/** The event id for a transaction id and a sequence number. */
export function formatCursor(txid: string | number | bigint, seq: string | number | bigint): string {
  return `${String(txid)}.${String(seq)}`;
}

/** The fields of an audit row the stream reads. The cursor parts are text, as PostgreSQL sends them. */
export interface AuditRowForEvents {
  cursor_txid: string;
  cursor_seq: string;
  created_at: Date | string;
  action: string;
  effect_class: string;
  policy_decision: string;
  actor_type: string;
  actor_id: string;
  workflow_id: string | null;
  evidence: unknown;
  tx_hash: string | null;
  workspace_id: string;
  request_id: string | null;
}

/** The public event (docs/EVENTS.md). Field names are camelCase, as the service views are (docs/decisions/0034). */
export interface EventEnvelope {
  id: string;
  type: string;
  /** The past-tense name (ADR 0053). */
  name: string;
  schemaVersion: 1;
  at: string;
  workspaceId: string;
  effectClass: string;
  decision: string;
  actor: { type: string; id: string };
  workflowId?: string;
  /** The main thing the event is about. `id` is null when the row carries none. */
  object?: { type: string; id: string | null };
  /** The request that caused the event, when the row recorded one. */
  correlationId?: string;
  data: Record<string, unknown>;
}

/** Whether a value of a key may be sent: a short string, a finite number, a boolean, or a short list of short strings. */
function allowedValue(value: unknown): boolean {
  if (typeof value === "string") return value.length <= MAX_VALUE_CHARACTERS;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) {
    return value.length <= MAX_ARRAY_ITEMS && value.every((item) => typeof item === "string" && item.length <= MAX_VALUE_CHARACTERS);
  }
  return false;
}

/**
 * The part of the audit evidence that leaves the server: allowed keys with allowed values, then redacted. The transaction
 * hash of the row is `txHash` when present. Never throws; anything that is not an object gives no keys.
 */
export function eventData(evidence: unknown, txHash: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (evidence !== null && typeof evidence === "object" && !Array.isArray(evidence)) {
    for (const [key, value] of Object.entries(evidence as Record<string, unknown>)) {
      if (ALLOWED_EVIDENCE_KEY.test(key) && allowedValue(value)) out[key] = value;
    }
  }
  if (txHash !== null) out.txHash = txHash;
  return redactDeep(out);
}

/** Whether a role may receive an event type (docs/decisions/0035). */
export function isVisibleToRole(role: WorkspaceRoleName, type: string): boolean {
  if (role === "owner") return true;
  return !OWNER_ONLY_PREFIXES.some((prefix) => type.startsWith(prefix));
}

/** The id of the thing an event is about: the `<object>Id` evidence key, or the workflow id for a workflow event. */
function objectIdOf(object: string, workflowId: string | null, data: Record<string, unknown>): string | null {
  const camel = object.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  const direct = data[`${camel}Id`];
  if (typeof direct === "string" && direct.length > 0 && direct.length <= 128) return direct;
  if (object === "workflow" && workflowId) return workflowId;
  return null;
}

/** Only a safe request id is sent as correlationId. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The envelope of an audit row. Pure: the cursor comes from the row's txid and seq. */
export function mapAuditRow(row: AuditRowForEvents): EventEnvelope {
  const createdAt = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  const data = eventData(row.evidence, row.tx_hash);
  const object = EVENT_CATALOGUE[row.action]?.object;
  return {
    id: formatCursor(row.cursor_txid, row.cursor_seq),
    type: row.action,
    name: eventNameOf(row.action),
    schemaVersion: 1,
    at: createdAt.toISOString(),
    workspaceId: row.workspace_id,
    effectClass: row.effect_class,
    decision: row.policy_decision,
    actor: { type: row.actor_type, id: redactText(row.actor_id) },
    ...(row.workflow_id !== null ? { workflowId: row.workflow_id } : {}),
    ...(object ? { object: { type: object, id: objectIdOf(object, row.workflow_id, data) } } : {}),
    ...(row.request_id !== null && SAFE_REQUEST_ID.test(row.request_id) ? { correlationId: row.request_id } : {}),
    data,
  };
}

export interface ReadOptions {
  /** True for an owner. Staff do not receive the owner-only event types. */
  includeSensitive: boolean;
}

/**
 * A page of events. `events` are the ones the caller may see. `lastCursor` is the id of the last row read, including rows
 * a staff caller does not see, so a page of hidden rows still moves the cursor on. `more` is true when rows remain after
 * this page. When nothing was read, `lastCursor` is the cursor that was asked for.
 */
export interface EventPage {
  events: EventEnvelope[];
  lastCursor: string;
  more: boolean;
}

// The cursor parts are returned under other names: an output alias called txid would shadow the column in ORDER BY, and the
// order would then be the order of the text. (Found by EXPLAIN; see docs/decisions/0035, "Index plan".)
const COLUMNS = `txid::text AS cursor_txid, seq::text AS cursor_seq, created_at, action, effect_class, policy_decision,
  actor_type, actor_id, workflow_id, evidence, tx_hash, workspace_id, request_id`;

/** Only rows whose transaction has finished (docs/decisions/0035). The horizon is the oldest transaction still running. */
const FINISHED = `workspace_id = $1 AND txid < pg_snapshot_xmin(pg_current_snapshot())`;

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_POLL_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_POLL_LIMIT}`);
  }
}

function cursorOf(row: { cursor_txid: string; cursor_seq: string }): string {
  return formatCursor(row.cursor_txid, row.cursor_seq);
}

function pageOf(
  rows: AuditRowForEvents[],
  limit: number,
  options: ReadOptions,
  fallbackCursor: string
): EventPage {
  const more = rows.length > limit;
  const kept = rows.slice(0, limit);
  const lastCursor = kept.length > 0 ? cursorOf(kept[kept.length - 1]) : fallbackCursor;
  const events = kept
    .filter((row) => options.includeSensitive || isVisibleToRole("staff", row.action))
    .map(mapAuditRow);
  return { events, lastCursor, more };
}

/**
 * The finished events of a workspace after a cursor, in (txid, seq) order, at most `limit` of them. The query reads one row
 * more than `limit`, to know whether more remain.
 */
export async function readEvents(
  workspaceId: string,
  after: string,
  limit: number,
  options: ReadOptions
): Promise<EventPage> {
  const cursor = parseCursor(after);
  if (cursor === null) throw new RangeError("readEvents: the cursor is malformed");
  assertLimit(limit);
  const res = await query<AuditRowForEvents>(
    `SELECT ${COLUMNS} FROM audit_logs
     WHERE ${FINISHED} AND (txid, seq) > ($2::text::xid8, $3::bigint)
     ORDER BY txid, seq
     LIMIT $4;`,
    [workspaceId, cursor.txid, cursor.seq, limit + 1]
  );
  return pageOf(res.rows, limit, options, formatCursor(cursor.txid, cursor.seq));
}

/**
 * The newest finished events of a workspace, in ascending order, at most `limit`. `more` is false: this read is the end of
 * the history it returns, and older rows are not paged by it.
 */
export async function readLatestEvents(workspaceId: string, limit: number, options: ReadOptions): Promise<EventPage> {
  assertLimit(limit);
  const res = await query<AuditRowForEvents>(
    `SELECT ${COLUMNS} FROM audit_logs
     WHERE ${FINISHED}
     ORDER BY txid DESC, seq DESC
     LIMIT $2;`,
    [workspaceId, limit]
  );
  // The newest row is first in this result. The page is returned oldest first, and its cursor is the newest row read.
  const newestFirst = res.rows;
  const lastCursor = newestFirst.length > 0 ? cursorOf(newestFirst[0]) : ZERO_CURSOR;
  const ascending = newestFirst.slice().reverse();
  const events = ascending
    .filter((row) => options.includeSensitive || isVisibleToRole("staff", row.action))
    .map(mapAuditRow);
  return { events, lastCursor, more: false };
}

/**
 * The cursor of the newest finished row of a workspace, or "0.0" when there is none. A new stream starts here, so it does
 * not replay history (docs/decisions/0035).
 */
export async function latestCursor(workspaceId: string): Promise<string> {
  const res = await query<{ cursor_txid: string; cursor_seq: string }>(
    `SELECT txid::text AS cursor_txid, seq::text AS cursor_seq FROM audit_logs
     WHERE ${FINISHED}
     ORDER BY txid DESC, seq DESC
     LIMIT 1;`,
    [workspaceId]
  );
  return res.rows.length > 0 ? cursorOf(res.rows[0]) : ZERO_CURSOR;
}
