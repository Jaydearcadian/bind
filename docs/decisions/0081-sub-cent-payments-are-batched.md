# ADR 0081: Sub-cent charges are accrued and settled in whole cents

## Status
Accepted (2026-10-23), on the owner's instruction ("go with your recommendations"). Resolves the open decision in ADR 0078. The settle rules below are
conservative defaults the owner can change; no money moves under this ADR.

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

## Not built yet
The tab ledger, its settle rule and its tests. Nothing here changes behaviour today: sub-cent amounts are still refused.

## Consequences
When built, this adds a per-counterparty accrual table and a settle step to the worker, tested for duplicate charges, crash between settle and clear, and
cross-tenant access. Until then agent-to-agent sub-cent charges cannot be paid.
