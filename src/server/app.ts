import express, { Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import { fileURLToPath } from "url";
import { z } from "zod";
import { query } from "../db/client.js";
import { acquireAdvisoryLock } from "../db/advisory-lock.js";
import { config } from "../config/env.js";
import { issueToken, listTokens, revokeToken, TokenError, type WorkspaceRole } from "../auth/tokens.js";
import { authenticated, workspaceMember, workspaceOwner, anyWorkspaceOwner } from "../auth/middleware.js";
import { provisionWorkspace, listTemplates } from "../templates/registry.js";
import { ProcurementWorkflowRunner } from "../workflows/procurement.js";
import { ApprovalDecisionError } from "../workflows/engine.js";
import {
  acceptCustomerOrder,
  acceptHeldOrder,
  cancelCustomerOrder,
  fulfilCustomerOrder,
  getCustomerOrder,
  listCustomerOrders,
  listKitchenCapacity,
  setKitchenCapacity,
  FulfilmentError,
  type OperatorActor,
} from "../workflows/fulfilment.js";
import { SettlementOrderError } from "../workflows/settlement.js";
import { WorkflowCrashRecoveryRunner } from "../workflows/recovery.js";
import { WebhookReceiver } from "../adapters/web2/webhook-receiver.js";
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
  type SocialSurfaceEvent,
} from "../adapters/socialSurface.js";
import { verifySignature, workspaceWebhookSecret } from "../webhooks/signing.js";
import {
  setCredential,
  listConnectors,
  revokeCredential,
  verifyCredential,
  CredentialInputError,
  CredentialNotFoundError,
  CredentialStoreDisabledError,
  type CredentialActor,
} from "../credentials/admin.js";
import {
  setAgentsPaused,
  viewWebhookSecret,
  rotateWebhookSecret,
} from "../studio/workspaceControls.js";
import { newId } from "../utils/ids.js";
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
    return res.status(status).json({
      error: err.message,
      code: err.code,
      ...(err.reasonCodes ? { reasonCodes: err.reasonCodes } : {}),
    });
  }
  return res.status(400).json({ error: err.message });
}

/** Customer order failures (ADR 0026). The message is the service's own text: it never echoes a customer's note. */
function sendFulfilmentError(res: Response, err: unknown) {
  if (err instanceof FulfilmentError) {
    const status = err.code === "INVALID_INPUT" ? 400 : err.code === "ORDER_NOT_FOUND" ? 404 : 409;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  if (err instanceof z.ZodError) {
    return res.status(400).json({ error: "Invalid request body", fields: err.issues.map((i) => i.path.join(".")) });
  }
  return res.status(500).json({ error: "Request could not be completed" });
}

const CustomerOrderBodySchema = z.object({
  externalRef: z.string().trim().min(1).max(120),
  lines: z.array(z.object({ sku: z.string().min(1).max(120), quantity: z.number() })).max(200),
  requestedFor: z.string().datetime({ offset: true }).optional(),
  // Customer text. Stored as data and truncated by the service; it is never a decision input.
  note: z.string().max(5000).optional(),
});

const KitchenCapacityBodySchema = z.object({
  slots: z
    .array(
      z.object({
        startsAt: z.string().datetime({ offset: true }),
        endsAt: z.string().datetime({ offset: true }),
        capacityUnits: z.number().int().min(0),
      })
    )
    .min(1)
    .max(200),
});

/** Parses BIND_CORS_ORIGINS: comma-separated origins. Unset or empty means no origin is allowed. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * JSON cannot carry a BigInt. Template amounts are BigInt in memory, so responses send them as decimal strings.
 * Done before any response is written, so a serialization error cannot follow a successful write.
 */
function jsonSafe<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/** The decision recorded for an approval: the owner token's label. The body's decidedBy is never used. */
function decidedByOf(label: string): string {
  return `owner:${label}`;
}

/** Sends a token-operation failure with its status. */
function sendTokenError(res: Response, err: unknown) {
  if (err instanceof TokenError) {
    const status = err.code === "TOKEN_NOT_FOUND" ? 404 : err.code === "LAST_OWNER_TOKEN" ? 409 : 400;
    return res.status(status).json({ error: err.message, code: err.code });
  }
  return res.status(500).json({ error: "Token operation failed" });
}

/** The audit actor for a credential change: the owner token's label, never the token. */
function credentialActorOf(req: Request): CredentialActor {
  return { type: "owner", id: req.actor!.label };
}

/** Maps a credential failure to its status. Messages name rules only; any other failure gets a generic body. */
function sendCredentialError(res: Response, err: unknown) {
  if (err instanceof CredentialStoreDisabledError) {
    return res.status(503).json({ error: "Credential store is not configured" });
  }
  if (err instanceof CredentialInputError) {
    return res.status(400).json({ error: err.message });
  }
  if (err instanceof CredentialNotFoundError) {
    return res.status(404).json({ error: "Connector credential not found" });
  }
  return res.status(500).json({ error: "Credential operation failed" });
}

type CreateOutcome<T> =
  | { kind: "conflict" }
  | { kind: "created"; result: T; ownerToken: { id: string; token: string } };

/**
 * Creates a workspace through a public route and issues its first owner token. An id that already exists is refused
 * before the create runs, so an existing workspace is never overwritten. The check, the create and the token run under
 * an advisory lock on the id, so two concurrent requests for one new id cannot both succeed. If the token cannot be
 * issued, the workspace just created is deleted, so no workspace is left without an owner.
 */
async function createWithOwnerToken<T>(workspaceId: string, create: () => Promise<T>): Promise<CreateOutcome<T>> {
  const lock = await acquireAdvisoryLock(`workspace-create:${workspaceId}`);
  if (!lock) return { kind: "conflict" };
  try {
    const existing = await query("SELECT 1 FROM workspaces WHERE id = $1;", [workspaceId]);
    if (existing.rows.length > 0) return { kind: "conflict" };
    const result = await create();
    try {
      const issued = await issueToken(workspaceId, "owner", "founding-owner", {
        type: "system",
        id: "system:workspace-create",
      });
      return { kind: "created", result, ownerToken: { id: issued.id, token: issued.token } };
    } catch (err) {
      await query("DELETE FROM workspaces WHERE id = $1;", [workspaceId]);
      throw err;
    }
  } finally {
    await lock.release();
  }
}

export interface CreateAppOptions {
  /** Browser origins allowed to call the API. Defaults to BIND_CORS_ORIGINS. An empty list sends no CORS headers. */
  corsOrigins?: string[];
  /**
   * Overrides for the webhook secrets (ADR 0022). null means unset, which fails closed with 503. Omitted means the
   * value from the environment. Tests use this to run unconfigured.
   */
  secrets?: { masterSecret?: string | null; webhookSecret?: string | null };
}

const WEBHOOK_UNAUTHORIZED = { error: "Invalid signature or expired timestamp" };
const WEBHOOK_NOT_CONFIGURED = { error: "Webhook signing is not configured" };

/** The raw bytes of a JSON request, kept by express.json so a signature is checked over what was sent. */
type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * True when the x-bind-signature and x-bind-timestamp headers authenticate the exact bytes received. Any missing or
 * malformed header, or a request with no raw body, is refused.
 */
function requestSignatureValid(req: Request, secret: string): boolean {
  const raw = (req as RawBodyRequest).rawBody;
  const signature = req.headers["x-bind-signature"];
  const timestamp = req.headers["x-bind-timestamp"];
  if (!Buffer.isBuffer(raw)) return false;
  if (typeof signature !== "string") return false;
  if (typeof timestamp !== "string" || !/^\d{1,15}$/.test(timestamp)) return false;
  return verifySignature({ secret, timestamp: Number(timestamp), rawBody: raw, signature });
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();
  const procurementRunner = new ProcurementWorkflowRunner();
  const recoveryRunner = new WorkflowCrashRecoveryRunner();
  const corsOrigins = options.corsOrigins ?? parseCorsOrigins(config.BIND_CORS_ORIGINS);
  const masterSecret =
    options.secrets?.masterSecret !== undefined ? (options.secrets.masterSecret ?? undefined) : config.BIND_MASTER_SECRET;
  const webhookSecret =
    options.secrets?.webhookSecret !== undefined ? (options.secrets.webhookSecret ?? undefined) : config.BIND_WEBHOOK_SECRET;
  const receiver = new WebhookReceiver(() => webhookSecret);

  app.use(helmet({
    contentSecurityPolicy: false, // Allow CDN resources for Tailwind in UI
  }));
  if (corsOrigins.length > 0) {
    app.use(cors({ origin: corsOrigins }));
  }
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf;
      },
    })
  );

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
    res.json(jsonSafe(listTemplates()));
  });

  app.get("/api/templates/:id/blueprint", (req: Request, res: Response) => {
    const bp = getTemplateBlueprint(req.params.id);
    if (!bp) {
      return res.status(404).json({ error: `Template '${req.params.id}' not found.` });
    }
    res.json(bp);
  });

  // Workspaces. The list returns only the caller's own workspace.
  app.get("/api/workspaces", ...authenticated, async (req: Request, res: Response) => {
    try {
      const wsRes = await query("SELECT * FROM workspaces WHERE id = $1;", [req.actor!.workspaceId]);
      res.json(wsRes.rows);
    } catch {
      res.status(500).json({ error: "Workspace list unavailable" });
    }
  });

  // Flow A: Onboard genuinely blank or owner-configured workspace. Public: creating a workspace issues its owner token.
  app.post("/api/workspaces/onboard", async (req: Request, res: Response) => {
    try {
      // No token exists before the workspace does, so the audit actor is the creating system (ADR 0023).
      const outcome = await createWithOwnerToken(String(req.body?.workspaceId ?? ""), () =>
        onboardBlankWorkspace(req.body, { type: "system", id: "system:workspace-create" })
      );
      if (outcome.kind === "conflict") {
        return res.status(409).json({ error: "Workspace id is not available" });
      }
      res.status(201).json(jsonSafe({ ...(outcome.result as object), ownerToken: outcome.ownerToken }));
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
      const outcome = await createWithOwnerToken(String(id), () => provisionWorkspace(id, name, templateId));
      if (outcome.kind === "conflict") {
        return res.status(409).json({ error: "Workspace id is not available" });
      }
      res.status(201).json(
        jsonSafe({ message: "Workspace provisioned", template: outcome.result, ownerToken: outcome.ownerToken })
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/workspaces/:id", ...workspaceMember, async (req: Request, res: Response) => {
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
  app.put("/api/workspaces/:id/policy", ...workspaceOwner, async (req: Request, res: Response) => {
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
  app.get("/api/workspaces/:id/inventory", ...workspaceMember, async (req: Request, res: Response) => {
    const { id } = req.params;
    const invRes = await query(
      "SELECT * FROM inventory_items WHERE workspace_id = $1 ORDER BY sku ASC;",
      [id]
    );
    res.json(invRes.rows);
  });

  app.post("/api/workspaces/:id/inventory", ...workspaceMember, async (req: Request, res: Response) => {
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
  app.post("/api/workspaces/:id/replenish", ...workspaceMember, async (req: Request, res: Response) => {
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
  app.get("/api/workspaces/:id/approvals", ...workspaceMember, async (req: Request, res: Response) => {
    const { id } = req.params;
    await procurementRunner.expireApprovals({ workspaceId: id });
    const apprRes = await query(
      "SELECT * FROM approvals WHERE workspace_id = $1 ORDER BY created_at DESC;",
      [id]
    );
    res.json(apprRes.rows);
  });

  app.post("/api/approvals/:id/approve", ...anyWorkspaceOwner, async (req: Request, res: Response) => {
    const { id } = req.params;
    const actor = req.actor!;
    try {
      const result = await procurementRunner.approveAndSubmit(id, decidedByOf(actor.label), actor.workspaceId);
      res.json(result);
    } catch (err: any) {
      sendApprovalError(res, err);
    }
  });

  app.post("/api/approvals/:id/reject", ...anyWorkspaceOwner, async (req: Request, res: Response) => {
    const { id } = req.params;
    const actor = req.actor!;
    const { reason } = req.body;
    try {
      const result = await procurementRunner.declineApproval(
        id,
        "rejected",
        decidedByOf(actor.label),
        actor.workspaceId,
        reason
      );
      res.json({ status: "rejected", approvalId: id, ...result });
    } catch (err: any) {
      sendApprovalError(res, err);
    }
  });

  app.post("/api/approvals/:id/revoke", ...anyWorkspaceOwner, async (req: Request, res: Response) => {
    const { id } = req.params;
    const actor = req.actor!;
    const { reason } = req.body;
    try {
      const result = await procurementRunner.declineApproval(
        id,
        "revoked",
        decidedByOf(actor.label),
        actor.workspaceId,
        reason
      );
      res.json({ status: "revoked", approvalId: id, ...result });
    } catch (err: any) {
      sendApprovalError(res, err);
    }
  });

  // Fulfill and Reconcile Order
  app.post("/api/orders/:id/reconcile", ...anyWorkspaceOwner, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const result = await procurementRunner.fulfillAndReconcile(id, req.actor!.workspaceId);
      res.json(result);
    } catch (err: any) {
      if (err instanceof SettlementOrderError) {
        const status = err.code === "ORDER_NOT_FOUND" ? 404 : 409;
        res.status(status).json({ error: err.message, code: err.code });
        return;
      }
      res.status(400).json({ error: err.message });
    }
  });

  // Confirm a payment that was sent but not yet confirmed (settlement_submitted)
  app.post("/api/orders/:id/confirm-settlement", ...anyWorkspaceOwner, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const result = await procurementRunner.confirmSettlement(id, req.actor!.workspaceId);
      res.json(result);
    } catch (err: any) {
      if (err instanceof SettlementOrderError) {
        const status = err.code === "ORDER_NOT_FOUND" ? 404 : 409;
        res.status(status).json({ error: err.message, code: err.code });
        return;
      }
      res.status(400).json({ error: err.message });
    }
  });

  // Customer orders (Task 8a, ADR 0026). Creating and reading are member routes; the order is decided as the fulfilment
  // agent. Accepting a held order is owner-only. Cancel and fulfil are member routes, and staff may use them.
  app.get("/api/workspaces/:id/customer-orders", ...workspaceMember, async (req: Request, res: Response) => {
    try {
      res.json(await listCustomerOrders(req.params.id));
    } catch (err) {
      sendFulfilmentError(res, err);
    }
  });

  app.post("/api/workspaces/:id/customer-orders", ...workspaceMember, async (req: Request, res: Response) => {
    const { id } = req.params;
    let body: z.infer<typeof CustomerOrderBodySchema>;
    try {
      body = CustomerOrderBodySchema.parse(req.body);
    } catch (err) {
      return sendFulfilmentError(res, err);
    }
    try {
      const result = await acceptCustomerOrder(
        {
          workspaceId: id,
          externalRef: body.externalRef,
          lines: body.lines,
          requestedFor: body.requestedFor ? new Date(body.requestedFor) : undefined,
          note: body.note,
        },
        { kind: "agent", roleName: "fulfilment_agent" }
      );
      res.status(result.replayed ? 200 : 201).json(result);
    } catch (err) {
      sendFulfilmentError(res, err);
    }
  });

  app.get("/api/workspaces/:id/customer-orders/:orderId", ...workspaceMember, async (req: Request, res: Response) => {
    try {
      const order = await getCustomerOrder(req.params.id, req.params.orderId);
      if (!order) return res.status(404).json({ error: "Order not found", code: "ORDER_NOT_FOUND" });
      res.json(order);
    } catch (err) {
      sendFulfilmentError(res, err);
    }
  });

  app.post("/api/workspaces/:id/customer-orders/:orderId/accept", ...workspaceOwner, async (req: Request, res: Response) => {
    try {
      res.json(await acceptHeldOrder(req.params.id, req.params.orderId, req.actor!.label));
    } catch (err) {
      sendFulfilmentError(res, err);
    }
  });

  app.post("/api/workspaces/:id/customer-orders/:orderId/cancel", ...workspaceMember, async (req: Request, res: Response) => {
    try {
      const actor: OperatorActor = { kind: req.actor!.role, label: req.actor!.label };
      res.json(await cancelCustomerOrder(req.params.id, req.params.orderId, actor));
    } catch (err) {
      sendFulfilmentError(res, err);
    }
  });

  app.post("/api/workspaces/:id/customer-orders/:orderId/fulfil", ...workspaceMember, async (req: Request, res: Response) => {
    try {
      const actor: OperatorActor = { kind: req.actor!.role, label: req.actor!.label };
      res.json(await fulfilCustomerOrder(req.params.id, req.params.orderId, actor));
    } catch (err) {
      sendFulfilmentError(res, err);
    }
  });

  app.get("/api/workspaces/:id/kitchen-capacity", ...workspaceMember, async (req: Request, res: Response) => {
    try {
      res.json(await listKitchenCapacity(req.params.id));
    } catch (err) {
      sendFulfilmentError(res, err);
    }
  });

  app.put("/api/workspaces/:id/kitchen-capacity", ...workspaceOwner, async (req: Request, res: Response) => {
    let body: z.infer<typeof KitchenCapacityBodySchema>;
    try {
      body = KitchenCapacityBodySchema.parse(req.body);
    } catch (err) {
      return sendFulfilmentError(res, err);
    }
    try {
      const slots = body.slots.map((slot) => ({
        startsAt: new Date(slot.startsAt),
        endsAt: new Date(slot.endsAt),
        capacityUnits: slot.capacityUnits,
      }));
      res.json(await setKitchenCapacity(req.params.id, slots, { kind: "owner", label: req.actor!.label }));
    } catch (err) {
      sendFulfilmentError(res, err);
    }
  });

  // Workflows
  app.get("/api/workspaces/:id/workflows", ...workspaceMember, async (req: Request, res: Response) => {
    const { id } = req.params;
    const wfRes = await query(
      "SELECT * FROM workflows WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 50;",
      [id]
    );
    res.json(wfRes.rows);
  });

  // Orders & 3-Way Match Status
  app.get("/api/workspaces/:id/orders", ...workspaceMember, async (req: Request, res: Response) => {
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
  app.get("/api/workspaces/:id/suppliers", ...workspaceMember, async (req: Request, res: Response) => {
    const { id } = req.params;
    const suppRes = await query(
      "SELECT * FROM suppliers WHERE workspace_id = $1 ORDER BY name ASC;",
      [id]
    );
    res.json(suppRes.rows);
  });

  app.post("/api/workspaces/:id/suppliers", ...workspaceOwner, async (req: Request, res: Response) => {
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
  app.get("/api/workspaces/:id/agents", ...workspaceMember, async (req: Request, res: Response) => {
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

  app.post("/api/workspaces/:id/agents", ...workspaceOwner, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      // Recorded under the owner token label (ADR 0023).
      const result = await upsertAgentRole(id, req.body, { type: "owner", id: req.actor!.label });
      res.status(201).json(result);
    } catch (err: any) {
      if (err instanceof ForbiddenCapabilityError) {
        return res.status(400).json({ error: err.message, code: "FORBIDDEN_CAPABILITY" });
      }
      res.status(400).json({ error: err.message });
    }
  });

  // Flow C: Messaging Surfaces & Identity Bindings
  app.get("/api/workspaces/:id/surfaces", ...workspaceMember, async (req: Request, res: Response) => {
    const { id } = req.params;
    const bindings = await listSurfaceBindings(id);
    res.json(bindings);
  });

  app.post("/api/workspaces/:id/surfaces", ...workspaceOwner, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      const binding = await upsertSurfaceBinding(id, req.body, { type: "owner", id: decidedByOf(req.actor!.label) });
      res.status(201).json(binding);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Flow D: Two-Stage Document Extract -> Confirm & Accounting Ledger
  app.get("/api/workspaces/:id/documents", ...workspaceMember, async (req: Request, res: Response) => {
    const { id } = req.params;
    const docs = await listStagedDocuments(id);
    res.json(docs);
  });

  app.post("/api/workspaces/:id/documents/extract", ...workspaceMember, async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
      // Recorded under the token label and its role, so a staff extraction is not shown as an owner's (ADR 0023).
      const draft = await extractDocumentDraft(id, req.body, { type: req.actor!.role, id: req.actor!.label });
      res.status(201).json(draft);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/api/workspaces/:id/documents/:docId/confirm", ...workspaceOwner, async (req: Request, res: Response) => {
    const { id, docId } = req.params;
    try {
      // The confirming owner is the token label. The body's decidedBy is ignored (ADR 0021, ADR 0022).
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const confirmed = await confirmStagedDocument(id, docId, {
        ...body,
        decidedBy: decidedByOf(req.actor!.label),
      });
      res.json(confirmed);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get("/api/workspaces/:id/accounting/ledger", ...workspaceMember, async (req: Request, res: Response) => {
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
  app.get("/api/workspaces/:id/audit", ...workspaceMember, async (req: Request, res: Response) => {
    const { id } = req.params;
    const auditRes = await query(
      "SELECT * FROM audit_logs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100;",
      [id]
    );
    res.json(auditRes.rows);
  });

  // Crash Recovery
  app.post("/api/workspaces/:id/recover", ...workspaceOwner, async (req: Request, res: Response) => {
    try {
      const report = await recoveryRunner.recoverInterruptedWorkflows({ workspaceId: req.params.id });
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Access tokens (owner only). The plaintext token is in the create response only.
  app.post("/api/workspaces/:id/tokens", ...workspaceOwner, async (req: Request, res: Response) => {
    const { id } = req.params;
    const actor = req.actor!;
    try {
      const issued = await issueToken(id, req.body?.role as WorkspaceRole, req.body?.label, {
        type: "owner",
        id: actor.label,
      });
      res.status(201).json({ id: issued.id, role: issued.role, label: issued.label, token: issued.token });
    } catch (err) {
      sendTokenError(res, err);
    }
  });

  app.get("/api/workspaces/:id/tokens", ...workspaceOwner, async (req: Request, res: Response) => {
    try {
      res.json(await listTokens(req.params.id));
    } catch (err) {
      sendTokenError(res, err);
    }
  });

  app.delete("/api/workspaces/:id/tokens/:tokenId", ...workspaceOwner, async (req: Request, res: Response) => {
    const { id, tokenId } = req.params;
    const actor = req.actor!;
    try {
      const revoked = await revokeToken(id, tokenId, { type: "owner", id: actor.label });
      res.json(revoked);
    } catch (err) {
      sendTokenError(res, err);
    }
  });

  // Owner pause switch (ADR 0022). While paused, the commitment gate denies every commitment and no replenishment starts.
  app.put("/api/workspaces/:id/agents-paused", ...workspaceOwner, async (req: Request, res: Response) => {
    const { id } = req.params;
    const paused = req.body?.paused;
    if (typeof paused !== "boolean") {
      return res.status(400).json({ error: "paused must be true or false." });
    }
    try {
      const stored = await setAgentsPaused(id, paused, { type: "owner", id: decidedByOf(req.actor!.label) }, "owner_api");
      if (stored === null) return res.status(404).json({ error: "Workspace not found" });
      res.json({ workspaceId: id, paused: stored });
    } catch {
      res.status(500).json({ error: "Pause could not be recorded" });
    }
  });

  // Webhook signing secret (owner only, ADR 0022). The secret is derived from the master secret and the version.
  app.get("/api/workspaces/:id/webhook-secret", ...workspaceOwner, async (req: Request, res: Response) => {
    if (!masterSecret) return res.status(503).json(WEBHOOK_NOT_CONFIGURED);
    res.setHeader("Cache-Control", "no-store");
    try {
      const shown = await viewWebhookSecret(req.params.id, masterSecret, { type: "owner", id: decidedByOf(req.actor!.label) });
      if (shown === null) return res.status(404).json({ error: "Workspace not found" });
      res.json(shown);
    } catch {
      res.status(500).json({ error: "Webhook secret unavailable" });
    }
  });

  app.post("/api/workspaces/:id/webhook-secret/rotate", ...workspaceOwner, async (req: Request, res: Response) => {
    if (!masterSecret) return res.status(503).json(WEBHOOK_NOT_CONFIGURED);
    res.setHeader("Cache-Control", "no-store");
    try {
      const rotated = await rotateWebhookSecret(req.params.id, masterSecret, { type: "owner", id: decidedByOf(req.actor!.label) });
      if (rotated === null) return res.status(404).json({ error: "Workspace not found" });
      res.json(rotated);
    } catch {
      res.status(500).json({ error: "Webhook secret could not be rotated" });
    }
  });

  // Connector credentials (owner only, ADR 0024). A secret is accepted once, encrypted at rest, and never returned: every
  // response is a summary. The store is disabled (503) until BIND_CREDENTIAL_KEY is configured.
  app.get("/api/workspaces/:id/connectors", ...workspaceOwner, async (req: Request, res: Response) => {
    try {
      res.json(await listConnectors(req.params.id));
    } catch (err) {
      sendCredentialError(res, err);
    }
  });

  app.put("/api/workspaces/:id/connectors/:connectorId", ...workspaceOwner, async (req: Request, res: Response) => {
    try {
      const summary = await setCredential({
        workspaceId: req.params.id,
        connectorId: req.params.connectorId,
        kind: req.body?.kind,
        secret: req.body?.secret,
        actor: credentialActorOf(req),
      });
      res.json(summary);
    } catch (err) {
      sendCredentialError(res, err);
    }
  });

  app.delete("/api/workspaces/:id/connectors/:connectorId", ...workspaceOwner, async (req: Request, res: Response) => {
    try {
      const revoked = await revokeCredential(req.params.id, req.params.connectorId, credentialActorOf(req));
      if (revoked === null) return res.status(404).json({ error: "Connector credential not found" });
      res.json(revoked);
    } catch (err) {
      sendCredentialError(res, err);
    }
  });

  app.post("/api/workspaces/:id/connectors/:connectorId/verify", ...workspaceOwner, async (req: Request, res: Response) => {
    try {
      res.json(await verifyCredential(req.params.id, req.params.connectorId, credentialActorOf(req)));
    } catch (err) {
      sendCredentialError(res, err);
    }
  });

  // Inbound Webhooks (Standard and Social/POS Surface). Every request is authenticated before anything is recorded.
  // A surface event is checked in this order: schema, workspace exists, signature for that workspace, replay, binding.
  // A standard event is checked: signature with the configured secret, then its fields. See docs/decisions/0022.
  app.post("/api/webhooks/incoming", async (req: Request, res: Response) => {
    try {
      const surfaceParsed = SocialSurfaceEventSchema.safeParse(req.body);
      if (surfaceParsed.success) {
        return await handleSurfaceEvent(req, res, surfaceParsed.data);
      }
      return await handleStandardWebhook(req, res);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ error: "Webhook could not be processed" });
      }
    }
  });

  async function handleSurfaceEvent(req: Request, res: Response, event: SocialSurfaceEvent) {
    // (2) The workspace must exist. An unknown one gets the same 401 as a bad signature, so existence is not revealed.
    const wsRes = await query(`SELECT webhook_secret_version FROM workspaces WHERE id = $1;`, [event.workspaceId]);
    if (wsRes.rows.length === 0) {
      return res.status(401).json(WEBHOOK_UNAUTHORIZED);
    }

    // (3) Signed over the raw body with this workspace's secret at its current version. No master secret: nothing runs.
    if (!masterSecret) {
      return res.status(503).json(WEBHOOK_NOT_CONFIGURED);
    }
    const secret = workspaceWebhookSecret(masterSecret, event.workspaceId, Number(wsRes.rows[0].webhook_secret_version));
    if (!requestSignatureValid(req, secret)) {
      return res.status(401).json(WEBHOOK_UNAUTHORIZED);
    }

    // (4) Replay. Only a verified request reaches this insert, so an unsigned request cannot use up an event id.
    // The provider names the workspace and the surface, so the same event id in two workspaces is two events.
    const recorded = await query(
      `INSERT INTO inbound_webhooks (id, provider, event_id, payload, status, received_at)
       VALUES ($1, $2, $3, $4::jsonb, 'received', NOW())
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id;`,
      [newId("wh"), `surface:${event.workspaceId}:${event.surface}`, event.eventId, JSON.stringify(event)]
    );
    if ((recorded.rowCount ?? 0) === 0) {
      return res.json({ status: "duplicate", eventId: event.eventId });
    }

    // (5) The actor must be bound in this workspace. The role comes from the binding, never from the payload.
    // Only an authorization refusal is answered here. Anything else (a storage failure) goes to the generic 500.
    let authMeta: { effectiveRole: "owner" | "staff"; bindingStatus: string };
    try {
      authMeta = await verifyAndAuthorizeSurfaceEvent(event);
    } catch (err: any) {
      if (err instanceof SurfaceAuthorizationError) {
        return res.status(403).json({ error: err.message });
      }
      throw err;
    }

    // The surface actor, recorded as the decider of any approval or pause change it makes.
    const surfaceActor = `surface:${event.surface}:${event.actorId}`;

    if (event.eventType === "SURFACE_STOCK_OBSERVED") {
      const itemRes = await query(
        `UPDATE inventory_items
         SET current_quantity = $1, updated_at = NOW()
         WHERE workspace_id = $2 AND sku = $3
         RETURNING *;`,
        [event.observedQuantity, event.workspaceId, event.sku]
      );
      const item = itemRes.rows[0];
      // The count is a fact and is kept above. While the workspace is paused (ADR 0023) the replenishment it would
      // start is skipped, not refused: the event is answered 200 and says why.
      const pauseRes = await query(`SELECT agents_paused FROM workspaces WHERE id = $1;`, [event.workspaceId]);
      const paused = pauseRes.rows[0]?.agents_paused === true;
      let replenishmentResult = null;
      let replenishmentSkipped: "AGENTS_PAUSED" | undefined;
      if (item && Number(item.current_quantity) < Number(item.par_level)) {
        if (paused) {
          replenishmentSkipped = "AGENTS_PAUSED";
        } else {
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
        ...(replenishmentSkipped ? { replenishmentSkipped } : {}),
      });
    }

    if (event.eventType === "SURFACE_OWNER_APPROVAL_DECISION") {
      if (event.decision === "approve") {
        try {
          const result = await procurementRunner.approveAndSubmit(event.approvalId, surfaceActor, event.workspaceId);
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
            surfaceActor,
            event.workspaceId,
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
      const stored = await setAgentsPaused(event.workspaceId, event.paused, { type: "owner", id: surfaceActor }, "surface");
      return res.json({
        status: "processed",
        eventType: event.eventType,
        effectiveRole: authMeta.effectiveRole,
        bindingStatus: authMeta.bindingStatus,
        workspaceId: event.workspaceId,
        paused: stored,
      });
    }

    return res.status(400).json({ error: "Unsupported surface event" });
  }

  async function handleStandardWebhook(req: Request, res: Response) {
    // (1) Authentication before any field is read. No secret configured: 503, nothing processed.
    if (!webhookSecret) {
      return res.status(503).json(WEBHOOK_NOT_CONFIGURED);
    }
    if (!requestSignatureValid(req, webhookSecret)) {
      return res.status(401).json(WEBHOOK_UNAUTHORIZED);
    }

    // (2) The fields. No fallback id is invented, so a missing one can never be processed twice by accident.
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { provider, eventId, payload } = body;
    const isText = (value: unknown): value is string =>
      typeof value === "string" && value.trim().length > 0 && value.length <= 200;
    if (!isText(provider) || !isText(eventId)) {
      return res.status(400).json({ error: "provider and eventId are required" });
    }

    const timestamp = Number(req.headers["x-bind-timestamp"]);
    const { retryable, ...outcome } = await receiver.processEvent({
      provider,
      eventId,
      timestamp,
      payload: (payload ?? body) as Record<string, any>,
    });
    // A storage failure is retryable (503). The stored reason is generic, never the database's own text.
    res.status(retryable ? 503 : 200).json(outcome);
  }

  // Default SPA route (supports /, /app, /app/workflows/:workflowId)
  app.get("*", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.sendFile(path.resolve(staticPath, "index.html"));
  });

  return app;
}
