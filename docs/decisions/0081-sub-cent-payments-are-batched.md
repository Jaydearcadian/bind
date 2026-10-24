# ADR 0081: Sub-cent charges are accrued and settled in whole cents

## Status
Accepted (2026-10-23), on the owner's instruction ("go with your recommendations"). Resolves the open decision in ADR 0078. The settle rules below are
conservative defaults the owner can change. Built locally (`LOCAL_PASS`); live Arc untested. See the addendum below.

## Context
The settlement adapters pay whole cents only and refuse anything smaller (ADR 0078). Agent-to-agent charges can be fractions of a cent. Measured on Arc
testnet, one settlement costs about 0.003 USDC in gas (roughly 76,000 gas at 40 gwei), so settling a charge below a cent on its own would cost more in gas
than the charge. Options considered: batch small charges into whole-cent settlements (1), change the base unit to micro-USDC everywhere (2), or build a
separate micro-payment path such as vouchers or channels (3).

## Decision: option 1, accrue and settle in whole cents
- A charge below one cent is **not** paid on its own and not rounded. It is recorded as a ledger entry against a counterparty (a tab).
- A tab is settled with a normal whole-cent settlement through the adapter and the effects ledger once it reaches **one cent**, or at the end of the day if it
  is at least one cent. A tab under one cent at the end of the day carries over. Defaults, owner can change.
- The 0.01 USDC minimum and the `SUB_CENT_AMOUNT_NOT_SUPPORTED` refusal (ADR 0078) stay for single payments. The contract and the adapter are unchanged.
- Every accrued charge and every settlement that clears a tab is a ledger entry with its own record, so the tab balance is auditable and a crash never
  pays a tab twice (the same idempotency and recovery rules as any settlement, ADR 0019 and ADR 0079).
- Options 2 and 3 are deferred until a real product needs a single payment below a cent.

## Not built yet (superseded)
The tab ledger, its settle rule and its tests. Built on 2026-10-23; see "Built" below. The 0.01 USDC minimum for single payments is unchanged.

## Consequences
When built, this adds a per-counterparty accrual table and a settle step to the worker, tested for duplicate charges, crash between settle and clear, and
cross-tenant access. Until then agent-to-agent sub-cent charges cannot be paid.

## Built (2026-10-23, addendum)

Built locally as specified above. Evidence: `LOCAL_PASS` only (local PostgreSQL, a spy adapter and the local simulator). Live Arc is untested and no live evidence is claimed. Details, states, recovery, API and the not-verified list are in `docs/CONTRACT_SCOPE.md`, "Tab ledger".

Decisions taken during the build, and the review revisions to them (conservative, reversible):
- **Unit.** Micro-USDC as bigint everywhere in the tab layer. One cent is 10_000 micro. A settlement is `floor(balance / 10_000)` cents, and at most one chunk (the approval threshold) per attempt. The adapters are unchanged.
- **Charge limit (revised).** A charge is at most **25 USDC** (`MAX_CHARGE_MICRO`, a named constant). The review asked for a limit so that no single charge is large in one step. Note: 25 USDC is one tenth of the default approval threshold (250 USDC), not half of it; the review's "half" premise assumed a 50 USDC threshold. The limit is the constant, and the docs say so.
- **Above the threshold (revised).** The first version answered `needs_approval` and left the balance stuck. A balance now settles in chunks of at most the threshold. Each chunk is its own settlement through every gate and the daily budget; the rest carries over. A threshold below one cent cannot chunk, and still answers `needs_approval`. A balance whose first chunk is blocked by the budget is left untouched.
- **Gate holds own no balance.** A settlement refused by the verification or address gates is stored as `held` with a `hold_reason` and no clear entry. It owns nothing, and the budget does not count it. A `held` settlement that was cleared (failed or unknown outcome) keeps its clear, and the budget counts it.
- **Cancel and reversal (revised).** A cancel reverses a clear only when nothing can have been sent: the first attempt (no effect row existed) and a code in `PRE_SEND_REJECTION_CODES` (`INVALID_REQUEST`, `SUB_CENT_AMOUNT_NOT_SUPPORTED`, `PAYER_MISMATCH`), each raised before the pre-flight in `arc-l1.ts`. `OrderAlreadySettled`, `UNKNOWN_REVERT`, any other revert, any refusal on a retry, and a gate that fails after an effect row exists are holds with the clear kept. The first version cancelled on any retry refusal and on a gate that failed after a send; both could pay twice. Regression tests cover each.
- **Serialisation (revised).** A per-settlement execution lock (`tab_exec:<id>`) makes the gate check, the cancel and the send mutually exclusive. The reserve takes the workspace spend lock (`spend:<workspace>`, the lock order reservation already takes), so every budget decision in a workspace is serialised across counterparties. Order reservation is unchanged; it shares the same lock. Residual: an order's commit and a tab's reserve are serialised by that lock, but the order code's own budget read is unchanged.
- **UTC budget day (revised).** The tab budget and the commitment gate both use the UTC day. The commitment gate's `CURRENT_DATE` is replaced; the replenishment tool's pre-check (`src/agents/replenishmentTools.ts`) still uses `CURRENT_DATE` (an advisory read; the gate decides). Residual, recorded.
- **One daily sum on both sides (second review).** The first version counted tab settlements on the tab side only: an order could be committed on top of same-day tab spend, and the combined spend could exceed the limit. The order commitment gate now counts today's tab settlements that own a clear, through the same fragment the tab reserve uses (`TAB_SPEND_TODAY_CENTS_SQL`). Existing order-gate tests pass unchanged (they have no tab rows); `tests/integration/tab-budget-symmetry.test.ts` pins both directions, and the first case fails on the previous gate. Still open: the procurement re-check and the replenishment pre-check read the gate outside the spend lock, and the pre-check still uses `CURRENT_DATE`. Both are advisory; the reservation under the lock is authoritative.
- **Fail-closed lookup (stated).** When the adapter's `findTransfer` is unavailable and a transfer may have moved, the settlement stays `pending`, is retried each stale window, is never resent and never cancelled. It finishes exactly once when the lookup returns. It can therefore stay pending indefinitely while the lookup is down. Pinned by a regression test.
- **Cancel guards pinned (second review).** A transport error before the send, followed by an INVALID_REQUEST refusal on the retry, is held and not reversed (the effect row exists, so the first-attempt condition fails). A completed effect whose gate now fails is held, with one transfer in total. Both are regression tests; removing the first-attempt condition makes the first one fail (checked on a scratch copy).
- **End-of-day starvation (second review).** A tab whose reserve throws has its failed attempt recorded outside the rolled-back transaction, so the batch moves past it. This is a regression test. With a batch of N, N tabs that keep failing can still occupy the whole batch; that is stated, not fixed.
- **Confirmation claim without a new status.** The status set is the five in the brief. Confirmation is claimed with a per-settlement advisory lock (`tab_confirm:<id>`), so only one caller asks the adapter, and the record is finalised only with `tx_hash` still matching.
- **Duplicate rule.** ADR 0079's rule (a REVERTED outcome may be a second broadcast; adopt the other transfer only when `findTransfer` says it is CONFIRMED and different) is applied to tabs.
- **End-of-day claim (revised).** The first version wrote an audit marker before the settle, so two batches could both settle a tab and a crash could skip it. The claim is now one conditional upsert on `tab_attempts` in the same transaction as the reservation. Every attempt records `last_attempt_at`; the batch orders by it, so no tab starves. A refusal or approval audit is written at most once per counterparty per UTC day.
- **Test replaced (stated).** `tests/integration/tab-ledger.test.ts` no longer has the case "an amount above the approval threshold needs approval". It was replaced on purpose by the chunking tests (above the threshold settles one chunk; a threshold below one cent still needs approval; a blocked first chunk leaves the balance untouched), because the behaviour it pinned, a stuck balance, is what the review found wrong.
- **Charges while paused.** Recorded, as obligations. Settlement is refused with `AGENTS_PAUSED` (answered 200 with the outcome, as order reconcile does), and nothing is cleared or sent.
- **Agent charges are paid without per-charge approval (stated explicitly).** A charge recorded by an agent (a staff token) is paid by the worker at the end of the UTC day, without a per-charge owner approval. The payment is bounded by: the approval threshold (one chunk at most), the daily budget, the pre-send and hold rules, the 25 USDC charge limit, and the pause switch. The owner's controls are the pause, the threshold and the budget.
- **Worker.** One step, `tab_settlements`, after `stuck_settling`. End-of-day is on by default; settle-on-threshold is off.
- **Audit.** Charges, reserves, refusals, holds, submissions, confirmations, cancellations, reverted-duplicate adoptions and the refusal and approval rows are audited in the transaction that writes them.
- **Exposure.** `recordTabCharge` is `data_entry` (economic); `settleTab` is `commercial_commitment`, irreversible and owner-only; both are `preview`. Neither is an MCP tool, so the three agent commitment tools are unchanged.
- **Idempotency.** `recordTabCharge` and `settleTab` are in `IDEMPOTENT_ROUTES`, because the catalogue test requires every economic or irreversible public write to be.

Tests (all `LOCAL_PASS`): `tests/unit/tab-units.test.ts` (12); `tests/integration/tab-ledger.test.ts` (37, including the four-counterparty budget race and the far-offset UTC day); `tests/integration/tab-recovery.test.ts` (17, including the gate-flip, UNKNOWN_REVERT, OrderAlreadySettled, racing batches, crash-after-attempt, starvation and refusal-audit regressions); `tests/integration/tab-fuzz.test.ts` (4, seeded, with a path-coverage check); `tests/integration/tab-api.test.ts` (14). Existing tests changed: `tests/integration/api-contract.test.ts` (a tab seeding and one path value added), `tests/integration/auth-tenancy.test.ts` (route table entries added), and in `tests/integration/tab-api.test.ts` the limit expectations moved to 25 USDC. No existing assertion of an order, a worker or a commitment test was changed.

**REQUIRED BEFORE ANY LIVE ARC RUN OF THE TAB PATH** (none of these is built):
- (a) An operator route, or a worker re-reconcile, for `held` tab settlements. A held settlement keeps its clear and has no exit today; a confirm-time failure such as `EVENT_MISSING` holds forever.
- (b) The busy-lock case where the original caller's `recordSubmitted` loses the hash. The hash survives in `effects.external_ref`; the worker should adopt it rather than hold.
- (c) A live Arc run of the tab path, on the testnet, with the evidence recorded in `docs/RELEASE_EVIDENCE.md`.

Not done: a live Arc run; an operator route to resolve a held tab; a load test; the Anvil suite (not run here); the replenishment pre-check's `CURRENT_DATE`.
