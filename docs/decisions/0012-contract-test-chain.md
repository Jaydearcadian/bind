# ADR 0012: Contract artifact and in-process test chain

## Status
Accepted (2026-10-19)

## Context
The settlement client must be tested against the real compiled `BindSettlement` bytecode. Foundry, Anvil and
Slither cannot be installed in this container (no network access), so they remain BLOCKED here. The root
`npm audit --audit-level=high` gate reports 0 findings and must stay that way. Measured with lock-only audits on
2026-10-19:
- ganache 7.9.2 adds 36 advisories (22 high, 5 critical) at package level.
- tevm (1.0.0-next.149) adds 9 high.
- Every solc release checked (0.8.20 to 0.8.37) depends on a flagged `tmp`. 0.8.37 uses tmp 0.2.6 (GHSA-7c78-jf6q-g5cm).
  0.8.36 uses tmp 0.0.33 (GHSA-52f5-9888-hmc6, GHSA-ph9p-34f9-6g65).

## Decision
- The root tree gains only the five EthereumJS packages (`@ethereumjs/vm`, `tx`, `common`, `block`, `util`), each an
  exact `10.1.3` devDependency. They back `tests/helpers/local-chain.ts`, an in-process EVM exposed as an EIP-1193
  request function for viem.
- `solc` 0.8.37 lives only in `tools/compile-contract/` with its own lock file. `npm run contract:artifact` compiles
  `contracts/src/BindSettlement.sol` (evmVersion cancun, optimizer off) into `contracts/artifacts/BindSettlement.json`.
  That file is committed and carries `sourceSha256`. Regeneration is byte-identical.
- The artifact must be regenerated with `npm run contract:artifact` whenever the Solidity changes.
  `tests/unit/contract-artifact.test.ts` fails on a stale hash.
- Client tests against this chain are `LOCAL_PASS (in-process EVM, not Anvil)`. Forge, Anvil and Slither remain BLOCKED.

## Consequences
- The root gate stays at 0 findings. The compile tool's tree carries the two `tmp` high advisories. It does not ship
  with the app. `npm audit fix --force` would only move solc to 0.8.36, which has the same problem, so it is not applied.
- The in-process EVM is not Anvil. It checks client, ABI, event and custom-error behaviour. It is not evidence of
  deployment or live-chain behaviour.
- The EthereumJS packages are pinned exact. Upgrading them is a deliberate change that reruns the chain tests.
- When Forge and Anvil become available, the Anvil deployment and Forge tests are still required and are not replaced.
