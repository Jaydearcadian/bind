# ADR 0019: The settlement transfer goes through the effects ledger, and adapters can look a transfer up

## Status
Accepted (2026-10-19). Implements Task 5c. Builds on ADR 0013 (truthful Arc states), ADR 0014 (settlement
confirmation) and ADR 0017 (effects ledger). ADR 0018 covers order submission.

## Context
`OrderSettlementService.settle` called `settlementAdapter.transferUSDC` directly. If the process died, or an
unknown error was thrown, after the transfer was sent, nothing recorded that a transfer had been attempted. A retry
could send it again. The Arc contract's `OrderAlreadySettled` guard protects the chain. The local simulator and any
future adapter had no such guard.

## Decision

### What is in the ledger
- The transfer is the only money-moving call in `settle`. It runs through `runEffect` with
  - operation `settlement.transfer_usdc` (commercial commitment, already in the classification map),
  - idempotency key `<workspaceId>:settle:<orderId>` (the workspace id is part of the key),
  - request `{ fromAddress, toAddress, amountCents, currency, orderId, matchHash, idempotencyKey }`, of which only the
    hash is stored.
- The adapter's transfer idempotency key stays `idem_pay_<orderId>`.
- `confirm`, `confirmSettlement`, the restock, the journal and the workflow transition are not in the ledger. They
  are unchanged.

### Outcomes of the transfer call
- `SettlementRejectedError` means nothing was sent. The order goes to `payment_hold` with `SETTLEMENT_REJECTED`.
  The next attempt reconciles first. A `null` lookup means nothing was made, so the transfer is sent again.
- Any other thrown error (a plain `Error`, a network error) is an **unknown outcome**. The transfer may have been
  made. The ledger records the effect as `failed`, and the error is rethrown as before, so the claim is released.
- A `failed` ledger row is in doubt. Without a lookup, the next attempt does not call the adapter. It goes to
  `payment_hold` with `SETTLEMENT_OUTCOME_UNKNOWN` and audit `settlement.in_doubt` (effect id and attempts, no
  transaction hash). With a lookup, the next attempt calls `findTransfer` first. A transfer found is adopted, and
  one not found is sent once more.
- A completed effect replays its stored `TransferResult`, and the adapter is not called.

### What each adapter can reconcile
- `LocalSettlementSimulator` (in memory, lost on restart). Remembers each transfer under its idempotency key and under
  its order id. The same key returns the same result and moves no money. A second key for an order that is already
  settled returns the earlier transfer and moves nothing, as the Arc contract does. A failed insufficient-balance
  attempt is not remembered. `findTransfer` returns the remembered transfer or `null`.
- `ArcL1SettlementAdapter`. `findTransfer({ orderId })` computes `keccak256(toHex(orderId))` as `transferUSDC` does. It
  reads `SettlementExecuted` logs, filtered on the indexed order id, from `BIND_SETTLEMENT_DEPLOY_BLOCK` to the latest
  block. A log returns `confirmed` with its transaction hash and block number. A log is emitted only by a successful
  transaction, which is why a log means `confirmed`. A log with no transaction hash throws. No log returns `null`. An
  RPC failure throws a `SettlementTransportError` with the operation `settlement lookup`. It is never reported as
  `null`, and it carries no URL or key.
- An adapter without `findTransfer` cannot reconcile. Its unknown outcomes stay in doubt until a person resolves them.

### Arc in-flight caveat
A transfer that was sent but is not yet mined has no log. `findTransfer` then returns `null` while money is in
flight. This is safe only because the contract refuses a second `settleOrder` for the same order id
(`OrderAlreadySettled`). A retry that sends again therefore reverts instead of paying twice. A non-Arc adapter must
not rely on this. It must make its own lookup or idempotency guarantee, or it stays in doubt.

## Known edge (accepted, no code change)
If the ledger's completed-mark write fails after the adapter has returned a transfer, `runEffect` throws a database
error. `progress.paid` is still false, so the claim is released to `confirmed`, while the ledger row stays `started`.
The next attempt does not send again. Without a lookup it is in doubt and held. With a lookup it reconciles. Either way
no second payment is made, but the order is no longer claimed while a transfer may exist. Resolving that needs a
person or a lookup.

## What stays in doubt, and why
- A transfer that is sent and then crashes before the ledger completes: the row is `started`. Without a lookup the
  order is held in doubt. With one, the lookup decides.
- An unknown error from `transferUSDC`: the same as above, with the row `failed`.
- An adapter without a lookup, whatever it returned: the order is held until someone checks the chain or the ledger.

## Consequences
- The existing `settle` and `confirmSettlement` state machine is unchanged, except for the new hold
  `SETTLEMENT_OUTCOME_UNKNOWN`, which is part of `ReconcileHold`.
- The `reconcile-once` test fixture (`CountingSettlementAdapter`) now answers "did you make this transfer". That is what
  lets a retry after an unknown error send again safely. Its assertions are unchanged.
- `SettlementAdapter.findTransfer` is optional. The Arc adapter and the simulator implement it. Nothing else does.
