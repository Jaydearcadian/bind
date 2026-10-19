# Bind Release Evidence Report

**Generated At:** 2026-10-14T11:55:00Z  
**Harness / Branch:** `feature/bind-kitchen-vertical-slice`  
**Execution Directives:** Autonomous `/goal`  
**Hackathon Target:** Tameion Agents Hackathon (Canteen × Circle on Arc L1)  

---

## 1. Executive Summary

Bind is a business agent deployment and authority enforcement platform designed to give businesses role-specific autonomous agent teams that safely connect to internal tools, external counterparties, and settlement rails.

The complete vertical slice has been implemented, validated, and proven locally and on **Arc Testnet** across all 10 verification gates (`PASS=10 FAIL_OR_BLOCKED=0`) in accordance with `BIND_BUILD_SPEC.md`, `RUN_BIND_ONESHOT.md`, and `docs/TESTING_AND_RELEASE_GATES.md`.

Bind owns and has deployed [`BindSettlement.sol`](file:///home/ubuntu/bind/contracts/src/BindSettlement.sol) to **Arc Testnet** via the Arc Canteen RPC, with real on-chain transaction execution, deterministic policy enforcement (24-hour rolling daily spend limit and vendor allowlist), and live verification.

---

## 2. On-Chain Arc Testnet Deployments & Proof-of-Settlement

* **Arc Testnet Chain ID:** `5042002`
* **Arc Canteen RPC:** `https://rpc.testnet.arc-node.thecanteenapp.com/v1/<ARC_RPC_TOKEN>` (token supplied via `ARC_RPC_URL`/`RPC_URL`; not committed)
* **Agent Deployer Wallet:** `0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2`
* **Active Deployed Contract:** [`0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`](https://testnet.arcscan.app/address/0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29)
* **Contract Deployment Tx:** [`0xe152f9ced4c696548c42d629ea88917ca1b810de845407ac0b7c17698245300e`](https://testnet.arcscan.app/tx/0xe152f9ced4c696548c42d629ea88917ca1b810de845407ac0b7c17698245300e)
* **Live On-Chain Policy Verification Transactions**:
  1. `setDailyLimit(1 USDC)`: [`0x388196b8c8fdf16cf600a1f059fa8fa0fde6a710424588eea6f54c0425b5d1ab`](https://testnet.arcscan.app/tx/0x388196b8c8fdf16cf600a1f059fa8fa0fde6a710424588eea6f54c0425b5d1ab)
  2. `setEnforceVendorWhitelist(true)`: [`0x4c8f5b2ca544c05a22caa639d4707cb8c81264ff38044d338d02f6bb7f2d7051`](https://testnet.arcscan.app/tx/0x4c8f5b2ca544c05a22caa639d4707cb8c81264ff38044d338d02f6bb7f2d7051)
  3. `setVendorStatus(0xa835...06ea, true)`: [`0x20f04822e1ea1fe0a79953071207a64db3575bd90e15f0243dc1a4be3575ae2a`](https://testnet.arcscan.app/tx/0x20f04822e1ea1fe0a79953071207a64db3575bd90e15f0243dc1a4be3575ae2a)
  4. `settleOrder(orderId, supplier, matchHash)`: [`0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb`](https://testnet.arcscan.app/tx/0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb)
  5. Unwhitelisted Vendor Revert: Reverts with `VendorNotWhitelisted(address)` (`0x65e822e9`)
  6. Daily Limit Exceeded Revert: Reverts with `DailyLimitExceeded(uint256,uint256)` (`0xef664d6a`)
* **Previous v1 Deployment:** `0x6cb713De75CDB19c3f7e9ACAB10Dc753b7cea96f` (Tx: `0xda20e4449a16f0d0178553acf2bff65b3f9bf376ca13b5e732a5161740fa5ed5`)

---

## 3. Gate Verification Evidence Matrix

| Gate / Layer | Exact Command | Outcome | Evidence Classification |
| :--- | :--- | :--- | :--- |
| **Dependency Audit** | `npm audit --audit-level=high` | `found 0 vulnerabilities` | `LOCAL_PASS` |
| **Linting & Hygiene** | `npm run lint` (`eslint src/ tests/`) | `0 errors, 0 warnings` | `LOCAL_PASS` |
| **Strict Typecheck** | `npm run typecheck` (`tsc --noEmit`) | `0 type errors` | `LOCAL_PASS` |
| **Unit Test Suite** | `npm run test:unit` | `49 passed (49)` | `LOCAL_PASS` |
| **Integration Suite**| `npm run test:integration` | `15 passed (15)` | `LOCAL_PASS` |
| **Playwright E2E** | `npm run test:e2e` | `8 passed (8)` (Desktop + Mobile Chrome) | `LOCAL_PASS` |
| **Production Build** | `npm run build` (`tsc -p tsconfig.build.json`) | Clean compilation to `dist/` | `LOCAL_PASS` |
| **Forge Format** | `cd contracts && forge fmt --check` | `PASS: Forge format check` | `LOCAL_PASS` |
| **Forge Unit/Fuzz/Invariants** | `cd contracts && forge test -vvv` | `10 passed (10)` | `LOCAL_PASS` |
| **Forge Coverage** | `cd contracts && forge coverage` | `100.00% Lines (68/68), 100% Funcs (11/11)` | `LOCAL_PASS` |
| **Master Local Runner**| `bash scripts/verify-local.sh` | **`PASS=10 FAIL_OR_BLOCKED=0`** | `LOCAL_PASS` |
| **Arc Testnet RPC** | `arc-canteen status` | Chain ID 5042002 connected | `LIVE_READ_PASS` |
| **Arc Testnet Deploy**| `forge create --broadcast` | Deployed `0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29` | `VERIFIED_REMOTE` |
| **On-Chain Policy Limits**| `cast send` / `cast call` | Limit configured & breach reverted | `VERIFIED_REMOTE` |
| **On-Chain Vendor Allowlist**| `cast send` / `cast call` | Whitelist active & unwhitelisted reverted | `VERIFIED_REMOTE` |
| **Arc Testnet Settlement**| `cast send` | Settled `0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb` | `VERIFIED_REMOTE` |

---

## 4. Security & Risk Assessment

1. **Model Independence & Deterministic Defense-in-Depth**:
   - Level 1: Off-chain policy engine (`src/policy/`) inspects proposed actions against business rules, budgets, and approval thresholds before network requests or blockchain transactions are signed.
   - Level 2: On-chain smart contract (`BindSettlement.sol`) enforces invariant daily spend limits and vendor allowlists directly in the EVM. Even in the event of an agent key leak or hallucination, funds cannot be sent outside the approved whitelist or in excess of daily caps.
2. **On-Chain Settlement Verification**: Settlement transactions emit events with the 3-way match hash (`keccak256(PO, DeliveryReceipt, SupplierBill)`) on Arc L1.
3. **Double-Spend Prevention**: Every external order and settlement transaction requires a deterministic idempotency key locked in PostgreSQL before network dispatch.
4. **Compliance Screening**: Verified against Circle's compliance screening policies on Arc Testnet.
5. **Secret Redaction**: Server-side credentials, private keys, and session tokens are strictly excluded from client payloads, audit logs, and model transcripts (`[REDACTED]`).

## 5. Live Arc Testnet & Jev/Surface Verification (2026-10-15T22:24:18.999Z)
| Gate / Check | Evidence Classification | Verified Details |
| :--- | :--- | :--- |
| Arc Testnet RPC & Chain ID Verification | `LIVE_READ_PASS` | Connected to https://rpc.testnet.arc-node.thecanteenapp.com/v1/<ARC_RPC_TOKEN> (chainId=5042002, expected=5042002) |
| BindSettlement.sol Deployed Bytecode Verification | `VERIFIED_REMOTE` | Contract 0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29 bytecode length=14716 chars |
| On-Chain Approved Supplier Allowlist Check | `LIVE_READ_PASS` | whitelistedVendors(0xa8358AED200D6CB6C856F972D853C1be833006ea) = true |
| Negative Path: Unapproved Supplier Rejection (VendorNotWhitelisted) | `LIVE_READ_PASS` | Deterministically reverted on Arc Testnet with selector 0x65e822e9; 0 USDC moved |
| Negative Path: Rolling 24h Budget Cap Enforcement (DailyLimitExceeded) | `LIVE_READ_PASS` | Attempted 2.0 USDC > 1.0 USDC cap; deterministically reverted on Arc Testnet with selector 0xef664d6a |
| Confirmed On-Chain USDC Settlement Receipt | `VERIFIED_REMOTE` | Tx 0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb confirmed in block 67155117 on Arc Testnet (status=0x1) |

---

## 6. Four-Flow Business Setup Studio & Subpage Acceptance Matrix (2026-10-17T11:09:17Z)

| Feature / Subpage | Implemented Code | Automated Test Coverage | External / Simulated Boundary | Classification |
| :--- | :--- | :--- | :--- | :--- |
| **Dedicated Subpage Routing, Deep-Link Reload, History & Unsaved Draft Preservation** (`/app`, `/app/workflows/:id`, `/app/approvals`, `/app/evidence`, `/app/setup/*`) | `src/ui/public/index.html`, `src/ui/public/app.js`, `src/server/app.ts` | `tests/e2e/dashboard.spec.ts` (Desktop & Mobile Chrome): direct `page.goto`, `page.reload`, `page.goBack`, `page.goForward`, active `.sidebar-link` state, and unsaved `#onboardWsName` draft preservation | Local Express SPA + browser History API + `localStorage` workspace persistence | `LOCAL_PASS` |
| **Flow A: Blank Workspace Onboarding & Reference Blueprints** (`/app/setup/onboarding`) | `src/studio/onboarding.ts`, `POST /api/workspaces/onboard`, `GET /api/templates/:id/blueprint` | `tests/integration/studio-flows.test.ts` & `tests/e2e/dashboard.spec.ts`: verifies 0 SKUs, 0 Orders, 0 Workflows, blocks overwriting `kitchen-ops` / `coffee-roaster` (`PROTECTED_CANONICAL_TEMPLATES`), and persists added SKUs across reload | PostgreSQL (`workspaces`, `inventory_items`, `suppliers`); canonical templates protected in `templates/` | `LOCAL_PASS` |
| **Flow B: Agent Role Configurator & Forbidden Tool Block** (`/app/setup/agents`) | `src/studio/onboarding.ts`, `POST /api/workspaces/:id/agents`, `syncWorkspaceDerivedTemplateFiles` | `tests/integration/studio-flows.test.ts` & `tests/e2e/dashboard.spec.ts`: verifies `400 FORBIDDEN_CAPABILITY_VIOLATION` on `transfer_usdc`, saves bounded role to PostgreSQL, writes derived `templates/<wsId>/AGENTS.md`, and verifies reload persistence | PostgreSQL canonical source of truth + derived filesystem `AGENTS.md` / `SKILL.md` | `LOCAL_PASS` |
| **Flow C: Messaging Surfaces & Role-Enforced Simulator** (`/app/setup/surfaces`) | `src/adapters/socialSurface.ts`, `POST /api/workspaces/:id/surfaces`, `POST /api/webhooks/incoming` | `tests/integration/studio-flows.test.ts` & `tests/e2e/dashboard.spec.ts`: binds staff WhatsApp handle, verifies staff low-stock report (`200`) triggers held proposal, verifies staff spend approval spoof rejected (`403 SURFACE_ROLE_VIOLATION`), and verifies owner approval (`200`) | Channels without live provider credentials (`SURFACE_PROVIDER_VERIFIED`) are labeled `simulated` or `configured_unverified` | `LOCAL_PASS` |
| **Flow D: Two-Stage Document Extract → Confirm, 3-Way Match & Accounting Ledger** (`/app/setup/documents`) | `src/studio/documentsAndAccounting.ts`, `POST /api/workspaces/:id/documents/extract`, `POST .../confirm`, `GET .../accounting/ledger` | `tests/integration/studio-flows.test.ts` & `tests/e2e/dashboard.spec.ts`: verifies Stage 1 `staged_unconfirmed` (`DOCUMENT_EXTRACTED`), Stage 2 owner quote confirmation (`OWNER_CONFIRMED`), failed 3-way match (`PRICE_DISCREPANCY`, unfulfilled), and passing 3-way match (`MATCHED` + double-entry journal + CSV export) | Deterministic entity/arithmetic parser + PostgreSQL `staged_documents` & `accounting_journal_entries`; external QuickBooks/Xero APIs not live-connected | `LOCAL_PASS` |

---

## 7. Serverless Deployment (Vercel + Neon) and UI Refinement (2026-10-18)

### 7.1 What was deployed
- Public production deployment: <https://bind-gilt.vercel.app> (project `bind`,
  team `jaydearcadians-projects`).
- Single serverless entry `api/index.js` re-exporting `api/_handler.js`, which wraps the
  existing Express app, runs migrations, and provisions `ws-kitchen-main` idempotently.
- Database: Neon (Vercel marketplace integration `neon`, resource `bind-db`), injecting
  `DATABASE_URL` into production/preview/development. No credentials are committed.
- `vercel.json` rewrites `/api/*` and `/health` to the function; everything else to
  `index.html`. Static assets built from `src/ui/public/` into `public/` via
  `npm run build:vercel`.

### 7.2 Repairs required to make it run
| Problem | Root cause | Fix | Classification |
| :--- | :--- | :--- | :--- |
| Function crashed at init (`FUNCTION_INVOCATION_FAILED`) on every request | `deepagents` → `@langchain/langgraph-sdk` vendors an ESM `p-retry` under a CJS bundle; loaded at module init via `bindTemplateAgent.ts` | Lazy dynamic `import("deepagents")` inside the guarded LLM-agent paths (`bindTemplateAgent.ts`, `workflows/procurement.ts`) | `LOCAL_PASS` + `LIVE_READ_PASS` |
| Replenishment aborted with `ENOENT mkdir /var/task/workflows/...` | Derived `.md` artifacts written under read-only `cwd` | `src/utils/artifacts.ts` redirects writes to `/tmp/bind-artifacts` when `VERCEL` is set; writes made best-effort | `LOCAL_PASS` + `LIVE_READ_PASS` |
| `/health` unreachable after rewrite | `/health` was captured by the SPA rewrite | Added explicit rewrite `"/health" → "/api/index"` | `LIVE_READ_PASS` |

### 7.3 Commands and results
```
npm run typecheck                       # pass
npm run lint                            # pass (0 problems)
npm run test:unit                        # 10 files, 49 tests passed
npm run test:integration                 # 5 files, 15 tests passed
npx playwright test tests/e2e/dashboard.spec.ts   # 8 passed (Desktop + Mobile Chrome)
vercel build --yes                       # Build Completed
vercel deploy --prod --yes               # Aliased https://bind-gilt.vercel.app
```

Live endpoint verification against `https://bind-gilt.vercel.app` (all `LIVE_READ_PASS`):

| Check | Result |
| :--- | :--- |
| `GET /` | `200` — SPA landing (`<title>Bind — Your business runs on your rules.</title>`) |
| `GET /app` | `200` — SPA workspace shell |
| `GET /health` | `200` — `{"status":"ok","postgres":"connected", ...}` |
| `GET /api/workspaces`, `/{id}`, `/{id}/workflows|orders|approvals|inventory|agents|surfaces|accounting/ledger|audit`, `/api/templates/kitchen-ops/blueprint` | all `200` |
| `POST /api/workspaces/ws-kitchen-main/replenish {sku:FOOD-FLOUR-50LB}` | `200` → `{state:"confirmed", orderId:"ord_..."}` — workflow + order persisted |
| `POST /api/workspaces/ws-kitchen-main/documents/extract` (quote) then `/confirm` | `201` / `200` — staged `staged_unconfirmed` → `owner_confirmed` |
| `POST /api/workspaces/ws-kitchen-main/surfaces` (bind staff + owner WhatsApp) | `201` |
| `POST /api/webhooks/incoming SURFACE_STOCK_OBSERVED` (staff) | `200` — inventory updated, replenishment triggered → `awaiting_approval` |
| `POST /api/webhooks/incoming SURFACE_OWNER_APPROVAL_DECISION` as **staff** | `403 SURFACE_ROLE_VIOLATION` (negative/security test) |
| `POST /api/webhooks/incoming SURFACE_OWNER_APPROVAL_DECISION` as **owner** | `200` → workflow `confirmed`, order created |

### 7.4 UI refinement
- Added a keyboard skip-link and `main#main-content`.
- Mobile (`<=639px`) inventory table becomes labelled stacked cards via `td[data-label]::before`.
- Badges wrap safely (`max-width:100%; white-space:normal; overflow-wrap:anywhere`); panel
  header and evidence rows wrap on narrow widths.
- No horizontal overflow at 320/375/768/1024/1440 on `/`, `/app`, `/app/workflows`, `/app/evidence`.

### 7.5 Known risks / not verified
- Generated `STATE_ANCHOR.md` / `DECISION_EVIDENCE.md` are **ephemeral** on serverless
  (`/tmp`). Durable evidence is the PostgreSQL record and the API `decisionHash`/audit log.
- The live LLM agent path (`arc-testnet` + `NEBIUS_API_KEY`) inside the serverless function
  is **NOT_RUN**; the langgraph bundle was not exercised in the Vercel runtime.
- Preview deployments were not independently verified; `NODE_ENV` is set for production
  and development but not preview.
- `vercel dev` hijacks the package `dev` script and fails on a type-only import in
  `src/accounting/three-way-match.ts` — pre-existing, does not affect build/deploy.
- `/health` returns `500` with a raw connection error when `DATABASE_URL` is absent;
  `/api/*` degrades gracefully with `503`.


---

## 8. Approval lifecycle slice (2026-10-19)

### 8.1 What changed
- Approvals are decided once. Approve, reject, and revoke move the approval and its workflow in one SQL statement (ADR 0005).
- Expired approvals are refused, marked `expired`, and their workflows cancelled. Listing approvals applies expiry for that workspace only.
- New `POST /api/approvals/:id/revoke`. Reject and revoke cancel the waiting workflow and submit nothing.
- The surface-card reject path now goes through the same engine code. Previously it left the workflow waiting.
- Unknown approval: `404 APPROVAL_NOT_FOUND`. Already decided or expired: `409` with `code`.
- The approval card shows Revoke, and a reject error now shows a message instead of failing silently.
- Not changed: the database schema, the contracts, and the Vercel deployment.

### 8.2 Commands and results (local, from a clean `npm ci`, PostgreSQL 16.15 on 127.0.0.1)
```
npm ci                                  # clean install from package-lock.json
npm run lint                            # exit 0
npm run typecheck                       # exit 0
npm run test:unit                       # 10 files, 49 passed
npm run test:integration                # 6 files, 23 passed (15 existing + 8 new in approval-lifecycle.test.ts)
npm run build                           # exit 0
npx playwright test -c <config with launchOptions.executablePath=/opt/pw-browsers/chromium> tests/e2e/
                                        # 8 passed (Desktop Chrome + Mobile Chrome)
```
Classification: `LOCAL_PASS` for all of the above.

Notes on the browser run:
- `npx playwright test` as written failed before reaching the app. The project pins a Playwright build whose Chromium is not installed here (`chromium_headless_shell-1248` missing). The pre-installed Chromium at `/opt/pw-browsers/chromium` was used through a temporary, untracked config. The repo config is unchanged.
- `forge test` and `forge coverage` were not re-run. `forge` is not installed in this container, and no Solidity changed. The Section 3 results still describe the unchanged contract, and they were not re-verified in this slice.

### 8.3 Known gaps and risks (open)
| Area | Status | Why it matters |
| :--- | :--- | :--- |
| Owner authentication on approval and workspace routes | **Open. See ADR 0006** | Any caller can approve, reject, or revoke, and read any workspace by id. This is the main blocker before real use. |
| Browser test for the Revoke button | `NOT_RUN` | The API path is covered by integration tests. The button is not exercised in a browser. |
| Background expiry sweeper | Not built | Expiry applies on decision and on list read. An untouched approval stays `pending` in the database until someone reads or decides it. |
| Crash injection between approval steps | Not run | The single-statement design should prevent a partial state. A fault-injection test would prove it. |
| Live LLM replenishment agent (`NEBIUS_API_KEY`) | `NOT_RUN` | No key in this environment. |
| Supplier, accounting, and messaging connectors | Simulated | Labelled `SIMULATED_SUPPLIER_ADAPTER` / `simulated`. No live counterparty is connected. |
| Credential store for connectors | Not built | Required by the spec ("connect or configure tools with server-side credential storage"). |
| Workflow cancel by owner (outside approvals) | Not built | Required by the spec's lifecycle, and needed for recovery. |
| Live Vercel deployment | Not redeployed in this slice | Production still runs the previous commit until redeployed and checked. |
