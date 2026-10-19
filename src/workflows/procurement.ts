import { WorkflowEngine, ApprovalDecisionError } from "./engine.js";
import { WorkflowState } from "./types.js";
import { query } from "../db/client.js";
import { PolicyDecision } from "../policy/engine.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { getSupplierAdapter } from "../adapters/suppliers/index.js";
import { simulatedPaymentAddress } from "../adapters/suppliers/payment-address.js";
import type { SupplierAdapter } from "../adapters/suppliers/types.js";
import { getSettlementAdapter } from "../adapters/settlement/index.js";
import type { SettlementAdapter } from "../adapters/settlement/types.js";
import { generateIdempotencyKey } from "../utils/idempotency.js";
import { resolveTemplateDir } from "../agents/bindTemplateAgent.js";
import { createReplenishmentTools } from "../agents/replenishmentTools.js";
import { OrderSettlementService } from "./settlement.js";
import type { EvidenceLoader, ReconcileResult } from "./settlement.js";

export interface ProcurementRunnerDeps {
  settlementFor?: (mode: string) => SettlementAdapter;
  supplierFor?: (id: string) => SupplierAdapter;
}

export type { ReconcileResult } from "./settlement.js";

type ReceiptAndBill = Exclude<Awaited<ReturnType<EvidenceLoader>>, { pending: unknown }>;

export class ProcurementWorkflowRunner {
  private workflowEngine = new WorkflowEngine();
  private readonly settlementFor: (mode: string) => SettlementAdapter;
  private readonly supplierFor: (id: string) => SupplierAdapter;
  private readonly settlement: OrderSettlementService;

  constructor(deps: ProcurementRunnerDeps = {}) {
    this.settlementFor =
      deps.settlementFor ?? ((mode: string) => getSettlementAdapter(mode as "local" | "arc-testnet"));
    this.supplierFor = deps.supplierFor ?? getSupplierAdapter;
    this.settlement = new OrderSettlementService({ settlementFor: this.settlementFor });
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
          `INSERT INTO suppliers (id, workspace_id, name, adapter_type, contact_email, verified, is_simulated, payment_address, created_at)
           VALUES ($1, $2, 'Sysco Metro Restock', 'simulated_sysco', 'orders@sysco-sim.local', TRUE, TRUE, $3, NOW())
           ON CONFLICT (id) DO NOTHING;`,
          [supplierId, workspaceId, simulatedPaymentAddress(supplierId)]
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
   * Ingests delivery receipt & bill, runs 3-way match, and reconciles. Settlement itself is
   * owned by OrderSettlementService; this runner only supplies the documents: stored ones when
   * present, otherwise generated from the supplier adapter.
   */
  async fulfillAndReconcile(orderId: string): Promise<ReconcileResult> {
    const { status, reconciled, txHash, alreadyReconciled, hold } = await this.settlement.settle(orderId, (order) =>
      this.storedOrGeneratedEvidence(order)
    );
    return { status, reconciled, txHash, alreadyReconciled, hold };
  }

  private async storedOrGeneratedEvidence(order: any): Promise<ReceiptAndBill> {
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

    return { receipt, bill };
  }
}
