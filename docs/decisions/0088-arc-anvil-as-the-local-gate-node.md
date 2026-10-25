# ADR 0088: arc-anvil is the local node for the Anvil gate

## Status
Accepted (2026-10-25), by the owner's instruction of the same date. It changes which local node `scripts/verify-local.sh`
prefers and adds Arc-specific tests. It does not change CI (see "Not done").

## Context
- Plain Anvil is a standard EVM. Its base fee starts at 1 gwei, and it has none of Arc's protocol rules. The Anvil suite
  (`tests/integration/anvil-settlement.test.ts`) passed on plain Anvil (ADR 0038). That result does not show how the contract
  or the adapter behaves on Arc.
- The Arc documentation points to `arc-anvil`, the Arc-aware build of Anvil from circlefin/arc-foundry.
- How it was obtained here: the release archives and api.github.com downloads were blocked by the sandbox proxy (403). The public
  `circlefin/arc-foundry` repository was cloned through the session's git proxy and built from source, pinned to v0.8.0-2 and
  commit `d497bee`, with the toolchain pinned by its `rust-toolchain.toml` (1.95.0):
  `cargo build --release -p anvil --jobs 3`, which took 26 minutes. The binary is 54 MB. It is installed at
  `/root/.local/bin/arc-anvil`, reports `anvil 1.7.1-dev`, and runs as `arc-anvil --network arc --chain-id 31337`.
- This build is a local artifact of this environment. Nothing in it was downloaded as a release or verified against a published checksum.

## Decision

### 1. The gate prefers arc-anvil
- `scripts/verify-local.sh` picks the node binary in this order: `ANVIL_BIN` when set, then `arc-anvil` on PATH, then `anvil`.
  `ANVIL_RPC_URL` set by the caller still takes precedence over starting a node.
- With `arc-anvil` the script starts `arc-anvil --network arc --chain-id 31337 --host 127.0.0.1 --port <port>` and exports
  `ANVIL_EXPECT_ARC=1`. The Arc block must then run, and it fails on a node that is not in Arc mode.
- With plain `anvil` the script starts `anvil --chain-id 31337 ...`, prints a CAVEAT that a plain-anvil run does NOT reproduce Arc
  behaviour, and the Arc block is reported NOT RUN. The CAVEAT is a recorded caveat, not a failure.
- The gate name (`anvil integration`) and its command text (`npx vitest run tests/integration/anvil-settlement.test.ts`) did not
  change, so `tests/unit/verify-local-script.test.ts` and the workflow parity checks still hold.

### 2. The Anvil suite has an Arc block
- The 10 existing `[anvil]` tests are unchanged.
- A new block, `[arc-anvil] Arc protocol differences`, runs only when the node reports a latest base fee of at least 20 gwei, or
  when `ANVIL_EXPECT_ARC=1` is set. Otherwise it is reported as `NOT RUN [arc-anvil]: ...` on stdout and its tests are skipped.
  A skip is never a pass.
- Its tests: (a) base fee at least 20 gwei; (b) a transaction with `maxFeePerGas` 1 gwei is rejected with
  `max fee per gas less than block base fee`; (c) a native value send to the zero address reverts with `Zero address not allowed`
  and moves no value; (d) a native value send emits exactly one Transfer log from the system emitter
  `0xfffffffffffffffffffffffffffffffffffffffe`, with the right `from`, `to` and an 18-decimal `value`; (e) a settlement through the
  real `ArcL1SettlementAdapter` produces system-emitter logs beside exactly one `SettlementExecuted` from the contract, and
  `confirm` and `findTransfer` report it; (f) a settlement to the zero-address supplier is refused by the adapter as
  `SettlementRejectedError` with code `Unauthorized`, with no chain effect (nonce, balances and settlement logs unchanged).
- (f) needed no change to `src/`. The contract's `settleOrder` reverts `Unauthorized()` for a zero supplier, and the adapter's
  pre-flight call turns that into the refusal.

### 3. Verified differences (local node, observed here)

| Probe | arc-anvil `--network arc` | `--network ethereum` (standard EVM) |
|---|---|---|
| Latest base fee | 20 gwei | 1 gwei |
| Transaction with `maxFeePerGas` 1 gwei | rejected by the RPC: `max fee per gas less than block base fee` | accepted |
| Native value send of 1 wei to the zero address | reverts: `Zero address not allowed` | succeeds |
| Native value send | exactly one log: Transfer from the system emitter `0xff..fe` | no log |
| Blocklist address `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` (Anvil account 1) | not enforced: it sends 1 wei and receives 1 wei, both succeed | not probed |

- The blocklist row answers the docs' claim for local arc-anvil mode. The docs say this address is blocklisted on testnet. The local
  node does not enforce that, so no test relies on it. If the local node's genesis differs from testnet, the testnet claim is still
  unverified here.

### 4. Results on arc-anvil
- `ANVIL_RPC_URL=http://127.0.0.1:<port> npx vitest run tests/integration/anvil-settlement.test.ts` on arc-anvil: 16 of 16 passed
  (the 10 existing tests and the 6 new ones).
- The bite proof, the same suite against `arc-anvil --network ethereum`:
  - Without `ANVIL_EXPECT_ARC`: the 6 Arc tests are reported NOT RUN, and the 10 existing tests pass.
  - With `ANVIL_EXPECT_ARC=1`: 5 of the 6 Arc tests fail (a, b, c, d, e) with the expected reasons (base fee 7.5 mwei; the 1 gwei
    transaction is accepted; the zero-address send does not revert; no system-emitter log). Test (f) still passes on the plain node,
    because the refusal comes from the contract's own revert, not from Arc.

### 5. What is NOT done
- CI does not use arc-anvil. `.github/workflows/quality-gates.yml` still starts plain Anvil from the Foundry toolchain. Switching it
  needs the Arc Foundry release archive, which could not be downloaded here, so it cannot be tested here. It is a follow-up. Until then
  the CI Anvil job runs without the Arc block, and that job's Anvil result is not Arc evidence.
- Forge and arc-forge were not built here. The Forge gates (`forge fmt --check`, `forge build`, `forge test -vvv`, `forge coverage`)
  stay NOT_RUN here.
- The blocklist result above is only for local arc-anvil mode.
- Local Arc mode is not proof of live Arc behaviour. The fee rules, the system-emitter logs and the revert text were observed on a
  local node built from source. A live run on Arc testnet is still required before any claim about Arc.

## Consequences
- The local gate exercises Arc's fee rules and native-value logs when `arc-anvil` is installed, and it reports the Arc tests as NOT RUN
  when only plain Anvil is available.
- The adapter's `confirm` and `findTransfer` are checked against system-emitter logs beside the contract's log. This is the first local
  check of that behaviour.
- To undo: remove `arc-anvil` from PATH (or set `ANVIL_BIN`) and the gate falls back to plain Anvil. Delete the Arc block to remove the tests.
