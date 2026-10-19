import crypto from "crypto";
import { query } from "../db/client.js";
import { acquireAdvisoryLock } from "../db/advisory-lock.js";
import { authorizeCommitment, type CommitmentDecision } from "../policy/commitment-gate.js";
import { PolicyDecision } from "../policy/engine.js";

/**
 * Reserves spend for an order before any supplier is called. The reservation is the order row itself, written with a
 * spend-counting status while the workspace's spend lock is held. The commitment gate runs under the same lock, so two
 * concurrent commitments cannot both pass the daily limit. See docs/decisions/0018-order-reservation-and-recovery.md.
 */

/** The actor the commitment gate checks for procurement commitments. */
export const PROCUREMENT_ACTOR_ROLE = "procurement_agent";

/** A reservation waits this long for the workspace spend lock. A busy lock is an error, never a skipped check. */
const SPEND_LOCK_WAIT_MS = 10_000;

/** A quote row, read from the table with the workspace id. The amounts and supplier of an order come from here. */
export interface StoredQuote {
  id: string;
  workspaceId: string;
  supplierId: string | null;
  supplierName: string;
  sku: string;
  quantity: number;
  unitPriceCents: bigint;
  totalPriceCents: bigint;
  validUntil: Date;
}

/** Deterministic purchase order number for an order id: PO- and the first 8 hex characters of sha256(orderId). */
export function orderNumberFor(orderId: string): string {
  return `PO-${crypto.createHash("sha256").update(orderId).digest("hex").slice(0, 8).toUpperCase()}`;
}

export function spendLockKey(workspaceId: string): string {
  return `spend:${workspaceId}`;
}

export async function loadStoredQuote(workspaceId: string, quoteId: string): Promise<StoredQuote | null> {
  if (!quoteId) return null;
  const res = await query(
    `SELECT id, workspace_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, valid_until
     FROM quotes WHERE workspace_id = $1 AND id = $2;`,
    [workspaceId, quoteId]
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    supplierId: row.supplier_id,
    supplierName: row.supplier_name,
    sku: row.item_sku,
    quantity: Number(row.quantity),
    unitPriceCents: BigInt(row.unit_price_cents),
    totalPriceCents: BigInt(row.total_price_cents),
    validUntil: new Date(row.valid_until),
  };
}

/** True when the owner approved an escalation for this workflow. Approvals are keyed by the workflow id. */
export async function hasApprovedEscalation(workspaceId: string, workflowId: string): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM approvals WHERE workspace_id = $1 AND entity_id = $2 AND status = 'approved' LIMIT 1;`,
    [workspaceId, workflowId]
  );
  return res.rows.length > 0;
}

export interface ReserveOrderInput {
  workspaceId: string;
  workflowId: string;
  orderId: string;
  quote: StoredQuote;
  itemName: string;
  idempotencyKey: string;
  orderNumber: string;
}

export type ReservationResult =
  | { reserved: true; created: boolean }
  | { reserved: false; decision: CommitmentDecision };

/**
 * Decides the commitment and writes the order row as `submitted` under the workspace spend lock. Outcomes:
 * - The order row already exists: the reservation was made earlier. It is not decided again, because the order may
 *   already be placed with the supplier, and a later denial would strand it. Returns created: false.
 * - DENY: nothing is written. Returns the decision.
 * - REQUIRE_APPROVAL: reserved only when the owner approved this workflow's escalation. Otherwise it is refused.
 * - ALLOW: the row is written and counts toward spend before any supplier call.
 */
export async function reserveOrder(input: ReserveOrderInput): Promise<ReservationResult> {
  const lock = await acquireAdvisoryLock(spendLockKey(input.workspaceId), SPEND_LOCK_WAIT_MS);
  if (!lock) throw new Error("spend lock busy");
  try {
    const existing = await query(`SELECT workspace_id FROM orders WHERE id = $1;`, [input.orderId]);
    if (existing.rows[0]) {
      if (existing.rows[0].workspace_id !== input.workspaceId) {
        throw new Error("The order id is not available in this workspace.");
      }
      return { reserved: true, created: false };
    }

    const { quote } = input;
    const decision = await authorizeCommitment({
      workspaceId: input.workspaceId,
      workflowId: input.workflowId,
      actorRole: PROCUREMENT_ACTOR_ROLE,
      supplierId: quote.supplierId ?? "",
      quoteId: quote.id,
      quantity: quote.quantity,
      totalPriceCents: quote.totalPriceCents,
    });
    if (decision.decision === PolicyDecision.DENY) return { reserved: false, decision };
    if (decision.decision === PolicyDecision.REQUIRE_APPROVAL) {
      const approved = await hasApprovedEscalation(input.workspaceId, input.workflowId);
      if (!approved) return { reserved: false, decision };
    }

    const inserted = await query(
      `INSERT INTO orders (id, workspace_id, order_number, supplier_id, supplier_name, item_sku, item_name, quantity, unit_price_cents, total_price_cents, currency, status, idempotency_key, external_order_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'USDC', 'submitted', $11, NULL, NOW(), NOW())
       ON CONFLICT (id) DO NOTHING
       RETURNING id;`,
      [
        input.orderId,
        input.workspaceId,
        input.orderNumber,
        quote.supplierId,
        quote.supplierName,
        quote.sku,
        input.itemName,
        quote.quantity,
        quote.unitPriceCents.toString(),
        quote.totalPriceCents.toString(),
        input.idempotencyKey,
      ]
    );
    return { reserved: true, created: inserted.rowCount === 1 };
  } finally {
    await lock.release();
  }
}
