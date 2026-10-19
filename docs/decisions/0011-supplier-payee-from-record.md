# ADR 0011: The payee comes from the verified supplier record

## Status
Accepted (2026-10-19)

## Context
Settlement paid one hard-coded vendor address for every order and fell back to a shared demo deployer
wallet when a workspace had no settlement address. Suppliers had no payment address. Paying the wrong
party is the error this project exists to prevent.

## Decision
- The payee is `suppliers.payment_address` of the order's own supplier. The payer is the workspace
  `settlement_address`. Neither comes from a constant.
- After the 3-way match passes and before payment, a missing or unverified supplier, a missing supplier
  payment address, or a missing workspace settlement address moves the order to `payment_hold` with
  `SUPPLIER_NOT_VERIFIED`, `SUPPLIER_PAYMENT_ADDRESS_MISSING` or `WORKSPACE_SETTLEMENT_ADDRESS_MISSING`.
  A `settlement.payment_hold` audit row (DENY) records the code. Nothing is paid or restocked.
- `payment_hold` is still a commitment: it counts toward daily spend, and it is claimable, so the order
  pays exactly once after the record is fixed.
- No shared default payer wallet. A local workspace gets `simulatedPaymentAddress("workspace:<id>")`.
  An arc-testnet workspace without an address stores NULL, and its payments are held.
- Simulated suppliers get `simulatedPaymentAddress(id)`: deterministic, lowercase, labelled simulated,
  and not a real wallet. The SQL backfill uses the same algorithm.
- A studio `manual_quote` supplier has no payment address on purpose. The owner must add one.

## Consequences
- A payment can only reach an address recorded on the order's own supplier.
- Existing workspaces keep their address. Real suppliers without an address stay held until the owner
  adds one. Held orders are visible as `payment_hold` and are not retried automatically.

## Fix round 1
- A caller that loses the claim retries it once if the order is `payment_hold`. If it is still held, the
  caller reports `RECONCILE_IN_PROGRESS` and never throws.
- Every release restores the status the claim replaced (`confirmed` or `payment_hold`), so a failed retry
  keeps the hold label.
- A supplier from another workspace counts as `SUPPLIER_NOT_VERIFIED`.
