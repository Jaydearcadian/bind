# ADR 0013: Arc settlement reports only what the chain returned

## Status
Accepted (2026-10-19)

## Context
The Arc adapter returned `status: "settled"`, a made-up hash (`0xarc_<timestamp>_<orderId>`) and an explorer link,
and never sent a transaction. The local simulator also reported `settled`. Nothing read the status.

## Decision
- `SettlementStatus` is `submitted | confirmed | failed`. `submitted` means a transaction was broadcast or a prior
  settlement for the order was found on chain. It does not mean paid. `confirmed` needs a receipt with status success
  and a `SettlementExecuted` log from the configured contract.
- `transferUSDC` checks, in order: configuration (`SettlementNotConfiguredError`, naming variables only), chain id once
  (`SettlementChainMismatchError`), payer equals signer (`SettlementPayerMismatchError`), request shape
  (`SettlementRejectedError("INVALID_REQUEST")`), then a pre-flight `eth_call`. A custom revert is decoded and thrown as
  `SettlementRejectedError(name, args)` before anything is sent. `OrderAlreadySettled` returns the earlier settlement's
  hash, found by `getLogs` on the indexed order id, as `submitted`. Revert data that cannot be decoded is
  `SettlementRejectedError("UNKNOWN_REVERT")`. Errors with no revert data are rethrown unchanged.
- `confirm` waits at most `confirmWaitMs`. Any RPC failure, or no receipt in time, returns `submitted`. Unknown outcomes
  are never reported as confirmed. A reverted receipt is `failed` with `REVERTED`, and a success without the event is
  `failed` with `EVENT_MISSING`.
- The BindSettlement ABI is read from `contracts/artifacts/BindSettlement.json` in the constructor, not imported
  statically. A missing artifact then fails only when the Arc adapter is built, not when the settlement module is
  imported, so local mode keeps working.
- Arc `depositEscrow` and `releaseEscrow` throw `SettlementNotSupportedError`. The local simulator keeps them with the
  same status model and `simulated: true`.
- The local simulator returns `submitted` with `simulated: true`, and `confirmed` for any well-formed hash. It has no
  explorer link and holds no state across restarts.
- Explorer links are built only for chain id 5042002.

## Consequences
- `OrderSettlementService` still treats `submitted` as paid, as it did `settled`. Task 3c must branch on status.
- `settlement.ts` does not pass `matchHash`, which the Arc adapter requires. So `arc-testnet` settlement now fails with
  `INVALID_REQUEST` until Task 3c supplies it. This is intended: the old path reported a payment without sending any
  transaction.
- Verification is against the in-process EVM, which is `LOCAL_PASS` and not Anvil.
