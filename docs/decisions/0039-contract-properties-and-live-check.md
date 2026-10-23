# ADR 0039: Contract property tests, reentrancy, Forge invariant files (NOT_RUN), and an honest live check

## Status
Accepted (2026-10-20), by Task 13b of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`. It builds on ADR 0012
(the artifact and the in-process EVM) and ADR 0038 (contract gates and CI). The environment has no network, no Foundry, no
Anvil, no Slither and no live Arc access. Everything that needs one of them is recorded as `NOT_RUN` or `BLOCKED`.
`BindSettlement.sol` is not changed: it is deployed on Arc Testnet, and a change to it is a product decision.

## Context
- `AGENTS.md` requires Forge unit, fuzz and invariant tests, reentrancy tests where reachable, and a live check that never
  reports a pass it did not earn. Before this task the repository had no invariant test, no reentrancy test, and a live
  script that reported any `cast` failure (including a missing binary) as `LIVE_READ_PASS`, and that appended to
  `docs/RELEASE_EVIDENCE.md` on every run.
- The in-process EVM (EthereumJS, ADR 0012) can run many transactions quickly and deterministically. It is not Anvil and it
  is not Forge. What it can establish is recorded below.

## What each test establishes, and what it does not

### 1. Property tests over the in-process EVM (`tests/integration/bind-settlement-properties.test.ts`, LOCAL_PASS)
- Six fixed seeds (`1, 2, 3, 42, 1337, 20261020`), 60 random steps each, with a mulberry32 generator written in the file. A
  failure names the seed and the step, and the message reproduces the run (`mulberry32(seed)`, 60 steps).
- Each step is applied to a TypeScript model of the contract and to the real bytecode. Before each write, `eth_call` must
  give the outcome the model predicts (success, or the custom error and its arguments). The write is then sent and its
  receipt must agree.
- Invariants checked after every step against the chain:
  - **I1** settled orders never go back to false, and each order settles at most once.
  - **I2** the contract balance equals the sum of open escrows.
  - **I3** a successful `settleOrder` pays the supplier exactly `msg.value`, changes the contract balance by zero, and the
    payer pays `msg.value` plus gas. Gas is read from balances, not from the receipt (see section 6 below).
  - **I4** after a successful spend with a non-zero limit, `dailySpent <= dailySpendLimit`.
  - **I5** an escrow is never released and refunded, never released or refunded twice, and only the depositor or the owner
    releases or refunds. A stranger on an open escrow gets `Unauthorized`.
  - **I6** only the owner calls the admin functions; others get `Unauthorized`.
  - **I7** a reverted call changes no contract state (a full snapshot before and after) and moves no balance except the
    caller's gas.
- The model tracks the clock. The chain's clock (`currentTime()`, added to the helper) must match the model clock after
  every step.
- The last test checks that the random runs reached every outcome class (success and each revert the model can predict),
  so the properties are not vacuous.
- Named tests: `a refund after the daily window reset reduces today's spent amount (known issue)` and `the daily limit is a
  fixed window reset, not a rolling window` (both document current behaviour; see section 5).

**Establishes:** on this in-process EVM, for these six seeds and these operations, the contract behaves as the model says and
the invariants hold after each step, and the model is consistent with the bytecode.

**Does not establish:** Forge invariant testing (a Forge run with fuzzed handlers, coverage of the state space, and
shrinking), a formal proof, behaviour under Anvil or Arc (different client code), behaviour for any seed other than the six,
or anything about the deployed contract. The model was written from the Solidity source, so a misreading of the source would
be copied into the model. The model's check order (for example, which error comes first) was read from the source and is
confirmed only by the chain agreeing with it.

### 2. Reentrancy (`tests/integration/bind-settlement-reentrancy.test.ts`, LOCAL_PASS)
- The attacker is `contracts/test/helpers/ReentrantSupplier.sol`, compiled by `tools/compile-contract/generate.mjs` to
  `contracts/artifacts/helpers/ReentrantSupplier.json` (hash-guarded by `tests/unit/helper-artifacts.test.ts`). The source
  has no imports, so the isolated solc compiles it alone.
- Six modes: an inner `settleOrder` with the same id (must fail, `OrderAlreadySettled`); with a different id, paid back to
  the attacker; an inner `releaseEscrow` and `refundEscrow` of an escrow the attacker deposited; an inner `depositEscrow`;
  and a release to the attacker as recipient and depositor, re-entered on the same id (must fail, `EscrowAlreadySettled`).
- Each mode runs twice: the attacker swallows the inner failure, or bubbles it (so the outer call reverts with
  `TransferFailed`). For each case the test checks: no order settles twice; what the attacker receives equals the legitimate
  payouts in the events (so it never receives more); the contract balance equals the open escrows; a swallowed re-entry
  leaves the outer settlement correct; a bubbled failure reverts the whole outer call with no state change.
- The release-as-recipient fixture was chosen so that a contract which pays before it marks the escrow released would pay a
  second time (from a second, unrelated escrow). The mutation check below confirmed this.

**Establishes:** the reentrancy behaviour of this bytecode for these six call paths, on the in-process EVM.

**Does not establish:** every reentrancy path (other entry points that pay out, such as cross-function re-entry into a
different function with a shared state), gas-limited or out-of-gas re-entry, or behaviour with a real token contract.

### 3. Forge invariant and reentrancy files (`contracts/test/BindSettlement.invariant.t.sol`, `BindSettlement.reentrancy.t.sol`): NOT_RUN under Forge
- `contracts/foundry.toml` has `[invariant] runs = 256, depth = 15, fail_on_revert = false`.
- The invariant file has a handler with bounded random actions (settle, deposit, release, refund, non-owner admin attempts,
  time warps) and `invariant_` functions for I1, I2, I4, I5 and I6. The daily limit is set once and never changed by the
  handler, so `dailySpent <= limit` is a fair invariant.
- Both files were **compile-checked only**, with the pinned solc 0.8.37 from `tools/compile-contract` and `forge-std` resolved
  from `contracts/lib/forge-std`. The existing `contracts/test/BindSettlement.t.sol` also compiles. Their status is
  `COMPILES (solc-js)` and `NOT_RUN under Forge (not installed)`. No `forge test` has run, so nothing here is a pass.
- Their headers say so. Do not cite them as passing until `cd contracts && forge test` is recorded in
  `docs/RELEASE_EVIDENCE.md`.

### 4. Live check (`scripts/verify-live-arc.ts`, unit-tested with injected cast and RPC, LOCAL_PASS; live run NOT_RUN)
The script exports `runLiveArcVerification({ exec, rpc, env, now })` and `main(argv, deps)`, both with injected dependencies.
The module runs `main` only when the file is the entry point. Rules:
- A gate is `LIVE_READ_PASS` only when the call succeeded and its output matches the expectation. For a revert gate, the
  revert selector in the cast output (from the revert data, falling back to a standalone 8-hex token) must equal the
  expected selector: `0x65e822e9` (VendorNotWhitelisted) or `0xef664d6a` (DailyLimitExceeded). A successful call is never a
  pass for a revert gate.
- `BLOCKED` with the reason: a missing `cast` binary, a spawn error, a timeout, an RPC HTTP error, an RPC network error, an
  RPC JSON-RPC error object, an unconfigured RPC URL, a placeholder URL (`<ARC_RPC_TOKEN>`), and a cast failure that shows no
  revert selector. None of these is a pass.
- `FAILED`: a successful call whose output does not match. Examples: `whitelistedVendors` returns `false`, a revert gate's
  call succeeds, a revert gate reverts with a different selector, the chain id differs, or the receipt status is not
  `0x1`. `FAILED` was added to the status union and to `docs/TESTING_AND_RELEASE_GATES.md` section 10. It is outside the
  five classes in `AGENTS.md`, and the report says so.
- No gate can be `VERIFIED_REMOTE`. Every call is a read or an `eth_call` (nothing is signed or sent).
- No output line or evidence line contains the RPC URL or its token. Every string passes through `redactText` from
  `src/utils/redact.ts`, with the URL and its path segments as extra secrets. The unit test puts a token in the URL and
  echoes it back from cast and from the RPC error, then checks every output.
- The script writes nothing by default. `--write-evidence <path>` writes the table to a NEW file (`flag: "wx"`). If the file
  exists the script refuses with exit 2. It never appends to `docs/RELEASE_EVIDENCE.md`.
- Exit code 0 only when all six gates are `LIVE_READ_PASS`; 1 otherwise; 2 for a usage error.

**Establishes:** that the classification logic does what the rules say, against the failure modes that matter (a missing
binary, a network error, an HTTP error, an unconfigured URL, a wrong selector, a successful call where a revert was expected,
and token leakage).

**Does not establish:** that any gate passes against Arc. This environment has no network, no token and no `cast`. Each
live gate is `NOT_RUN` here. A live run is needed, and it will be recorded as its own evidence entry (Task 14).

### 5. Known issues (see `docs/CONTRACT_SCOPE.md`, section 7)
1. **A refund after the window reset reduces the current window's spent amount.** `refundEscrow` subtracts the refunded
   amount from `dailySpent` when `dailySpent >= amount`, whatever window the escrow was made in. The window can then hold
   more settlement than the limit (the example in the named test is 14 USDC against a 10 USDC limit). This is asserted as
   current behaviour, with the comment `KNOWN ISSUE (CONTRACT_SCOPE)`. The fix changes deployed behaviour, so it is a product
   decision and is not made here.
2. **The daily limit is a fixed window, not a rolling one.** The NatSpec in the contract says "rolling"; the code resets at
   the first call at or after `lastDayReset + 1 day`. The named test asserts the fixed-window behaviour.
3. **A stranger on a settled escrow gets `EscrowAlreadySettled`, not `Unauthorized`.** The status check comes before the
   caller check. The model encodes the actual order. The `Unauthorized` rule holds for open escrows.

## 6. Test-harness observation: the in-process chain's gas price
The in-process chain reports `effectiveGasPrice` of 1 gwei in receipts, but the sender is charged `gasUsed × 1.2 gwei`
(viem's estimate). This was measured with a probe (`gasUsed 112385`, charged `134862000000000` wei, which is
`112385 × 1.2e9`). The property suite therefore takes gas from balances, requires it to be a whole multiple of `gasUsed`,
and requires one price for the whole run. It does not read the receipt's price. `local-chain.ts` was not changed.

## 7. Mutation checks (scratch copy, not committed)
The contract mutants were applied to a scratch copy of the tree, recompiled with the isolated solc
(`tools/compile-contract/generate.mjs`), and run against both new suites. The unmutated copy passes (38 tests in the three
in-process contract files at the time).

| Mutant (contract) | Result | What caught it |
| :--- | :--- | :--- |
| C1: `settledOrders[orderId] = true` removed | 18 tests fail | all six property seeds and the outcome-coverage test (I1 and the model disagree on `settledOrders`), and 11 of the 13 reentrancy tests |
| C2: external call moved before `esc.released = true` in `releaseEscrow` | 2 tests fail | the reentrancy RELEASE_AS_RECIPIENT cases (swallowed and bubbled): the inner release pays a second time, so the outer call does not revert and the balance check fails |
| C3: daily limit check disabled | 5 tests fail | seeds 2, 3 and 1337 (I4 and the model's DailyLimitExceeded), the outcome-coverage test, and the fixed-window named test |
| C4: caller check removed from `releaseEscrow` and `refundEscrow` | 3 tests fail | seeds 1, 1337 and 20261020 (I5) |

Model mutations (the test's model is wrong, the contract is the original):

| Model mutation | Result |
| :--- | :--- |
| M-A: the model's refund does not reduce `dailySpent` | 2 seeds fail (1 and 3): the model and the chain disagree on `dailySpent` |
| M-B: the model never records a settled order | 7 seeds fail: the model and the chain disagree on `settledOrders` |

Interpretation: the brief asked to "weaken one invariant check and show the test fails". Weakening a check cannot make a test
fail, so the model was made wrong in one place at a time instead. That shows the comparisons run and that they are sensitive.
The contract mutants show that the properties and the reentrancy suite detect a broken contract.

## 8. What ran here
Commands and results are in `docs/RELEASE_EVIDENCE.md` (Task 13b entry) and in the report that accompanies this ADR. In
summary: `npm run lint`, `npm run typecheck`, `npm run test:unit` (47 files, 339 tests), `npm run test:integration` (51 files
and 519 tests passed, 1 file skipped: the Anvil suite without `ANVIL_RPC_URL`), `npm run build`, `npm audit --audit-level=high`
(0 vulnerabilities), `npm run map:functions` (regenerated `docs/CODEBASE_MAP.md`, stable on re-run), and each new integration
file three times (9 and 13 tests, every run passing).

## What is BLOCKED or NOT_RUN, and why
- Forge (`forge fmt --check`, `forge build`, `forge test -vvv`, `forge coverage`): BLOCKED, Forge is not installed. The new
  invariant and reentrancy files are NOT_RUN under Forge (compile-checked with solc-js only).
- Anvil integration: BLOCKED (not installed; the suite skips without `ANVIL_RPC_URL`).
- Slither: BLOCKED (not installed).
- Live Arc read-only checks: NOT_RUN (no network, no token, no `cast`). The unconfigured script blocks every gate.
- Browser E2E: NOT_RUN, accepted through `BIND_ACCEPT_NOT_RUN=test:e2e` (ADR 0016).

## Consequences
- The contract's known issues are visible in tests and in `CONTRACT_SCOPE.md`. A reader who sees a passing test should
  check that it is the in-process EVM before reading it as Forge or Anvil evidence.
- `docs/RELEASE_EVIDENCE.md` is not touched by this task. Its section 5 contains the output of the old script (see
  Task 14's audit list in the report).
- The live script's output is now a new file per run. Nothing appends to the evidence document.
- `FAILED` is a new status. Any consumer that expected only the five classes in `AGENTS.md` must handle it.
