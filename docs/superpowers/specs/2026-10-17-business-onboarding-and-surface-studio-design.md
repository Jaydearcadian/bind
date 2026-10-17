# Bind Business Onboarding & Surface Studio Design Specification

**Date:** 2026-10-17  
**Status:** DRAFT (Under Review)  
**Document:** `docs/superpowers/specs/2026-10-17-business-onboarding-and-surface-studio-design.md`  
**Harness / Standard:** Bind Anti-Drift Architecture, `DESIGN.md`, `BRAND_DIRECTION.md`, `SPEC_DEFINITION.md`

---

## 1. Intent and The Why

Bind's mission is to let a business connect once, configure operating preferences and authority bounds, and get a role-specific agent team that coordinates workflows across real tools and external surfaces safely.

Currently, `/app` provides a read-only operational view of a single demo workspace (`ws-kitchen-main`). In accordance with `BRAND_DIRECTION.md` and `DESIGN.md`, the platform enforces a strict rule:  
> *"Do not expose editable fields that are not connected to backend validation and persisted state."*

To transition from a static demo into a live self-serve operations product, Bind requires an interactive **Business Onboarding & Surface Studio** accessible within `/app` (under the "Business setup" navigation rail and workspace selector). Every form, toggle, file drop, and simulator in this studio must connect to typed, backend-validated Express endpoints that persist to PostgreSQL and the `templates/` filesystem, while labeling provenance honestly (`OWNER_CONFIRMED`, `DOCUMENT_EXTRACTED`, `WEBHOOK_BOUND`, or `DEMO_WORKSPACE`).

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
1. **Interactive Workspace Onboarding**: Allow an operator to create a fresh, clean business workspace with custom business type, referencing existing templates (`kitchen-ops`, `coffee-roaster`) or starting blank, persisting to PostgreSQL (`workspaces`, `inventory_items`, `suppliers`) and scaffolding `templates/<slug>/AGENTS.md`.
2. **Role-Specific Agent Creator & Configurator**: Allow an operator to create, update, or remove agent roles bound to their workspace, setting custom prompts, selecting allowed typed tools (from the safe 6-tool replenishment library), and configuring the TypeSafe Jev System One autonomy threshold.
3. **Multi-Channel Surface Connector**: Allow an operator to configure WhatsApp, Telegram, Instagram, Slack, and Inbound Email channels with verified handles/phone numbers, strictly enforcing role boundaries (`owner` vs `staff`), providing signed webhook URLs, and featuring an interactive in-UI signal simulator.
4. **Document Extraction & 3-Way Match Ingestion**: Allow an operator to upload or paste supplier quotes, delivery packing slips, or vendor invoices. Implement a two-stage `Extract → Confirm` flow with honest provenance (`DOCUMENT_EXTRACTED` → `OWNER_CONFIRMED`) and direct integration into the 3-way match engine and accounting ledger export.
5. **Multi-Workspace Selector in `/app`**: Allow the operator to switch seamlessly between inspecting the seeded `ws-kitchen-main` reference demo and their own active custom workspaces without page reloads.

### Non-Goals
- Building an open-ended "agent marketplace" or speculative third-party app store.
- Direct credit card billing or fiat bank clearing outside the existing USDC/Arc Testnet settlement engine.
- Storing unencrypted plaintext API secrets in browser `localStorage`.

### Anti-Goals
- **No Decorative Forms**: Never render an input or button that does not write to the backend or update persisted state.
- **No Unenforced Permissions**: Never allow an agent prompt to bypass code-enforced spending limits, vendor allowlists, or owner approvals.
- **No Silent Downgrades or Faked Success**: Invariant 10 prohibits masking parse failures, blocked webhooks, or testnet errors with simulated successes.

---

## 3. System Architecture & The 4 Concrete Flows

```
+---------------------------------------------------------------------------------------------------+
|                                 /app (Bind Operations Workspace)                                 |
|                                                                                                   |
|  [ Workspace Switcher: Demo Kitchen (ws-kitchen-main) | My Custom Workspace (ws-xxxx) ]          |
|                                                                                                   |
|  Tab 1: Workspace & Blueprint Setup    Tab 2: Agent Team & Jev Bounds                             |
|  Tab 3: Messaging & Social Surfaces   Tab 4: Documents, Invoices & Accounting                     |
+---------------------------------+---------------------------------+-------------------------------+
                                  |                                 |
                                  v                                 v
+---------------------------------------------------------------------------------------------------+
|                                     Typed Backend API Layer                                      |
|                                                                                                   |
|  POST /api/workspaces/onboard          POST /api/workspaces/:id/agents                           |
|  POST /api/workspaces/:id/surfaces     POST /api/workspaces/:id/documents/extract                |
|  POST /api/workspaces/:id/documents/confirm   GET /api/workspaces/:id/accounting/ledger           |
+---------------------------------+---------------------------------+-------------------------------+
                                  |                                 |
            +---------------------+---------------------+           |
            |                                           |           |
            v                                           v           v
+------------------------+             +---------------------------+--------------------------------+
|  PostgreSQL Database   |             |    Templates Filesystem   |  Policy & Accounting Engines   |
|  - workspaces          |             |  - templates/<slug>/      |  - policy/engine.ts            |
|  - agent_roles         |             |      AGENTS.md            |  - accounting/three-way-match  |
|  - surface_bindings    |             |      skills/...           |  - domain/jevScorer.ts         |
|  - inventory_items     |             |      state/               |  - adapters/socialSurface.ts   |
|  - quotes & orders     |             |                           |                                |
|  - audit_logs          |             |                           |                                |
+------------------------+             +---------------------------+--------------------------------+
```

### Flow 1: Business & Template Onboarding Wizard
- **API Endpoint**: `POST /api/workspaces/onboard`
- **Payload Schema (Zod)**:
  - `workspaceId`: string (`ws-[a-z0-9-]+`)
  - `name`: string (e.g., "Artisan Bakery & Café")
  - `businessType`: `"kitchen" | "cafe" | "retail" | "service" | "custom"`
  - `referenceTemplateId`: optional string (`kitchen-ops` or `coffee-roaster`)
  - `settlementAddress`: EVM address (e.g. Arc Testnet treasury address)
  - `dailyBudgetLimitCents`: positive integer cents
  - `approvalThresholdCents`: positive integer cents
  - `initialSupplies`: array of `{ sku, name, unit, currentQuantity, parLevel, reorderQuantity }`
  - `initialSuppliers`: array of `{ id, name, isVerified, contactEmail, contactPhone }`
- **Execution**:
  1. Inserts record into `workspaces` table (with `template_id = workspaceId`).
  2. Seeds `inventory_items` and `suppliers` for this workspace.
  3. Scaffolds `templates/<workspaceId>/AGENTS.md` on disk by cloning the reference template or writing a structured default.
  4. Records an audit log entry with `EffectClass.COMMERCIAL_COMMITMENT` or `READ` attributed to `owner@bind.local`.

### Flow 2: Role-Specific Agent Creator & Configurator
- **API Endpoint**: `POST /api/workspaces/:id/agents` (Create/Update), `DELETE /api/workspaces/:id/agents/:roleId`
- **Payload Schema (Zod)**:
  - `roleName`: string (e.g., `"procurement_agent"`, `"invoice_reconciliation_agent"`, `"shift_lead_agent"`)
  - `displayName`: string (e.g., `"Kitchen Procurement Agent"`)
  - `systemPrompt`: markdown instructions for the agent
  - `allowedTools`: array of strings selected strictly from safe tools:
    `["get_business_context", "get_stock_snapshot", "get_approved_supplier_quotes", "create_replenishment_proposal", "request_policy_evaluation", "get_request_status"]`
    *(Dangerous actions like `transfer_usdc`, raw signing, or direct database mutations are rejected by Zod validation)*.
  - `jevAutonomyThreshold`: number between `0.50` and `1.00` (minimum confidence required to avoid holding for owner).
- **Execution**:
  1. Upserts into `agent_roles` PostgreSQL table.
  2. Updates `templates/<workspaceId>/AGENTS.md` and `templates/<workspaceId>/skills/` on disk via `FilesystemBackend`.
  3. Appends an audit log entry.

### Flow 3: Social & Messaging Surface Connector
- **API Endpoint**: `POST /api/workspaces/:id/surfaces`
- **Payload Schema (Zod)**:
  - `surface`: `"whatsapp" | "telegram" | "instagram" | "slack" | "email"`
  - `actorHandle`: string (e.g., phone number `+14155552671` or handle `@chef_marco`)
  - `role`: `"owner" | "staff"`
  - `signingSecret`: optional webhook HMAC secret
- **In-App Simulator**:
  - Lets the operator test live inbound events directly through `POST /api/webhooks/incoming`:
    1. **Staff Stock Observation**: simulates staff messaging `"flour count is 2 bags"` (`SURFACE_STOCK_OBSERVED`).
    2. **Owner Approval Decision**: simulates owner tapping *"Approve PO-102"* (`SURFACE_OWNER_APPROVAL_DECISION`).
    3. **Agent Pause Toggle**: simulates owner sending emergency stop (`SURFACE_AGENT_PAUSE_TOGGLE`).

### Flow 4: PDF / Document Extractor & Accounting / POS Sync
- **API Endpoints**:
  - `POST /api/workspaces/:id/documents/extract`
    - Ingests base64/raw text of a supplier quote sheet, delivery packing slip, or vendor bill.
    - Runs structured extraction (parsing item lines, pack sizes, quantities, and integer-cent prices) and cross-references against known inventory SKUs.
    - Returns structured extraction payload badged as `DOCUMENT_EXTRACTED (UNCONFIRMED)`.
  - `POST /api/workspaces/:id/documents/confirm`
    - Ingests owner-confirmed items.
    - If Quote: writes to `quotes` table with `valid_until` (24h) and `OWNER_CONFIRMED` provenance.
    - If Invoice / Packing Slip: stages for `three_way_matches` and feeds `evaluateThreeWayMatch` against the selected `order_id`.
  - `GET /api/workspaces/:id/accounting/ledger`
    - Exports standard Double-Entry Journal Entries (`Debit: Inventory Asset`, `Credit: Accounts Payable / USDC Settlement`) for all fulfilled orders in CSV and JSON formats.

---

## 4. UI/UX Specification in `/app` (Business Setup Studio)

The existing "Business setup" navigation item in the `/app` rail will open the **Bind Business & Surface Studio**, organized into 4 cohesive sub-tabs:

1. **Workspace & Blueprint**:
   - Workspace selector dropdown at top (`Demo Workspace: Hearth & Grain Kitchen` vs any configured custom workspaces).
   - "New Business Workspace" button opening the 3-step onboarding card:
     - Step 1: Business Identity & Arc Settlement Address
     - Step 2: Spending Authority & Approval Thresholds
     - Step 3: Starter Items & Suppliers
2. **Agent Roles & Authority**:
   - Live list of active agents with custom prompts, allowed typed tools, and Jev autonomy sliders.
   - "Add Role-Specific Agent" modal with validation preventing unsafe tool selection.
3. **Messaging Surfaces & Webhook Simulator**:
   - Channels list (WhatsApp, Telegram, Instagram, Slack, Email) with registered actor handles and `owner` vs `staff` badges.
   - Webhook URL display with Copy button.
   - Live In-App Simulator card with "Send Test Observation" and "Send Test Approval" buttons that trigger real backend webhook handling and update the workspace live.
4. **Document Ingestion & Accounting Sync**:
   - Drag-and-drop / paste invoice & quote parser with immediate extracted line-item preview table.
   - Two-stage "Confirm & Save Quote" or "Submit to 3-Way Match" actions.
   - Double-entry accounting ledger viewer with "Download CSV Ledger" button.

---

## 5. Security, Invariant, and Data Integrity Safeguards

1. **Integer Cents**: All financial inputs (`dailyBudgetLimitCents`, `approvalThresholdCents`, `unitPriceCents`, `totalPriceCents`) are strictly validated as non-negative integers. No floating point currency.
2. **Actor Role Enforcement**: Inbound webhook signals are validated with `assertSurfaceRoleAuthorized`. A staff phone number cannot execute approvals or release funds.
3. **Template Isolation**: Custom templates scaffolded into `templates/<workspaceId>` are isolated; agents running for `workspaceA` cannot mount or inspect `templates/workspaceB`.
4. **Idempotency**: All created orders, webhooks, and quote insertions use idempotency keys to protect against network retries or duplicate uploads.

---

## 6. Verification and Acceptance Gates

- **Unit Tests**:
  - Test Zod validation for workspace onboarding, agent creation, and surface binding.
  - Test document parsing and line-item extraction with integer-cent math.
- **Integration Tests**:
  - Test creating a blank workspace, configuring an agent, saving a quote from an extracted document, and executing replenishment.
  - Test sending a simulated WhatsApp stock observation webhook that triggers low-stock replenishment, followed by an owner approval webhook.
- **Playwright E2E Tests**:
  - Test switching between workspaces in `/app`.
  - Test adding a new agent role and verifying it appears in the active agent list with `Enforced` badge.
  - Test document extraction preview and confirmation.
- **Local Verification Gate**:
  - `./scripts/verify-local.sh` must remain at **`PASS=10 FAIL_OR_BLOCKED=0`**.
