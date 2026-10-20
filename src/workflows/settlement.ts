import { encodePacked, keccak256 } from "viem";
import { query, withTransaction } from "../db/client.js";
import { WorkflowEngine } from "./engine.js";
import { WorkflowState } from "./types.js";
import { PolicyDecision } from "../policy/engine.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { EffectInDoubtError, runEffect } from "../effects/ledger.js";
import type { SettlementAdapter, TransferResult } from "../adapters/settlement/types.js";
import { SettlementRejectedError } from "../adapters/settlement/errors.js";
import { evaluateThreeWayMatch, MatchStatus } from "../accounting/three-way-match.js";
import { recordIdempotentJournalEntry } from "../accounting/journal.js";
import { writeWorkflowAntiDriftFiles } from "../agents/antiDriftWriter.js";
import { newId } from "../utils/ids.js";

/**
 * Why an order is not paid or not yet final. RECONCILE_IN_PROGRESS means another caller holds the claim.
 * The three payment codes mean the order is held in `payment_hold`: the match passed, but no payee or payer
 * is verified, so nothing is paid or restocked until the record is fixed. SETTLEMENT_REJECTED and
 * SETTLEMENT_FAILED also end in `payment_hold`: the adapter refused the payment, or the transfer reverted.
 * SETTLEMENT_OUTCOME_UNKNOWN ends in `payment_hold` too: an earlier transfer attempt may have moved money and
 * the adapter cannot show whether it did, so the transfer is not sent again.
 * AGENTS_PAUSED means the owner has paused the workspace (ADR 0023). Nothing is paid, and the order returns to
 * the status it had before this call (`confirmed` or `payment_hold`), so it can be paid after the owner resumes.
 */
export type ReconcileHold =
  | "RECONCILE_IN_PROGRESS"
  | "SUPPLIER_NOT_VERIFIED"
  | "SUPPLIER_PAYMENT_ADDRESS_MISSING"
  | "WORKSPACE_SETTLEMENT_ADDRESS_MISSING"
  | "SETTLEMENT_REJECTED"
  | "SETTLEMENT_FAILED"
  | "SETTLEMENT_OUTCOME_UNKNOWN"
  | "AGENTS_PAUSED";

/** The statuses a settlement claim can take the order from; the claim restores the one it replaced. */
type ClaimableStatus = "confirmed" | "payment_hold";

/** Every status a release can restore: a payment claim, or a confirmation claim. */
type RestorableStatus = ClaimableStatus | "settlement_submitted";

export interface ReconcileResult {
  status: MatchStatus;
  reconciled: boolean;
  txHash?: string;
  alreadyReconciled?: boolean;
  hold?: ReconcileHold;
  varianceCents?: string;
  discrepancyReason?: string;
  pending?: "AWAITING_DELIVERY_RECEIPT" | "AWAITING_SUPPLIER_BILL" | "AWAITING_SETTLEMENT_CONFIRMATION";
}

/**
 * A confirmation request the order cannot satisfy. ORDER_NOT_FOUND: there is no such order.
 * ORDER_NOT_AWAITING_CONFIRMATION: the order is neither awaiting confirmation nor already reconciled.
 */
export class SettlementOrderError extends Error {
  readonly code: "ORDER_NOT_FOUND" | "ORDER_NOT_AWAITING_CONFIRMATION";

  constructor(code: "ORDER_NOT_FOUND" | "ORDER_NOT_AWAITING_CONFIRMATION", orderId: string) {
    super(
      code === "ORDER_NOT_FOUND"
        ? `Order '${orderId}' not found.`
        : `Order '${orderId}' is not awaiting settlement confirmation.`
    );
    this.name = "SettlementOrderError";
    this.code = code;
  }
}

/**
 * Supplies the delivery receipt and supplier bill for the claimed order, or reports which
 * one is still missing. Called only while this caller holds the settlement claim.
 */
export type EvidenceLoader = (order: any) => Promise<
  | {
      receipt: { receiptId: string; receivedQuantity: number };
      bill: {
        billId: string;
        billNumber: string;
        vendorId: string;
        billedQuantity: number;
        billedUnitPriceCents: bigint;
        billedTotalCents: bigint;
      };
    }
  | { pending: "AWAITING_DELIVERY_RECEIPT" | "AWAITING_SUPPLIER_BILL" }
>;

/**
 * What the adapter has said about a transfer. `unconfirmed` covers a `submitted` result and a confirm call
 * that threw: the payment may already exist on chain, so it is never read as a failure.
 */
type TransferOutcome =
  | { kind: "confirmed"; timestamp: Date }
  | { kind: "failed"; failureCode?: string }
  | { kind: "unconfirmed" };

function outcomeOf(result: TransferResult): TransferOutcome {
  if (result.status === "confirmed") return { kind: "confirmed", timestamp: result.timestamp };
  if (result.status === "failed") return { kind: "failed", failureCode: result.failureCode };
  return { kind: "unconfirmed" };
}

/**
 * The only place an order is settled: claim, 3-way match, payment, confirmation, restock, workflow
 * transition, audit and journal. Every caller (the procurement runner and the studio document route) goes
 * through `settle`, and a transfer that was sent but not confirmed is finished through `confirmSettlement`.
 * An order is paid and restocked at most once.
 */
export class OrderSettlementService {
  private workflowEngine = new WorkflowEngine();
  private readonly settlementFor: (mode: string) => SettlementAdapter;

  constructor(deps: { settlementFor: (mode: string) => SettlementAdapter }) {
    this.settlementFor = deps.settlementFor;
  }

  /**
   * Reconciles an order at most once. The order row is claimed with an atomic
   * `confirmed | payment_hold -> settling` update before any effect, so concurrent or repeated calls
   * cannot pay the supplier or restock twice. If the settlement adapter fails before a
   * result is stored, or the result is not MATCHED, the claim is released to the status it
   * replaced (`confirmed` or `payment_hold`) and the call can be retried. Nothing has been
   * restocked or journaled at that point. A transfer that was sent but not confirmed leaves the order
   * `settlement_submitted` until `confirmSettlement` resolves it.
   */
  async settle(orderId: string, loadEvidence: EvidenceLoader): Promise<ReconcileResult> {
    // The claim is attempted at most twice. A caller can lose the claim to a holder that then
    // parks the order in `payment_hold`, which is claimable. One retry covers that; if the
    // order is still held after the second attempt, the caller reports RECONCILE_IN_PROGRESS.
    let claimed: any = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      // The claim also returns the status it replaced, so every release restores exactly that.
      const claimRes = await query(
        `WITH prev AS (SELECT status FROM orders WHERE id = $1 FOR UPDATE)
         UPDATE orders o SET status = 'settling', updated_at = NOW() FROM prev
         WHERE o.id = $1 AND o.status IN ('confirmed', 'payment_hold')
         RETURNING o.*, prev.status AS prev_status;`,
        [orderId]
      );
      if (claimRes.rows.length > 0) {
        claimed = claimRes.rows[0];
        break;
      }

      const currentRes = await query(`SELECT * FROM orders WHERE id = $1;`, [orderId]);
      if (currentRes.rows.length === 0) {
        throw new Error(`Order '${orderId}' not found.`);
      }
      const current = currentRes.rows[0];
      if (current.status === "reconciled") {
        return this.storedReconcileResult(current);
      }
      if (current.status === "settling") {
        // Task 5/10 recovery: an order left in `settling` after a crash or a failed finalising
        // step has no automatic recovery yet; it holds as RECONCILE_IN_PROGRESS. Report the
        // stored match outcome if there is one. MatchStatus.UNMATCHED is the "no match evaluated
        // yet" value, so a hold never claims MATCHED on its own.
        return this.inProgressResult(current.id);
      }
      if (current.status === "settlement_submitted") {
        // The transfer was sent and its outcome is not yet confirmed. Settling again could send a
        // second transfer, so report the stored hash and wait for confirmSettlement.
        return this.awaitingResult(current.id, current.tx_hash);
      }
      if (current.status === "confirmed" || current.status === "payment_hold") {
        // Both are claimable. A holder can release to `confirmed` (evidence pending, or a match
        // that is not MATCHED) or park the order in `payment_hold`. Retry once; if the order is
        // still unclaimed after the second attempt, report RECONCILE_IN_PROGRESS. Nothing is paid here.
        if (attempt < 2) continue;
        return this.inProgressResult(current.id);
      }
      throw new Error(`Order '${orderId}' is in status '${current.status}' and cannot be reconciled.`);
    }
    if (claimed === null) {
      throw new Error(`Order '${orderId}' could not be claimed for settlement.`);
    }

    const { prev_status: prevStatusRaw, ...order } = claimed;
    const prevStatus: ClaimableStatus = prevStatusRaw === "payment_hold" ? "payment_hold" : "confirmed";
    const progress = { paid: false };
    try {
      return await this.settleClaimedOrder(order, loadEvidence, progress, prevStatus);
    } catch (err) {
      // Release the claim unless the adapter already returned a payment. If we fail
      // after a successful transfer the order stays `settling` (a visible hold)
      // rather than being offered for a second payment.
      if (!progress.paid) {
        try {
          await this.releaseClaim(order.id, prevStatus);
        } catch (releaseErr) {
          // Never mask the original failure. The order stays `settling` (held).
          console.error(`Could not release settlement claim on order '${order.id}':`, releaseErr);
        }
      }
      throw err;
    }
  }

  /**
   * Finishes a transfer that was sent but not confirmed. The order is claimed with one atomic update from
   * `settlement_submitted`, the adapter is asked for the outcome once, and the order is finished only on
   * `confirmed`. Nothing is paid here. A `submitted` outcome restores `settlement_submitted`; a `failed`
   * outcome moves the order to `payment_hold` with SETTLEMENT_FAILED.
   */
  async confirmSettlement(orderId: string): Promise<ReconcileResult> {
    const claimRes = await query(
      `WITH prev AS (SELECT status FROM orders WHERE id = $1 FOR UPDATE)
       UPDATE orders o SET status = 'settling', updated_at = NOW() FROM prev
       WHERE o.id = $1 AND o.status = 'settlement_submitted'
       RETURNING o.*, prev.status AS prev_status;`,
      [orderId]
    );
    if (claimRes.rows.length > 0) {
      const order = claimRes.rows[0];
      try {
        return await this.confirmClaimedOrder(order);
      } catch (err) {
        // Nothing was paid by this call, so the order goes back to waiting for a confirmation.
        try {
          await this.releaseClaim(order.id, "settlement_submitted");
        } catch (releaseErr) {
          console.error(`Could not release confirmation claim on order '${order.id}':`, releaseErr);
        }
        throw err;
      }
    }

    // The claim was not taken. Report what the order holds now, without claiming it.
    const current = await this.orderOrThrow(orderId);
    if (current.status === "reconciled") {
      return this.storedReconcileResult(current);
    }
    if (current.status === "settling") {
      return this.inProgressResult(orderId);
    }
    if (current.status === "settlement_submitted") {
      // Only reachable when a holder restored the order between the claim and this read.
      return this.awaitingResult(orderId, current.tx_hash);
    }
    throw new SettlementOrderError("ORDER_NOT_AWAITING_CONFIRMATION", orderId);
  }

  /** Puts a claimed order back to the status it had before the claim. */
  private async releaseClaim(orderId: string, status: RestorableStatus): Promise<void> {
    await query(
      `UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1 AND status = 'settling';`,
      [orderId, status]
    );
  }

  /** The hold reported to a caller that cannot claim an order another caller is settling or has held. */
  private async inProgressResult(orderId: string): Promise<ReconcileResult> {
    const matchRes = await query(`SELECT match_status FROM three_way_matches WHERE order_id = $1;`, [orderId]);
    return {
      status: (matchRes.rows[0]?.match_status as MatchStatus) ?? MatchStatus.UNMATCHED,
      reconciled: false,
      hold: "RECONCILE_IN_PROGRESS",
    };
  }

  private async storedReconcileResult(order: any): Promise<ReconcileResult> {
    const matchRes = await query(`SELECT match_status FROM three_way_matches WHERE order_id = $1;`, [order.id]);
    return {
      status: (matchRes.rows[0]?.match_status as MatchStatus) ?? MatchStatus.MATCHED,
      reconciled: true,
      txHash: order.tx_hash ?? undefined,
      alreadyReconciled: true,
    };
  }

  /**
   * The result for an order whose transfer was sent but not confirmed. A transfer is only sent after a
   * MATCHED result, so the stored match is the one that paid.
   */
  private async awaitingResult(orderId: string, txHash: string | null): Promise<ReconcileResult> {
    const matchRes = await query(`SELECT match_status FROM three_way_matches WHERE order_id = $1;`, [orderId]);
    return {
      status: (matchRes.rows[0]?.match_status as MatchStatus) ?? MatchStatus.MATCHED,
      reconciled: false,
      txHash: txHash ?? undefined,
      pending: "AWAITING_SETTLEMENT_CONFIRMATION",
    };
  }

  private async orderOrThrow(orderId: string): Promise<any> {
    const res = await query(`SELECT * FROM orders WHERE id = $1;`, [orderId]);
    if (res.rows.length === 0) {
      throw new SettlementOrderError("ORDER_NOT_FOUND", orderId);
    }
    return res.rows[0];
  }

  /**
   * Moves a claimed order to `payment_hold` and writes the denial audit row. Nothing was paid on this path,
   * so the hold can be claimed again later.
   */
  private async holdClaim(order: any, action: string, evidence: Record<string, unknown>): Promise<void> {
    await query(
      `UPDATE orders SET status = 'payment_hold', updated_at = NOW() WHERE id = $1 AND status = 'settling';`,
      [order.id]
    );
    await this.workflowEngine.recordAudit(
      order.workspace_id,
      null,
      "system",
      "settlement_engine",
      EffectClass.COMMERCIAL_COMMITMENT,
      action,
      PolicyDecision.DENY,
      evidence
    );
  }

  /** One confirm call. A call that throws leaves the outcome unknown; it is never read as a failure. */
  private async confirmOnce(adapter: SettlementAdapter, txHash: string): Promise<TransferOutcome> {
    try {
      return outcomeOf(await adapter.confirm(txHash));
    } catch (err) {
      // The error can carry transport detail, so only its type is logged.
      console.warn(`Settlement outcome for ${txHash} is unknown (${err instanceof Error ? err.name : "unknown error"}).`);
      return { kind: "unconfirmed" };
    }
  }

  /**
   * Finishes a claimed order whose transfer was sent earlier: confirms it, then pays or holds or releases.
   * Facts about the payment come only from the payment record stored with the transfer, never from the
   * latest documents, which may have changed since the transfer was sent.
   */
  private async confirmClaimedOrder(order: any): Promise<ReconcileResult> {
    if (!order.tx_hash) {
      throw new Error(`Order '${order.id}' is settlement_submitted without a transaction hash.`);
    }
    const missing = [
      ["settled_amount_cents", order.settled_amount_cents],
      ["settled_receipt_id", order.settled_receipt_id],
      ["settled_bill_id", order.settled_bill_id],
    ]
      .filter(([, value]) => value === null || value === undefined)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `Order '${order.id}' cannot be finished: its payment record is missing ${missing.join(", ")}.`
      );
    }
    const wsRes = await query(`SELECT * FROM workspaces WHERE id = $1;`, [order.workspace_id]);
    const workspace = wsRes.rows[0];
    if (!workspace) {
      throw new Error(`Workspace '${order.workspace_id}' not found.`);
    }
    const adapter = this.settlementFor(workspace.settlement_mode);
    const outcome = await this.confirmOnce(adapter, order.tx_hash);

    if (outcome.kind === "failed") {
      await this.holdClaim(order, "settlement.failed", {
        orderId: order.id,
        hold: "SETTLEMENT_FAILED",
        txHash: order.tx_hash,
        failureCode: outcome.failureCode,
      });
      return { status: await this.matchStatusOf(order.id), reconciled: false, txHash: order.tx_hash, hold: "SETTLEMENT_FAILED" };
    }
    if (outcome.kind === "unconfirmed") {
      await this.releaseClaim(order.id, "settlement_submitted");
      return this.awaitingResult(order.id, order.tx_hash);
    }

    // Restock the quantity of the receipt the payment was matched against. A missing receipt is an error,
    // never a reason to read a different one.
    const receiptRes = await query(`SELECT received_quantity FROM delivery_receipts WHERE id = $1 AND order_id = $2;`, [
      order.settled_receipt_id,
      order.id,
    ]);
    if (receiptRes.rows.length === 0) {
      throw new Error(
        `Order '${order.id}' cannot be finished: payment receipt '${order.settled_receipt_id}' is not stored.`
      );
    }
    await this.finaliseConfirmedPayment(order, {
      txHash: order.tx_hash,
      settledAt: outcome.timestamp,
      receivedQuantity: Number(receiptRes.rows[0].received_quantity),
      payableAmountCents: BigInt(order.settled_amount_cents),
      mode: adapter.mode,
    });
    return { status: await this.matchStatusOf(order.id), reconciled: true, txHash: order.tx_hash };
  }

  private async matchStatusOf(orderId: string): Promise<MatchStatus> {
    const matchRes = await query(`SELECT match_status FROM three_way_matches WHERE order_id = $1;`, [orderId]);
    return (matchRes.rows[0]?.match_status as MatchStatus) ?? MatchStatus.MATCHED;
  }

  /**
   * The finalising step for a confirmed payment, shared by `settle` and `confirmSettlement`: records the
   * payment and the restock in one transaction, only while this caller holds the claim; writes the
   * anti-drift record; moves the workflow to RECONCILED; audits; and journals. The Arc label is used only
   * for the Arc adapter; every other adapter is labelled as a local simulation.
   */
  private async finaliseConfirmedPayment(
    order: any,
    payment: {
      txHash: string;
      settledAt: Date;
      receivedQuantity: number;
      payableAmountCents: bigint;
      mode: "local" | "arc-testnet";
    }
  ): Promise<void> {
    // Record the payment and restock in one transaction, and only if this call still
    // holds the claim, so restock cannot happen twice.
    const finalized = await withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE orders SET status = 'reconciled', tx_hash = $1, updated_at = NOW()
         WHERE id = $2 AND status = 'settling'
         RETURNING id;`,
        [payment.txHash, order.id]
      );
      if (upd.rows.length === 0) return false;
      await client.query(
        `UPDATE inventory_items
         SET current_quantity = current_quantity + $1, updated_at = NOW()
         WHERE workspace_id = $2 AND sku = $3;`,
        [payment.receivedQuantity, order.workspace_id, order.item_sku]
      );
      return true;
    });
    if (!finalized) {
      throw new Error(`Order '${order.id}' lost its settlement claim after payment ${payment.txHash}.`);
    }

    // Find associated workflow and transition to RECONCILED
    const wfRes = await query(`SELECT id FROM workflows WHERE context_data->>'orderId' = $1;`, [order.id]);
    if (wfRes.rows.length > 0) {
      const activeWf = await this.workflowEngine.getWorkflow(wfRes.rows[0].id);
      if (activeWf?.contextData?.decisionRecord) {
        try {
          await writeWorkflowAntiDriftFiles(activeWf.contextData.decisionRecord, {
            settlementTxHash: payment.txHash,
            paymentStatusOverride: payment.mode === "arc-testnet" ? "SETTLED_ON_ARC_TESTNET" : "SETTLED_LOCAL_SIMULATION",
          });
        } catch {
          // Continue if file write fails in testing
        }
      }

      await this.workflowEngine.transition(wfRes.rows[0].id, {
        fromState: WorkflowState.CONFIRMED,
        toState: WorkflowState.RECONCILED,
        patchContext: { txHash: payment.txHash, settledAt: payment.settledAt },
      });

      await this.workflowEngine.recordAudit(
        order.workspace_id,
        wfRes.rows[0].id,
        "system",
        "settlement_engine",
        EffectClass.COMMERCIAL_COMMITMENT,
        "settlement.reconcile_and_pay",
        PolicyDecision.ALLOW,
        { txHash: payment.txHash, payableAmountCents: payment.payableAmountCents.toString() },
        payment.txHash
      );
    }

    await recordIdempotentJournalEntry({
      workspaceId: order.workspace_id,
      orderId: order.id,
      orderNumber: order.order_number,
      itemName: order.item_name,
      supplierName: order.supplier_name,
      amountCents: payment.payableAmountCents,
      txHash: payment.txHash,
    });
  }

  /**
   * The claim was lost after the transfer went out (ADR 0030). The stuck-claim step moved the order to `payment_hold`
   * with no hash, while this settle was still in flight. The hash and the payment record are attached to that hold,
   * and the order goes to `settlement_submitted`, so the worker's confirmation poll finishes it. Nothing is paid here.
   * Any other state is left alone: this call changes nothing and reports the reconciliation as in progress.
   */
  private async reattachLostTransfer(
    order: any,
    transfer: TransferResult,
    status: MatchStatus,
    payment: { amountCents: bigint; receiptId: string; billId: string }
  ): Promise<ReconcileResult> {
    const current = await query(`SELECT status, tx_hash FROM orders WHERE id = $1;`, [order.id]);
    const row = current.rows[0];
    if (!row || row.status !== "payment_hold" || row.tx_hash !== null) {
      return { status, reconciled: false, hold: "RECONCILE_IN_PROGRESS" };
    }
    // The guard is repeated in the write, so a hold that changes between the read and the write is not touched.
    const attached = await withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE orders
         SET status = 'settlement_submitted', tx_hash = $2, settled_amount_cents = $3, settled_receipt_id = $4,
             settled_bill_id = $5, updated_at = NOW()
         WHERE id = $1 AND status = 'payment_hold' AND tx_hash IS NULL
         RETURNING id;`,
        [order.id, transfer.txHash, payment.amountCents, payment.receiptId, payment.billId]
      );
      if (upd.rowCount !== 1) return false;
      await client.query(
        `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, tx_hash, created_at)
         VALUES ($1, $2, NULL, 'system', 'settlement_engine', $3, 'settlement.reattached', $4, $5, $6, NOW());`,
        [
          newId("audit"),
          order.workspace_id,
          EffectClass.COMMERCIAL_COMMITMENT,
          PolicyDecision.ALLOW,
          JSON.stringify({ orderId: order.id, txHash: transfer.txHash }),
          transfer.txHash,
        ]
      );
      return true;
    });
    if (!attached) {
      return { status, reconciled: false, hold: "RECONCILE_IN_PROGRESS" };
    }
    return { status, reconciled: false, txHash: transfer.txHash, pending: "AWAITING_SETTLEMENT_CONFIRMATION" };
  }

  private async settleClaimedOrder(
    order: any,
    loadEvidence: EvidenceLoader,
    progress: { paid: boolean },
    prevStatus: ClaimableStatus
  ): Promise<ReconcileResult> {
    const evidence = await loadEvidence(order);
    if ("pending" in evidence) {
      // Nothing can be matched yet. Release the claim so the missing document can arrive
      // and the order can be settled by a later call.
      await this.releaseClaim(order.id, prevStatus);
      return { status: MatchStatus.UNMATCHED, reconciled: false, pending: evidence.pending };
    }
    const { receipt, bill } = evidence;

    // Run 3-Way Match
    const matchResult = evaluateThreeWayMatch(
      {
        orderId: order.id,
        orderNumber: order.order_number,
        vendorId: order.supplier_id,
        sku: order.item_sku,
        quantity: Number(order.quantity),
        unitPriceCents: BigInt(order.unit_price_cents),
        totalPriceCents: BigInt(order.total_price_cents),
      },
      {
        receiptId: receipt.receiptId,
        orderId: order.id,
        sku: order.item_sku,
        receivedQuantity: receipt.receivedQuantity,
      },
      {
        billId: bill.billId,
        orderId: order.id,
        billNumber: bill.billNumber,
        vendorId: bill.vendorId,
        sku: order.item_sku,
        billedQuantity: bill.billedQuantity,
        billedUnitPriceCents: bill.billedUnitPriceCents,
        billedTotalCents: bill.billedTotalCents,
      }
    );

    if (matchResult.status !== MatchStatus.MATCHED) {
      // Record the failure before the match row below can be overwritten by a later evaluation.
      await this.workflowEngine.recordAudit(
        order.workspace_id,
        null,
        "system",
        "three_way_match_engine",
        EffectClass.COMMERCIAL_COMMITMENT,
        "accounting.three_way_match_failed",
        PolicyDecision.DENY,
        {
          orderId: order.id,
          matchStatus: matchResult.status,
          varianceCents: matchResult.varianceCents.toString(),
          discrepancyReason: matchResult.discrepancyReason,
        }
      );
    }

    // Save 3-Way Match Result: one row per order, deterministic id.
    await query(
      `INSERT INTO three_way_matches (id, order_id, delivery_receipt_id, supplier_bill_id, match_status, variance_cents, notes, matched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (order_id) DO UPDATE SET
         delivery_receipt_id = EXCLUDED.delivery_receipt_id,
         supplier_bill_id = EXCLUDED.supplier_bill_id,
         match_status = EXCLUDED.match_status,
         variance_cents = EXCLUDED.variance_cents,
         notes = EXCLUDED.notes,
         matched_at = NOW();`,
      [
        `match_${order.id}`,
        order.id,
        receipt.receiptId,
        bill.billId,
        matchResult.status,
        matchResult.varianceCents,
        matchResult.discrepancyReason || "Perfect 3-way match",
      ]
    );

    if (matchResult.status !== MatchStatus.MATCHED) {
      // Nothing was paid: release the claim so the order can be corrected and retried.
      await this.releaseClaim(order.id, prevStatus);
      return {
        status: matchResult.status,
        reconciled: false,
        varianceCents: matchResult.varianceCents.toString(),
        discrepancyReason: matchResult.discrepancyReason,
      };
    }

    // The payee is the order's supplier as recorded; the payer is the workspace wallet. A
    // missing or unverified record holds the order. It never falls back to a constant address.
    const wsRes = await query(`SELECT * FROM workspaces WHERE id = $1;`, [order.workspace_id]);
    const workspace = wsRes.rows[0];
    const suppRes = await query(`SELECT * FROM suppliers WHERE id = $1;`, [order.supplier_id]);
    const supplier = suppRes.rows[0];

    let hold: ReconcileHold | null = null;
    // A supplier record from another workspace is never a payee, even when it is verified and payable.
    if (!supplier || supplier.workspace_id !== order.workspace_id || !supplier.verified) {
      hold = "SUPPLIER_NOT_VERIFIED";
    } else if (!supplier.payment_address) {
      hold = "SUPPLIER_PAYMENT_ADDRESS_MISSING";
    } else if (!workspace.settlement_address) {
      hold = "WORKSPACE_SETTLEMENT_ADDRESS_MISSING";
    }
    if (hold) {
      // Keep the match row (already written above) and hold the claim as payment_hold.
      await this.holdClaim(order, "settlement.payment_hold", { orderId: order.id, hold });
      return { status: MatchStatus.MATCHED, reconciled: false, hold };
    }

    // The owner's pause switch (ADR 0023). A paused workspace pays nothing. The claim is released to the status the
    // order had before it, with no transfer, no effect row, no restock and no journal. The flag is read here, at the
    // last database read before the transfer, so a pause set during the match is honoured. A pause set in the instant
    // between this read and the adapter call is not; ADR 0023 records that residual window.
    const pauseRes = await query(`SELECT agents_paused FROM workspaces WHERE id = $1;`, [order.workspace_id]);
    if (pauseRes.rows[0]?.agents_paused === true) {
      await this.releaseClaim(order.id, prevStatus);
      await this.workflowEngine.recordAudit(
        order.workspace_id,
        null,
        "system",
        "settlement_engine",
        EffectClass.COMMERCIAL_COMMITMENT,
        "settlement.paused_hold",
        PolicyDecision.DENY,
        { orderId: order.id, hold: "AGENTS_PAUSED" }
      );
      return { status: MatchStatus.MATCHED, reconciled: false, hold: "AGENTS_PAUSED" };
    }

    // Execute Settlement payment. The match hash binds the transfer to this order, receipt and bill.
    const settlementAdapter = this.settlementFor(workspace.settlement_mode);
    const matchHash = keccak256(encodePacked(["string", "string", "string"], [order.id, receipt.receiptId, bill.billId]));

    // The transfer runs through the effects ledger, so a retry never sends it a second time for this order.
    // When the adapter can look transfers up, a retry after an unknown outcome adopts the transfer it finds.
    const lookup = settlementAdapter.findTransfer?.bind(settlementAdapter);
    const paymentRequest = {
      fromAddress: workspace.settlement_address,
      toAddress: supplier.payment_address,
      amountCents: matchResult.payableAmountCents,
      currency: "USDC",
      orderId: order.id,
      idempotencyKey: `idem_pay_${order.id}`,
      matchHash,
    };
    let transfer: TransferResult;
    try {
      ({ result: transfer } = await runEffect<TransferResult>(
        {
          workspaceId: order.workspace_id,
          effectClass: EffectClass.COMMERCIAL_COMMITMENT,
          operation: "settlement.transfer_usdc",
          idempotencyKey: `${order.workspace_id}:settle:${order.id}`,
          request: paymentRequest,
        },
        () => settlementAdapter.transferUSDC(paymentRequest),
        {
          reconcile: lookup
            ? async () => {
                const found = await lookup({ orderId: order.id });
                return found ? { found: true, result: found, externalRef: found.txHash } : { found: false };
              }
            : undefined,
          externalRef: (t) => t.txHash,
        }
      ));
    } catch (err) {
      if (err instanceof SettlementRejectedError) {
        // The contract or the request refused the payment, so no transfer was made.
        await this.holdClaim(order, "settlement.rejected", { orderId: order.id, code: err.code });
        return { status: MatchStatus.MATCHED, reconciled: false, hold: "SETTLEMENT_REJECTED" };
      }
      if (err instanceof EffectInDoubtError) {
        // An earlier attempt may have moved the money. Hold the order and do not call the adapter again.
        // The evidence carries the effect id and attempts, never a transaction hash.
        await this.holdClaim(order, "settlement.in_doubt", {
          orderId: order.id,
          hold: "SETTLEMENT_OUTCOME_UNKNOWN",
          effectId: err.effectId,
          attempts: err.attempts,
        });
        return { status: MatchStatus.MATCHED, reconciled: false, hold: "SETTLEMENT_OUTCOME_UNKNOWN" };
      }
      throw err;
    }
    progress.paid = true;

    // Make the transfer durable on the claimed row before anything else, so a failure from here on
    // leaves the order `settling` with the hash recorded. The payment record (amount and the receipt and bill
    // it was matched against) is written in the same statement, so confirmation finishes this payment as made.
    // The row count is checked: zero means the claim was lost after the money moved (ADR 0030).
    const recorded = await query(
      `UPDATE orders
       SET tx_hash = $1, settled_amount_cents = $3, settled_receipt_id = $4, settled_bill_id = $5, updated_at = NOW()
       WHERE id = $2 AND status = 'settling';`,
      [transfer.txHash, order.id, matchResult.payableAmountCents, receipt.receiptId, bill.billId]
    );
    if (recorded.rowCount !== 1) {
      return this.reattachLostTransfer(order, transfer, matchResult.status, {
        amountCents: matchResult.payableAmountCents,
        receiptId: receipt.receiptId,
        billId: bill.billId,
      });
    }

    let outcome = outcomeOf(transfer);
    if (outcome.kind === "unconfirmed") {
      outcome = await this.confirmOnce(settlementAdapter, transfer.txHash);
    }

    if (outcome.kind === "failed") {
      await this.holdClaim(order, "settlement.failed", {
        orderId: order.id,
        hold: "SETTLEMENT_FAILED",
        txHash: transfer.txHash,
        failureCode: outcome.failureCode,
      });
      return { status: matchResult.status, reconciled: false, txHash: transfer.txHash, hold: "SETTLEMENT_FAILED" };
    }

    if (outcome.kind === "unconfirmed") {
      // The transfer may exist on chain. Keep the hash, wait for confirmSettlement, and do not restock,
      // journal or touch the workflow.
      await this.releaseClaim(order.id, "settlement_submitted");
      await this.workflowEngine.recordAudit(
        order.workspace_id,
        null,
        "system",
        "settlement_engine",
        EffectClass.COMMERCIAL_COMMITMENT,
        "settlement.submitted",
        PolicyDecision.ALLOW,
        { orderId: order.id, txHash: transfer.txHash },
        transfer.txHash
      );
      return {
        status: matchResult.status,
        reconciled: false,
        txHash: transfer.txHash,
        pending: "AWAITING_SETTLEMENT_CONFIRMATION",
      };
    }

    await this.finaliseConfirmedPayment(order, {
      txHash: transfer.txHash,
      settledAt: outcome.timestamp,
      receivedQuantity: receipt.receivedQuantity,
      payableAmountCents: matchResult.payableAmountCents,
      mode: settlementAdapter.mode,
    });

    return {
      status: matchResult.status,
      reconciled: true,
      txHash: transfer.txHash,
    };
  }
}
