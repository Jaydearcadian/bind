-- Bind Idempotent Database Schema for PostgreSQL
-- Supports both Kitchen (kitchen-v1) and Digital Agency (agency-v1) Templates

CREATE TABLE IF NOT EXISTS workspaces (
    id VARCHAR(64) PRIMARY KEY,
    name TEXT NOT NULL,
    template_id TEXT NOT NULL, -- 'kitchen-v1', 'agency-v1'
    settlement_address TEXT,
    settlement_mode TEXT NOT NULL DEFAULT 'local', -- 'local', 'arc-testnet'
    budget_daily_limit_cents BIGINT NOT NULL DEFAULT 100000, -- $1,000.00
    approval_threshold_cents BIGINT NOT NULL DEFAULT 25000, -- $250.00
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_roles (
    id VARCHAR(64) PRIMARY KEY,
    workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    role_name TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT,
    permitted_effects TEXT[] NOT NULL DEFAULT ARRAY['read']::TEXT[],
    spending_limit_cents BIGINT NOT NULL DEFAULT 50000,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(workspace_id, role_name)
);

CREATE TABLE IF NOT EXISTS inventory_items (
    id VARCHAR(64) PRIMARY KEY,
    workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    unit TEXT NOT NULL, -- 'kg', 'case', 'box', 'hours', 'units'
    current_quantity NUMERIC(12, 4) NOT NULL DEFAULT 0,
    par_level NUMERIC(12, 4) NOT NULL DEFAULT 10,
    reorder_quantity NUMERIC(12, 4) NOT NULL DEFAULT 20,
    unit_price_cents BIGINT NOT NULL DEFAULT 0,
    preferred_supplier_id TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(workspace_id, sku)
);

CREATE TABLE IF NOT EXISTS suppliers (
    id VARCHAR(64) PRIMARY KEY,
    workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    adapter_type TEXT NOT NULL, -- 'simulated_sysco', 'simulated_baldor', 'parallel_task', 'rest_api'
    contact_email TEXT,
    verified BOOLEAN NOT NULL DEFAULT TRUE,
    is_simulated BOOLEAN NOT NULL DEFAULT TRUE,
    endpoint_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quotes (
    id VARCHAR(64) PRIMARY KEY,
    workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    rfq_id TEXT NOT NULL,
    supplier_id VARCHAR(64) REFERENCES suppliers(id) ON DELETE SET NULL,
    supplier_name TEXT NOT NULL,
    item_sku TEXT NOT NULL,
    quantity NUMERIC(12, 4) NOT NULL,
    unit_price_cents BIGINT NOT NULL,
    total_price_cents BIGINT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USDC',
    valid_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(64) PRIMARY KEY,
    workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    order_number TEXT NOT NULL,
    supplier_id VARCHAR(64) REFERENCES suppliers(id) ON DELETE SET NULL,
    supplier_name TEXT NOT NULL,
    item_sku TEXT NOT NULL,
    item_name TEXT NOT NULL,
    quantity NUMERIC(12, 4) NOT NULL,
    unit_price_cents BIGINT NOT NULL,
    total_price_cents BIGINT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USDC',
    status TEXT NOT NULL, -- 'draft', 'awaiting_approval', 'authorized', 'submitted', 'confirmed', 'fulfilled', 'reconciled', 'cancelled'
    idempotency_key TEXT UNIQUE NOT NULL,
    external_order_ref TEXT,
    tx_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS delivery_receipts (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    received_quantity NUMERIC(12, 4) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    condition_notes TEXT,
    discrepancy_reported BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS supplier_bills (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    bill_number TEXT NOT NULL,
    billed_quantity NUMERIC(12, 4) NOT NULL,
    billed_unit_price_cents BIGINT NOT NULL,
    billed_total_cents BIGINT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USDC',
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS three_way_matches (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    delivery_receipt_id VARCHAR(64) REFERENCES delivery_receipts(id) ON DELETE CASCADE,
    supplier_bill_id VARCHAR(64) REFERENCES supplier_bills(id) ON DELETE CASCADE,
    match_status TEXT NOT NULL, -- 'MATCHED', 'QUANTITY_DISCREPANCY', 'PRICE_DISCREPANCY', 'UNMATCHED'
    variance_cents BIGINT NOT NULL DEFAULT 0,
    notes TEXT,
    matched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS approvals (
    id VARCHAR(64) PRIMARY KEY,
    workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL, -- 'order', 'payout', 'config_change'
    entity_id TEXT NOT NULL,
    action_requested TEXT NOT NULL,
    amount_cents BIGINT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USDC',
    requester_role TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'expired'
    reason TEXT,
    decided_by TEXT,
    decided_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflows (
    id VARCHAR(64) PRIMARY KEY,
    workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    workflow_type TEXT NOT NULL, -- 'kitchen_replenishment', 'agency_milestone', 'customer_fulfilment'
    state TEXT NOT NULL, -- 'draft', 'request_sent', 'quote_received', 'awaiting_approval', 'authorized', 'submitted', 'confirmed', 'reconciled', 'failed', 'cancelled'
    context_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    error_message TEXT,
    retry_count INT NOT NULL DEFAULT 0,
    idempotency_key TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    workflow_id VARCHAR(64),
    actor_type TEXT NOT NULL, -- 'agent', 'owner', 'system', 'webhook'
    actor_id TEXT NOT NULL,
    effect_class TEXT NOT NULL, -- 'read', 'external_request', 'commercial_commitment'
    action TEXT NOT NULL,
    policy_decision TEXT NOT NULL, -- 'ALLOW', 'REQUIRE_APPROVAL', 'DENY'
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    tx_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    workspace_id VARCHAR(64) NOT NULL,
    scope TEXT NOT NULL,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    response_payload JSONB
);

CREATE TABLE IF NOT EXISTS inbound_webhooks (
    id VARCHAR(64) PRIMARY KEY,
    provider TEXT NOT NULL, -- 'whatsapp', 'email', 'telegram', 'stripe', 'supplier'
    event_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'received', -- 'received', 'processed', 'ignored', 'failed'
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    UNIQUE(provider, event_id)
);

-- Studio Extensions (Idempotent Columns & Tables)
ALTER TABLE agent_roles
  ADD COLUMN IF NOT EXISTS allowed_tools TEXT[] NOT NULL DEFAULT ARRAY[
    'get_business_context',
    'get_stock_snapshot',
    'get_approved_supplier_quotes',
    'create_replenishment_proposal',
    'request_policy_evaluation',
    'get_request_status'
  ]::TEXT[];

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS provenance TEXT NOT NULL DEFAULT 'SIMULATED_SUPPLIER_ADAPTER';

CREATE TABLE IF NOT EXISTS surface_bindings (
    id VARCHAR(64) PRIMARY KEY,
    workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    surface TEXT NOT NULL, -- 'whatsapp', 'telegram', 'instagram', 'slack', 'email', 'pos_webhook'
    actor_id TEXT NOT NULL, -- phone number, handle, or email
    actor_label TEXT,
    actor_role TEXT NOT NULL, -- 'owner', 'staff'
    integration_status TEXT NOT NULL DEFAULT 'simulated', -- 'simulated', 'configured_unverified', 'verified'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(workspace_id, surface, actor_id)
);

CREATE TABLE IF NOT EXISTS staged_documents (
    id VARCHAR(64) PRIMARY KEY,
    workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    doc_type TEXT NOT NULL, -- 'quote', 'delivery_receipt', 'supplier_bill'
    source_label TEXT NOT NULL DEFAULT 'manual_upload',
    raw_text TEXT NOT NULL,
    extracted_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT NOT NULL DEFAULT 'staged_unconfirmed', -- 'staged_unconfirmed', 'owner_confirmed', 'rejected'
    linked_order_id VARCHAR(64),
    confirmed_by TEXT,
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS accounting_journal_entries (
    id VARCHAR(64) PRIMARY KEY,
    workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    order_id VARCHAR(64) REFERENCES orders(id) ON DELETE SET NULL,
    entry_number TEXT NOT NULL,
    debit_account TEXT NOT NULL,
    credit_account TEXT NOT NULL,
    amount_cents BIGINT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USDC',
    memo TEXT NOT NULL,
    provenance TEXT NOT NULL DEFAULT 'THREE_WAY_MATCH_VERIFIED',
    tx_hash TEXT,
    idempotency_key TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast workflow queries and audit trails
CREATE INDEX IF NOT EXISTS idx_inventory_sku ON inventory_items(workspace_id, sku);
CREATE INDEX IF NOT EXISTS idx_orders_workspace ON orders(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_workflows_state ON workflows(workspace_id, state);
CREATE INDEX IF NOT EXISTS idx_audit_workspace ON audit_logs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_surface_bindings_ws ON surface_bindings(workspace_id, surface);
CREATE INDEX IF NOT EXISTS idx_staged_docs_ws ON staged_documents(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_journal_ws ON accounting_journal_entries(workspace_id, created_at DESC);
-- One match row per order. Earlier code generated a new id on every reconcile call, so
-- collapse any historical duplicates (keep the first recorded) before enforcing it.
DELETE FROM three_way_matches a
USING three_way_matches b
WHERE a.order_id = b.order_id
  AND (a.matched_at, a.id) > (b.matched_at, b.id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_three_way_matches_order ON three_way_matches(order_id);
