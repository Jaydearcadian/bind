import { WorkflowEngine, ApprovalDecisionError } from "./engine.js";
import { WorkflowState } from "./types.js";
import { query, withTransaction } from "../db/client.js";
import { PolicyDecision } from "../policy/engine.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { getSupplierAdapter } from "../adapters/suppliers/index.js";
import type { SupplierAdapter } from "../adapters/suppliers/types.js";
import { getSettlementAdapter } from "../adapters/settlement/index.js";
import type { SettlementAdapter } from "../adapters/settlement/types.js";
import { evaluateThreeWayMatch, MatchStatus } from "../accounting/three-way-match.js";
import { generateIdempotencyKey } from "../utils/idempotency.js";
import { resolveTemplateDir } from "../agents/bindTemplateAgent.js";
import { writeWorkflowAntiDriftFiles } from "../agents/antiDriftWriter.js";
import { createReplenishmentTools } from "../agents/replenishmentTools.js";
import { recordIdempotentJournalEntry } from "../studio/documentsAndAccounting.js";

export interface ProcurementRunnerDeps {
  settlementFor?: (mode: string) => SettlementAdapter;
  supplierFor?: (id: string) => SupplierAdapter;
}

export interface ReconcileResult {
  status: MatchStatus;
  reconciled: boolean;
  txHash?: string;
  alreadyReconciled?: boolean;
  hold?: string;
}

export class ProcurementWorkflowRunner {
  private workflowEngine = new WorkflowEngine();
  private readonly settlementFor: (mode: string) => SettlementAdapter;
  private readonly supplierFor: (id: string) => SupplierAdapter;

  constructor(deps: ProcurementRunnerDeps = {}) {
    this.settlementFor =
      deps.settlementFor ?? ((mode: string) => getSettlementAdapter(mode as "local" | "arc-testnet"));
    this.supplierFor = deps.supplierFor ?? getSupplierAdapter;
  }

  /**
   * Triggers the procurement replenishment workflow from low inventory.
   */
  async startReplenishment(
    workspaceId: string,
    sku: string,
    triggerSource: string = "inventory_monitor"
  ): Promise<{ workflowId: string; state: WorkflowState; orderId?: string; approvalId?: string }> {
    // 0. Idempotency Gate on Entry: check if an active non-terminal workflow already exists
    const activeWfRes = await query(
      `SELECT id, state, context_data FROM workflows
       WHERE workspace_id = $1
         AND context_data->>'sku' = $2
         AND state NOT IN ('reconciled', 'failed', 'cancelled')
       ORDER BY created_at DESC LIMIT 1;`,
      [workspaceId, sku]
    );
    if (activeWfRes.rows.length > 0) {
      const activeWf = activeWfRes.rows[0];
      return {
        workflowId: activeWf.id,
        state: activeWf.state as WorkflowState,
        orderId: activeWf.context_data?.orderId,
        approvalId: activeWf.context_data?.approvalId,
      };
    }

    // 1. Fetch Inventory Item
    const itemRes = await query(
      `SELECT * FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`,
      [workspaceId, sku]
    );
    if (itemRes.rows.length === 0) {
      throw new Error(`Inventory item '${sku}' not found in workspace '${workspaceId}'.`);
    }
    const item = itemRes.rows[0];

    // 2. Check if replenishment is needed
    const currentQty = Number(item.current_quantity);
    const parLevel = Number(item.par_level);
    const reorderQty = Number(item.reorder_quantity);

    if (currentQty >= parLevel) {
      throw new Error(`Item '${item.name}' has sufficient stock (${currentQty} >= par ${parLevel}). No order needed.`);
    }

    const workflowId = `wf_proc_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const idempotencyKey = generateIdempotencyKey(workspaceId, "procurement.replenish", { sku, currentQty });

    // 3. Create Workflow in DRAFT state
    await this.workflowEngine.createWorkflow(
      workflowId,
      workspaceId,
      "kitchen_replenishment",
      idempotencyKey,
      { sku, itemName: item.name, triggerSource, currentQty, parLevel, reorderQty }
    );

    await this.workflowEngine.recordAudit(
      workspaceId,
      workflowId,
      "agent",
      "procurement_agent",
      EffectClass.READ,
      "inventory.detect_low_stock",
      PolicyDecision.ALLOW,
      { sku, currentQty, parLevel, reorderQty }
    );

    // 4. Transition to REQUEST_SENT and request quote
    await this.workflowEngine.transition(workflowId, {
      fromState: WorkflowState.DRAFT,
      toState: WorkflowState.REQUEST_SENT,
    });

    let supplierId = item.preferred_supplier_id;
    if (!supplierId) {
      const existingSupp = await query(
        `SELECT id FROM suppliers WHERE workspace_id = $1 AND verified = TRUE ORDER BY created_at ASC LIMIT 1;`,
        [workspaceId]
      );
      if (existingSupp.rows.length > 0) {
        supplierId = existingSupp.rows[0].id;
      } else {
        supplierId = `${workspaceId}_supp-sysco-metro`;
        await query(
          `INSERT INTO suppliers (id, workspace_id, name, adapter_type, contact_email, verified, is_simulated, created_at)
           VALUES ($1, $2, 'Sysco Metro Restock', 'simulated_sysco', 'orders@sysco-sim.local', TRUE, TRUE, NOW())
           ON CONFLICT (id) DO NOTHING;`,
          [supplierId, workspaceId]
        );
      }
    }
    const supplierAdapter = this.supplierFor(supplierId);

    const quoteRes = await supplierAdapter.requestQuote({
      workspaceId,
      sku,
      quantity: reorderQty,
      rfqId: `rfq_${workflowId}`,
      supplierId,
    });

    // Record quote in DB with 24h validity
    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await query(
      `INSERT INTO quotes (id, workspace_id, rfq_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, currency, valid_until, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'USDC', $10, NOW());`,
      [
        quoteRes.quoteId,
        workspaceId,
        quoteRes.rfqId,
        quoteRes.supplierId,
        quoteRes.supplierName,
        quoteRes.sku,
        quoteRes.quantity,
        quoteRes.unitPriceCents,
        quoteRes.totalPriceCents,
        validUntil,
      ]
    );

    // 5. Transition to QUOTE_RECEIVED
    await this.workflowEngine.transition(workflowId, {
      fromState: WorkflowState.REQUEST_SENT,
      toState: WorkflowState.QUOTE_RECEIVED,
      patchContext: {
        quote: quoteRes,
      },
    });

    // 6. Execute deepagents Replenishment Agent Loop
    const wsRes = await query(`SELECT * FROM workspaces WHERE id = $1;`, [workspaceId]);
    const ws = wsRes.rows[0];
    const tools = createReplenishmentTools({ workspaceId, workflowId });
    const templateDir = resolveTemplateDir(ws?.template_id || "kitchen-ops");

    if (ws?.settlement_mode === "arc-testnet") {
      // In live Arc Testnet mode, require NEBIUS_API_KEY. Spec Invariant 10 prohibits silent downgrade.
      if (!process.env.NEBIUS_API_KEY) {
        const errorMsg =
          "[INVARIANT_10_BLOCKED] Missing NEBIUS_API_KEY for live arc-testnet replenishment agent. Silent downgrade prohibited.";
        await this.workflowEngine.transition(workflowId, {
          fromState: WorkflowState.QUOTE_RECEIVED,
          toState: WorkflowState.FAILED,
          errorMessage: errorMsg,
        });
        return { workflowId, state: WorkflowState.FAILED };
      }

      const { createDeepAgent, FilesystemBackend } = await import("deepagents");
      const { ChatOpenAI } = await import("@langchain/openai");

      const model = new ChatOpenAI({
        model: process.env.NEBIUS_MODEL ?? "nousresearch/Hermes-4-405B",
        configuration: {
          baseURL: "https://api.tokenfactory.nebius.com/v1/",
          apiKey: process.env.NEBIUS_API_KEY,
        },
        temperature: 0,
      });

      const agent = createDeepAgent({
        model,
        tools: tools.allTools,
        memory: ["/AGENTS.md"],
        skills: ["/skills/"],
        backend: new FilesystemBackend({
          rootDir: templateDir,
          virtualMode: true,
        }),
        systemPrompt:
          "You are Bind's Replenishment Agent. Follow these steps: " +
          "1. Call get_business_context and get_stock_snapshot. " +
          "2. Call get_approved_supplier_quotes for the item. " +
          "3. Select the best unexpired verified quote, calculate required quantity, and call create_replenishment_proposal. " +
          "4. Call request_policy_evaluation and get_request_status.",
      });

      try {
        await agent.invoke({
          messages: [
            {
              role: "user",
              content: `Low stock detected on SKU ${sku} (${item.name}). Current stock is ${currentQty}, par level is ${parLevel}. Complete the replenishment procedure.`,
            },
          ],
        });
      } catch (err: any) {
        await this.workflowEngine.transition(workflowId, {
          fromState: WorkflowState.QUOTE_RECEIVED,
          toState: WorkflowState.FAILED,
          errorMessage: `Replenishment agent failed: ${err.message}`,
        });
        return { workflowId, state: WorkflowState.FAILED };
      }
    } else {
      // Offline / Local / Test Mode: execute the exact 6 tools deterministically
      await tools.getBusinessContextTool.invoke({});
      await tools.getStockSnapshotTool.invoke({ sku });
      const quotesRaw = await tools.getApprovedSupplierQuotesTool.invoke({ sku });
      const parsed = JSON.parse(quotesRaw);
      const validQuotes = (parsed.quotes || []).filter((q: any) => !q.isExpired);
      const chosen = validQuotes[0] || {
        quoteId: quoteRes.quoteId,
        supplierId: quoteRes.supplierId,
        unitPriceCents: quoteRes.unitPriceCents.toString(),
      };

      await tools.createReplenishmentProposalTool.invoke({
        itemId: sku,
        quantity: reorderQty,
        supplierId: chosen.supplierId,
        quoteId: chosen.quoteId,
        reasonCodes: ["LOW_INVENTORY_PAR_BREACH", "PREVENT_STOCKOUT"],
        explanation: `Stock (${currentQty}) is below par level (${parLevel}). Selected verified quote for ${reorderQty} units at $${(Number(chosen.unitPriceCents) / 100).toFixed(2)}/unit.`,
        sourceRecordIds: [chosen.quoteId, item.id],
      });

      await tools.requestPolicyEvaluationTool.invoke({ requestId: workflowId });
      await tools.getRequestStatusTool.invoke({ requestId: workflowId });
    }

    // 7. Check result of policy evaluation from DB
    const updatedWf = await this.workflowEngine.getWorkflow(workflowId);
    if (!updatedWf) {
      throw new Error(`Workflow '${workflowId}' lost after policy evaluation.`);
    }

    if (updatedWf.state === WorkflowState.FAILED) {
      return { workflowId, state: WorkflowState.FAILED };
    }

    if (updatedWf.state === WorkflowState.AWAITING_APPROVAL) {
      return {
        workflowId,
        state: WorkflowState.AWAITING_APPROVAL,
        approvalId: updatedWf.contextData?.approvalId,
      };
    }

    if (updatedWf.state === WorkflowState.AUTHORIZED) {
      const activeQuote = updatedWf.contextData?.replenishmentProposal || quoteRes;
      return this.executeOrderSubmission(workflowId, workspaceId, activeQuote, item.name);
    }

    return { workflowId, state: updatedWf.state };
  }

  /**
   * Resumes workflow after human approval.
   */
  async approveAndSubmit(
    approvalId: string,
    decidedBy: string
  ): Promise<{ workflowId: string; state: WorkflowState; orderId?: string }> {
    const apprRes = await query(`SELECT * FROM approvals WHERE id = $1;`, [approvalId]);
    if (apprRes.rows.length === 0) {
      throw new ApprovalDecisionError("APPROVAL_NOT_FOUND", `Approval '${approvalId}' not found.`);
    }
    const approval = apprRes.rows[0];

    const { workflowId } = await this.workflowEngine.resolveApproval(approvalId, "approved", decidedBy);

    const wf = await this.workflowEngine.getWorkflow(workflowId);
    const quoteRes = wf!.contextData.replenishmentProposal || wf!.contextData.quote;
    const itemName = wf!.contextData.itemName || quoteRes.sku;

    return this.executeOrderSubmission(workflowId, approval.workspace_id, quoteRes, itemName);
  }

  /**
   * Expires pending approvals past their window and cancels their workflows.
   */
  async expireApprovals(filter: { workspaceId?: string; approvalId?: string } = {}): Promise<number> {
    return this.workflowEngine.expireApprovals(filter);
  }

  /**
   * Rejects or revokes a pending approval. The waiting workflow is cancelled and
   * no order is submitted.
   */
  async declineApproval(
    approvalId: string,
    decision: "rejected" | "revoked",
    decidedBy: string,
    reason?: string
  ): Promise<{ workflowId: string; state: WorkflowState }> {
    const { workflowId } = await this.workflowEngine.resolveApproval(approvalId, decision, decidedBy, reason);
    return { workflowId, state: WorkflowState.CANCELLED };
  }

  /**
   * Submits an authorized order to the supplier adapter.
   */
  private async executeOrderSubmission(
    workflowId: string,
    workspaceId: string,
    quote: any,
    itemName: string
  ): Promise<{ workflowId: string; state: WorkflowState; orderId: string }> {
    await this.workflowEngine.transition(workflowId, {
      fromState: WorkflowState.AUTHORIZED,
      toState: WorkflowState.SUBMITTED,
    });

    const orderId = `ord_${workflowId}`;
    const orderNumber = `PO-${Date.now().toString().slice(-6)}`;
    const idempotencyKey = `idem_ord_${orderId}`;

    const supplierAdapter = this.supplierFor(quote.supplierId);
    const orderRes = await supplierAdapter.submitOrder({
      workspaceId,
      orderId,
      orderNumber,
      supplierId: quote.supplierId,
      sku: quote.sku,
      quantity: quote.quantity,
      unitPriceCents: BigInt(quote.unitPriceCents),
      totalPriceCents: BigInt(quote.totalPriceCents),
      idempotencyKey,
    });

    // Record Order in DB
    await query(
      `INSERT INTO orders (id, workspace_id, order_number, supplier_id, supplier_name, item_sku, item_name, quantity, unit_price_cents, total_price_cents, currency, status, idempotency_key, external_order_ref, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'USDC', 'confirmed', $11, $12, NOW(), NOW());`,
      [
        orderId,
        workspaceId,
        orderNumber,
        quote.supplierId,
        quote.supplierName,
        quote.sku,
        itemName,
        quote.quantity,
        quote.unitPriceCents,
        quote.totalPriceCents,
        idempotencyKey,
        orderRes.externalOrderRef,
      ]
    );

    // Transition to CONFIRMED
    await this.workflowEngine.transition(workflowId, {
      fromState: WorkflowState.SUBMITTED,
      toState: WorkflowState.CONFIRMED,
      patchContext: { orderId, orderNumber, externalOrderRef: orderRes.externalOrderRef },
    });

    await this.workflowEngine.recordAudit(
      workspaceId,
      workflowId,
      "agent",
      "procurement_agent",
      EffectClass.COMMERCIAL_COMMITMENT,
      "orders.submit",
      PolicyDecision.ALLOW,
      { orderId, orderNumber, externalOrderRef: orderRes.externalOrderRef }
    );

    return { workflowId, state: WorkflowState.CONFIRMED, orderId };
  }

  /**
   * Ingests delivery receipt & bill, runs 3-way match, and reconciles.
   *
   * Reconciliation happens at most once per order. The order row is claimed with an
   * atomic `confirmed -> settling` update before any effect, so concurrent or repeated
   * calls cannot pay the supplier or restock twice. If the settlement adapter fails
   * before a result is stored the claim is released (`settling -> confirmed`) and the
   * call can be retried; nothing has been restocked or journaled at that point.
   */
  async fulfillAndReconcile(orderId: string): Promise<ReconcileResult> {
    // Task 5/10 recovery: an order left in `settling` after a crash or a failed
    // finalising step has no automatic recovery yet; it holds as RECONCILE_IN_PROGRESS.
    const claimRes = await query(
      `UPDATE orders SET status = 'settling', updated_at = NOW()
       WHERE id = $1 AND status = 'confirmed'
       RETURNING *;`,
      [orderId]
    );

    if (claimRes.rows.length === 0) {
      const currentRes = await query(`SELECT * FROM orders WHERE id = $1;`, [orderId]);
      if (currentRes.rows.length === 0) {
        throw new Error(`Order '${orderId}' not found.`);
      }
      const current = currentRes.rows[0];
      if (current.status === "reconciled") {
        return this.storedReconcileResult(current);
      }
      if (current.status === "settling") {
        // Report the stored match outcome if there is one. MatchStatus.UNMATCHED is the
        // "no match evaluated yet" value, so a hold never claims MATCHED on its own.
        const matchRes = await query(`SELECT match_status FROM three_way_matches WHERE order_id = $1;`, [
          current.id,
        ]);
        return {
          status: (matchRes.rows[0]?.match_status as MatchStatus) ?? MatchStatus.UNMATCHED,
          reconciled: false,
          hold: "RECONCILE_IN_PROGRESS",
        };
      }
      throw new Error(`Order '${orderId}' is in status '${current.status}' and cannot be reconciled.`);
    }

    const order = claimRes.rows[0];
    const progress = { paid: false };
    try {
      return await this.settleClaimedOrder(order, progress);
    } catch (err) {
      // Release the claim unless the adapter already returned a payment. If we fail
      // after a successful transfer the order stays `settling` (a visible hold)
      // rather than being offered for a second payment.
      if (!progress.paid) {
        try {
          await query(
            `UPDATE orders SET status = 'confirmed', updated_at = NOW()
             WHERE id = $1 AND status = 'settling';`,
            [order.id]
          );
        } catch (releaseErr) {
          // Never mask the original failure. The order stays `settling` (held).
          console.error(`Could not release settlement claim on order '${order.id}':`, releaseErr);
        }
      }
      throw err;
    }
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

  private async settleClaimedOrder(order: any, progress: { paid: boolean }): Promise<ReconcileResult> {
    const supplierAdapter = this.supplierFor(order.supplier_id);

    // Delivery receipt: reuse the stored one when a previous attempt already ingested it.
    const storedReceipt = await query(
      `SELECT * FROM delivery_receipts WHERE order_id = $1 ORDER BY received_at DESC, id DESC LIMIT 1;`,
      [order.id]
    );
    let receipt: { receiptId: string; receivedQuantity: number };
    if (storedReceipt.rows.length > 0) {
      receipt = {
        receiptId: storedReceipt.rows[0].id,
        receivedQuantity: Number(storedReceipt.rows[0].received_quantity),
      };
    } else {
      const generated = await supplierAdapter.generateDeliveryReceipt(
        order.id,
        order.item_sku,
        Number(order.quantity)
      );
      await query(
        `INSERT INTO delivery_receipts (id, order_id, received_quantity, received_at, condition_notes, discrepancy_reported)
         VALUES ($1, $2, $3, NOW(), $4, FALSE)
         ON CONFLICT (id) DO NOTHING;`,
        [generated.receiptId, order.id, generated.receivedQuantity, generated.conditionNotes]
      );
      receipt = { receiptId: generated.receiptId, receivedQuantity: generated.receivedQuantity };
    }

    // Supplier bill: same rule.
    const storedBill = await query(
      `SELECT * FROM supplier_bills WHERE order_id = $1 ORDER BY received_at DESC, id DESC LIMIT 1;`,
      [order.id]
    );
    let bill: {
      billId: string;
      billNumber: string;
      vendorId: string;
      billedQuantity: number;
      billedUnitPriceCents: bigint;
      billedTotalCents: bigint;
    };
    if (storedBill.rows.length > 0) {
      const row = storedBill.rows[0];
      bill = {
        billId: row.id,
        billNumber: row.bill_number,
        vendorId: order.supplier_id,
        billedQuantity: Number(row.billed_quantity),
        billedUnitPriceCents: BigInt(row.billed_unit_price_cents),
        billedTotalCents: BigInt(row.billed_total_cents),
      };
    } else {
      const generated = await supplierAdapter.generateBill(
        order.id,
        order.item_sku,
        Number(order.quantity),
        BigInt(order.unit_price_cents),
        order.supplier_id
      );
      await query(
        `INSERT INTO supplier_bills (id, order_id, bill_number, billed_quantity, billed_unit_price_cents, billed_total_cents, currency, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'USDC', NOW())
         ON CONFLICT (id) DO NOTHING;`,
        [
          generated.billId,
          order.id,
          generated.billNumber,
          generated.billedQuantity,
          generated.billedUnitPriceCents,
          generated.billedTotalCents,
        ]
      );
      bill = {
        billId: generated.billId,
        billNumber: generated.billNumber,
        vendorId: generated.vendorId,
        billedQuantity: generated.billedQuantity,
        billedUnitPriceCents: BigInt(generated.billedUnitPriceCents),
        billedTotalCents: BigInt(generated.billedTotalCents),
      };
    }

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
      await query(
        `UPDATE orders SET status = 'confirmed', updated_at = NOW() WHERE id = $1 AND status = 'settling';`,
        [order.id]
      );
      return { status: matchResult.status, reconciled: false };
    }

    // Execute Settlement payment
    const wsRes = await query(`SELECT * FROM workspaces WHERE id = $1;`, [order.workspace_id]);
    const settlementAdapter = this.settlementFor(wsRes.rows[0].settlement_mode);

    const transferRes = await settlementAdapter.transferUSDC({
      fromAddress: wsRes.rows[0].settlement_address || "0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2",
      toAddress: "0xa8358AED200D6CB6C856F972D853C1be833006ea",
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
