import type { NextFunction, Request, Response } from "express";
import { IDEMPOTENT_ROUTES } from "./idempotency.js";

/**
 * `_meta` on the responses of the 18 command operations (ADR 0050, docs/ecosystem/spec/response-meta-v1.schema.json).
 * It is added next to the existing fields; nothing moves and the HTTP status does not change. `status` is the outcome of the
 * request in one vocabulary: completed (done and recorded), accepted (started, not finished), held (waiting for a person) or
 * refused (a rule said no). `nextActions` lists only what the caller's own role may do now.
 *
 * It is derived from the response body by code, never from model text, and holds ids, state names and fixed labels only.
 */

export type MetaStatus = "completed" | "accepted" | "held" | "refused";
export interface MetaAction {
  id: string;
  label: string;
  actor: "owner" | "staff" | "agent" | "system";
  method: "GET" | "POST" | "PUT" | "DELETE";
  href?: string;
  needsConfirmation?: boolean;
}
export interface ResponseMeta {
  requestId: string;
  status: MetaStatus;
  state?: string;
  processing?: { remaining?: string[]; poll?: string; events?: string };
  nextActions?: MetaAction[];
  warnings?: { code: string; message: string }[];
  links?: Record<string, string>;
}

export interface Context {
  workspaceId: string;
  role: "owner" | "staff";
  body: Record<string, unknown>;
  params: Record<string, string>;
}
type Derived = Omit<ResponseMeta, "requestId">;

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const eventsPath = (ws: string): string => `/api/workspaces/${ws}/events`;

function ownerOnly(ctx: Context, actions: MetaAction[]): MetaAction[] {
  return ctx.role === "owner" ? actions : [];
}

/** A procurement workflow state, as the replenish, approve and cancel answers name it. */
function workflowStatus(state: string | undefined): { status: MetaStatus; remaining?: string[] } {
  switch (state) {
    case "awaiting_approval":
      return { status: "held", remaining: ["owner_decision", "supplier_order", "settlement"] };
    case "failed":
    case "cancelled":
      return { status: "refused" };
    case "reconciled":
    case "confirmed":
      return { status: "completed" };
    default:
      return { status: "accepted", remaining: ["supplier_confirmation", "settlement"] };
  }
}

/** Links to the single-resource reads, for the ids the answer names. */
function procurementLinks(ctx: Context): Record<string, string> | undefined {
  const base = `/api/workspaces/${ctx.workspaceId}`;
  const links: Record<string, string> = {};
  const workflowId = str(ctx.body.workflowId);
  const orderId = str(ctx.body.orderId);
  const approvalId = str(ctx.body.approvalId);
  if (workflowId) links.workflow = `${base}/workflows/${workflowId}`;
  if (orderId) links.order = `${base}/orders/${orderId}`;
  if (approvalId) links.approval = `${base}/approvals/${approvalId}`;
  return Object.keys(links).length > 0 ? links : undefined;
}

function procurement(ctx: Context): Derived {
  const state = str(ctx.body.state);
  const { status, remaining } = workflowStatus(state);
  const approvalId = str(ctx.body.approvalId);
  const meta: Derived = { status, ...(state ? { state } : {}) };
  const links = procurementLinks(ctx);
  if (links) meta.links = links;
  if (remaining) {
    meta.processing = { remaining, events: eventsPath(ctx.workspaceId) };
    // Asynchronous work is observed by reading its workflow, never by guessing from a flag.
    if (links?.workflow) meta.processing.poll = links.workflow;
  }
  if (status === "held" && approvalId) {
    meta.nextActions = ownerOnly(ctx, [
      { id: "approve", label: "Approve the order", actor: "owner", method: "POST", href: `/api/approvals/${approvalId}/approve`, needsConfirmation: true },
      { id: "reject", label: "Reject the order", actor: "owner", method: "POST", href: `/api/approvals/${approvalId}/reject` },
    ]);
  }
  return meta;
}

function customerOrder(ctx: Context): Derived {
  const state = str(ctx.body.status);
  const orderId = str(ctx.body.orderId);
  const base = `/api/workspaces/${ctx.workspaceId}/customer-orders/${orderId ?? ""}`;
  const cancel: MetaAction = { id: "cancel", label: "Cancel the order", actor: ctx.role, method: "POST", href: `${base}/cancel`, needsConfirmation: true };
  const meta: Derived = { status: "completed", ...(state ? { state } : {}) };
  if (!orderId) return meta;
  meta.links = { order: base };
  if (state === "needs_owner") {
    meta.status = "held";
    meta.nextActions =
      ctx.role === "owner"
        ? [{ id: "accept", label: "Accept the order", actor: "owner", method: "POST", href: `${base}/accept`, needsConfirmation: true }, cancel]
        : [cancel];
  } else if (state === "declined") {
    meta.status = "refused";
  } else if (state === "accepted" || state === "partially_available") {
    meta.nextActions = [{ id: "fulfil", label: "Mark the order fulfilled", actor: ctx.role, method: "POST", href: `${base}/fulfil`, needsConfirmation: true }, cancel];
  }
  return meta;
}

function approvalDecision(ctx: Context): Derived {
  const decision = str(ctx.body.status);
  const meta: Derived = { status: "completed", ...(decision ? { state: decision } : {}) };
  return meta;
}

function approve(ctx: Context): Derived {
  const meta = procurement(ctx);
  // A transfer that may or may not have gone out is never reported as done.
  if (ctx.body.inDoubt === true) {
    meta.status = "accepted";
    meta.warnings = [{ code: "SETTLEMENT_OUTCOME_UNKNOWN", message: "The payment may or may not have gone out. It is not reported as done and will not be sent again." }];
  }
  return meta;
}

function recorded(stateKey: string): (ctx: Context) => Derived {
  return (ctx) => {
    const state = str(ctx.body[stateKey]);
    return { status: "completed", ...(state ? { state } : {}) };
  };
}

const DERIVE: Readonly<Record<string, (ctx: Context) => Derived>> = {
  "POST /api/workspaces/:id/replenish": procurement,
  "POST /api/approvals/:id/approve": approve,
  "POST /api/approvals/:id/reject": approvalDecision,
  "POST /api/approvals/:id/revoke": approvalDecision,
  "POST /api/workspaces/:id/workflows/:workflowId/cancel": recorded("state"),
  "POST /api/workspaces/:id/customer-orders": customerOrder,
  "POST /api/workspaces/:id/customer-orders/:orderId/accept": customerOrder,
  "POST /api/workspaces/:id/customer-orders/:orderId/cancel": customerOrder,
  "POST /api/workspaces/:id/customer-orders/:orderId/fulfil": customerOrder,
  "POST /api/workspaces/:id/menu-proposals/:proposalId/publish": recorded("status"),
  "POST /api/workspaces/:id/documents/:docId/confirm": recorded("status"),
};

/** The `_meta` for one answer. Pure: the same inputs give the same output. */
export function buildMeta(operation: string, ctx: Context, requestId: string, keySent: boolean): ResponseMeta {
  const derive = DERIVE[operation] ?? (() => ({ status: "completed" as const }));
  const derived = derive(ctx);
  const warnings: { code: string; message: string }[] = [...(derived.warnings ?? [])];
  if (!keySent) {
    warnings.push({ code: "IDEMPOTENCY_KEY_MISSING", message: "Send an Idempotency-Key header so a retry cannot repeat this command." });
  }
  if (derived.status === "held" && (derived.nextActions?.length ?? 0) === 0) {
    warnings.push({ code: "OWNER_DECISION_NEEDED", message: "An owner decides this next. Your role cannot." });
  }
  const meta: ResponseMeta = { requestId, ...derived };
  if (warnings.length > 0) meta.warnings = warnings;
  else delete meta.warnings;
  if (meta.nextActions && meta.nextActions.length === 0) delete meta.nextActions;
  return meta;
}

/** Adds `_meta` to a 2xx JSON object answer of a command operation. Other answers pass through untouched. */
export function responseMeta(req: Request, res: Response, next: NextFunction): void {
  const operation = `${req.method} ${req.route?.path ?? ""}`;
  if (!IDEMPOTENT_ROUTES.has(operation) || !req.actor) {
    next();
    return;
  }
  const send = res.json.bind(res);
  const actor = req.actor;
  res.json = ((body: unknown) => {
    const ok = res.statusCode >= 200 && res.statusCode < 300;
    if (!ok || body === null || typeof body !== "object" || Array.isArray(body) || "_meta" in (body as object)) return send(body);
    const requestId = String(req.id ?? res.getHeader("x-request-id") ?? "");
    const ctx = { workspaceId: actor.workspaceId, role: actor.role, body: body as Record<string, unknown>, params: req.params };
    return send({ ...(body as object), _meta: buildMeta(operation, ctx, requestId, req.headers["idempotency-key"] !== undefined) });
  }) as Response["json"];
  next();
}
