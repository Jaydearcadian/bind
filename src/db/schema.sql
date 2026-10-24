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
-- Settlement milestones. `submitted` is when the transfer's hash was stored (the order is then `settlement_submitted`);
-- `confirmed` is when the adapter confirmed it and the order was finished. A submitted transfer is not a confirmed
-- settlement, so the two are kept apart. NULL until each milestone is reached.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS settlement_submitted_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS settlement_confirmed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS settlement_confirmed_block BIGINT;

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
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    request_id TEXT
);
-- The request that caused the row, for an event's correlationId (ADR 0053). Null for work no request started (the worker).
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS request_id TEXT;

CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    workspace_id VARCHAR(64) NOT NULL,
    scope TEXT NOT NULL,
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    response_payload JSONB
);

-- Client idempotency keys for the API boundary (ADR 0049). Not the same as idempotency_keys above, which guards internal effects.
CREATE TABLE IF NOT EXISTS api_idempotency (
    workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    token_id VARCHAR(64) NOT NULL,
    key TEXT NOT NULL,
    operation TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('in_progress','done')),
    status_code INTEGER,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, token_id, key)
);
CREATE INDEX IF NOT EXISTS idx_api_idempotency_created ON api_idempotency(created_at);

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
-- Demo workspaces (docs/decisions/0057): a throwaway sandbox that expires. Only a demo has an expiry; a real workspace keeps
-- both columns at their defaults. Token resolution refuses an expired demo, and the worker deletes it (src/demo/purge.ts).
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS demo_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_workspaces_demo_expiry ON workspaces (demo_expires_at) WHERE is_demo;
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
-- The event stream (docs/decisions/0035, src/api/events.ts). Each audit row gets a sequence number and the id of the
-- transaction that wrote it. A reader orders by (txid, seq) and sees only rows whose transaction has finished, so a
-- transaction that commits late is never skipped. Existing rows take this migration's transaction id, which is harmless:
-- a new stream starts from the latest event, not from the start of the table.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS txid xid8 NOT NULL DEFAULT pg_current_xact_id();
CREATE INDEX IF NOT EXISTS idx_audit_events ON audit_logs(workspace_id, txid, seq);
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
-- Query indexes (ADR 0040). The first start builds them, and the build takes a lock that blocks writes to the table while it runs
-- (docs/RUNBOOK.md section 3.1). A name that already exists makes IF NOT EXISTS skip the statement silently, so each name here
-- is new: idx_workflows_state is already (workspace_id, state), so the state-only index is idx_workflows_state_global.
-- Each serves a query across workspaces: metrics (GROUP BY state, GROUP BY status), the worker (settling orders), unresolved effects.
CREATE INDEX IF NOT EXISTS idx_audit_order ON audit_logs ((evidence->>'orderId'));
CREATE INDEX IF NOT EXISTS idx_workflows_state_global ON workflows(state);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_effects_status ON effects(status, updated_at);

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

-- People (ADR 0051). An account is one person's sign-in identity: the Privy user id and nothing else about them is required.
-- Authorization stays here: a membership says which workspaces an account belongs to and in what role.
CREATE TABLE IF NOT EXISTS accounts (
  id VARCHAR(64) PRIMARY KEY,
  privy_user_id TEXT NOT NULL UNIQUE,
  display_name TEXT CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workspace_memberships (
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','staff')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ,
  PRIMARY KEY (account_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_ws ON workspace_memberships(workspace_id) WHERE removed_at IS NULL;

-- Short-lived sessions for a signed-in account, scoped to one workspace. Only the SHA-256 hash of the token is stored.
CREATE TABLE IF NOT EXISTS account_sessions (
  id VARCHAR(64) PRIMARY KEY,
  account_id VARCHAR(64) NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON account_sessions(account_id);

-- Single-use, expiring staff invitations. Only the hash of the code is stored; the code is shown once to the owner.
CREATE TABLE IF NOT EXISTS workspace_invites (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('staff')),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 80),
  created_by TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_by_account VARCHAR(64) REFERENCES accounts(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invites_ws ON workspace_invites(workspace_id);

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

-- Owner email for notices (src/notifications/owner-emails.ts, ADR 0074). One live row per workspace and address. The code is
-- stored only as a salted SHA-256; it is in the email and nowhere else. A verified row is the proof that the owner received
-- the code at this address. A removed row keeps its id and loses no evidence it was ever verified.
CREATE TABLE IF NOT EXISTS owner_emails (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  added_by TEXT NOT NULL,
  email TEXT NOT NULL CHECK (char_length(email) BETWEEN 3 AND 254 AND email = lower(email)),
  code_salt TEXT,
  code_hash TEXT,
  code_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  verified_at TIMESTAMPTZ,
  -- The surface binding this row created, if it created one. Removing the row removes only that binding.
  binding_id VARCHAR(64),
  -- The binding's updated_at when this row created it. Removal deletes the binding only while it is still unchanged, so a
  -- binding the owner later sets through /surfaces survives.
  binding_marker TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  removed_at TIMESTAMPTZ
);
ALTER TABLE owner_emails ADD COLUMN IF NOT EXISTS binding_marker TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_emails_live ON owner_emails(workspace_id, email) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_owner_emails_verified ON owner_emails(workspace_id, verified_at) WHERE verified_at IS NOT NULL AND removed_at IS NULL;

-- Each verification mail sent, so the limit of sends per address per hour survives a removal and a re-add.
CREATE TABLE IF NOT EXISTS owner_email_sends (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_owner_email_sends_addr ON owner_email_sends(workspace_id, email, sent_at);
CREATE INDEX IF NOT EXISTS idx_owner_email_sends_ws ON owner_email_sends(workspace_id, sent_at);

-- One row per wrong code guess for an address (ADR 0074). It is not tied to a code, so a new code does not reset it. Rows
-- older than a day do not count. A successful verification of the address deletes the address's rows.
CREATE TABLE IF NOT EXISTS owner_email_failures (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_owner_email_failures_addr ON owner_email_failures(workspace_id, email, failed_at);

-- Tab ledger (docs/decisions/0081). Sub-cent charges accrue per counterparty in micro-USDC (1e-6 USDC) and a tab is settled
-- in whole cents through the settlement adapter. The counterparty is a supplier of the SAME workspace: the composite key
-- below makes a cross-workspace counterparty a foreign-key error, not only a code check.
CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_workspace_id ON suppliers (workspace_id, id);

-- One row per settlement attempt that was cleared from a tab. The clear entry is written in the same transaction.
-- Status: pending (cleared, not yet sent), submitted (sent, hash stored), confirmed (final), held (cleared, outcome not
-- known or failed; never reversed here), cancelled (refused before anything was sent; its reversal entry restores the balance).
-- A 'held' row with no clear entry is a settlement the gates refused: it owns no balance.
CREATE TABLE IF NOT EXISTS tab_settlements (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  counterparty_id VARCHAR(64) NOT NULL,
  amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'submitted', 'confirmed', 'held', 'cancelled')),
  tx_hash TEXT,
  hold_reason TEXT,
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  confirmed_block BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, counterparty_id) REFERENCES suppliers (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_tab_settlements_status ON tab_settlements (status, updated_at);
CREATE INDEX IF NOT EXISTS idx_tab_settlements_tab ON tab_settlements (workspace_id, counterparty_id, created_at);
-- Reconcile attempts on a held settlement (docs/decisions/0081): the backoff step of the next attempt of a SETTLEMENT_FAILED hold.
ALTER TABLE tab_settlements ADD COLUMN IF NOT EXISTS reconcile_attempts INTEGER NOT NULL DEFAULT 0;

-- Append-only: the code never updates or deletes a row. Balance(counterparty) = sum(charge) - sum(clear) + sum(reversal), in micro-USDC.
-- idempotency_key is namespaced by kind ('charge:<client key>', 'clear:<settlement id>', 'reversal:<settlement id>'), so a client
-- key can never collide with a settlement's entries.
CREATE TABLE IF NOT EXISTS tab_entries (
  id VARCHAR(64) PRIMARY KEY,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  counterparty_id VARCHAR(64) NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('charge', 'clear', 'reversal')),
  amount_micro BIGINT NOT NULL CHECK (amount_micro > 0),
  idempotency_key TEXT NOT NULL,
  settlement_id VARCHAR(64) REFERENCES tab_settlements(id),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (workspace_id, counterparty_id) REFERENCES suppliers (workspace_id, id),
  CONSTRAINT uq_tab_entries_idempotency UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT tab_entries_settlement_link CHECK ((kind = 'charge' AND settlement_id IS NULL) OR (kind <> 'charge' AND settlement_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_tab_entries_tab ON tab_entries (workspace_id, counterparty_id);
CREATE INDEX IF NOT EXISTS idx_tab_entries_settlement ON tab_entries (settlement_id);

-- Per counterparty: when the tab was last attempted, and on which UTC day its end-of-day attempt was claimed (ADR 0081).
-- The claim is one conditional upsert in the same transaction as the reservation, so a crash rolls both back together and a
-- second batch on the same day finds the day claimed. last_attempt_at orders the batch, so no tab starves the others.
CREATE TABLE IF NOT EXISTS tab_attempts (
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  counterparty_id VARCHAR(64) NOT NULL,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_utc_day DATE,
  PRIMARY KEY (workspace_id, counterparty_id),
  FOREIGN KEY (workspace_id, counterparty_id) REFERENCES suppliers (workspace_id, id)
);
