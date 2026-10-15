import { WorkflowEngine } from "./engine.js";
import { WorkflowState } from "./types.js";
import { query } from "../db/client.js";
import { PolicyEngine, PolicyDecision } from "../policy/engine.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { getSupplierAdapter } from "../adapters/suppliers/index.js";
import { getSettlementAdapter } from "../adapters/settlement/index.js";
import { evaluateThreeWayMatch, MatchStatus } from "../accounting/three-way-match.js";
import { notificationEmitter } from "../adapters/web2/notifications.js";
import { generateIdempotencyKey } from "../utils/idempotency.js";
import { generateVerifiableDecisionRecord } from "../agents/bindTemplateAgent.js";
import { writeWorkflowAntiDriftFiles } from "../agents/antiDriftWriter.js";

export class ProcurementWorkflowRunner {
  private workflowEngine = new WorkflowEngine();
  private policyEngine = new PolicyEngine();

  /**
   * Triggers the procurement replenishment workflow from low inventory.
   */
  async startReplenishment(
    workspaceId: string,
    sku: string,
    triggerSource: string = "inventory_monitor"
  ): Promise<{ workflowId: string; state: WorkflowState; orderId?: string; approvalId?: string }> {
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

    const supplierId = item.preferred_supplier_id || `${workspaceId}_supp-sysco-metro`;
    const supplierAdapter = getSupplierAdapter(supplierId);

    const quoteRes = await supplierAdapter.requestQuote({
      workspaceId,
      sku,
      quantity: reorderQty,
      rfqId: `rfq_${workflowId}`,
      supplierId,
    });

    // Record quote in DB
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
        quoteRes.validUntil,
      ]
    );

    // Generate verifiable decision record via Nebius Token Factory / deepagents / anti-drift writer
    let decisionRecord: any = null;
    try {
      decisionRecord = await generateVerifiableDecisionRecord({
        workflowId,
        templateId: "kitchen-ops",
        skuName: item.name,
        quantityRequested: reorderQty,
        candidateQuotes: [
          {
            vendorId: quoteRes.supplierId,
            vendorName: quoteRes.supplierName,
            vendorWallet: "0xa8358AED200D6CB6C856F972D853C1be833006ea",
            unitPriceUsdc: (Number(quoteRes.unitPriceCents) / 100).toFixed(4),
            totalPriceUsdc: (Number(quoteRes.totalPriceCents) / 100).toFixed(4),
            leadTimeDays: 2,
            isWhitelistedOnChain: true,
          },
        ],
        dailyLimitUsdc: "1.0",
      });
    } catch {
      // Keep going if template dir isn't present in specific test runs
    }

    // 5. Transition to QUOTE_RECEIVED
    await this.workflowEngine.transition(workflowId, {
      fromState: WorkflowState.REQUEST_SENT,
      toState: WorkflowState.QUOTE_RECEIVED,
      patchContext: {
        quote: quoteRes,
        decisionRecord,
        decisionHash: decisionRecord?.decisionHash,
        evidencePath: decisionRecord ? `workflows/${workflowId}/DECISION_EVIDENCE.md` : undefined,
      },
    });

    // 6. Policy Engine Evaluation
    const wsRes = await query(`SELECT * FROM workspaces WHERE id = $1;`, [workspaceId]);
    const roleRes = await query(
      `SELECT * FROM agent_roles WHERE workspace_id = $1 AND role_name = 'procurement_agent';`,
      [workspaceId]
    );

    const ws = wsRes.rows[0];
    const role = roleRes.rows[0];

    const policyResult = this.policyEngine.evaluate({
      workspace: {
        workspaceId,
        budgetDailyLimitCents: BigInt(ws.budget_daily_limit_cents),
        approvalThresholdCents: BigInt(ws.approval_threshold_cents),
        dailySpentCents: 0n,
      },
      role: {
        roleId: role.id,
        workspaceId,
        roleName: role.role_name,
        permittedEffects: role.permitted_effects,
        spendingLimitCents: BigInt(role.spending_limit_cents),
        enabled: role.enabled,
      },
      operation: "orders.submit",
      amountCents: quoteRes.totalPriceCents,
      supplierId: quoteRes.supplierId,
    });

    await this.workflowEngine.recordAudit(
      workspaceId,
      workflowId,
      "agent",
      "procurement_agent",
      EffectClass.COMMERCIAL_COMMITMENT,
      "policy.evaluate_order",
      policyResult.decision,
      { amountCents: quoteRes.totalPriceCents.toString(), policyResult }
    );

    // Handle Policy Result
    if (policyResult.decision === PolicyDecision.DENY) {
      await this.workflowEngine.transition(workflowId, {
        fromState: WorkflowState.QUOTE_RECEIVED,
        toState: WorkflowState.FAILED,
        errorMessage: policyResult.reason,
      });
      return { workflowId, state: WorkflowState.FAILED };
    }

    if (policyResult.decision === PolicyDecision.REQUIRE_APPROVAL) {
      const approvalId = `appr_${workflowId}`;
      await this.workflowEngine.createApproval(
        approvalId,
        workspaceId,
        "order",
        workflowId,
        `Purchase ${reorderQty}x ${item.name} from ${quoteRes.supplierName} for $${(Number(quoteRes.totalPriceCents) / 100).toFixed(2)} USDC`,
        quoteRes.totalPriceCents,
        "procurement_agent"
      );

      // Emit interactive WhatsApp & Email notifications
      await notificationEmitter.send({
        workspaceId,
        channel: "whatsapp",
        recipient: "+12125550199",
        title: "⚠️ Bind Alert: Ingredient Restock Approval Required",
        message: `Low stock detected on ${item.name}. Best quote from ${quoteRes.supplierName} is $${(Number(quoteRes.totalPriceCents) / 100).toFixed(2)} USDC.`,
        actionUrl: `http://127.0.0.1:3000/api/approvals/${approvalId}/approve`,
        approvalToken: approvalId,
      });

      await this.workflowEngine.transition(workflowId, {
        fromState: WorkflowState.QUOTE_RECEIVED,
        toState: WorkflowState.AWAITING_APPROVAL,
        patchContext: { approvalId },
      });

      return { workflowId, state: WorkflowState.AWAITING_APPROVAL, approvalId };
    }

    // Otherwise, policy is ALLOW -> Auto-authorize and submit!
    await this.workflowEngine.transition(workflowId, {
      fromState: WorkflowState.QUOTE_RECEIVED,
      toState: WorkflowState.AUTHORIZED,
    });

    return this.executeOrderSubmission(workflowId, workspaceId, quoteRes, item.name);
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
      throw new Error(`Approval '${approvalId}' not found.`);
    }
    const approval = apprRes.rows[0];
    const workflowId = approval.entity_id;

    await this.workflowEngine.decideApproval(approvalId, "approved", decidedBy);

    await this.workflowEngine.transition(workflowId, {
      fromState: WorkflowState.AWAITING_APPROVAL,
      toState: WorkflowState.AUTHORIZED,
      patchContext: { approvedBy: decidedBy },
    });

    const wf = await this.workflowEngine.getWorkflow(workflowId);
    const quoteRes = wf!.contextData.quote;
    const itemName = wf!.contextData.itemName;

    return this.executeOrderSubmission(workflowId, approval.workspace_id, quoteRes, itemName);
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

    const supplierAdapter = getSupplierAdapter(quote.supplierId);
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
   */
  async fulfillAndReconcile(
    orderId: string
  ): Promise<{ status: MatchStatus; reconciled: boolean; txHash?: string }> {
    const orderRes = await query(`SELECT * FROM orders WHERE id = $1;`, [orderId]);
    if (orderRes.rows.length === 0) {
      throw new Error(`Order '${orderId}' not found.`);
    }
    const order = orderRes.rows[0];
    const supplierAdapter = getSupplierAdapter(order.supplier_id);

    // Generate or fetch Delivery Receipt
    const receipt = await supplierAdapter.generateDeliveryReceipt(
      order.id,
      order.item_sku,
      Number(order.quantity)
    );
    await query(
      `INSERT INTO delivery_receipts (id, order_id, received_quantity, received_at, condition_notes, discrepancy_reported)
       VALUES ($1, $2, $3, NOW(), $4, FALSE)
       ON CONFLICT (id) DO NOTHING;`,
      [receipt.receiptId, order.id, receipt.receivedQuantity, receipt.conditionNotes]
    );

    // Generate or fetch Supplier Bill
    const bill = await supplierAdapter.generateBill(
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
      [bill.billId, order.id, bill.billNumber, bill.billedQuantity, bill.billedUnitPriceCents, bill.billedTotalCents]
    );

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
        billedUnitPriceCents: BigInt(bill.billedUnitPriceCents),
        billedTotalCents: BigInt(bill.billedTotalCents),
      }
    );

    // Save 3-Way Match Result
    await query(
      `INSERT INTO three_way_matches (id, order_id, delivery_receipt_id, supplier_bill_id, match_status, variance_cents, notes, matched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW());`,
      [
        `match_${Date.now()}`,
        order.id,
        receipt.receiptId,
        bill.billId,
        matchResult.status,
        matchResult.varianceCents,
        matchResult.discrepancyReason || "Perfect 3-way match",
      ]
    );

    if (matchResult.status !== MatchStatus.MATCHED) {
      return { status: matchResult.status, reconciled: false };
    }

    // Execute Settlement payment
    const wsRes = await query(`SELECT * FROM workspaces WHERE id = $1;`, [order.workspace_id]);
    const settlementAdapter = getSettlementAdapter(wsRes.rows[0].settlement_mode);

    const transferRes = await settlementAdapter.transferUSDC({
      fromAddress: wsRes.rows[0].settlement_address || "0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2",
      toAddress: "0xa8358AED200D6CB6C856F972D853C1be833006ea",
      amountCents: matchResult.payableAmountCents,
      currency: "USDC",
      orderId: order.id,
      idempotencyKey: `idem_pay_${order.id}`,
    });

    // Update order with tx_hash and status reconciled
    await query(
      `UPDATE orders SET status = 'reconciled', tx_hash = $1, updated_at = NOW() WHERE id = $2;`,
      [transferRes.txHash, order.id]
    );

    // Restock Inventory
    await query(
      `UPDATE inventory_items
       SET current_quantity = current_quantity + $1, updated_at = NOW()
       WHERE workspace_id = $2 AND sku = $3;`,
      [receipt.receivedQuantity, order.workspace_id, order.item_sku]
    );

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

    return {
      status: matchResult.status,
      reconciled: true,
      txHash: transferRes.txHash,
    };
  }
}
