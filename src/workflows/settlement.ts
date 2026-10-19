import { query, withTransaction } from "../db/client.js";
import { WorkflowEngine } from "./engine.js";
import { WorkflowState } from "./types.js";
import { PolicyDecision } from "../policy/engine.js";
import { EffectClass } from "../policy/effect-classifier.js";
import type { SettlementAdapter } from "../adapters/settlement/types.js";
import { evaluateThreeWayMatch, MatchStatus } from "../accounting/three-way-match.js";
import { recordIdempotentJournalEntry } from "../accounting/journal.js";
import { writeWorkflowAntiDriftFiles } from "../agents/antiDriftWriter.js";

/**
 * Why an order is not paid. RECONCILE_IN_PROGRESS means another caller holds the claim.
 * The three payment codes mean the order is held in `payment_hold`: the match passed, but
 * no payee or payer is verified, so nothing is paid or restocked until the record is fixed.
 */
export type ReconcileHold =
  | "RECONCILE_IN_PROGRESS"
  | "SUPPLIER_NOT_VERIFIED"
  | "SUPPLIER_PAYMENT_ADDRESS_MISSING"
  | "WORKSPACE_SETTLEMENT_ADDRESS_MISSING";

/** The statuses an order can hold before a settlement claim; the claim restores the one it replaced. */
type ClaimableStatus = "confirmed" | "payment_hold";

export interface ReconcileResult {
  status: MatchStatus;
  reconciled: boolean;
  txHash?: string;
  alreadyReconciled?: boolean;
  hold?: ReconcileHold;
  varianceCents?: string;
  discrepancyReason?: string;
  pending?: "AWAITING_DELIVERY_RECEIPT" | "AWAITING_SUPPLIER_BILL";
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
 * The only place an order is settled: claim, 3-way match, payment, restock, workflow
 * transition, audit and journal. Every caller (the procurement runner and the studio
 * document route) goes through `settle`, so an order is paid and restocked at most once.
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
   * restocked or journaled at that point.
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

  /** Puts a claimed order back to the status it had before the claim. */
  private async releaseClaim(orderId: string, status: ClaimableStatus): Promise<void> {
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
        "settlement.payment_hold",
        PolicyDecision.DENY,
        { orderId: order.id, hold }
      );
      return { status: MatchStatus.MATCHED, reconciled: false, hold };
    }

    // Execute Settlement payment
    const settlementAdapter = this.settlementFor(workspace.settlement_mode);

    const transferRes = await settlementAdapter.transferUSDC({
      fromAddress: workspace.settlement_address,
      toAddress: supplier.payment_address,
      amountCents: matchResult.payableAmountCents,
      currency: "USDC",
      orderId: order.id,
      idempotencyKey: `idem_pay_${order.id}`,
    });
    progress.paid = true;

    // Make the payment durable on the claimed row before the finalising step, so a
    // failure from here on leaves `settling` with the tx hash recorded.
    await query(`UPDATE orders SET tx_hash = $1, updated_at = NOW() WHERE id = $2 AND status = 'settling';`, [
      transferRes.txHash,
      order.id,
    ]);

    // Record the payment and restock in one transaction, and only if this call still
    // holds the claim, so restock cannot happen twice.
    const finalized = await withTransaction(async (client) => {
      const upd = await client.query(
        `UPDATE orders SET status = 'reconciled', tx_hash = $1, updated_at = NOW()
         WHERE id = $2 AND status = 'settling'
         RETURNING id;`,
        [transferRes.txHash, order.id]
      );
      if (upd.rows.length === 0) return false;
      await client.query(
        `UPDATE inventory_items
         SET current_quantity = current_quantity + $1, updated_at = NOW()
         WHERE workspace_id = $2 AND sku = $3;`,
        [receipt.receivedQuantity, order.workspace_id, order.item_sku]
      );
      return true;
    });
    if (!finalized) {
      throw new Error(`Order '${order.id}' lost its settlement claim after payment ${transferRes.txHash}.`);
    }

    // Find associated workflow and transition to RECONCILED
    const wfRes = await query(
      `SELECT id FROM workflows WHERE context_data->>'orderId' = $1;`,
      [order.id]
    );
    if (wfRes.rows.length > 0) {
      const activeWf = await this.workflowEngine.getWorkflow(wfRes.rows[0].id);
      if (activeWf?.contextData?.decisionRecord) {
        try {
          await writeWorkflowAntiDriftFiles(activeWf.contextData.decisionRecord, {
            settlementTxHash: transferRes.txHash,
            paymentStatusOverride: "SETTLED_ON_ARC_TESTNET",
          });
        } catch {
          // Continue if file write fails in testing
        }
      }

      await this.workflowEngine.transition(wfRes.rows[0].id, {
        fromState: WorkflowState.CONFIRMED,
        toState: WorkflowState.RECONCILED,
        patchContext: { txHash: transferRes.txHash, settledAt: transferRes.timestamp },
      });

      await this.workflowEngine.recordAudit(
        order.workspace_id,
        wfRes.rows[0].id,
        "system",
        "settlement_engine",
        EffectClass.COMMERCIAL_COMMITMENT,
        "settlement.reconcile_and_pay",
        PolicyDecision.ALLOW,
        { txHash: transferRes.txHash, payableAmountCents: matchResult.payableAmountCents.toString() },
        transferRes.txHash
      );
    }

    await recordIdempotentJournalEntry({
      workspaceId: order.workspace_id,
      orderId: order.id,
      orderNumber: order.order_number,
      itemName: order.item_name,
      supplierName: order.supplier_name,
      amountCents: matchResult.payableAmountCents,
      txHash: transferRes.txHash,
    });

    return {
      status: matchResult.status,
      reconciled: true,
      txHash: transferRes.txHash,
    };
  }
}
