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

Decisions taken during the build (conservative, reversible):
- **Unit.** Micro-USDC as bigint everywhere in the tab layer. One cent is 10_000 micro. A settlement is `floor(balance / 10_000)` cents. A charge is at most 100 USDC. The adapters are unchanged.
- **Gate holds own no balance.** A settlement refused by the verification or address gates is stored as `held` with a `hold_reason` and no clear entry. It owns nothing, and the budget does not count it. A `held` settlement that was cleared (failed or unknown outcome) keeps its clear, and the budget counts it.
- **Counterparty.** A counterparty is a supplier of the same workspace. A composite foreign key `(workspace_id, counterparty_id)` makes the database refuse a cross-workspace row, and deleting a supplier that has tab rows is refused.
- **Confirmation claim without a new status.** The status set is the five in the brief. Confirmation is claimed with a per-settlement advisory lock (`tab_confirm:<id>`), so only one caller asks the adapter, and the record is finalised only with `tx_hash` still matching.
- **Duplicate rule.** ADR 0079's rule (a REVERTED outcome may be a second broadcast; adopt the other transfer only when `findTransfer` says it is CONFIRMED and different) is applied to tabs. It applies because the ledger's reconcile path re-sends when a lookup returns null, which is how a second broadcast can arise.
- **Charges while paused.** Recorded, as obligations. Settlement is refused with `AGENTS_PAUSED` (answered 200 with the outcome, as order reconcile does), and nothing is cleared or sent.
- **Above the threshold.** `needs_approval` (200). There is no approval flow for tabs in this slice, so such an amount stays in the balance.
- **Worker.** One step, `tab_settlements`, after `stuck_settling`. End-of-day is on by default; settle-on-threshold is off. An attempt is recorded before settling, so a tab is attempted once per UTC day.
- **Audit.** Charges, reserves, refusals, holds, submissions, confirmations, cancellations, reverted-duplicate adoptions and end-of-day attempts are all audited in the transaction that writes them.
- **Exposure.** `recordTabCharge` is `data_entry` (economic); `settleTab` is `commercial_commitment`, irreversible and owner-only; both are `preview`. Neither is an MCP tool, so the three agent commitment tools are unchanged.
- **Idempotency.** `recordTabCharge` and `settleTab` are in `IDEMPOTENT_ROUTES`, because the catalogue test requires every economic or irreversible public write to be.

Tests (all `LOCAL_PASS`): `tests/unit/tab-units.test.ts` (11); `tests/integration/tab-ledger.test.ts` (33); `tests/integration/tab-recovery.test.ts` (10); `tests/integration/tab-fuzz.test.ts` (4, seeded, with a path-coverage check); `tests/integration/tab-api.test.ts` (14). Existing tests changed: `tests/integration/api-contract.test.ts` (a tab seeding and one path value added) and `tests/integration/auth-tenancy.test.ts` (the three owner routes and one member route added to the tables). No existing assertion was changed.

Not done: a live Arc run; an operator route to resolve a held tab; an approval flow for tabs above the threshold; a load test; the Anvil suite (not run here).
