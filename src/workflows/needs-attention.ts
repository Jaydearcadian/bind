import { query } from "../db/client.js";

/**
 * What needs the owner's attention, for one workspace (ADR 0030). Each kind is one SQL function. The assembly
 * (merge, sort, cap) is pure and takes already-read items.
 *
 * An item holds only ids, codes, enum values and times. No customer text, note, external reference, supplier name,
 * feedback text, rationale or proposed name is read into an item, and every code is checked against a code shape
 * before it is returned, so a stored free-text value cannot reach the list by mistake.
 */

export const ATTENTION_KINDS = [
  "effect_in_doubt",
  "payment_hold",
  "settlement_unconfirmed",
  "order_submission_in_doubt",
  "customer_order_held",
  "menu_proposal_awaiting",
  "approval_pending",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export interface AttentionItem {
  kind: AttentionKind;
  id: string;
  /** When the item began to need attention (ISO 8601). Items are sorted by this, oldest first. */
  since: string;
  codes: string[];
  nextAction: string;
}

export interface NeedsAttention {
  items: AttentionItem[];
  /** True when more items exist than `items` holds. */
  capped: boolean;
}

export const ATTENTION_LIMIT = 200;
/** Each kind reads one row past the limit, so the cap can be told from a list of exactly the limit. */
const PER_KIND_LIMIT = ATTENTION_LIMIT + 1;

/** A code is an identifier of the kind `SUPPLIER_NOT_VERIFIED` or `suppliers.request_quote`, never a sentence. */
const CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;

function codesOnly(values: unknown[]): string[] {
  return values.filter((v): v is string => typeof v === "string" && CODE_SHAPE.test(v));
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

/**
 * Merges the lists, sorts by `since` (then kind and id), and keeps the first `limit`. `capped` is true when more items
 * were given than are kept. Pure: no reads, no clock.
 */
export function assembleAttention(lists: AttentionItem[][], limit: number = ATTENTION_LIMIT): NeedsAttention {
  const all = lists
    .flat()
    .sort(
      (a, b) =>
        Date.parse(a.since) - Date.parse(b.since) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)
    );
  return { items: all.slice(0, limit), capped: all.length > limit };
}

/** An effect whose outcome is unknown: started or failed, and not touched for two minutes. */
async function effectsInDoubt(workspaceId: string): Promise<AttentionItem[]> {
  const res = await query(
    `SELECT id, operation, status, updated_at FROM effects
     WHERE workspace_id = $1 AND status IN ('started', 'failed') AND updated_at < NOW() - INTERVAL '2 minutes'
     ORDER BY updated_at ASC, id ASC LIMIT $2;`,
    [workspaceId, PER_KIND_LIMIT]
  );
  return res.rows.map((r) => ({
    kind: "effect_in_doubt" as const,
    id: r.id,
    since: iso(r.updated_at),
    codes: codesOnly([r.operation, r.status]),
    nextAction: "RESOLVE_EFFECT",
  }));
}

/** An order held in payment_hold. Its code is the hold named by the latest audit row of that order, or UNKNOWN. */
async function paymentHolds(workspaceId: string): Promise<AttentionItem[]> {
  const res = await query(
    `SELECT o.id, o.updated_at,
            (SELECT a.evidence->>'hold' FROM audit_logs a
             WHERE a.workspace_id = o.workspace_id AND a.evidence->>'orderId' = o.id AND a.evidence->>'hold' IS NOT NULL
             ORDER BY a.created_at DESC, a.id DESC LIMIT 1) AS hold_code
     FROM orders o
     WHERE o.workspace_id = $1 AND o.status = 'payment_hold'
     ORDER BY o.updated_at ASC, o.id ASC LIMIT $2;`,
    [workspaceId, PER_KIND_LIMIT]
  );
  return res.rows.map((r) => ({
    kind: "payment_hold" as const,
    id: r.id,
    since: iso(r.updated_at),
    codes: codesOnly([r.hold_code ?? "UNKNOWN"]),
    nextAction: "RECONCILE_ORDER",
  }));
}

/**
 * A payment sent but not confirmed for more than five minutes. The age is measured from the transfer (or from the
 * order, when no transfer record exists). POLLING_STOPPED means the worker no longer asks: the transfer is older than a
 * day, or it has no record at all (ADR 0029 leaves such an order to this list).
 */
async function settlementsUnconfirmed(workspaceId: string): Promise<AttentionItem[]> {
  const res = await query(
    `SELECT o.id, COALESCE(e.created_at, o.updated_at) AS since_at,
            (e.id IS NULL) AS no_record,
            (e.created_at < NOW() - INTERVAL '24 hours') AS too_old
     FROM orders o
     LEFT JOIN effects e ON e.idempotency_key = o.workspace_id || ':settle:' || o.id
                        AND e.operation = 'settlement.transfer_usdc'
     WHERE o.workspace_id = $1 AND o.status = 'settlement_submitted'
       AND COALESCE(e.created_at, o.updated_at) < NOW() - INTERVAL '5 minutes'
     ORDER BY since_at ASC, o.id ASC LIMIT $2;`,
    [workspaceId, PER_KIND_LIMIT]
  );
  return res.rows.map((r) => {
    const stopped = r.no_record === true || r.too_old === true;
    return {
      kind: "settlement_unconfirmed" as const,
      id: r.id,
      since: iso(r.since_at),
      codes: codesOnly(["AWAITING_SETTLEMENT_CONFIRMATION", ...(r.no_record === true ? ["NO_TRANSFER_RECORD"] : []), ...(stopped ? ["POLLING_STOPPED"] : [])]),
      nextAction: "CONFIRM_SETTLEMENT",
    };
  });
}

/** A replenishment whose order is still `submitted` after five minutes: the supplier's answer is unknown and nothing resends it. */
async function orderSubmissionsInDoubt(workspaceId: string): Promise<AttentionItem[]> {
  const res = await query(
    `SELECT wf.id, wf.updated_at FROM workflows wf
     WHERE wf.workspace_id = $1 AND wf.state = 'submitted' AND wf.updated_at < NOW() - INTERVAL '5 minutes'
       AND EXISTS (SELECT 1 FROM orders o
                   WHERE o.id = 'ord_' || wf.id AND o.workspace_id = wf.workspace_id AND o.status = 'submitted')
     ORDER BY wf.updated_at ASC, wf.id ASC LIMIT $2;`,
    [workspaceId, PER_KIND_LIMIT]
  );
  return res.rows.map((r) => ({
    kind: "order_submission_in_doubt" as const,
    id: r.id,
    since: iso(r.updated_at),
    codes: ["SUPPLIER_OUTCOME_UNKNOWN"],
    nextAction: "RESOLVE_ORDER_WITH_SUPPLIER",
  }));
}

/** A customer order held for the owner. Its codes are the reason codes only; the sku and the note are never read. */
async function customerOrdersHeld(workspaceId: string): Promise<AttentionItem[]> {
  const res = await query(
    `SELECT id, updated_at, reasons FROM customer_orders
     WHERE workspace_id = $1 AND status = 'needs_owner'
     ORDER BY updated_at ASC, id ASC LIMIT $2;`,
    [workspaceId, PER_KIND_LIMIT]
  );
  return res.rows.map((r) => {
    const reasons = Array.isArray(r.reasons) ? r.reasons : [];
    const codes = codesOnly(reasons.map((reason: any) => reason?.code));
    return {
      kind: "customer_order_held" as const,
      id: r.id,
      since: iso(r.updated_at),
      codes: codes.length > 0 ? codes : ["UNSPECIFIED"],
      nextAction: "ACCEPT_OR_CANCEL_ORDER",
    };
  });
}

/** A menu proposal the owner has not finished with: proposed (to decide) or approved (to publish). */
async function menuProposalsAwaiting(workspaceId: string): Promise<AttentionItem[]> {
  const res = await query(
    `SELECT id, status, updated_at FROM menu_proposals
     WHERE workspace_id = $1 AND status IN ('proposed', 'approved')
     ORDER BY updated_at ASC, id ASC LIMIT $2;`,
    [workspaceId, PER_KIND_LIMIT]
  );
  return res.rows.map((r) => ({
    kind: "menu_proposal_awaiting" as const,
    id: r.id,
    since: iso(r.updated_at),
    codes: codesOnly([r.status]),
    nextAction: "APPROVE_REJECT_OR_PUBLISH",
  }));
}

/** A pending approval whose window ends within the hour. An approval already past its window is listed too: it is not decidable. */
async function approvalsPending(workspaceId: string): Promise<AttentionItem[]> {
  const res = await query(
    `SELECT id, action_requested, created_at FROM approvals
     WHERE workspace_id = $1 AND status = 'pending' AND expires_at <= NOW() + INTERVAL '1 hour'
     ORDER BY created_at ASC, id ASC LIMIT $2;`,
    [workspaceId, PER_KIND_LIMIT]
  );
  return res.rows.map((r) => ({
    kind: "approval_pending" as const,
    id: r.id,
    since: iso(r.created_at),
    codes: codesOnly([r.action_requested]),
    nextAction: "DECIDE_APPROVAL",
  }));
}

/** The workspace's items that need attention, oldest first, at most ATTENTION_LIMIT, with `capped` saying whether more exist. */
export async function listNeedsAttention(workspaceId: string): Promise<NeedsAttention> {
  const lists = await Promise.all([
    effectsInDoubt(workspaceId),
    paymentHolds(workspaceId),
    settlementsUnconfirmed(workspaceId),
    orderSubmissionsInDoubt(workspaceId),
    customerOrdersHeld(workspaceId),
    menuProposalsAwaiting(workspaceId),
    approvalsPending(workspaceId),
  ]);
  return assembleAttention(lists);
}
