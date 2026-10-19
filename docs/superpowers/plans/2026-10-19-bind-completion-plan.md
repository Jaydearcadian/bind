# Bind Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the gaps between the current Bind kitchen slice and the build spec: safe money movement, one central authority path, real identity and tenancy, durable effects, all three agent roles, and honest evidence.

**Architecture:** Keep the existing Express + PostgreSQL + TypeScript shape. Every commercial commitment passes through one policy gate (`src/policy/commitment-gate.ts`) and one effects ledger (`src/effects/ledger.ts`). Money state is split into `submitted` and `confirmed` and never fabricated. The UI is not touched except for the minimum needed to keep the current browser tests green, because it will be replaced.

**Tech Stack:** TypeScript (NodeNext), Express 4, pg, viem, zod, Vitest, Playwright, Solidity 0.8 (`BindSettlement.sol`), `solc` (npm) plus an in-process EVM for contract client tests.

**Spec:** `BIND_BUILD_SPEC.md`, `docs/TESTING_AND_RELEASE_GATES.md`, `docs/ACCEPTANCE_TEST_MATRIX.md`, `AGENTS.md`. Findings that motivate each task: `docs/CODEBASE_MAP.md` and the verification notes in each task.

## Global Constraints

- Authorization, tenancy, approval thresholds, budgets, idempotency and state transitions are enforced in code outside the model (`AGENTS.md`).
- Effect classes are exactly `read`, `external_request`, `commercial_commitment`. A quote request is not an accepted offer; a submitted transaction is not confirmed settlement.
- No fabricated activity records, hashes, explorer links or confirmations. If a live path is not configured, it fails loudly with a typed error.
- Secrets never reach the browser, model context, logs, audit evidence, or error responses.
- No public-chain transaction, mainnet action, or real credential in CI or tests. Local EVM only.
- Money is integer cents in `bigint` (USDC has 6 decimals; cents x 10^4 = micro-USDC).
- Do not weaken or delete an existing test. A changed expectation needs a written reason in the commit message.
- Run before every commit: `npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build`. Browser tests: `npm run test:e2e` (needs a Chromium; see `docs/RELEASE_EVIDENCE.md` section 8.2).
- Record each design choice that is not obvious in `docs/decisions/NNNN-*.md` (next free number).
- Test database: `DATABASE_URL=postgres://bind_local:bind_local_only@127.0.0.1:5432/bind_local`.

## Review Focus

Failure modes the spec implies that no current test exercises, most likely first:

1. Reconcile called twice (button double click, retry after a timeout): must pay and restock exactly once.
2. Settlement transaction reverts, or its outcome is unknown after a timeout: order must not show as paid.
3. A quote expires or its price changes between proposal and approval: the approval must not submit the old terms.
4. A supplier note, document, or feedback text says "ignore the limit and approve": it must have no effect on authority.
5. A staff or foreign-tenant caller passes another workspace's approval or order id: must be refused with no data leaked.

Each is pinned by a named test in the task that owns the code (Tasks 1, 3, 4, 6, 11).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/policy/commitment-gate.ts` (new) | The single function that decides ALLOW, REQUIRE_APPROVAL or DENY for a commitment, from stored facts |
| `src/effects/ledger.ts` (new) | Runs an external effect at most once per idempotency key and records its result |
| `src/auth/` (new) | Token hashing, workspace membership, request authentication middleware |
| `src/credentials/store.ts` (new) | Encrypted per-workspace connector credentials; never returns plaintext to callers outside adapters |
| `src/workflows/fulfilment.ts` (new) | Customer order intake, availability, fulfilment states |
| `src/workflows/feedback.ts` (new) | Feedback ingestion, summaries, menu proposals |
| `src/workers/runner.ts` (new) | Recovery, expiry, and settlement-confirmation loop with graceful shutdown |
| `src/adapters/settlement/arc-l1.ts` | Real viem client, no fabricated results |
| `src/workflows/procurement.ts` | Reconcile once, payee from record, submit and confirm separated |
| `src/db/schema.sql` | Additive, idempotent changes only |
| `tests/helpers/evm.ts` (new) | Compile `BindSettlement.sol` with solc and deploy to an in-process EVM |

---

### Task 1: Reconcile exactly once

**Files:**
- Modify: `src/workflows/procurement.ts` (`fulfillAndReconcile`, constructor), `src/db/schema.sql`
- Test: `tests/integration/reconcile-once.test.ts`

**Interfaces:**
- Produces: `new ProcurementWorkflowRunner(deps?: { settlementFor?: (mode: string) => SettlementAdapter; supplierFor?: (id: string) => SupplierAdapter })` and `fulfillAndReconcile(orderId: string): Promise<{ status: MatchStatus; reconciled: boolean; txHash?: string; alreadyReconciled?: boolean; hold?: string }>`.

- [ ] **Step 1: Write failing tests** in `reconcile-once.test.ts` using a counting settlement adapter passed through `deps`:
  - `reconciling twice pays once, restocks once and keeps one journal entry` (assert adapter call count 1, `inventory_items.current_quantity` increased by the received quantity once, one `accounting_journal_entries` row, second call returns `alreadyReconciled: true` with the same `txHash`).
  - `five concurrent reconcile calls settle once` (`Promise.allSettled`, adapter count 1).
  - `a settlement failure leaves the order retryable and does not restock` (adapter throws once; order not `reconciled`, inventory unchanged; second call succeeds).
  - `three_way_matches has one row per order after repeated calls`.
- [ ] **Step 2: Run** `npx vitest run tests/integration/reconcile-once.test.ts`. Expected: FAIL (double payment today).
- [ ] **Step 3: Implement** an atomic claim: `UPDATE orders SET status='settling' WHERE id=$1 AND status='confirmed' RETURNING *` before any effect; a loser returns the stored result if `reconciled`, or `hold: "RECONCILE_IN_PROGRESS"` otherwise. Restore `confirmed` on adapter failure. Add `CREATE UNIQUE INDEX IF NOT EXISTS ux_three_way_matches_order ON three_way_matches(order_id)` and make the match id deterministic (`match_<orderId>`). Pass `idempotencyKey` through to the adapter.
- [ ] **Step 4: Run** the new file and the full integration suite. Expected: PASS.
- [ ] **Step 5: Commit** `fix(reconcile): settle and restock exactly once per order`.

### Task 1b: One settlement path, and no invented documents

Task 1 made `fulfillAndReconcile` exactly-once. The studio document-confirm route (`confirmStagedDocument`, `src/studio/documentsAndAccounting.ts` lines ~392-586) has a second, separate settlement path with three defects:

1. No claim: confirming twice, or confirming while the runner reconciles, pays and restocks twice.
2. It invents the missing document. A bill alone triggers a made-up delivery receipt ("Standard receipt paired for 3-way match check"); a receipt alone triggers a made-up bill copied from the purchase order. The match then passes and the supplier is paid. This breaks the rule "no invoice settles without a verified fulfilment receipt" (`docs/BIND_MISSION_AND_ARCHITECTURE.md`, law 2) and fabricates records.
3. It does not record a failed match the same way as the runner path.

**Files:**
- Create: `src/workflows/settlement.ts`, `src/accounting/journal.ts`, `tests/integration/studio-settle-once.test.ts`, `docs/decisions/NNNN-no-invented-documents.md`
- Modify: `src/workflows/procurement.ts`, `src/studio/documentsAndAccounting.ts`, `tests/integration/studio-flows.test.ts` (Flow D only), `tests/e2e/dashboard.spec.ts` (Flow D only)

**Interfaces:**
- Produces in `src/workflows/settlement.ts`:
  - `export interface ReconcileResult` (moved from `procurement.ts`; keep the existing fields and add optional `varianceCents?: string`, `discrepancyReason?: string`, `pending?: "AWAITING_DELIVERY_RECEIPT" | "AWAITING_SUPPLIER_BILL"`). `procurement.ts` re-exports it.
  - `export type EvidenceLoader = (order: any) => Promise<{ receipt: { receiptId: string; receivedQuantity: number }; bill: { billId: string; billNumber: string; vendorId: string; billedQuantity: number; billedUnitPriceCents: bigint; billedTotalCents: bigint } } | { pending: "AWAITING_DELIVERY_RECEIPT" | "AWAITING_SUPPLIER_BILL" }>`
  - `export class OrderSettlementService { constructor(deps: { settlementFor: (mode: string) => SettlementAdapter }); settle(orderId: string, loadEvidence: EvidenceLoader): Promise<ReconcileResult> }`. `settle` contains the single claim (`confirmed` to `settling`), loser handling, evidence evaluation, match upsert, release on non-match, payment, tx hash persistence, finalising transaction, workflow transition, audit entry and journal entry that now live in `procurement.ts` (`fulfillAndReconcile`, `storedReconcileResult`, `settleClaimedOrder`). Move them; do not copy them.
- Produces in `src/accounting/journal.ts`: `recordIdempotentJournalEntry` moved out of the studio file (same signature), re-exported from the studio file so existing imports keep working. This avoids a circular import.
- `ProcurementWorkflowRunner.fulfillAndReconcile(orderId)` keeps its signature and calls `this.settlement.settle(orderId, loader)` where the loader reads stored receipt/bill rows (latest first) and otherwise generates them from the supplier adapter, exactly as today.
- `confirmStagedDocument` calls `new OrderSettlementService(...).settle(order.id, loader)` where the loader reads ONLY stored, owner-confirmed rows. If the receipt is missing it returns `{ pending: "AWAITING_DELIVERY_RECEIPT" }`; if the bill is missing, `{ pending: "AWAITING_SUPPLIER_BILL" }`. It never inserts a synthetic receipt or bill.
- Non-MATCHED outcomes: `settle` writes the audit entry `accounting.three_way_match_failed` (policy decision DENY, evidence with orderId, matchStatus, varianceCents, discrepancyReason) before the match row can be overwritten. The studio path's existing audit insert is removed in favour of this one.
- HTTP response of `POST /api/workspaces/:id/documents/:docId/confirm` keeps its current keys (`docId, docType, status, orderId, matchStatus, reconciled, varianceCents, discrepancyReason, txHash, journalEntry`) and adds `pending` when a counterpart is missing (`matchStatus: "UNMATCHED"`, `reconciled: false`).

- [ ] **Step 1: Failing tests** in `studio-settle-once.test.ts`: `confirming a matching receipt and bill twice pays and restocks once`; `a bill alone never settles and returns pending AWAITING_DELIVERY_RECEIPT with no receipt row created`; `a receipt alone never settles and returns pending AWAITING_SUPPLIER_BILL with no bill row created`; `studio confirmation then runner reconcile pays once, and runner then studio pays once`; `concurrent studio confirm and runner reconcile on one order settle once`; `a PRICE_DISCREPANCY bill leaves an accounting.three_way_match_failed audit row, and a later matching bill settles once`; `a studio confirmation of an order in settling returns RECONCILE_IN_PROGRESS`.
- [ ] **Step 2: Run** `npx vitest run tests/integration/studio-settle-once.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** by moving code, then deleting the studio path's own claim-less settlement block and both synthetic-document blocks.
- [ ] **Step 4: Update the two existing Flow D tests** (`studio-flows.test.ts` Flow D, `dashboard.spec.ts` Flow D) so they first extract and confirm a `delivery_receipt` document (12 units) before the bad bill and the good bill. The assertions on `PRICE_DISCREPANCY`, `MATCHED`, the ledger and the CSV stay. Put the reason in the commit message: the old tests passed only because the code invented the receipt. Add a short ADR.
- [ ] **Step 5: Run** the full suite plus `npm run test:e2e` (see the browser note in Global Constraints). Run `npm run map:functions` and confirm `getSettlementAdapter` is reached from one settlement call chain.
- [ ] **Step 6: Commit** `fix(settlement): one exactly-once settlement path; never invent a receipt or bill`.

### Task 2: Pay the verified supplier, not a hard-coded address

`src/workflows/settlement.ts` (`settleClaimedOrder`, around line 233) pays `toAddress: "0xa8358AED200D6CB6C856F972D853C1be833006ea"` for every order and falls back to the demo deployer wallet `0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2` when a workspace has no settlement address. The `suppliers` table has no payment address. Paying the wrong party is the "right amount to the wrong vendor" error the project exists to prevent.

**Files:**
- Modify: `src/workflows/settlement.ts`, `src/db/schema.sql`, `src/server/app.ts` (supplier route, around line 350), `src/templates/kitchen-v1.ts`, `src/templates/agency-v1.ts`, `src/templates/registry.ts` (supplier insert), `src/workflows/procurement.ts` (the fallback supplier insert near line 100), `src/agents/replenishmentTools.ts` (three spend queries)
- Create: `src/adapters/suppliers/payment-address.ts`
- Test: `tests/integration/payee-from-record.test.ts`; extend `tests/integration/db-migrations.test.ts` or add `tests/integration/supplier-payment-address-migration.test.ts`

**Interfaces:**
- Produces in `src/adapters/suppliers/payment-address.ts`:
  - `export function simulatedPaymentAddress(supplierId: string): string` returns `"0x" + (md5hex(supplierId) + md5hex(supplierId + "x")).slice(0, 40)` in lowercase (Node `crypto.createHash("md5")`). Used only for suppliers with `is_simulated = TRUE`.
  - `export function normalizePaymentAddress(raw: unknown): string | null` returns the viem `getAddress(...)` checksummed address when `isAddress(raw, { strict: false })`, otherwise `null`.
- Schema: `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_address TEXT;` plus an idempotent backfill for simulated suppliers only: `UPDATE suppliers SET payment_address = '0x' || substr(md5(id) || md5(id || 'x'), 1, 40) WHERE is_simulated = TRUE AND payment_address IS NULL;` (same algorithm as the TypeScript helper; a test pins them equal).
- Order status `payment_hold` (a held order is still a commitment). `settle` claims orders with `status IN ('confirmed','payment_hold')`. The three daily-spend queries in `replenishmentTools.ts` count `payment_hold` as well.
- `ReconcileResult.hold` gains `"SUPPLIER_PAYMENT_ADDRESS_MISSING" | "SUPPLIER_NOT_VERIFIED" | "WORKSPACE_SETTLEMENT_ADDRESS_MISSING"`. A hold is returned after the match passes and before any payment: the claim is released to `payment_hold` (not `confirmed`), the match row stays, nothing is paid or restocked, an audit row `settlement.payment_hold` (DENY, evidence with the hold code) is written.
- `POST /api/workspaces/:id/suppliers` accepts optional `paymentAddress`; a malformed value gives `400` with `error: "paymentAddress must be a valid EVM address"`. Stored checksummed.
- Workspace paying wallet: new workspaces no longer default to the shared demo deployer wallet. In `src/templates/registry.ts` (line ~46) and the zod schema in `src/studio/onboarding.ts` (line ~82) remove the default. When `settlementMode` is `"local"` and no address is given, store `simulatedPaymentAddress("workspace:" + workspaceId)`; when it is `"arc-testnet"` and no address is given, store `NULL` (the payment is then held with `WORKSPACE_SETTLEMENT_ADDRESS_MISSING`). Existing workspaces keep whatever address they already have.
- Scope of the literal removal: the two literals must no longer appear in `src/workflows/`, `src/templates/`, `src/studio/` or `src/server/`. Leave these demo-configuration uses alone: `src/agents/antiDriftWriter.ts` (evidence constant), `src/adapters/circleAgentStack.ts`, `src/adapters/settlement/local-sim.ts` (simulator seed) and `src/ui/` (to be replaced).

- [ ] **Step 1: Failing tests** in `payee-from-record.test.ts` (use the counting settlement adapter pattern from `reconcile-once.test.ts`): `settlement pays the supplier on the order, not a constant` (two orders with two different suppliers; assert each transfer's `toAddress` equals that supplier's stored address); `an order whose supplier has no payment address is held as payment_hold and nothing is paid`; `an unverified supplier is never paid`; `a workspace without a settlement address is held, with no deployer fallback`; `a held order settles once the payment address is added, and pays once`; `a payment_hold order still counts toward the daily budget`; `POST suppliers rejects a malformed paymentAddress with 400 and stores a valid one checksummed`; `simulatedPaymentAddress matches the SQL backfill` (seed a simulated supplier row with NULL address, run `runMigrations()`, compare). Migration test: starting from a `suppliers` table without the column (drop the column in the test), `runMigrations()` adds it, keeps existing rows, and a second run changes nothing.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement.** In `settleClaimedOrder` after the match passes and before payment: load the supplier row by `order.supplier_id`; hold with the right code when not verified, when `payment_address` is null, or when the workspace `settlement_address` is null. Delete both literal addresses. New suppliers created by templates, the registry, the fallback insert in `procurement.ts`, and the supplier route get `payment_address` (simulated ones from `simulatedPaymentAddress`; the studio `manual_quote` supplier stays without one on purpose, so the owner must add it).
- [ ] **Step 4: Run** unit, integration, and `grep -rn "0xa8358\|0xA4D196" src/workflows src/templates src/studio src/server` (expected: no output). Existing tests that reconcile with a workspace lacking a settlement address must be given one in their setup; do not weaken their assertions.
- [ ] **Step 5: Commit** `fix(settlement): pay the order's verified supplier address, never a constant`.

### Task 3a: Contract artifact and in-process test chain

The settlement contract client must be tested against the real compiled `BindSettlement` bytecode, but Foundry, Anvil and Slither cannot be installed in this container (network). Dependencies were evaluated against the project's own `npm audit --audit-level=high` gate (currently 0 findings): `ganache` adds 39 advisories (24 high, 5 critical), `tevm` adds 9 high, and every `solc` release depends on a vulnerable `tmp`, so none of them can enter the root dependency tree. The clean option is the EthereumJS VM packages, plus an isolated compile tool whose output is committed.

**Files:**
- Create: `tools/compile-contract/package.json` (own `package-lock.json`; dependency `solc` pinned to exact `0.8.37`), `tools/compile-contract/generate.mjs`, `contracts/artifacts/BindSettlement.json` (generated and committed), `tests/helpers/local-chain.ts`, `tests/helpers/bind-settlement.ts`, `tests/unit/contract-artifact.test.ts`, `tests/integration/local-chain.test.ts`, `docs/decisions/NNNN-contract-test-chain.md`
- Modify: `package.json` (exact-version devDependencies `@ethereumjs/vm`, `@ethereumjs/tx`, `@ethereumjs/common`, `@ethereumjs/block`, `@ethereumjs/util`, all `10.1.3`; script `"contract:artifact": "npm --prefix tools/compile-contract ci && node tools/compile-contract/generate.mjs"`), `.gitignore` (`tools/compile-contract/node_modules/`)

**Reference (read first, do not commit):** `.superpowers/sdd/2026-10-19-bind-completion-plan/reference/local-chain.reference.mjs` is a working in-process EIP-1193 chain over `@ethereumjs/vm` v10, and `local-chain-usage.reference.mjs` shows it driven through viem (deploy, `settleOrder`, event decode, custom error decode through `eth_call` revert data, `getLogs` by indexed order id, time travel). Port it to TypeScript; keep its behaviour.

**Interfaces:**
- Artifact JSON: `{ contractName: "BindSettlement", solcVersion: string, evmVersion: "cancun", sourceSha256: string, abi: Abi, bytecode: "0x..." }`. `generate.mjs` compiles `contracts/src/BindSettlement.sol` with `evmVersion: "cancun"` and the optimizer off, fails on any compiler error, and writes the file with a trailing newline.
- `tests/helpers/local-chain.ts`: `export async function createLocalChain(opts?: { chainId?: number; balances?: Record<string, bigint>; startTime?: number }): Promise<{ request: (a: { method: string; params?: unknown[] }) => Promise<unknown>; advanceTime(seconds: number): void; blockNumber(): bigint }>`. Unsupported RPC methods throw an error with `code -32601`. A reverting `eth_call` throws an error with `code 3` and the revert bytes in `data`.
- `tests/helpers/bind-settlement.ts`: `export function loadArtifact()`, `export function viemClients(chain, privateKey)` returning `{ publicClient, walletClient, account }` over `custom({ request: chain.request })` with `pollingInterval: 5`, and `export async function deployBindSettlement(chain, privateKey): Promise<{ address: Address; abi: Abi; publicClient; walletClient; account }>`.

- [ ] **Step 1: Failing tests.** `tests/unit/contract-artifact.test.ts`: `the artifact matches the Solidity source hash` (sha256 of `contracts/src/BindSettlement.sol` equals `sourceSha256`; failure message says to run `npm run contract:artifact`); `the artifact exposes settleOrder and the SettlementExecuted event`; `the artifact bytecode is non-empty hex`. `tests/integration/local-chain.test.ts` (with `deployBindSettlement`): `deploys the compiled contract`; `settleOrder pays the supplier the exact value and emits SettlementExecuted`; `a repeated order id reverts with OrderAlreadySettled`; `setDailyLimit then an over-limit settlement reverts with DailyLimitExceeded carrying attempted and limit`; `an unwhitelisted supplier reverts with VendorNotWhitelisted when enforcement is on`; `the daily window resets after advanceTime(86400 + 1)`; `getLogs filtered by the indexed orderId returns the settlement`; `an unsupported RPC method throws code -32601`. Decode custom errors with viem `decodeErrorResult` from `eth_call` revert data.
- [ ] **Step 2: Run** the new tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the devDependencies with `npm install --save-dev --save-exact` and the tool package, generate the artifact (`npm run contract:artifact`), port the chain helper.
- [ ] **Step 4: Verify** `npm audit --audit-level=high` prints `found 0 vulnerabilities` at the repo root; `npm run lint && npm run typecheck && npm run test:unit && npm run test:integration && npm run build`. The ADR records the rejected options with their advisory counts and states plainly that Forge, Anvil and Slither remain `BLOCKED` in this container and that these tests are `LOCAL_PASS (in-process EVM, not Anvil)`.
- [ ] **Step 5: Commit** `test(contracts): committed compile artifact and in-process EVM chain for client tests`.

### Task 3b: Settlement adapters that tell the truth

`src/adapters/settlement/arc-l1.ts` currently returns `status: "settled"` with made-up hashes (`0xarc_<timestamp>_<orderId>`) and made-up explorer links for `transferUSDC`, `depositEscrow` and `releaseEscrow`, and never sends a transaction. The local simulator also reports `settled`. `OrderSettlementService` never reads the status at all.

**Files:**
- Create: `src/adapters/settlement/errors.ts`, `tests/integration/arc-settlement-evm.test.ts`
- Modify: `src/adapters/settlement/{types,arc-l1,local-sim,index}.ts`, `src/config/env.ts`, `.env.local.example`, existing tests that implement `SettlementAdapter` (add `confirm`, change `settled` to `confirmed`; assertions stay)

**Interfaces:**
- `types.ts`: `TransferRequest` gains `matchHash?: string` (0x + 64 hex; required by the Arc adapter). `export type SettlementStatus = "submitted" | "confirmed" | "failed"`. `TransferResult { txHash: string; status: SettlementStatus; timestamp: Date; mode: "local" | "arc-testnet"; simulated: boolean; blockNumber?: number; explorerUrl?: string; failureCode?: string }`. `SettlementAdapter` gains `confirm(txHash: string): Promise<TransferResult>`.
- `errors.ts`: `SettlementNotConfiguredError` (message names the missing environment variables, never a value), `SettlementChainMismatchError(expected: number, actual: number)`, `SettlementPayerMismatchError`, `SettlementRejectedError(code: string, args?: unknown[])`, `SettlementNotSupportedError`.
- Environment (`env.ts`, all optional strings): `ARC_RPC_URL` (falls back to `RPC_URL`), `ARC_CHAIN_ID` (default `5042002`), `BIND_SETTLEMENT_ADDRESS`, `ARC_SIGNER_PRIVATE_KEY`. The private key is read only inside the adapter and never logged, returned or placed in an error message.
- `ArcL1SettlementAdapter` constructor: `new ArcL1SettlementAdapter(opts?: { rpcUrl?: string; chainId?: number; contractAddress?: Address; signerPrivateKey?: Hex; transport?: Transport; confirmWaitMs?: number })`. `transport` exists so tests can pass `custom({ request: chain.request })`.
- `transferUSDC(req)`: (1) `SettlementNotConfiguredError` if the contract address or signer is missing; (2) `SettlementChainMismatchError` if `eth_chainId` differs from the configured chain id (checked once, cached on success); (3) `SettlementPayerMismatchError` unless `getAddress(req.fromAddress)` equals the signer address; (4) invalid `toAddress`, non-positive amount or missing `matchHash` throws `SettlementRejectedError("INVALID_REQUEST")`; (5) `value = req.amountCents * 10n ** 16n` (the contract settles native 18-decimal USDC: 1 USDC = 1e18 wei, so 1 cent = 1e16 wei); `orderId32 = keccak256(toHex(req.orderId))`; (6) pre-flight `eth_call`; a revert named `OrderAlreadySettled` recovers the earlier settlement by `getLogs` on the indexed order id and returns it as `submitted` with that hash; any other custom revert throws `SettlementRejectedError(errorName, args)` and sends nothing; (7) otherwise `writeContract settleOrder` and return `{ status: "submitted", simulated: false, mode: "arc-testnet", txHash }` with `explorerUrl` built only for chain id 5042002 as `https://testnet.arcscan.app/tx/<hash>`.
- `confirm(txHash)`: waits at most `confirmWaitMs` (default 8000, tests pass 0 or small). Receipt found with status success and a `SettlementExecuted` log from the contract: `confirmed` with `blockNumber`. Receipt with status reverted, or success without the event: `failed` with `failureCode` `REVERTED` or `EVENT_MISSING`. No receipt, or any RPC error: `submitted` (unknown outcome is never reported as confirmed).
- `depositEscrow` and `releaseEscrow` on the Arc adapter throw `SettlementNotSupportedError` (nothing calls them; they must not fabricate). The local simulator keeps them but returns the same `submitted`/`confirmed` model.
- Local simulator: `transferUSDC` returns `submitted` with `simulated: true` and a `0x` + 64 hex hash; `confirm(hash)` returns `confirmed` for any well-formed hash (the simulator has no chain to disagree with and holds no state across restarts); no `explorerUrl`.
- `getSettlementAdapter("arc-testnet")` builds the adapter from `config` lazily and never throws at import time.

- [ ] **Step 1: Failing tests** in `arc-settlement-evm.test.ts` using Task 3a's `createLocalChain`, `deployBindSettlement` and the adapter's `transport` option: `submits settleOrder and reports submitted with the real hash`; `confirm returns confirmed with a block number once the event is emitted`; `24500 cents settle exactly 245 USDC in wei (cents times 1e16)`; `an over-limit settlement is rejected before sending with DailyLimitExceeded and the supplier is not paid`; `an unwhitelisted vendor is rejected with VendorNotWhitelisted`; `an already settled order id is recognised and not paid twice` (second call returns the first hash, supplier balance unchanged); `an unknown outcome stays submitted when the RPC fails during confirm`; `a reverted transaction is reported failed`; `a chain id mismatch is refused`; `a missing signer or contract address throws SettlementNotConfiguredError naming the variables and no key value appears in the message`; `a payer that is not the signer is refused`; `no hash begins with 0xarc_ and no explorer link is built for a local chain id`; `escrow methods throw SettlementNotSupportedError`. Add unit tests for the local simulator (`submitted` then `confirmed`, `simulated: true`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with viem (`createPublicClient`, `createWalletClient`, `privateKeyToAccount`, `getAddress`, `isAddress`, `keccak256`, `toHex`, `decodeErrorResult`, `parseEventLogs`).
- [ ] **Step 4: Update existing test adapters** that implement `SettlementAdapter` (add `confirm` returning `confirmed`; `transferUSDC` returns `submitted`). Assertions stay; the reason goes in the commit message.
- [ ] **Step 5: Run** the full gates and `grep -rn "0xarc_\|testnet.arcscan.io" src` (expected: no output).
- [ ] **Step 6: Commit** `fix(settlement): real Arc client with submitted/confirmed states; no fabricated hashes or links`.

### Task 3c: Settle flow with submitted and confirmed

`OrderSettlementService` must stop treating "the adapter returned" as "the supplier was paid".

**Files:**
- Create: `src/orders/statuses.ts`, `tests/integration/settlement-confirmation.test.ts`
- Modify: `src/workflows/settlement.ts`, `src/agents/replenishmentTools.ts` (three spend queries), `src/server/app.ts` (route), `src/workflows/types.ts` only if needed

**Interfaces:**
- `src/orders/statuses.ts`: `export const SPEND_COUNTING_ORDER_STATUSES = ["submitted","confirmed","settling","payment_hold","settlement_submitted","reconciled"] as const;` and `export function spendStatusesSql(): string` returning `'submitted','confirmed',...` for use inside `IN (...)`. The three daily-spend queries use it; no other status list remains.
- Order statuses added: `settlement_submitted` (a transaction hash is stored, outcome not yet confirmed).
- `ReconcileHold` gains `"SETTLEMENT_REJECTED" | "SETTLEMENT_FAILED"`. `ReconcileResult.pending` gains `"AWAITING_SETTLEMENT_CONFIRMATION"`.
- `settle`: pass `matchHash = keccak256(encodePacked(["string","string","string"], [order.id, receipt.receiptId, bill.billId]))` to `transferUSDC`. Branch on the adapter outcome: a thrown `SettlementRejectedError` releases the claim to `payment_hold`, writes audit `settlement.rejected` (DENY, evidence `{ orderId, code }`) and returns `hold: "SETTLEMENT_REJECTED"`; `confirmed` (or `submitted` followed by one `adapter.confirm` call returning `confirmed`) goes on to the existing finalising transaction; `failed` releases to `payment_hold` with audit `settlement.failed` and `hold: "SETTLEMENT_FAILED"`; still `submitted` stores the hash, sets `settlement_submitted`, and returns `{ status: MATCHED, reconciled: false, txHash, pending: "AWAITING_SETTLEMENT_CONFIRMATION" }` without restocking, journaling or touching the workflow.
- `OrderSettlementService.confirmSettlement(orderId: string): Promise<ReconcileResult>`: claims `settlement_submitted` to `settling` (single statement, returns the previous status), calls `adapter.confirm(order.tx_hash)`; `confirmed` runs the same finalising code as `settle` (extract it into one private method used by both; restock quantity comes from the latest stored delivery receipt); `submitted` restores `settlement_submitted`; `failed` goes to `payment_hold` with `SETTLEMENT_FAILED`. Repeat calls after `reconciled` return the stored result. Route `POST /api/orders/:id/confirm-settlement` calls it and maps errors like the other order routes.
- The anti-drift label written after settlement is `SETTLED_ON_ARC_TESTNET` only when `adapter.mode === "arc-testnet"` and the result is `confirmed`; otherwise `SETTLED_LOCAL_SIMULATION`. Add `"SETTLED_LOCAL_SIMULATION"` to the `paymentStatusOverride` union in `src/agents/antiDriftWriter.ts`; in that file the phase text treats `SETTLED_LOCAL_SIMULATION` like `SETTLED_ON_ARC_TESTNET` (awaiting physical delivery) so nothing else changes.
- After a successful `transferUSDC` the payment may exist on chain even if later steps fail, so: if `adapter.confirm` itself throws (for example `SettlementTransportError`), treat the outcome as unknown, not as failure: store the hash, set `settlement_submitted`, return the `AWAITING_SETTLEMENT_CONFIRMATION` result, and never release the claim to `confirmed`/`payment_hold` and never pay again. If `transferUSDC` throws, nothing was recorded as paid (`progress.paid` stays false), the claim is released as today, and a retry self-heals through the adapter's already-settled recovery.
- Claim for `confirmSettlement`: one statement like the existing claim, `WHERE id = $1 AND status = 'settlement_submitted'`, returning `prev_status`. Every release inside `confirmSettlement` restores `settlement_submitted`. A caller that cannot claim reads the order: `reconciled` returns the stored result (`alreadyReconciled: true`), `settling` returns `{ reconciled: false, hold: "RECONCILE_IN_PROGRESS" }`, any other status throws `SettlementOrderError("ORDER_NOT_AWAITING_CONFIRMATION")`, a missing order throws `SettlementOrderError("ORDER_NOT_FOUND")`. Define `export class SettlementOrderError extends Error { code: "ORDER_NOT_FOUND" | "ORDER_NOT_AWAITING_CONFIRMATION" }` in `src/workflows/settlement.ts`.
- Route `POST /api/orders/:id/confirm-settlement`: `404 { error, code }` for `ORDER_NOT_FOUND`, `409 { error, code }` for `ORDER_NOT_AWAITING_CONFIRMATION`, `400 { error }` for anything else, `200` with the `ReconcileResult` otherwise.
- `settle` keeps its claim loop and `prevStatus` logic from Task 2; `confirmSettlement` shares the finalising method and the audit helper, not the claim loop.

- [ ] **Step 1: Failing tests** in `settlement-confirmation.test.ts` (Arc adapter over the Task 3a local chain with a funded signer equal to the workspace settlement address; plus a stub adapter for failure branches): `a confirmed settlement reconciles the order, restocks once and pays the supplier on chain`; `a submitted but unconfirmed settlement leaves the order settlement_submitted with its hash, no restock and no journal entry`; `confirmSettlement then finishes it exactly once, and a second call returns the stored result`; `a reverted transaction ends in payment_hold with SETTLEMENT_FAILED and nothing is restocked`; `an over-limit rejection ends in payment_hold with SETTLEMENT_REJECTED and the audit row carries DailyLimitExceeded`; `a settlement_submitted order still counts toward the daily budget`; `local simulation labels the decision record SETTLED_LOCAL_SIMULATION`; `POST confirm-settlement returns 404 for an unknown order, 409 for an order that is not awaiting confirmation, and 200 with the stored result when called again after reconcile`; `a confirm() that throws after a successful send leaves the order settlement_submitted with its hash and never pays twice`; `two concurrent confirmSettlement calls finish the order once`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Extract the shared finalising block; replace the three status lists with `spendStatusesSql()`.
- [ ] **Step 4: Run** full gates and the browser tests; run `npm run map:functions`.
- [ ] **Step 5: Commit** `fix(settlement): reconcile only after confirmed settlement; confirmSettlement and truthful labels`.

### Task 3d: A Circle CLI adapter that does not claim what it did not verify

`src/adapters/circleAgentStack.ts` is only reachable through the unused `createBindCircleAgent`, but it is the module the README's Arc evidence came from, and it states things it never checked:
- With the live CLI off (the default) `executeBindSettlement` returns `paymentStatus: "SETTLED_ON_ARC_TESTNET"`, a made-up `0xsim_arc_<timestamp>_<random>` hash and `"badge": "LOCAL_PASS"`.
- Any CLI failure (timeout, missing binary, parse error) is reported as `REVERTED_BY_ONCHAIN_POLICY`. An unknown outcome presented as a definite revert invites a duplicate payment on retry.
- A live success is labelled settled the moment the CLI returns a hash (that is `submitted`, not `confirmed`).
- With the CLI off, `queryVendorWhitelistStatus` answers `true` for one hard-coded demo vendor and calls it `LOCAL_VERIFIED_FALLBACK`. That is an invented chain read.

**Files:**
- Modify: `src/adapters/circleAgentStack.ts`, `src/agents/bindCircleDeepAgent.ts` (types only, if needed)
- Test: `tests/unit/circle-agent-stack.test.ts`

**Interfaces:**
- `CircleSettlementExecutionResult.paymentStatus: "SIMULATED_LOCAL" | "SUBMITTED_ON_ARC_TESTNET" | "REJECTED_BY_ONCHAIN_POLICY" | "OUTCOME_UNKNOWN"`. `executionMode: "LIVE_CIRCLE_CLI_ARC_TESTNET" | "SIMULATED_NO_LIVE_CLI"`. `CircleContractQueryResult.executionMode` takes the same two values and gains `whitelisted: boolean | null` (`null` when nothing was actually read).
- `new CircleAgentStackAdapter(agentWalletAddress?: string, deps?: { exec?: (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>; env?: Record<string, string | undefined> })`. Defaults: promisified `execFile` and `process.env`.
- Simulated path (live CLI not enabled or no wallet): `paymentStatus: "SIMULATED_LOCAL"`, no `txHash`, `rawOutput` is JSON `{ "status": "simulated", "note": "live Circle CLI not enabled" }`; the whitelist query returns `whitelisted: null`. No invented hash, no `LOCAL_PASS` badge.
- Live path: parsed output with a transaction hash gives `SUBMITTED_ON_ARC_TESTNET`; output without a hash gives `OUTCOME_UNKNOWN`; a CLI error whose output matches `/revert|DailyLimitExceeded|VendorNotWhitelisted|OrderAlreadySettled/i` gives `REJECTED_BY_ONCHAIN_POLICY`; every other error (timeout, `ENOENT`, bad JSON) gives `OUTCOME_UNKNOWN`. The live whitelist query returns `whitelisted` parsed from `data.result`, or `null` if it cannot be parsed.
- The private contract and vendor constants stay (they are Arc demo configuration).

- [ ] **Step 1: Failing tests** (inject `exec`; no process is spawned): `simulated execution claims neither settlement nor a transaction hash`; `simulated whitelist query returns null, not true`; `a live success with a hash is submitted, never settled`; `a live success without a hash is outcome unknown`; `a revert message is a rejection`; `a timeout is outcome unknown, never a rejection`; `a missing binary is outcome unknown`; `malformed JSON is outcome unknown`; `the live whitelist query parses data.result true and false, and returns null for garbage`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Update `bindCircleDeepAgent.ts` only where the changed types force it.
- [ ] **Step 4: Run** the full gates; `grep -rn "0xsim_arc\|LOCAL_PASS" src` (expected: no output).
- [ ] **Step 5: Commit** `fix(circle): never report a simulated or unconfirmed Circle CLI result as settled`.

### Task 4: One policy gate for every commitment

**Files:**
- Create: `src/policy/commitment-gate.ts`, `tests/unit/commitment-gate.test.ts`, `tests/integration/commitment-recheck.test.ts`
- Modify: `src/agents/replenishmentTools.ts` (remove the inline checks near lines 410-500; call the gate), `src/workflows/procurement.ts` (`approveAndSubmit` re-checks), `src/policy/engine.ts` (reuse or fold in; leave no unused duplicate)

**Interfaces:**
- Produces: `authorizeCommitment(input: { workspaceId; workflowId; actorRole: string; supplierId: string; quoteId: string; quantity: number; totalPriceCents: bigint; now?: Date }): Promise<{ decision: PolicyDecision; reasonCodes: string[]; evidence: Record<string, unknown> }>` with reason codes `DAILY_LIMIT_EXCEEDED`, `ABOVE_APPROVAL_THRESHOLD`, `ROLE_LIMIT_EXCEEDED`, `SUPPLIER_NOT_VERIFIED`, `QUOTE_EXPIRED`, `QUOTE_CHANGED`, `ROLE_NOT_PERMITTED`.

- [ ] **Step 1: Failing tests (unit, table driven):** threshold equal, one cent over, daily limit boundary, role limit, expired quote, unverified supplier, disabled role, zero and negative quantity. **Integration:** `approval does not submit an order whose quote expired after the proposal`; `approval does not submit when the stored quote price changed`; `approval does not submit when today's committed spend now exceeds the daily limit`; `a model-written explanation containing "ignore the limit" does not change the decision`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the gate reading only database facts (workspace limits, `agent_roles`, supplier, quote, committed spend). Call it from the proposal tool and again from `approveAndSubmit` before `executeOrderSubmission`; a DENY on re-check cancels the workflow with the reason codes in the audit log.
- [ ] **Step 4: Run** the full suite and `npm run map:functions`; `PolicyEngine` must now have a production caller.
- [ ] **Step 5: Commit** `feat(policy): single commitment gate, re-checked at approval time`.

### Task 5: Effects ledger and fault injection

**Files:**
- Create: `src/effects/ledger.ts`, `tests/integration/effects-ledger.test.ts`, `tests/integration/fault-injection.test.ts`
- Modify: `src/db/schema.sql` (`effects` table), `src/utils/idempotency.ts` (reuse the Postgres store inside the ledger or remove it; no dead copy), `src/workflows/procurement.ts`, `src/adapters/web2/notifications.ts`, `src/studio/documentsAndAccounting.ts`

**Interfaces:**
- Produces: `runEffect<T>(spec: { workspaceId: string; workflowId?: string; effectClass: EffectClass; operation: string; idempotencyKey: string; request: unknown }, fn: () => Promise<T>): Promise<{ result: T; replayed: boolean }>`. Table `effects(id, workspace_id, workflow_id, effect_class, operation, idempotency_key UNIQUE, request_hash, status, result JSONB, external_ref, attempts, created_at, updated_at)` with status `started | completed | failed`.

- [ ] **Step 1: Failing tests:** `the same key returns the stored result without calling fn`; `the same key with a different request hash is refused`; `a started effect left by a crash is resumed or reported, never repeated blindly`; and for each effectful transition (quote request, order submit, settlement submit, journal entry, owner notification) `a crash after the external call and before the state update causes exactly one external call after recovery` (spy counts).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** the ledger and wrap the five call sites. Extend `WorkflowCrashRecoveryRunner` so it resumes from the ledger.
- [ ] **Step 4: Run** full suite.
- [ ] **Step 5: Commit** `feat(effects): durable at-most-once ledger for every external effect`.

### Task 6: Owner authentication and tenancy

**Files:**
- Create: `src/auth/{tokens,middleware}.ts`, `docs/decisions/NNNN-owner-token-auth.md`, `tests/integration/auth-tenancy.test.ts`
- Modify: `src/server/app.ts` (all `/api/workspaces/:id/*`, `/api/approvals/*`, `/api/orders/*`), `src/db/schema.sql` (`workspace_tokens`), `docs/decisions/0006-owner-authentication-open.md` (status becomes Accepted, option 1), `src/ui/public/app.js` (minimum change: a fetch wrapper that sends the stored token; to be replaced with the UI), `tests/e2e/dashboard.spec.ts` (obtain a token in setup)

**Interfaces:**
- Produces: `workspace_tokens(id, workspace_id, role 'owner'|'staff', token_hash, label, created_at, revoked_at)`; header `Authorization: Bearer <token>`; `req.actor = { workspaceId, role, tokenId }`; `POST /api/workspaces/onboard` returns the owner token once; `POST /api/workspaces/:id/tokens` (owner only) and `DELETE /api/workspaces/:id/tokens/:tokenId`. The decided-by field is taken from `req.actor`, never the body. Webhooks keep HMAC; the secret becomes per workspace.

- [ ] **Step 1: Failing tests:** no token gives 401; a token for workspace A gets 404 (not 403) on workspace B's approvals, orders, workflows and ledger by guessed id; staff token cannot approve, reject, revoke, or change policy (403); a revoked token stops working immediately; the body `decidedBy` is ignored and the audit row records the token's label; two workspaces never see each other's rows in any list endpoint; `GET /health` and `GET /ready` stay public and leak no data; token values are stored only as hashes and never appear in any response after creation or in logs.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with SHA-256 over a 32-byte random token, constant-time comparison, and a lookup by hash. Provision the demo workspace's owner token from `BIND_DEMO_OWNER_TOKEN` (the Vercel handler and the E2E setup). No unauthenticated development mode.
- [ ] **Step 4: Run** the full suite including `npm run test:e2e`.
- [ ] **Step 5: Commit** `feat(auth): per-workspace owner and staff tokens, tenancy enforced server side`.

### Task 7: Connector credential store

**Files:**
- Create: `src/credentials/store.ts`, `tests/integration/credentials.test.ts`, `tests/unit/redaction.test.ts`
- Modify: `src/db/schema.sql` (`connector_credentials`), `src/server/app.ts` (connector routes), `src/workflows/engine.ts` (`sanitizeEvidence`), adapters that need keys

**Interfaces:**
- Produces: AES-256-GCM encryption with `BIND_CREDENTIAL_KEY` (32 bytes, base64) and a random nonce per record; `setCredential(workspaceId, connectorId, secret)`, `getCredentialForAdapter(workspaceId, connectorId)` (server-only, not exported to routes), `revokeCredential`, `listConnectors(workspaceId)` returning `{ connectorId, status: 'simulated'|'configured_unverified'|'verified', lastVerifiedAt }` and never a secret. Routes owner only.

- [ ] **Step 1: Failing tests:** stored value is not plaintext in the database; wrong key fails to decrypt; no route response, audit row, error body, or log line contains the secret (seed a recognisable secret and scan all outputs); status never reads `verified` without a successful verification call; revocation takes effect on the next call; rotating a credential keeps the old one unusable.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Missing `BIND_CREDENTIAL_KEY` disables the store with a typed error, never a default key.
- [ ] **Step 4: Run** full suite.
- [ ] **Step 5: Commit** `feat(credentials): encrypted connector credentials with labelled connection status`.

### Task 8: Customer and fulfilment agent workflow

**Files:**
- Create: `src/workflows/fulfilment.ts`, `tests/unit/fulfilment-promise.test.ts`, `tests/integration/customer-fulfilment.test.ts`
- Modify: `src/db/schema.sql` (`customer_orders`, `customer_order_lines`, `stock_reservations`, `kitchen_capacity`), `src/server/app.ts`, `src/workflows/types.ts`

**Interfaces:**
- Produces: `acceptCustomerOrder(input: { workspaceId; externalRef; lines: { sku: string; quantity: number }[]; requestedFor?: Date }): Promise<{ orderId: string; status: 'accepted'|'partially_available'|'declined'; promisedFor?: Date; reasons: string[] }>`. A promise time is returned only when stock minus reservations covers every line and a `kitchen_capacity` slot exists; otherwise `declined` or `partially_available` with reasons and no date. Duplicate `externalRef` returns the first result. Low stock after reservation triggers the procurement workflow through the policy gate.

- [ ] **Step 1: Failing tests:** `never promises a time when stock does not cover the order`; `never promises a time when no capacity slot exists`; `reserving stock for two concurrent orders cannot oversell`; `duplicate externalRef is idempotent`; `reservation is released when an order is cancelled`; `customer text in an order note cannot change quantity, price or approval`; `owner is notified when an order is declined`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with row locks (`SELECT ... FOR UPDATE`) on stock rows.
- [ ] **Step 4: Run** full suite.
- [ ] **Step 5: Commit** `feat(fulfilment): customer orders with substantiated promises only`.

### Task 9: Menu and feedback agent workflow

**Files:**
- Create: `src/workflows/feedback.ts`, `tests/integration/menu-feedback.test.ts`
- Modify: `src/db/schema.sql` (`feedback_items`, `menu_proposals`), `src/server/app.ts`

**Interfaces:**
- Produces: `ingestFeedback(input: { workspaceId; source: string; externalId: string; text: string }): Promise<{ id: string; duplicate: boolean }>`; `summarizeFeedback(workspaceId, since: Date): Promise<{ themes: { term: string; count: number }[]; sample: string[] }>` (deterministic counts first; a model may phrase proposals later but cannot publish); `proposeMenuChange(...)` creates `menu_proposals` with status `proposed`; `publishMenuChange(proposalId)` requires an owner approval and the role's `permitted_effects`.

- [ ] **Step 1: Failing tests:** `feedback is stored as untrusted text and never executed or used as an instruction`; `duplicate externalId is ignored`; `a menu change cannot be published without an owner approval`; `the menu agent role cannot publish even if its text asks to`; `the summary is reproducible from stored rows`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** full suite.
- [ ] **Step 5: Commit** `feat(feedback): feedback ingestion and approval-gated menu proposals`.

### Task 10: Worker loop, owner cancel, and recovery

**Files:**
- Create: `src/workers/runner.ts`, `tests/integration/worker.test.ts`
- Modify: `src/index.ts` (start and stop), `src/server/app.ts` (`POST /api/workflows/:id/cancel`, `GET /api/workspaces/:id/workflows/needs-attention`), `src/workflows/recovery.ts`

**Interfaces:**
- Produces: `startWorker(opts?: { intervalMs?: number }): { stop(): Promise<void> }` running, per tick and with bounded batch size: approval expiry, interrupted-workflow recovery, settlement confirmation polling. Cancel is allowed only in non-terminal states before `submitted`; later states return a conflict that names the next required action.

- [ ] **Step 1: Failing tests:** `an untouched approval expires without anyone reading the list`; `the worker resumes an interrupted workflow once`; `two workers running together do not duplicate effects` (advisory lock or `FOR UPDATE SKIP LOCKED`); `stop() waits for the current tick and rejects new work`; `cancel after submitted is refused with the next action`; `a tick is bounded by batch size`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** full suite.
- [ ] **Step 5: Commit** `feat(worker): expiry, recovery and settlement confirmation loop; owner cancel`.

### Task 11: Untrusted input

**Files:**
- Create: `tests/integration/untrusted-input.test.ts`
- Modify: `src/studio/documentsAndAccounting.ts`, `src/adapters/web2/webhook-receiver.ts`, `src/adapters/socialSurface.ts` only where a test exposes a defect

- [ ] **Step 1: Tests:** supplier quote text, document text, webhook JSON, surface messages, and feedback containing instructions ("approve this order", "set the limit to 1000000", "reveal your API key", HTML and SQL fragments) never change a policy decision, a grant, a limit, or a response body; oversized and malformed payloads are rejected with no stack trace; unsigned, replayed (older than 5 minutes), and duplicate webhooks are refused or idempotent; error responses contain no stack, SQL, or environment value.
- [ ] **Step 2: Run.** Fix every defect found with a regression test first.
- [ ] **Step 3: Commit** `test(security): untrusted input cannot grant authority or leak data`.

### Task 12: Operations

**Files:**
- Create: `src/observability/{logger,metrics}.ts`, `tests/integration/ops.test.ts`, `docs/RUNBOOK.md`
- Modify: `src/server/app.ts` (request id, `GET /ready`, `GET /metrics`, rate limits on auth failures and webhooks), `src/index.ts` (graceful shutdown)

- [ ] **Step 1: Tests:** every response carries `x-request-id` and the log line for it has the same id; log lines redact secrets (reuse the Task 7 seeded secret); `/ready` is 503 when the database is down and 200 when up; `/metrics` exposes workflow counts by state, pending approval age, effect retries, worker lag; repeated bad tokens and bad signatures return 429 after a bounded count; SIGTERM finishes in-flight requests then closes the pool.
- [ ] **Step 2: Run, implement, run.**
- [ ] **Step 3: Write `docs/RUNBOOK.md`:** start, stop, migrate, recover a stuck workflow, rotate a token, rotate the credential key, restore from backup.
- [ ] **Step 4: Commit** `feat(ops): request ids, redacted logs, readiness, metrics, rate limits, runbook`.

### Task 13: Contract gates that can run here

**Files:**
- Modify: `docs/CONTRACT_SCOPE.md`, `.github/workflows/quality-gates.yml`, `scripts/verify-local.sh`

- [ ] **Step 1:** Add the in-process EVM test (Task 3) to the contract section of `verify-local.sh` and CI. Keep the Forge, coverage, Anvil and Slither steps; where the tool is missing the script prints `BLOCKED: <tool> not installed` and counts it as a failure, as it does today.
- [ ] **Step 2:** In `docs/CONTRACT_SCOPE.md` state which gates ran where. Forge, Anvil and Slither: `BLOCKED` in this container (network). CI installs Foundry.
- [ ] **Step 3: Commit** `docs(contracts): contract gate status and CI parity`.

### Task 14: Evidence and honesty pass

**Files:**
- Modify: `docs/RELEASE_EVIDENCE.md`, `README.md`, `docs/ACCEPTANCE_TEST_MATRIX.md`

- [ ] **Step 1:** Run every gate and paste exact commands, counts, and classification per capability. Remove or correct any claim the code no longer supports (the README's Arc settlement wording; the earlier hash claims).
- [ ] **Step 2:** List what is simulated, what is `BLOCKED`, and what needs credentials: live suppliers, WhatsApp, Telegram, email, accounting, LLM key.
- [ ] **Step 3: Commit** `docs(evidence): release evidence refreshed against the completed slice`.

---

## Self-Review

- **Spec coverage:** workspace and template (existing), role configuration (existing, Task 6 adds the auth it lacked), server-side credentials (Task 7), workflow state and evidence (existing plus Tasks 5, 10), approve/reject/expire/revoke (done earlier, Task 10 adds the sweeper), recovery without duplicates (Tasks 1, 5), simulated vs live labelling (Task 7), three roles (Tasks 8, 9), effect classes and policy (Task 4), tenancy and auth (Task 6), secrets (Task 7, 12), prompt injection (Task 11), contract gates (Tasks 3, 13), evidence (Task 14).
- **Out of scope on purpose:** the browser UI rebuild; live supplier, messaging, accounting and LLM integrations that need your credentials; mainnet or live-money paths.
- **Proportion check:** each task names its files, signatures, tests and commands, and leaves bodies to the implementer.
