# ADR 0008: Reconcile exactly once

## Status
Accepted (2026-10-19)

## Context
`ProcurementWorkflowRunner.fulfillAndReconcile` had no guard. A second call (double click, retry after
a timeout) paid the supplier again and restocked again, and only then failed on the workflow transition.

## Decisions
- **Claim before any effect.** `UPDATE orders SET status='settling' WHERE id=$1 AND status='confirmed'
  RETURNING *`. Exactly one caller gets a row. `settling` is free text like the other order statuses, so no
  schema change is needed for it.
- **Losers.** After completion a loser returns the stored result (`alreadyReconciled: true`, stored
  `tx_hash`, stored match status) and calls no adapter. While the winner is still working a loser returns
  `hold: "RECONCILE_IN_PROGRESS"`.
- **Failure releases the claim.** If anything fails before the settlement adapter returns, or the match is
  not `MATCHED`, the order goes back to `confirmed`. Nothing has been restocked or journaled at that point.
  If a failure happens after the adapter returned a payment, the order is deliberately left `settling`
  rather than offered for a second payment. The returned tx hash is written to the `settling` row
  immediately after the adapter returns, so the payment stays on record. Recovery is Tasks 5 and 10.
- `settling` counts toward the daily spend budget (three queries in `replenishmentTools.ts`).
- **Pay record and restock in one transaction**, guarded by `status='settling'`, so restock cannot repeat.
- **Receipts and bills are reused on retry.** The simulated supplier adapter makes ids with `Date.now()`,
  so a retry would otherwise insert a second receipt and bill. The runner now reads the stored ones first.
- **One match row per order.** Id is `match_<orderId>` and a unique index on `three_way_matches(order_id)`
  backs `ON CONFLICT (order_id) DO UPDATE` (latest evaluation wins, same as the studio path). The migration
  keeps the latest historical row per order and first copies every other row into
  `three_way_matches_archive`, because the old code generated a new id every call and the index could not
  otherwise be created.
- **Constructor injection** of `settlementFor` and `supplierFor`, defaulting to the production factories.

## Studio document path
`src/studio/documentsAndAccounting.ts` also writes `three_way_matches`, once per confirmed document, so the
unique index would reject a corrected bill for the same order. Its insert now upserts on `order_id` (latest
evaluation wins). Its settlement path still lacks the claim guard.

## Known gap
The studio settlement path (same file) has the same missing pay/restock guard. It is not changed here.
