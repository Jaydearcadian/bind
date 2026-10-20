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

-- Payee address for the supplier. Simulated suppliers get a deterministic, clearly simulated
-- address (same algorithm as simulatedPaymentAddress in src/adapters/suppliers/payment-address.ts).
-- Real suppliers stay NULL until the owner records one; settlement holds the order until then.
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_address TEXT;
UPDATE suppliers SET payment_address = '0x' || substr(md5(id) || md5(id || 'x'), 1, 40)
WHERE is_simulated = TRUE AND payment_address IS NULL;

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
    status TEXT NOT NULL, -- 'draft', 'awaiting_approval', 'authorized', 'submitted', 'confirmed', 'settling', 'payment_hold', 'settlement_submitted', 'fulfilled', 'reconciled', 'cancelled'
    idempotency_key TEXT UNIQUE NOT NULL,
    external_order_ref TEXT,
    tx_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Payment record: the amount and the documents that a transfer was sent against. Written in the same statement
-- that stores the transaction hash, so a later confirmation finishes the payment as it was made, never against
-- whatever documents are stored when it is confirmed. NULL on orders that have not been paid.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS settled_amount_cents BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS settled_receipt_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS settled_bill_id TEXT;

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

-- Owner pause switch (ADR 0022). While TRUE the commitment gate denies every commitment and no replenishment starts.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS agents_paused BOOLEAN NOT NULL DEFAULT FALSE;
-- Webhook signing secret version (ADR 0022). Rotation increments it; the secret is derived from the master secret.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS webhook_secret_version INT NOT NULL DEFAULT 1;

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
-- One match row per order, latest evaluation wins (same rule as the studio path).
-- Earlier code generated a new id on every reconcile call. Before collapsing historical
-- duplicates, copy every row about to be removed into an archive; evidence is never
-- deleted without a copy. Re-running adds nothing (archive id is the primary key).
CREATE TABLE IF NOT EXISTS three_way_matches_archive (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL,
    delivery_receipt_id VARCHAR(64),
    supplier_bill_id VARCHAR(64),
    match_status TEXT NOT NULL,
    variance_cents BIGINT NOT NULL DEFAULT 0,
    notes TEXT,
    matched_at TIMESTAMPTZ NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO three_way_matches_archive (id, order_id, delivery_receipt_id, supplier_bill_id, match_status, variance_cents, notes, matched_at)
SELECT a.id, a.order_id, a.delivery_receipt_id, a.supplier_bill_id, a.match_status, a.variance_cents, a.notes, a.matched_at
FROM three_way_matches a
WHERE EXISTS (
  SELECT 1 FROM three_way_matches b
  WHERE b.order_id = a.order_id AND (b.matched_at, b.id) > (a.matched_at, a.id)
)
ON CONFLICT (id) DO NOTHING;
DELETE FROM three_way_matches a
USING three_way_matches b
WHERE a.order_id = b.order_id
  AND (b.matched_at, b.id) > (a.matched_at, a.id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_three_way_matches_order ON three_way_matches(order_id);

-- Durable ledger for external effects (src/effects/ledger.ts). One row per idempotency key. The request is
-- never stored, only its hash. A row left in 'started' or 'failed' is an effect in doubt until reconciled.
CREATE TABLE IF NOT EXISTS effects (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workflow_id VARCHAR(64),
  effect_class TEXT NOT NULL CHECK (effect_class IN ('read', 'external_request', 'commercial_commitment')),
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  result JSONB,
  error_message TEXT CHECK (error_message IS NULL OR char_length(error_message) <= 500),
  external_ref TEXT,
  attempts INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_effects_workspace_status ON effects(workspace_id, status);

-- Per-workspace access tokens (src/auth/tokens.ts, ADR 0021). Only the SHA-256 hash of a token is stored.
-- The plaintext is returned once when it is issued and is never written anywhere.
CREATE TABLE IF NOT EXISTS workspace_tokens (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','staff')),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_workspace_tokens_ws ON workspace_tokens(workspace_id) WHERE revoked_at IS NULL;

-- Connector credentials (src/credentials, ADR 0024). The secret is stored only as AES-256-GCM ciphertext under a key the
-- database does not hold. A revoked row keeps its id and status and loses every secret-bearing column.
CREATE TABLE IF NOT EXISTS connector_credentials (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_id TEXT NOT NULL CHECK (connector_id ~ '^[a-z][a-z0-9_.:-]{1,63}$'),
  kind TEXT NOT NULL CHECK (kind IN ('messaging','supplier','accounting','llm','other')),
  ciphertext BYTEA, nonce BYTEA, auth_tag BYTEA,          -- all three NULL once revoked
  key_id TEXT,                                            -- which key encrypted it
  fingerprint TEXT,                                       -- HMAC(key, secret), first 12 hex; identifies without revealing
  status TEXT NOT NULL CHECK (status IN ('configured_unverified','verified','revoked')),
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (workspace_id, connector_id)
);

-- Customer orders and substantiated promises (Task 8a, ADR 0026). A promise is written only when stock minus active
-- reservations covers every line and a kitchen slot has room. The note is untrusted customer text, stored as data.
CREATE TABLE IF NOT EXISTS customer_orders (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  external_ref TEXT NOT NULL CHECK (char_length(external_ref) BETWEEN 1 AND 120),
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('accepted','partially_available','declined','needs_owner','cancelled','fulfilled')),
  requested_for TIMESTAMPTZ,
  promised_for TIMESTAMPTZ,
  reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  note TEXT,                                   -- untrusted customer text, at most 500 characters, data only
  units INT NOT NULL DEFAULT 0,
  slot_id VARCHAR(64),
  decided_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, external_ref)
);
CREATE TABLE IF NOT EXISTS customer_order_lines (
  id VARCHAR(64) PRIMARY KEY,
  order_id VARCHAR(64) NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0)
);
CREATE TABLE IF NOT EXISTS stock_reservations (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id VARCHAR(64) NOT NULL REFERENCES customer_orders(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL CHECK (status IN ('active','released','consumed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reservations_active ON stock_reservations(workspace_id, sku) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS kitchen_capacity (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL CHECK (ends_at > starts_at),
  capacity_units INT NOT NULL CHECK (capacity_units >= 0),
  used_units INT NOT NULL DEFAULT 0 CHECK (used_units >= 0 AND used_units <= capacity_units),
  UNIQUE (workspace_id, starts_at)
);

-- Feedback and approval-gated menu proposals (Task 9, ADR 0028). Feedback text is untrusted customer or staff text: it is
-- stored and counted, never executed or used as an instruction. A proposal may change only its status and decision fields.
CREATE TABLE IF NOT EXISTS feedback_items (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source ~ '^[a-z][a-z0-9_.:-]{1,39}$'),
  external_id TEXT NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 120),
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 2000),   -- untrusted, data only
  truncated BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, source, external_id)
);

CREATE TABLE IF NOT EXISTS menu_items (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
  available BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- A name is taken for good: a removed item keeps its name, so a later item cannot silently reuse it.
CREATE UNIQUE INDEX IF NOT EXISTS uq_menu_items_name ON menu_items (workspace_id, lower(name));

CREATE TABLE IF NOT EXISTS menu_proposals (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  change JSONB NOT NULL,
  rationale TEXT CHECK (rationale IS NULL OR char_length(rationale) <= 500),   -- untrusted, data only
  source_feedback_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('proposed','approved','rejected','published','cancelled')),
  proposed_by TEXT NOT NULL,
  decided_by TEXT,
  applied JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_menu_proposals_workspace ON menu_proposals (workspace_id, created_at);

-- Immutable after creation (ADR 0028): only status, decided_by, applied and updated_at may change.
CREATE OR REPLACE FUNCTION menu_proposal_fields_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
     OR NEW.change IS DISTINCT FROM OLD.change
     OR NEW.rationale IS DISTINCT FROM OLD.rationale
     OR NEW.source_feedback_ids IS DISTINCT FROM OLD.source_feedback_ids
     OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by THEN
    RAISE EXCEPTION 'menu proposal is immutable after creation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'menu_proposals_immutable') THEN
    CREATE TRIGGER menu_proposals_immutable BEFORE UPDATE ON menu_proposals
      FOR EACH ROW EXECUTE FUNCTION menu_proposal_fields_immutable();
  END IF;
END
$$;
