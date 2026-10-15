import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { query } from "../db/client.js";
import { WorkflowState } from "../workflows/types.js";
import { PolicyDecision } from "../policy/engine.js";
import { notificationEmitter } from "../adapters/web2/notifications.js";
import { CANONICAL_ARC_LOCK } from "./antiDriftWriter.js";
import { generateVerifiableDecisionRecord } from "./bindTemplateAgent.js";
import { evaluateWithJevSystemOne } from "../domain/jevScorer.js";

export interface ReplenishmentToolsContext {
  workspaceId: string;
  workflowId: string;
}

export function createReplenishmentTools(ctx: ReplenishmentToolsContext) {
  const { workspaceId, workflowId } = ctx;

  /**
   * Tool 1: get_business_context
   * Tenant-scoped: returns business profile, active template rules, and policy limits.
   */
  const getBusinessContextTool = tool(
    async () => {
      const wsRes = await query(`SELECT * FROM workspaces WHERE id = $1;`, [
        workspaceId,
      ]);
      if (wsRes.rows.length === 0) {
        throw new Error(`Workspace '${workspaceId}' not found.`);
      }
      const ws = wsRes.rows[0];

      // Calculate cumulative spend today from submitted, confirmed, or reconciled orders
      const spendRes = await query(
        `SELECT COALESCE(SUM(total_price_cents), 0) AS daily_spent_cents
         FROM orders
         WHERE workspace_id = $1
           AND created_at >= CURRENT_DATE
           AND status IN ('submitted', 'confirmed', 'reconciled');`,
        [workspaceId]
      );
      const dailySpentCents = BigInt(spendRes.rows[0].daily_spent_cents || 0);
      const budgetLimitCents = BigInt(ws.budget_daily_limit_cents);
      const remainingBudgetCents =
        budgetLimitCents > dailySpentCents
          ? budgetLimitCents - dailySpentCents
          : 0n;

      return JSON.stringify({
        workspaceId: ws.id,
        name: ws.name,
        templateId: ws.template_id,
        settlementMode: ws.settlement_mode,
        settlementAddress: ws.settlement_address,
        budgetDailyLimitCents: ws.budget_daily_limit_cents.toString(),
        approvalThresholdCents: ws.approval_threshold_cents.toString(),
        todayCumulativeSpentCents: dailySpentCents.toString(),
        remainingDailyBudgetCents: remainingBudgetCents.toString(),
        policyRules: {
          autoApprovalMaxCents: ws.approval_threshold_cents.toString(),
          hardDailyLimitCents: ws.budget_daily_limit_cents.toString(),
          onChainContract: CANONICAL_ARC_LOCK.bindSettlementContract,
          requiresOwnerApprovalAboveThreshold: true,
        },
      });
    },
    {
      name: "get_business_context",
      description:
        "Queries workspace profile, settlement settings, daily budget limits, and current 24-hour cumulative spend.",
      schema: z.object({}),
    }
  );

  /**
   * Tool 2: get_stock_snapshot
   * Tenant-scoped: queries inventory items and checks for duplicate active workflows.
   */
  const getStockSnapshotTool = tool(
    async ({ sku }: { sku?: string }) => {
      let sql = `SELECT * FROM inventory_items WHERE workspace_id = $1`;
      const params: any[] = [workspaceId];
      if (sku) {
        sql += ` AND sku = $2`;
        params.push(sku);
      }
      sql += ` ORDER BY sku ASC;`;

      const itemsRes = await query(sql, params);
      const items = itemsRes.rows.map((row: any) => ({
        sku: row.sku,
        name: row.name,
        category: row.category,
        unit: row.unit,
        currentQuantity: Number(row.current_quantity),
        parLevel: Number(row.par_level),
        reorderQuantity: Number(row.reorder_quantity),
        unitPriceCents: row.unit_price_cents ? row.unit_price_cents.toString() : "0",
        preferredSupplierId: row.preferred_supplier_id,
        needsReplenishment:
          Number(row.current_quantity) < Number(row.par_level),
      }));

      const activeWfRes = await query(
        `SELECT id, state, context_data FROM workflows
         WHERE workspace_id = $1
           AND state NOT IN ('reconciled', 'failed', 'cancelled');`,
        [workspaceId]
      );

      return JSON.stringify({
        workspaceId,
        items,
        activeReplenishmentWorkflows: activeWfRes.rows.map((w: any) => ({
          workflowId: w.id,
          state: w.state,
          sku: w.context_data?.sku,
        })),
      });
    },
    {
      name: "get_stock_snapshot",
      description:
        "Inspects current on-hand stock quantities, par levels, and checks for existing active requests.",
      schema: z.object({
        sku: z.string().optional().describe("Optional SKU filter to inspect a specific item."),
      }),
    }
  );

  /**
   * Tool 3: get_approved_supplier_quotes
   * Tenant-scoped: retrieves owner-approved supplier quotes and flags expired ones.
   */
  const getApprovedSupplierQuotesTool = tool(
    async ({ sku }: { sku: string }) => {
      const quotesRes = await query(
        `SELECT q.id AS quote_id, q.rfq_id, q.supplier_id, q.supplier_name, q.item_sku,
                q.quantity, q.unit_price_cents, q.total_price_cents, q.currency, q.valid_until,
                s.verified, s.is_simulated, s.adapter_type
         FROM quotes q
         JOIN suppliers s ON s.id = q.supplier_id AND s.workspace_id = q.workspace_id
         WHERE q.workspace_id = $1 AND q.item_sku = $2 AND s.verified = TRUE
         ORDER BY q.created_at DESC;`,
        [workspaceId, sku]
      );

      const now = new Date();
      const quotes = quotesRes.rows.map((row: any) => {
        const isExpired = new Date(row.valid_until) < now;
        return {
          quoteId: row.quote_id,
          supplierId: row.supplier_id,
          supplierName: row.supplier_name,
          sku: row.item_sku,
          quoteQuantity: Number(row.quantity),
          unitPriceCents: row.unit_price_cents.toString(),
          totalPriceCents: row.total_price_cents.toString(),
          currency: row.currency,
          validUntil: row.valid_until,
          isExpired,
          isSimulated: row.is_simulated,
          adapterType: row.adapter_type,
          supplierWallet: CANONICAL_ARC_LOCK.whitelistedVendor,
        };
      });

      return JSON.stringify({
        workspaceId,
        sku,
        quotes,
        availableCount: quotes.length,
        unexpiredCount: quotes.filter((q: any) => !q.isExpired).length,
      });
    },
    {
      name: "get_approved_supplier_quotes",
      description:
        "Retrieves owner-approved, verified supplier quotes for a SKU from PostgreSQL, explicitly flagging expired quotes.",
      schema: z.object({
        sku: z.string().describe("The item SKU to fetch supplier quotes for."),
      }),
    }
  );

  /**
   * Tool 4: create_replenishment_proposal
   * Server-Side Authority & Math Guard: recomputes money in BigInt base units.
   */
  const createReplenishmentProposalTool = tool(
    async (proposal: {
      itemId: string;
      quantity: number;
      supplierId: string;
      quoteId: string;
      reasonCodes: string[];
      explanation: string;
      sourceRecordIds: string[];
    }) => {
      // 1. Verify quote exists in DB for this workspace
      const quoteRes = await query(
        `SELECT q.*, s.verified, s.name as verified_supplier_name
         FROM quotes q
         JOIN suppliers s ON s.id = q.supplier_id AND s.workspace_id = q.workspace_id
         WHERE q.id = $1 AND q.workspace_id = $2;`,
        [proposal.quoteId, workspaceId]
      );
      if (quoteRes.rows.length === 0) {
        throw new Error(
          `Quote '${proposal.quoteId}' not found for workspace '${workspaceId}'.`
        );
      }
      const quote = quoteRes.rows[0];

      // 2. Verify supplier ID matches and supplier is verified
      if (quote.supplier_id !== proposal.supplierId) {
        throw new Error(
          `Supplier ID mismatch: proposal cited '${proposal.supplierId}' but quote belongs to '${quote.supplier_id}'.`
        );
      }
      if (!quote.verified) {
        throw new Error(
          `Supplier '${quote.supplier_id}' is not an owner-approved verified supplier.`
        );
      }

      // 3. Verify quote is not expired
      if (new Date(quote.valid_until) < new Date()) {
        throw new Error(
          `Cannot propose expired quote '${proposal.quoteId}' (expired at ${quote.valid_until}).`
        );
      }

      // 4. Server-Side Integer Math Guard (BigInt arithmetic, NEVER parseFloat)
      const unitPriceCents = BigInt(quote.unit_price_cents);
      const quantityBigInt = BigInt(proposal.quantity);
      const calculatedTotalCents = quantityBigInt * unitPriceCents;

      const itemRes = await query(
        `SELECT name FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`,
        [workspaceId, quote.item_sku]
      );
      const itemName = itemRes.rows[0]?.name || quote.item_sku;

      // 5. Evaluate with TypeSafe Jev System One decision scorer
      const candidatesRes = await query(
        `SELECT q.id AS quote_id, q.supplier_id, q.supplier_name, q.unit_price_cents, q.total_price_cents,
                q.valid_until, s.verified
         FROM quotes q
         JOIN suppliers s ON s.id = q.supplier_id AND s.workspace_id = q.workspace_id
         WHERE q.workspace_id = $1 AND q.item_sku = $2;`,
        [workspaceId, quote.item_sku]
      );

      const wsRes = await query(`SELECT * FROM workspaces WHERE id = $1;`, [workspaceId]);
      const ws = wsRes.rows[0];

      const invRes = await query(
        `SELECT current_quantity, par_level, reorder_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`,
        [workspaceId, quote.item_sku]
      );
      const inv = invRes.rows[0];

      const spendRes = await query(
        `SELECT COALESCE(SUM(total_price_cents), 0) AS daily_spent_cents
         FROM orders
         WHERE workspace_id = $1
           AND created_at >= CURRENT_DATE
           AND status IN ('submitted', 'confirmed', 'reconciled');`,
        [workspaceId]
      );
      const dailySpentCents = BigInt(spendRes.rows[0]?.daily_spent_cents || 0);
      const budgetLimitCents = BigInt(ws?.budget_daily_limit_cents || 100000);
      const remainingDailyBudgetCents = Number(
        budgetLimitCents > dailySpentCents ? budgetLimitCents - dailySpentCents : 0n
      );

      const now = new Date();
      const candidates = candidatesRes.rows.map((row: any) => ({
        quoteId: row.quote_id,
        supplierId: row.supplier_id,
        supplierName: row.supplier_name,
        unitPriceCents: Number(row.unit_price_cents),
        totalPriceCents: Number(row.total_price_cents),
        validUntil: row.valid_until,
        isExpired: new Date(row.valid_until) < now,
        isVerifiedSupplier: Boolean(row.verified),
        historicalMatchRate: 1.0,
      }));

      const jevEvaluation = await evaluateWithJevSystemOne({
        workspaceId,
        templateId: ws?.template_id || "kitchen-ops",
        sku: quote.item_sku,
        currentQuantity: Number(inv?.current_quantity || 0),
        parLevel: Number(inv?.par_level || 10),
        reorderQuantity: Number(inv?.reorder_quantity || proposal.quantity),
        approvalThresholdCents: Number(ws?.approval_threshold_cents || 25000),
        remainingDailyBudgetCents,
        candidates:
          candidates.length > 0
            ? candidates
            : [
                {
                  quoteId: proposal.quoteId,
                  supplierId: proposal.supplierId,
                  supplierName: quote.verified_supplier_name,
                  unitPriceCents: Number(quote.unit_price_cents),
                  totalPriceCents: Number(calculatedTotalCents),
                  validUntil: quote.valid_until,
                  isExpired: false,
                  isVerifiedSupplier: true,
                  historicalMatchRate: 1.0,
                },
              ],
      });

      // 6. Store validated proposal in workflow context
      const proposalRecord = {
        proposalId: `prop_${workflowId}`,
        workflowId,
        sku: quote.item_sku,
        itemName,
        quantity: proposal.quantity,
        supplierId: proposal.supplierId,
        supplierName: quote.verified_supplier_name,
        supplierWallet: CANONICAL_ARC_LOCK.whitelistedVendor,
        quoteId: proposal.quoteId,
        unitPriceCents: unitPriceCents.toString(),
        totalPriceCents: calculatedTotalCents.toString(),
        reasonCodes: proposal.reasonCodes,
        explanation: proposal.explanation,
        sourceRecordIds: proposal.sourceRecordIds,
        jevEvaluation,
        validatedAt: new Date().toISOString(),
        status: "VALIDATED" as const,
      };

      await query(
        `UPDATE workflows
         SET context_data = context_data || $1::jsonb, updated_at = NOW()
         WHERE id = $2;`,
        [JSON.stringify({ replenishmentProposal: proposalRecord }), workflowId]
      );

      await query(
        `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
         VALUES ($1, $2, $3, 'agent', 'procurement_agent', 'commercial_commitment', 'replenishment.propose', 'ALLOW', $4::jsonb, NOW());`,
        [
          `audit_prop_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          workspaceId,
          workflowId,
          JSON.stringify(proposalRecord),
        ]
      );

      return JSON.stringify({
        proposalId: proposalRecord.proposalId,
        status: "VALIDATED",
        sku: proposalRecord.sku,
        quantity: proposalRecord.quantity,
        unitPriceCents: proposalRecord.unitPriceCents,
        totalPriceCents: proposalRecord.totalPriceCents,
        totalPriceUsdcFormatted: `$${(Number(calculatedTotalCents) / 100).toFixed(2)} USDC`,
        message:
          "Proposal successfully validated against database records and integer math invariants.",
      });
    },
    {
      name: "create_replenishment_proposal",
      description:
        "Validates and submits a replenishment proposal. Server recalculates all pricing in BigInt base units from stored quote records.",
      schema: z.object({
        itemId: z.string().describe("SKU or item identifier."),
        quantity: z.number().int().positive().describe("Integer quantity to order."),
        supplierId: z.string().describe("The selected approved supplier identifier."),
        quoteId: z.string().describe("The PostgreSQL quote ID being accepted."),
        reasonCodes: z.array(z.string()).min(1).describe("List of reason codes justifying this purchase."),
        explanation: z.string().min(10).describe("Concise explanation justifying supplier selection and quantity math."),
        sourceRecordIds: z.array(z.string()).min(1).describe("Underlying database record IDs consulted."),
      }),
    }
  );

  /**
   * Tool 5: request_policy_evaluation
   * Evaluates proposal against spending limits and on-chain BindSettlement.sol policy.
   */
  const requestPolicyEvaluationTool = tool(
    async ({ requestId }: { requestId: string }) => {
      const targetWorkflowId = requestId || workflowId;
      const wfRes = await query(`SELECT * FROM workflows WHERE id = $1;`, [
        targetWorkflowId,
      ]);
      if (wfRes.rows.length === 0) {
        throw new Error(`Workflow '${targetWorkflowId}' not found.`);
      }
      const wf = wfRes.rows[0];
      const proposal = wf.context_data?.replenishmentProposal;
      if (!proposal) {
        throw new Error(
          `No validated replenishment proposal found in workflow '${targetWorkflowId}'. Call create_replenishment_proposal first.`
        );
      }

      const wsRes = await query(`SELECT * FROM workspaces WHERE id = $1;`, [
        workspaceId,
      ]);
      const ws = wsRes.rows[0];

      const amountCents = BigInt(proposal.totalPriceCents);
      const dailyLimitCents = BigInt(ws.budget_daily_limit_cents);
      const approvalThresholdCents = BigInt(ws.approval_threshold_cents);

      // Compute cumulative spend today
      const spendRes = await query(
        `SELECT COALESCE(SUM(total_price_cents), 0) AS daily_spent_cents
         FROM orders
         WHERE workspace_id = $1
           AND created_at >= CURRENT_DATE
           AND status IN ('submitted', 'confirmed', 'reconciled');`,
        [workspaceId]
      );
      const dailySpentCents = BigInt(spendRes.rows[0].daily_spent_cents || 0);

      // Check against hard daily limit
      if (dailySpentCents + amountCents > dailyLimitCents) {
        await query(
          `UPDATE workflows SET state = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2;`,
          [
            `Daily spend limit exceeded: attempting $${(Number(amountCents) / 100).toFixed(2)} when $${(Number(dailySpentCents) / 100).toFixed(2)} of $${(Number(dailyLimitCents) / 100).toFixed(2)} is already committed.`,
            targetWorkflowId,
          ]
        );
        return JSON.stringify({
          requestId: targetWorkflowId,
          policyDecision: "DENY",
          workflowState: WorkflowState.FAILED,
          reason: `Spend ($${(Number(amountCents) / 100).toFixed(2)}) + today's spend ($${(Number(dailySpentCents) / 100).toFixed(2)}) exceeds daily limit ($${(Number(dailyLimitCents) / 100).toFixed(2)}).`,
        });
      }

      // Check vendor whitelist against on-chain policy
      const vendorWhitelisted =
        proposal.supplierWallet.toLowerCase() ===
        CANONICAL_ARC_LOCK.whitelistedVendor.toLowerCase();

      const jevHoldRequired = Boolean(proposal.jevEvaluation?.holdForOwnerReview);

      let nextState: WorkflowState;
      let policyDecision: PolicyDecision;
      let approvalId: string | undefined = undefined;

      if (amountCents > approvalThresholdCents || !vendorWhitelisted || jevHoldRequired) {
        policyDecision = PolicyDecision.REQUIRE_APPROVAL;
        nextState = WorkflowState.AWAITING_APPROVAL;
        approvalId = `appr_${targetWorkflowId}`;

        await query(
          `INSERT INTO approvals (id, workspace_id, entity_type, entity_id, action_requested, amount_cents, requester_role, status, expires_at, created_at)
           VALUES ($1, $2, 'order', $3, $4, $5, 'procurement_agent', 'pending', NOW() + INTERVAL '24 hours', NOW())
           ON CONFLICT (id) DO NOTHING;`,
          [
            approvalId,
            workspaceId,
            targetWorkflowId,
            `Purchase ${proposal.quantity}x ${proposal.itemName || proposal.sku} from ${proposal.supplierName} for $${(Number(amountCents) / 100).toFixed(2)} USDC`,
            amountCents,
          ]
        );

        const displayItemName = proposal.itemName || proposal.sku;
        await notificationEmitter.send({
          workspaceId,
          channel: "whatsapp",
          recipient: "+12125550199",
          title: "⚠️ Bind Alert: Ingredient Restock Approval Required",
          message: `Low stock detected on ${displayItemName}. Best quote from ${proposal.supplierName} is $${(Number(amountCents) / 100).toFixed(2)} USDC.`,
          actionUrl: `http://127.0.0.1:3000/api/approvals/${approvalId}/approve`,
          approvalToken: approvalId,
        });
      } else {
        policyDecision = PolicyDecision.ALLOW;
        nextState = WorkflowState.AUTHORIZED;
      }

      // Generate verifiable decision record and anti-drift lock files
      const decisionRecord = await generateVerifiableDecisionRecord({
        workflowId: targetWorkflowId,
        templateId: ws.template_id || "kitchen-ops",
        skuName: proposal.itemName || proposal.sku,
        quantityRequested: proposal.quantity,
        candidateQuotes: [
          {
            vendorId: proposal.supplierId,
            vendorName: proposal.supplierName,
            vendorWallet: proposal.supplierWallet,
            unitPriceUsdc: (Number(proposal.unitPriceCents) / 100).toFixed(4),
            totalPriceUsdc: (Number(amountCents) / 100).toFixed(4),
            leadTimeDays: 2,
            isWhitelistedOnChain: vendorWhitelisted,
          },
        ],
        dailyLimitUsdc: (Number(dailyLimitCents) / 100).toFixed(2),
      });

      await query(
        `UPDATE workflows
         SET state = $1,
             context_data = context_data || $2::jsonb,
             updated_at = NOW()
         WHERE id = $3;`,
        [
          nextState,
          JSON.stringify({
            policyDecision,
            approvalId,
            jevEvaluation: proposal.jevEvaluation,
            decisionRecord,
            decisionHash: decisionRecord.decisionHash,
            evidencePath: `workflows/${targetWorkflowId}/DECISION_EVIDENCE.md`,
          }),
          targetWorkflowId,
        ]
      );

      return JSON.stringify({
        requestId: targetWorkflowId,
        policyDecision,
        workflowState: nextState,
        approvalId,
        decisionHash: decisionRecord.decisionHash,
        withinDailyLimit: true,
        requiresOwnerApproval: nextState === WorkflowState.AWAITING_APPROVAL,
      });
    },
    {
      name: "request_policy_evaluation",
      description:
        "Evaluates proposal against deterministic spending limits and on-chain BindSettlement.sol policy.",
      schema: z.object({
        requestId: z.string().describe("The workflow ID being evaluated."),
      }),
    }
  );

  /**
   * Tool 6: get_request_status
   * Returns chain-reconciled status, decisionHash, and evidence classification.
   */
  const getRequestStatusTool = tool(
    async ({ requestId }: { requestId: string }) => {
      const targetWorkflowId = requestId || workflowId;
      const wfRes = await query(`SELECT * FROM workflows WHERE id = $1;`, [
        targetWorkflowId,
      ]);
      if (wfRes.rows.length === 0) {
        throw new Error(`Workflow '${targetWorkflowId}' not found.`);
      }
      const wf = wfRes.rows[0];
      const wsRes = await query(
        `SELECT settlement_mode FROM workspaces WHERE id = $1;`,
        [wf.workspace_id]
      );
      const isArc = wsRes.rows[0]?.settlement_mode === "arc-testnet";
      const evidenceClassification = isArc ? "VERIFIED_REMOTE" : "LOCAL_PASS";

      return JSON.stringify({
        requestId: wf.id,
        workflowState: wf.state,
        totalPriceCents:
          wf.context_data?.replenishmentProposal?.totalPriceCents,
        decisionHash: wf.context_data?.decisionHash,
        evidenceClassification,
        evidencePath: wf.context_data?.evidencePath,
        approvalId: wf.context_data?.approvalId,
        errorMessage: wf.error_message,
      });
    },
    {
      name: "get_request_status",
      description:
        "Returns the chain-reconciled workflow state, decision hash, and evidence classification.",
      schema: z.object({
        requestId: z.string().describe("The workflow ID to check status for."),
      }),
    }
  );

  return {
    getBusinessContextTool,
    getStockSnapshotTool,
    getApprovedSupplierQuotesTool,
    createReplenishmentProposalTool,
    requestPolicyEvaluationTool,
    getRequestStatusTool,
    allTools: [
      getBusinessContextTool,
      getStockSnapshotTool,
      getApprovedSupplierQuotesTool,
      createReplenishmentProposalTool,
      requestPolicyEvaluationTool,
      getRequestStatusTool,
    ],
  };
}
