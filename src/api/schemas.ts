/**
 * The shared schemas of the HTTP contract (docs/decisions/0034). Routes parse their bodies and queries with the request
 * schemas here, and the route registry (src/api/registry.ts) documents the response schemas here. One definition, used by
 * the route, the generated OpenAPI document and the contract tests.
 *
 * Conventions:
 * - Responses are `.passthrough()`: a field this file does not name is allowed. The named fields are the ones a client may
 *   rely on, and they are required.
 * - PostgreSQL NUMERIC and BIGINT columns come back as strings from the driver, so money and quantity fields use
 *   `Decimal` (a decimal string or a number). A value that the code always sends as a JS number is `z.number()`.
 * - Timestamps are ISO 8601 strings (`Date.toJSON`).
 * - Error bodies are `ErrorBody`: `{ error, code?, reasonCodes? }`, plus any extra field a route documents (for example
 *   `fields` on a validation error). The request id is in the `x-request-id` header, not the body.
 */
import { z } from "zod";
import {
  AgentRoleUpsertSchema,
  InitialSupplierSchema,
  InitialSupplyItemSchema,
  OnboardWorkspaceSchema,
} from "../studio/onboarding.js";
import { SocialSurfaceEventSchema, SurfaceBindingUpsertSchema, SupportedSurfaceEnum } from "../adapters/socialSurface.js";
import { ConfirmDocumentInputSchema, ExtractDocumentInputSchema } from "../studio/documentsAndAccounting.js";
import { CUSTOMER_ORDER_STATUSES } from "../workflows/fulfilment.js";
import { CANCEL_REASON_MAX_CHARACTERS } from "../workflows/cancel.js";
import { CONNECTOR_KINDS } from "../credentials/admin.js";

export { AgentRoleUpsertSchema, InitialSupplierSchema, InitialSupplyItemSchema, OnboardWorkspaceSchema };
export { SocialSurfaceEventSchema, SurfaceBindingUpsertSchema, SupportedSurfaceEnum };
export { ConfirmDocumentInputSchema, ExtractDocumentInputSchema };

// ---------------------------------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------------------------------

/** A NUMERIC or BIGINT value. PostgreSQL sends it as a string; some code paths send a number. Both are decimal values. */
export const Decimal = z.union([z.string(), z.number()]);

/** An ISO 8601 date-time, as `Date.toJSON` writes it. */
export const IsoDateTime = z.string().datetime({ offset: true });

/** `_meta` on the answers of the command operations (ADR 0050; docs/ecosystem/spec/response-meta-v1.schema.json). */
export const ResponseMetaSchema = z
  .object({
    requestId: z.string(),
    status: z.enum(["completed", "accepted", "held", "refused"]),
    state: z.string().optional(),
    processing: z.object({ remaining: z.array(z.string()).optional(), poll: z.string().optional(), events: z.string().optional() }).optional(),
    nextActions: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          actor: z.enum(["owner", "staff", "agent", "system"]),
          method: z.enum(["GET", "POST", "PUT", "DELETE"]),
          href: z.string().optional(),
          needsConfirmation: z.boolean().optional(),
        })
      )
      .optional(),
    warnings: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
    links: z.record(z.string()).optional(),
  })
  .describe("Outcome of the request in one vocabulary, and what the caller's role may do next.");

/**
 * The body of every error response (error body v2, docs/ecosystem/RESPONSE_AND_EVENT_SPEC.md section 4). `error`, `code`,
 * `category`, `retryable` and `requestId` are always present; `retryAfterSeconds` accompanies a Retry-After header; `details`
 * and `recovery` appear where they help. Routes may add a documented field (`fields`, `state`, `nextAction`, `reasonCodes`).
 * The health and readiness failures have their own bodies and do not use this schema.
 */
export const ErrorCategory = z.enum([
  "validation",
  "authentication",
  "authorization",
  "not_found",
  "conflict",
  "policy",
  "rate_limited",
  "upstream",
  "unavailable",
  "internal",
]);

export const ErrorBody = z
  .object({
    error: z.string(),
    code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    category: ErrorCategory,
    retryable: z.boolean(),
    requestId: z.string(),
    retryAfterSeconds: z.number().int().optional(),
    reasonCodes: z.array(z.string()).optional(),
    details: z.record(z.unknown()).optional(),
    recovery: z
      .array(z.object({ action: z.string(), description: z.string(), href: z.string().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

const Role = z.enum(["owner", "staff"]);

// ---------------------------------------------------------------------------------------------------------------------
// Request bodies and queries
// ---------------------------------------------------------------------------------------------------------------------

/** POST /api/workspaces. The route checks these three fields with the same message it always sent. */
export const CreateWorkspaceBodySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  templateId: z.string().min(1),
});

/** PUT /api/workspaces/:id/policy. The route coerces with Number() (a numeric string is accepted); the contract is a number. */
export const PolicyBodySchema = z.object({
  budgetDailyLimitCents: z.number().int().positive(),
  approvalThresholdCents: z.number().int().nonnegative(),
  settlementAddress: z.string().nullable().optional(),
});

/** POST /api/workspaces/:id/replenish. */
export const ReplenishBodySchema = z.object({
  sku: z.string().min(1),
});

/** POST /api/workspaces/:id/suppliers: the supplier fields, and an optional payee address (checked by the route). */
export const SupplierBodySchema = InitialSupplierSchema.extend({
  paymentAddress: z.string().nullable().optional(),
});

/** POST /api/workspaces/:id/documents/:docId/confirm. The confirming owner is the token label, so decidedBy is not sent. */
export const ConfirmDocumentBodySchema = ConfirmDocumentInputSchema.omit({ decidedBy: true });

/** POST /api/approvals/:id/reject and /revoke. The reason is recorded with the decision (same bound as a surface event). */
export const ApprovalDecisionBodySchema = z.object({
  reason: z.string().max(500).optional(),
});

/** POST /api/workspaces/:id/tokens. The label is trimmed and must be 1 to 80 characters (src/auth/tokens.ts). */
export const TokenCreateBodySchema = z.object({
  role: Role,
  label: z.string().min(1).max(80),
});

/** PUT /api/workspaces/:id/agents-paused. */
export const PauseBodySchema = z.object({
  paused: z.boolean(),
});

/** PUT /api/workspaces/:id/connectors/:connectorId. The secret is accepted once and never returned (ADR 0024). */
export const ConnectorSetBodySchema = z.object({
  kind: z.enum(CONNECTOR_KINDS),
  secret: z.string().min(1).max(8192),
});

/** POST /api/workspaces/:id/customer-orders (ADR 0026). Customer text is data: stored, truncated, never a decision input. */
export const CustomerOrderBodySchema = z.object({
  externalRef: z.string().trim().min(1).max(120),
  lines: z.array(z.object({ sku: z.string().min(1).max(120), quantity: z.number() })).max(200),
  requestedFor: z.string().datetime({ offset: true }).optional(),
  note: z.string().max(5000).optional(),
});

/** PUT /api/workspaces/:id/kitchen-capacity (ADR 0026). Replaces the slots it is given. */
export const KitchenCapacityBodySchema = z.object({
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

/** POST /api/workspaces/:id/feedback (ADR 0028). Untrusted text: stored as data. */
export const FeedbackBodySchema = z.object({
  source: z.string().regex(/^[a-z][a-z0-9_.:-]{1,39}$/),
  externalId: z.string().trim().min(1).max(120),
  text: z.string().max(20000),
});

/** GET /api/workspaces/:id/feedback/summary?since=... */
export const FeedbackSummaryQuerySchema = z.object({
  since: z.string().datetime({ offset: true }).optional(),
});

/** GET /api/workspaces/:id/accounting/ledger?format=csv returns CSV; the default is the JSON rows. */
export const LedgerQuerySchema = z.object({
  format: z.enum(["json", "csv"]).optional(),
});

export const MenuChangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_item"),
    name: z.string().max(400),
    description: z.string().max(2000).optional(),
    priceCents: z.number(),
  }),
  z.object({ type: z.literal("update_price"), itemId: z.string().min(1).max(64), priceCents: z.number() }),
  z.object({ type: z.literal("remove_item"), itemId: z.string().min(1).max(64) }),
]);

/** POST /api/workspaces/:id/menu-proposals (ADR 0028). */
export const MenuProposalBodySchema = z.object({
  change: MenuChangeSchema,
  rationale: z.string().max(2000).optional(),
  sourceFeedbackIds: z.array(z.string().min(1).max(64)).max(20).optional(),
});

/** POST /api/workspaces/:id/workflows/:workflowId/cancel (ADR 0030). The body itself is optional. */
export const CancelWorkflowBodySchema = z.object({
  // Owner text. Stored as data by the service, never echoed in an error and never written to the audit row.
  reason: z.string().max(CANCEL_REASON_MAX_CHARACTERS).optional(),
});

/** POST /api/webhooks/incoming, the standard (non-surface) event (ADR 0022). */
export const StandardWebhookBodySchema = z.object({
  provider: z.string().trim().min(1).max(200),
  eventId: z.string().trim().min(1).max(200),
  payload: z.record(z.unknown()).optional(),
});

/**
 * POST /api/webhooks/incoming takes either a surface event (ADR 0022) or a standard event. The route picks the branch by
 * the surface schema first, so this union is the contract of the whole route.
 */
export const WebhookBodySchema = z.union([SocialSurfaceEventSchema, StandardWebhookBodySchema]);

// ---------------------------------------------------------------------------------------------------------------------
// Response schemas (the rows and views the routes return)
// ---------------------------------------------------------------------------------------------------------------------

export const WorkspaceRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    template_id: z.string(),
    settlement_address: z.string().nullable(),
    settlement_mode: z.string(),
    budget_daily_limit_cents: Decimal,
    approval_threshold_cents: Decimal,
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
    agents_paused: z.boolean(),
    webhook_secret_version: z.number().int(),
    // Demo workspaces (docs/decisions/0057). A real workspace has is_demo false and no expiry.
    is_demo: z.boolean().optional(),
    demo_expires_at: IsoDateTime.nullable().optional(),
  })
  .passthrough();

/**
 * GET /api/me (ADR 0058): who the bearer token is. The server builds this answer field by field, so no secret, hash or token id
 * can reach it. Passthrough like the other response schemas, so an additive field does not break the contract.
 */
export const MeSchema = z
  .object({
    workspaceId: z.string(),
    workspaceName: z.string(),
    role: z.enum(["owner", "staff"]),
    label: z.string(),
    credential: z.enum(["workspace_token", "account_session"]),
    agentsPaused: z.boolean(),
  })
  .passthrough();

export const AgentRoleRowSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    role_name: z.string(),
    display_name: z.string(),
    description: z.string().nullable(),
    permitted_effects: z.array(z.string()),
    spending_limit_cents: Decimal,
    enabled: z.boolean(),
    created_at: IsoDateTime,
    allowed_tools: z.array(z.string()),
  })
  .passthrough();

export const InventoryItemSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    sku: z.string(),
    name: z.string(),
    category: z.string(),
    unit: z.string(),
    current_quantity: Decimal,
    par_level: Decimal,
    reorder_quantity: Decimal,
    unit_price_cents: Decimal,
    preferred_supplier_id: z.string().nullable(),
    updated_at: IsoDateTime,
  })
  .passthrough();

export const SupplierSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    name: z.string(),
    adapter_type: z.string(),
    contact_email: z.string().nullable(),
    verified: z.boolean(),
    is_simulated: z.boolean(),
    endpoint_url: z.string().nullable(),
    created_at: IsoDateTime,
    payment_address: z.string().nullable(),
  })
  .passthrough();

export const SurfaceBindingSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    surface: SupportedSurfaceEnum,
    actor_id: z.string(),
    actor_label: z.string().nullable(),
    actor_role: Role,
    integration_status: z.enum(["simulated", "configured_unverified", "verified"]),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .passthrough();

export const ApprovalSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    entity_type: z.string(),
    entity_id: z.string(),
    action_requested: z.string(),
    amount_cents: Decimal,
    currency: z.string(),
    requester_role: z.string(),
    status: z.string(),
    reason: z.string().nullable(),
    decided_by: z.string().nullable(),
    decided_at: IsoDateTime.nullable(),
    expires_at: IsoDateTime,
    created_at: IsoDateTime,
  })
  .passthrough();

export const WorkflowSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    workflow_type: z.string(),
    state: z.string(),
    context_data: z.record(z.unknown()),
    error_message: z.string().nullable(),
    retry_count: z.number().int(),
    idempotency_key: z.string(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .passthrough();

/** An order row, with the latest three-way match joined in (null until a match exists). */
export const OrderSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    order_number: z.string(),
    supplier_id: z.string().nullable(),
    supplier_name: z.string(),
    item_sku: z.string(),
    item_name: z.string(),
    quantity: Decimal,
    unit_price_cents: Decimal,
    total_price_cents: Decimal,
    currency: z.string(),
    status: z.string(),
    idempotency_key: z.string(),
    external_order_ref: z.string().nullable(),
    tx_hash: z.string().nullable(),
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
    settled_amount_cents: Decimal.nullable(),
    settled_receipt_id: z.string().nullable(),
    settled_bill_id: z.string().nullable(),
    match_status: z.string().nullable(),
    variance_cents: Decimal.nullable(),
    match_notes: z.string().nullable(),
    matched_at: IsoDateTime.nullable(),
  })
  .passthrough();

/** A staged document row (SELECT *). */
export const StagedDocumentSchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    doc_type: z.string(),
    source_label: z.string(),
    raw_text: z.string(),
    extracted_data: z.record(z.unknown()),
    warnings: z.array(z.string()),
    status: z.string(),
    linked_order_id: z.string().nullable(),
    confirmed_by: z.string().nullable(),
    confirmed_at: IsoDateTime.nullable(),
    created_at: IsoDateTime,
  })
  .passthrough();

/** The answer to POST documents/extract: the stored row, with the camelCase fields the draft carries as well. */
export const DocumentDraftSchema = StagedDocumentSchema.extend({
  docId: z.string(),
  docType: z.string(),
  provenance: z.string(),
  extractedFields: z.record(z.unknown()),
  warnings: z.array(z.string()),
});

export const DocumentConfirmSchema = z
  .object({
    docId: z.string(),
    docType: z.string(),
    status: z.string(),
    provenance: z.string(),
  })
  .passthrough();

export const LedgerEntrySchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    order_id: z.string().nullable(),
    entry_number: z.string(),
    debit_account: z.string(),
    credit_account: z.string(),
    amount_cents: Decimal,
    currency: z.string(),
    memo: z.string(),
    provenance: z.string(),
    tx_hash: z.string().nullable(),
    idempotency_key: z.string(),
    created_at: IsoDateTime,
  })
  .passthrough();

export const AuditEntrySchema = z
  .object({
    id: z.string(),
    workspace_id: z.string(),
    workflow_id: z.string().nullable(),
    actor_type: z.string(),
    actor_id: z.string(),
    effect_class: z.string(),
    action: z.string(),
    policy_decision: z.string(),
    evidence: z.record(z.unknown()),
    tx_hash: z.string().nullable(),
    created_at: IsoDateTime,
  })
  .passthrough();

// ---------------------------------------------------------------------------------------------------------------------
// The event stream (docs/decisions/0035)
// ---------------------------------------------------------------------------------------------------------------------

/** An event id: "<txid>.<seq>", the transaction id and the sequence number of an audit row. */
const EventCursorText = z.string().regex(/^\d{1,19}\.\d{1,19}$/);

/** GET /api/workspaces/:id/events and /events/poll: the cursor is taken from Last-Event-ID, or from lastEventId (stream). */
export const EventStreamQuerySchema = z.object({
  lastEventId: EventCursorText.optional(),
});

/** GET /api/workspaces/:id/events/poll. after is an event id; limit is 1 to 200 (default 50). Validated by the route. */
export const EventPollQuerySchema = z.object({
  after: EventCursorText.optional(),
  limit: z.string().regex(/^\d{1,3}$/).optional(),
});

/** One event: the audit action as its type, the redacted evidence allowlist as data (docs/EVENTS.md). */
export const EventEnvelopeSchema = z
  .object({
    id: EventCursorText,
    type: z.string(),
    name: z.string(),
    schemaVersion: z.literal(1),
    at: IsoDateTime,
    workspaceId: z.string(),
    effectClass: z.string(),
    decision: z.string(),
    actor: z.object({ type: z.string(), id: z.string() }).passthrough(),
    workflowId: z.string().optional(),
    object: z.object({ type: z.string(), id: z.string().nullable() }).optional(),
    correlationId: z.string().optional(),
    data: z.record(z.unknown()),
  })
  .passthrough();

/** GET /api/workspaces/:id/events/poll. nextCursor is the cursor to pass as after; hasMore is true when rows remain. */
export const EventPollSchema = z
  .object({
    events: z.array(EventEnvelopeSchema),
    nextCursor: EventCursorText,
    hasMore: z.boolean(),
  })
  .passthrough();

export const TokenSummarySchema = z
  .object({
    id: z.string(),
    role: Role,
    label: z.string(),
    createdAt: IsoDateTime,
    revokedAt: IsoDateTime.nullable(),
  })
  .passthrough();

export const ConnectorSummarySchema = z
  .object({
    connectorId: z.string(),
    kind: z.enum(CONNECTOR_KINDS),
    status: z.enum(["configured_unverified", "verified", "revoked"]),
    lastVerifiedAt: IsoDateTime.nullable(),
    fingerprint: z.string().nullable(),
    updatedAt: IsoDateTime,
  })
  .passthrough();

const ReasonRef = z.object({ code: z.string(), sku: z.string().optional() }).passthrough();

/** A customer order as the fulfilment service shows it (ADR 0026). */
export const CustomerOrderSchema = z
  .object({
    orderId: z.string(),
    externalRef: z.string(),
    status: z.enum(CUSTOMER_ORDER_STATUSES),
    requestedFor: IsoDateTime.nullable(),
    promisedFor: IsoDateTime.nullable(),
    reasons: z.array(ReasonRef),
    note: z.string().nullable(),
    units: z.number(),
    slotId: z.string().nullable(),
    decidedBy: z.string().nullable(),
    lines: z.array(z.object({ sku: z.string(), quantity: z.number() }).passthrough()),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .passthrough();

/** The answer to creating or accepting a customer order: its decision, and whether it was a replay of an earlier request. */
export const CustomerOrderDecisionSchema = z
  .object({
    orderId: z.string(),
    status: z.enum(CUSTOMER_ORDER_STATUSES),
    promisedFor: IsoDateTime.optional(),
    reasons: z.array(ReasonRef),
    replayed: z.boolean(),
  })
  .passthrough();

export const KitchenSlotSchema = z
  .object({
    id: z.string(),
    startsAt: IsoDateTime,
    endsAt: IsoDateTime,
    capacityUnits: z.number(),
    usedUnits: z.number(),
    remainingUnits: z.number(),
  })
  .passthrough();

export const FeedbackItemSchema = z
  .object({
    id: z.string(),
    source: z.string(),
    externalId: z.string(),
    text: z.string(),
    truncated: z.boolean(),
    createdAt: IsoDateTime,
  })
  .passthrough();

export const FeedbackIngestSchema = z
  .object({
    id: z.string(),
    duplicate: z.boolean(),
  })
  .passthrough();

/** The feedback summary. `sample` and `themes` are customer text: data, flagged by `untrusted: true`. */
export const FeedbackSummarySchema = z
  .object({
    since: IsoDateTime,
    themes: z.array(z.object({ term: z.string(), count: z.number() }).passthrough()),
    sample: z.array(z.string()),
    total: z.number(),
    rowsConsidered: z.number(),
    capped: z.boolean(),
    untrusted: z.literal(true),
  })
  .passthrough();

export const MenuProposalSchema = z
  .object({
    proposalId: z.string(),
    status: z.enum(["proposed", "approved", "rejected", "published", "cancelled"]),
    change: MenuChangeSchema,
    rationale: z.string().nullable(),
    sourceFeedbackIds: z.array(z.string()),
    proposedBy: z.string(),
    decidedBy: z.string().nullable(),
    applied: z.record(z.unknown()).nullable(),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  })
  .passthrough();

export const MenuItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    priceCents: z.number(),
    available: z.boolean(),
    updatedAt: IsoDateTime,
  })
  .passthrough();

export const NeedsAttentionSchema = z
  .object({
    items: z.array(
      z
        .object({
          kind: z.string(),
          id: z.string(),
          since: IsoDateTime,
          codes: z.array(z.string()),
          nextAction: z.string(),
        })
        .passthrough()
    ),
    capped: z.boolean(),
  })
  .passthrough();

/** The result of starting a replenishment, or of finding one already open. */
export const ReplenishResultSchema = z
  .object({
    workflowId: z.string(),
    state: z.string(),
    orderId: z.string().optional(),
    approvalId: z.string().optional(),
  })
  .passthrough();

/** The result of approving: the order is submitted (and may be in doubt, with the effect id to resume from). */
export const ApprovalApproveResultSchema = z
  .object({
    workflowId: z.string(),
    state: z.string(),
    orderId: z.string().optional(),
    inDoubt: z.literal(true).optional(),
    effectId: z.string().optional(),
  })
  .passthrough();

export const ApprovalDecisionResultSchema = z
  .object({
    status: z.enum(["rejected", "revoked"]),
    approvalId: z.string(),
    workflowId: z.string(),
    state: z.string(),
  })
  .passthrough();

export const WorkflowCancelResultSchema = z
  .object({
    workflowId: z.string(),
    state: z.string(),
    alreadyCancelled: z.boolean(),
    approvalId: z.string().optional(),
  })
  .passthrough();

/** A reconciliation or settlement check: the match, and the transaction when a payment was made. */
export const ReconcileResultSchema = z
  .object({
    status: z.string(),
    reconciled: z.boolean(),
    txHash: z.string().optional(),
    alreadyReconciled: z.boolean().optional(),
    hold: z.string().optional(),
    varianceCents: Decimal.optional(),
    discrepancyReason: z.string().optional(),
    pending: z.enum(["AWAITING_DELIVERY_RECEIPT", "AWAITING_SUPPLIER_BILL", "AWAITING_SETTLEMENT_CONFIRMATION"]).optional(),
  })
  .passthrough();

export const RecoveryReportSchema = z
  .object({
    recoveredCount: z.number(),
    failedCount: z.number(),
    inDoubt: z.array(z.object({ workflowId: z.string(), effectId: z.string() }).passthrough()),
    details: z.array(
      z.object({ workflowId: z.string(), previousState: z.string(), newState: z.string() }).passthrough()
    ),
  })
  .passthrough();

/** A webhook answer for a surface event that was processed (one of three shapes, by event type). */
const SurfaceProcessedBase = {
  status: z.literal("processed"),
  effectiveRole: Role,
  bindingStatus: z.string(),
};
export const SurfaceEventResultSchema = z.union([
  z
    .object({
      ...SurfaceProcessedBase,
      eventType: z.literal("SURFACE_STOCK_OBSERVED"),
      observedQuantity: z.number(),
      parLevel: z.number().optional(),
      replenishmentTriggered: z.boolean(),
      replenishmentResult: ReplenishResultSchema.nullable(),
      replenishmentSkipped: z.literal("AGENTS_PAUSED").optional(),
    })
    .passthrough(),
  z
    .object({
      ...SurfaceProcessedBase,
      eventType: z.literal("SURFACE_OWNER_APPROVAL_DECISION"),
      decision: z.enum(["approve", "reject"]),
      result: ApprovalApproveResultSchema.optional(),
      approvalId: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      ...SurfaceProcessedBase,
      eventType: z.literal("SURFACE_AGENT_PAUSE_TOGGLE"),
      workspaceId: z.string(),
      paused: z.boolean(),
    })
    .passthrough(),
  z.object({ status: z.literal("duplicate"), eventId: z.string() }).passthrough(),
]);

/** A standard event: accepted, or refused as a duplicate with the reason. */
export const StandardWebhookResultSchema = z
  .object({
    accepted: z.boolean(),
    reason: z.string().optional(),
  })
  .passthrough();

export const WebhookSecretSchema = z
  .object({
    secret: z.string(),
    version: z.number().int(),
  })
  .passthrough();

export const PauseResultSchema = z
  .object({
    workspaceId: z.string(),
    paused: z.boolean(),
  })
  .passthrough();

export const TokenIssuedSchema = z
  .object({
    id: z.string(),
    role: Role,
    label: z.string(),
    token: z.string(),
  })
  .passthrough();

export const TokenRevokedSchema = z
  .object({
    id: z.string(),
    role: Role,
    label: z.string(),
    revokedAt: IsoDateTime,
  })
  .passthrough();

export const ConnectorVerifySchema = z
  .object({
    connectorId: z.string(),
    status: z.enum(["configured_unverified", "verified", "revoked"]),
    verification: z.enum(["NOT_AVAILABLE", "VERIFIED", "FAILED"]),
    code: z.string().optional(),
  })
  .passthrough();

/** A derived-file report: where the generated agent and skill specs were written. */
const DerivedFilesSchema = z
  .object({
    agentsSpecPath: z.string(),
    skillSpecPath: z.string(),
  })
  .passthrough();

export const AgentRoleUpsertResultSchema = z
  .object({
    roleId: z.string(),
    workspaceId: z.string(),
    roleName: z.string(),
    displayName: z.string(),
    permittedEffects: z.array(z.string()),
    spendingLimitCents: z.number(),
    allowedTools: z.array(z.string()),
    enabled: z.boolean(),
    derivedFiles: DerivedFilesSchema,
  })
  .passthrough();

export const OnboardResultSchema = z
  .object({
    workspaceId: z.string(),
    name: z.string(),
    provenance: z.literal("OWNER_CONFIRMED"),
    derivedFiles: DerivedFilesSchema,
    ownerToken: z.object({ id: z.string(), token: z.string() }).passthrough(),
  })
  .passthrough();

/** A reference template, as the catalogue lists it. Amounts are BigInt in memory, so they travel as strings. */
export const TemplateSummarySchema = z
  .object({
    templateId: z.string(),
    name: z.string(),
    description: z.string(),
    defaultDailyLimitCents: Decimal,
    defaultApprovalThresholdCents: Decimal,
    roles: z.array(z.object({ roleName: z.string() }).passthrough()),
    /** Which optional parts the template has. A template with neither has no stock and no purchasing (docs/decisions/0084). */
    modules: z.object({ stock: z.boolean(), suppliers: z.boolean() }).optional(),
    /** Descriptive only (docs/decisions/0084): no behaviour reads these yet. */
    dataSources: z.array(z.object({ id: z.string(), label: z.string(), kind: z.string(), readOnly: z.literal(true) })).optional(),
    triggers: z
      .array(z.object({ id: z.string(), kind: z.enum(["schedule", "event", "manual"]), description: z.string() }))
      .optional(),
    outputs: z.array(z.object({ id: z.string(), kind: z.enum(["report", "notice", "order"]), description: z.string() })).optional(),
  })
  .passthrough();

export const TemplateBlueprintSchema = z
  .object({
    referenceTemplateId: z.string(),
    name: z.string(),
    description: z.string(),
    defaultDailyLimitCents: z.number(),
    defaultApprovalThresholdCents: z.number(),
    suggestedRoles: z.array(z.object({ roleName: z.string() }).passthrough()),
    suggestedSuppliers: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()),
    suggestedSupplies: z.array(z.object({ sku: z.string(), name: z.string() }).passthrough()),
  })
  .passthrough();

export const WorkspaceDetailSchema = z
  .object({
    workspace: WorkspaceRowSchema,
    roles: z.array(AgentRoleRowSchema),
    treasuryBalanceCents: Decimal,
    safeAgentTools: z.array(z.string()),
    forbiddenCapabilities: z.array(z.string()),
  })
  .passthrough();

export const PolicyUpdateSchema = z
  .object({
    workspace: WorkspaceRowSchema,
    provenance: z.literal("OWNER_CONFIRMED"),
  })
  .passthrough();

export const AgentsListSchema = z
  .object({
    roles: z.array(AgentRoleRowSchema),
    safeAgentTools: z.array(z.string()),
    forbiddenCapabilities: z.array(z.string()),
  })
  .passthrough();

/**
 * POST /api/demo and POST /api/workspaces/:id/demo/reset (docs/decisions/0057). The token is the demo's owner token, shown once.
 * The expiry is an ISO time about four hours after the answer.
 */
export const DemoCreatedSchema = z
  .object({
    workspaceId: z.string(),
    token: z.string(),
    expiresAt: IsoDateTime,
  })
  .strict();

export const WorkspaceCreateResultSchema = z
  .object({
    message: z.literal("Workspace provisioned"),
    template: TemplateSummarySchema,
    ownerToken: z.object({ id: z.string(), token: z.string() }).passthrough(),
  })
  .passthrough();

export const HealthSchema = z
  .object({
    status: z.literal("ok"),
    postgres: z.literal("connected"),
    timestamp: IsoDateTime,
  })
  .passthrough();

export const ReadySchema = z.object({ status: z.literal("ready") }).passthrough();

/** GET /api/public-config (ADR 0070): the only browser-visible configuration. The Privy app id is public by design. */
export const PublicConfigSchema = z.object({ privyAppId: z.string().min(1).max(128).nullable() }).strict();

/** The document served by GET /api/openapi.json. Its full shape is checked by the OpenAPI tests, not here. */
export const OpenApiDocumentSchema = z
  .object({
    openapi: z.literal("3.0.3"),
    info: z.object({ title: z.literal("Bind API"), version: z.string() }).passthrough(),
    paths: z.record(z.record(z.unknown())),
    components: z.object({ securitySchemes: z.record(z.unknown()) }).passthrough(),
  })
  .passthrough();

// ---------------------------------------------------------------------------------------------------------------------
// People: accounts, sessions, invitations and members (ADR 0051)
// ---------------------------------------------------------------------------------------------------------------------

export const SessionCreateBodySchema = z.object({
  workspaceId: z.string().min(1).max(64),
  displayName: z.string().min(1).max(80).optional(),
});

export const SessionIssuedSchema = z
  .object({ sessionToken: z.string(), expiresAt: IsoDateTime, workspaceId: z.string(), role: Role })
  .passthrough();

export const SignedOutSchema = z.object({ signedOut: z.boolean() }).passthrough();

export const AccountWorkspaceSchema = z.object({ id: z.string(), name: z.string(), role: Role }).passthrough();

export const AccountWorkspaceCreatedSchema = z.object({ id: z.string(), name: z.string(), role: z.literal("owner") }).passthrough();

export const InviteCreateBodySchema = z.object({
  label: z.string().min(1).max(80),
  expiresInHours: z.number().int().min(1).max(336).optional(),
});

export const InviteIssuedSchema = z
  .object({ id: z.string(), code: z.string(), label: z.string(), role: z.literal("staff"), expiresAt: IsoDateTime })
  .passthrough();

export const InviteSummarySchema = z
  .object({
    id: z.string(),
    role: z.literal("staff"),
    label: z.string(),
    createdBy: z.string(),
    expiresAt: IsoDateTime,
    usedAt: IsoDateTime.nullable(),
    revokedAt: IsoDateTime.nullable(),
  })
  .passthrough();

export const InviteAcceptBodySchema = z.object({ code: z.string().min(1).max(128) });

export const MemberSchema = z
  .object({ accountId: z.string(), displayName: z.string().nullable(), role: Role, joinedAt: IsoDateTime })
  .passthrough();

export const MemberRoleBodySchema = z.object({ role: Role });

export const MemberRemovedSchema = z.object({ accountId: z.string(), removed: z.literal(true) }).passthrough();

export const InviteRevokedSchema = z.object({ id: z.string(), revoked: z.literal(true) }).passthrough();

// Owner email notices (ADR 0074). A code is never in any of these answers; only the address and its status are.
export const OwnerEmailRequestBodySchema = z.object({ email: z.string().min(3).max(120) });

export const OwnerEmailVerifyBodySchema = z.object({
  id: z.string().min(1).max(64),
  code: z.string().regex(/^\d{6}$/, "must be six digits"),
});

export const OwnerEmailSummarySchema = z
  .object({
    id: z.string(),
    email: z.string(),
    status: z.enum(["pending", "verified"]),
    expiresAt: IsoDateTime.nullable(),
    verifiedAt: IsoDateTime.nullable(),
    attemptsRemaining: z.number().int().nullable(),
    createdAt: IsoDateTime,
  })
  .passthrough();

export const NotificationChannelsSchema = z
  .object({ emailDelivery: z.enum(["on", "simulated"]), emails: z.array(OwnerEmailSummarySchema) })
  .passthrough();

export const OwnerEmailRequestedSchema = z
  .object({ id: z.string(), email: z.string(), status: z.enum(["pending", "verified"]), expiresAt: IsoDateTime.nullable() })
  .passthrough();

export const OwnerEmailVerifiedSchema = z
  .object({ id: z.string(), email: z.string(), status: z.literal("verified"), verifiedAt: IsoDateTime })
  .passthrough();

export const OwnerEmailRemovedSchema = z.object({ id: z.string(), removed: z.literal(true) }).passthrough();

/**
 * Tab ledger (docs/decisions/0081). Amounts cross the API as decimal strings of micro-USDC, never JSON numbers. The
 * charge body's amount is checked by the route (INVALID_CHARGE_AMOUNT), so a number reaches the route and is refused there.
 */
export const TabChargeBodySchema = z.object({
  counterpartyId: z.string().min(1).max(64),
  // Bounded only so a very long string is refused by the route as INVALID_CHARGE_AMOUNT, never as a shape error.
  amountMicro: z.string().max(64),
  idempotencyKey: z.string().min(1).max(128),
  description: z.string().min(1).max(200),
});

const TabEntrySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  counterpartyId: z.string(),
  kind: z.enum(["charge", "clear", "reversal"]),
  amountMicro: z.string(),
  idempotencyKey: z.string(),
  settlementId: z.string().nullable(),
  description: z.string(),
  createdAt: z.string(),
});

const TabSettlementRowSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  counterpartyId: z.string(),
  amountCents: z.string(),
  status: z.enum(["pending", "submitted", "confirmed", "held", "cancelled"]),
  txHash: z.string().nullable(),
  holdReason: z.string().nullable(),
  submittedAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  confirmedBlock: z.number().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** POST /api/workspaces/:id/tabs/charges: created true (201) or the same charge already recorded (200). */
export const TabChargeResultSchema = z.object({ created: z.boolean(), entry: TabEntrySchema });

/** GET /api/workspaces/:id/tabs: one row per counterparty that has entries. */
export const TabSummarySchema = z.object({
  counterpartyId: z.string(),
  name: z.string(),
  entryCount: z.number(),
  balanceMicro: z.string(),
  settleableCents: z.string(),
});

/** GET /api/workspaces/:id/tabs/:counterpartyId: the balance, the latest entries and settlements. */
export const TabDetailSchema = z.object({
  counterpartyId: z.string(),
  balanceMicro: z.string(),
  settleableCents: z.string(),
  entries: z.array(TabEntrySchema),
  settlements: z.array(TabSettlementRowSchema),
});

/**
 * POST /api/workspaces/:id/tabs/settlements/:settlementId/resolve (docs/decisions/0081). `reconcile` finds and confirms the
 * hash of a held settlement; `cancel_and_restore` restores its clear only when it is provably unsent. Owner only.
 */
export const TabResolveBodySchema = z.object({
  action: z.enum(["reconcile", "cancel_and_restore"]),
  acknowledgeNotSent: z.boolean().optional(),
});

/** GET /api/workspaces/:id/tabs/settlements?status=held: one row per held settlement, oldest change first (at most 50). */
export const TabHeldSettlementSchema = z.object({
  id: z.string(),
  counterpartyId: z.string(),
  amountCents: z.string(),
  status: z.literal("held"),
  holdReason: z.string().nullable(),
  txHash: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  hasEffect: z.boolean(),
  effectStatus: z.string().nullable(),
});

/**
 * The answer to a resolve. `outcome.kind` names what happened: for `reconcile`, `adopted` (with its source, hash and final
 * status) or one of the reasons nothing was adopted (`lookup_unavailable`, `nothing_found`, ...); for `cancel_and_restore`,
 * `cancelled` or `already_cancelled`. A refusal is a 409 NOT_PROVABLY_UNSENT, not a body.
 */
export const TabResolveResultSchema = z.object({
  action: z.enum(["reconcile", "cancel_and_restore"]),
  outcome: z.object({ kind: z.string() }).passthrough(),
});

/**
 * POST /api/workspaces/:id/tabs/:counterpartyId/settle. `outcome` says what the call did: nothing to settle (below_threshold),
 * the amount needs approval, the workspace refused it (paused or over the daily budget), or a settlement was recorded with
 * its status now.
 */
export const TabSettleResultSchema = z.object({
  outcome: z.enum(["below_threshold", "needs_approval", "refused", "settlement", "already_attempted"]),
  balanceMicro: z.string().optional(),
  utcDay: z.string().optional(),
  reason: z.string().optional(),
  amountCents: z.string().optional(),
  thresholdCents: z.string().optional(),
  settlementId: z.string().optional(),
  status: z.enum(["pending", "submitted", "confirmed", "held", "cancelled"]).optional(),
  txHash: z.string().nullable().optional(),
  holdReason: z.string().nullable().optional(),
});
