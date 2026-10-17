# Bind Business Onboarding & Surface Studio Design Specification

**Date:** 2026-10-17  
**Status:** APPROVED  
**Document:** `docs/superpowers/specs/2026-10-17-business-onboarding-and-surface-studio-design.md`  
**Harness / Standard:** Bind Anti-Drift Architecture, `DESIGN.md`, `BRAND_DIRECTION.md`, `SPEC_DEFINITION.md`

---

## 1. Intent and The Why

Bind's mission is to let a business connect once, configure operating preferences and authority bounds, and get a role-specific agent team that coordinates workflows across real tools and external surfaces safely.

In accordance with `BRAND_DIRECTION.md` and `DESIGN.md`, the platform enforces a strict rule:  
> *"Do not expose editable fields that are not connected to backend validation and persisted state."*

To transition from a static demo into a live self-serve operations product, Bind provides an interactive **Business Onboarding & Operations Studio** accessible within `/app`. Every form, toggle, file drop, and simulator in this studio connects to typed, backend-validated Express endpoints that persist to PostgreSQL and the `templates/` filesystem, while labeling provenance honestly (`OWNER_CONFIRMED`, `DOCUMENT_EXTRACTED`, `SIMULATED_EVENT`, `CONFIGURED_INTEGRATION`, or `DEMO_WORKSPACE`).

---

## 2. Non-Negotiable Financial & Agent-Safety Invariants

1. **Model Confidence Never Grants Financial Authority**: An LLM or scorer confidence value can never independently authorize a financial transaction or override a policy limit. Bind's deterministic policy engine (`PolicyEngine`) is the sole authority that decides whether an action is `ALLOW`, `REQUIRE_APPROVAL`, or `DENY` based on counterparty allowlists, role `spending_limit_cents`, workspace `approval_threshold_cents`, and workspace `budget_daily_limit_cents`. Model uncertainty may only escalate an action to `REQUIRE_APPROVAL`, never relax a rule.
2. **Blank Workspace Integrity**: Creating a new business workspace starts genuinely blank—zero fabricated orders, inventory history, invoices, transactions, or agent activity. Reference templates (`kitchen-ops`, `coffee-roaster`) are optional blueprints that only pre-fill owner-editable form fields when explicitly requested.
3. **Database as Canonical Source of Truth**: Agent role permissions, allowed tools, and spending limits are persisted in PostgreSQL (`agent_roles`) and enforced in backend code. `templates/<workspaceId>/AGENTS.md` and skill files are generated as derived artifacts.
4. **Honest Channel & Provenance Attribution**: Simulated events, configured integrations, and live verified channels are explicitly distinguished. No channel is labeled "Connected / Verified" unless real authentication and webhook checks have passed.
5. **Two-Stage Document Extraction (`Extract → Confirm`)**: Uploaded or pasted quotes, packing slips, and bills are parsed into untrusted staged drafts (`DOCUMENT_EXTRACTED`). Only owner confirmation (`OWNER_CONFIRMED`) commits quotes to procurement or links delivery receipts and bills to a Purchase Order for three-way matching.

---

## 3. System Architecture & The 4 Integrated Flows

### Flow A: Business Onboarding & Blank Workspace Creation
- **API Endpoints**:
  - `POST /api/workspaces/onboard`: Creates a genuinely blank workspace (or applies owner-confirmed blueprint fields from an optional reference template) in PostgreSQL (`workspaces`, optional owner-entered `inventory_items` and `suppliers`), generates `templates/<workspaceId>/AGENTS.md`, and logs an owner-attributed audit record.
  - `PUT /api/workspaces/:id/policy`: Updates workspace `budget_daily_limit_cents`, `approval_threshold_cents`, and `settlement_address` with deterministic integer-cent validation.
  - `POST /api/workspaces/:id/inventory` & `POST /api/workspaces/:id/suppliers`: Allows the owner to add/update real inventory SKUs (par level, reorder quantity, unit price cents) and approved suppliers.

### Flow B: Agent Role Creator & Configurator
- **API Endpoints**:
  - `POST /api/workspaces/:id/agents`: Creates or updates a role in `agent_roles` (`role_name`, `display_name`, `description`, `permitted_effects`, `spending_limit_cents`, `allowed_tools`, `enabled`), enforcing that forbidden capabilities (`transfer_usdc`, `raw_signer`, `self_approve_order`, `bypass_policy`) are rejected by Zod and policy validation.
  - Regenerates `templates/<workspaceId>/AGENTS.md` and `templates/<workspaceId>/skills/supply-replenishment/SKILL.md` as derived artifacts from the canonical PostgreSQL state.

### Flow C: Messaging Surfaces & In-App Owner/Staff Simulator
- **Database Persistence (`surface_bindings`)**:
  - Persists registered actor identities (`workspace_id`, `surface`, `actor_id`, `actor_role` = `'owner' | 'staff'`, `integration_status` = `'simulated' | 'configured_unverified' | 'verified'`).
- **API Endpoints**:
  - `GET /api/workspaces/:id/surfaces` & `POST /api/workspaces/:id/surfaces`: Lists and registers workspace surface actor bindings.
  - `POST /api/webhooks/incoming`: Verifies that the inbound event's `(workspaceId, surface, actorId)` matches the registered `actor_role` in PostgreSQL (or explicit role assertions) before executing `SURFACE_STOCK_OBSERVED`, `SURFACE_OWNER_APPROVAL_DECISION`, or `SURFACE_AGENT_PAUSE_TOGGLE`.
- **In-App Simulator**:
  - Interactive simulator in `/app` allowing the operator to dispatch both:
    - Staff stock-count / delivery-note messages (`SURFACE_STOCK_OBSERVED`)
    - Owner approval / rejection messages (`SURFACE_OWNER_APPROVAL_DECISION`)
    - Negative test: Staff attempting to approve an order (verifying deterministic `403 SURFACE_ROLE_VIOLATION` rejection).

### Flow D: Document Extraction, Owner Confirmation, 3-Way Match & Accounting Export
- **Database Persistence (`staged_documents` & `accounting_journal_entries`)**:
  - `staged_documents`: Stores untrusted extracted drafts (`id`, `workspace_id`, `doc_type` = `'quote' | 'delivery_receipt' | 'supplier_bill'`, `raw_text`, `extracted_json`, `status` = `'staged_unconfirmed' | 'owner_confirmed' | 'rejected'`).
  - `accounting_journal_entries`: Idempotent double-entry ledger records (`id`, `workspace_id`, `order_id`, `entry_number`, `debit_account`, `credit_account`, `amount_cents`, `currency`, `tx_hash`, `idempotency_key`).
- **API Endpoints**:
  - `POST /api/workspaces/:id/documents/extract`: Parses uploaded/pasted supplier quote, packing slip, or vendor invoice into integer-cent fields, flags unmatched SKUs or uncertain fields, and saves a `staged_unconfirmed` draft.
  - `POST /api/workspaces/:id/documents/confirm`: Owner confirms the staged draft (with idempotency key):
    - If `quote`: inserts into `quotes` with `OWNER_CONFIRMED` provenance so procurement agents can use it.
    - If `delivery_receipt` + `supplier_bill` (or linked to an active PO `orderId`): records receipt/bill, runs `evaluateThreeWayMatch`, and only on `MATCHED` (`0` variance) allows settlement release and posts an idempotent journal entry.
  - `GET /api/workspaces/:id/accounting/ledger`: Returns JSON or CSV (`?format=csv`) double-entry journal ledger with traceable PO, receipt, bill, and Arc Testnet `tx_hash` provenance.
