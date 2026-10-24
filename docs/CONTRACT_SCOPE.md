Decision: IN_SCOPE

# Contract Scope & Deployment: BindSettlement on Arc L1

Rewritten 2026-10-20 (Task 13) so that every claim says how it is known. Every fact from the earlier version is kept.

## How to read the labels

- `UNVERIFIED_CLAIM (earlier session; reproduce with: <command>)`: an earlier session stated this. The command is the reproduction the repository provides. This environment has no network access and no Foundry, so none of these claims was re-verified here. Running the command against the live network would verify only the part of the claim the command checks.
- `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`: no script in the repository checks this claim.
- `LOCAL_PASS (<command>)`: checked in this environment by the command shown.
- `BLOCKED` and `NOT_RUN`: as defined in `docs/TESTING_AND_RELEASE_GATES.md`, section 10.

Nothing in this document is a live pass or a remote verification. Those require a recorded run in `docs/RELEASE_EVIDENCE.md`.

Reproduction command used below: `ARC_RPC_URL=<arc-rpc-url-with-token> npx tsx scripts/verify-live-arc.ts`. The script requires `ARC_RPC_URL` (or `ARC_TESTNET_RPC_URL`). Its built-in default contains the literal placeholder `<ARC_RPC_TOKEN>` and cannot be used. Gates 3 to 5 call Foundry's `cast` binary, which must be on `PATH`. The optional `LAST_LIVE_SETTLEMENT_TX=<hash>` overrides the hash that gate 6 checks. Each run appends a table to `docs/RELEASE_EVIDENCE.md`.

## 1. Bind-Owned Smart Contracts

Bind deploys and owns [`BindSettlement.sol`](../contracts/src/BindSettlement.sol):
- **Purpose**: Trustless on-chain milestone escrow, 3-way match hash recording (`keccak256(PO, DeliveryReceipt, SupplierBill)`), deterministic on-chain policy enforcement (rolling 24h daily spend limit, vendor allowlist), and native USDC settlement.
  - Source note (read from `_checkAndUpdateDailyLimit`, not run): the daily limit is a fixed window, not a rolling one. `dailySpent` is reset only when a call arrives at or after `lastDayReset + 1 days`. `lastDayReset` changes only at construction and at that reset. `refundEscrow` subtracts the refunded amount from `dailySpent`.
- **Network**: Arc Testnet (Chain ID `5042002`). `LIVE_READ_PASS` (reproduced 2026-10-22: eth_chainId = 5042002; see docs/RELEASE_EVIDENCE.md, live run). Gate 1 of that script reads `eth_chainId` and compares it with `5042002`.
- **RPC**: Arc Canteen RPC (`https://rpc.testnet.arc-node.thecanteenapp.com/v1/<ARC_RPC_TOKEN>`). The access token is supplied via `ARC_RPC_URL`/`RPC_URL` and is never committed. The adapter reads `ARC_RPC_URL` then `RPC_URL` (`src/adapters/settlement/arc-l1.ts`). The endpoint claim is `LIVE_READ_PASS` (reproduced 2026-10-22: RPC answers; the provider name is not checked; see docs/RELEASE_EVIDENCE.md, live run), since gate 1 connects to it.
- **Deployer / Owner Wallet**: `0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2`. `LIVE_READ_PASS` (reproduced 2026-10-22: owner() = this address and the signer key derives to it; see docs/RELEASE_EVIDENCE.md, live run). No script reads `owner()`.
- **Active Deployed Contract Address**: [`0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`](https://testnet.arcscan.app/address/0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29). `LIVE_READ_PASS` (reproduced 2026-10-22: code present; body matches the artifact except the compiler metadata tail; owner read; see docs/RELEASE_EVIDENCE.md, live run). Gate 2 checks only that the address has non-empty bytecode. It does not compare the bytecode with the artifact and does not check the owner.
- **Deployment Transaction Hash**: [`0xe152f9ced4c696548c42d629ea88917ca1b810de845407ac0b7c17698245300e`](https://testnet.arcscan.app/tx/0xe152f9ced4c696548c42d629ea88917ca1b810de845407ac0b7c17698245300e). `LIVE_READ_PASS` (reproduced 2026-10-22: receipt success, contractAddress is the deployed contract, block 67155017; see docs/RELEASE_EVIDENCE.md, live run).
- **Previous Deployment**: `0x6cb713De75CDB19c3f7e9ACAB10Dc753b7cea96f` (Initial v1 without on-chain policy). `LIVE_READ_PASS` (reproduced 2026-10-22: address has code; the "without on-chain policy" description is not checked; see docs/RELEASE_EVIDENCE.md, live run).

Local check of the committed artifact: `LOCAL_PASS (npx vitest run tests/unit/contract-artifact.test.ts)`. It confirms that `contracts/artifacts/BindSettlement.json` carries the SHA-256 of the current `contracts/src/BindSettlement.sol`. It does not show that any deployment uses that bytecode.

## 2. On-Chain Policy Verification (Live Arc Testnet)

1. **Daily Spend Limit (1.0 USDC / 1e18 wei)**:
   - Configuration Tx: [`0x388196b8c8fdf16cf600a1f059fa8fa0fde6a710424588eea6f54c0425b5d1ab`](https://testnet.arcscan.app/tx/0x388196b8c8fdf16cf600a1f059fa8fa0fde6a710424588eea6f54c0425b5d1ab). `LIVE_READ_PASS` (reproduced 2026-10-22: receipt success to the contract at block 67155039; dailySpendLimit() = 1e18; see docs/RELEASE_EVIDENCE.md, live run). No script reads the transaction or the stored limit. Gate 5 shows only that a 2.0 USDC call reverts, which implies a limit below 2.0 USDC.
   - Revert Verification: Attempted 2.0 USDC settlement reverts on-chain with `DailyLimitExceeded(2001000000000000000, 1000000000000000000)` (`0xef664d6a`). `LIVE_READ_PASS` (reproduced 2026-10-22: eth_call from the funded owner reverts with 0xef664d6a and arguments 2.0 and 1.0 USDC; see docs/RELEASE_EVIDENCE.md, live run). Gate 5 simulates a 2.0 USDC `settleOrder` and checks that the error contains `0xef664d6a`. It does not check the two arguments. The first argument is `dailySpent + amount`, so 2.001 USDC means 0.001 USDC was already counted when that call reverted. Section 2.3 records that settlement. The order of events should be checked against the chain.
   - Selector `0xef664d6a`: `LOCAL_PASS (node --input-type=module -e 'import {toFunctionSelector} from "viem"; console.log(toFunctionSelector("DailyLimitExceeded(uint256,uint256)"))')`. The result matches the value above.
2. **Vendor Whitelist Enforcement**:
   - Enforcement Enabled Tx: [`0x4c8f5b2ca544c05a22caa639d4707cb8c81264ff38044d338d02f6bb7f2d7051`](https://testnet.arcscan.app/tx/0x4c8f5b2ca544c05a22caa639d4707cb8c81264ff38044d338d02f6bb7f2d7051). `LIVE_READ_PASS` (reproduced 2026-10-22: receipt success at block 67155064; enforceVendorWhitelist() = true; see docs/RELEASE_EVIDENCE.md, live run). Gate 4 implies enforcement is on, because it expects a `VendorNotWhitelisted` revert, but it does not read the flag.
   - Vendor Whitelisted Tx: [`0x20f04822e1ea1fe0a79953071207a64db3575bd90e15f0243dc1a4be3575ae2a`](https://testnet.arcscan.app/tx/0x20f04822e1ea1fe0a79953071207a64db3575bd90e15f0243dc1a4be3575ae2a) (`0xa8358AED200D6CB6C856F972D853C1be833006ea`). The whitelist status of the vendor is `LIVE_READ_PASS` (reproduced 2026-10-22: receipt success at block 67155084; whitelistedVendors = true; see docs/RELEASE_EVIDENCE.md, live run), because gate 3 reads `whitelistedVendors` for that address and expects `true`. The transaction hash itself is `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`.
   - Revert Verification: Settle to unwhitelisted vendor reverts on-chain with `VendorNotWhitelisted(address)` (`0x65e822e9`). `LIVE_READ_PASS` (reproduced 2026-10-22: eth_call from the funded owner reverts with 0x65e822e9; see docs/RELEASE_EVIDENCE.md, live run). Only a gate-4 row whose status is `VERIFIED_REMOTE` contains the selector check. A non-revert failure in gate 4 is reported as `LIVE_READ_PASS` with revert wording (see section 5).
   - Selector `0x65e822e9`: `LOCAL_PASS (node --input-type=module -e 'import {toFunctionSelector} from "viem"; console.log(toFunctionSelector("VendorNotWhitelisted(address)"))')`. The result matches the value above.
3. **Live Whitelisted Settlement**:
   - Tx: [`0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb`](https://testnet.arcscan.app/tx/0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb). `LIVE_READ_PASS` (reproduced 2026-10-22: receipt success, block 67155117, from the owner, value 1e15; see docs/RELEASE_EVIDENCE.md, live run). Gate 6 checks that the receipt exists with status `0x1`. It does not check the block, the logs or the value.
   - Value: 0.001 USDC native transfer with `SettlementExecuted` event. `LIVE_READ_PASS` (reproduced 2026-10-22: value 1e15 confirmed; the log comes from the system emitter, event name not decoded; see docs/RELEASE_EVIDENCE.md, live run).
   - Resulting `dailySpent()`: 1000000000000000 (0.001 USDC). `LIVE_READ_PASS` (reproduced 2026-10-22: dailySpent() = 1e15; see docs/RELEASE_EVIDENCE.md, live run).

## 3. External System Contracts Consumed

1. **Native USDC Precompile / System Emitter**:
   - ERC-20 NativeFiatToken Interface (6 decimals): [`0x3600000000000000000000000000000000000000`](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000). The on-chain interface is `LIVE_READ_PASS` (reproduced 2026-10-22: 0x3600… has code, decimals 6, symbol USDC; see docs/RELEASE_EVIDENCE.md, live run). The address constant is `LOCAL_PASS (npx vitest run tests/unit/arc-contract-boundary.test.ts)`, which checks `ARC_USDC_PRECOMPILE` against this value and the `transfer` selector. That is not evidence of on-chain behaviour.
   - EIP-7708 System Log Emitter (18 decimals): `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE`. `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`. No source file in the repository references this address.
   - Live Verified Transfer: [`0x03f3f068d372737396fe8aebbf5e3aaf4bbd3b857698e24de8b4657f43965e01`](https://testnet.arcscan.app/tx/0x03f3f068d372737396fe8aebbf5e3aaf4bbd3b857698e24de8b4657f43965e01) (Block `67153050`). `LIVE_READ_PASS` (reproduced 2026-10-22: receipt success at block 67153050 to 0x3600…; see docs/RELEASE_EVIDENCE.md, live run).
   - Decimal conventions in the code (`LOCAL_PASS` by reading `src/adapters/settlement/arc-l1.ts`, not a run): `getBalance` divides the 6-decimal precompile balance by 10^4 to get cents. Settlement sends 1 cent as 1e16 wei of the 18-decimal native USDC.
2. **ERC-8183 AgenticCommerce / Escrow Standard**:
   - Reference contract on Arc Testnet: `0x0747EEf0706327138c69792bF28Cd525089e4583`. `LIVE_READ_PASS` (reproduced 2026-10-22: address has code; behaviour not checked; see docs/RELEASE_EVIDENCE.md, live run).
   - The adapter declares an `ERC8183_ABI`, but `depositEscrow` and `releaseEscrow` throw `SettlementNotSupportedError` (`docs/decisions/0013-arc-settlement-truthful-states.md`). No code calls that reference contract.

### Amount units: whole cents only

- Bind settles whole USDC cents only. `TransferRequest.amountCents` is a bigint count of cents, and the minimum payable amount is 1 cent (0.01 USDC). Nothing is paid below 0.01 USDC (owner decision).
- A zero, negative, fractional or otherwise non-bigint amount is refused with `SettlementRejectedError` code `SUB_CENT_AMOUNT_NOT_SUPPORTED`. The message reads: "amounts below one cent (0.01 USDC) are not supported yet, only whole cents are paid". The Arc adapter checks this first in `transferUSDC`, before any settings check, chain read or RPC call, so nothing is sent. The local simulator applies the same check in `transferUSDC` and `depositEscrow`.
- The order is held in `payment_hold` with `SETTLEMENT_REJECTED`, and the code is written to the audit evidence.
- Sub-cent payments (for example agent-to-agent payments below 0.01 USDC) need an owner decision before they are supported. Until then this refusal stands.
- Unit coverage: `tests/unit/sub-cent-amount.test.ts`. This is `LOCAL_PASS` for the guard and the wei conversion (1 cent = 1e16 wei). It does not exercise the workflow's database path.

### Tab ledger: sub-cent charges settled in whole cents (ADR 0081)

Status: built locally. Evidence is `LOCAL_PASS` only: a local PostgreSQL with a spy settlement adapter and the local simulator. Nothing here has run against Arc testnet or mainnet (`NOT_RUN`).

- **Unit.** A charge is an integer count of micro-USDC (1e-6 USDC, bigint). One cent is 10_000 micro. The adapters are unchanged and still take whole cents. A settlement is always `floor(balance / 10_000)` whole cents, capped at one chunk (the workspace approval threshold), so no sub-cent amount reaches an adapter. A charge is between 1 micro and 25 USDC (`MAX_CHARGE_MICRO`).
- **Ledger.** `tab_entries` is append-only: `charge`, `clear` and `reversal` entries. Balance = charges - clears + reversals. The code never updates or deletes an entry. Keys are namespaced by kind (`charge:<client key>`, `clear:<settlement id>`, `reversal:<settlement id>`), unique per workspace.
- **Settle rule.** A settlement reserves its clear and its `tab_settlements` row in one transaction, under a row lock on the counterparty and the workspace spend lock (`spend:<workspace>`, the same lock order reservation takes). From that commit the settlement owns the cleared cents, so two settles clear once and every settle in a workspace decides the budget one at a time. Gates, in order: nothing to settle (carries over); workspace paused (refused, nothing written); counterparty unverified, no payment address, or no workspace settlement address (a `held` row with `hold_reason`, owning no balance); the approval threshold is below one cent (`needs_approval`); otherwise one chunk of at most the threshold is taken, and the daily budget is checked for that chunk (`refused`, nothing written). The rest of a balance carries over to the next attempt. The budget is one daily sum on both sides: the tab reserve and the order commitment gate each count today's order spend and today's tab settlements that own a clear (`pending`, `submitted`, `confirmed`, `held` with a clear; never `cancelled` or a gate hold). Both use one SQL fragment (`TAB_SPEND_TODAY_CENTS_SQL`, `src/tabs/spend-sql.ts`). The order reservation and the tab reserve both take the workspace spend lock, so the authoritative decisions are serialised.
- **Send.** The transfer runs through `runEffect` with operation `settlement.transfer_usdc` and key `<workspace>:tab_settle:<settlement id>`, under a per-settlement execution lock. The adapter order id is `tab_<settlement id>`, and the match hash is keccak of the settlement id and the tag `tab`. A cancel and a reversal happen only when nothing can have been sent: this is the first attempt (no effect row existed) and the adapter refused with a code in `PRE_SEND_REJECTION_CODES` (`INVALID_REQUEST`, `SUB_CENT_AMOUNT_NOT_SUPPORTED`, `PAYER_MISMATCH`, each raised before the pre-flight in `arc-l1.ts`). Any other refusal, any refusal on a retry, a gate that fails after an effect row exists, a failed outcome and an unknown one are holds, with the clear kept.
- **States.** `pending` (cleared, not sent), `submitted` (sent, hash stored, `tab.settlement_submitted` audit written before confirm is asked), `confirmed` (final; `confirmed_block` set), `held` (`hold_reason` names why; keeps its clear), `cancelled` (reversed: a pre-send refusal on the first attempt, or an owner restore under one of the three proofs in ADR 0081's addendum).
- **Recovery (worker step `tab_settlements`).** (a) `pending` older than the stale window goes back through the ledger: a replay, an adoption through `findTransfer`, or an in-doubt hold. Never a second payment. When the adapter's lookup is unavailable, a settlement whose transfer may have moved stays `pending` and is retried each stale window; nothing is resent and nothing is cancelled (fail-closed). It finishes exactly once when the lookup returns. A pending settlement can therefore stay pending indefinitely while the lookup is down. (b) `submitted` is confirmed once; the confirmation claim is an advisory lock. (c) The end-of-day batch attempts each tab at most once per UTC day: the claim is one conditional upsert on `tab_attempts` in the same transaction as the reservation, so a crash rolls the claim back with the settlement. It is on by default. Settle-on-threshold is off by default; the batch orders by the least recently attempted tab, so no tab starves the others. A paused workspace is not sent to. A tab whose reserve keeps throwing (for example a busy spend lock) has its failed attempt recorded outside the rolled-back transaction, so the batch moves past it: it does not hold the front of the batch. With a batch of N, N tabs that all keep failing can still occupy the whole batch; the rest wait until one of them succeeds. (d) `held` settlements that own a clear and are `SETTLEMENT_OUTCOME_UNKNOWN` or `SETTLEMENT_FAILED` are reconciled: a hash is taken from the settlement, the effect row or the lookup, then confirmed. Adoption only; at most five per tick, after a five-minute backoff; it runs while paused (it cannot pay). A restore is never done by the worker.
- **Time.** The budget day and the end-of-day day are both the UTC day (`UTC_DAY_START_SQL` in `src/utils/utc-day.ts`), so the database session's time zone does not move spend between days. Two order-side reads run outside the spend lock and so can race a tab reserve: the procurement re-check (`src/workflows/procurement.ts`, the recheck call) and the replenishment pre-check (`src/agents/replenishmentTools.ts`, which still reads `CURRENT_DATE`). Both are advisory reads; the reservation under the lock decides, so an over-limit commitment is refused there. Recorded, not changed.
- **API.** `POST /api/workspaces/:id/tabs/charges` (staff or owner; `amountMicro` is a decimal string), `GET /api/workspaces/:id/tabs`, `GET /api/workspaces/:id/tabs/:counterpartyId` and `POST /api/workspaces/:id/tabs/:counterpartyId/settle` (owner). Errors: `INVALID_CHARGE_AMOUNT` and `INVALID_CHARGE` (400), `COUNTERPARTY_NOT_FOUND` (404), `COUNTERPARTY_NOT_VERIFIED`, `IDEMPOTENCY_CONFLICT` and `SPEND_LOCK_BUSY` (409). Settle answers 200 with an `outcome` for every non-error result. The economic routes take an `Idempotency-Key`. Held settlements (ADR 0081 addendum, owner only, not MCP tools): `GET /api/workspaces/:id/tabs/settlements` (held only, at most 50) and `POST /api/workspaces/:id/tabs/settlements/:settlementId/resolve` with `action` `reconcile` or `cancel_and_restore` (`acknowledgeNotSent`). Errors: `INVALID_STATUS`, `INVALID_ACTION`, `INVALID_RESOLVE` (400), `SETTLEMENT_NOT_FOUND` (404), `NOT_PROVABLY_UNSENT`, `SETTLEMENT_NOT_HELD`, `SETTLEMENT_OWNS_NO_BALANCE`, `SETTLEMENT_BUSY` (409).
- **Agent charges.** A charge recorded by an agent (a staff token) is paid by the worker at the end of the UTC day, without a per-charge owner approval. The payment is still bounded by the approval threshold (one chunk at most), the daily budget, the pre-send and hold rules above, and the 25 USDC charge limit. The owner's control is the pause switch, the threshold and the budget.
- **Not verified.** Live Arc: the Arc adapter's `transferUSDC`, `confirm` and `findTransfer` are exercised here only through the spy, and the local simulator for the API tests. The Anvil suite did not run. The residuals listed below are open.

**Held settlements (ADR 0081 addendum, `LOCAL_PASS`).** A held settlement keeps its clear. Two exits exist, and neither sends:
- `reconcileHeld` (the worker's step (d) and the owner's `reconcile`) takes a hash from the settlement, the effect row or the adapter's lookup, and confirms it. A lost hash (the original caller's record lost a busy-lock race) is therefore adopted, not held. A lookup that throws or answers null leaves the settlement held.
- `cancelHeldAndRestore` (the owner's `cancel_and_restore` only) cancels it and writes exactly one reversal, only under one of three proofs: no effect row; a stored hash whose confirmation reverted, with no settled transfer and an unsettled order; or an unknown outcome with no hash, an effect row at least 30 minutes old, an empty lookup, an unsettled order and `acknowledgeNotSent`. Anything else is `409 NOT_PROVABLY_UNSENT`.
- The Arc adapter's `isOrderSettled` is a read of the contract's `settledOrders` for the order id. It throws on any failed read and is never `false` for one. The local simulator answers from its in-memory transfers. Both are covered by `tests/unit/arc-is-order-settled.test.ts`.
- Residuals. Proof (iii) cannot see a transaction that is still in a mempool; if it mines after the 30 minute window, the clear was restored and the order is paid. The owner accepts that with `acknowledgeNotSent`. Proof (ii) has no time window; it relies on the stored hash's revert and the two reads at check time. Neither is verified against a live chain.

**REQUIRED BEFORE ANY LIVE ARC RUN OF THE TAB PATH:**
- (a) An operator route, or a worker re-reconcile, for `held` tab settlements. **Built (`LOCAL_PASS`).** See the paragraph above.
- (b) The busy-lock case where the original caller's `recordSubmitted` loses the hash. **Built (`LOCAL_PASS`).** The hash is kept in the effect row and an audit row, and reconcile adopts it.
- (c) A live Arc run of the tab path, on the testnet, with the evidence recorded in `docs/RELEASE_EVIDENCE.md`. **NOT RUN. Still required.**

**Mutation evidence (held settlements, `LOCAL_PASS`).** Each guard below was removed or inverted on a scratch copy of `src` and `tests`, one at a time, and the named tests (or the fuzz) failed each time: the busy-lock winner throwing again; a reconcile that confirms without the adapter; a restore whose lookup error reads as "not found"; no 30 minute window; no contract read for proof (iii); a non-revert failure accepted for proof (ii); no acknowledgement; a recorded effect hash ignored; a repeat that writes a second reversal; a worker that cancels an unresolved hold; the worker step removed; a restore that ignores the lookup for a moved transfer (the fuzz and two restore tests failed); the Arc read that answers false on RPC failure; the Arc read with the wrong order-id hash; the local simulator never settled; the list open to staff; the resolve not scoped to the workspace; an unknown action accepted; and a restore that fails open. Nineteen mutations in all; none survived after the tests were tightened.

## 4. Foundry Verification Gates

**Update 2026-10-20 (`f776d34`):** Foundry 1.5.1, Anvil 1.5.1 and Slither 0.11.6 were installed in this container and the gates were run. Results are in `docs/RELEASE_EVIDENCE.md` section 3: Forge format and build exit 0; 24 of 24 Forge tests passed (10 unit or fuzz, 8 reentrancy, 6 invariants at 256 runs, depth 15); contract coverage is lines 100% (68/68), statements 93.02%, branches 72.73%, functions 100%; Anvil suite 10 of 10; Slither found nothing medium or high. The lines below are the earlier session's claims, kept for history. The 10-test count and the 100% line and function figures are now reproduced. "No invariant tests" and "No reentrancy test exists" are superseded (Task 13b added them). Everything remains local: nothing ran in CI or against Arc.

The earlier session recorded these results:
- `forge fmt --check`: 100% compliant. `UNVERIFIED_CLAIM (earlier session; reproduce with: cd contracts && forge fmt --check)`. Local result on 2026-10-20: reproduced (`LOCAL_PASS`).
- `forge test -vvv`: 10 passed (unit, fuzzing, policy, invariant, and adversarial tests). `UNVERIFIED_CLAIM (earlier session; reproduce with: cd contracts && forge test -vvv)`. Local result on 2026-10-20: reproduced (`LOCAL_PASS`).
  - Static check, not a run (`LOCAL_PASS (grep -c "function test" contracts/test/BindSettlement.t.sol)`): the file defines 10 test functions, nine `test_*` and one `testFuzz_*`. It defines no `invariant_*` function and imports no invariant helper. The word "invariant" appears only in a comment. The "invariant" part of the claim is therefore not supported by the file.
  - The adversarial tests are access-control checks (`test_PolicyAdmin_OnlyOwner`, `test_UnauthorizedCallerCannotRelease`). No reentrancy test exists.
- `forge coverage`: 100% line coverage (68/68 lines), 100% function coverage (11/11 functions). `UNVERIFIED_CLAIM (earlier session; reproduce with: cd contracts && forge coverage)`. Local result on 2026-10-20: reproduced (`LOCAL_PASS`).

Gaps against `docs/TESTING_AND_RELEASE_GATES.md` section 2, from the tree as it is:
- No invariant tests (see above).
- One fuzz test (`testFuzz_DepositAndRelease`, the deposit amount). No fuzzing of addresses, deadlines or IDs.
- No Foundry deployment script: `contracts/` has no `script/` directory. The Anvil suite (`tests/integration/anvil-settlement.test.ts`) deploys the committed artifact through viem, not through a Foundry script. It is `NOT_RUN` here.
- No gas snapshot (`forge snapshot` output is not in the repository).
- No static analysis has been run. Slither is `BLOCKED` here and configured in CI (see section 6).

## 5. Known issues found while writing this document (not fixed here)

1. `scripts/verify-live-arc.ts`, gates 4 and 5: the `catch` branch treats every failure of `cast call` as the expected revert. A network error, a rejected token, or a missing `cast` binary in those gates gives status `LIVE_READ_PASS` and the detail text "deterministically reverted". Only a `VERIFIED_REMOTE` row, which means the selector appeared in stderr, supports the revert claims in section 2.
2. The daily limit is described as rolling. The code is a fixed-window reset (section 1).
3. The script appends to `docs/RELEASE_EVIDENCE.md` on every run.
4. The earlier "invariant" wording in section 4 is not supported by the test file.
5. The configuration and deployment transactions in sections 1 and 2 are not checked by any script in the repository.
6. The live-reproduction script is not wired to any `package.json` script. Its usage is only the command above.

## 6. Which gate ran where

Local result is what happened in this container. CI is what `.github/workflows/quality-gates.yml` configures; no CI job has executed: the one dispatch on 2026-10-20 got no runner (`BLOCKED`).

| Gate | Command | Local container result | CI (configured; one dispatch got no runner) | Evidence class |
| --- | --- | --- | --- | --- |
| Forge format | `forge fmt --check` in `contracts/` | exit 0 | `contracts` job | LOCAL_PASS |
| Forge build | `forge build` in `contracts/` | exit 0 | `contracts` job | LOCAL_PASS |
| Forge unit and fuzz tests | `forge test -vvv` in `contracts/` | 24 of 24 passed across 3 suites | `contracts` job | LOCAL_PASS |
| Forge coverage | `forge coverage` in `contracts/` | lines 100% (68/68), statements 93.02%, branches 72.73%, functions 100% | `contracts` job | LOCAL_PASS |
| Slither | `slither . --fail-medium` in `contracts/` (reads `contracts/slither.config.json`); CI uses `crytic/slither-action@v0.4.0` (unverified tag) | exit 0: no medium or high findings; 9 lower findings listed in the evidence. Without the config, `slither .` analysed 0 contracts and exited 0 | `contracts` job and `verify-local` job (which installs Slither unpinned) | LOCAL_PASS |
| Anvil deployment and client suite | `ANVIL_RPC_URL=<node> npx vitest run tests/integration/anvil-settlement.test.ts` | 10 of 10 passed on a local Anvil (the suite skips without `ANVIL_RPC_URL`) | `contracts` job (Anvil on 8545) and `verify-local` job (Anvil on 18545) | LOCAL_PASS |
| In-process EVM: client, ABI, events, artifact hash | `npx vitest run tests/unit/contract-artifact.test.ts tests/integration/local-chain.test.ts tests/integration/arc-settlement-evm.test.ts tests/integration/arc-find-transfer.test.ts` | LOCAL_PASS (4 files, 32 tests) | `contracts` job | LOCAL_PASS (in-process EVM, not Anvil) |
| In-process property tests (I1 to I7, six seeds of 60 steps, the daily-window named tests) | `npx vitest run tests/integration/bind-settlement-properties.test.ts` | LOCAL_PASS (1 file, 9 tests: six seeds of 60 steps, one coverage check, two named tests) | not in CI | LOCAL_PASS (in-process EVM, not Forge invariant testing, not a proof) |
| In-process reentrancy (six attacker modes, swallowed and bubbled) | `npx vitest run tests/integration/bind-settlement-reentrancy.test.ts` | LOCAL_PASS (1 file, 13 tests: six modes, each swallowed and bubbled, plus one extra test for a second order) | not in CI | LOCAL_PASS (in-process EVM, not Forge) |
| Helper artifact hash guard (`ReentrantSupplier`) | `npx vitest run tests/unit/helper-artifacts.test.ts` | LOCAL_PASS (1 file, 5 tests) | not in CI | LOCAL_PASS |
| Forge invariant suite (`BindSettlementInvariantTest`, I1 to I6 as Solidity invariants) | `cd contracts && forge test --match-contract BindSettlementInvariantTest` | 6 invariants passed (256 runs, depth 15, 0 reverts) | `contracts` job (never run) | LOCAL_PASS |
| Forge reentrancy suite (`BindSettlementReentrancyTest`, uses `ReentrantSupplier`) | `cd contracts && forge test --match-contract BindSettlementReentrancyTest` | 8 tests passed | `contracts` job (never run) | LOCAL_PASS |
| Live Arc reads and recorded transactions | `ARC_RPC_URL=<arc-rpc-url-with-token> npx tsx scripts/verify-live-arc.ts [--write-evidence <new-file>]` | NOT_RUN (no network, no token, no `cast`). The script is read-only and writes only the file named by `--write-evidence`. Without a configured URL every gate is BLOCKED. | not configured (no secret in CI) | UNVERIFIED_CLAIM (earlier session); the rewritten checks are unit-tested: LOCAL_PASS (`npx vitest run tests/unit/verify-live-arc.test.ts`, injected cast and RPC) |
| Browser E2E | `npm run test:e2e` | BLOCKED (UI orphaned, ADR 0016); accepted as NOT_RUN only through `BIND_ACCEPT_NOT_RUN=test:e2e` | `verify-local` job, recorded as NOT_RUN_ACCEPTED | NOT_RUN (ADR 0016) |

The in-process EVM rows and the Anvil row are different evidence. The in-process EVM is `LOCAL_PASS` for the client boundary. It is not a deployment or a live-chain result, and it does not satisfy the Anvil gate.

## 7. Known issues: the daily window (Task 13b)

These entries come from the property tests in `tests/integration/bind-settlement-properties.test.ts` (LOCAL_PASS, in-process
EVM) and from reading `contracts/src/BindSettlement.sol`. The contract is deployed on Arc Testnet, so the source is not
changed here. Each behaviour is asserted as it is, with a comment that names this section.

1. **A refund after the window reset reduces the current window's spent amount (KNOWN ISSUE).**
   `refundEscrow` subtracts the refunded amount from `dailySpent` whenever `dailySpent >= amount`. It does not check that
   the escrow was made in the current window. Example: deposit 4 USDC on day 1; on day 2 settle 5 USDC (the window resets, so
   `dailySpent` is 5); refund the day-1 escrow. `dailySpent` falls to 1. A further 9 USDC settles against the 10 USDC limit.
   The window then holds 14 USDC of real settlements against a 10 USDC limit, so the limit is exceeded.
   Asserted as current behaviour by `a refund after the daily window reset reduces today's spent amount (known issue)`.
   `LOCAL_PASS (npx vitest run tests/integration/bind-settlement-properties.test.ts -t "known issue")`. Not fixed: a fix changes
   deployed behaviour, so it is a product decision.
2. **The daily limit is a fixed window, not a rolling window.** The window starts at `lastDayReset` (deployment, then the
   first spend at or after `lastDayReset + 1 day`). A spend stops counting at that reset, not 24 hours after it was made.
   Example: 9 USDC settled at 86,000 seconds into the window does not count after the reset at 86,400 seconds, so a further
   9 USDC settles at 87,000 seconds. A rolling window would refuse it. Asserted by
   `the daily limit is a fixed window reset, not a rolling window`. The NatSpec of `_checkAndUpdateDailyLimit` and of
   `setDailyLimit` in the contract says "rolling"; the code is a fixed window.
3. **A stranger on a settled escrow gets `EscrowAlreadySettled`, not `Unauthorized`.** `releaseEscrow` and `refundEscrow`
   check the escrow status before the caller. The stranger rule therefore holds for open escrows only. The property model
   encodes the actual order. `LOCAL_PASS` (property suite, I5).
4. **Forge invariant and reentrancy suites** (`NOT_RUN` when this was written; run and passed on 2026-10-20, `LOCAL_PASS`). `contracts/test/BindSettlement.invariant.t.sol` and
   `contracts/test/BindSettlement.reentrancy.t.sol` compile with solc-js, but no `forge test` has run them here. Their
   results are unknown until a Forge run is recorded in `docs/RELEASE_EVIDENCE.md`.
5. **Corrections to earlier text in this document (Task 13b).** Section 4 says "No invariant tests" and the Forge gate row says
   "no invariant tests in the file". Both are now true only for the committed `BindSettlement.t.sol`: the new invariant file
   exists and is `NOT_RUN`. Section 2 says a gate-4 row can be `VERIFIED_REMOTE`. The rewritten script never produces that
   status, because every check is read-only (`LIVE_READ_PASS`, `BLOCKED` or `FAILED`). Section 5 item 1 (the catch branch
   that treats every `cast` failure as a revert) and item 3 (the script appends to `RELEASE_EVIDENCE.md`) are fixed in the
   script, but the script has not been run against the network here.
6. **Test-chain gas price (a test-harness observation, not a contract issue).** The in-process chain's receipts report
   `effectiveGasPrice` of 1 gwei, but it charges 1.2 gwei (viem's estimate) to the sender. Tests that check the payer's gas
   read the charged amount from balances and do not use the receipt price (`tests/integration/bind-settlement-properties.test.ts`).
