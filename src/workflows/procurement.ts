import { WorkflowEngine, ApprovalDecisionError } from "./engine.js";
import { WorkflowState } from "./types.js";
import { query } from "../db/client.js";
import { PolicyDecision } from "../policy/engine.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { authorizeCommitment, describeCommitmentDecision, type CommitmentDecision } from "../policy/commitment-gate.js";
import { getSupplierAdapter } from "../adapters/suppliers/index.js";
import {
  SupplierResponseInvalidError,
  validateOrderResponse,
  validateQuoteResponse,
} from "../adapters/suppliers/validate.js";
import { simulatedPaymentAddress } from "../adapters/suppliers/payment-address.js";
import type { OrderRequest, OrderResponse, QuoteRequest, QuoteResponse, SupplierAdapter } from "../adapters/suppliers/types.js";
import { EffectInDoubtError, runEffect } from "../effects/ledger.js";
import {
  PROCUREMENT_ACTOR_ROLE,
  loadStoredQuote,
  orderNumberFor,
  reserveOrder,
} from "../orders/reservation.js";
import { getSettlementAdapter } from "../adapters/settlement/index.js";
import type { SettlementAdapter } from "../adapters/settlement/types.js";
import { generateIdempotencyKey } from "../utils/idempotency.js";
import { resolveTemplateDir } from "../agents/bindTemplateAgent.js";
import { newId } from "../utils/ids.js";
import { createReplenishmentTools } from "../agents/replenishmentTools.js";
import { OrderSettlementService, SettlementOrderError } from "./settlement.js";
import type { EvidenceLoader, ReconcileResult } from "./settlement.js";

export interface ProcurementRunnerDeps {
  settlementFor?: (mode: string) => SettlementAdapter;
  supplierFor?: (id: string) => SupplierAdapter;
}

export type { ReconcileResult } from "./settlement.js";

/** Actor recorded when the approval-time re-check rejects an approval. */
const POLICY_RECHECK_ACTOR = "system:policy-recheck";
/** Actor recorded when the order reservation or crash recovery refuses a commitment. */
const RESERVATION_ACTOR = "system:order-reservation";

/**
 * Result of submitting or resuming an order. CONFIRMED and FAILED are final. SUBMITTED with inDoubt means the supplier
 * may or may not have accepted the order: the order and the workflow stay submitted and nothing is resent.
 */
export type OrderSubmissionResult =
  | { workflowId: string; state: WorkflowState.CONFIRMED; orderId: string }
  | { workflowId: string; state: WorkflowState.FAILED; orderId?: string }
  | { workflowId: string; state: WorkflowState.SUBMITTED; orderId: string; inDoubt: true; effectId: string };

/** Fields of a quote or proposal that the commitment gate checks. Read from the workflow context. */
function commitmentClaims(workflowId: string, workspaceId: string, proposal: any) {
  return {
    workspaceId,
    workflowId,
    actorRole: PROCUREMENT_ACTOR_ROLE,
    supplierId: String(proposal?.supplierId ?? ""),
    quoteId: String(proposal?.quoteId ?? ""),
    quantity: Number(proposal?.quantity),
    totalPriceCents: BigInt(proposal?.totalPriceCents ?? 0),
  };
}

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
    triggerSource: string = "inventory_monitor",
    opts?: { availableQuantity?: number }
  ): Promise<{ workflowId: string; state: WorkflowState; orderId?: string; approvalId?: string }> {
    // 0a. The owner's pause switch (ADR 0022). A paused workspace starts no workflow and asks no supplier for a quote.
    const pauseRes = await query(`SELECT agents_paused FROM workspaces WHERE id = $1;`, [workspaceId]);
    if (pauseRes.rows[0]?.agents_paused === true) {
      throw new Error(
        "[AGENTS_PAUSED] The owner has paused the agents for this workspace. Resume them before starting a replenishment."
      );
    }

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

    // 2. Check if replenishment is needed. A caller that knows stock is committed to customer orders passes the
    // available quantity (on hand minus active reservations, ADR 0027). It then replaces on-hand stock in the test,
    // in the recorded quantity and in the idempotency key. Without it the on-hand quantity is used, as before.
    const currentQty = opts?.availableQuantity ?? Number(item.current_quantity);
    const parLevel = Number(item.par_level);
    const reorderQty = Number(item.reorder_quantity);

    if (currentQty >= parLevel) {
      throw new Error(`Item '${item.name}' has sufficient stock (${currentQty} >= par ${parLevel}). No order needed.`);
    }

    const workflowId = newId("wf_proc");
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
    let quoteRes: QuoteResponse;
    try {
      quoteRes = await this.requestQuote({
        workspaceId,
        workflowId,
        sku,
        quantity: reorderQty,
        rfqId: `rfq_${workflowId}`,
        supplierId,
      });
    } catch (err) {
      if (!(err instanceof SupplierResponseInvalidError)) throw err;
      // The supplier's answer was refused. The workflow fails with the code only: no quote is stored and no approval follows.
      await this.workflowEngine.transition(workflowId, {
        fromState: WorkflowState.REQUEST_SENT,
        toState: WorkflowState.FAILED,
        errorMessage: err.message,
      });
      await this.workflowEngine.recordAudit(
        workspaceId,
        workflowId,
        "system",
        "system:supplier-response",
        EffectClass.EXTERNAL_REQUEST,
        "suppliers.request_quote.response_invalid",
        PolicyDecision.DENY,
        { code: err.code, sku, quantity: reorderQty }
      );
      return { workflowId, state: WorkflowState.FAILED };
    }

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
      // Only a quote for the quantity being ordered can be chosen. The gate refuses any other (QUOTE_CHANGED).
      const validQuotes = (parsed.quotes || []).filter((q: any) => !q.isExpired && Number(q.quoteQuantity) === reorderQty);
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
      return this.resumeOrderSubmission(workflowId);
    }

    return { workflowId, state: updatedWf.state };
  }

  /**
   * Resumes workflow after human approval.
   */
  async approveAndSubmit(
    approvalId: string,
    decidedBy: string,
    workspaceId: string
  ): Promise<{ workflowId: string; state: WorkflowState; orderId?: string }> {
    // An approval of another workspace is reported exactly like a missing one, before any state changes.
    const apprRes = await query(`SELECT * FROM approvals WHERE id = $1 AND workspace_id = $2;`, [approvalId, workspaceId]);
    if (apprRes.rows.length === 0) {
      throw new ApprovalDecisionError("APPROVAL_NOT_FOUND", `Approval '${approvalId}' not found.`);
    }
    const approval = apprRes.rows[0];
    const waiting = await this.workflowEngine.getWorkflow(approval.entity_id);
    const proposal = waiting?.contextData.replenishmentProposal || waiting?.contextData.quote;

    // The approval was requested earlier. Limits, supplier status and quote expiry may have changed since, so
    // the commitment is decided again from the database before anything is submitted. A pending approval
    // that is still in its window is re-checked; any other state is refused by resolveApproval below.
    const pending = approval.status === "pending" && new Date(approval.expires_at).getTime() > Date.now();
    if (pending) {
      // A waiting workflow with no stored proposal has no quote to check, so the gate denies it (QUOTE_NOT_FOUND).
      const recheck = await authorizeCommitment({
        workspaceId: approval.workspace_id,
        workflowId: approval.entity_id,
        actorRole: "procurement_agent",
        supplierId: String(proposal?.supplierId ?? ""),
        quoteId: String(proposal?.quoteId ?? ""),
        quantity: Number(proposal?.quantity),
        totalPriceCents: BigInt(proposal?.totalPriceCents ?? 0),
      });
      if (recheck.decision === PolicyDecision.DENY) {
        // Cancels the waiting workflow in the same step as the rejection. No order and no supplier call follow.
        await this.workflowEngine.resolveApproval(approvalId, "rejected", POLICY_RECHECK_ACTOR, recheck.reasonCodes.join(","));
        await this.workflowEngine.recordAudit(
          approval.workspace_id,
          approval.entity_id,
          "system",
          POLICY_RECHECK_ACTOR,
          EffectClass.COMMERCIAL_COMMITMENT,
          "commitment.recheck",
          PolicyDecision.DENY,
          { approvalId, reasonCodes: recheck.reasonCodes, reason: describeCommitmentDecision(recheck), ...recheck.evidence }
        );
        throw new ApprovalDecisionError(
          "POLICY_DENIED",
          `Approval '${approvalId}' was refused: the commitment no longer passes policy. ${describeCommitmentDecision(recheck)}`,
          recheck.reasonCodes
        );
      }
    }

    const { workflowId } = await this.workflowEngine.resolveApproval(approvalId, "approved", decidedBy);
    await this.workflowEngine.recordAudit(
      approval.workspace_id,
      workflowId,
      "owner",
      decidedBy,
      EffectClass.COMMERCIAL_COMMITMENT,
      "approval.approved",
      PolicyDecision.ALLOW,
      { approvalId }
    );

    return this.resumeOrderSubmission(workflowId);
  }

  /**
   * Expires pending approvals past their window and cancels their workflows.
   */
  async expireApprovals(filter: { workspaceId?: string; approvalId?: string; limit?: number } = {}): Promise<number> {
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
    workspaceId: string,
    reason?: string
  ): Promise<{ workflowId: string; state: WorkflowState }> {
    // Checked before the decision is written: another workspace's approval is "not found", as a missing one is.
    const owned = await query(`SELECT 1 FROM approvals WHERE id = $1 AND workspace_id = $2;`, [approvalId, workspaceId]);
    if (owned.rows.length === 0) {
      throw new ApprovalDecisionError("APPROVAL_NOT_FOUND", `Approval '${approvalId}' not found.`);
    }
    const { workflowId } = await this.workflowEngine.resolveApproval(approvalId, decision, decidedBy, reason);
    await this.workflowEngine.recordAudit(
      workspaceId,
      workflowId,
      "owner",
      decidedBy,
      EffectClass.COMMERCIAL_COMMITMENT,
      `approval.${decision}`,
      PolicyDecision.DENY,
      { approvalId, reason: reason ?? null }
    );
    return { workflowId, state: WorkflowState.CANCELLED };
  }

  /**
   * Asks a supplier for a quote through the effects ledger. A quote creates no liability, so a repeated request with the
   * same rfq id is safe: the stored quote is replayed and the supplier is not asked again. The quote row is written
   * once, keyed by the quote id, so a replay does not add a second row.
   */
  async requestQuote(input: {
    workspaceId: string;
    workflowId?: string;
    supplierId: string;
    sku: string;
    quantity: number;
    rfqId: string;
  }): Promise<QuoteResponse> {
    const supplierAdapter = this.supplierFor(input.supplierId);
    const quoteRequest: QuoteRequest = {
      workspaceId: input.workspaceId,
      sku: input.sku,
      quantity: input.quantity,
      rfqId: input.rfqId,
      supplierId: input.supplierId,
    };
    const { result: quoteRes } = await runEffect(
      {
        workspaceId: input.workspaceId,
        workflowId: input.workflowId,
        effectClass: EffectClass.EXTERNAL_REQUEST,
        operation: "suppliers.request_quote",
        idempotencyKey: `${input.workspaceId}:quote:${input.rfqId}`,
        request: { sku: input.sku, quantity: input.quantity, supplierId: input.supplierId, rfqId: input.rfqId },
        externalDedupes: true,
      },
      async () => {
        const quote = await supplierAdapter.requestQuote(quoteRequest);
        // A supplier's answer is untrusted (Task 11): it must answer this request and stay within bounds, or it is refused
        // here, before it is recorded or stored.
        const check = validateQuoteResponse(quoteRequest, quote);
        if (!check.valid) throw new SupplierResponseInvalidError(check.reason);
        return quote;
      }
    );

    // Record the quote with 24h validity. A replayed quote carries the same id, so the row is written once.
    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await query(
      `INSERT INTO quotes (id, workspace_id, rfq_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, currency, valid_until, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'USDC', $10, NOW())
       ON CONFLICT (id) DO NOTHING;`,
      [
        quoteRes.quoteId,
        input.workspaceId,
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
    return quoteRes;
  }

  /**
   * Submits an authorized order, or resumes a submitted one after a crash. The order id is derived from the workflow, so
   * a resume finds the workflow's own order and never another one. Steps:
   * 1. authorized -> submitted (any other state, other than submitted, is refused).
   * 2. Reserve spend: the order row is written as submitted under the spend lock, after the commitment gate decides.
   * 3. Submit through the effects ledger, at most once per key. The result is reconciled with the supplier when it can
   *    look up orders. An unknown outcome is reported in doubt and is never resent.
   */
  async resumeOrderSubmission(workflowId: string): Promise<OrderSubmissionResult> {
    const wf = await this.workflowEngine.getWorkflow(workflowId);
    if (!wf) throw new Error(`Workflow '${workflowId}' not found.`);
    if (wf.state !== WorkflowState.AUTHORIZED && wf.state !== WorkflowState.SUBMITTED) {
      throw new Error(
        `Workflow '${workflowId}' is '${wf.state}'; only an authorized or submitted workflow can be submitted.`
      );
    }
    const workspaceId = wf.workspaceId;
    const proposal = wf.contextData.replenishmentProposal || wf.contextData.quote || {};
    const itemName: string = wf.contextData.itemName || String(proposal.sku ?? "");

    if (wf.state === WorkflowState.AUTHORIZED) {
      await this.workflowEngine.transition(workflowId, {
        fromState: WorkflowState.AUTHORIZED,
        toState: WorkflowState.SUBMITTED,
      });
    }

    const orderId = `ord_${workflowId}`;
    const idempotencyKey = `idem_ord_${orderId}`;

    let order = await this.loadOwnOrder(orderId, workspaceId);
    if (!order) {
      const stored = await loadStoredQuote(workspaceId, String(proposal.quoteId ?? ""));
      if (!stored) {
        // Nothing to reserve against. The gate denies it (QUOTE_NOT_FOUND), so no order is written.
        const decision = await authorizeCommitment(commitmentClaims(workflowId, workspaceId, proposal));
        return this.failReservation(workflowId, workspaceId, decision);
      }
      const reservation = await reserveOrder({
        workspaceId,
        workflowId,
        orderId,
        quote: stored,
        itemName: itemName || stored.sku,
        idempotencyKey,
        orderNumber: orderNumberFor(orderId),
      });
      if (!reservation.reserved) return this.failReservation(workflowId, workspaceId, reservation.decision);
      order = await this.loadOwnOrder(orderId, workspaceId);
      if (!order) throw new Error(`Order '${orderId}' is missing after its reservation.`);
    }

    if (order.status === "cancelled") {
      // The supplier rejected this order earlier, and the workflow was left submitted by a crash. Finish the failure.
      await this.workflowEngine.transition(workflowId, {
        fromState: WorkflowState.SUBMITTED,
        toState: WorkflowState.FAILED,
        errorMessage: "The supplier rejected this order. Its reservation was released.",
      });
      return { workflowId, state: WorkflowState.FAILED, orderId };
    }

    if (!order.supplier_id) throw new Error(`Order '${orderId}' has no supplier on record.`);
    const supplierAdapter = this.supplierFor(order.supplier_id);
    const request: OrderRequest = {
      workspaceId,
      orderId,
      orderNumber: order.order_number,
      supplierId: order.supplier_id,
      sku: order.item_sku,
      quantity: Number(order.quantity),
      unitPriceCents: BigInt(order.unit_price_cents),
      totalPriceCents: BigInt(order.total_price_cents),
      idempotencyKey,
    };
    const lookupOrder = supplierAdapter.lookupOrder?.bind(supplierAdapter);

    let orderRes: OrderResponse;
    try {
      ({ result: orderRes } = await runEffect<OrderResponse>(
        {
          workspaceId,
          workflowId,
          effectClass: EffectClass.COMMERCIAL_COMMITMENT,
          operation: "orders.submit",
          idempotencyKey: `${workspaceId}:order:${orderId}`,
          request: {
            orderId,
            supplierId: request.supplierId,
            sku: request.sku,
            quantity: request.quantity,
            unitPriceCents: request.unitPriceCents,
            totalPriceCents: request.totalPriceCents,
            orderNumber: request.orderNumber,
            idempotencyKey,
          },
        },
        async () => {
          const response = await supplierAdapter.submitOrder(request);
          const check = validateOrderResponse(request, response);
          if (!check.valid) throw new SupplierResponseInvalidError(check.reason);
          return response;
        },
        {
          reconcile: lookupOrder
            ? async () => {
                const found = await lookupOrder({ workspaceId, orderId, idempotencyKey });
                if (!found) return { found: false };
                const check = validateOrderResponse(request, found);
                if (!check.valid) throw new SupplierResponseInvalidError(check.reason);
                return { found: true, result: found, externalRef: found.externalOrderRef };
              }
            : undefined,
          externalRef: (r) => r.externalOrderRef,
        }
      ));
    } catch (err) {
      if (err instanceof SupplierResponseInvalidError) {
        // The supplier answered in a form Bind cannot trust. The outcome is unknown: the order and the workflow stay
        // submitted, the ledger effect is not completed, nothing is cancelled or confirmed, and nothing is resent.
        const effectRes = await query(`SELECT id FROM effects WHERE idempotency_key = $1;`, [`${workspaceId}:order:${orderId}`]);
        const effectId: string = effectRes.rows[0]?.id ?? "";
        await this.workflowEngine.recordAudit(
          workspaceId,
          workflowId,
          "system",
          "system:order-submission",
          EffectClass.COMMERCIAL_COMMITMENT,
          "orders.submit.response_invalid",
          PolicyDecision.ALLOW,
          { orderId, orderNumber: request.orderNumber, effectId, code: err.code }
        );
        return { workflowId, state: WorkflowState.SUBMITTED, orderId, inDoubt: true, effectId };
      }
      if (err instanceof EffectInDoubtError) {
        // The money may already be committed. Keep the order and the workflow submitted, and never resend.
        await this.workflowEngine.recordAudit(
          workspaceId,
          workflowId,
          "system",
          "system:order-submission",
          EffectClass.COMMERCIAL_COMMITMENT,
          "orders.submit.in_doubt",
          PolicyDecision.ALLOW,
          { orderId, orderNumber: request.orderNumber, effectId: err.effectId, effectStatus: err.status, attempts: err.attempts }
        );
        return { workflowId, state: WorkflowState.SUBMITTED, orderId, inDoubt: true, effectId: err.effectId };
      }
      // Any other error: the ledger has recorded the call as failed. The outcome is unknown, so nothing is cancelled.
      throw err;
    }

    if (orderRes.status === "rejected") {
      // The supplier refused the order: release the reservation so the budget is free again, then fail the workflow.
      await query(
        `UPDATE orders SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND workspace_id = $2 AND status = 'submitted';`,
        [orderId, workspaceId]
      );
      await this.workflowEngine.transition(workflowId, {
        fromState: WorkflowState.SUBMITTED,
        toState: WorkflowState.FAILED,
        errorMessage: `The supplier rejected order ${request.orderNumber}. The reservation was released.`,
      });
      await this.workflowEngine.recordAudit(
        workspaceId,
        workflowId,
        "agent",
        "procurement_agent",
        EffectClass.COMMERCIAL_COMMITMENT,
        "orders.submit",
        PolicyDecision.DENY,
        { orderId, orderNumber: request.orderNumber, externalOrderRef: orderRes.externalOrderRef, status: "rejected" }
      );
      return { workflowId, state: WorkflowState.FAILED, orderId };
    }

    await query(
      `UPDATE orders SET status = 'confirmed', external_order_ref = $3, updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2 AND status = 'submitted';`,
      [orderId, workspaceId, orderRes.externalOrderRef]
    );
    await this.workflowEngine.transition(workflowId, {
      fromState: WorkflowState.SUBMITTED,
      toState: WorkflowState.CONFIRMED,
      patchContext: { orderId, orderNumber: request.orderNumber, externalOrderRef: orderRes.externalOrderRef },
    });
    await this.workflowEngine.recordAudit(
      workspaceId,
      workflowId,
      "agent",
      "procurement_agent",
      EffectClass.COMMERCIAL_COMMITMENT,
      "orders.submit",
      PolicyDecision.ALLOW,
      { orderId, orderNumber: request.orderNumber, externalOrderRef: orderRes.externalOrderRef }
    );
    return { workflowId, state: WorkflowState.CONFIRMED, orderId };
  }

  /** The workflow's own order, in its workspace only. */
  private async loadOwnOrder(orderId: string, workspaceId: string): Promise<any | null> {
    const res = await query(
      `SELECT id, status, order_number, supplier_id, item_sku, quantity, unit_price_cents, total_price_cents
       FROM orders WHERE id = $1 AND workspace_id = $2;`,
      [orderId, workspaceId]
    );
    return res.rows[0] ?? null;
  }

  /** A refused reservation fails the workflow with the reason codes, and writes no order and calls no supplier. */
  private async failReservation(
    workflowId: string,
    workspaceId: string,
    decision: CommitmentDecision
  ): Promise<OrderSubmissionResult> {
    if (decision.decision !== PolicyDecision.DENY) {
      throw new Error(`A reservation can only be refused on a denial, not '${decision.decision}'.`);
    }
    const reason = describeCommitmentDecision(decision);
    await this.workflowEngine.transition(workflowId, {
      fromState: WorkflowState.SUBMITTED,
      toState: WorkflowState.FAILED,
      errorMessage: reason,
    });
    await this.workflowEngine.recordAudit(
      workspaceId,
      workflowId,
      "system",
      RESERVATION_ACTOR,
      EffectClass.COMMERCIAL_COMMITMENT,
      "commitment.recheck",
      PolicyDecision.DENY,
      { reasonCodes: decision.reasonCodes, reason, ...decision.evidence }
    );
    return { workflowId, state: WorkflowState.FAILED };
  }

  /**
   * Ingests delivery receipt & bill, runs 3-way match, and reconciles. Settlement itself is
   * owned by OrderSettlementService; this runner only supplies the documents: stored ones when
   * present, otherwise generated from the supplier adapter.
   */
  async fulfillAndReconcile(orderId: string, workspaceId: string): Promise<ReconcileResult> {
    await this.assertOrderInWorkspace(orderId, workspaceId);
    const { status, reconciled, txHash, alreadyReconciled, hold, pending } = await this.settlement.settle(orderId, (order) =>
      this.storedOrGeneratedEvidence(order)
    );
    return { status, reconciled, txHash, alreadyReconciled, hold, pending };
  }

  /**
   * Finishes a payment that was sent but not confirmed (`settlement_submitted`). Pays nothing: it asks the
   * adapter for the outcome and finishes the order only when that outcome is `confirmed`.
   */
  async confirmSettlement(orderId: string, workspaceId: string): Promise<ReconcileResult> {
    await this.assertOrderInWorkspace(orderId, workspaceId);
    return this.settlement.confirmSettlement(orderId);
  }

  /** An order of another workspace is reported exactly like a missing one, before any claim or transfer. */
  private async assertOrderInWorkspace(orderId: string, workspaceId: string): Promise<void> {
    const res = await query(`SELECT 1 FROM orders WHERE id = $1 AND workspace_id = $2;`, [orderId, workspaceId]);
    if (res.rows.length === 0) {
      throw new SettlementOrderError("ORDER_NOT_FOUND", orderId);
    }
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
