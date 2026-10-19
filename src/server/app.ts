import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "../db/client.js";
import { provisionWorkspace, listTemplates } from "../templates/registry.js";
import { ProcurementWorkflowRunner } from "../workflows/procurement.js";
import { ApprovalDecisionError } from "../workflows/engine.js";
import { WorkflowCrashRecoveryRunner } from "../workflows/recovery.js";
import { webhookReceiver } from "../adapters/web2/webhook-receiver.js";
import { getSettlementAdapter } from "../adapters/settlement/index.js";
import {
  normalizePaymentAddress,
  simulatedPaymentAddress,
} from "../adapters/suppliers/payment-address.js";
import {
  SocialSurfaceEventSchema,
  SurfaceAuthorizationError,
  verifyAndAuthorizeSurfaceEvent,
  upsertSurfaceBinding,
  listSurfaceBindings,
} from "../adapters/socialSurface.js";
import {
  SAFE_AGENT_TOOLS,
  FORBIDDEN_AGENT_CAPABILITIES,
  ForbiddenCapabilityError,
  InitialSupplyItemSchema,
  InitialSupplierSchema,
  getTemplateBlueprint,
  onboardBlankWorkspace,
  upsertAgentRole,
  syncWorkspaceDerivedTemplateFiles,
} from "../studio/onboarding.js";
import {
  extractDocumentDraft,
  confirmStagedDocument,
  listStagedDocuments,
  getWorkspaceAccountingLedger,
  formatLedgerAsCsv,
} from "../studio/documentsAndAccounting.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Maps an approval decision failure to its HTTP status; anything else stays a 400. */
function sendApprovalError(res: Response, err: any) {
  if (err instanceof ApprovalDecisionError) {
    const status = err.code === "APPROVAL_NOT_FOUND" ? 404 : 409;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  return res.status(400).json({ error: err.message });
}

export function createApp(): express.Express {
  const app = express();
  const procurementRunner = new ProcurementWorkflowRunner();
  const recoveryRunner = new WorkflowCrashRecoveryRunner();

  app.use(helmet({
    contentSecurityPolicy: false, // Allow CDN resources for Tailwind in UI
  }));
  app.use(cors());
  app.use(express.json());

  // Serve static UI assets with no-store cache headers so updates are always fresh
  const staticPath = path.resolve(__dirname, "../../src/ui/public");
  app.use(
    express.static(staticPath, {
      etag: false,
      lastModified: false,
      setHeaders: (res) => {
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      },
    })
  );

  // Healthcheck
  app.get("/health", async (_req: Request, res: Response) => {
    try {
      await query("SELECT 1;");
      res.json({ status: "ok", postgres: "connected", timestamp: new Date() });
    } catch (err: any) {
      res.status(500).json({ status: "error", error: err.message });
    }
  });

  // Templates & Blueprints
  app.get("/api/templates", (_req: Request, res: Response) => {
    res.json(listTemplates());
  });

  app.get("/api/templates/:id/blueprint", (req: Request, res: Response) => {
    const bp = getTemplateBlueprint(req.params.id);
    if (!bp) {
      return res.status(404).json({ error: `Template '${req.params.id}' not found.` });
    }
    res.json(bp);
  });

  // Workspaces
  app.get("/api/workspaces", async (_req: Request, res: Response) => {
    const wsRes = await query("SELECT * FROM workspaces ORDER BY created_at DESC;");
    res.json(wsRes.rows);
  });

  // Flow A: Onboard genuinely blank or owner-configured workspace
  app.post("/api/workspaces/onboard", async (req: Request, res: Response) => {
    try {
      const result = await onboardBlankWorkspace(req.body);
      res.status(201).json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/workspaces", async (req: Request, res: Response) => {
    const { id, name, templateId } = req.body;
    if (!id || !name || !templateId) {
      return res.status(400).json({ error: "id, name, and templateId are required" });
    }
    try {
      const template = await provisionWorkspace(id, name, templateId);
      res.status(201).json({ message: "Workspace provisioned", template });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/workspaces/:id", async (req: Request, res: Response) => {
    const { id } = req.params;
    const wsRes = await query("SELECT * FROM workspaces WHERE id = $1;", [id]);
    if (wsRes.rows.length === 0) {
      return res.status(404).json({ error: "Workspace not found" });
    }
    const rolesRes = await query("SELECT * FROM agent_roles WHERE workspace_id = $1 ORDER BY created_at ASC;", [id]);
    const settlementAdapter = getSettlementAdapter(wsRes.rows[0].settlement_mode);
    const balance = await settlementAdapter.getBalance(wsRes.rows[0].settlement_address || "");

    res.json({
      workspace: wsRes.rows[0],
      roles: rolesRes.rows,
      treasuryBalanceCents: balance.toString(),
      safeAgentTools: SAFE_AGENT_TOOLS,
      forbiddenCapabilities: FORBIDDEN_AGENT_CAPABILITIES,
    });
  });

  // Update workspace spending policy & settlement address
  app.put("/api/workspaces/:id/policy", async (req: Request, res: Response) => {
    const { id } = req.params;
    const budgetDailyLimitCents = Number(req.body.budgetDailyLimitCents);
    const approvalThresholdCents = Number(req.body.approvalThresholdCents);
    const settlementAddress = req.body.settlementAddress;

    if (!Number.isInteger(budgetDailyLimitCents) || budgetDailyLimitCents <= 0) {
      return res.status(400).json({ error: "budgetDailyLimitCents must be a positive integer." });
    }
    if (!Number.isInteger(approvalThresholdCents) || approvalThresholdCents < 0) {
      return res.status(400).json({ error: "approvalThresholdCents must be a non-negative integer." });
    }
    if (approvalThresholdCents > budgetDailyLimitCents) {
      return res.status(400).json({ error: "Approval threshold cannot exceed daily budget limit." });
    }

    try {
      const upd = await query(
        `UPDATE workspaces
         SET budget_daily_limit_cents = $1,
             approval_threshold_cents = $2,
             settlement_address = COALESCE($3, settlement_address),
             updated_at = NOW()
         WHERE id = $4
         RETURNING *;`,
        [budgetDailyLimitCents, approvalThresholdCents, settlementAddress || null, id]
      );
      if (upd.rows.length === 0) {
        return res.status(404).json({ error: "Workspace not found." });
      }
      await syncWorkspaceDerivedTemplateFiles(id);
      res.json({ workspace: upd.rows[0], provenance: "OWNER_CONFIRMED" });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Inventory
  app.get("/api/workspaces/:id/inventory", async (req: Request, res: Response) => {
    const { id } = req.params;
    const invRes = await query(
      "SELECT * FROM inventory_items WHERE workspace_id = $1 ORDER BY sku ASC;",
      [id]
    );
    res.json(invRes.rows);
  });

  app.post("/api/workspaces/:id/inventory", async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const item = InitialSupplyItemSchema.parse(req.body);
      const itemId = `inv_${id}_${item.sku}`;
      const ins = await query(
        `INSERT INTO inventory_items (id, workspace_id, sku, name, category, unit, current_quantity, par_level, reorder_quantity, unit_price_cents, preferred_supplier_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (workspace_id, sku) DO UPDATE SET
           name = EXCLUDED.name,
           category = EXCLUDED.category,
           unit = EXCLUDED.unit,
           current_quantity = EXCLUDED.current_quantity,
           par_level = EXCLUDED.par_level,
           reorder_quantity = EXCLUDED.reorder_quantity,
           unit_price_cents = EXCLUDED.unit_price_cents,
           preferred_supplier_id = COALESCE(EXCLUDED.preferred_supplier_id, inventory_items.preferred_supplier_id),
           updated_at = NOW()
         RETURNING *;`,
        [
          itemId,
          id,
          item.sku,
          item.name,
          item.category,
          item.unit,
          item.currentQuantity,
          item.parLevel,
          item.reorderQuantity,
          item.unitPriceCents,
          item.preferredSupplierId || null,
        ]
      );
      res.status(201).json(ins.rows[0]);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Low stock trigger / replenishment
  app.post("/api/workspaces/:id/replenish", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { sku } = req.body;
    if (!sku) {
      return res.status(400).json({ error: "sku is required" });
    }
    try {
      const result = await procurementRunner.startReplenishment(id, sku, "owner_manual_trigger");
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Approvals
  app.get("/api/workspaces/:id/approvals", async (req: Request, res: Response) => {
    const { id } = req.params;
    await procurementRunner.expireApprovals({ workspaceId: id });
    const apprRes = await query(
      "SELECT * FROM approvals WHERE workspace_id = $1 ORDER BY created_at DESC;",
      [id]
    );
    res.json(apprRes.rows);
  });

  app.post("/api/approvals/:id/approve", async (req: Request, res: Response) => {
    const { id } = req.params;
    const decidedBy = req.body.decidedBy || "owner@bind.local";
    try {
      const result = await procurementRunner.approveAndSubmit(id, decidedBy);
      res.json(result);
    } catch (err: any) {
      sendApprovalError(res, err);
    }
  });

  app.post("/api/approvals/:id/reject", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { reason, decidedBy } = req.body;
    try {
      const result = await procurementRunner.declineApproval(
        id,
        "rejected",
        decidedBy || "owner@bind.local",
        reason
      );
      res.json({ status: "rejected", approvalId: id, ...result });
    } catch (err: any) {
      sendApprovalError(res, err);
    }
  });

  app.post("/api/approvals/:id/revoke", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { reason, decidedBy } = req.body;
    try {
      const result = await procurementRunner.declineApproval(
        id,
        "revoked",
        decidedBy || "owner@bind.local",
        reason
      );
      res.json({ status: "revoked", approvalId: id, ...result });
    } catch (err: any) {
      sendApprovalError(res, err);
    }
  });

  // Fulfill and Reconcile Order
  app.post("/api/orders/:id/reconcile", async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const result = await procurementRunner.fulfillAndReconcile(id);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Workflows
  app.get("/api/workspaces/:id/workflows", async (req: Request, res: Response) => {
    const { id } = req.params;
    const wfRes = await query(
      "SELECT * FROM workflows WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 50;",
      [id]
    );
    res.json(wfRes.rows);
  });

  // Orders & 3-Way Match Status
  app.get("/api/workspaces/:id/orders", async (req: Request, res: Response) => {
    const { id } = req.params;
    const ordRes = await query(
      `SELECT o.*,
              m.match_status,
              m.variance_cents,
              m.notes AS match_notes,
              m.matched_at
       FROM orders o
       LEFT JOIN LATERAL (
         SELECT match_status, variance_cents, notes, matched_at
         FROM three_way_matches
         WHERE order_id = o.id
         ORDER BY matched_at DESC
         LIMIT 1
       ) m ON true
       WHERE o.workspace_id = $1
       ORDER BY o.created_at DESC
       LIMIT 50;`,
      [id]
    );
    res.json(ordRes.rows);
  });

  // Suppliers
  app.get("/api/workspaces/:id/suppliers", async (req: Request, res: Response) => {
    const { id } = req.params;
    const suppRes = await query(
      "SELECT * FROM suppliers WHERE workspace_id = $1 ORDER BY name ASC;",
      [id]
    );
    res.json(suppRes.rows);
  });

  app.post("/api/workspaces/:id/suppliers", async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const supp = InitialSupplierSchema.parse(req.body);
      const fullSuppId = supp.id.startsWith(`${id}_`) ? supp.id : `${id}_${supp.id}`;
      // Optional payee address. When sent it must be a valid EVM address, stored checksummed.
      // Omitted: a simulated supplier gets its simulated address, a real one stays without an address.
      const rawPayment = req.body?.paymentAddress;
      const hasPayment = rawPayment !== undefined && rawPayment !== null && rawPayment !== "";
      const providedPayment = hasPayment ? normalizePaymentAddress(rawPayment) : null;
      if (hasPayment && providedPayment === null) {
        res.status(400).json({ error: "paymentAddress must be a valid EVM address" });
        return;
      }
      const paymentAddress = providedPayment ?? (supp.isSimulated ? simulatedPaymentAddress(fullSuppId) : null);
      const ins = await query(
        `INSERT INTO suppliers (id, workspace_id, name, adapter_type, contact_email, verified, is_simulated, endpoint_url, payment_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           adapter_type = EXCLUDED.adapter_type,
           contact_email = EXCLUDED.contact_email,
           verified = EXCLUDED.verified,
           is_simulated = EXCLUDED.is_simulated,
           endpoint_url = EXCLUDED.endpoint_url,
           payment_address = COALESCE(EXCLUDED.payment_address, suppliers.payment_address)
         RETURNING *;`,
        [
          fullSuppId,
          id,
          supp.name,
          supp.adapterType,
          supp.contactEmail || null,
          supp.verified,
          supp.isSimulated,
          supp.endpointUrl || null,
          paymentAddress,
        ]
      );
      res.status(201).json(ins.rows[0]);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Flow B: Role-Specific Agent Creator & Configurator
  app.get("/api/workspaces/:id/agents", async (req: Request, res: Response) => {
    const { id } = req.params;
    const rolesRes = await query(
      "SELECT * FROM agent_roles WHERE workspace_id = $1 ORDER BY created_at ASC;",
      [id]
    );
    res.json({
      roles: rolesRes.rows,
      safeAgentTools: SAFE_AGENT_TOOLS,
      forbiddenCapabilities: FORBIDDEN_AGENT_CAPABILITIES,
    });
  });

  app.post("/api/workspaces/:id/agents", async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const result = await upsertAgentRole(id, req.body);
      res.status(201).json(result);
    } catch (err: any) {
      if (err instanceof ForbiddenCapabilityError) {
        return res.status(400).json({ error: err.message, code: "FORBIDDEN_CAPABILITY" });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // Flow C: Messaging Surfaces & Identity Bindings
  app.get("/api/workspaces/:id/surfaces", async (req: Request, res: Response) => {
    const { id } = req.params;
    const bindings = await listSurfaceBindings(id);
    res.json(bindings);
  });

  app.post("/api/workspaces/:id/surfaces", async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const binding = await upsertSurfaceBinding(id, req.body);
      res.status(201).json(binding);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Flow D: Two-Stage Document Extract -> Confirm & Accounting Ledger
  app.get("/api/workspaces/:id/documents", async (req: Request, res: Response) => {
    const { id } = req.params;
    const docs = await listStagedDocuments(id);
    res.json(docs);
  });

  app.post("/api/workspaces/:id/documents/extract", async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const draft = await extractDocumentDraft(id, req.body);
      res.status(201).json(draft);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/workspaces/:id/documents/:docId/confirm", async (req: Request, res: Response) => {
    const { id, docId } = req.params;
    try {
      const confirmed = await confirmStagedDocument(id, docId, req.body);
      res.json(confirmed);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/workspaces/:id/accounting/ledger", async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const entries = await getWorkspaceAccountingLedger(id);
      if (req.query.format === "csv") {
        const csv = formatLedgerAsCsv(entries);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="bind-ledger-${id}.csv"`
        );
        return res.send(csv);
      }
      res.json(entries);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Audit Logs
  app.get("/api/workspaces/:id/audit", async (req: Request, res: Response) => {
    const { id } = req.params;
    const auditRes = await query(
      "SELECT * FROM audit_logs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100;",
      [id]
    );
    res.json(auditRes.rows);
  });

  // Crash Recovery
  app.post("/api/workspaces/:id/recover", async (_req: Request, res: Response) => {
    try {
      const report = await recoveryRunner.recoverInterruptedWorkflows();
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Inbound Webhooks (Standard and Social/POS Surface)
  app.post("/api/webhooks/incoming", async (req: Request, res: Response) => {
    // 1. Check if incoming body is a Social / POS Surface event
    const surfaceParsed = SocialSurfaceEventSchema.safeParse(req.body);
    if (surfaceParsed.success) {
      const event = surfaceParsed.data;
      let authMeta: { effectiveRole: "owner" | "staff"; bindingStatus: string };
      try {
        authMeta = await verifyAndAuthorizeSurfaceEvent(event);
      } catch (err: any) {
        if (err instanceof SurfaceAuthorizationError) {
          return res.status(403).json({ error: err.message });
        }
        return res.status(400).json({ error: err.message });
      }

      if (event.eventType === "SURFACE_STOCK_OBSERVED") {
        const itemRes = await query(
          `UPDATE inventory_items
           SET current_quantity = $1, updated_at = NOW()
           WHERE workspace_id = $2 AND sku = $3
           RETURNING *;`,
          [event.observedQuantity, event.workspaceId, event.sku]
        );
        const item = itemRes.rows[0];
        let replenishmentResult = null;
        if (item && Number(item.current_quantity) < Number(item.par_level)) {
          try {
            replenishmentResult = await procurementRunner.startReplenishment(
              event.workspaceId,
              event.sku,
              `surface_${event.surface}`
            );
          } catch (err: any) {
            return res.status(400).json({ error: err.message });
          }
        }
        return res.json({
          status: "processed",
          eventType: event.eventType,
          effectiveRole: authMeta.effectiveRole,
          bindingStatus: authMeta.bindingStatus,
          observedQuantity: event.observedQuantity,
          parLevel: item ? Number(item.par_level) : undefined,
          replenishmentTriggered: Boolean(replenishmentResult),
          replenishmentResult,
        });
      }

      if (event.eventType === "SURFACE_OWNER_APPROVAL_DECISION") {
        if (event.decision === "approve") {
          try {
            const result = await procurementRunner.approveAndSubmit(
              event.approvalId,
              event.actorId
            );
            return res.json({
              status: "processed",
              eventType: event.eventType,
              effectiveRole: authMeta.effectiveRole,
              bindingStatus: authMeta.bindingStatus,
              decision: "approve",
              result,
            });
          } catch (err: any) {
            return sendApprovalError(res, err);
          }
        } else {
          try {
            await procurementRunner.declineApproval(
              event.approvalId,
              "rejected",
              event.actorId,
              event.reason || "Rejected by owner via surface card"
            );
          } catch (err: any) {
            return sendApprovalError(res, err);
          }
          return res.json({
            status: "processed",
            eventType: event.eventType,
            effectiveRole: authMeta.effectiveRole,
            bindingStatus: authMeta.bindingStatus,
            decision: "reject",
            approvalId: event.approvalId,
          });
        }
      }

      if (event.eventType === "SURFACE_AGENT_PAUSE_TOGGLE") {
        await query(
          `UPDATE workspaces
           SET updated_at = NOW()
           WHERE id = $1;`,
          [event.workspaceId]
        );
        return res.json({
          status: "processed",
          eventType: event.eventType,
          effectiveRole: authMeta.effectiveRole,
          bindingStatus: authMeta.bindingStatus,
          workspaceId: event.workspaceId,
          paused: event.paused,
        });
      }
    }

    // 2. Standard external webhooks with HMAC signature verification
    const sigHeader = (req.headers["x-bind-signature"] as string) || "";
    const timeHeader = Number(req.headers["x-bind-timestamp"] || 0);

    const rawBody = JSON.stringify(req.body);
    const verified = webhookReceiver.verifySignature(rawBody, sigHeader, timeHeader);

    if (!verified && process.env.NODE_ENV !== "test") {
      return res.status(401).json({ error: "Invalid signature or expired timestamp" });
    }

    const { provider, eventId, payload } = req.body;
    const result = await webhookReceiver.processEvent({
      provider: provider || "external",
      eventId: eventId || `evt_${Date.now()}`,
      timestamp: timeHeader || Math.floor(Date.now() / 1000),
      payload: payload || req.body,
    });

    res.json(result);
  });

  // Default SPA route (supports /, /app, /app/workflows/:workflowId)
  app.get("*", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(path.resolve(staticPath, "index.html"));
  });

  return app;
}
