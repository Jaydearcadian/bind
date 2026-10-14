# ADR 0001: System Boundaries, Architecture Stack, and Settlement Model

## Status
Accepted

## Context
Bind is a deployment and connectivity layer for business agents. The first vertical is a commercial kitchen with three coordinated roles: Procurement Agent, Customer & Fulfilment Agent, and Menu & Feedback Agent. The system must operate locally, enforce deterministic policy outside of model reasoning, anchor all financial records to verified documents (preventing double-entry accounting errors as analyzed in *Agents and Ledgers in 2026*), and prepare for sub-second USDC settlement on Arc via the Circle Agent Stack.

## Decision

### 1. Selected Technology Stack
* **Language & Runtime**: TypeScript on Node.js v24 LTS (ESM modules).
* **Database & Persistence**: Local PostgreSQL (Dockerized for development/CI, configurable via `DATABASE_URL`) with explicit schema migrations.
* **API & Service Framework**: Express/Node HTTP service with OpenAPI-compliant request validation, strict JSON schemas, and structured error frames.
* **Deterministic Policy Engine**: Pure TypeScript business rules module that classifies actions (`read`, `external_request`, `commercial_commitment`), checks workspace authority, enforces spending caps, and intercepts over-budget actions into `awaiting_approval`.
* **Model Reasoning & Ingestion Layer**:
  * Open models via Nebius Token Factory / Prime Intellect for fast planning and quote comparison.
  * Google GenAI (Gemini) for multimodal invoice and receipt extraction.
  * Jev (TypeSafe AI) for sub-50ms calibrated probabilistic policy routing and prompt-injection defense.
  * Parallel AI Task API (`parallel-cli`) for deep multi-step web intelligence and vendor due diligence.
  * LangSmith for evaluation, tracing, and token monitoring.
* **Accounting & Ledger Controls**:
  * Mandatory three-way matching (Purchase Order $\leftrightarrow$ Fulfillment Receipt $\leftrightarrow$ Vendor Bill).
  * Unique idempotency keys for every event and external mutation.
  * Zero silent rounding: strict arithmetic tolerances with loud error logging.
* **Settlement & Payment Layer**:
  * Settlement mode is environment-gated: `local` (simulated / Anvil mock) by default, `arc-testnet` (`5042002`) for live testnet trials.
  * Circle Agent Stack (`@circle-fin/cli`), Circle Developer-Controlled Wallets, and native USDC contract interfaces (`0x3600000000000000000000000000000000000000`).
  * ERC-8183 Job Escrow contract on Arc Testnet (`0x0747EEf0706327138c69792bF28Cd525089e4583`).

### 2. What Bind Owns vs. What Bind Integrates
* **Bind Owns**:
  1. Workspace lifecycle, tenant isolation, and agent role provisioning.
  2. Operating preference configurations (budgets, approval policies, notification rules).
  3. Deterministic policy enforcement and human-in-the-loop approval workflows.
  4. Durable state orchestration, crash recovery, and idempotent action dispatch.
  5. Owner-facing activity evidence, audit logs, and Web2 notification adapters (WhatsApp, Email, Telegram).
  6. The Kitchen Vertical Slice (Inventory Tracker $\rightarrow$ Supplier RFQ $\rightarrow$ Quote Evaluation $\rightarrow$ Approval $\rightarrow$ Settlement $\rightarrow$ Reconciliation).
* **Bind Integrates**:
  1. Arc L1 blockchain for sub-second settlement and native USDC gas.
  2. Circle Agent Stack for wallet custody, compliance screening, and Gateway unified balances.
  3. External LLM and intelligence providers (Nebius, Gemini, Parallel AI, Jev) as untrusted proposal generators.
  4. External ERPs and accounting systems (Odoo, ERPNext) via verified MCP/REST adapters.

### 3. Solidity Contract Ownership Boundary
* **Decision**: `NOT_APPLICABLE` for custom Bind-owned Solidity in the initial vertical slice.
* **Rationale**: Custom Solidity is not justified when the established standards (Arc native USDC precompile, ERC-8004 Identity Registry, and ERC-8183 Agentic Commerce Escrow) already provide battle-tested onchain trust, escrow, and settlement primitives. Bind implements rigorous client/ABI boundary tests against these contracts, verified locally via Anvil and contract integration mocks.
* **Consequence**: `docs/CONTRACT_SCOPE.md` documents this boundary and references the verified ABI interfaces.

## Consequences
* High test velocity and zero risk of mainnet capital loss during local development.
* Clear architectural separation: LLMs reason and suggest, code deterministically enforces, Arc settles, and business owners approve through familiar Web2 interfaces.
