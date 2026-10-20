# ADR 0038: Contract gates, CI layout, and what has not run

## Status
Accepted (2026-10-20), by Task 13 of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`. It describes an
environment with no Foundry, no Anvil, no Slither, no GitHub runner and no live Arc access. Every gate that depends on
those is recorded here as `BLOCKED` or `NOT_RUN`, not as a pass.

## Context
- `BindSettlement.sol` is in scope (`docs/CONTRACT_SCOPE.md`, `Decision: IN_SCOPE`). `AGENTS.md` requires Forge unit,
  fuzz and invariant tests, a real Anvil deployment, static analysis and coverage for in-scope Solidity.
- Before this change, `scripts/verify-local.sh` ran `forge` steps only when `forge` was present and printed one
  generic `BLOCKED` line otherwise. Its contract section also allowed `ALLOW_NO_CONTRACTS=1` to skip contracts, and the
  CI workflow set that variable. Slither and Anvil had no step. The in-process contract suite was not a visible gate, and
  the spec, SDK and map drift checks were not in the runner.
- `which forge anvil cast slither` returns nothing in the authoring environment, and there is no network access.
- The CI workflow had never run on GitHub and still does not have a recorded run.

## Decision

### 1. The local runner (`scripts/verify-local.sh`)
- `--list` prints one `label<TAB>command` line per gate and executes nothing. `--accepted` prints what
  `BIND_ACCEPT_NOT_RUN` accepts and executes nothing. `tests/unit/verify-local-script.test.ts` tests both, and checks that
  each listed gate is in the CI job that owns it.
- Steps: `clean dependency install` (only when `node_modules` is absent), `lint`, `typecheck`, `unit`, `integration`,
  `contract in-process suite` (the four files named in the plan, run as their own section even though `integration`
  includes them), `build`, `sdk:build`, `mcp:build`, `audit`, `spec drift`, `sdk drift`, `map drift`, `forge fmt --check`,
  `forge build`, `forge test -vvv`, `forge coverage`, `anvil integration`, `slither (unverified invocation)`, `test:e2e`.
- Drift checks run the generator and then `git diff --exit-code` on the generated file. Regenerating is the only write the
  script makes. On drift the regenerated file stays in the working tree so the diff can be read. The script does not
  restore it.
- Missing tools print `BLOCKED: <tool> not installed (skipped: ...)` once per tool, and that counts as a failure. There is
  no escape hatch for `forge`, `anvil` or `slither`.
- Slither runs `slither .` in `contracts/`. That invocation is UNVERIFIED: it was not checked against a Slither release in
  this environment, and no Slither documentation is available offline.
- The `anvil integration` step uses `ANVIL_RPC_URL` if it is set. Otherwise it starts `anvil --chain-id 31337` on port
  18545 (`ANVIL_PORT` overrides it), waits until `eth_chainId` returns `0x7a69`, runs the suite and stops the node.

### 2. The accepted NOT_RUN mechanism (a narrow, named exception)
- `test:e2e` is the only gate that may be accepted as not run. The reason is ADR 0016: the UI under `src/ui` is orphaned and
  its browser tests cannot pass.
- Without acceptance the script prints `BLOCKED: test:e2e (...)` and counts a failure. With
  `BIND_ACCEPT_NOT_RUN=test:e2e` it prints `NOT_RUN (accepted by BIND_ACCEPT_NOT_RUN): test:e2e (UI orphaned, ADR 0016)`.
  It is counted as `NOT_RUN_ACCEPTED`, which is neither a pass nor a failure.
- The script does not run `npm run test:e2e`. That npm script still prints its BLOCKED message and exits 1.
- Any other name in `BIND_ACCEPT_NOT_RUN` is ignored with a `WARN` on stderr, and that gate still runs and can fail.
- The summary line is `PASS=.. FAIL_OR_BLOCKED=.. NOT_RUN_ACCEPTED=..`.
- Removal: when the rebuilt UI has a browser suite, remove `test:e2e` from `BIND_ACCEPT_NOT_RUN` in
  `.github/workflows/quality-gates.yml`, make the script run that suite, and delete this exception.

### 3. The Anvil suite (`tests/integration/anvil-settlement.test.ts`)
- `describe.skipIf(!ANVIL_RPC_URL)` with the name `[anvil]`. Without `ANVIL_RPC_URL` it prints
  `SKIPPED [anvil]: ANVIL_RPC_URL is not set ... (NOT_RUN)` and the tests are reported as skipped.
- It deploys the committed artifact through `deployBindSettlementOn` (a new helper; `deployBindSettlement` keeps its
  signature and behaviour for the in-process suites). It checks that the deployed runtime code is the tail of the artifact's
  creation bytecode, which holds because the contract has no constructor arguments or immutables.
- It covers the scenarios in `arc-settlement-evm.test.ts` on a real node: success with the event, `OrderAlreadySettled`,
  `DailyLimitExceeded`, `VendorNotWhitelisted` with and without whitelisting, the adapter's submit, confirm and findTransfer,
  recovery of an earlier settlement, the adapter's limit refusal, and a chain id mismatch.
- Signer key: the key given in the task brief (`...2ac5de71`) derives to `0xB06C040b616Ee3254bbbf2FFCfaeD70bD296Cc05`,
  which is not a standard Anvil account, so Anvil would not fund it. The suite therefore defaults to Anvil account 1
  (`0x59c6995e...78690d`, which derives to `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`). `ANVIL_OWNER_KEY` overrides it.
  The suite fails loudly if the signer has no balance on the node.

### 4. CI layout (`.github/workflows/quality-gates.yml`)
- `permissions: contents: read`. `BIND_ACCEPT_NOT_RUN: test:e2e` at workflow level. `ALLOW_NO_CONTRACTS` is removed.
- `quality`: Postgres service, Node 24, `npm ci` with the npm cache, then lint, typecheck, unit, integration, build,
  sdk:build, mcp:build, audit, and the three drift checks as named steps.
- `contracts`: Foundry, then forge fmt, build, test and coverage in `contracts/`, then Slither through
  `crytic/slither-action@v0.4.0` with `target: contracts/`, then the in-process suite, then Anvil on 8545 and the Anvil suite.
- `verify-local` (needs both jobs): the same aggregate script developers run, with Foundry and Slither installed. It runs the
  script's own Anvil. This job is the only one that exercises the acceptance rule. It duplicates the work of the other two
  jobs on purpose, so that CI has one authoritative summary line.
- Actions stay on the major versions already in use (`actions/checkout@v4`, `actions/setup-node@v4`,
  `foundry-rs/foundry-toolchain@v1`). Two versions are UNVERIFIED: the `crytic/slither-action@v0.4.0` tag and its default
  `fail-on` threshold, and the unpinned `pipx install slither-analyzer` in `verify-local`. Both must be pinned from the first
  real run.
- The workflow has never been executed on GitHub. Every CI job is `NOT_RUN` until a run is recorded.

### 5. Drift checks and how to fix them
- Spec: `npm run api:spec` rewrites `docs/openapi.json` from `src/api/registry.ts`. Fix: commit the regenerated file if
  the route change was intended. Otherwise restore the source.
- SDK types: `npm run sdk:generate` rewrites `sdk/src/generated`. The same rule applies to `docs/openapi.json`.
- Map: `npm run map:functions` rewrites `docs/CODEBASE_MAP.md`. It counts test functions too, so adding or changing a
  test file changes the map. Regenerate and commit it with the test change.
- To inspect a failure, run `git diff -- <file>` after the failing step. Revert with `git checkout -- <file>` only after
  deciding the source is correct.
- Caveat: `git diff --exit-code <file>` compares the regenerated file with the git index, not with `HEAD`. So a
  regenerated file that is not staged fails locally, even when the change is intended. The first local run in this
  task failed `map drift` for that reason, and the fix was to stage the regenerated map before the run. A regenerated file
  that is staged but not committed passes locally. CI runs on a clean checkout of the commit and does not have this gap.
  The check keeps the literal form given in the plan rather than `git diff --exit-code HEAD -- <file>`.

## What ran here

Result of `BIND_ACCEPT_NOT_RUN=test:e2e bash scripts/verify-local.sh`, run on the working tree that this commit
records (the regenerated `docs/CODEBASE_MAP.md` was staged, which is the content committed). The exit code was 1, and
that is the intended result, because three tools are BLOCKED. Per-step lines copied from the run log:

```
INFO: node_modules already exists; the dependency tree is not proven clean by this run.
PASS: lint
PASS: typecheck
PASS: unit                                   (Test Files 45 passed (45); Tests 324 passed (324))
PASS: integration                            (Test Files 49 passed | 1 skipped (50); Tests 497 passed | 10 skipped (507))
SKIPPED [anvil]: ANVIL_RPC_URL is not set, so the Anvil settlement suite did not run (NOT_RUN). ...
PASS: contract in-process suite              (Test Files 4 passed (4); Tests 32 passed (32))
PASS: build
PASS: sdk:build
PASS: mcp:build
PASS: audit
PASS: spec drift
PASS: sdk drift
PASS: map drift                              (functions=1396 prod=750 calls=2549 routes=67 unwiredExported=92)
BLOCKED: forge not installed (skipped: forge fmt --check, forge build, forge test -vvv, forge coverage)
BLOCKED: anvil not installed (skipped: anvil integration)
BLOCKED: slither not installed (skipped: slither (unverified invocation))
NOT_RUN (accepted by BIND_ACCEPT_NOT_RUN): test:e2e (UI orphaned, ADR 0016)
PASS=12 FAIL_OR_BLOCKED=3 NOT_RUN_ACCEPTED=1
NOT_RUN_ACCEPTED: test:e2e (named in BIND_ACCEPT_NOT_RUN; not run; not counted as a failure)
```

The first run of the same script, before the regenerated map was staged, failed `map drift` for the index reason in
section 5 and reported `PASS=11 FAIL_OR_BLOCKED=4 NOT_RUN_ACCEPTED=1`. Nothing else changed between the two runs.

Other local runs that informed this ADR:
- `npx vitest run tests/unit/contract-artifact.test.ts tests/integration/local-chain.test.ts tests/integration/arc-settlement-evm.test.ts tests/integration/arc-find-transfer.test.ts`: 4 files, 32 tests passed (before and after the helper change). This is `LOCAL_PASS (in-process EVM, not Anvil)`.
- `npx vitest run tests/integration/anvil-settlement.test.ts` without `ANVIL_RPC_URL`: 10 tests skipped, with the skip reason printed.
- `npx vitest run tests/unit/verify-local-script.test.ts`: 12 tests passed. The workflow tests use python3 with PyYAML 6.0.1.
- `npm run lint`, `npm run typecheck`: pass.
- `npm run api:spec`, `npm run sdk:generate`, `npm run map:functions`: each reproduces the committed files, except
  `docs/CODEBASE_MAP.md`, which changed because the test files changed. That change is committed with this ADR.
- Selectors recomputed with viem: `DailyLimitExceeded(uint256,uint256)` = `0xef664d6a`, `VendorNotWhitelisted(address)` = `0x65e822e9`.

## What is BLOCKED or NOT_RUN, and why

| Gate | Here | Why | Evidence class |
| --- | --- | --- | --- |
| `forge fmt --check`, `forge build`, `forge test -vvv`, `forge coverage` | BLOCKED (forge not installed) | No Foundry and no network | NOT_RUN |
| `anvil integration` (`tests/integration/anvil-settlement.test.ts`) | BLOCKED (anvil not installed); the suite is also skipped without `ANVIL_RPC_URL` | No Anvil and no network | NOT_RUN |
| `slither (unverified invocation)` | BLOCKED (slither not installed) | No Slither and no network | NOT_RUN |
| `test:e2e` | NOT_RUN_ACCEPTED through `BIND_ACCEPT_NOT_RUN` | UI orphaned (ADR 0016) | NOT_RUN (accepted) |
| Every CI job | NOT_RUN | Never executed on GitHub | NOT_RUN |
| Live Arc reads (`scripts/verify-live-arc.ts`) | NOT_RUN | No network, no token, no `cast` | NOT_RUN |

Forge, Anvil and Slither are required gates. None of them is satisfied by the in-process EVM, which is a client and ABI
boundary check and is not a deployment on a real node.

## What is not done
- Slither has never run. Its invocation is unverified, and so is the CI action tag and its fail threshold.
- Forge has never run. The existing test file has no invariant tests and no reentrancy test, and there is no Foundry
  deployment script or gas snapshot (`docs/CONTRACT_SCOPE.md`, section 4). These are gaps against the gate document,
  recorded and not filled.
- The Anvil suite has never run. Its scenarios are written against the in-process suites and against the adapter's real
  code path, and they have not been checked against a live node.
- `scripts/verify-live-arc.ts` treats a non-revert `cast` failure in gates 4 and 5 as a revert pass
  (`docs/CONTRACT_SCOPE.md`, section 5). It was not changed in this task. Its output should not be cited until that is fixed.
- CI has never run. `docs/RELEASE_EVIDENCE.md` is not refreshed here; that is Task 14.
- No gas snapshot exists.

## Consequences
- In this environment the runner exits 1 because three tools are BLOCKED. That is the intended result: the gates are
  visible and are not passed.
- The aggregate CI job repeats the other jobs. It costs CI time in exchange for a single authoritative summary line.
- Any change to `contracts/src/BindSettlement.sol` requires `npm run contract:artifact` and a commit. The artifact test
  fails on a stale hash.

## Update 2026-10-20: the gates were run locally
Foundry 1.5.1, Anvil 1.5.1 and Slither 0.11.6 (with solc 0.8.28) were downloaded and installed in the working container, because the
owner could not fix the GitHub runner. `bash scripts/verify-local.sh` then reported `PASS=18 FAIL_OR_BLOCKED=0 NOT_RUN_ACCEPTED=1`
at commit `f776d34`. The BLOCKED lines above describe the earlier environment and are kept as written. Slither's gate was changed:
`slither .` analysed 0 contracts and exited 0 (a false pass), so the gate is now `slither . --fail-medium` with
`contracts/slither.config.json`, and it was shown to exit 255 on an injected arbitrary-send function. The gate label no longer says
"unverified invocation". CI still has not executed; the one dispatch got no runner. Details: `docs/RELEASE_EVIDENCE.md` section 3.
