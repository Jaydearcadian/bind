import type pg from "pg";
import { query, withTransaction } from "../db/client.js";
import { requestHash } from "../effects/serialize.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PolicyEngine } from "../policy/engine.js";
import { PolicyDecision } from "../policy/types.js";
import { newId } from "../utils/ids.js";
import { acquireAdvisoryLock, type AdvisoryLock } from "../db/advisory-lock.js";
import { boundedErrorMessage } from "../effects/ledger.js";
import { sendOwnerNotification, type OwnerNoticeKind } from "../notifications/dispatch.js";
import { customerOrderLink } from "../notifications/links.js";
import { resolveOwnerRecipient } from "../notifications/recipients.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { ProcurementWorkflowRunner } from "./procurement.js";
import {
  decidePromise,
  type PromiseDecision,
  type PromiseFacts,
  type PromiseReasonRef,
} from "./fulfilment-promise.js";

/**
 * Customer orders, substantiated promises, stock reservations and kitchen capacity (Task 8a, ADR 0026).
 *
 * Every decision and every state change runs in one transaction under row locks, taken in this order:
 *   customer order row, then inventory rows by sku, then kitchen capacity rows by start time.
 * Creating an order inserts its row first, so a retried externalRef waits for the first attempt and then replays it.
 * The customer's note is data. It is stored, returned, and never read by a decision and never written to the audit log.
 */

export const CUSTOMER_ORDER_STATUSES = [
  "accepted",
  "partially_available",
  "declined",
  "needs_owner",
  "cancelled",
  "fulfilled",
] as const;
export type CustomerOrderStatus = (typeof CUSTOMER_ORDER_STATUSES)[number];

export type FulfilmentErrorCode =
  | "INVALID_INPUT"
  | "ORDER_NOT_FOUND"
  | "EXTERNAL_REF_REUSED"
  | "NOT_HELD"
  | "NOT_ACCEPTED"
  | "ALREADY_FULFILLED"
  | "CAPACITY_BELOW_USED"
  | "INSUFFICIENT_ON_HAND";

const ERROR_MESSAGES: Record<Exclude<FulfilmentErrorCode, "INVALID_INPUT">, string> = {
  ORDER_NOT_FOUND: "Order not found",
  EXTERNAL_REF_REUSED: "externalRef was already used for a different request",
  NOT_HELD: "Only an order held for the owner can be accepted by the owner",
  NOT_ACCEPTED: "Only an accepted order can be fulfilled",
  ALREADY_FULFILLED: "A fulfilled order cannot be cancelled",
  CAPACITY_BELOW_USED: "A slot cannot be lowered below its used units",
  INSUFFICIENT_ON_HAND: "On-hand stock is below the reserved quantity; nothing was fulfilled",
};

/** A customer order operation that cannot be done. The API maps the code to a status. */
export class FulfilmentError extends Error {
  readonly code: FulfilmentErrorCode;

  constructor(code: FulfilmentErrorCode, message?: string) {
    super(code === "INVALID_INPUT" ? message ?? "Invalid input" : ERROR_MESSAGES[code]);
    this.name = "FulfilmentError";
    this.code = code;
  }
}

/** The automated fulfilment role. Its decisions are checked against the role's grant. */
export interface AgentActor {
  kind: "agent";
  roleName: string;
}

/** The owner, by token label. A human owner's decision needs no role grant. */
export interface OwnerActor {
  kind: "owner";
  label: string;
}

/** A staff member, by token label. Staff may cancel and fulfil, never accept a held order or set capacity. */
export interface StaffActor {
  kind: "staff";
  label: string;
}

export type OperatorActor = OwnerActor | StaffActor;

export interface CustomerOrderLine {
  sku: string;
  quantity: number;
}

export interface CustomerOrderInput {
  workspaceId: string;
  externalRef: string;
  lines: CustomerOrderLine[];
  requestedFor?: Date;
  /** Untrusted customer text. Trimmed, truncated to 500 characters, stored as data only. */
  note?: string;
}

export interface AcceptResult {
  orderId: string;
  status: CustomerOrderStatus;
  promisedFor?: Date;
  reasons: PromiseReasonRef[];
  replayed: boolean;
}

export interface CustomerOrderView {
  orderId: string;
  externalRef: string;
  status: CustomerOrderStatus;
  requestedFor: Date | null;
  promisedFor: Date | null;
  reasons: PromiseReasonRef[];
  note: string | null;
  units: number;
  slotId: string | null;
  decidedBy: string | null;
  lines: CustomerOrderLine[];
  createdAt: Date;
  updatedAt: Date;
}

export interface KitchenSlotInput {
  startsAt: Date;
  endsAt: Date;
  capacityUnits: number;
}

export interface KitchenSlotView {
  id: string;
  startsAt: Date;
  endsAt: Date;
  capacityUnits: number;
  usedUnits: number;
  remainingUnits: number;
}

export const MAX_NOTE_CHARACTERS = 500;
const MAX_REF_CHARACTERS = 120;
const MAX_SKU_CHARACTERS = 120;
const MAX_SLOTS_PER_REQUEST = 200;
const MAX_CAPACITY_UNITS = 1_000_000;
const LIST_LIMIT = 100;
/** The restock trigger waits this long for another trigger on the same sku before it reports itself busy. */
const RESTOCK_LOCK_WAIT_MS = 5_000;
/** The trigger source recorded on a replenishment started from a customer order. */
const RESTOCK_TRIGGER_SOURCE = "customer_order";
/** startReplenishment refuses a paused workspace with a message that starts with this tag (ADR 0023). */
const PAUSED_MESSAGE_PREFIX = "[AGENTS_PAUSED]";

function invalid(message: string): never {
  throw new FulfilmentError("INVALID_INPUT", message);
}

function checkExternalRef(ref: unknown): string {
  if (typeof ref !== "string" || ref.length < 1 || ref.length > MAX_REF_CHARACTERS) {
    invalid(`externalRef must be 1 to ${MAX_REF_CHARACTERS} characters.`);
  }
  return ref;
}

function checkLines(lines: unknown): CustomerOrderLine[] {
  if (!Array.isArray(lines)) invalid("lines must be a list.");
  return lines.map((line: unknown) => {
    if (typeof line !== "object" || line === null) invalid("each line must be an object.");
    const { sku, quantity } = line as { sku?: unknown; quantity?: unknown };
    if (typeof sku !== "string" || sku.length < 1 || sku.length > MAX_SKU_CHARACTERS) {
      invalid(`sku must be 1 to ${MAX_SKU_CHARACTERS} characters.`);
    }
    if (typeof quantity !== "number") invalid("quantity must be a number.");
    return { sku, quantity };
  });
}

function checkDate(value: unknown, name: string): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) invalid(`${name} must be a valid date.`);
  return value;
}

/** Trims, then keeps at most 500 characters. Empty text is no note. */
export function normaliseNote(note: unknown): string | null {
  if (typeof note !== "string") return null;
  const trimmed = note.trim();
  if (trimmed.length === 0) return null;
  return Array.from(trimmed).slice(0, MAX_NOTE_CHARACTERS).join("");
}

function compareSku(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The request identity. The note is not part of it, so a retry with a different note is still the same request. */
function identityHash(lines: CustomerOrderLine[], requestedFor: Date | undefined): string {
  return requestHash({
    lines: [...lines]
      .sort((a, b) => compareSku(a.sku, b.sku))
      .map((line) => ({ sku: String(line.sku), quantity: String(line.quantity) })),
    requestedFor: requestedFor ? requestedFor.toISOString() : null,
  });
}

function toView(row: any, lines: CustomerOrderLine[]): CustomerOrderView {
  return {
    orderId: row.id,
    externalRef: row.external_ref,
    status: row.status,
    requestedFor: row.requested_for ?? null,
    promisedFor: row.promised_for ?? null,
    reasons: row.reasons ?? [],
    note: row.note ?? null,
    units: Number(row.units),
    slotId: row.slot_id ?? null,
    decidedBy: row.decided_by ?? null,
    lines,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadLines(client: pg.PoolClient | null, orderIds: string[]): Promise<Map<string, CustomerOrderLine[]>> {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `SELECT order_id, sku, quantity FROM customer_order_lines WHERE order_id = ANY($1::text[]) ORDER BY sku ASC;`,
    [orderIds]
  );
  const byOrder = new Map<string, CustomerOrderLine[]>();
  for (const row of res.rows) {
    const list = byOrder.get(row.order_id) ?? [];
    list.push({ sku: row.sku, quantity: Number(row.quantity) });
    byOrder.set(row.order_id, list);
  }
  return byOrder;
}

/** Loads one order of the workspace and locks it. Another workspace's id is simply not found. */
async function lockOrder(client: pg.PoolClient, workspaceId: string, orderId: string): Promise<any> {
  const res = await client.query(
    `SELECT * FROM customer_orders WHERE id = $1 AND workspace_id = $2 FOR UPDATE;`,
    [orderId, workspaceId]
  );
  if (res.rows.length === 0) throw new FulfilmentError("ORDER_NOT_FOUND");
  return res.rows[0];
}

async function writeAudit(
  client: pg.PoolClient,
  row: {
    workspaceId: string;
    actorType: "agent" | "owner" | "staff";
    actorId: string;
    effectClass: EffectClass;
    action: string;
    decision: PolicyDecision;
    evidence: Record<string, unknown>;
  }
): Promise<void> {
  // Evidence holds ids, status and reason codes. It never holds the customer's note or any other free text.
  await client.query(
    `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, $7, $8::jsonb, NOW());`,
    [
      newId("audit"),
      row.workspaceId,
      row.actorType,
      row.actorId,
      row.effectClass,
      row.action,
      row.decision,
      JSON.stringify(row.evidence),
    ]
  );
}

/**
 * Takes the locks for a decision and makes it. The caller holds the order row lock (or has just inserted the row).
 * Facts are read only under these locks, so two decisions for the same sku or slot cannot both see the same room.
 */
async function decideLocked(
  client: pg.PoolClient,
  workspaceId: string,
  lines: CustomerOrderLine[],
  requestedFor: Date | undefined,
  now: Date,
  actor: AgentActor | OwnerActor
): Promise<PromiseDecision> {
  const skus = [...new Set(lines.map((line) => line.sku))].sort(compareSku);

  // 1. Inventory rows, locked in sku order. An unknown sku has no row.
  const stockRows = await client.query(
    `SELECT sku, current_quantity::float8 AS on_hand FROM inventory_items
     WHERE workspace_id = $1 AND sku = ANY($2::text[]) ORDER BY sku ASC FOR UPDATE;`,
    [workspaceId, skus]
  );
  // 2. Active reservations for those skus, read after the lock so a concurrent reservation is already visible.
  const reservedRows = await client.query(
    `SELECT sku, SUM(quantity)::int AS reserved FROM stock_reservations
     WHERE workspace_id = $1 AND status = 'active' AND sku = ANY($2::text[]) GROUP BY sku;`,
    [workspaceId, skus]
  );
  const reserved = new Map<string, number>(reservedRows.rows.map((r) => [r.sku as string, Number(r.reserved)]));
  const stock: PromiseFacts["stock"] = {};
  for (const row of stockRows.rows) {
    stock[row.sku as string] = { onHand: Number(row.on_hand), reserved: reserved.get(row.sku as string) ?? 0 };
  }

  // 3. The role grant and the pause switch. An owner decision does not consult the role.
  let roleGranted = false;
  if (actor.kind === "agent") {
    const roleRes = await client.query(
      `SELECT id, workspace_id, role_name, permitted_effects, enabled FROM agent_roles WHERE workspace_id = $1 AND role_name = $2;`,
      [workspaceId, actor.roleName]
    );
    const role = roleRes.rows[0];
    if (role) {
      roleGranted =
        new PolicyEngine().evaluate({
          workspace: { workspaceId },
          role: {
            roleId: role.id,
            workspaceId: role.workspace_id,
            roleName: role.role_name,
            permittedEffects: role.permitted_effects,
            enabled: role.enabled,
          },
          operation: "orders.accept_customer",
        }).decision === PolicyDecision.ALLOW;
    }
  }
  const wsRes = await client.query(`SELECT agents_paused FROM workspaces WHERE id = $1;`, [workspaceId]);
  const agentsPaused = wsRes.rows[0]?.agents_paused === true;

  // 4. Kitchen slots from the earliest time that could be promised, locked in time order.
  const earliest = new Date(Math.max(now.getTime(), requestedFor?.getTime() ?? now.getTime()));
  const slotRows = await client.query(
    `SELECT id, starts_at, capacity_units, used_units FROM kitchen_capacity
     WHERE workspace_id = $1 AND starts_at >= $2 ORDER BY starts_at ASC FOR UPDATE;`,
    [workspaceId, earliest]
  );
  const slots = slotRows.rows.map((r) => ({
    id: r.id as string,
    startsAt: r.starts_at as Date,
    capacityUnits: Number(r.capacity_units),
    usedUnits: Number(r.used_units),
  }));

  return decidePromise(
    { stock, slots, roleGranted, agentsPaused },
    { lines, requestedFor, now, actor: actor.kind === "agent" ? "agent" : "owner" }
  );
}

/** Writes the decision on the order row, makes the reservation and the slot booking when accepted, and audits it. */
async function recordDecision(
  client: pg.PoolClient,
  args: {
    workspaceId: string;
    orderId: string;
    decision: PromiseDecision;
    decidedBy: string;
    actorType: "agent" | "owner";
    lines: CustomerOrderLine[];
  }
): Promise<void> {
  const { workspaceId, orderId, decision, decidedBy, actorType, lines } = args;
  if (decision.status === "accepted") {
    for (const line of lines) {
      await client.query(
        `INSERT INTO stock_reservations (id, workspace_id, order_id, sku, quantity, status)
         VALUES ($1, $2, $3, $4, $5, 'active');`,
        [newId("rsv"), workspaceId, orderId, line.sku, line.quantity]
      );
    }
    await client.query(
      `UPDATE kitchen_capacity SET used_units = used_units + $2 WHERE id = $1;`,
      [decision.slotId, decision.units]
    );
  }

  await client.query(
    `UPDATE customer_orders SET status = $2, reasons = $3::jsonb, promised_for = $4, slot_id = $5, units = $6,
       decided_by = $7, updated_at = NOW()
     WHERE id = $1;`,
    [
      orderId,
      decision.status,
      JSON.stringify(decision.reasons),
      decision.promisedFor ?? null,
      decision.slotId ?? null,
      decision.units,
      decidedBy,
    ]
  );

  const accepted = decision.status === "accepted";
  const action =
    decision.status === "needs_owner" ? "customer_order.held" : `customer_order.${decision.status}`;
  await writeAudit(client, {
    workspaceId,
    actorType,
    actorId: decidedBy,
    effectClass: accepted ? EffectClass.COMMERCIAL_COMMITMENT : EffectClass.READ,
    action,
    decision: accepted
      ? PolicyDecision.ALLOW
      : decision.status === "needs_owner"
        ? PolicyDecision.REQUIRE_APPROVAL
        : PolicyDecision.DENY,
    evidence: {
      orderId,
      status: decision.status,
      reasonCodes: decision.reasons.map((r) => r.code),
      units: decision.units,
      ...(accepted ? { slotId: decision.slotId, promisedFor: decision.promisedFor?.toISOString() } : {}),
    },
  });
}

function resultOf(row: any, replayed: boolean): AcceptResult {
  return {
    orderId: row.id,
    status: row.status,
    ...(row.promised_for ? { promisedFor: row.promised_for } : {}),
    reasons: row.reasons ?? [],
    replayed,
  };
}

/**
 * Accepts a customer order for the workspace, or records why it was declined, held or partially available.
 * A repeated externalRef with the same lines returns the stored result and makes nothing new (`replayed: true`).
 * The same externalRef with different lines is refused with EXTERNAL_REF_REUSED.
 */
export async function acceptCustomerOrder(
  input: CustomerOrderInput,
  actor: AgentActor | OwnerActor,
  now: Date = new Date()
): Promise<AcceptResult> {
  const workspaceId = input.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) invalid("workspaceId is required.");
  const externalRef = checkExternalRef(input.externalRef);
  const lines = checkLines(input.lines);
  const requestedFor = checkDate(input.requestedFor, "requestedFor");
  const note = normaliseNote(input.note);
  const hash = identityHash(lines, requestedFor);
  const decidedBy = actor.kind === "agent" ? `agent:${actor.roleName}` : `owner:${actor.label}`;

  const result = await withTransaction(async (client) => {
    const orderId = newId("cord");
    // The row is inserted first. A concurrent attempt with the same externalRef waits here until this one commits.
    const inserted = await client.query(
      `INSERT INTO customer_orders (id, workspace_id, external_ref, request_hash, status, requested_for, reasons, note, units, decided_by)
       VALUES ($1, $2, $3, $4, 'declined', $5, '[]'::jsonb, $6, 0, NULL)
       ON CONFLICT (workspace_id, external_ref) DO NOTHING
       RETURNING id;`,
      [orderId, workspaceId, externalRef, hash, requestedFor ?? null, note]
    );

    if (inserted.rows.length === 0) {
      const stored = await client.query(
        `SELECT * FROM customer_orders WHERE workspace_id = $1 AND external_ref = $2;`,
        [workspaceId, externalRef]
      );
      const row = stored.rows[0];
      if (!row || row.request_hash !== hash) throw new FulfilmentError("EXTERNAL_REF_REUSED");
      return resultOf(row, true);
    }

    const decision = await decideLocked(client, workspaceId, lines, requestedFor, now, actor);
    // Lines are stored only for a valid request. An invalid one keeps its reasons and no lines.
    if (decision.units > 0) {
      for (const line of lines) {
        await client.query(
          `INSERT INTO customer_order_lines (id, order_id, sku, quantity) VALUES ($1, $2, $3, $4);`,
          [newId("cline"), orderId, line.sku, line.quantity]
        );
      }
    }
    await recordDecision(client, {
      workspaceId,
      orderId,
      decision,
      decidedBy,
      actorType: actor.kind,
      lines: decision.units > 0 ? lines : [],
    });

    return {
      orderId,
      status: decision.status,
      ...(decision.promisedFor ? { promisedFor: decision.promisedFor } : {}),
      reasons: decision.reasons,
      replayed: false,
    };
  });
  // After the commit, never inside it (ADR 0027). A replay made no decision, so it notifies and restocks nothing.
  if (!result.replayed) await afterNewDecision(workspaceId, result, lines);
  return result;
}

/**
 * The owner accepts an order that was held for the owner. The decision is made again against current stock and
 * capacity, so it may come out declined or partially available. Only a `needs_owner` order can be accepted this way.
 */
export async function acceptHeldOrder(
  workspaceId: string,
  orderId: string,
  ownerLabel: string,
  now: Date = new Date()
): Promise<AcceptResult> {
  if (typeof ownerLabel !== "string" || ownerLabel.trim().length === 0) invalid("owner label is required.");
  const { result, lines } = await withTransaction(async (client) => {
    const order = await lockOrder(client, workspaceId, orderId);
    if (order.status !== "needs_owner") throw new FulfilmentError("NOT_HELD");
    const heldLines = (await loadLines(client, [orderId])).get(orderId) ?? [];
    const requestedFor: Date | undefined = order.requested_for ?? undefined;

    const decision = await decideLocked(client, workspaceId, heldLines, requestedFor, now, { kind: "owner", label: ownerLabel });
    await recordDecision(client, {
      workspaceId,
      orderId,
      decision,
      decidedBy: `owner:${ownerLabel}`,
      actorType: "owner",
      lines: heldLines,
    });
    const decided: AcceptResult = {
      orderId,
      status: decision.status,
      ...(decision.promisedFor ? { promisedFor: decision.promisedFor } : {}),
      reasons: decision.reasons,
      replayed: false,
    };
    return { result: decided, lines: heldLines };
  });
  // A new decision, so the same after-commit steps as acceptCustomerOrder (ADR 0027).
  await afterNewDecision(workspaceId, result, lines);
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// After a new decision (Task 8b, ADR 0027). Everything here runs after the decision has committed. Nothing here can fail
// the order or change it: each step catches its own errors and writes an audit row for them.
// ---------------------------------------------------------------------------------------------------------------------

/** The order decisions that tell the owner something. An accepted order sends nothing. */
type OrderNoticeKind = Exclude<OwnerNoticeKind, "approval">;

const NOTICE_KIND_BY_STATUS: Partial<Record<CustomerOrderStatus, OrderNoticeKind>> = {
  needs_owner: "order_held",
  declined: "order_declined",
  partially_available: "order_partially_available",
};

const NOTICE_TITLE: Record<OrderNoticeKind, string> = {
  order_held: "Bind: customer order needs your attention",
  order_declined: "Bind: customer order declined",
  order_partially_available: "Bind: customer order partly available",
};

/**
 * A sku is named in the notice only when it is short and plain. The customer chose the sku, so any other text is
 * withheld (ADR 0027).
 */
const SHOWN_SKU = /^[A-Za-z0-9._-]{1,40}$/;

/**
 * The notice text is built only from the order id, the status and the reason codes (and skus named in reasons). It never
 * holds the customer's note or the externalRef, which are customer-controlled.
 */
function noticeMessage(orderId: string, status: CustomerOrderStatus, reasons: PromiseReasonRef[]): string {
  const parts = reasons.map((reason) => {
    if (reason.sku === undefined) return reason.code;
    return SHOWN_SKU.test(reason.sku) ? `${reason.code} (${reason.sku})` : `${reason.code} (sku withheld)`;
  });
  return `Order ${orderId} status: ${status}. Reasons: ${parts.length > 0 ? parts.join(", ") : "none"}.`;
}

const systemEngine = new WorkflowEngine();

/** Writes a system audit row. A failure to write it is swallowed: the caller has already done its work. */
async function recordSystemAudit(
  workspaceId: string,
  actorId: string,
  action: string,
  effectClass: EffectClass,
  decision: PolicyDecision,
  evidence: Record<string, unknown>
): Promise<void> {
  await systemEngine
    .recordAudit(workspaceId, null, "system", actorId, effectClass, action, decision, evidence)
    .catch(() => undefined);
}

/**
 * Tells the owner that an order was held, declined or only partly covered. The recipient is the owner's own binding
 * (ADR 0025). With no binding nothing is sent and the skip is audited. A send error is audited as notification.failed.
 */
async function notifyOwnerOfDecision(
  workspaceId: string,
  orderId: string,
  status: CustomerOrderStatus,
  reasons: PromiseReasonRef[]
): Promise<void> {
  const kind = NOTICE_KIND_BY_STATUS[status];
  if (!kind) return;
  try {
    const owner = await resolveOwnerRecipient(workspaceId);
    if (!owner) {
      await recordSystemAudit(
        workspaceId,
        "system:notifications",
        "notification.skipped_no_recipient",
        EffectClass.EXTERNAL_REQUEST,
        PolicyDecision.ALLOW,
        { orderId, status }
      );
      return;
    }
    await sendOwnerNotification({
      workspaceId,
      kind,
      refId: orderId,
      payload: {
        workspaceId,
        channel: owner.channel,
        recipient: owner.recipient,
        title: NOTICE_TITLE[kind],
        message: noticeMessage(orderId, status, reasons),
        actionUrl: customerOrderLink(orderId),
      },
    });
  } catch (err) {
    await recordSystemAudit(
      workspaceId,
      "system:notifications",
      "notification.failed",
      EffectClass.EXTERNAL_REQUEST,
      PolicyDecision.ALLOW,
      { orderId, error: boundedErrorMessage(err) }
    );
  }
}

/** The on-hand quantity less active reservations, and the par level, for one sku of the workspace. */
async function availableLevel(workspaceId: string, sku: string): Promise<{ available: number; par: number } | null> {
  const res = await query(
    `SELECT i.current_quantity::float8 AS on_hand, i.par_level::float8 AS par,
            COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r
                      WHERE r.workspace_id = i.workspace_id AND r.sku = i.sku AND r.status = 'active'), 0)::float8 AS reserved
     FROM inventory_items i WHERE i.workspace_id = $1 AND i.sku = $2;`,
    [workspaceId, sku]
  );
  const row = res.rows[0];
  if (!row) return null;
  return { available: Number(row.on_hand) - Number(row.reserved), par: Number(row.par) };
}

/**
 * Starts a replenishment for one sku when its available quantity is below par. Serialised per sku by an advisory lock, so
 * concurrent accepted orders read the level in turn, and the active-workflow check then returns the workflow the first
 * one started. The replenishment goes through the existing workflow, gate and approvals (ADR 0027).
 */
async function restockIfLow(workspaceId: string, orderId: string, sku: string): Promise<void> {
  let lock: AdvisoryLock | null;
  try {
    lock = await acquireAdvisoryLock(`restock:${workspaceId}:${sku}`, RESTOCK_LOCK_WAIT_MS);
  } catch (err) {
    await recordSystemAudit(workspaceId, "system:restock", "replenishment.trigger_failed", EffectClass.READ, PolicyDecision.ALLOW, {
      orderId,
      sku,
      error: boundedErrorMessage(err),
    });
    return;
  }
  if (!lock) {
    await recordSystemAudit(workspaceId, "system:restock", "replenishment.trigger_skipped", EffectClass.READ, PolicyDecision.ALLOW, {
      orderId,
      sku,
      reason: "LOCK_BUSY",
    });
    return;
  }
  try {
    const level = await availableLevel(workspaceId, sku);
    if (!level || level.available >= level.par) return;
    await new ProcurementWorkflowRunner().startReplenishment(workspaceId, sku, RESTOCK_TRIGGER_SOURCE, {
      availableQuantity: level.available,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith(PAUSED_MESSAGE_PREFIX)) {
      // A pause refuses the restock. It is a policy refusal, so it is recorded as a denial (ADR 0023).
      await recordSystemAudit(workspaceId, "system:restock", "replenishment.trigger_skipped", EffectClass.READ, PolicyDecision.DENY, {
        orderId,
        sku,
        reason: "AGENTS_PAUSED",
      });
    } else {
      await recordSystemAudit(workspaceId, "system:restock", "replenishment.trigger_failed", EffectClass.READ, PolicyDecision.ALLOW, {
        orderId,
        sku,
        error: boundedErrorMessage(err),
      });
    }
  } finally {
    await lock.release();
  }
}

/** After an accepted order: each sku of the order is checked, and a restock starts when it is below par (ADR 0027). */
async function triggerRestockAfterAcceptance(workspaceId: string, orderId: string, lines: CustomerOrderLine[]): Promise<void> {
  const skus = [...new Set(lines.map((line) => line.sku))].sort(compareSku);
  for (const sku of skus) {
    // Per sku, so one failing sku does not stop the others. restockIfLow audits its own errors.
    await restockIfLow(workspaceId, orderId, sku).catch(() => undefined);
  }
}

/** Runs the notice and the restock trigger for a decision that was just made. Neither can fail the order. */
async function afterNewDecision(
  workspaceId: string,
  decision: AcceptResult,
  lines: CustomerOrderLine[]
): Promise<void> {
  await notifyOwnerOfDecision(workspaceId, decision.orderId, decision.status, decision.reasons).catch(() => undefined);
  if (decision.status === "accepted") {
    await triggerRestockAfterAcceptance(workspaceId, decision.orderId, lines).catch(() => undefined);
  }
}

/**
 * Cancels an order. An accepted order gives its reservations and its slot units back. Cancelling a cancelled order is a
 * no-op. A fulfilled order cannot be cancelled.
 */
export async function cancelCustomerOrder(
  workspaceId: string,
  orderId: string,
  actor: OperatorActor
): Promise<CustomerOrderView> {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, workspaceId, orderId);
    if (order.status === "fulfilled") throw new FulfilmentError("ALREADY_FULFILLED");
    if (order.status === "cancelled") return viewAfter(client, workspaceId, orderId);

    const wasAccepted = order.status === "accepted";
    await client.query(
      `UPDATE stock_reservations SET status = 'released', updated_at = NOW()
       WHERE order_id = $1 AND workspace_id = $2 AND status = 'active';`,
      [orderId, workspaceId]
    );
    if (wasAccepted && order.slot_id) {
      await client.query(
        `UPDATE kitchen_capacity SET used_units = used_units - $2 WHERE id = $1 AND workspace_id = $3;`,
        [order.slot_id, Number(order.units), workspaceId]
      );
    }
    await client.query(`UPDATE customer_orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1;`, [orderId]);
    await writeAudit(client, {
      workspaceId,
      actorType: actor.kind,
      actorId: `${actor.kind}:${actor.label}`,
      effectClass: wasAccepted ? EffectClass.COMMERCIAL_COMMITMENT : EffectClass.READ,
      action: "customer_order.cancelled",
      decision: PolicyDecision.ALLOW,
      evidence: { orderId, previousStatus: order.status, units: Number(order.units) },
    });
    return viewAfter(client, workspaceId, orderId);
  });
}

/**
 * Fulfils an accepted order: its reserved quantities leave on-hand stock and the reservations are consumed. The check
 * and the change happen under the inventory locks, so a short count changes nothing.
 */
export async function fulfilCustomerOrder(
  workspaceId: string,
  orderId: string,
  actor: OperatorActor
): Promise<CustomerOrderView> {
  return withTransaction(async (client) => {
    const order = await lockOrder(client, workspaceId, orderId);
    if (order.status === "fulfilled") return viewAfter(client, workspaceId, orderId);
    if (order.status !== "accepted") throw new FulfilmentError("NOT_ACCEPTED");

    const reservations = (
      await client.query(
        `SELECT sku, quantity FROM stock_reservations WHERE order_id = $1 AND workspace_id = $2 AND status = 'active' ORDER BY sku ASC;`,
        [orderId, workspaceId]
      )
    ).rows.map((r) => ({ sku: r.sku as string, quantity: Number(r.quantity) }));
    const skus = [...new Set(reservations.map((r) => r.sku))].sort(compareSku);

    const stockRows = await client.query(
      `SELECT sku, current_quantity::float8 AS on_hand FROM inventory_items
       WHERE workspace_id = $1 AND sku = ANY($2::text[]) ORDER BY sku ASC FOR UPDATE;`,
      [workspaceId, skus]
    );
    const onHand = new Map<string, number>(stockRows.rows.map((r) => [r.sku as string, Number(r.on_hand)]));
    for (const reservation of reservations) {
      const available = onHand.get(reservation.sku);
      if (available === undefined || available < reservation.quantity) {
        throw new FulfilmentError("INSUFFICIENT_ON_HAND");
      }
    }

    for (const reservation of reservations) {
      await client.query(
        `UPDATE inventory_items SET current_quantity = current_quantity - $3, updated_at = NOW()
         WHERE workspace_id = $1 AND sku = $2;`,
        [workspaceId, reservation.sku, reservation.quantity]
      );
    }
    await client.query(
      `UPDATE stock_reservations SET status = 'consumed', updated_at = NOW()
       WHERE order_id = $1 AND workspace_id = $2 AND status = 'active';`,
      [orderId, workspaceId]
    );
    await client.query(`UPDATE customer_orders SET status = 'fulfilled', updated_at = NOW() WHERE id = $1;`, [orderId]);
    await writeAudit(client, {
      workspaceId,
      actorType: actor.kind,
      actorId: `${actor.kind}:${actor.label}`,
      effectClass: EffectClass.COMMERCIAL_COMMITMENT,
      action: "customer_order.fulfilled",
      decision: PolicyDecision.ALLOW,
      evidence: { orderId, units: Number(order.units), lineCount: reservations.length },
    });
    return viewAfter(client, workspaceId, orderId);
  });
}

/**
 * Sets kitchen slots for the workspace, by start time. A slot cannot be lowered below its used units. The batch is all or
 * nothing: one refused slot stores none of them.
 */
export async function setKitchenCapacity(
  workspaceId: string,
  slots: KitchenSlotInput[],
  actor: OwnerActor
): Promise<KitchenSlotView[]> {
  if (!Array.isArray(slots) || slots.length === 0 || slots.length > MAX_SLOTS_PER_REQUEST) {
    invalid(`slots must be a list of 1 to ${MAX_SLOTS_PER_REQUEST} entries.`);
  }
  const checked = slots.map((slot) => {
    const startsAt = checkDate(slot.startsAt, "startsAt");
    const endsAt = checkDate(slot.endsAt, "endsAt");
    if (!startsAt || !endsAt) invalid("startsAt and endsAt are required.");
    if (endsAt.getTime() <= startsAt.getTime()) invalid("endsAt must be after startsAt.");
    const capacityUnits = slot.capacityUnits;
    if (!Number.isInteger(capacityUnits) || capacityUnits < 0 || capacityUnits > MAX_CAPACITY_UNITS) {
      invalid(`capacityUnits must be a whole number from 0 to ${MAX_CAPACITY_UNITS}.`);
    }
    return { startsAt, endsAt, capacityUnits };
  });
  const sorted = [...checked].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  return withTransaction(async (client) => {
    const ids: string[] = [];
    for (const slot of sorted) {
      // The conflict row is locked here. The update applies only when the used units still fit.
      const res = await client.query(
        `INSERT INTO kitchen_capacity (id, workspace_id, starts_at, ends_at, capacity_units, used_units)
         VALUES ($1, $2, $3, $4, $5, 0)
         ON CONFLICT (workspace_id, starts_at) DO UPDATE SET
           ends_at = EXCLUDED.ends_at,
           capacity_units = EXCLUDED.capacity_units
         WHERE kitchen_capacity.used_units <= EXCLUDED.capacity_units
         RETURNING id;`,
        [newId("cap"), workspaceId, slot.startsAt, slot.endsAt, slot.capacityUnits]
      );
      if (res.rows.length === 0) throw new FulfilmentError("CAPACITY_BELOW_USED");
      ids.push(res.rows[0].id as string);
    }
    await writeAudit(client, {
      workspaceId,
      actorType: "owner",
      actorId: `owner:${actor.label}`,
      effectClass: EffectClass.COMMERCIAL_COMMITMENT,
      action: "kitchen_capacity.set",
      decision: PolicyDecision.ALLOW,
      evidence: { slotCount: ids.length },
    });
    return listKitchenCapacity(workspaceId, client);
  });
}

export async function listKitchenCapacity(workspaceId: string, client?: pg.PoolClient): Promise<KitchenSlotView[]> {
  const run = client ? client.query.bind(client) : query;
  const res = await run(
    `SELECT id, starts_at, ends_at, capacity_units, used_units FROM kitchen_capacity
     WHERE workspace_id = $1 ORDER BY starts_at ASC LIMIT 500;`,
    [workspaceId]
  );
  return res.rows.map((r) => {
    const capacityUnits = Number(r.capacity_units);
    const usedUnits = Number(r.used_units);
    return {
      id: r.id as string,
      startsAt: r.starts_at as Date,
      endsAt: r.ends_at as Date,
      capacityUnits,
      usedUnits,
      remainingUnits: capacityUnits - usedUnits,
    };
  });
}

async function viewAfter(client: pg.PoolClient, workspaceId: string, orderId: string): Promise<CustomerOrderView> {
  const res = await client.query(`SELECT * FROM customer_orders WHERE id = $1 AND workspace_id = $2;`, [orderId, workspaceId]);
  if (res.rows.length === 0) throw new FulfilmentError("ORDER_NOT_FOUND");
  const lines = (await loadLines(client, [orderId])).get(orderId) ?? [];
  return toView(res.rows[0], lines);
}

/** One order of the workspace, or null. Another workspace's id is null, the same as a missing one. */
export async function getCustomerOrder(workspaceId: string, orderId: string): Promise<CustomerOrderView | null> {
  const res = await query(`SELECT * FROM customer_orders WHERE id = $1 AND workspace_id = $2;`, [orderId, workspaceId]);
  if (res.rows.length === 0) return null;
  const lines = (await loadLines(null, [orderId])).get(orderId) ?? [];
  return toView(res.rows[0], lines);
}

/** The most recent orders of the workspace, newest first. */
export async function listCustomerOrders(workspaceId: string): Promise<CustomerOrderView[]> {
  const res = await query(
    `SELECT * FROM customer_orders WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2;`,
    [workspaceId, LIST_LIMIT]
  );
  const ids = res.rows.map((r) => r.id as string);
  const lines = ids.length > 0 ? await loadLines(null, ids) : new Map<string, CustomerOrderLine[]>();
  return res.rows.map((row) => toView(row, lines.get(row.id) ?? []));
}
