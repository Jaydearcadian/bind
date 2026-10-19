# ADR 0014: An order is paid only after the transfer is confirmed

## Status
Accepted (2026-10-19)

## Context
`OrderSettlementService` treated any returned transfer as paid, so a `failed` result was restocked and journaled.
ADR 0013 made the adapter report `submitted | confirmed | failed` but did not change the caller. The Arc adapter
also requires a `matchHash`, which the caller did not pass.

## Decision
- `settle` passes `matchHash = keccak256(encodePacked(["string","string","string"], [orderId, receiptId, billId]))`.
- The outcome of a transfer decides the order's state:
  - A thrown `SettlementRejectedError` makes no transfer. The claim goes to `payment_hold` with `SETTLEMENT_REJECTED`
    and audit `settlement.rejected` (DENY, `{ orderId, code }`).
  - `failed`, or `submitted` then `confirm` returning `failed`, goes to `payment_hold` with `SETTLEMENT_FAILED` and
    audit `settlement.failed`.
  - `confirmed`, or `submitted` then `confirm` returning `confirmed`, runs the finalising step.
  - `submitted` with an unresolved outcome (a `submitted` confirm, or a confirm that throws) stores the hash, sets
    `settlement_submitted`, audits `settlement.submitted` (ALLOW) and returns `pending: AWAITING_SETTLEMENT_CONFIRMATION`.
    It does not restock, journal or touch the workflow. A throw is treated as unknown, never as failure.
- A thrown error from `transferUSDC` that is not a rejection releases the claim, as before. `progress.paid` is set only
  after a transfer returns, so a failed send is never recorded as paid.
- `confirmSettlement(orderId)` claims `settlement_submitted` in one statement, asks the adapter for the outcome once and
  finishes, holds or restores the order as above. Its restock quantity and payable amount come from the latest stored
  delivery receipt and supplier bill, the same rule the studio and runner evidence loaders use.
- A `settle` call on a `settlement_submitted` order returns the stored hash with `AWAITING_SETTLEMENT_CONFIRMATION`
  and never sends a transfer. `confirmSettlement` on an order that it cannot claim but that is still
  `settlement_submitted` (a holder restored it in the same instant) returns the same result rather than throwing.
- The finalising step (restock and status in one transaction, anti-drift write, transition, audit, journal) is one
  private method used by both paths. The anti-drift label is `SETTLED_ON_ARC_TESTNET` only for the Arc adapter and
  `SETTLED_LOCAL_SIMULATION` for every other adapter. Both labels read as "awaiting physical delivery".
- `settlement_submitted` counts toward the daily spend. The three spend queries read one list,
  `SPEND_COUNTING_ORDER_STATUSES` in `src/orders/statuses.ts`.
- `POST /api/orders/:id/confirm-settlement` returns 200 with the result, 404 `ORDER_NOT_FOUND`, 409
  `ORDER_NOT_AWAITING_CONFIRMATION`, or 400 for other errors.

## Consequences
- An Arc-testnet replenishment still requires `NEBIUS_API_KEY` to start, so Arc tests start the order on a local
  workspace and then switch that workspace to Arc settlement. This is test setup only.
- A payment that was sent and never confirmed stays `settlement_submitted` until someone calls `confirm-settlement`.
  There is no automatic poller yet.
