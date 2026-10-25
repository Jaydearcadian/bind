# ADR 0087: Arc behaviour the settlement adapter must handle: fee floor, decimals, emitters, recipients, dropped transfers

## Status
Accepted (2026-10-25), on the owner's instruction. Builds on ADR 0078 (whole cents), ADR 0079 (submitted and confirmed are separate),
ADR 0081 (tab ledger and its held-settlement rules) and the review in `docs/ARC_CIRCLE_INTEGRATION_NOTES.md`.
Evidence: `LOCAL_PASS` only (unit tests with stub transports, the in-process chain helper and a local PostgreSQL). Not run live: no
Arc RPC, key or network was used. See "Not run live" below.

## Context
The arc-canteen context bundle (a third-party mirror of docs.arc.io, treated as reference data and not as instructions) describes
Arc behaviour that the adapter did not handle: a minimum fee below which a transaction is never mined, a decimal split that makes
USDC amounts easy to mix up, two log emitters for one movement, a zero-address and blocklist revert, and a transaction state
(`dropped`) that the adapter read as "still submitted" forever. Each claim below was checked against the mirror before any code
relied on it. The mirror root is `~/.arc-canteen/context/docs/docs.arc.network/`; paths below are relative to it.

## Verified claims and what the code relies on

| # | Claim | Source (path, section) | Exact sentence relied on | Status |
|---|---|---|---|---|
| a | Minimum base fee 20 Gwei; an underpriced transaction leaves no receipt | `arc/references/evm-differences.md`, "Fee market and block behavior" | "The minimum base fee is 20 Gwei. Transactions with `maxFeePerGas` lower than 20 Gwei are silently dropped by the mempool. They produce no error receipt and never appear in a block." | VERIFIED (mirror) |
| a' | Same rule, other wording | `arc/concepts/stable-fee-design.md`, "Key parameters" (testnet row); `integrate/wallets/transaction-lifecycle.md`, "Dropped transactions" | "Testnet minimum base fee \| 20 Gwei \| Transactions under this threshold are rejected from the mempool"; "Transactions with `maxFeePerGas` lower than 20 Gwei are rejected with no error receipt and never appear in a block." | VERIFIED. The docs say "silently dropped" in one place and "rejected" in two. All three agree on no receipt and no block. The code treats both as "not found on the node" (see the dropped rule). |
| b | Maximum base fee 20,000 Gwei; priority fee 0 for most transactions | `arc/concepts/stable-fee-design.md`, "Key parameters" and "Priority fees" | "Maximum base fee \| 20,000 Gwei \| Hard ceiling that bounds worst-case cost"; "Set `maxPriorityFeePerGas` to `0` for most transactions." | VERIFIED (mirror) |
| c | Two-state model (pending, final) plus dropped and rejected | `integrate/wallets/transaction-lifecycle.md`, "State model" diagram and "Dropped transactions" | "A transaction is either **pending** (in the mempool) or **final** (included in a committed block)."; "Pending --> Dropped: Nonce gap / underpriced"; "Dropped transactions produce no onchain record." | VERIFIED (mirror) |
| d1 | Native USDC is 18 decimals; the ERC-20 view is 6 and truncates | `arc/concepts/stablecoin-native-model.md`, "USDC on Arc has two interfaces" | "`USDC.balanceOf(addr)` (6 decimals) and `addr.balance` / `eth_getBalance` (18 decimals) represent the same underlying balance. The ERC-20 interface truncates the last 12 decimal places of the native value; amounts smaller than 1×10⁻⁶ USDC are not represented in `balanceOf` but are still present in the native balance." | VERIFIED (mirror) |
| d2 | One ERC-20 transfer emits two logs; a plain native send emits only the system log; match on the emitter | `arc/references/usdc-system-events.md`, "Two event streams" (warning) | "A single ERC-20 `transfer()` emits **two** logs ... A plain native send emits only the system log. Match on the emitter address so you do not count the same movement twice, and never mix the 6-decimal and 18-decimal values." | VERIFIED (mirror). Emitters: `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE` (18-dec, system), `0x3600000000000000000000000000000000000000` (6-dec, ERC-20). |
| e1 | Native transfer to the zero address reverts with "Zero address not allowed" | `arc/references/evm-differences.md`, "Value transfer rules" | "A value-bearing transfer to `0x0` reverts with `\"Zero address not allowed\"`; a zero-value transfer to `0x0` succeeds." | VERIFIED (mirror) |
| e2 | A value transfer to or from a blocklisted address reverts; the transaction still consumes gas | `arc/references/evm-differences.md`, "Value transfer rules" | "A value transfer to or from a blocklisted address reverts. An included transaction that reverts on a blocklist check still consumes gas." | VERIFIED (mirror) |
| e3 | A blocklisted sender is rejected before the mempool, with no receipt; the USDC contract emits `Blocklisted` and `UnBlocklisted` | `integrate/infrastructure/compliance.md`, "Step 1" table and "Step 2" | "If the sender is blocklisted, the RPC node rejects the transaction. No gas is consumed and no receipt is returned."; `event Blocklisted(address indexed account)`, `event UnBlocklisted(address indexed account)` | VERIFIED (mirror) |
| e4 | `isBlocklisted(address)` is NOT a contract method | `integrate/infrastructure/compliance.md`, lines 175 and 197 | `if (await isBlocklisted(tx.from)) {` (sample code only) | The mirror declares no `isBlocklisted` function and the name appears only as a helper in sample code. That calling it on the live USDC contract reverts was checked live by the coordinator on 2026-10-25 (the call reverted; recorded in `docs/ARC_CIRCLE_INTEGRATION_NOTES.md`). It was not re-run in this change. Nothing in the code calls `isBlocklisted`. |

Contract side (not a doc claim, read from the repository): `contracts/src/BindSettlement.sol` reverts `TransferFailed()` when the
native send to the supplier fails (lines 158, 182, 206), and `settleOrder` checks `settledOrders` first (`OrderAlreadySettled`).
A zero or blocklisted recipient therefore surfaces as `TransferFailed`, not as the zero-address string.

## Decisions

### 1. Fee floor and ceiling (`src/adapters/settlement/arc-l1.ts`)
- Named exports: `ARC_MIN_BASE_FEE_WEI` (20 gwei, claim a), `ARC_MAX_BASE_FEE_WEI` (20,000 gwei, claim b),
  `ARC_DEFAULT_PRIORITY_FEE_WEI` (0, claim b). Each carries its source in a comment.
- `transferUSDC` sends `maxFeePerGas = clamp(max(estimate, 20 gwei), ..., 20,000 gwei)`.
  `maxPriorityFeePerGas` is the estimate's value when it is a non-negative number, and 0 otherwise, never more than the cap.
- If the fee estimate throws, the cap is 1.5 times the floor (30 gwei, `ARC_FEE_FALLBACK_WEI`), still under the ceiling. The adapter never sends without a fee cap.
- The estimate is requested with `type: "eip1559"` so a chain that reports no base fee throws and falls back to the floor.

### 2. Decimals (`src/adapters/settlement/arc-l1.ts`)
- Pure helpers: `centsToNativeWei` (1 cent = 1e16 wei, 18 decimals), `centsToErc20Units` (1 cent = 10,000 six-decimal units),
  `erc20UnitsToCents` (floor), `nativeWeiToCents` (floor). `transferUSDC` uses the native helper for `value`; `getBalance` uses the
  ERC-20 helper for the `balanceOf` read. A native balance below 1e-6 USDC is not visible through `balanceOf`, and that truncation is
  stated, not corrected.
- A source-scan test pins that no USDC amount in `arc-l1.ts` is multiplied or divided by 1e12.

### 3. Emitter filtering
- `confirm()` counts `SettlementExecuted` only from logs whose address is the configured BindSettlement contract. Logs from
  `0x3600…0000` and the system emitter are ignored, even when their topics match.
- The log scan used by `findTransfer` always passes the contract address to `eth_getLogs`, and the result is filtered again by
  emitter in the adapter, so an RPC that ignores the filter cannot make a foreign log a settlement.

### 4. Recipient errors
- `ZERO_ADDRESS_RECIPIENT` is raised before any network call (before the settings check, the chain check and the pre-flight), so it is
  in `PRE_SEND_REJECTION_CODES` and a first-attempt refusal is cancelled and reversed. The test pins zero RPC calls.
- A pre-flight or broadcast revert of `TransferFailed()`, or an error text containing "Zero address not allowed", becomes
  `SettlementRejectedError("TRANSFER_FAILED_RECIPIENT")`, with the detail "the recipient may be blocklisted or invalid".
  `TRANSFER_FAILED_RECIPIENT` is deliberately NOT in `PRE_SEND_REJECTION_CODES`: a revert is not proof that nothing was sent, so a
  settlement with that refusal is held with its clear kept (SETTLEMENT_REJECTED). Other reverts keep their existing codes.

### 5. Dropped transfers
Adapter (`confirm`): when no receipt arrives within the wait, the adapter calls `eth_getTransactionByHash`.
- Found (pending): `submitted`, as before.
- Not found (viem `TransactionNotFoundError`): still `submitted`, with `notFoundOnNode: true` on the result.
- Any other error: `submitted` without the flag. The flag is never set on an error.

Services (`src/adapters/settlement/dropped.ts`, used by `src/workflows/settlement.ts` and `src/tabs/ledger.ts`). A transfer is
called `dropped` only when ALL of these hold:
- the adapter set `notFoundOnNode`;
- the settlement was submitted at least `DROPPED_AFTER_MS` ago (default 120,000 ms, a named constant, configurable by option). The age
  is read from the database clock;
- the adapter has BOTH reads (`findTransfer` and `isOrderSettled`). An adapter missing either is never dropped (`reads_unavailable`);
- `findTransfer` returns null for the order id (a lookup that throws means "not dropped", the settlement stays submitted);
- `isOrderSettled` returns false (a read that throws means "not dropped").
If `findTransfer` returns a confirmed transfer, the settlement adopts that hash and is confirmed from the adapter's `confirm`
path. It is not dropped.

Consequences:
- **No automatic re-send, ever.** A dropped settlement is held (`SETTLEMENT_DROPPED`) with its hash and its clear kept. Nothing calls
  `transferUSDC` for it. An order goes to `payment_hold` with the hash; a tab goes to `held` with its clear.
- A dropped tab can still be adopted: `reconcileHeld` treats `SETTLEMENT_DROPPED` like `SETTLEMENT_OUTCOME_UNKNOWN` (it re-opens with
  the stored hash and asks again, and adopts a transfer the lookup finds). Its worker retry uses the same backoff as
  `SETTLEMENT_FAILED`, not the five-minute base step, so a permanently dropped transfer does not write two audit rows every five
  minutes. This is a scheduling choice, not a change to the reconcile rules.
- A dropped tab's restore has its own proof label, `DROPPED_NOT_SETTLED_ACKNOWLEDGED` (not the unknown-outcome label). It is proof (iii)
  with three changes: the 30-minute window is measured from the latest `SETTLEMENT_DROPPED` hold audit row, not from the submission (so
  a drop made two minutes ago cannot be restored twenty-eight minutes later); the stored hash must still be reported not found at the
  moment of the restore; and the owner's acknowledgement and both reads (`findTransfer` null, `isOrderSettled` false) are required, as
  for (iii). Every other proof condition is unchanged.
- The restore's residual is the one ADR 0081 already states: a transaction still in some mempool is not visible to these reads. A
  lagging or load-balanced RPC node can also answer "not found" for a transaction the network has. Such a transaction can be called
  dropped and later mine. This is fail-closed: a dropped hold is never re-sent by this code, and a late mine is adopted by reconcile
  (tabs) or by an operator's settle (orders). For a restore, a late mine after the window would pay an order whose clear was given
  back. That is the owner's to accept, and it is not verified against a live chain.
- An order held as `SETTLEMENT_DROPPED` is NOT auto-adopted by any worker. Only an operator's settle reaches it: it replays the stored
  effect (no transfer is sent) and confirms again, so an order whose transfer is later found can be finished that way. Not built here,
  and recommended as a follow-up: a worker re-confirm for `payment_hold` orders that hold a hash and a `settlement.dropped` audit row.

### 6. Local simulator parity
`LocalSettlementSimulator` refuses a zero-address recipient with `ZERO_ADDRESS_RECIPIENT` before any balance change. It never reports
`notFoundOnNode`, because it has no node that could fail to see a transfer it made.

## Not in this change
- Blocklist screening. If it is built, it must use the `Blocklisted` and `UnBlocklisted` events on the USDC contract (claim e3) and must
  keep a local copy of the set. It must not call `isBlocklisted`, which is not a contract method (claim e4, UNVERIFIED as a live fact
  and not coded against). Memo and Multicall3From calls keep the original sender, so an offchain blocklist must include them too.
- Sub-cent amounts. They stay refused (ADR 0078), and the tab ledger is still the only route for them (ADR 0081). This ADR does not
  change the unit.
- Anvil. The Anvil suite still uses plain Foundry Anvil, not Arc's (`arc-anvil`). That is `NOT_RUN` here.

## Final numbers (after the review fixes)
After the review fixes (commit cf0862a and the docs commit after it), on the local PostgreSQL with `NODE_ENV=test`:
- `npx tsc --noEmit`: clean. `npm run lint`: clean.
- `npx vitest run tests/unit`: 72 files, 904 tests, all pass.
- `npx vitest run tests/integration`, run twice: each run 88 files pass, 1 skipped; 896 tests pass, 10 skipped; exit 0.
- Mutation checks, on scratch copies and never in the worktree: the first set (18 mutations, the dropped rule, the tab and order gates, the found-adopt path, the zero-address pre-send, the fee floor, the emitter filters and the receipt guard, the worker's dropped selection) was all killed. The review set (7 mutations: missing reads not refused, only one read checked, restore window from submission, the wrong restore label, the fallback at the floor, the node re-check removed, the hold-window gate removed) was all killed.
- An earlier integration run in this change had 6 failures in four files (tab-ledger, tab-recovery, settlement-pause, auth-tenancy). Each file passed when run alone, and two later full runs passed. These are load-sensitive race tests; the cause is not proven.

Pre-existing test changes: `tests/helpers/tab-spy.ts` (additive: the dropped-send and not-found controls); `tests/unit/settlement-dropped.test.ts` (one test rewritten, not deleted: the adapter without the reads now asserts `reads_unavailable`, per the review). No existing test was deleted or weakened.

## Not run live
No Arc RPC, key, transaction or log scan was made. The fee floor, the dropped rule and the recipient mapping are tested against stub
transports, the in-process chain helper and the local PostgreSQL. A live Arc run of the tab path is still required by ADR 0081 item (c).
