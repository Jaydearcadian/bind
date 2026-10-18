# Bind Four-Flow Business Operations Studio Implementation Plan

> **For agentic workers:** Execute vertically slice-by-slice, running unit, integration, and E2E verification gates after each slice.

**Goal:** Build and wire Bind's four-flow Business Onboarding & Operations Studio end-to-end inside `/app` with real PostgreSQL persistence, derived `templates/<workspaceId>/` artifacts, deterministic policy enforcement, messaging surface identity checks, and two-stage `Extract → Confirm` document + 3-way match accounting.

**Spec Reference:** [`docs/superpowers/specs/2026-10-17-business-onboarding-and-surface-studio-design.md`](file:///home/ubuntu/bind/docs/superpowers/specs/2026-10-17-business-onboarding-and-surface-studio-design.md)

---

### Slice 1: Database Schema Extensions & Flow A (Blank Workspace Onboarding, Policy & Template Blueprinting)
- **Files:**
  - Modify `src/db/schema.sql` (add `surface_bindings`, `staged_documents`, `accounting_journal_entries`, and `allowed_tools` column on `agent_roles` idempotently).
  - Create `src/studio/onboarding.ts` (Zod schemas and service functions for blank workspace creation, optional blueprint prefill, inventory/supplier creation, and derived `templates/<workspaceId>/AGENTS.md` + `SKILL.md` generation).
  - Wire routes in `src/server/app.ts`:
    - `POST /api/workspaces/onboard`
    - `PUT /api/workspaces/:id/policy`
    - `POST /api/workspaces/:id/inventory`
    - `POST /api/workspaces/:id/suppliers`

### Slice 2: Flow B (Agent Role Creator, Forbidden Tool Guard & Enforceable Policy Integration)
- **Files:**
  - In `src/studio/onboarding.ts`: Add `AgentRoleConfigSchema` that enforces safe tool allowlists (`get_business_context`, `get_stock_snapshot`, `get_approved_supplier_quotes`, `create_replenishment_proposal`, `request_policy_evaluation`, `get_request_status`) and rejects forbidden capabilities (`transfer_usdc`, `raw_signer`, `self_approve_order`, `bypass_policy`).
  - Ensure `src/agents/replenishmentTools.ts` and `src/policy/engine.ts` enforce the role's `spending_limit_cents` and `enabled` flag from PostgreSQL, and never allow model confidence to bypass `approval_threshold_cents`, `spending_limit_cents`, `budget_daily_limit_cents`, or vendor allowlists.
  - Wire routes in `src/server/app.ts`:
    - `GET /api/workspaces/:id/agents`
    - `POST /api/workspaces/:id/agents`

### Slice 3: Flow C (Messaging Surfaces Identity Mapping & In-App Owner/Staff Simulator)
- **Files:**
  - Modify `src/adapters/socialSurface.ts` to support `whatsapp`, `telegram`, `instagram`, `slack`, `email`, `pos_webhook`, `web_ui` and validate registered actor identities in `surface_bindings` when present.
  - Wire routes in `src/server/app.ts`:
    - `GET /api/workspaces/:id/surfaces`
    - `POST /api/workspaces/:id/surfaces`
    - Enhance `POST /api/webhooks/incoming` to verify workspace actor role against `surface_bindings` (rejecting staff actors attempting `SURFACE_OWNER_APPROVAL_DECISION` even if the payload claims `actorRole: "owner"` when registered as `"staff"` in DB!).

### Slice 4: Flow D (Two-Stage Document Extraction, Owner Confirmation, 3-Way Match & Accounting Export)
- **Files:**
  - Create `src/studio/documentsAndAccounting.ts`:
    - Deterministic + structured parser (`extractDocumentDraft`) for Supplier Quotes, Delivery Packing Slips, and Vendor Bills/Invoices with integer-cent conversion and SKU matching against `inventory_items`.
    - Owner confirmation (`confirmStagedDocument`) with idempotency protection:
      - Confirmed `quote` → inserts into `quotes` (`OWNER_CONFIRMED`) so procurement can select it.
      - Confirmed `delivery_receipt` / `supplier_bill` linked to an `orderId` → inserts into `delivery_receipts` / `supplier_bills`, runs `evaluateThreeWayMatch`, and if both receipt and bill are present and `MATCHED` (`0` variance), executes settlement and records an idempotent double-entry journal entry in `accounting_journal_entries`.
    - Ledger export (`getWorkspaceLedger` + CSV formatter).
  - Wire routes in `src/server/app.ts`:
    - `GET /api/workspaces/:id/documents`
    - `POST /api/workspaces/:id/documents/extract`
    - `POST /api/workspaces/:id/documents/confirm`
    - `GET /api/workspaces/:id/accounting/ledger`

### Slice 5: Integrated Studio UI in `/app` & Comprehensive Test Suite (Unit, Integration, E2E, Negative Paths)
- **Files:**
  - Update `src/ui/public/index.html` and `src/ui/public/app.js` to include the interactive **Business Onboarding & Operations Studio** inside `/app` (`#setupSection`) with workspace switcher (Demo Workspace vs Blank/Custom Workspaces) and all 4 connected studio tabs.
  - Add unit & integration tests (`tests/unit/studio-flows.test.ts`, `tests/integration/studio-end-to-end.test.ts`) covering positive and negative paths (blank workspace creation, forbidden agent tools rejection, unauthorized staff approval rejection, malformed/mismatched invoice 3-way match rejection, idempotent ledger export).
  - Update `tests/e2e/dashboard.spec.ts` to test the Studio flows in real browsers (Desktop & Mobile Chrome).
  - Run `./scripts/verify-local.sh` and confirm `PASS=10 FAIL_OR_BLOCKED=0`.
