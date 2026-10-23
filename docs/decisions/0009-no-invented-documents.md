# ADR 0009: No invented documents, one settlement path

## Status
Accepted (2026-10-19)

## Context
The studio document-confirm route had its own settlement path. Confirming a bill alone created a receipt
copied from the purchase order, and confirming a receipt alone created a bill copied from it. The match then
passed and the supplier was paid. That breaks the rule that no invoice settles without a verified receipt, and
it fabricates records. The studio path also had no claim, so repeated or concurrent confirmations could pay twice.

## Decision
- **Stored documents only.** The studio route records the owner-confirmed receipt or bill it was given, nothing
  else. A missing counterpart returns `pending` (`AWAITING_DELIVERY_RECEIPT` or `AWAITING_SUPPLIER_BILL`) with
  `matchStatus: UNMATCHED`, and writes no match row.
- **One settlement path.** `OrderSettlementService.settle` (`src/workflows/settlement.ts`) owns the claim, match,
  payment, restock, workflow transition, audit and journal. The runner and the studio route both call it.
- **Failed matches are audited once** as `accounting.three_way_match_failed` (system actor, DENY), before the
  match row is upserted.
- **Identity is checked before recording.** A document whose SKU differs from the order, or a bill whose vendor
  differs from the order's supplier, is refused before any row is written.
- **Flow D changed.** The two Flow D tests now confirm a delivery receipt first. They passed before only because
  the invented receipt was created. Their bad-bill and good-bill assertions are unchanged.

## Consequences
- A bill or receipt on its own never moves money.
- The studio path honours the claim and can no longer settle an order that is not `confirmed`.
- Open: the web UI does not render `pending` yet, so a pending receipt shows as a blocked match. A settlement
  failure after a studio confirmation leaves the document `owner_confirmed`, so a repeat confirmation replays
  without retrying. Recovery is `POST /api/orders/:id/reconcile`.
