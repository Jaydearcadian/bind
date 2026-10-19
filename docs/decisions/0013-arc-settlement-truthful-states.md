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
- The BindSettlement ABI is a generated module, `src/adapters/settlement/bind-settlement.abi.ts`, written by
  `tools/compile-contract/generate.mjs` alongside `contracts/artifacts/BindSettlement.json`. It carries the same
  `sourceSha256`, and a unit test checks that it equals the artifact. No runtime file read happens, so serverless
  builds that ship only `dist/` work.
- Every viem call that can fail for a non-settlement reason (chain id check, pre-flight call without revert data,
  settleOrder send, settlement lookup, receipt decode) is wrapped in `SettlementTransportError`. Its message is
  `RPC request failed during <operation>: <reason>`, the reason is the viem short message with URLs replaced by
  `[redacted-url]` and the RPC URL and signer key replaced by `[redacted]`. It has no `cause`, so the raw RPC error,
  and any token in the RPC URL, is not carried with it. A revert with data is always decoded first.
- The adapter keeps its RPC URL, chain, transport, signer key, signer and wallet client in ES private fields, so
  `JSON.stringify` and `util.inspect` of the adapter show none of them.
- Settlement recovery (`OrderAlreadySettled`) scans from `BIND_SETTLEMENT_DEPLOY_BLOCK` (default 0) rather than
  always from block 0.
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
