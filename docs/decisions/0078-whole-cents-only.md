# ADR 0078: Whole cents only; amounts below one cent are refused

## Status
Accepted (2026-10-22), on the owner's instruction. Resolves the open point recorded in ADR 0076.

## Context
`TransferRequest.amountCents` is a bigint of USDC cents and the Arc adapter sends `amountCents * 10^16` wei, so one cent is 0.01 USDC and the
smallest payment Bind can make is 0.01 USDC. The contract itself accepts any non-zero amount, and orders, the ledger and the three-way match
all use whole cents. Agent-to-agent payments are often fractions of a cent, so this will matter.

## Decision
- **Nothing is paid below 0.01 USDC** until the owner makes a separate decision on sub-cent amounts.
- The settlement adapters (Arc and the local simulator, for parity) refuse a zero, negative, fractional or non-bigint amount with the rejection
  code `SUB_CENT_AMOUNT_NOT_SUPPORTED` and a plain message, before any network call, so nothing is ever sent. The settlement service treats it
  like any `SettlementRejectedError`: the order is held as `payment_hold` with `SETTLEMENT_REJECTED` and the code is in the audit evidence.
- Other invalid requests (bad address, missing order id, bad match hash) keep the generic `INVALID_REQUEST`.

## Open decision (owner), before agent-to-agent payments
How to pay amounts below one cent: a smaller base unit in order and ledger types (a migration), a separate micro-payment path, or batching small
amounts into whole cents. This ADR does not choose.

## Consequences
Anything that needs to pay less than 0.01 USDC is refused with a clear error, not rounded up or down. Rounding silently would change what the owner approved.
