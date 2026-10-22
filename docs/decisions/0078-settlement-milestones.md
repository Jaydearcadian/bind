# ADR 0078: Submitted and confirmed are separate, durable settlement milestones

## Status
Accepted (2026-10-22). Builds on ADR 0014 (an order is paid only after the transfer is confirmed), ADR 0017 (effects
ledger), ADR 0019 (the transfer goes through the ledger) and ADR 0030 (lost-claim reattach).

## Context
`OrderSettlementService.settleClaimedOrder` stored the transaction hash and then confirmed it in the same call. The
records never showed `submitted` as a milestone of its own. A crash between the two left the order in `settling`, and
only the worker's stuck-claim step (ADR 0029) recovered it.

## Decision
- Schema: `orders.settlement_submitted_at`, `orders.settlement_confirmed_at` (TIMESTAMPTZ) and
  `orders.settlement_confirmed_block` (BIGINT), added with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in
  `src/db/schema.sql`. Nothing is backfilled; rows settled before this change keep NULL.
- A transfer the adapter reports as sent (`submitted` or `confirmed` at send) is recorded as `submitted` before any
  confirmation is asked for. In one transaction, guarded on `status = 'settling'`: the hash, the payment record,
  `settlement_submitted_at = NOW()`, the status `settlement_submitted` (which releases the claim) and a
  `settlement.submitted` audit row (ALLOW, `{ orderId, txHash }`, with the hash in the audit's `tx_hash`).
- The order is then confirmed through `confirmSettlement`: a fresh atomic claim from `settlement_submitted` to `settling`,
  one `adapter.confirm`, and finalising on `confirmed`. `settle` still returns `reconciled: true` with the hash when the
  confirmation succeeds in the same call. An unresolved outcome keeps `settlement_submitted` and returns
  `AWAITING_SETTLEMENT_CONFIRMATION`. A failed outcome holds the order with `SETTLEMENT_FAILED`. These are unchanged.
- Finalising a confirmed payment sets `settlement_confirmed_at = NOW()` and `settlement_confirmed_block` (from
  `TransferResult.blockNumber`, NULL when the adapter does not report one) in the same transaction as the restock. It
  writes a `settlement.confirmed` audit row (ALLOW, `{ orderId, txHash, blockNumber }`, with the hash in `tx_hash`).
  The audit row rolls back with the restock if the restock fails.
- A transfer the adapter reports as `failed` outright keeps the path of ADR 0014: the hash and the payment record are
  stored on the claim and the order is held with `SETTLEMENT_FAILED`. Nothing is pending, so no `submitted` milestone
  is written for it.
- The lost-claim reattach (ADR 0030) also sets `settlement_submitted_at` and writes `settlement.submitted`, because it
  stores the same hash as `settlement_submitted`.
- The worker is unchanged. `stuckSettlingStep` still moves a `settling` row with a hash back to `settlement_submitted`.
  With this change that state means the process died inside the confirmation, so the recovery is still right. The
  comment on the step records this. The confirmation poll is unchanged.
- The order read model (`GET /api/workspaces/:id/orders[/:orderId]`) selects `o.*`, so the three columns appear there
  as additive snake_case fields. No typed schema changed.

## Consequences
- A crash after the hash is stored leaves the order `settlement_submitted`, which the worker's poll finds, instead of
  `settling`.
- The adapter's `confirm` is now called after every sent transfer that is not `failed`, including one reported
  `confirmed` at send. This is one extra receipt lookup for the Arc adapter. It is what makes `confirmed` mean "the
  adapter confirmed it" and not "the adapter said so at send".
- A failure while finalising after a confirmed transfer (the restock write) now releases the order to
  `settlement_submitted`, not `settling`. The error is still thrown to the caller. A later confirmation finishes the
  restock once.
- `settlement.submitted` is written only with the transaction that stores the hash, so a missing submitted row means
  the hash was never stored.

## Test changes (recorded, per AGENTS.md)
- Added: `tests/integration/settlement-milestones.test.ts` (9 tests). The spy's `confirm()` reads the database and the tests
  assert on what it saw, because `confirmOnce` catches every error thrown by `confirm()`.
- `tests/integration/reconcile-once.test.ts`, "keeps the order settling with the payment recorded when the finalising
  step fails": the title now says `settlement_submitted`, the status is `settlement_submitted` instead of `settling`, and
  the retry result is `AWAITING_SETTLEMENT_CONFIRMATION` with the stored hash instead of `RECONCILE_IN_PROGRESS`. The
  reason is the release described above. The assertions that the payment is recorded, the stock is unchanged and the
  transfer is made once are unchanged.
- No other existing assertion changed.

## Not done
- No backfill of `settlement_submitted_at` or the confirmation columns for rows settled before this change.
- No read-model typing for the new fields (they appear only through the raw order row).
- The Arc adapter path (`settlement-confirmation`, `arc-settlement-evm`) ran in-process. The Anvil suite did not run
  (`ANVIL_RPC_URL` not set, Anvil not installed), so it is NOT_RUN here.
