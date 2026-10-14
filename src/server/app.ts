import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import { fileURLToPath } from "url";
import { query } from "../db/client.js";
import { provisionWorkspace, listTemplates } from "../templates/registry.js";
import { ProcurementWorkflowRunner } from "../workflows/procurement.js";
import { WorkflowCrashRecoveryRunner } from "../workflows/recovery.js";
import { webhookReceiver } from "../adapters/web2/webhook-receiver.js";
import { getSettlementAdapter } from "../adapters/settlement/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(): express.Express {
  const app = express();
  const procurementRunner = new ProcurementWorkflowRunner();
  const recoveryRunner = new WorkflowCrashRecoveryRunner();

  app.use(helmet({
    contentSecurityPolicy: false, // Allow CDN resources for Tailwind in UI
  }));
  app.use(cors());
  app.use(express.json());

  // Serve static UI assets
  const staticPath = path.resolve(__dirname, "../../src/ui/public");
  app.use(express.static(staticPath));

  // Healthcheck
  app.get("/health", async (_req: Request, res: Response) => {
    try {
      await query("SELECT 1;");
      res.json({ status: "ok", postgres: "connected", timestamp: new Date() });
    } catch (err: any) {
      res.status(500).json({ status: "error", error: err.message });
    }
  });

  // Templates
  app.get("/api/templates", (_req: Request, res: Response) => {
    res.json(listTemplates());
  });

  // Workspaces
  app.get("/api/workspaces", async (_req: Request, res: Response) => {
    const wsRes = await query("SELECT * FROM workspaces ORDER BY created_at DESC;");
    res.json(wsRes.rows);
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
    const rolesRes = await query("SELECT * FROM agent_roles WHERE workspace_id = $1;", [id]);
    const settlementAdapter = getSettlementAdapter(wsRes.rows[0].settlement_mode);
    const balance = await settlementAdapter.getBalance(wsRes.rows[0].settlement_address || "");

    res.json({
      workspace: wsRes.rows[0],
      roles: rolesRes.rows,
      treasuryBalanceCents: balance.toString(),
    });
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
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/approvals/:id/reject", async (req: Request, res: Response) => {
    const { id } = req.params;
    const { reason, decidedBy } = req.body;
    try {
      await query(
        "UPDATE approvals SET status = 'rejected', reason = $1, decided_by = $2, decided_at = NOW() WHERE id = $3 AND status = 'pending';",
        [reason || "Rejected by owner", decidedBy || "owner@bind.local", id]
      );
      res.json({ status: "rejected", approvalId: id });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
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

  // Inbound Webhooks
  app.post("/api/webhooks/incoming", async (req: Request, res: Response) => {
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

  // Default SPA route
  app.get("*", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(staticPath, "index.html"));
  });

  return app;
}
