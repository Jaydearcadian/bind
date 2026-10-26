# ADR 0086: Escrow direction: keep our native escrow, adopt ERC-8183, or defer escrow

## Status
Accepted as deferred (2026-10-26). The owner decided: escrow stays deferred because no business we are working with needs it yet. Reopen this record when a real business needs escrow. Until then, neither escrow option is built and `BindSettlement`'s escrow functions stay unwired.

This record builds nothing. It does not deploy, configure, wire or call any contract. It does not change the adapter, the
app or any test. The deployed `BindSettlement` at `0x16E1…aA29` is left as it is. The choice is still open.

Related: ADR 0001 (build boundaries; section 3 says custom Solidity is not justified for the initial slice because ERC-8183 provides escrow), ADR 0060 (Arc as the payment
rail; escrow is later work), ADR 0076 (one `BindSettlement` per business), ADR 0079 (submitted and confirmed are separate),
ADR 0080 (the business payment account), ADR 0081 (tab ledger). `docs/ARC_CIRCLE_INTEGRATION_NOTES.md`, item 8, asks for this
evaluation before more custom escrow is written.

## Summary for the owner (plain language)

**What we have.** Our own contract, `BindSettlement`, is live on the Arc testnet. Besides the payment call the app uses today
(`settleOrder`, pay a supplier once the purchase order, delivery receipt and bill match), it has an escrow: a business locks
USDC with the contract, and later the money goes to the supplier or back to the business. The escrow code is tested locally.
The app does not use it. The Arc adapter refuses escrow calls with "not supported", so no business can use escrow today.

**What the other option is.** ERC-8183 is a draft Ethereum standard for a job with escrowed money and a named "evaluator" who
approves the work. Arc's own documentation points to one reference contract on the Arc testnet, `0x0747…4583`. We read its
published source. It is an upgradeable proxy: its admin can replace the code at any time. We found no audit. The EIP prose and its own reference code disagree in several places, and the deployed contract follows the code (section 1.4).

**Recommendation: option C.** Use no escrow for now. Keep paying on the three-way match, which is the only live path. Do not
wire our escrow functions, and do not adopt the ERC-8183 reference, until a business actually needs milestone escrow. At that
point choose between A and B with the owner, on evidence gathered then. Reasons:
1. No workflow in the app needs escrow yet, and ADR 0060 places escrow later.
2. Both escrow options carry risks we would have to accept now. Our escrow lets the paying side take its money back at any time, and release without proof, and has an open issue with the daily limit. The reference contract's current admin is not confirmed by us,
   and we found no audit.
3. Deferring needs no contract, no deployment and no on-chain approval. On the chain side it is easy to reverse later; template and skill copy would need a follow-up (section 6).

**What the owner must decide** (section 7): whether any business needs escrow in the pilot period; if yes, A or B; who would
operate and hold the keys of the reference contract, if B; and whether ADR 0001's "no custom Solidity" line still stands.

## 1. Context

### 1.1 What our escrow is (read from source, not run in this record)

Source: `contracts/src/BindSettlement.sol` in this repository.

- **Asset.** Native USDC sent as `msg.value`, 18 decimals (contract header, line 7). The adapter converts one cent to 1e16 wei
  (`src/adapters/settlement/arc-l1.ts`, line 243). The USDC ERC-20 interface on Arc is 6 decimals (`docs/CONTRACT_SCOPE.md`, section 3).
- **Functions.** `depositEscrow(commitmentId, recipient, matchHash)` payable (lines 120-141). `releaseEscrow(commitmentId)`
  (lines 147-161). `refundEscrow(commitmentId)` (lines 167-185). `getEscrow` (lines 214-216). Storage: `escrows` mapping (line 27).
- **Who may release or refund.** Either the depositor or the owner (lines 151 and 171). Neither call checks a status or a time,
  other than "not already released or refunded". So the depositor can take the money back at any time before release, and
  can release it to the recipient without any proof. The owner, a single signer key, can do either to any escrow. The owner can only send funds to the stored recipient (release) or depositor (refund), not to itself. There is no function to change owner, so the key cannot be rotated. The vendor whitelist is checked at deposit only, not at release.
- **The match hash.** `matchHash` is stored (line 14, line 138) and emitted (line 140). Release does not check it.
- **Timeouts.** None. An escrow has no expiry.
- **Daily limit.** A deposit counts against the global daily limit (line 128). A refund subtracts the amount from `dailySpent`
  only if enough is recorded (lines 177-179). This is the known issue in `docs/CONTRACT_SCOPE.md`, section 7, item 1: a refund
  after a window reset can let spending exceed the limit.
- **Upgrade.** None. The contract is not a proxy; its code is fixed once deployed.
- **Deployed.** `0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29` on Arc testnet. `docs/CONTRACT_SCOPE.md`, section 1, records code
  present and the body matching the artifact apart from the metadata tail (`LIVE_READ_PASS`, 2026-10-22). That record does not
  say the escrow functions were called on chain.
- **Tests.** Forge: `test_DepositAndReleaseEscrow`, `test_RefundEscrow`, `test_RefundRestoresDailyBudget`, `testFuzz_DepositAndRelease`,
  `test_UnauthorizedCallerCannotRelease` (`contracts/test/BindSettlement.t.sol`); invariants
  `invariant_balanceEqualsOpenEscrows`, `invariant_noEscrowReleasedAndRefunded`, `invariant_onlyDepositorOrOwnerReleases`
  (`contracts/test/BindSettlement.invariant.t.sol`); reentrancy file `contracts/test/BindSettlement.reentrancy.t.sol`. Status in
  `docs/CONTRACT_SCOPE.md`, section 6: Forge 24 of 24 passed, `LOCAL_PASS`, on 2026-10-20. The Anvil client suite
  (`tests/integration/anvil-settlement.test.ts`) does not call the escrow functions (checked by grep of `tests/`).
- **Not wired.** `src/adapters/settlement/arc-l1.ts`, lines 345-351: `depositEscrow` and `releaseEscrow` throw
  `SettlementNotSupportedError`. The interface declares them (`src/adapters/settlement/types.ts`, lines 41-42). The local
  simulator implements them. No app workflow calls them (grep of `src/`, `scripts/`, `mcp/`, `sdk/`, `templates/`, `web/`, `api/`, `skills/`; the only non-test matches are the adapter, the simulator, the interface, and a pass-through in `scripts/live-recovery-arc.ts`). The in-process EVM suites (`tests/integration/bind-settlement-properties.test.ts`, `tests/integration/bind-settlement-reentrancy.test.ts`) exercise the escrow functions; `tests/integration/arc-settlement-evm.test.ts` asserts the adapter refuses them.
- **The live path.** `settleOrder` (lines 193-209): pays a whitelisted supplier once per order id, within the daily limit, in
  one transaction. This is the path the app uses (ADR 0079, ADR 0080).

### 1.2 What ERC-8183 is (EIP text)

Source: https://eips.ethereum.org/EIPS/eip-8183, fetched as text on 2026-10-25 (`Read` of the converted page, not a copy in this repository).

- **Status.** "Draft", Standards Track ERC, created 2026-02-25. Requires EIP-20. The text can still change.
- **Model.** A job with escrowed budget. States: Open, Funded, Submitted, and three terminal states (Completed, Rejected,
  Expired). The EIP's own transition list is the reference for the states below.
- **Roles.** Client: creates the job, sets the provider, sets the budget, funds it. Provider: submits the deliverable (a
  bytes32 hash or reference). Evaluator: one address per job, fixed at creation; once Submitted, the evaluator alone may
  complete or reject; while Funded, the evaluator may reject. The client may reject only while Open. After expiry, anyone may
  trigger a refund to the client.
- **Money.** One ERC-20 token per contract. Fund pulls the budget into escrow. Complete pays the provider, minus an optional
  platform fee. Fees are optional, in basis points, charged only on completion.
- **Hooks (optional).** A client-chosen contract called before and after the core functions. The EIP calls hooks trusted by the
  client and warns that a reverting hook can block actions until expiry. `claimRefund` is not hookable.
- **Security notes in the EIP.** The evaluator is trusted; "no dispute resolution or arbitration; reject/expire is final"; a
  reentrancy guard and SafeERC-20 are required; hooks SHOULD be gas-limited.
- **Reputation.** ERC-8004 is recommended for reputation; the Arc docs list ERC-8004 registries on the testnet
  (`arc/tutorials/register-your-first-ai-agent.md`, the ERC-8004 table).

### 1.3 What the reference implementation does (read from the explorer's verified source)

Sources read with plain public GETs on 2026-10-25:
- `https://explorer.testnet.arc.io/api/v2/smart-contracts/0x0747EEf0706327138c69792bF28Cd525089e4583` (the
  `testnet.arcscan.app` API address answers 301 to this host; read as data).
- `https://explorer.testnet.arc.io/api/v2/smart-contracts/0xA316fd02827242D537F84730F8a37D0BA5fd351a` (implementation).
- The Arc docs mirror: `arc/tutorials/create-your-first-erc-8183-job.md` (steps and function signatures), `build/agentic-economy.md`,
  `build/sample-apps/arc-escrow.md`.

What we read:
- **The address is a proxy.** `0x0747…4583` is an `ERC1967Proxy` (EIP-1967 upgradeable proxy), verified, with implementation
  `0xA316…d351a` named `AgenticCommerce`. Verified source: `src/AgenticCommerce.sol`, 11,662 bytes, Solidity v0.8.28, optimiser
  off, licence "none", verified 2026-03-26 per the explorer. The explorer reports `is_verified: true` for both. We did not
  recompile, so the match between the deployed bytecode and the source is `UNVERIFIED`.
- **Token and roles at initialisation.** The proxy's constructor data (`initialize`) sets `paymentToken` to `0x3600…0000`
  (the native USDC interface, 6 decimals), `platformTreasury` to `0xcbe5…620d`, and `admin` to the same `0xcbe5…620d`
  (decoded from the explorer's `constructor_args`). The roles of that address now are `UNVERIFIED`. A public explorer read shows `0xcbe5…620d` is an externally owned account (`is_contract: false`), not a contract or multisig, at the time of reading. Its current role holdings are still `UNVERIFIED`.
- **Admin powers** (`src/AgenticCommerce.sol`):
  - `_authorizeUpgrade` (line 94): `DEFAULT_ADMIN_ROLE` may replace the implementation. No timelock is in the code.
  - `setPlatformFee`, `setEvaluatorFee` (lines 98-108): `ADMIN_ROLE` sets the fees and the treasury. The sum of fees is capped
    at 100%. Fees are read at completion, so a change applies to jobs already funded. `setPlatformFee` and `setEvaluatorFee` emit no event.
  - `setHookWhitelist` (lines 110-114): `ADMIN_ROLE` decides which hook contracts a client may choose.
- **Current values** of fees, treasury, and roles were not read. The explorer's method-read endpoint answered 404 (`UNVERIFIED`).
- **Lifecycle** (lines 132-304): `createJob` requires an evaluator, and `expiredAt` more than five minutes ahead (line 137);
  `setProvider`, `setBudget`, `fund`, `submit`, `complete`, `reject`, `claimRefund`. `complete` is `msg.sender == evaluator`
  (line 232). `reject` is client-when-Open, evaluator-when-Funded-or-Submitted (lines 265-271). `claimRefund` has no
  caller check and pays the client after expiry (lines 289-304). `fund` requires a provider (line 195) and a time before expiry
  (line 196). A funded job's expiry cannot be extended.
- **Open jobs have no expiry** in the code: only `fund` and `claimRefund` read `expiredAt`, and `claimRefund` needs Funded or
  Submitted.
- **Events.** `JobCreated(jobId indexed, client indexed, provider indexed, evaluator, expiredAt, hook)`, `ProviderSet`,
  `BudgetSet`, `JobFunded`, `JobSubmitted(deliverable not indexed)`, `JobCompleted(reason not indexed)`, `JobRejected`,
  `JobExpired`, `PaymentReleased`, `EvaluatorFeePaid`, `Refunded`, `HookWhitelistUpdated` (lines 50-64). `JobCreated` does not
  carry the description; the description is in storage only.
- **Reentrancy.** Lifecycle functions carry `nonReentrant` (ReentrancyGuardTransient); transfers come after state changes.
- **Blocklist or pause.** None in this contract. Whether the USDC interface at `0x3600…` can block an address or pause transfers
  is `UNVERIFIED` (not read).
- **Audit and tests.** No audit report appears in the verified source, the EIP text or the Arc docs mirror; we did not find one,
  which does not prove none exists (`UNVERIFIED`). The repository holding the contract's own tests was not read (`UNVERIFIED`).
- **Documented use.** The Arc tutorial runs the full lifecycle on testnet with developer-controlled wallets. It states the
  contract does not return the deliverable from `getJob()`. Its calls are `createJob`, `setBudget(uint256,uint256,bytes)`,
  `approve` on `0x3600…`, `fund(uint256,bytes)`, `submit(uint256,bytes32,bytes)`, `complete(uint256,bytes32,bytes)`.

### 1.4 Where the EIP prose, its reference code and the deployed contract differ

The deployed AgenticCommerce matches the reference implementation printed in the EIP, except `initialize` (it adds an admin parameter). The differences below are between the EIP prose and that code (items 1 to 5, 7 to 12), or between the EIP reference `initialize` and the deployed one (item 6). They are inconsistencies inside a draft EIP, not a divergence introduced at deployment. We compared the verified source with the EIP reference listing; we did not recompile.

| # | EIP prose | Deployed `AgenticCommerce` (src line) |
|---|---|---|
| 1 | `fund(jobId, expectedBudget, optParams?)` with a front-running check | `fund(jobId, optParams)`, no expected budget (line 190). The Arc tutorial uses this signature. |
| 2 | `setBudget` may be called by the client or the provider | provider only (line 178) |
| 3 | `fund` reverts when the budget is zero | zero budget allowed; nothing is escrowed (lines 202-204) |
| 4 | `submit` only from Funded | also from Open when the budget is zero (lines 213-216) |
| 5 | `setProvider` is hookable | no hook call in `setProvider` (lines 163-172) |
| 6 | Reference `initialize(paymentToken, treasury)`; admin is the caller | `initialize(paymentToken, treasury, admin)` (line 81) |
| 7 | `expiredAt` must be in the future | must be more than five minutes ahead (line 137) |
| 8 | Only a platform fee | also an evaluator fee paid on completion (lines 43, 241-251) |
| 9 | Hook data for `setBudget`, `submit`, `complete`, `reject` is `abi.encode(<args>, optParams)`, and for `fund` raw `optParams` | all five also prepend the caller (lines 180, 198, 219, 234, 273) |
| 10 | `fund` has no expiry check | `fund` reverts at or after `expiredAt` (line 196) |
| 11 | `createJob` is not hookable | `createJob` calls the after-hook (line 158) |
| 12 | Hooks SHOULD be gas-limited | no gas limit on hook calls (lines 118-128) |

Deviation 1 matters most for a client: without an expected budget, the front-running protection the EIP describes is absent.
Deviations 2 and 3 mean the deployed contract accepts a zero-value job that the EIP prose would reject. We did not test these on chain. A deployed contract that follows the EIP reference code faithfully inherits these contradictions.

## 2. Side by side

| Topic | Our `BindSettlement` escrow (`0x16E1…aA29`) | ERC-8183 reference (`0x0747…4583`, proxy) |
|---|---|---|
| Asset | Native USDC as `msg.value`, 18 decimals (`BindSettlement.sol` line 7) | One ERC-20 at `0x3600…`, 6 decimals (proxy init data). Approve, then fund. |
| Transactions per payment | 2: deposit, then release (or refund) | 6: createJob, setBudget, approve, fund, submit, complete (tutorial steps 4 to 8) |
| Who may release | Depositor or owner, at any time before release (line 151) | Evaluator only, and only when Submitted (`complete`, line 232) |
| Who may refund | Depositor or owner, at any time before release (line 171) | Nobody has funds to refund when Open (client may reject an Open job); evaluator when Funded or Submitted; anyone after expiry, including Submitted jobs (lines 265-304) |
| Third party in the decision | None. The depositor decides and can override. | A separate evaluator per job. The client can be the evaluator, which removes the third party. |
| Timeouts or expiry | None | `expiredAt` required; refund after expiry; no expiry for Open |
| Proof of delivery | `matchHash` stored, never checked | `deliverable` and `reason` are in events only; not checked |
| Events and indexing | `EscrowDeposited` (commitment indexed), `EscrowReleased`, `EscrowRefunded`; `findTransfer` does not read escrows | `JobCreated` indexed by job id, client and provider; no per-order key; no description in events |
| Idempotency | Commitment id is unique; a second deposit reverts (`EscrowAlreadyExists`) | Job id is a counter; a retried `createJob` creates a second job |
| Zero address and blocklist | Zero recipient refused (line 122); whitelist enforced when on (line 123). No blocklist. | Zero evaluator, treasury and admin refused at init and creation; a zero hook means no hook and is accepted (`setHookWhitelist(0)` is refused); provider zero until set. No blocklist in code; token blocklist `UNVERIFIED`. |
| Reentrancy | The contract has no reentrancy guard; it relies on setting state before the transfer. The Forge reentrancy suite (8 tests) and the in-process suite (13 tests) include deposit, release and refund from inside a callback (`test_releaseAsRecipientReentryRefused`, `test_depositFromInsideCallback`, `test_refundFromInsideCallback`, `test_releaseFromInsideCallback`). Status: `CONTRACT_SCOPE` sections 4 and 6. | `nonReentrant` on lifecycle functions |
| Admin and upgrade | One owner signer; no upgrade; owner can release or refund any escrow | Upgrade by `DEFAULT_ADMIN_ROLE`, no timelock; fees and treasury can change under live jobs; hook whitelist by admin |
| Daily limit and vendor list | Global fixed-window limit and vendor allowlist apply at deposit (lines 123-128) | None in the contract; policy only through a client-chosen hook |
| Known issues | Refund after window reset (`CONTRACT_SCOPE` section 7, item 1); fixed rather than rolling window (item 2) | Draft EIP; deviations in section 1.4; no dispute process (EIP security notes) |
| Tests and audit | Forge 24 of 24, `LOCAL_PASS` (2026-10-20); no external audit recorded in this repository; no Anvil escrow test | No test suite read (`UNVERIFIED`); no audit found (`UNVERIFIED`) |
| Standard and ecosystem | Custom; no standard; no ERC-8004 link | Draft EIP-8183; named in Arc docs and ADR 0001; ERC-8004 recommended |
| Integration cost with our adapter | No deployment needed. Needs adapter methods (today they throw), effects-ledger rows (ADR 0017, 0019), a commitment gate, the match hash (already stored). Recovery can read `getEscrow` by commitment id. | Needs ABI and approve flow, job-id storage, six-step state tracking, and an evaluator key we would manage. Recovery of a lost `createJob` means scanning `JobCreated` events (no key). Our daily limit and vendor allowlist would need a custom hook, which is new Solidity. |
| Submitted and confirmed (ADR 0079) | Deposit and release each have one receipt and one event | Each step needs its own receipt and event check; six steps per job |
| Per-business cost (ADR 0076, 0080) | One deployment per business: 1,681,387 gas measured on testnet (about 0.045 USDC), plus three configuration calls and a per-business owner key and float | One shared contract; no per-business deployment. But all businesses share one admin, treasury, upgrade path and fee setting, which is the tenancy problem ADR 0076 describes for Option B. Gas per job `UNVERIFIED`. |
| Readiness for real money | None. KYB and legal advice first (ADR 0060, 0080). | Testnet reference; mainnet status unknown (`UNVERIFIED`). |

### 2.1 Other design seen, not recommended

The Circle sample `arc-escrow` (`~/.arc-canteen/context/samples/arc-escrow`) uses a different escrow: `RefundProtocol.sol`, an
EIP-712 signed-withdrawal design with an arbiter, plus a route that asks an OpenAI model (`gpt-4o`) to decide whether work meets
the criteria (`app/api/contracts/validate-work/route.ts`). Its README says it "is not intended for production use without
modification" (README, line 173). We do not recommend it: AGENTS.md requires that model reasoning never decides money, and this design uses a model's answer to validate work (`validate-work/route.ts`); we did not trace where release is triggered. It is noted here only so the owner knows it was considered.

## 3. Options

### Option A: keep our native escrow and wire it

Work: implement `depositEscrow`, `releaseEscrow` and refund in the Arc adapter; write the effects-ledger and commitment-gate rules
for escrow; deploy one `BindSettlement` per business (ADR 0076), with a non-zero limit and its own owner key (ADR 0080).

What we must accept or fix first:
- The depositor can refund at any time, so a supplier has no protection after a deposit. A milestone escrow with that rule is a
  deposit the payer can cancel.
- The owner key can release or refund any escrow.
- The daily-window refund issue (`CONTRACT_SCOPE` section 7, item 1) stays unless the contract is replaced, because the contract is
  not upgradeable. A fix means a new deployment per business.
- Release is not gated by the match hash, so the three-way match is recorded but not enforced for escrow.

Gains: the code exists and is tested locally; one transaction per step; native USDC like `settleOrder`; no third-party contract.

### Option B: adopt ERC-8183 through the reference contract, and stop using our escrow functions

Work: an ERC-8183 adapter (approve, create, fund, submit, complete, reject, refund); job-id storage in the ledger; key management
for the evaluator; a hook contract only if our daily limit and vendor list are to be enforced on chain (a new contract, so new Solidity); otherwise the app gate enforces them, stated as not on-chain; a testnet spike.

What we must accept:
- Trust in a proxy whose admin and upgrade rights we do not know, with no timelock in the code.
- Fees and the treasury can change under live jobs.
- No audit found; deviations from the EIP (section 1.4).
- The EIP is a draft.
- Shared tenancy across businesses (ADR 0076, Option B problem).
- Six transactions per job and no per-job idempotency at creation.

Gains: a standard that Arc's documentation names; a model where the evaluator alone releases after submission and the client
cannot take the money back once work is submitted, which protects the supplier better than our escrow. The provider carries evaluator-liveness risk: after `expiredAt`, anyone can refund a Submitted job to the client.

Note: "stop using our escrow functions" does not remove them. They stay on the deployed contract.

### Option C: neither for now; pay on the three-way match only

Keep `settleOrder` as the only payment path (ADR 0079, 0080). Keep the adapter's escrow methods refusing with
`SettlementNotSupportedError`. Defer escrow until a business needs milestone escrow, and then decide between A and B with
evidence.

Cost: no pre-payment holding for suppliers. A business that wants deposit-before-delivery must wait.
Gains: no new on-chain surface; no contract deployment or configuration, so no owner approval for an on-chain action; matches
ADR 0060's order of work; reversible, because A and B stay available and the deployed functions remain on chain.

### Other variants considered (not recommended now)

**Option A variant:** redesign our escrow with evaluator or match-hash gating and an expiry, in a new contract (new Solidity, new audit trail). It removes the depositor-refund and no-proof issues, but needs the full build and audit that Option A does not yet have.

**Option D:** deploy our own, non-shared instance of the CC0 ERC-8183 reference code, per business or under a Bind-controlled admin. This removes the shared-admin and tenancy objection to B, but adds a deployment and Bind ownership of Solidity.

## 4. Recommendation: option C

Measured against AGENTS.md:
- **Smallest architecture that meets the workflow.** The kitchen workflow pays on the three-way match. No app workflow needs escrow (section 1.1, grep; scope stated there). ADR 0060 defers escrow.
- **Do not invent a contract to satisfy a checklist.** AGENTS.md says this (line 31). Here `BindSettlement` already exists. The point is not to extend it, or to add a hook contract, without a workflow that needs it.

Additional consideration (not an AGENTS.md rule):
- **Do not build both.** Choosing C means building neither.
- **Keep the choice reversible.** C changes no code and no chain state; A and B stay available. Template and skill copy that still mentions escrow would need a follow-up (section 6).

Before any escrow is built, under whichever option is chosen, the owner's approval is still needed for any deployment, any
configuration call and any move of real value (ADR 0080).

## 5. What would have to be true to accept

**To accept C (the recommendation):**
- The owner confirms that no business in the pilot needs milestone escrow, and accepts that suppliers are paid only after the
  three-way match.
- The owner accepts that ADR 0001 section 3 is superseded for escrow, or asks that it be amended (section 7, question 2).

**To accept A (our escrow, wired):**
- The depositor-refund rule and the owner override are accepted as the trust model, or the escrow is redesigned (a new
  contract, so a new deployment and a new audit trail).
- The daily-window refund issue is fixed in a new deployment or accepted in writing, with the limit set above the largest escrow.
- Release is gated by a check of the match hash, or the evaluator is an explicit, recorded decision.
- An Anvil test covers the escrow calls, and the adapter methods are tested against a real local chain.
- The owner approves each deployment and configuration call, and the key custody follows ADR 0080.

**To accept B (ERC-8183 reference):**
- The operator of the reference contract is identified, and its admin and upgrade rights are either under a multisig or timelock
  or accepted as a residual risk in writing.
- An audit report is found, or the owner accepts the risk without one. Our usage avoids the EIP prose/code inconsistencies in section 1.4 (for example we do not rely on `expectedBudget` protection, zero-budget jobs, or the hook data encoding).
- A testnet spike passes the full lifecycle, including reject, expiry refund and a lost `createJob` recovery, with the evidence
  recorded in `docs/RELEASE_EVIDENCE.md`. Gas per job is measured.
- Our policy (daily limit, vendor list) is enforced in a hook we have reviewed, or in the app's gate with the limits stated as
  not on-chain.
- Legal advice on the testnet reference and any future mainnet use (ADR 0060).

## 6. Consequences

- Under C, nothing changes in the repository except this record, the index row and a pointer in `docs/CONTRACT_SCOPE.md`. Existing copy still advertises escrow: `src/templates/agency-v1.ts` (lines 14, 75), `templates/coffee-roaster/skills/supply-replenishment/SKILL.md` (line 10), and the `escrow.*` classes in `src/policy/effect-classifier.ts` (lines 31-32). A follow-up should reword the template and skill text so they do not promise an escrow the Arc adapter refuses. Not done in this record.
- Under A or B, a separate ADR and build plan follow after the owner answers section 7.
- The deployed `BindSettlement` escrow functions stay on chain under every option. Their known issues stay documented in
  `docs/CONTRACT_SCOPE.md`, section 7.

## 7. Owner decisions needed

1. Does any business need milestone escrow in the pilot period? If no, accept C. If yes, choose A or B.
2. Does ADR 0001 section 3 still stand? It says "Decision: `NOT_APPLICABLE` for custom Bind-owned Solidity in the initial vertical slice", and its rationale says the "established standards (... ERC-8183 Agentic Commerce Escrow) already provide battle-tested onchain trust, escrow, and settlement primitives". `BindSettlement` is deployed and carries its own escrow. Decide whether to supersede it. This record's findings (draft EIP, upgradeable proxy, EOA admin at init, no audit found) do not support the word "battle-tested".
3. If B: who operates the reference contract, who holds its admin and upgrade role, and is an upgradeable third-party contract
   acceptable for supplier money?
4. If A: is a depositor who can refund at any time, and an owner who can override, acceptable as the trust model for suppliers?
5. Custody: who holds the evaluator key (B) or the owner key (A)? ADR 0080 says a business-held owner key and a Bind-run payer
   float; confirm for escrow too.
6. Fees and treasury (B): is any platform fee acceptable, and to which treasury? The reference's treasury at initialisation was
   `0xcbe5…620d`; its current value is `UNVERIFIED`.
7. Audit and legal: is an audit or legal review of the reference (testnet) needed before any real money? ADR 0060 already requires
   legal advice before live money.

Nothing in this list authorises a deployment, a configuration call, a live transfer or a mainnet step.

## 8. Not verified

- The current admin, fee, treasury and token values of the reference proxy. The explorer's method-read endpoint returned 404, and
  no node call was made. `UNVERIFIED`.
- That the deployed bytecode of the proxy and of `AgenticCommerce` matches the verified source. We did not recompile. `UNVERIFIED`.
- Whether an audit of the reference exists. We found none in the sources read. `UNVERIFIED`.
- The reference's own test suite. Its repository was not read. `UNVERIFIED`.
- Whether the native USDC interface at `0x3600…` has a blocklist or pause. `UNVERIFIED`.
- Gas per ERC-8183 job. Not measured. `UNVERIFIED`.
- Whether the reference is deployed on mainnet. Unknown. `UNVERIFIED`.
- Whether any escrow function of our deployed `BindSettlement` has been called on chain. The live record does not say. `UNVERIFIED`.
- BindSettlement has no way to change owner. Read from source; no test of key rotation.
- Where the Circle sample releases funds after model validation was not traced. `UNVERIFIED`.
- No transaction was sent to either contract in this record. No chain state was changed.
- Coverage of the reading: the Arc tutorial was read in its steps and function calls, not in full. The ERC-8004 tutorial was read
  only for its registry table. The ADRs 0060, 0076, 0080 and 0081 were read in their opening sections; the rest of each was not read.
  The Circle sample was read only for its contract's function list and one route. Each of these limits the claims in sections 1 and 2.

## Evidence classes used

- `LOCAL_PASS` for our own contract tests: `docs/CONTRACT_SCOPE.md`, section 6, 2026-10-20.
- Reading the public verified source on 2026-10-25 is a read of published data. It is not a node call, and it is not a
  reproduction of behaviour. Claims from it are stated as read from the source, not as observed behaviour.
- Everything marked `UNVERIFIED` above has no evidence class yet and must not be reported as passing.
