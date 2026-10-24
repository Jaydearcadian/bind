/**
 * The route registry: one entry for every route in createApp (docs/decisions/0034). It is the single source for the
 * OpenAPI document (src/api/openapi.ts, docs/openapi.json), for the route-level validation the contract tests send, and for
 * the access level a reviewer reads. A route added without an entry fails tests/integration/api-contract.test.ts.
 *
 * `access` says what the middleware in src/auth/middleware.ts applies, and the contract test checks it against the server:
 * public (no token), authenticated (any valid token), member (owner or staff of the workspace in the path), owner (owner of
 * the workspace in the path), owner-any (owner of the workspace the approval or order belongs to; checked by the service),
 * metrics-token (BIND_METRICS_TOKEN), signed-webhook (an HMAC signature over the raw body; ADR 0022).
 *
 * Generic errors (400 for malformed input, 401, 403, 404, 413, 429, 500, 503) are added from the access level and the
 * route's inputs (see `withGenericErrors`). A route lists its success responses and its own error responses.
 */
import { z } from "zod";
import {
  TabChargeBodySchema,
  TabChargeResultSchema,
  TabDetailSchema,
  TabHeldSettlementSchema,
  TabResolveBodySchema,
  TabResolveResultSchema,
  TabSettleResultSchema,
  TabSummarySchema,
  AgentRoleUpsertResultSchema,
  AgentRoleUpsertSchema,
  AgentsListSchema,
  ApprovalApproveResultSchema,
  ApprovalDecisionResultSchema,
  ApprovalDecisionBodySchema,
  ApprovalSchema,
  AuditEntrySchema,
  CancelWorkflowBodySchema,
  ConfirmDocumentBodySchema,
  ConnectorSetBodySchema,
  ConnectorSummarySchema,
  ConnectorVerifySchema,
  CreateWorkspaceBodySchema,
  CustomerOrderBodySchema,
  CustomerOrderDecisionSchema,
  CustomerOrderSchema,
  DocumentConfirmSchema,
  DocumentDraftSchema,
  DemoCreatedSchema,
  AccountWorkspaceCreatedSchema,
  AccountWorkspaceSchema,
  ErrorBody,
  NotificationChannelsSchema,
  OwnerEmailRemovedSchema,
  OwnerEmailRequestBodySchema,
  OwnerEmailRequestedSchema,
  OwnerEmailVerifiedSchema,
  OwnerEmailVerifyBodySchema,
  InviteAcceptBodySchema,
  InviteCreateBodySchema,
  InviteIssuedSchema,
  InviteRevokedSchema,
  InviteSummarySchema,
  MeSchema,
  MemberRemovedSchema,
  MemberRoleBodySchema,
  MemberSchema,
  SessionCreateBodySchema,
  SessionIssuedSchema,
  SignedOutSchema,
  EventPollQuerySchema,
  EventPollSchema,
  EventStreamQuerySchema,
  ExtractDocumentInputSchema,
  FeedbackBodySchema,
  FeedbackIngestSchema,
  FeedbackItemSchema,
  FeedbackSummaryQuerySchema,
  FeedbackSummarySchema,
  HealthSchema,
  InitialSupplyItemSchema,
  InventoryItemSchema,
  KitchenCapacityBodySchema,
  KitchenSlotSchema,
  LedgerEntrySchema,
  LedgerQuerySchema,
  MenuItemSchema,
  MenuProposalBodySchema,
  MenuProposalSchema,
  NeedsAttentionSchema,
  OnboardResultSchema,
  OnboardWorkspaceSchema,
  OpenApiDocumentSchema,
  OrderSchema,
  PauseBodySchema,
  PauseResultSchema,
  PolicyBodySchema,
  PolicyUpdateSchema,
  PublicConfigSchema,
  ReadySchema,
  RecoveryReportSchema,
  ReconcileResultSchema,
  ReplenishBodySchema,
  ReplenishResultSchema,
  StagedDocumentSchema,
  StandardWebhookResultSchema,
  SupplierBodySchema,
  SupplierSchema,
  SurfaceBindingSchema,
  SurfaceBindingUpsertSchema,
  SurfaceEventResultSchema,
  TemplateBlueprintSchema,
  TemplateSummarySchema,
  TokenCreateBodySchema,
  TokenIssuedSchema,
  TokenRevokedSchema,
  TokenSummarySchema,
  WebhookBodySchema,
  WebhookSecretSchema,
  WorkflowCancelResultSchema,
  WorkflowSchema,
  WorkspaceCreateResultSchema,
  WorkspaceDetailSchema,
  WorkspaceRowSchema,
} from "./schemas.js";

export type AccessLevel =
  | "public"
  | "authenticated"
  | "member"
  | "owner"
  | "owner-any"
  | "account"
  | "metrics-token"
  | "signed-webhook";

export interface ResponseSpec {
  description: string;
  schema?: z.ZodTypeAny;
  contentType?: "application/json" | "text/csv" | "text/plain" | "text/html" | "text/event-stream";
}

export interface RouteSpec {
  operationId: string;
  method: "get" | "post" | "put" | "delete" | "patch";
  /** Express style, for example /api/workspaces/:id/inventory. */
  path: string;
  access: AccessLevel;
  tags: string[];
  summary: string;
  params?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  body?: z.ZodTypeAny;
  responses: Record<number, ResponseSpec>;
  /** A valid example body, posted by the contract test where its preconditions are safe. */
  sampleBody?: unknown;
  contractTested: boolean;
  notTestedReason?: string;
}

/** A 4xx or 5xx whose body is the standard error shape. */
const err = (description: string): ResponseSpec => ({ description, schema: ErrorBody });
const ok = (description: string, schema?: z.ZodTypeAny): ResponseSpec => ({ description, schema });
const list = (schema: z.ZodTypeAny) => z.array(schema);

/** Routes that the monitoring probes and the UI catch-all do not get the generic error set. */
const NO_GENERIC_ERRORS = new Set(["/health", "/ready", "*"]);

/**
 * Adds the errors a route can produce from its access level and inputs. A route's own response for a status wins.
 * The statuses here come from src/auth/middleware.ts, src/server/errors.ts and src/security/rate-limit-middleware.ts.
 */
function withGenericErrors(entry: Omit<RouteSpec, "responses"> & { responses: Record<number, ResponseSpec> }): RouteSpec {
  const generic: Record<number, ResponseSpec> = {};
  if (!NO_GENERIC_ERRORS.has(entry.path)) {
    generic[400] = err("Malformed JSON, a NUL character in the input, or a field that fails validation (see the route for its own message).");
    generic[429] = err("Too many requests: the per-client or per-token limit is reached. Retry-After is set (ADR 0033).");
    generic[500] = err("An unexpected failure. The detail is logged with the request id, never returned.");
  }
  if (entry.access !== "public") {
    generic[401] = err("Authentication required: the token is missing, malformed, unknown or revoked (or the webhook signature is refused).");
  }
  if (entry.access === "account") {
    generic[503] = err("Sign-in is not configured on this server (no Privy app), or the account store is unavailable.");
  }
  if (entry.access === "owner" || entry.access === "owner-any") {
    generic[403] = err("Owner role required.");
  }
  if (entry.body !== undefined) {
    generic[413] = err("Request body too large (over 256 kB).");
  }
  if (entry.access === "authenticated" || entry.access === "member" || entry.access === "owner" || entry.access === "owner-any") {
    generic[503] = err("Authentication is unavailable (the token lookup failed). Retry later.");
  }
  if ((entry.access === "member" || entry.access === "owner") && entry.path.startsWith("/api/workspaces/:id")) {
    generic[404] = err("Workspace not found. The same body answers a workspace that does not exist and one that belongs to another tenant.");
  }
  return { ...entry, responses: { ...generic, ...entry.responses } };
}

/** Why the UI catch-all has no contract test. */
const CONTRACT_NOT_TESTED_UI =
  "The catch-all serves the website's not-found page (ADR 0054). It is not an API route and has no JSON schema; its access is checked by the access test and its page by tests/web.";

export const ROUTES: RouteSpec[] = [
  // -------------------------------------------------------------------------------------------------------------------
  // Monitoring and public catalogue
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "getHealth",
    method: "get",
    path: "/health",
    access: "public",
    tags: ["Monitoring"],
    summary: "Liveness: the process answers and the database responds. Carries no data.",
    responses: {
      200: ok("Alive, and the database answered.", HealthSchema),
      500: { description: "The database did not answer. Only the status is returned; the cause is logged.", schema: z.object({ status: z.literal("error") }).passthrough() },
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getReady",
    method: "get",
    path: "/ready",
    access: "public",
    tags: ["Monitoring"],
    summary: "Readiness: the database answers within the budget and the schema is present.",
    responses: {
      200: ok("Ready to take traffic.", ReadySchema),
      503: { description: "Not ready. No detail is returned.", schema: z.object({ status: z.literal("not_ready") }).passthrough() },
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getPublicConfig",
    method: "get",
    path: "/api/public-config",
    access: "public",
    tags: ["Monitoring"],
    summary: "The public browser configuration: the Privy app id for sign-in, or null. Nothing secret (ADR 0070).",
    responses: { 200: ok("Public configuration. Never cached.", PublicConfigSchema) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getMetrics",
    method: "get",
    path: "/metrics",
    access: "metrics-token",
    tags: ["Monitoring"],
    summary: "Prometheus metrics: aggregate counts only (ADR 0032).",
    responses: {
      200: ok("Prometheus text exposition.", undefined),
      404: err("No metrics token is configured, so the route is disabled."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "listTemplates",
    method: "get",
    path: "/api/templates",
    access: "public",
    tags: ["Templates"],
    summary: "The reference templates a workspace can start from.",
    responses: { 200: ok("Template catalogue.", list(TemplateSummarySchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getTemplateBlueprint",
    method: "get",
    path: "/api/templates/:id/blueprint",
    access: "public",
    tags: ["Templates"],
    summary: "The pre-fill for onboarding from one reference template. Creates nothing.",
    responses: {
      200: ok("Blueprint.", TemplateBlueprintSchema),
      404: err("No template has that id."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getOpenApi",
    method: "get",
    path: "/api/openapi.json",
    access: "public",
    tags: ["Monitoring"],
    summary: "The OpenAPI 3.0 document of this API, built from the route registry (ADR 0034).",
    responses: { 200: ok("OpenAPI 3.0.3 document.", OpenApiDocumentSchema) },
    contractTested: true,
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // Workspaces and onboarding
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "listWorkspaces",
    method: "get",
    path: "/api/workspaces",
    access: "authenticated",
    tags: ["Workspaces"],
    summary: "The caller's own workspace (never another one).",
    responses: { 200: ok("The caller's workspace, as a one-item list.", list(WorkspaceRowSchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getMe",
    method: "get",
    path: "/api/me",
    access: "authenticated",
    tags: ["Workspaces"],
    summary: "Who the bearer token is: its workspace, role, label, credential kind and the pause switch. Never a secret.",
    responses: {
      200: ok("The caller's identity in its workspace. Sent with Cache-Control: no-store.", MeSchema),
      404: err("The caller's workspace no longer exists. The same body a missing workspace gets elsewhere."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "onboardWorkspace",
    method: "post",
    path: "/api/workspaces/onboard",
    access: "public",
    tags: ["Workspaces"],
    summary: "Create a blank or owner-configured workspace. Returns its first owner token once.",
    body: OnboardWorkspaceSchema,
    sampleBody: {
      workspaceId: "<<fresh>>",
      name: "Contract Onboarded Kitchen",
      businessType: "kitchen",
      budgetDailyLimitCents: 5000,
      approvalThresholdCents: 1000,
    },
    responses: {
      201: ok("Created. The owner token is in the body and is shown only here.", OnboardResultSchema),
      409: err("The workspace id is taken. Nothing is changed."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "createWorkspace",
    method: "post",
    path: "/api/workspaces",
    access: "public",
    tags: ["Workspaces"],
    summary: "Create a workspace from a reference template. Returns its first owner token once.",
    body: CreateWorkspaceBodySchema,
    sampleBody: { id: "<<fresh>>", name: "Contract Created Kitchen", templateId: "kitchen-v1" },
    responses: {
      201: ok("Created. The owner token is in the body and is shown only here.", WorkspaceCreateResultSchema),
      409: err("The workspace id is taken. Nothing is changed."),
    },
    contractTested: true,
  }),
  // -------------------------------------------------------------------------------------------------------------------
  // Demo workspaces (docs/decisions/0057)
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "createDemo",
    method: "post",
    path: "/api/demo",
    access: "public",
    tags: ["Demo"],
    summary:
      "Create a throwaway demo workspace: four hours, simulated only, with one real pending approval. Returns its owner token once.",
    responses: {
      201: ok("Created. The owner token is in the body and is shown only here. Never cached.", DemoCreatedSchema),
      404: err("Demo workspaces are off on this server (code DEMO_DISABLED). They are off in production unless BIND_DEMO_ENABLED=true."),
      503: err("The limit on active demos is reached (code DEMO_CAPACITY_REACHED), or another create holds the lock (code DEMO_BUSY, Retry-After: 3)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "resetDemo",
    method: "post",
    path: "/api/workspaces/:id/demo/reset",
    access: "owner",
    tags: ["Demo"],
    summary: "Reset a demo: delete it and its data, and return a fresh demo with new credentials. The old token stops working.",
    responses: {
      201: ok("Created. The new owner token is in the body and is shown only here. Never cached.", DemoCreatedSchema),
      404: err("Demo workspaces are off on this server (code DEMO_DISABLED)."),
      409: err("This workspace is not a demo (code NOT_A_DEMO). Nothing is changed."),
      503: err("The limit on active demos is reached (code DEMO_CAPACITY_REACHED), or another create holds the lock (code DEMO_BUSY, Retry-After: 3)."),
    },
    contractTested: true,
  }),

  withGenericErrors({
    operationId: "getWorkspace",
    method: "get",
    path: "/api/workspaces/:id",
    access: "member",
    tags: ["Workspaces"],
    summary: "A workspace with its agent roles, treasury balance and the tool registry.",
    responses: { 200: ok("Workspace detail.", WorkspaceDetailSchema) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "updatePolicy",
    method: "put",
    path: "/api/workspaces/:id/policy",
    access: "owner",
    tags: ["Workspaces"],
    summary: "Set the daily budget, the approval threshold and the settlement address.",
    body: PolicyBodySchema,
    sampleBody: { budgetDailyLimitCents: 150000, approvalThresholdCents: 25000 },
    responses: {
      200: ok("Updated workspace.", PolicyUpdateSchema),
      404: err("Workspace not found."),
    },
    contractTested: true,
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // Inventory and replenishment
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "listInventory",
    method: "get",
    path: "/api/workspaces/:id/inventory",
    access: "member",
    tags: ["Inventory"],
    summary: "Inventory items, ordered by sku.",
    responses: { 200: ok("Inventory rows.", list(InventoryItemSchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "upsertInventoryItem",
    method: "post",
    path: "/api/workspaces/:id/inventory",
    access: "member",
    tags: ["Inventory"],
    summary: "Add or update an inventory item by sku.",
    body: InitialSupplyItemSchema,
    sampleBody: { sku: "FOOD-CONTRACT-SAMPLE", name: "Contract Sample Item", currentQuantity: 4, parLevel: 2, reorderQuantity: 3, unitPriceCents: 150 },
    responses: { 201: ok("The stored item.", InventoryItemSchema) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "replenish",
    method: "post",
    path: "/api/workspaces/:id/replenish",
    access: "member",
    tags: ["Replenishment"],
    summary: "Start a replenishment for one sku. Returns the workflow it is in.",
    body: ReplenishBodySchema,
    sampleBody: { sku: "FOOD-BUTTER-36LB" },
    responses: {
      200: ok("The replenishment workflow, and its order or approval if one exists.", ReplenishResultSchema),
      400: err(
        "Malformed JSON, a NUL character, or a missing or non-text sku. Also refused: a paused workspace (code AGENTS_PAUSED, ADR 0023), an unknown sku, and an item with sufficient stock."
      ),
    },
    contractTested: true,
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // Approvals and settlement
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "getApproval",
    method: "get",
    path: "/api/workspaces/:id/approvals/:approvalId",
    access: "member",
    tags: ["Approvals"],
    summary: "One approval of this workspace.",
    responses: {
      200: ok("The row, as the list returns it.", ApprovalSchema),
      404: err("Approval not found in this workspace (APPROVAL_NOT_FOUND)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "listApprovals",
    method: "get",
    path: "/api/workspaces/:id/approvals",
    access: "member",
    tags: ["Approvals"],
    summary: "Approvals of the workspace. Pending ones past their expiry are expired first.",
    responses: { 200: ok("Approval rows, newest first.", list(ApprovalSchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "approveApproval",
    method: "post",
    path: "/api/approvals/:id/approve",
    access: "owner-any",
    tags: ["Approvals"],
    summary: "Approve a pending approval. The order is submitted once, as the owner token's label.",
    responses: {
      200: ok("The workflow after the approval, with its order.", ApprovalApproveResultSchema),
      404: err("The approval is not found in your workspace (APPROVAL_NOT_FOUND)."),
      409: err("The approval cannot be decided now, for example it is expired or already decided."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "rejectApproval",
    method: "post",
    path: "/api/approvals/:id/reject",
    access: "owner-any",
    tags: ["Approvals"],
    summary: "Reject a pending approval. The workflow is cancelled and nothing is ordered.",
    body: ApprovalDecisionBodySchema.optional(),
    responses: {
      200: ok("The decision.", ApprovalDecisionResultSchema),
      404: err("The approval is not found in your workspace (APPROVAL_NOT_FOUND)."),
      409: err("The approval cannot be decided now."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "revokeApproval",
    method: "post",
    path: "/api/approvals/:id/revoke",
    access: "owner-any",
    tags: ["Approvals"],
    summary: "Revoke an approval that was given. Recorded as revoked, not rejected.",
    body: ApprovalDecisionBodySchema.optional(),
    responses: {
      200: ok("The decision.", ApprovalDecisionResultSchema),
      404: err("The approval is not found in your workspace (APPROVAL_NOT_FOUND)."),
      409: err("The approval cannot be decided now."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "reconcileOrder",
    method: "post",
    path: "/api/orders/:id/reconcile",
    access: "owner-any",
    tags: ["Orders"],
    summary: "Match the delivery receipt and the bill to the order, and settle it if they match.",
    responses: {
      200: ok("The match and, when paid, the transaction.", ReconcileResultSchema),
      404: err("The order is not found in your workspace (ORDER_NOT_FOUND)."),
      409: err("The order is not in a state that can be reconciled."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "confirmOrderSettlement",
    method: "post",
    path: "/api/orders/:id/confirm-settlement",
    access: "owner-any",
    tags: ["Orders"],
    summary: "Finish a payment that was sent but not yet confirmed. It pays nothing.",
    responses: {
      200: ok("The settlement outcome.", ReconcileResultSchema),
      404: err("The order is not found in your workspace (ORDER_NOT_FOUND)."),
      409: err("The order is not waiting for settlement confirmation."),
    },
    contractTested: true,
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // Customer orders and kitchen capacity (ADR 0026)
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "listCustomerOrders",
    method: "get",
    path: "/api/workspaces/:id/customer-orders",
    access: "member",
    tags: ["Customer orders"],
    summary: "Customer orders, newest first.",
    responses: { 200: ok("Customer orders.", list(CustomerOrderSchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "createCustomerOrder",
    method: "post",
    path: "/api/workspaces/:id/customer-orders",
    access: "member",
    tags: ["Customer orders"],
    summary: "Record a customer order and its decision. Customer text is data, never an instruction.",
    body: CustomerOrderBodySchema,
    sampleBody: { externalRef: "contract-sample-<<run>>", lines: [{ sku: "FOOD-FLOUR-50LB", quantity: 1 }] },
    responses: {
      201: ok("Created: the decision (accepted, needs_owner, declined, ...).", CustomerOrderDecisionSchema),
      200: ok("The same external reference was sent before: the earlier decision, replayed.", CustomerOrderDecisionSchema),
      409: err("The request conflicts with an existing order (FulfilmentError code)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getCustomerOrder",
    method: "get",
    path: "/api/workspaces/:id/customer-orders/:orderId",
    access: "member",
    tags: ["Customer orders"],
    summary: "One customer order.",
    responses: {
      200: ok("The customer order.", CustomerOrderSchema),
      404: err("No order with that id in this workspace (ORDER_NOT_FOUND)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "acceptCustomerOrder",
    method: "post",
    path: "/api/workspaces/:id/customer-orders/:orderId/accept",
    access: "owner",
    tags: ["Customer orders"],
    summary: "Accept a held order (the owner decides it; the capacity is checked again).",
    responses: {
      200: ok("The decision after the owner's accept.", CustomerOrderDecisionSchema),
      404: err("No order with that id (ORDER_NOT_FOUND)."),
      409: err("The order cannot be accepted now."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "cancelCustomerOrder",
    method: "post",
    path: "/api/workspaces/:id/customer-orders/:orderId/cancel",
    access: "member",
    tags: ["Customer orders"],
    summary: "Cancel a customer order. Staff may cancel. Nothing is ordered or paid by this.",
    responses: {
      200: ok("The order, now cancelled.", CustomerOrderSchema),
      404: err("No order with that id (ORDER_NOT_FOUND)."),
      409: err("The order cannot be cancelled in its state."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "fulfilCustomerOrder",
    method: "post",
    path: "/api/workspaces/:id/customer-orders/:orderId/fulfil",
    access: "member",
    tags: ["Customer orders"],
    summary: "Mark an accepted order fulfilled, and release its reserved stock.",
    responses: {
      200: ok("The order, now fulfilled.", CustomerOrderSchema),
      404: err("No order with that id (ORDER_NOT_FOUND)."),
      409: err("The order is not accepted (NOT_ACCEPTED) or cannot be fulfilled in its state."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "listKitchenCapacity",
    method: "get",
    path: "/api/workspaces/:id/kitchen-capacity",
    access: "member",
    tags: ["Customer orders"],
    summary: "Kitchen capacity slots, with the units used and left in each.",
    responses: { 200: ok("Capacity slots.", list(KitchenSlotSchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "setKitchenCapacity",
    method: "put",
    path: "/api/workspaces/:id/kitchen-capacity",
    access: "owner",
    tags: ["Customer orders"],
    summary: "Replace the kitchen capacity slots.",
    body: KitchenCapacityBodySchema,
    sampleBody: { slots: [{ startsAt: "2026-12-01T10:00:00Z", endsAt: "2026-12-01T11:00:00Z", capacityUnits: 5 }] },
    responses: { 200: ok("The slots after the change.", list(KitchenSlotSchema)) },
    contractTested: true,
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // Feedback and menu proposals (ADR 0028)
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "ingestFeedback",
    method: "post",
    path: "/api/workspaces/:id/feedback",
    access: "member",
    tags: ["Feedback"],
    summary: "Store one piece of customer or staff feedback. It is data, never an instruction.",
    body: FeedbackBodySchema,
    sampleBody: { source: "pos", externalId: "contract-sample-<<run>>", text: "Sample feedback" },
    responses: {
      201: ok("Stored.", FeedbackIngestSchema),
      200: ok("The same source and external id was stored before (duplicate).", FeedbackIngestSchema),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "listFeedback",
    method: "get",
    path: "/api/workspaces/:id/feedback",
    access: "member",
    tags: ["Feedback"],
    summary: "The newest feedback items (up to 100).",
    responses: { 200: ok("Feedback items.", list(FeedbackItemSchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getFeedbackSummary",
    method: "get",
    path: "/api/workspaces/:id/feedback/summary",
    access: "member",
    tags: ["Feedback"],
    summary: "Themes and a sample of the feedback since a date (default: 30 days). Reproducible from stored rows.",
    query: FeedbackSummaryQuerySchema,
    responses: { 200: ok("The summary. Its text fields are customer data.", FeedbackSummarySchema) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "proposeMenuChange",
    method: "post",
    path: "/api/workspaces/:id/menu-proposals",
    access: "member",
    tags: ["Menu"],
    summary: "Propose a menu change. A staff token proposes as the menu agent (its role and the pause apply).",
    body: MenuProposalBodySchema,
    sampleBody: { change: { type: "add_item", name: "Contract Sample Dish", priceCents: 900 }, rationale: "Sample" },
    responses: {
      201: ok("The proposal, not yet applied.", MenuProposalSchema),
      403: err("The menu agent role is not permitted to propose (ROLE_NOT_PERMITTED)."),
      409: err("A proposal is refused now, for example while the agents are paused (AGENTS_PAUSED)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "listMenuProposals",
    method: "get",
    path: "/api/workspaces/:id/menu-proposals",
    access: "member",
    tags: ["Menu"],
    summary: "Menu proposals, newest first.",
    responses: { 200: ok("Proposals.", list(MenuProposalSchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "approveMenuProposal",
    method: "post",
    path: "/api/workspaces/:id/menu-proposals/:proposalId/approve",
    access: "owner",
    tags: ["Menu"],
    summary: "Approve a proposal (an owner decision; it is not yet on the menu).",
    responses: {
      200: ok("The approved proposal.", MenuProposalSchema),
      404: err("No proposal with that id (PROPOSAL_NOT_FOUND)."),
      409: err("The proposal is not in a state that can be approved."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "rejectMenuProposal",
    method: "post",
    path: "/api/workspaces/:id/menu-proposals/:proposalId/reject",
    access: "owner",
    tags: ["Menu"],
    summary: "Reject a proposal.",
    responses: {
      200: ok("The rejected proposal.", MenuProposalSchema),
      404: err("No proposal with that id (PROPOSAL_NOT_FOUND)."),
      409: err("The proposal is not in a state that can be rejected."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "cancelMenuProposal",
    method: "post",
    path: "/api/workspaces/:id/menu-proposals/:proposalId/cancel",
    access: "owner",
    tags: ["Menu"],
    summary: "Cancel a proposal that is not yet published.",
    responses: {
      200: ok("The cancelled proposal.", MenuProposalSchema),
      404: err("No proposal with that id (PROPOSAL_NOT_FOUND)."),
      409: err("The proposal cannot be cancelled in its state."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "publishMenuProposal",
    method: "post",
    path: "/api/workspaces/:id/menu-proposals/:proposalId/publish",
    access: "owner",
    tags: ["Menu"],
    summary: "Publish an approved proposal to the menu. An offer to customers: only an owner may do it.",
    responses: {
      200: ok("The published proposal, with what it changed.", MenuProposalSchema),
      404: err("No proposal with that id (PROPOSAL_NOT_FOUND)."),
      409: err("The proposal is not approved (NOT_APPROVED)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "listMenu",
    method: "get",
    path: "/api/workspaces/:id/menu",
    access: "member",
    tags: ["Menu"],
    summary: "The published menu items.",
    responses: { 200: ok("Menu items.", list(MenuItemSchema)) },
    contractTested: true,
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // Workflows, attention and orders
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "listWorkflows",
    method: "get",
    path: "/api/workspaces/:id/workflows",
    access: "member",
    tags: ["Workflows"],
    summary: "The 50 newest workflows.",
    responses: { 200: ok("Workflow rows.", list(WorkflowSchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getWorkflow",
    method: "get",
    path: "/api/workspaces/:id/workflows/:workflowId",
    access: "member",
    tags: ["Workflows"],
    summary: "One workflow of this workspace.",
    responses: {
      200: ok("The row, as the list returns it.", WorkflowSchema),
      404: err("Workflow not found in this workspace (WORKFLOW_NOT_FOUND). The same answer for another tenant's id."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "cancelWorkflow",
    method: "post",
    path: "/api/workspaces/:id/workflows/:workflowId/cancel",
    access: "owner",
    tags: ["Workflows"],
    summary: "Owner cancel of a workflow that has not ordered. A pause does not block it; it never orders, pays or contacts a supplier (ADR 0030).",
    body: CancelWorkflowBodySchema.optional(),
    responses: {
      200: ok("The workflow, cancelled.", WorkflowCancelResultSchema),
      404: err("No workflow with that id (WORKFLOW_NOT_FOUND)."),
      409: err("The workflow cannot be cancelled now (WORKFLOW_NOT_CANCELLABLE or WORKFLOW_STATE_CHANGED)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getNeedsAttention",
    method: "get",
    path: "/api/workspaces/:id/needs-attention",
    access: "member",
    tags: ["Workflows"],
    summary: "What the owner must decide: ids, codes and the next action. No customer, supplier or feedback text.",
    responses: { 200: ok("Items that need the owner.", NeedsAttentionSchema) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getOrder",
    method: "get",
    path: "/api/workspaces/:id/orders/:orderId",
    access: "member",
    tags: ["Orders"],
    summary: "One supplier order of this workspace, with its latest three-way match.",
    responses: {
      200: ok("The row, as the list returns it.", OrderSchema),
      404: err("Order not found in this workspace (ORDER_NOT_FOUND)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "listOrders",
    method: "get",
    path: "/api/workspaces/:id/orders",
    access: "member",
    tags: ["Orders"],
    summary: "The 50 newest orders, with the latest three-way match.",
    responses: { 200: ok("Order rows.", list(OrderSchema)) },
    contractTested: true,
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // Suppliers and agents
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "listSuppliers",
    method: "get",
    path: "/api/workspaces/:id/suppliers",
    access: "member",
    tags: ["Suppliers"],
    summary: "Suppliers of the workspace, by name.",
    responses: { 200: ok("Supplier rows.", list(SupplierSchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "upsertSupplier",
    method: "post",
    path: "/api/workspaces/:id/suppliers",
    access: "owner",
    tags: ["Suppliers"],
    summary: "Add or update a supplier. A payee address is checked and stored checksummed.",
    body: SupplierBodySchema,
    sampleBody: { id: "contract-sample-supplier", name: "Contract Sample Supplier", adapterType: "manual_quote", isSimulated: false, verified: true },
    responses: {
      201: ok("The stored supplier.", SupplierSchema),
      409: err("The supplier id belongs to another workspace. Nothing is changed."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "recordTabCharge",
    method: "post",
    path: "/api/workspaces/:id/tabs/charges",
    access: "member",
    tags: ["Tabs"],
    summary: "Record a charge against a counterparty's tab, in micro-USDC (ADR 0081). Settled later in whole cents.",
    body: TabChargeBodySchema,
    responses: {
      201: ok("The charge was recorded.", TabChargeResultSchema),
      200: ok("The same key with the same data was already recorded. Nothing was added.", TabChargeResultSchema),
      400: err("The amount is not a positive whole number of micro-USDC within the 25 USDC limit (INVALID_CHARGE_AMOUNT), or a field is invalid (INVALID_CHARGE)."),
      404: err("The counterparty is not found in your workspace (COUNTERPARTY_NOT_FOUND)."),
      409: err("The counterparty is not verified (COUNTERPARTY_NOT_VERIFIED), or the key was used for a different charge (IDEMPOTENCY_CONFLICT)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "listTabs",
    method: "get",
    path: "/api/workspaces/:id/tabs",
    access: "owner",
    tags: ["Tabs"],
    summary: "The tabs of the workspace: balance in micro-USDC and the whole cents a settlement would clear now.",
    responses: { 200: ok("One row per counterparty with entries.", list(TabSummarySchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getTab",
    method: "get",
    path: "/api/workspaces/:id/tabs/:counterpartyId",
    access: "owner",
    tags: ["Tabs"],
    summary: "One tab: its balance, the latest entries and the latest settlements.",
    responses: {
      200: ok("The tab.", TabDetailSchema),
      404: err("The counterparty is not found in your workspace (COUNTERPARTY_NOT_FOUND)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "settleTab",
    method: "post",
    path: "/api/workspaces/:id/tabs/:counterpartyId/settle",
    access: "owner",
    tags: ["Tabs"],
    summary: "Settle the whole cents of a tab now, through the same gates as an order payment (ADR 0081).",
    responses: {
      200: ok("What the call did: nothing to settle, needs approval, refused, or a settlement with its status.", TabSettleResultSchema),
      404: err("The counterparty is not found in your workspace (COUNTERPARTY_NOT_FOUND)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "listHeldTabSettlements",
    method: "get",
    path: "/api/workspaces/:id/tabs/settlements",
    access: "owner",
    tags: ["Tabs"],
    summary: "The held tab settlements of the workspace, oldest change first, limited to 50. Read only (docs/decisions/0081).",
    responses: {
      200: ok("One row per held settlement, with its hold reason and whether an effect row exists.", list(TabHeldSettlementSchema)),
      400: err("The status filter is not held (INVALID_STATUS)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "resolveTabSettlement",
    method: "post",
    path: "/api/workspaces/:id/tabs/settlements/:settlementId/resolve",
    access: "owner",
    tags: ["Tabs"],
    summary: "Resolve a held tab settlement: reconcile (adopt and confirm a transfer the ledger or the chain can show) or cancel_and_restore (restore its clear only when it is provably unsent).",
    body: TabResolveBodySchema,
    responses: {
      200: ok("The outcome. reconcile: adopted, or why nothing was adopted. cancel_and_restore: cancelled, or already_cancelled on a repeat.", TabResolveResultSchema),
      400: err("The action is not reconcile or cancel_and_restore (INVALID_ACTION), or acknowledgeNotSent is not a boolean (INVALID_RESOLVE)."),
      404: err("The settlement is not found in your workspace (SETTLEMENT_NOT_FOUND)."),
      409: err("A restore is refused as not provably unsent (NOT_PROVABLY_UNSENT), the settlement is not held (SETTLEMENT_NOT_HELD), owns no balance (SETTLEMENT_OWNS_NO_BALANCE), or is being processed (SETTLEMENT_BUSY)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getAgents",
    method: "get",
    path: "/api/workspaces/:id/agents",
    access: "member",
    tags: ["Agents"],
    summary: "Agent roles, with the tool registry and the forbidden capabilities.",
    responses: { 200: ok("Roles and the tool lists.", AgentsListSchema) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "upsertAgentRole",
    method: "post",
    path: "/api/workspaces/:id/agents",
    access: "owner",
    tags: ["Agents"],
    summary: "Add or update an agent role. Only the typed tool registry is allowed; forbidden capabilities are refused.",
    body: AgentRoleUpsertSchema,
    sampleBody: {
      roleName: "contract_sample_role",
      displayName: "Contract Sample Role",
      description: "Sample role used by the contract test",
      permittedEffects: ["read"],
      spendingLimitCents: 500,
      allowedTools: ["get_stock_snapshot"],
      enabled: true,
    },
    responses: {
      201: ok("The stored role and where its generated spec was written.", AgentRoleUpsertResultSchema),
      400: err("Invalid role, or a forbidden or unknown tool (FORBIDDEN_CAPABILITY for a forbidden one)."),
    },
    contractTested: true,
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // Surfaces (messaging bindings, ADR 0022)
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "listSurfaces",
    method: "get",
    path: "/api/workspaces/:id/surfaces",
    access: "member",
    tags: ["Surfaces"],
    summary: "Identity bindings of messaging surfaces. A binding is the only source of a surface actor's role.",
    responses: { 200: ok("Bindings.", list(SurfaceBindingSchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "upsertSurfaceBinding",
    method: "post",
    path: "/api/workspaces/:id/surfaces",
    access: "owner",
    tags: ["Surfaces"],
    summary: "Bind an actor on a surface to a role in this workspace.",
    body: SurfaceBindingUpsertSchema,
    sampleBody: { surface: "email", actorId: "contract-sample@example.com", actorRole: "staff", integrationStatus: "simulated" },
    responses: { 201: ok("The stored binding.", SurfaceBindingSchema) },
    contractTested: true,
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // Owner notices by email (ADR 0074)
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "getNotificationChannels",
    method: "get",
    path: "/api/workspaces/:id/notifications",
    access: "owner",
    tags: ["Notifications"],
    summary: "Whether email notices are on for this server, and the workspace's owner addresses with their status. Never a code.",
    responses: { 200: ok("Channels.", NotificationChannelsSchema) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "requestOwnerEmailVerification",
    method: "post",
    path: "/api/workspaces/:id/notifications/email",
    access: "owner",
    tags: ["Notifications"],
    summary: "Send a six-digit code to an address, to be entered at /verify. The code goes only in the email.",
    body: OwnerEmailRequestBodySchema,
    responses: {
      201: ok("A code was sent and the address is pending.", OwnerEmailRequestedSchema),
      200: ok("The address is already verified for this workspace. Nothing was sent.", OwnerEmailRequestedSchema),
      400: err("The address is not a valid email address (INVALID_INPUT)."),
      403: err("A demo workspace sends no email (EMAIL_DEMO_REFUSED)."),
      409: err("Too many wrong codes for this address in the last day (EMAIL_ATTEMPTS_EXCEEDED). Nothing was sent."),
      429: err(
        "A send limit is reached (EMAIL_SEND_LIMITED): three codes per address per hour, five addresses or ten codes per workspace per day. Retry-After is set."
      ),
      502: err("The email provider refused or did not answer (EMAIL_SEND_FAILED). Nothing was verified."),
      503: err("Email notices are not set up on this server (EMAIL_NOT_CONFIGURED). Nothing was sent."),
    },
    contractTested: false,
    notTestedReason:
      "Needs a configured email provider to answer 2xx; the simulated server answers 503 by design. Covered by tests/integration/owner-email-routes.test.ts against a local fake provider.",
  }),
  withGenericErrors({
    operationId: "verifyOwnerEmail",
    method: "post",
    path: "/api/workspaces/:id/notifications/email/verify",
    access: "owner",
    tags: ["Notifications"],
    summary: "Check the six-digit code. On success the address receives owner notices.",
    body: OwnerEmailVerifyBodySchema,
    responses: {
      200: ok("Verified (also when the address was verified before).", OwnerEmailVerifiedSchema),
      400: err("The code is wrong (EMAIL_CODE_INVALID) or not six digits (INVALID_INPUT). The message says how many attempts are left."),
      403: err("A demo workspace verifies no email (EMAIL_DEMO_REFUSED)."),
      404: err("No such address on this workspace's list (EMAIL_NOT_FOUND)."),
      409: err(
        "The code expired (EMAIL_CODE_EXPIRED), or the code's five attempts or the address's ten wrong guesses in a day are used up (EMAIL_ATTEMPTS_EXCEEDED)."
      ),
      503: err("Email notices are not set up on this server (EMAIL_NOT_CONFIGURED)."),
    },
    contractTested: false,
    notTestedReason:
      "Needs a code that only the email carries, so a sample cannot reach 2xx. Covered by tests/integration/owner-email-routes.test.ts.",
  }),
  withGenericErrors({
    operationId: "removeOwnerEmail",
    method: "delete",
    path: "/api/workspaces/:id/notifications/email/:emailId",
    access: "owner",
    tags: ["Notifications"],
    summary: "Remove an owner address. It stops receiving notices at once. The binding it created is removed with it.",
    responses: {
      200: ok("Removed.", OwnerEmailRemovedSchema),
      404: err("No such address on this workspace's list (EMAIL_NOT_FOUND)."),
    },
    contractTested: false,
    notTestedReason: "Needs an address that exists first, which the contract sweep does not create. Covered by tests/integration/owner-email-routes.test.ts.",
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // Documents and accounting (ADR 0009)
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "listDocuments",
    method: "get",
    path: "/api/workspaces/:id/documents",
    access: "member",
    tags: ["Documents"],
    summary: "The 50 newest staged documents.",
    responses: { 200: ok("Staged documents.", list(StagedDocumentSchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "extractDocument",
    method: "post",
    path: "/api/workspaces/:id/documents/extract",
    access: "member",
    tags: ["Documents"],
    summary: "Extract a draft from document text. Staged, never committed.",
    body: ExtractDocumentInputSchema,
    sampleBody: {
      docType: "supplier_bill",
      sourceLabel: "contract_sample",
      rawText: "Invoice #: INV-CONTRACT-1\nSKU: FOOD-FLOUR-50LB\nQty: 8\nUnit Price: $38.00\nTotal: $304.00",
    },
    responses: { 201: ok("The staged draft.", DocumentDraftSchema) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "confirmDocument",
    method: "post",
    path: "/api/workspaces/:id/documents/:docId/confirm",
    access: "owner",
    tags: ["Documents"],
    summary: "Confirm a staged document as the owner. The confirming owner is the token label; a body decidedBy is ignored.",
    body: ConfirmDocumentBodySchema,
    responses: {
      200: ok("The confirmed document and what it created.", DocumentConfirmSchema),
      400: err("The document is not staged in this workspace, or the body is invalid."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getLedger",
    method: "get",
    path: "/api/workspaces/:id/accounting/ledger",
    access: "member",
    tags: ["Accounting"],
    summary: "Journal entries for paid and reconciled orders. ?format=csv returns the same rows as text/csv.",
    query: LedgerQuerySchema,
    responses: { 200: ok("Journal entries (JSON). With format=csv: a text/csv attachment of the same rows.", list(LedgerEntrySchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "listAudit",
    method: "get",
    path: "/api/workspaces/:id/audit",
    access: "member",
    tags: ["Audit"],
    summary: "The 100 newest audit rows. Evidence holds ids and decisions, never secrets.",
    responses: { 200: ok("Audit rows.", list(AuditEntrySchema)) },
    contractTested: true,
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // The workspace event stream and its poll fallback (docs/decisions/0035). Authorization header only.
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "streamEvents",
    method: "get",
    path: "/api/workspaces/:id/events",
    access: "member",
    tags: ["Events"],
    summary:
      "Live stream (text/event-stream) of the workspace's finished audit events. Each event: id (<txid>.<seq>), event (the audit action) and data (the envelope). Resumes after Last-Event-ID (header) or lastEventId (query); with neither, starts after the latest event.",
    query: EventStreamQuerySchema,
    responses: {
      200: {
        description:
          "An event stream. Frames: `id`, `event`, `data`; `: ping` comments while idle; `event: shutdown` when the server stops; the stream also ends after an hour, when its token is revoked, or on a cap.",
        contentType: "text/event-stream",
      },
      400: err("Invalid cursor (INVALID_CURSOR): Last-Event-ID or lastEventId is not <txid>.<seq>."),
      429: err("Too many event streams (TOO_MANY_STREAMS): the per-token, per-workspace or per-process cap is reached. Retry-After is 5 seconds."),
    },
    contractTested: false,
    notTestedReason: "long-lived stream; covered by tests/integration/events.test.ts",
  }),
  withGenericErrors({
    operationId: "pollEvents",
    method: "get",
    path: "/api/workspaces/:id/events/poll",
    access: "member",
    tags: ["Events"],
    summary:
      "The same events as the stream, as JSON pages, for clients that cannot hold a stream (serverless). Without after: the newest events, ascending.",
    query: EventPollQuerySchema,
    responses: {
      200: ok("Events after the cursor, with nextCursor and hasMore.", EventPollSchema),
      400: err("Invalid cursor (INVALID_CURSOR), or a limit that is not an integer from 1 to 200 (INVALID_LIMIT)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "recoverWorkflows",
    method: "post",
    path: "/api/workspaces/:id/recover",
    access: "owner",
    tags: ["Workflows"],
    summary: "Recover interrupted workflows of this workspace. In-doubt submissions are reported, never resent.",
    responses: { 200: ok("What was recovered and what is in doubt.", RecoveryReportSchema) },
    contractTested: true,
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // People: sign-in, invitations and members (ADR 0051)
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "createSession",
    method: "post",
    path: "/api/auth/session",
    access: "account",
    tags: ["People"],
    summary: "Sign in: swap a Privy access token for a short-lived session in one workspace the account belongs to.",
    body: SessionCreateBodySchema,
    responses: {
      201: ok("The session token. Send it as a bearer token like a workspace token.", SessionIssuedSchema),
      404: err("Workspace not found or the account is not a member (the same answer for both)."),
    },
    contractTested: false,
    notTestedReason: "Covered by tests/integration/accounts.test.ts, which signs requests with a real ES256 key and checks each answer against this schema.",
  }),
  withGenericErrors({
    operationId: "signOut",
    method: "post",
    path: "/api/auth/sign-out",
    access: "authenticated",
    tags: ["People"],
    summary: "End the account session this request used.",
    responses: {
      200: ok("signedOut is true when an account session was ended, and false for a workspace token, which is not a session and keeps working.", SignedOutSchema),
    },
    contractTested: false,
    notTestedReason: "Covered by tests/integration/accounts.test.ts, which signs requests with a real ES256 key and checks each answer against this schema.",
  }),
  withGenericErrors({
    operationId: "listAccountWorkspaces",
    method: "get",
    path: "/api/account/workspaces",
    access: "account",
    tags: ["People"],
    summary: "The workspaces the signed-in account belongs to, with its role in each.",
    responses: {
      200: ok("Workspaces.", list(AccountWorkspaceSchema)),
    },
    contractTested: false,
    notTestedReason: "Covered by tests/integration/accounts.test.ts, which signs requests with a real ES256 key and checks each answer against this schema.",
  }),
  withGenericErrors({
    operationId: "createAccountWorkspace",
    method: "post",
    path: "/api/account/workspaces",
    access: "account",
    tags: ["People"],
    summary: "Create a workspace from a template and become its owner.",
    body: CreateWorkspaceBodySchema,
    responses: {
      201: ok("The new workspace.", AccountWorkspaceCreatedSchema),
      409: err("The workspace id is not available."),
    },
    contractTested: false,
    notTestedReason: "Covered by tests/integration/accounts.test.ts, which signs requests with a real ES256 key and checks each answer against this schema.",
  }),
  withGenericErrors({
    operationId: "acceptInvite",
    method: "post",
    path: "/api/account/invites/accept",
    access: "account",
    tags: ["People"],
    summary: "Join a workspace as staff with a single-use invitation code.",
    body: InviteAcceptBodySchema,
    responses: {
      200: ok("The workspace joined.", AccountWorkspaceSchema),
      404: err("The invitation cannot be used (unknown, used, revoked or expired: one answer)."),
      409: err("The account already belongs to the workspace (ALREADY_MEMBER)."),
    },
    contractTested: false,
    notTestedReason: "Covered by tests/integration/accounts.test.ts, which signs requests with a real ES256 key and checks each answer against this schema.",
  }),
  withGenericErrors({
    operationId: "createInvite",
    method: "post",
    path: "/api/workspaces/:id/invites",
    access: "owner",
    tags: ["People"],
    summary: "Create a single-use staff invitation. The code is returned once and never stored.",
    body: InviteCreateBodySchema,
    sampleBody: { label: "contract-sample-<<run>>" },
    responses: {
      201: ok("The invitation. Share the code now: it cannot be shown again.", InviteIssuedSchema),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "listInvites",
    method: "get",
    path: "/api/workspaces/:id/invites",
    access: "owner",
    tags: ["People"],
    summary: "The workspace's invitations. Never a code.",
    responses: {
      200: ok("Invitation summaries.", list(InviteSummarySchema)),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "revokeInvite",
    method: "delete",
    path: "/api/workspaces/:id/invites/:inviteId",
    access: "owner",
    tags: ["People"],
    summary: "Revoke an invitation that has not been used.",
    responses: {
      200: ok("The invitation is revoked.", InviteRevokedSchema),
      404: err("Invitation not found, already used or already revoked."),
    },
    contractTested: false,
    notTestedReason: "Covered by tests/integration/accounts.test.ts, which signs requests with a real ES256 key and checks each answer against this schema.",
  }),
  withGenericErrors({
    operationId: "listMembers",
    method: "get",
    path: "/api/workspaces/:id/members",
    access: "owner",
    tags: ["People"],
    summary: "The people who belong to this workspace, with their roles.",
    responses: {
      200: ok("Members.", list(MemberSchema)),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "setMemberRole",
    method: "put",
    path: "/api/workspaces/:id/members/:accountId",
    access: "owner",
    tags: ["People"],
    summary: "Change a member's role. The last owner cannot be demoted.",
    body: MemberRoleBodySchema,
    responses: {
      200: ok("The member with the new role.", MemberSchema),
      404: err("Member not found."),
      409: err("The last owner cannot be demoted (LAST_OWNER)."),
    },
    contractTested: false,
    notTestedReason: "Covered by tests/integration/accounts.test.ts, which signs requests with a real ES256 key and checks each answer against this schema.",
  }),
  withGenericErrors({
    operationId: "removeMember",
    method: "delete",
    path: "/api/workspaces/:id/members/:accountId",
    access: "owner",
    tags: ["People"],
    summary: "Remove a member and end their sessions. The last owner cannot be removed.",
    responses: {
      200: ok("The member is removed.", MemberRemovedSchema),
      404: err("Member not found."),
      409: err("The last owner cannot be removed (LAST_OWNER)."),
    },
    contractTested: false,
    notTestedReason: "Covered by tests/integration/accounts.test.ts, which signs requests with a real ES256 key and checks each answer against this schema.",
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // Tokens and controls (ADR 0021, ADR 0022)
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "issueToken",
    method: "post",
    path: "/api/workspaces/:id/tokens",
    access: "owner",
    tags: ["Tokens"],
    summary: "Issue a token for a role. The plaintext is returned once and never stored.",
    body: TokenCreateBodySchema,
    sampleBody: { role: "staff", label: "contract-sample-<<run>>" },
    responses: {
      201: ok("The token. Store it now: it cannot be shown again.", TokenIssuedSchema),
      400: err("The role or label is invalid (INVALID_INPUT)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "listTokens",
    method: "get",
    path: "/api/workspaces/:id/tokens",
    access: "owner",
    tags: ["Tokens"],
    summary: "The tokens of this workspace. Never a hash or a plaintext.",
    responses: { 200: ok("Token summaries.", list(TokenSummarySchema)) },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "revokeToken",
    method: "delete",
    path: "/api/workspaces/:id/tokens/:tokenId",
    access: "owner",
    tags: ["Tokens"],
    summary: "Revoke a token. The last active owner token of a workspace cannot be revoked.",
    responses: {
      200: ok("The revoked token.", TokenRevokedSchema),
      404: err("No such active token in this workspace (TOKEN_NOT_FOUND)."),
      409: err("It would leave the workspace without an active owner (LAST_OWNER_TOKEN)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "setAgentsPaused",
    method: "put",
    path: "/api/workspaces/:id/agents-paused",
    access: "owner",
    tags: ["Controls"],
    summary: "The pause switch. While paused, no commitment is made and no replenishment starts (ADR 0022).",
    body: PauseBodySchema,
    sampleBody: { paused: false },
    responses: {
      200: ok("The stored value, read back from the workspace.", PauseResultSchema),
      400: err("paused must be true or false."),
      500: err("The change could not be recorded."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "getWebhookSecret",
    method: "get",
    path: "/api/workspaces/:id/webhook-secret",
    access: "owner",
    tags: ["Controls"],
    summary: "The workspace's surface signing secret. Audited. Sent with Cache-Control: no-store.",
    responses: {
      200: ok("The current secret and its version.", WebhookSecretSchema),
      503: err("Webhook signing is not configured (BIND_MASTER_SECRET is unset)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "rotateWebhookSecret",
    method: "post",
    path: "/api/workspaces/:id/webhook-secret/rotate",
    access: "owner",
    tags: ["Controls"],
    summary: "Rotate the surface signing secret. The old secret stops validating at once.",
    responses: {
      200: ok("The new secret and its version.", WebhookSecretSchema),
      503: err("Webhook signing is not configured (BIND_MASTER_SECRET is unset)."),
    },
    contractTested: true,
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // Connectors (ADR 0024)
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "listConnectors",
    method: "get",
    path: "/api/workspaces/:id/connectors",
    access: "owner",
    tags: ["Connectors"],
    summary: "Connector credentials, as summaries. A secret is never returned.",
    responses: {
      200: ok("Connector summaries.", list(ConnectorSummarySchema)),
      503: err("The credential store is not configured (BIND_CREDENTIAL_KEY)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "setConnector",
    method: "put",
    path: "/api/workspaces/:id/connectors/:connectorId",
    access: "owner",
    tags: ["Connectors"],
    summary: "Store a connector secret. Accepted once, encrypted at rest, never returned.",
    body: ConnectorSetBodySchema,
    sampleBody: { kind: "other", secret: "contract-sample-secret-value" },
    responses: {
      200: ok("The summary of the stored connector.", ConnectorSummarySchema),
      400: err("The connector id, kind or secret is invalid."),
      503: err("The credential store is not configured (BIND_CREDENTIAL_KEY)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "revokeConnector",
    method: "delete",
    path: "/api/workspaces/:id/connectors/:connectorId",
    access: "owner",
    tags: ["Connectors"],
    summary: "Revoke a connector: its ciphertext is destroyed and it is marked revoked.",
    responses: {
      200: ok("The revoked summary.", ConnectorSummarySchema),
      404: err("The connector is not found (not configured or already revoked)."),
      503: err("The credential store is not configured (BIND_CREDENTIAL_KEY)."),
    },
    contractTested: true,
  }),
  withGenericErrors({
    operationId: "verifyConnector",
    method: "post",
    path: "/api/workspaces/:id/connectors/:connectorId/verify",
    access: "owner",
    tags: ["Connectors"],
    summary: "Verify a connector against its provider where a verifier exists. Otherwise NOT_AVAILABLE.",
    responses: {
      200: ok("The verification outcome.", ConnectorVerifySchema),
      404: err("The connector is not found."),
      503: err("The credential store is not configured (BIND_CREDENTIAL_KEY)."),
    },
    contractTested: true,
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // Inbound webhooks (ADR 0022). Not bearer-authenticated: an HMAC signature over the raw body.
  // -------------------------------------------------------------------------------------------------------------------
  withGenericErrors({
    operationId: "receiveWebhook",
    method: "post",
    path: "/api/webhooks/incoming",
    access: "signed-webhook",
    tags: ["Webhooks"],
    summary: "A surface event (signed with the workspace's surface secret) or a standard event (signed with BIND_WEBHOOK_SECRET). The body is the signed bytes.",
    body: WebhookBodySchema,
    sampleBody: { provider: "contract-sample", eventId: "contract-sample-<<run>>", payload: { sample: true } },
    responses: {
      200: ok("Processed, or a duplicate. Surface and standard answers have different fields.", z.union([SurfaceEventResultSchema, StandardWebhookResultSchema])),
      400: err("A standard event without provider and eventId, or a surface event the server cannot process."),
      401: err("The signature or the timestamp is wrong or expired. The same body answers an unknown workspace."),
      403: err("Actor is not authorized for this event: no binding in this workspace, or a staff binding asked for an owner action. The code is SURFACE_ROLE_VIOLATION."),
      404: err("A surface approval decision for an approval that is not in this workspace (APPROVAL_NOT_FOUND)."),
      409: err("A surface approval decision that cannot be made now."),
      503: { description: "Webhook signing is not configured, or the event could not be recorded (retry later).", schema: z.union([ErrorBody, StandardWebhookResultSchema]) },
    },
    contractTested: true,
  }),

  // -------------------------------------------------------------------------------------------------------------------
  // The website's catch-all (ADR 0054). Not an API route.
  // -------------------------------------------------------------------------------------------------------------------
  {
    operationId: "getUiShell",
    method: "get",
    path: "*",
    access: "public",
    tags: ["UI"],
    summary: "Any other GET path: the website's not-found page (ADR 0054). Not an API route.",
    responses: { 404: { description: "The not-found page, as HTML.", contentType: "text/html" } },
    contractTested: false,
    notTestedReason: CONTRACT_NOT_TESTED_UI,
  },
];
