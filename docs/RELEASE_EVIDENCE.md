# Bind release evidence

Rebuilt on 2026-10-20 (Task 14) from the command runs listed below. It replaces the earlier version. The claims in that version
that this task did not reproduce are kept, labelled, in the appendix at the end, and are not to be relied on.

**Commit the gates ran on:** `407533ac09f7121806836e25db4834be5c91c412` (HEAD of `claude/capabilities-overview-c6elxr` before the
commit that adds this document; the working tree was clean at that commit).

## 0c. Embedded wallet for Google sign-in (ADR 0073): gate run and deployment

**Commit the gates ran on and the commit deployed:** `28f13c4df9ab72e6f48f14bd1d1d4bff66cc7580`. Command: `bash scripts/verify-local.sh`. Result: `PASS=19 FAIL_OR_BLOCKED=0 NOT_RUN_ACCEPTED=0` (unit 57 files and 606 tests, integration 638 passed and 10 skipped, contract 32, browser E2E including `wallet.spec.ts`, `account-signin.spec.ts` and `privy-bundle.spec.ts`).

| Check | Outcome | Class |
| --- | --- | --- |
| Wallet created once at a first Google sign-in, reused after, never blocks sign-in, retry in Settings, none for a wallet login or a quiet re-entry, none with an access key | stand-in Privy adapter against the real server | `LOCAL_PASS` |
| Adapter safety (88 unit tests): one creation under concurrency, external wallet never mistaken for the embedded one, frame only on the exact `auth.privy.io` host, messages accepted only from that frame's origin and window, the poster never uses `*`, no signing or sending method exists | fakes | `LOCAL_PASS` |
| Production `https://bind-gilt.vercel.app` | serves the new bundle (989,874 bytes); `/api/public-config` returns the app id; CSP `connect-src 'self' https://auth.privy.io` and `frame-src https://auth.privy.io`; `/health` database connected | `VERIFIED_REMOTE` |
| Privy app settings (public endpoint) | embedded wallet mode `user-controlled-server-wallets-only`, no password required, create-on-login off, no custom API host | `LIVE_READ_PASS` |
| Creating a real wallet through Privy for a Google sign-in | a person must sign in with Google on the deployed site and open Settings | `NOT_RUN` |
| The wallet frame's sandbox flags and the live frame handshake | unused in this Privy mode, never exercised live | `NOT_RUN` |

**Known risks:** under this Privy mode the new wallet's shape in the user record is read from the SDK's refreshed user; if Privy lists it differently the page reports "wallet not found" rather than creating a second one. The real custody and recovery behaviour of this mode is Privy's and is not verified here. `scripts/` is outside the ESLint scope.

## 0b. Sign-in with Google or a wallet (ADR 0070 to 0072) and the production deployment: gate run

**Commit the gates ran on and the commit deployed:** `5e6f5d5a1747dd66bff017799815dbef8ffec09e`. Command: `bash scripts/verify-local.sh`. Result: `PASS=19 FAIL_OR_BLOCKED=0 NOT_RUN_ACCEPTED=0`.

| Gate | Outcome | Class |
| --- | --- | --- |
| Unit | 57 files, 567 passed | `LOCAL_PASS` |
| Integration | 638 passed, 10 skipped (the skips recorded in ADR 0057) | `LOCAL_PASS` |
| Contract | 4 files, 32 passed | `LOCAL_PASS` |
| Anvil settlement (real node, 10 tests) | passed after the test waited for the node to mine (see below) | `LOCAL_PASS` |
| Browser E2E, desktop and phone | passed, including `account-signin.spec.ts` (7 scenarios) and `privy-bundle.spec.ts` | `LOCAL_PASS` |
| Production deployment `https://bind-gilt.vercel.app` | READY; `/health` reports the database connected; `/api/public-config` returns the Privy app id with `no-store`; the CSP `connect-src` is `'self' https://auth.privy.io`; `/app/vendor/privy.js` is served (986,517 bytes) | `VERIFIED_REMOTE` |
| Privy app settings (read from Privy's public endpoint) | Google and wallet login on; allowed domain is `https://bind-gilt.vercel.app`; Privy's verification key is one of the two public keys set in Vercel | `LIVE_READ_PASS` |
| Live Google and wallet login through Privy, in a browser on the deployed site | a person must complete it | `NOT_RUN` |
| Whether Privy's SDK reaches a bare `Buffer` after a real login (embedded-wallet paths) | not traced in a live session | `NOT_RUN` |

**Test fixes made while getting here (no assertion weakened):** `anvil-settlement.test.ts` read the receipt, and the settlement logs, the instant a transaction was submitted, which sometimes beat the node. The tests now wait for the transaction to be mined (a bounded `waitForTransactionReceipt`); every assertion is unchanged and `adapter.confirm` still confirms only once a receipt exists. Run against one long-lived Anvil node, the suite runs out of gas money after about ten runs (the signer's balance is never topped up); the release gate starts a fresh node per run.

**Dependencies added for the browser SDK:** `@privy-io/js-sdk-core` 0.78.0 (newest release at least 14 days old when pinned) and `esbuild` 0.28.2, both exact. `ox` is overridden to 0.14.56 and `viem` held at exactly 2.57.6 (the version already in use); the SDK declares an exact peer `viem@2.56.5`, which is recorded in ADR 0071.

**Known risks:** the Privy bundle is about 964 KiB and is loaded only on the sign-in and invite pages. The app secret was shared in chat and is not used by Bind; it should be rotated in the Privy dashboard. The three server secrets (`BIND_CREDENTIAL_KEY`, `BIND_MASTER_SECRET`, `BIND_WEBHOOK_SECRET`) are set in Vercel for production only, as Sensitive; their values were shown to the owner once and no other copy is kept. Preview deployments use the same database as production (every database variable is set for all three environments).

## 0a. App screens (ADR 0064 to 0069) and demo follow-ups: gate run

**Commit the gates ran on:** `b74db744875fc2c7067535e97075384b694dc48e` (People and access, Connections, Business data, Settings, Help, Getting started, the QR encoder, and
the merged demo follow-ups). Command: `bash scripts/verify-local.sh`. Result: `PASS=19 FAIL_OR_BLOCKED=0 NOT_RUN_ACCEPTED=0`.

| Gate | Outcome | Class |
| --- | --- | --- |
| Unit (`npm run test:unit`) | 56 files, 508 passed | `LOCAL_PASS` |
| Integration | 69 files passed, 1 skipped; 627 passed, 10 skipped (the skips recorded in ADR 0057) | `LOCAL_PASS` |
| Contract | 4 files, 32 passed | `LOCAL_PASS` |
| Browser E2E (`npm run test:e2e`, desktop and phone) | 106 passed, 4 skipped (desktop- or phone-only tests) | `LOCAL_PASS` |
| Privy sign-in, invite acceptance in the browser, workspace switcher | needs the owner's Privy credentials | `NOT_RUN` |
| QR scan with a phone camera | decoded with jsQR only | `NOT_RUN` |
| Vercel deployment of the website | not deployed | `NOT_RUN` |

**Known flake (not changed):** the existing SSE test "reconnecting with the last event id ..." in `tests/integration/events.test.ts`
can read a setup event first; it failed once in 20 runs on a private database. Fixing it means changing the test's setup or the
stream's start point, so it is recorded here rather than altered. The integration suites share one local database with any other
running server; a purge deadlock under that sharing caused two failures in 20 runs, none on a private database.

## 0. Demo workspaces (ADR 0057): gate run after the review fixes

**Code commit:** `043b361b0648754fd8323736ac1e85286639f3c2` (review fixes). **Commit the gates ran on:** `b143a5f60f9da3419e34bba9bc07046138230489`,
which is `043b361` plus one regenerated file, `docs/CODEBASE_MAP.md` (line ranges of two functions moved; the map drift gate failed on
the first run and passed on this one). The worktree was clean at that commit.

| Gate | Class | Result |
| --- | --- | --- |
| lint | LOCAL_PASS | `npm run lint`, no problems |
| typecheck | LOCAL_PASS | the app, the SDK and the MCP server |
| unit | LOCAL_PASS | 55 files, 432 tests passed |
| integration | LOCAL_PASS | 68 files passed and 1 skipped; 620 tests passed and 10 skipped |
| contract in-process suite | LOCAL_PASS | 4 files, 32 tests passed |
| build, sdk:build, mcp:build | LOCAL_PASS | |
| audit | LOCAL_PASS | `npm audit --audit-level=high` |
| spec, SDK and map drift | LOCAL_PASS | regenerated files equal the committed ones |
| forge fmt, build, test, coverage | LOCAL_PASS | |
| anvil integration | LOCAL_PASS | 10 tests, against a local Anvil on chain 31337 |
| slither `--fail-medium` | LOCAL_PASS | |
| test:e2e (browser suite) | LOCAL_PASS | 52 passed, 4 skipped by design; port set with `BIND_WEB_TEST_PORT=3311` |
| live Arc, live suppliers, live connectors | NOT_RUN | no credentials or endpoints were used; the demo never reaches them by design |

Summary line from the run: `PASS=19 FAIL_OR_BLOCKED=0 NOT_RUN_ACCEPTED=0`. The database was private to this worktree
(`bind_wt_a1f6` on the local server), because other worktrees' suites share that server. The first run on `043b361` had 18 passes and
the map drift failure described above; no test or gate was changed for it.

Command: `DATABASE_URL=<private database> BIND_WEB_TEST_PORT=3311 bash scripts/verify-local.sh`.

What the run covers for the demo: real PostgreSQL and real HTTP in `tests/integration/demo.test.ts` (22 tests: creation with an owner
token and a four-hour expiry, a seed from a real replenishment, simulated-only settlement and suppliers under a live-asking environment,
no outside call from a demo even with the TypeSafe, Parallel and Tavily keys set, expiry of token, account session, event stream and
surface webhook, a bounded purge on create, reset and its refusal, the per-address limit and `Retry-After` with and without a trusted
proxy, the global cap including three concurrent creates, `DEMO_BUSY` after the 3-second lock wait, the disabled switch, cross-tenant
refusals, and a failed seed that is logged and leaves no record).

**Known risks, for this run:**

- One worker test, "a tick is bounded by batch size", found 10 expired approvals where 3 were expected, in one full integration run
  on an earlier commit of this database. The later full runs passed. No cause was found in the test code. It is a pre-existing test and
  it is recorded here rather than hidden.
- The demo has not been exercised in a browser; the demo banner, the Reset button and the entry page are not built.
- A demo never reaches a live supplier or a live settlement by code, but no live system was ever tested against this path.


## Header

| Item | Value |
| --- | --- |
| Date (UTC) | 2026-10-20. Gate batch 10:17:57 to 10:30:05. Smoke run 10:30:49 to 10:30:50. |
| Branch | `claude/capabilities-overview-c6elxr` |
| Container | Linux 6.18.44-fc-v139, x86_64 |
| Node | v22.22.0 (npm 10.9.4). CI pins Node 24 (`.github/workflows/quality-gates.yml`) and this run did not use it. |
| PostgreSQL | 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) on 127.0.0.1:5432, database `bind_local`. CI pins PostgreSQL 17. |
| Not available here | model keys (`NEBIUS_API_KEY`); search keys (`PARALLEL_API_KEY`, `TAVILY_API_KEY`); live supplier, messaging, accounting and payment connectors; an Arc RPC token; a working GitHub Actions runner. |
| Outbound network | Only the npm registry, through the configured proxy, was reached (by `npm audit`). No live supplier, chain, messaging or hosting endpoint was contacted by any step. |
| Clean-checkout condition | `.env.local` was moved aside for the whole gate batch and for the smoke run, and restored afterwards (the file is untracked and gitignored). |

## 1. Summary

- **Passes locally, on `407533a`:** lint, typecheck, the unit suite (340 tests), the integration suite (535 tests, run twice with
  the same result), the production, SDK and MCP builds, the API, SDK and map drift checks, the in-process contract suite (32 tests),
  and a smoke run of the built server. The dependency audit reports no high-severity findings.
- **What those passes cover:** a local PostgreSQL database; a simulated supplier; owner notices that are recorded but not delivered;
  a settlement simulator in memory; and the settlement contract run in an in-process EVM. None of these is a live check.
- **Not verified:** any live Arc read or transaction; the contract deployment and transactions named in earlier notes; the browser suite (BLOCKED: the UI is orphaned); CI (BLOCKED: dispatched once, no runner); the hosted deployment.
- **Action needed:** see `README.md`, section "Status".

## 2. How to reproduce

From a clean checkout of `407533ac09f7121806836e25db4834be5c91c412`, with PostgreSQL reachable at the default local URL
(`postgres://bind_local:bind_local_only@127.0.0.1:5432/bind_local`, the development default in `src/config/env.ts`):

```bash
npm ci
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration            # run it twice to check for flaky tests
npm run build
npm run sdk:build
npm run mcp:build
npm audit --audit-level=high
npm run api:spec && git diff --exit-code docs/openapi.json
npm run sdk:generate && git diff --exit-code sdk/src/generated
npm run map:functions && git diff --exit-code docs/CODEBASE_MAP.md
npx vitest run tests/unit/contract-artifact.test.ts tests/integration/local-chain.test.ts tests/integration/arc-settlement-evm.test.ts tests/integration/arc-find-transfer.test.ts
npm run test:e2e                    # exits 1 and prints BLOCKED (UI orphaned, ADR 0016)
BIND_ACCEPT_NOT_RUN=test:e2e bash scripts/verify-local.sh
```

Smoke run of the built server (the HTTP calls were made with `curl`; the owner token was kept in a file and not printed):

```bash
npm run build
BIND_WORKER_ENABLED=false PORT=<free port> node dist/index.js
curl -s http://127.0.0.1:<port>/health
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/ready
curl -s http://127.0.0.1:<port>/api/openapi.json
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"workspaceId":"<unique id>","name":"Smoke Kitchen","businessType":"kitchen","budgetDailyLimitCents":5000,"approvalThresholdCents":1000}' \
  http://127.0.0.1:<port>/api/workspaces/onboard          # returns ownerToken.token once
curl -s -H "Authorization: Bearer <ownerToken.token>" http://127.0.0.1:<port>/api/workspaces/<unique id>
curl -s -H "Authorization: Bearer <ownerToken.token>" http://127.0.0.1:<port>/api/workspaces/<unique id>/inventory
kill -TERM <pid>                                        # the log line shutdown.completed is the evidence
psql "$DATABASE_URL" -c "DELETE FROM workspaces WHERE id = '<unique id>';"   # cascades to the workspace's rows
rm -rf templates/<unique id>                             # the derived directory, if created
```

To check the claims in this document against the repository: `npx vitest run tests/unit/docs-honesty.test.ts`.

## 3. Gates

Results from the runs on `407533a`. "Class" is one of the five evidence classes in `docs/TESTING_AND_RELEASE_GATES.md` section 10.

| Gate | Command | Result (this run) | Class |
| --- | --- | --- | --- |
| Lint | `npm run lint` | exit 0; no problems reported | LOCAL_PASS |
| Typecheck | `npm run typecheck` | exit 0 (root, `sdk` and `mcp` projects) | LOCAL_PASS |
| Unit | `npm run test:unit` | on 407533a: 48 of 48 files; 340 of 340 tests passed; 15.2 s. On the final tree (adds `tests/unit/docs-honesty.test.ts`): 49 of 49 files; 347 of 347 tests passed; 15.7 s (see the note below the table). | LOCAL_PASS |
| Integration, run 1 | `npm run test:integration` | 59 of 60 files passed, 1 skipped (`anvil-settlement.test.ts`); 535 tests passed, 10 skipped, 0 failed; 183.3 s | LOCAL_PASS |
| Integration, run 2 | `npm run test:integration` | the same: 535 passed, 10 skipped, 0 failed; 181.4 s. No test changed result between the runs. | LOCAL_PASS |
| Production build | `npm run build` | exit 0 | LOCAL_PASS |
| SDK build | `npm run sdk:build` | exit 0 | LOCAL_PASS |
| MCP build | `npm run mcp:build` | exit 0 | LOCAL_PASS |
| Dependency audit | `npm audit --audit-level=high` | exit 0; 0 vulnerabilities in the report (475 dependencies) | LIVE_READ_PASS |
| OpenAPI drift | `npm run api:spec`, then `git diff --exit-code docs/openapi.json` | exit 0; no drift | LOCAL_PASS |
| SDK drift | `npm run sdk:generate`, then `git diff --exit-code sdk/src/generated` | exit 0; no drift | LOCAL_PASS |
| Map drift | `npm run map:functions`, then `git diff --exit-code docs/CODEBASE_MAP.md` | exit 0; no drift | LOCAL_PASS |
| In-process contract suite | `npx vitest run tests/unit/contract-artifact.test.ts tests/integration/local-chain.test.ts tests/integration/arc-settlement-evm.test.ts tests/integration/arc-find-transfer.test.ts` | 4 of 4 files; 32 of 32 tests passed. In-process EVM, not Anvil. | LOCAL_PASS |
| Browser E2E (orphaned UI) | `npm run test:e2e` | prints `BLOCKED: browser E2E is not run: the UI is orphaned (ADR 0016)` and exits 1 | BLOCKED |
| Browser E2E (legacy) | `npm run test:e2e:legacy` | not run in this task | NOT_RUN |
| Forge format, build, unit, fuzz, invariant, coverage | `forge fmt --check`, `forge build`, `forge test -vvv`, `forge coverage` in `contracts/` | Forge 1.5.1. Format and build exit 0 (the build prints lint warnings about `uint160` casts in tests). 3 suites, 24 of 24 tests passed: 10 unit or fuzz, 8 reentrancy, 6 invariants (256 runs, depth 15, 0 reverts). Coverage of `src/BindSettlement.sol`: lines 100% (68/68), statements 93.02% (80/86), branches 72.73% (16/22), functions 100% (11/11). The branch figure is why "100% coverage" is not claimed. | LOCAL_PASS |
| Anvil deployment and client suite | `ANVIL_RPC_URL=<node> npx vitest run tests/integration/anvil-settlement.test.ts` | Anvil 1.5.1 on chain 31337, started by `scripts/verify-local.sh`: 10 of 10 tests passed. Without `ANVIL_RPC_URL` the file's 10 tests are skipped, so the plain integration run does not cover it. | LOCAL_PASS |
| Slither | `slither . --fail-medium` in `contracts/` (config: `contracts/slither.config.json`) | Slither 0.11.6, solc 0.8.28. 1 contract, 102 detectors, 9 findings, none medium or high: 3 reentrancy-events and 2 timestamp (low), 3 low-level-calls (informational), 1 `owner` could be immutable (optimization). Exit 0. With an arbitrary-send function added, the same command exits 255 (mutation check; the file was restored). The first attempt, `slither .` with no config, analysed 0 contracts and exited 0: a false pass, fixed in `f776d34`. | LOCAL_PASS |
| Clean dependency install | `npm ci` | not run in this task: `node_modules` was already present, and the runner printed INFO | NOT_RUN |
| Live Arc checks | `ARC_RPC_URL=<arc-rpc-url-with-token> npx tsx scripts/verify-live-arc.ts` | not run: no token, no `cast`, no chain access | NOT_RUN |
| CI workflow | `.github/workflows/quality-gates.yml` | dispatched once; no job got a runner, no step ran (section 6) | BLOCKED |
| Local gate runner | `BIND_ACCEPT_NOT_RUN=test:e2e bash scripts/verify-local.sh` | exit 1; summary below | BLOCKED |
| Built-server smoke run | section 4 | every check listed passed | LOCAL_PASS (smoke) |

Note on the counts. The rows above ran on `407533a`, before this document and its test were added. The final run on the committed
tree, after the test was added, was: `npm run lint` exit 0, `npm run typecheck` exit 0, and `npm run test:unit` 49 files and
347 tests passed. The difference from the 340 tests above is exactly the seven tests in `tests/unit/docs-honesty.test.ts`. No product
code changed. Integration results are the same as above, because the test and the documents do not touch the integration suite.

The local gate runner's own summary (its output is quoted as printed; the rows above explain each line):

```
PASS=12 FAIL_OR_BLOCKED=3 NOT_RUN_ACCEPTED=1     (commit 407533a, before Foundry and Slither were installed)
BLOCKED: forge, anvil and slither not installed

PASS=18 FAIL_OR_BLOCKED=0 NOT_RUN_ACCEPTED=1     (commit f776d34, 2026-10-20, after installing them; exit 0)
PASS: lint, typecheck, unit, integration, contract in-process suite, build, sdk:build, mcp:build, audit,
      spec drift, sdk drift, map drift, forge fmt --check, forge build, forge test -vvv, forge coverage,
      anvil integration, slither (--fail-medium)
NOT_RUN accepted by BIND_ACCEPT_NOT_RUN: test:e2e (UI orphaned, ADR 0016)
```

The first summary exited 1 because a missing tool is never a pass. The second exited 0 with Foundry 1.5.1, Anvil 1.5.1, Slither 0.11.6 and
solc 0.8.28 installed locally (downloaded through the environment's proxy; the tools are not part of the repository). In that run unit was 347 of 347,
integration 535 passed and 10 skipped, and the in-process contract suite 32 of 32.

Remote reproduction recorded: `npm audit --audit-level=high` on `407533a` at 2026-10-20T10:24:56Z, and again inside
`scripts/verify-local.sh` at about 10:29Z. npm's advisory database was read through the proxy, 0 vulnerabilities. This is a read of a
third-party service. It is not a Bind integration, and it is the only row in this document with a remote read.

## 4. Smoke run of the built server

Run after `npm run build`, with `BIND_WORKER_ENABLED=false` and the local database, on a free port. Class: LOCAL_PASS (smoke).

| Check | Result |
| --- | --- |
| `GET /health` | 200 `{"status":"ok","postgres":"connected"}` |
| `GET /ready` | 200 `{"status":"ready"}` |
| `GET /api/openapi.json` | 200; OpenAPI 3.0.3; 56 paths; 67 operations |
| `POST /api/workspaces/onboard` (unique id) | 201; the owner token is returned once in the body |
| `GET /api/workspaces/:id` with the owner token | 200 |
| `GET /api/workspaces/:id/inventory` with the owner token | 200 |
| `GET /api/workspaces/:id/workflows` with no token | 401 `{"error":"Authentication required"}` |
| `SIGTERM` | server log: `shutdown.started` (signal SIGTERM), then `shutdown.completed` with `forced: false`; exit code 0 |

Cleanup: the workspace was deleted from the database (cascade, verified: no audit or credential rows left), and its derived
`templates/<id>` directory was removed (untracked).

An earlier attempt in this task (workspace `ws-smoke-1792492226`) failed because the smoke script read the wrong field of the
onboarding response, so its requests were sent without a token. The server was not at fault. That workspace was deleted in the
same way. Only the second attempt is recorded here.

Also run in this task (LOCAL_PASS, dev entry): `npx tsx src/index.ts` (the entry `npm run dev` runs, without its watch mode) started,
ran its migration and the demo workspace check, listened, and shut down cleanly on SIGTERM (the `timeout` kill is the stop).
`npm run db:migrate:dev` exited 0. `npm run dev` itself, in watch mode, was not run.

### 4.1 Model-driven check of the MCP server (2026-10-20)

Class: LOCAL_PASS (a usability check, not a gate). A real model, through the `claude` CLI, used the packaged stdio MCP server
against the built API and a throwaway `kitchen-v1` workspace with a staff token. Four runs (two prompts, each twice) all finished
without a tool error. Observed: a replenishment over the approval threshold was held with an approval id and a repeat returned the
same ids (database check: one workflow, one pending approval); the model could not and did not try to approve; an injected
instruction in feedback text was stored as data and not followed. It found one tool description that understated the effect of a
replenishment under the threshold; that is fixed (ADR 0042). Reproduce with `bash scripts/mcp-model-check.sh`. Simulated
suppliers and settlement; one model family; not a security proof. The workspaces were deleted.

## 5. Capabilities

One row per capability. "Proving files" are the test files that assert the behaviour. All files named here were run in the gates
above, except where the class column says otherwise.

| Capability | Class | Proving files | Simulated or local only |
| --- | --- | --- | --- |
| Kitchen replenishment workflow (low stock, quote, policy, approval, one order, recovery) | LOCAL_PASS | `tests/integration/workflow-orchestrator.test.ts`, `tests/integration/reconcile-once.test.ts`, `tests/integration/order-submission-recovery.test.ts`, `tests/integration/replenish-key.test.ts`, `tests/unit/replenishmentTools.test.ts`, `tests/unit/kitchen-template.test.ts` | Suppliers are simulated (`SIMULATED_SUPPLIER_ADAPTER`). No live supplier. |
| Policy gate and approvals | LOCAL_PASS | `tests/unit/commitment-gate.test.ts`, `tests/integration/commitment-gate.test.ts`, `tests/integration/commitment-recheck.test.ts`, `tests/integration/approval-lifecycle.test.ts`, `tests/integration/approval-atomic.test.ts`, `tests/unit/policy-engine.test.ts`, `tests/unit/effect-classifier.test.ts`, `tests/unit/effect-classifier-fail-closed.test.ts` | The approval notice is recorded, not delivered. |
| Order reservation and effects ledger | LOCAL_PASS | `tests/integration/effects-ledger.test.ts`, `tests/integration/order-submission-recovery.test.ts`, `tests/integration/daily-budget-statuses.test.ts`, `tests/unit/effects-operation-map.test.ts`, `tests/unit/effects-serialize.test.ts`, `tests/integration/notification-effects.test.ts` | Local PostgreSQL. The supplier and emitter are simulated. |
| Settlement: local simulator (default) | LOCAL_PASS | `tests/unit/local-settlement-sim.test.ts`, `tests/integration/settlement-confirmation.test.ts`, `tests/integration/settlement-effects.test.ts`, `tests/integration/settlement-pause.test.ts`, `tests/integration/settlement-lost-claim.test.ts`, `tests/integration/studio-settle-once.test.ts` | In memory. Transfers are lost on restart. No money moves. |
| Settlement: Arc adapter against the in-process EVM | LOCAL_PASS (in-process EVM) | `tests/integration/arc-settlement-evm.test.ts`, `tests/integration/arc-find-transfer.test.ts`, `tests/integration/local-chain.test.ts`, `tests/integration/bind-settlement-properties.test.ts`, `tests/integration/bind-settlement-reentrancy.test.ts`, `tests/unit/contract-artifact.test.ts`, `tests/unit/arc-contract-boundary.test.ts` | The in-process EVM is not Anvil and not Arc. The live Arc check is NOT_RUN (section 6). |
| Settlement against Anvil | LOCAL_PASS (local Anvil) | `tests/integration/anvil-settlement.test.ts` (10 tests) | A local node, not Arc. Skipped in the plain integration run unless `ANVIL_RPC_URL` is set. |
| Crash recovery and worker | LOCAL_PASS | `tests/integration/crash-recovery.test.ts`, `tests/integration/worker.test.ts`, `tests/integration/worker-sweep.test.ts`, `tests/integration/needs-attention.test.ts`, `tests/integration/workflow-cancel.test.ts`, `tests/integration/shutdown.test.ts`, `tests/integration/migration-lock.test.ts` | A crash is simulated by leaving the state a crash would leave. No test kills a process in the middle of an effect. The worker runs only in the server process. |
| Auth and tenancy | LOCAL_PASS | `tests/integration/auth-tenancy.test.ts`, `tests/integration/audit-actors.test.ts`, `tests/unit/tokens.test.ts`, `tests/integration/error-echo.test.ts`, `tests/integration/untrusted-input.test.ts` | The owner is identified by a token label, not a person (ADR 0021). |
| Webhooks and surface identity | LOCAL_PASS | `tests/integration/webhook-auth.test.ts`, `tests/integration/webhook-receiver.test.ts`, `tests/unit/webhook-signing.test.ts`, `tests/integration/surface-pause.test.ts`, `tests/unit/socialSurface.test.ts`, `tests/integration/notification-recipients.test.ts` | Bind's own signed format only. No WhatsApp, email, Telegram or POS connector. |
| Credentials store | LOCAL_PASS | `tests/integration/credentials.test.ts`, `tests/unit/credential-crypto.test.ts`, `tests/unit/redaction.test.ts`, `tests/unit/redact-secrets.test.ts` | No live verifier: every credential reads `configured_unverified`. |
| Customer orders | LOCAL_PASS | `tests/integration/customer-fulfilment.test.ts`, `tests/integration/customer-fulfilment-effects.test.ts`, `tests/unit/fulfilment-promise.test.ts`, `tests/unit/customer-order-link.test.ts` | No customer messages, prices or payments. |
| Menu and feedback | LOCAL_PASS | `tests/integration/menu-feedback.test.ts`, `tests/unit/feedback-summary.test.ts` | Term counts only. No model wording. |
| API contract, event stream, SDK, MCP | LOCAL_PASS | `tests/integration/api-contract.test.ts`, `tests/unit/openapi.test.ts`, `tests/integration/openapi-route.test.ts`, `tests/integration/events.test.ts`, `tests/integration/events-shutdown.test.ts`, `tests/unit/events.test.ts`, `tests/integration/sdk.test.ts`, `tests/unit/sdk.test.ts`, `tests/unit/sdk-sse.test.ts`, `tests/unit/sdk-stream.test.ts`, `tests/integration/mcp.test.ts`, `tests/unit/mcp.test.ts` | MCP is driven by the SDK client over an in-memory transport and over stdio. No real model client. |
| Observability and rate limits | LOCAL_PASS | `tests/integration/ops.test.ts`, `tests/unit/logger.test.ts`, `tests/unit/metrics.test.ts`, `tests/integration/rate-limit.test.ts`, `tests/unit/rate-limit.test.ts`, `tests/integration/route-failure.test.ts` | Limits and metrics are per process, in memory. |
| Contract tests, in-process | LOCAL_PASS | `tests/unit/contract-artifact.test.ts`, `tests/unit/helper-artifacts.test.ts`, `tests/unit/arc-contract-boundary.test.ts`, `tests/integration/bind-settlement-properties.test.ts`, `tests/integration/bind-settlement-reentrancy.test.ts`, `tests/integration/local-chain.test.ts` | In-process EVM. The property tests are not Forge invariant tests and are not a proof. |
| Contract tests, Forge (unit, fuzz, invariant, reentrancy) | LOCAL_PASS | `contracts/test/BindSettlement.t.sol` (10 functions), `contracts/test/BindSettlement.invariant.t.sol` (6 invariants), `contracts/test/BindSettlement.reentrancy.t.sol` (8 functions) | Forge 1.5.1: 24 of 24 passed, invariants 256 runs at depth 15. Branch coverage of the contract is 72.73%. |
| Contract tests, Anvil | LOCAL_PASS | `tests/integration/anvil-settlement.test.ts` | Local Anvil, chain 31337. |
| Browser UI | NOT_RUN | `tests/e2e/dashboard.spec.ts` (tests the orphaned UI) | The UI is orphaned (ADR 0016). Nothing tests a new UI, because none exists. |
| Local-only, no testnet credentials | LOCAL_PASS | the whole unit and integration run above, with `.env.local` moved aside | No live credential was used. |

## 6. Simulated, BLOCKED or needs credentials

- **Suppliers.** All are simulated, in memory (`src/adapters/suppliers/`). A simulated order is labelled `SIMULATED_SUPPLIER_ADAPTER`.
  No real supplier has been contacted, and no quote from a real supplier has been received.
- **Messaging.** Owner notices (approval requests, held orders, restock notices) are recorded by an in-memory emitter with status
  `simulated` (`src/adapters/web2/notifications.ts`). Nothing is delivered to any phone or inbox. The audit row `notification.in_doubt` and
  the ledger state "completed" mean "recorded by the emitter", not "delivered".
- **Accounting.** A local journal in PostgreSQL (`src/accounting/journal.ts`). No accounting service is connected.
- **Settlement.** The default is the in-memory local simulator, in which no money moves. The Arc adapter is tested only against the
  in-process EVM. Its live path is `NOT_RUN`.
- **LLM.** No model key is set. The deterministic offline path is what runs. The paths that need `NEBIUS_API_KEY` are NOT_RUN. The agent harness's own model path is NOT_RUN. A real model was
  driven through the MCP server once, locally (section 4.1, LOCAL_PASS).
- **Market benchmarks.** Without `PARALLEL_API_KEY` or `TAVILY_API_KEY`, a labelled offline reference (`OFFLINE_DETERMINISTIC_FALLBACK`)
  is returned. It is not a market price.
- **Arc live.** NOT_RUN. No network to the chain, no token, no `cast`. The live script (`scripts/verify-live-arc.ts`) was not run.
- **Forge, Anvil, Slither.** Ran locally (section 3). They are installed in this environment only; CI has not run them.
- **CI.** BLOCKED. One manual run was dispatched on 2026-10-20 (run 39412218020, commit 23042f2). The `quality` and `contracts` jobs
  ended `failure` after 3 seconds with no runner assigned, no steps and no log (the log download returns 404), and `verify-local`
  was skipped. No step of the workflow executed, so its job definitions are still unproven. The cause is not visible from the
  API. A job that never gets a runner usually points to the account or repository (Actions billing or spending limit, or Actions
  settings), not to the workflow file. Owner action: open the run page, read the annotation, and fix the account setting.
- **Browser E2E.** `npm run test:e2e` is BLOCKED (the UI is orphaned). `npm run test:e2e:legacy` is NOT_RUN.
- **Circle CLI and surface providers.** Disabled unless `ENABLE_LIVE_CIRCLE_CLI` and `SURFACE_PROVIDER_VERIFIED` are set. Neither is set here.
- **Serverless deployment (Vercel).** NOT_RUN. The entry `api/` runs no worker, and `/ready` and `/metrics` are not routed to the function (RUNBOOK section 1).

## 7. Known risks

Each row is a real limit recorded in a decision record, in the runbook, or found in this task. Where a limit is in a deployed contract,
changing it is a product decision and it has not been changed here.

| Risk | Where it is recorded | What to do |
| --- | --- | --- |
| One Arc signer. `ARC_SIGNER_PRIVATE_KEY` signs every settlement transfer. Losing it stops settlement; a leak exposes the funds it controls. | RUNBOOK section 14; ADR 0013 | Keep the key out of the repository and logs. Decide on a signer and rotation plan before any live use. |
| The credential key is one environment variable (`BIND_CREDENTIAL_KEY`). A leak of it with the database exposes every stored credential. A compromised server process holds it in memory. | ADR 0024 ("What is NOT protected") | Store it in a secret manager; rotate it with the procedure in RUNBOOK section 12. |
| `BIND_MASTER_SECRET` derives every workspace's webhook secret. Rotating it changes all of them at once. | ADR 0022; RUNBOOK 11.3 | Treat as a maintenance event. |
| The on-chain daily limit is a fixed window that resets at `lastDayReset + 1 day`. The NatSpec says "rolling". A spend stops counting at the reset, not 24 hours after it was made. | `contracts/src/BindSettlement.sol` lines 76 to 86; `docs/CONTRACT_SCOPE.md` section 7 items 2; ADR 0039 section 5 | Decide the intended behaviour before any change. The deployed contract cannot be changed in place. |
| A refund of an earlier window's escrow reduces the current window's spent amount. The window can then hold more settlement than the limit (the named test: 14 USDC against a 10 USDC limit). | `docs/CONTRACT_SCOPE.md` section 7 item 1; ADR 0039 section 5 item 1; `tests/integration/bind-settlement-properties.test.ts` (asserted as current behaviour) | A product decision; not fixed. |
| Rate limits and metrics are per process and in memory. Serverless instances keep their own counters. Metrics are refused from a blocked address. | ADR 0033; ADR 0032; RUNBOOK section 9 | Run one process per limit that must hold, or add a shared store. |
| The simulated supplier keeps accepted orders in memory. After a restart its lookup reports "not found", so the worker's recovery can send a simulated order again. Real adapters must look orders up in durable records. | ADR 0018 ("Known limitations"); RUNBOOK 7.4 and 14 | Accept while suppliers are simulated. Fix before any real supplier. |
| Event stream horizon: a stream sends an event only when every older transaction has finished, database-wide. An `idle in transaction` session holds back every workspace's events. | ADR 0035 (Risks); RUNBOOK section 15 | Monitor for idle transactions; set `idle_in_transaction_session_timeout` per database. |
| The first start after the event-stream change rewrites `audit_logs` once (a volatile default under an exclusive lock). The first start also builds four indexes without `CONCURRENTLY`. | ADR 0035 (Risks); ADR 0040 section 3; RUNBOOK 3.1 | Back up and run the migration alone in a maintenance window on a large table. |
| The migration deletes duplicate `three_way_matches` rows (after copying them to an archive table). | RUNBOOK 3.1 | Back up before the first start of a version that changes that statement. |
| `DATABASE_URL` is required in production. Outside production the default URL contains a known password. | ADR 0033; `src/config/env.ts`; RUNBOOK section 2 | Set `DATABASE_URL` in every deployed environment. |
| The pause is checked immediately before a transfer, not in the same transaction. A pause written in that window can still pay. | ADR 0023 ("Known risks"); RUNBOOK 6.1 | Accept and document, or add a lock the transfer cannot cross. |
| Owner identity is a bearer token label. Owner tokens are equally powerful, have no expiry, and any owner can issue tokens. | ADR 0021 (Consequences) | Issue tokens to named people only; revoke with `DELETE .../tokens/:id`. |
| A document confirmation records the request body's `decidedBy`, not the token label. | ADR 0021 ("Not done"). Not re-checked in Task 14. | Confirm and fix before relying on the audit label for document decisions. |
| Surface bridges are trusted with the workspace secret. Their `actorId` claims are not verified independently. | ADR 0022 | Limit who holds the surface secret. |
| Owner notices are not delivered. A waiting approval is visible only through the API and the needs-attention list. No push exists. | ADR 0025; ADR 0027; ADR 0030 ("No push") | Build a delivery channel before depending on notices. |
| The worker does not run on serverless, so expiry, recovery and settlement confirmation do not run there. | ADR 0029; RUNBOOK section 1 | Run the worker in a server process, or add an external scheduler. |
| The request-evidence label `LIVE_READ_PASS` is returned for a reconciled Arc-testnet request. A settlement is a remote mutation, not a read, so the label overstates what the code checked. | `src/agents/evidence-classification.ts` (lines 13 to 21); `tests/unit/evidence-classification.test.ts` asserts it. Found in Task 14. | Product change, not made here. Relabel as a remote write that was confirmed on the chain. |
| The orphaned UI shows `SETTLED_ON_ARC_TESTNET` without a condition, in the static preview and the payment line. It also has a sample explorer link. | `src/ui/public/app.js` lines 964; `src/ui/public/index.html` lines 1317 and 1634 (ADR 0016) | Do not show `src/ui` to anyone. It is unsupported and is replaced by the rebuild. |
| Git history: commit `0b69b2e` says it removed a hard-coded Arc RPC token from source, docs and the example. A search of every commit found no literal token; every occurrence is the placeholder `<ARC_RPC_TOKEN>`. The exposure is not confirmed. | Appendix, A24 | Rotate the Arc RPC token if it was ever used with this repository. |
| Receipts and bills are ordered by a random row id when `received_at` ties. | ADR 0020 (Consequences) | Order by a stored sequence. Low risk: `received_at` has microsecond resolution. |
| Version gap: CI pins Node 24 and PostgreSQL 17. This run used Node 22 and PostgreSQL 16. ADR 0001 names Node 24. | `.github/workflows/quality-gates.yml`; ADR 0001 | Run the gates on the CI versions once CI runs. |
| Forge, Anvil and Slither ran once, locally, on one machine. Branch coverage of the contract is 72.73%, and Slither's low findings (reentrancy-events, timestamp) were reviewed but not fixed. | section 3 | Run them in CI when a runner exists; add tests for the 6 uncovered branches. |
| The restock sweep starts replenishments on its own, within policy, when `BIND_RESTOCK_SWEEP=true`. It is off by default. | RUNBOOK 6.2; ADR 0030 | Leave it off unless deliberately enabled. |

## 8. Skipped tests

- **`tests/integration/anvil-settlement.test.ts`**: `describe.skipIf(!ANVIL_RPC_URL)`. Its 10 `[anvil]` tests were reported as
  skipped in both integration runs and in the runner's run. The integration gate exits 0 with them skipped, because a skip is not a
  failure. Do not read "535 passed" as covering Anvil; the Anvil file ran separately (10 of 10).
- **`tests/e2e/dashboard.spec.ts`**: 4 tests in two Playwright projects (8 runs). Not run: the UI is orphaned (BLOCKED or NOT_RUN).
- **Solidity tests** in `contracts/test/`: 10 unit or fuzz functions, 6 invariants and 8 reentrancy functions. Run by Forge 1.5.1 on 2026-10-20: all passed (section 3).
- **CI jobs** in `.github/workflows/quality-gates.yml`. Never executed.
- **Searches for other skips.** `it.skip`, `describe.skip`, `test.skip`, `xit`, `xdescribe`, `it.todo`, `test.todo`, `.only`
  (in `tests/` and `contracts/test/`): none found. The only conditional skip is the Anvil file above.

## 9. Addendum: the SDK in the browser (ADR 0056)

Added on 2026-10-20 for the change that serves `sdk/dist` at `/sdk/` (`src/server/app.ts`), builds and copies it for Vercel, and
adds `tests/web/sdk-browser.spec.ts` and `tests/integration/sdk-browser-serving.test.ts`. The full command list, counts and
findings are in `docs/decisions/0056-sdk-in-the-browser.md`. Summary by class:

- **LOCAL_PASS.** `scripts/verify-local.sh` exited 0 with PASS=19, FAIL_OR_BLOCKED=0, NOT_RUN_ACCEPTED=0 on the worktree branch at
  `409c2bb` plus this change. Gates: lint, typecheck, unit (423 tests), integration (586 passed, 10 skipped), contract in-process
  suite (32), build, sdk:build, mcp:build, audit, spec, sdk and map drift, forge fmt, build, test and coverage, anvil (10), slither,
  and the browser suite (30 passed, 4 skipped). The gate run used the local database `bind_sdk_a9084`, not `bind_local`, because
  another session was running the same integration suite on `bind_local` at the time, which caused deadlocks in a first attempt.
- **LOCAL_PASS (manual).** Production path: `npm run build` then `node dist/index.js` serves `/sdk/index.js` as JavaScript with the
  file's exact bytes; `/sdk/index.d.ts` is 404. With `sdk/dist` missing, `/sdk/index.js` is 404 and the server still answers
  `/health`.
- **LOCAL_PASS (build only).** The Vercel build command was run as written in `vercel.json`; `public/sdk/` holds the 5 compiled
  `.js` files and nothing else.
- **NOT_RUN.** A Vercel deployment and its headers; browsers other than Chromium; a live (non-local) URL.
- **BLOCKED.** None for this change.
- **LIVE_READ_PASS / VERIFIED_REMOTE.** None. Nothing here contacted a live service.
- **Pre-existing drift.** `docs/CODEBASE_MAP.md` at `409c2bb` did not match a fresh regeneration (same function totals, large diff in
  layer ordering). It was regenerated in this change so the map gate passes; the cause of the layer ordering was not investigated.

## 10. Change evidence: `GET /api/me` (ADR 0058)

This section records one change, not the whole release. The gates ran on the working tree of this branch. It contains the endpoint (first commit `941033e`, parent `409c2bb`),
its follow-up changes (passthrough schema, expired-session test, 500-path logging), the regenerated artifacts and ADR 0058.
The branch was merged with the latest `claude/capabilities-overview-c6elxr` (`4f189b6`) before the follow-up. The full
record is `docs/decisions/0058-who-am-i.md`.

Command: `bash scripts/verify-local.sh`, with `DATABASE_URL` pointing at a database of its own on the same local cluster. Result:
`PASS=19 FAIL_OR_BLOCKED=0 NOT_RUN_ACCEPTED=0`. The gates are lint, typecheck, unit (54 files, 425 tests), integration (68 files
passed and 1 skipped; 609 tests passed and 10 skipped), the contract in-process suite (32 tests), build, sdk:build, mcp:build, the
dependency audit (0 vulnerabilities), spec, sdk and map drift, forge fmt, build, test (24 tests) and coverage, anvil integration,
slither, and test:e2e (10 tests).

Classification of this change's evidence. Every gate listed above is LOCAL_PASS, on this machine and this local database. No
live read, remote or hosted check was made, so none is claimed. The GitHub Actions workflow was not run and is NOT_RUN. No gate is
BLOCKED for this change. The first full run failed `map drift`, because the code map had been generated before the last test files
were added; the map was regenerated from the final test set and the second full run passed.

## 11. Change evidence: owner notices by email (ADR 0074)

This section records one change. Branch `worktree-agent-acd2c81ecb86759f4`, fast-forwarded to `claude/capabilities-overview-c6elxr`
first. The record is `docs/decisions/0074-owner-email-notices.md`.

Commands, run from the worktree, with `DATABASE_URL` pointing at a database created for this run on the local cluster
(`bind_priv_acd2_r3`, dropped after the run). The branch was merged with the latest `claude/capabilities-overview-c6elxr`
before the second review round. The second round fixed the review's blocking findings (demo refusal, verification-only recipients,
persistent wrong-guess cap, workspace send caps, binding removal marker, race-safe binding insert) and its should-fix items.

| Command | Result | Class |
|---|---|---|
| `npm ci` | exit 0 | LOCAL_PASS |
| `npm run lint` | no problems | LOCAL_PASS |
| `npm run typecheck` (root, sdk, mcp) | no errors | LOCAL_PASS |
| `npm run test:unit` | 63 files, 652 tests passed | LOCAL_PASS |
| `npm run test:integration` (full, sequential) | 75 files passed, 1 skipped (the skip predates this change); 719 tests passed, 10 skipped | LOCAL_PASS |
| Concurrency checks: the two parallel-request tests fail with the workspace advisory lock removed (7 sends for 5 allowed; 11 for 10) and pass with it | confirmed by a temporary mutation, then restored | LOCAL_PASS |
| `npm run build`, `npm run mcp:build` | exit 0 | LOCAL_PASS |
| `npm run api:spec`, `sdk:generate`, `capabilities:generate` run twice | every generated file unchanged by the second run | LOCAL_PASS |
| `npm run map:functions` | **not run.** This worktree has no `.ua/knowledge-graph.json`. The committed map was generated with it, and without it the layer section is rewritten. The map was left unchanged | BLOCKED: the `map drift` gate fails until the map is regenerated where the graph exists |
| `npm run test:e2e` (website browser suite) | not run. No web or `src/ui` file changed | NOT_RUN |
| `npm audit --audit-level=high`, forge, anvil, slither | not run. No dependency or contract changed | NOT_RUN |
| Live email to a real address or provider | **not run.** Every provider call in the tests goes to a local fake server on 127.0.0.1 | NOT_RUN |

Notes on the run:

- The local database is shared by sessions on this machine. A concurrent full integration run from another worktree caused
  deadlocks in the migration step and in provisioning, which were not in this change. The gate runs here used a database of
  their own, and the full suite passed on it.
- The contract sweep's cap on routes that are not contract tested rose from 10 to 13 (three owner email routes, each with a
  recorded reason in `src/api/registry.ts`). The routes are tested in `tests/integration/owner-email-routes.test.ts`.

## Appendix: Claims from earlier sessions (not reproduced; do not rely on them)

Everything in this appendix was written by an earlier session. Task 14 did not reproduce any of it: this environment cannot reach
the chain, has no token, and has no `cast` or Foundry. The "Earlier label" column shows what the claim said. The "Class" column is
`NOT_RUN` for every row, because nothing here was run in this task. Line numbers refer to the earlier `docs/RELEASE_EVIDENCE.md`,
`README.md` and `docs/CONTRACT_SCOPE.md` at commit `407533a`. The origin is the oldest commit that introduced the text, found with
`git log --all --reverse -S`.

Every row also says why the earlier label was wrong or unreproducible, where that is known.

| # | Claim (as written earlier) | Where it came from (file, line; origin commit) | Earlier label | Why it is not a current pass | How to reproduce | Class |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | "All 10 verification gates pass (`PASS=10 FAIL_OR_BLOCKED=0`)" | old RELEASE_EVIDENCE.md 14, 52; README.md 82 (a056aee, 2026-10-14) | LOCAL_PASS | Forge, Anvil and Slither are BLOCKED here, so the runner cannot report zero failures. Today's runner reports `PASS=12 FAIL_OR_BLOCKED=3`. | `BIND_ACCEPT_NOT_RUN=test:e2e bash scripts/verify-local.sh` (needs forge, anvil, slither) | NOT_RUN |
| A2 | Unit 49, integration 15, Playwright 8 (old 45 to 47; README 88 to 90) | 5aea18c (2026-10-15) for the counts; 374721f (2026-10-18) for Playwright | LOCAL_PASS | Counts have changed (now 340 and 535). The Playwright count is for the orphaned UI and is BLOCKED. | `npm run test:unit`, `npm run test:integration`; browser: none | NOT_RUN |
| A3 | `forge fmt --check` passes; `forge test -vvv` 10 passed; `forge coverage` 100% lines (68/68), 100% functions (11/11) (old 49 to 51; README 92 to 93) | 5a796c4 (tests and coverage), a056aee (format), all 2026-10-14 | LOCAL_PASS | Forge is not installed. The 10 tests are in `BindSettlement.t.sol` and include no invariant tests (CONTRACT_SCOPE section 4). Coverage has not been re-measured. | `cd contracts && forge fmt --check && forge test -vvv && forge coverage` (needs Foundry) | NOT_RUN |
| A4 | Arc RPC check: `arc-canteen status`, chain ID 5042002 connected (old 53) | a056aee | LIVE_READ_PASS | `arc-canteen` is not a command in this repository, and its output was not recorded. | `ARC_RPC_URL=<arc-rpc-url-with-token> npx tsx scripts/verify-live-arc.ts` (gate 1 reads `eth_chainId`) | NOT_RUN |
| A5 | "Arc Testnet Deploy: `forge create --broadcast` deployed `0x16E1Bd42…2aA29`" (old 54) | a056aee; address first in 5a796c4 | VERIFIED_REMOTE | A deployment is a remote mutation. No independent check is recorded. The repository has no deployment script (`contracts/` has no `script/`), and no script runs `forge create`. | None in the repository. A read-only check of code at the address: gate 2 of `scripts/verify-live-arc.ts` with an `ARC_RPC_URL`. | NOT_RUN |
| A6 | Policy configuration on-chain: `setDailyLimit(1 USDC)`, `setEnforceVendorWhitelist(true)`, `setVendorStatus(…, true)` with transaction hashes `0x388196…`, `0x4c8f5b…`, `0x20f048…` (old 28 to 30, 55 to 56; README 71 to 73) | 5a796c4 (2026-10-14) | VERIFIED_REMOTE | Sends are not reproducible from the repository. The stored values were not read back. The "cast send / cast call" row (old 55 to 56) has no recorded read. | None for the sends. The read-only gates 3 and 5 of `scripts/verify-live-arc.ts` check part of the state. | NOT_RUN |
| A7 | Settlement transaction `0x626129…1bbb`, "confirmed in block 67155117 (status=0x1)" (old 31, 57, 79; README 74) | 5a796c4 | VERIFIED_REMOTE (old 57, 79) | Gate 6 checks only that the receipt exists with status `0x1`. It does not check the block, the logs or the value (CONTRACT_SCOPE section 2). A receipt read is a read, so it can never be VERIFIED_REMOTE. | `ARC_RPC_URL=<…> LAST_LIVE_SETTLEMENT_TX=0x626129… npx tsx scripts/verify-live-arc.ts` (gate 6, read only) | NOT_RUN |
| A8 | Deployment transaction `0xe152f9ce…5300e` (old 26; README 70; CONTRACT_SCOPE 27) | 5a796c4 | VERIFIED_REMOTE (earlier) | No script reads the transaction. CONTRACT_SCOPE section 1 labels it unverified. | None in the repository | NOT_RUN |
| A9 | Deployer and owner wallet `0xA4D196…ae9C2` (old 24; CONTRACT_SCOPE 25) | earlier session | earlier claim | No script reads `owner()`. | None in the repository | NOT_RUN |
| A10 | Previous v1 deployment `0x6cb713De…a96f` and its transaction (old 34) | a056aee | earlier claim | No reproduction exists; CONTRACT_SCOPE 28 labels it unverified. | None in the repository | NOT_RUN |
| A11 | Revert claims: unwhitelisted vendor reverts with `VendorNotWhitelisted` (`0x65e822e9`); over-limit reverts with `DailyLimitExceeded` (`0xef664d6a`) (old 32 to 33, 77 to 78; README 63 to 64) | 5a796c4; live section in 5aea18c | LIVE_READ_PASS (old 77, 78) | The old script treated every `cast` failure as the expected revert (CONTRACT_SCOPE section 5 item 1). The corrected script has never been run against a network. The selectors are correct (LOCAL_PASS in CONTRACT_SCOPE section 2). | `ARC_RPC_URL=<…> npx tsx scripts/verify-live-arc.ts` (gates 4 and 5; needs `cast`) | NOT_RUN |
| A12 | Section 5 "Live Arc Testnet & Jev/Surface Verification (2026-10-15T22:24:18.999Z)": six rows, machine-appended (old 71 to 79) | 5aea18c (2026-10-15) | LIVE_READ_PASS and VERIFIED_REMOTE, mixed | (a) The bytecode check (`getCode`, labelled VERIFIED_REMOTE, old 75) and the receipt check (old 79) are reads. A read cannot be VERIFIED_REMOTE. (b) The revert rows (old 77, 78) were LIVE_READ_PASS while any `cast` failure counted as a pass. (c) The section was appended by the script, which now writes only to a new file (ADR 0039 section 4). The "on-chain approved supplier" row (old 76) is a read of `whitelistedVendors`, correctly LIVE_READ_PASS, but it was never run here. | `ARC_RPC_URL=<…> npx tsx scripts/verify-live-arc.ts` (reads only) | NOT_RUN |
| A13 | Live endpoint table, all rows "LIVE_READ_PASS": `POST /api/workspaces/ws-kitchen-main/replenish` returns `confirmed` and creates an order; `POST …/documents/extract` and `/confirm`; `POST …/surfaces`; `POST /api/webhooks/incoming` for stock and for the owner's approval (old 126 to 139) | 374721f (2026-10-18) | LIVE_READ_PASS (earlier) | Most rows are writes against production. A write that creates an order or approves a payment is a remote mutation, not a read, and no independent check of its effect is recorded. The GET rows are reads and were not re-run. | Writes: none should be repeated without authorization. Reads: `curl` against the hosted URL. | NOT_RUN |
| A14 | Serverless deployment: "Public production deployment `https://bind-gilt.vercel.app`", `vercel build --yes`, `vercel deploy --prod --yes` (old 97 to 99, 122 to 123; README 5, 97) | 374721f, d517c1a (2026-10-18) | earlier claim | No network here. Nothing in the repository re-checks the hosted URL. | `curl -sS https://bind-gilt.vercel.app/health` (read; not run here) | NOT_RUN |
| A15 | Vercel repair table: "LOCAL_PASS + LIVE_READ_PASS" for the lazy import, the `/tmp` redirect, and the `/health` rewrite (old 111 to 113) | 374721f | LOCAL_PASS and LIVE_READ_PASS | Typecheck and build passed in this task (section 3). That is not the claimed deployment, and the live part was not reproduced. | `npm run build`; live part: none | NOT_RUN |
| A16 | Four-Flow Studio matrix (old section 6, 83 to 91), with `tests/e2e/dashboard.spec.ts` results | 064dcc6 (2026-10-17) | LOCAL_PASS | The integration part (`tests/integration/studio-flows.test.ts`) passes here. The browser part is NOT_RUN (the UI is orphaned). | `npx vitest run tests/integration/studio-flows.test.ts`; browser: none | NOT_RUN |
| A17 | Approval-slice commands (old 174 to 183): npm ci, lint, typecheck, unit 49, integration 23, build; Playwright 8 passed through an untracked config at `/opt/pw-browsers/chromium` | 66d0d1e (2026-10-19) | LOCAL_PASS | Counts are out of date. The Playwright run used a temporary config that is not in the repository. | Counts: `npm run test:unit`, `npm run test:integration`. Browser: none. | NOT_RUN |
| A18 | Old "Open" item: "Owner authentication on approval and workspace routes. See ADR 0006" (old 194) | 66d0d1e | open risk | Resolved by ADR 0021 (per-workspace tokens). Kept here so no reader takes it as open. | `tests/integration/auth-tenancy.test.ts` | LOCAL_PASS |
| A19 | Security assessment: "Compliance Screening: Verified against Circle's compliance screening policies on Arc Testnet" (old 68) | a056aee (2026-10-14) | earlier claim | No code or script checks any compliance screening. The claim has no basis in the repository. | None | NOT_RUN |
| A20 | "24-hour rolling daily spend limit" and "refunds restore the active day's budget" (old 65; README 63; ADR 0003 decision) | 5a796c4 (2026-10-14) | earlier claim | The code is a fixed window. A refund reduces the current window's spent amount when it can (`contracts/src/BindSettlement.sol` lines 76 to 86, 177 to 178). | Read the source; `tests/integration/bind-settlement-properties.test.ts` | NOT_RUN |
| A21 | "Even in the event of an agent key leak or hallucination, funds cannot be sent outside the approved whitelist or in excess of daily caps" (old 65) | 5a796c4 | earlier claim | Contradicted by the fixed window and the refund case (CONTRACT_SCOPE section 7). The allowlist applies to settlements through the contract, and those tests run in-process. | None | NOT_RUN |
| A22 | Read-only deployment check: "Gate 2 … bytecode length=14716 chars" (old 75) | 5aea18c | VERIFIED_REMOTE | A bytecode read cannot be VERIFIED_REMOTE. The gate checks non-empty code only; it does not compare with the artifact (CONTRACT_SCOPE section 1). | `ARC_RPC_URL=<…> npx tsx scripts/verify-live-arc.ts` (gate 2; read only) | NOT_RUN |
| A23 | The `CONTRACT_SCOPE.md` claims labelled `UNVERIFIED_CLAIM` in that file: the RPC endpoint, the USDC precompile interface (`0x3600…`), the EIP-7708 emitter (`0xffff…FfE`), the ERC-8183 reference contract (`0x0747…4583`), a live transfer at block 67153050 (`0x03f3…5e01`), and `dailySpent()` = 1e15 | 3fc743b (2026-10-14) | earlier claim (labelled unverified in the file) | Each claim is labelled unverified in CONTRACT_SCOPE sections 1 to 3. No script checks most of them. | `ARC_RPC_URL=<…> npx tsx scripts/verify-live-arc.ts` covers the endpoint and gates 1 to 6 only | NOT_RUN |
| A24 | Commit `0b69b2e` "remove hardcoded Arc RPC token from source": the commit says the token was embedded in source, docs and the example | 0b69b2e (2026-10-18) | earlier claim, unconfirmed | Searched all commits (`git log --all`, diffs that name the Arc host or `RPC_TOKEN`). No literal token was found. Every occurrence is `<ARC_RPC_TOKEN>`. The commit's own removed lines are placeholders too. | `git log --all -G 'thecanteenapp\.com/v1/[^<]'` returns no commits. `git log --all -G 'RPC_TOKEN'` shows only placeholders. | NOT_RUN |
| A25 | README: "read APIs, the replenishment and approval flow, and owner/staff role separation were verified end to end" (README 97) | d517c1a (2026-10-18) | earlier claim | Same as A13 and A14. | None here | NOT_RUN |
| A26 | RUNBOOK notes marked "(Verified)" or "(verified)": the `PO-` order number for `wf-example-1` (RUNBOOK 266); the lookup key (342); the address hash (397); the token issue and revoke checks (425, 446); the webhook secret rotation (473); the credential key check (503); the `pg_dump` backup and restore (518, 527); the restore checks (533, 537) | RUNBOOK.md, first committed in 4fedfe7 (Task 12, the earlier session of 2026-10-20) | earlier claim (labelled "Verified") | Checked in an earlier session against a local database, and not re-run here. Each step's own command is written in the RUNBOOK section it cites. | The command in each cited RUNBOOK section | NOT_RUN |

Rows A5 to A13 and A15 are the lines the earlier file put under LIVE_READ_PASS and VERIFIED_REMOTE (old lines 53 to 57, 71 to 79,
111 to 113 and 126 to 139). The reasons are in their rows.

### Git history check for the Arc RPC token (A24)

Method (run in this task, no secret was printed):

1. `git log --all -G 'arc-node'`: six commits mention the host. Their diff lines were counted by the form of the path after `/v1/`.
   Result: 15 lines with `v1/<ARC_RPC_TOKEN>` and no line with any other character after `v1/`.
2. `git log --all -G 'thecanteenapp\.com/v1/[^<]'` and `git log --all -G '/v1/[A-Za-z0-9_-]{20,}'`: no commits.
3. `git log --all -G '[A-Z_]*RPC_TOKEN[A-Z_]*[ ]*[=:][ ]*["'"'"'`][^<"'"'"'`]'`: no commits.
4. Untracked and ignored files in the working tree (excluding `node_modules`) containing the host with a non-placeholder path: none.

So the repository's history does not show a literal token. Commit `0b69b2e` says there was one. Either the value was never committed, or
it was committed in a form this search does not match. Rotation is advised either way, because the value may have been used
outside the repository.

## Live Arc Testnet read-only run (2026-10-22)

Run by the owner's request, step 1 of the Arc plan. Read-only: nothing was signed or sent. The RPC URL and signer key came from the session
environment (mapped inside the commands from `Arc_RPC` and `Arc_Private_Key`); no secret was printed or written. `cast` 1.7.1 was installed from
the npm registry package `@foundry-rs/cast` into a scratch directory outside the repository (the Foundry installer was blocked by a 403 from GitHub).

| # | Check | Command | Observed | Class |
| :--- | :--- | :--- | :--- | :--- |
| L1 | Chain id | `cast chain-id --rpc-url "$ARC_RPC_URL"` | `5042002` | LIVE_READ_PASS |
| L2 | Signer address derived from the key (address only printed) | `cast wallet address --private-key "$ARC_SIGNER_PRIVATE_KEY"` | `0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2` | LIVE_READ_PASS |
| L3 | Signer native balance | `cast balance <signer>` | 4857129833337643373 wei (about 4.857 USDC, 18 decimals) | LIVE_READ_PASS |
| L4 | `owner()` of `0x16E1…aA29` | `cast call … "owner()(address)"` | `0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2`, so the signer IS the owner | LIVE_READ_PASS |
| L5 | `dailySpendLimit`, `dailySpent`, `lastDayReset`, `enforceVendorWhitelist` | `cast call …` | 1e18 (1.0 USDC), 1e15 (0.001 USDC), 1791978785, `true` | LIVE_READ_PASS |
| L6 | `whitelistedVendors(0xa835…06ea)` | `cast call …` | `true` | LIVE_READ_PASS |
| L7 | Deployed code vs `contracts/artifacts/BindSettlement.json` | `cast code` compared with the artifact's creation bytecode | The live runtime code (14716 hex chars) is contained in the artifact's creation code once the trailing 53-byte compiler metadata is excluded. The metadata tail itself differs, so it is not a byte-for-byte match. | LIVE_READ_PASS (code body only; metadata hash not reproduced) |
| L8 | Settlement `0x6261…1bbb` | `cast tx`, `cast receipt` | From the owner to the contract, value 1e15, block 67155117, status success, gas used 90012, one log from the system emitter `0xffff…fffe` | LIVE_READ_PASS |
| L9 | Deployment and configuration receipts (`0xe152…`, `0x3881…`, `0x4c8f…`, `0x20f0…`) | `cast receipt` | Each succeeded, from the owner; the deployment created `0x16E1…aA29` (block 67155017); the other three were calls to the contract (blocks 67155039, 67155064, 67155084) | LIVE_READ_PASS |
| L10 | Transfer `0x03f3…5e01` | `cast receipt` | Success at block 67153050, sent to the `0x3600…` precompile | LIVE_READ_PASS |
| L11 | Other addresses | `cast code`, `cast call … "decimals()" "symbol()"` | `0x3600…` has code, decimals 6, symbol USDC. `0x0747…4583` has code. Previous deployment `0x6cb7…` has code. `0xffff…fffe` has no code (a system address that appears as a log emitter in L8). | LIVE_READ_PASS (presence only; behaviour of `0x0747…` not checked) |
| L12 | Negative path, unapproved supplier, with the funded owner as sender | `cast call … settleOrder … --from <signer> --value 1000000000000000` to `0x…dEaD` | Reverts with `0x65e822e9` (VendorNotWhitelisted) | LIVE_READ_PASS |
| L13 | Negative path, 2.0 USDC, same sender | `cast call … settleOrder … --value 2000000000000000000` to the whitelisted vendor | Reverts with `0xef664d6a` (DailyLimitExceeded), arguments 2.0 USDC and 1.0 USDC limit | LIVE_READ_PASS |
| L14 | `scripts/verify-live-arc.ts` (writes its own evidence file, not appended here) | `npx tsx scripts/verify-live-arc.ts --write-evidence <new-file>` | 4 of 6 gates pass (chain id, bytecode present, vendor allowlist, receipt). Gates 4 and 5 (the two revert checks) did not pass: they ran `eth_call` with no sender, so the caller was the zero address with no balance and the node reverted with a generic `Error(string)` before the contract's own checks. Exit code 1. The script was not changed. | BLOCKED (the script's check as written; L12 and L13 are the same checks with a funded sender) |

Not reproduced: the claim that the previous deployment `0x6cb7…` lacked an on-chain policy, the behaviour of the ERC-8183 reference contract, and the
RPC provider name. Contract state is unchanged by this run: the owner's balance and the contract were only read.
No settlement has been sent in this session.

## Live Arc Testnet settlement through Bind's own code (2026-10-22)

One payment of 1 cent (0.01 USDC), approved by the owner in this session for this payment only. The adapter takes whole cents, so 0.01 USDC is its
smallest amount (the owner raised the earlier 0.001 USDC cap for this payment). Run against a **local** Postgres database and the local server code
(`ProcurementWorkflowRunner` → `OrderSettlementService` → `ArcL1SettlementAdapter`, workspace `settlement_mode = arc-testnet`). The deployed site, the
production database and Vercel were not used. The driver was a one-off script outside the repository. As a test fixture, the local order was edited to
1 unit at 1 cent after the normal replenishment flow created it, so the three-way match produced a payable amount of exactly 1 cent.

Checks immediately before sending, all as reported: chain id 5042002, `owner()` = the signer `0xA4D1…9C2`, `whitelistedVendors(0xa835…06ea)` = true,
`enforceVendorWhitelist` = true, limit 1e18. A guard in the driver refused to send unless the order total was exactly 1 cent.

Idempotency key (ledger): `ws-arc-live-1792669114820:settle:ord_wf_proc_3fb32ea6-fafa-4921-a471-cf891c5a6c28`; adapter key `idem_pay_<orderId>`; contract order id
`keccak256(utf8(orderId))`. Fresh, never used before.

| # | Check | Observed | Class |
| :--- | :--- | :--- | :--- |
| S1 | Transaction | `0xea73b2b1130ec88d75ec831ce19d74d0f6becea2f0009592bdde68b61c6a899d`, from the signer to `0x16E1…aA29`, value 1e16 wei (0.01 USDC), one send | VERIFIED_REMOTE |
| S2 | Submitted vs confirmed | The adapter's `transferUSDC` returned `submitted` with the hash, then `confirm()` polled the receipt in the same call and returned `confirmed`. The runner reports both steps in one call (total about 3.4 s), so the `submitted` result was not captured on its own. Confirmation was then repeated independently with `cast receipt`. | VERIFIED_REMOTE |
| S3 | Receipt (independent `cast receipt`) | status success, block 68513952, gas used 76014, effective gas price 40 gwei (fee 0.00304056 USDC) | VERIFIED_REMOTE |
| S4 | Event | The contract (`0x16e1…aa29`) emitted `SettlementExecuted` with amount 1e16. Two native-transfer logs came from the system emitter `0xffff…fffe` (payer to contract, contract to vendor). | VERIFIED_REMOTE |
| S5 | Balance deltas | Signer 4857129833337643373 → 4844089273337643373 wei (down 0.01304056 USDC: 0.01 payment + 0.00304056 gas). Vendor 51000000000000000 → 61000000000000000 (up 0.01 USDC). Contract balance 0 before and after. | VERIFIED_REMOTE |
| S6 | `dailySpent` | 1e15 → 1e16. It did not become 1.1e16: `lastDayReset` moved from 1791978785 to 1792669139, because the fixed 24-hour window had expired and the earlier 0.001 USDC no longer counted. This is the fixed-window behaviour described in CONTRACT_SCOPE section 7. | VERIFIED_REMOTE |
| S7 | Local ledger | Order `reconciled` with the hash; effect `settlement.transfer_usdc` `completed`, attempts 1, external_ref = the hash | LOCAL_PASS |
| S8 | Repeat with the same key | `fulfillAndReconcile` again: returned `alreadyReconciled: true` with the same hash in 5 ms and did not call the adapter. Signer nonce 9 before and after, same balances, same `dailySpent`, no new block activity from the signer. | VERIFIED_REMOTE |
| S9 | Contract-level guard for the same order id | An `eth_call` (nothing sent) of `settleOrder` for the same order id reverts with `0x4747436c`, which is `OrderAlreadySettled()` | LIVE_READ_PASS |

Not covered: the timeout path was not exercised (no timeout occurred, so no retry decision was needed); only one payment was made; crash recovery against
a live chain is not tested. The adapter handles whole cents only (see ADR 0076).

## Live-check script re-run after the sender fix (2026-10-22)

Change: `scripts/verify-live-arc.ts` now gives the two revert gates a funded sender (`--from`), taken from `ARC_SIGNER_ADDRESS` or derived in-process from
`ARC_SIGNER_PRIVATE_KEY` with viem (ADR 0077). Written by Haiku, reviewed twice by Sonnet (approved, optional nits only). Unit tests:
`npx vitest run tests/unit/verify-live-arc.test.ts tests/unit/docs-honesty.test.ts tests/unit/contract-artifact.test.ts` gave 32 of 32 passing, and
`npx tsc --noEmit` and eslint on the two files were clean (LOCAL_PASS).

| # | Check | Command | Observed | Class |
| :--- | :--- | :--- | :--- | :--- |
| L15 | All six gates of the fixed script, read-only (nothing signed or sent) | `npx tsx scripts/verify-live-arc.ts --write-evidence <new-file>` | Exit 0, 6 of 6 gates pass: chain id, bytecode present, vendor allowlist, `0x65e822e9` revert, `0xef664d6a` revert, receipt of `0x6261…1bbb` | LIVE_READ_PASS |

The earlier run (L14 above) stays as recorded: with no sender, its two revert gates did not pass. L12 and L13 were the same checks done by hand with a funded sender.

Correction to row L2: the command was `cast wallet address --private-key "$ARC_SIGNER_PRIVATE_KEY"`, which expanded the key into that `cast` process's arguments for a moment inside the session container. Nothing was printed or stored, but the owner's rule was that the key not be a command-line argument. The fixed script derives the address in-process and never puts the key in any argument or child environment.

## 0d. Production deploy of hosted MCP, Connect an agent and owner email UI (2026-10-22)

- Deployed commit `ef620ab` to the `bind` Vercel project, target production (`dpl_2vyHPmvGXwXvGxxSPVBj6k88nMhS`, READY), aliased to bind-gilt.vercel.app.
- Full local gate on a private database, run on the code before the last fix: 17 of 19 passed; the two failures (hosted MCP Origin and endpoint address, and the Connect an agent browser test) were one real bug (a loopback `APP_BASE_URL` from `.env.local` pinned the MCP origin). Fixed in `ef620ab` with a unit test; the affected unit, integration (35 tests) and browser (8 tests) suites pass after the fix. A complete gate rerun on `ef620ab` itself was NOT_RUN. Status: LOCAL_PASS for the affected suites, NOT_RUN for the full gate on the final commit.
- Live, unauthenticated: `/health` 200, `/api/public-config` 200, `/app/connect-agent` 200, `POST /mcp` and `GET /mcp` answer 401 `UNAUTHENTICATED` (the Vercel rewrite reaches the endpoint) — LIVE_READ_PASS. CSP header allows only `https://auth.privy.io` beyond self.
- NOT_RUN: `/mcp` with a real staff key and a real MCP client (Claude, Cursor); live email sending (email is off in production: no `BIND_EMAIL_*` variables set).

## Live crash and timeout recovery on Arc testnet (2026-10-22), partial

Owner scope: three scenarios, one 0.01 USDC payment each, testnet only (`scripts/live-recovery-arc.ts`, ADR 0079). Only the first scenario has
been run, and its recovery has **not** been proven. Local database throughout; no mainnet, no new contract, no configuration change.

| # | Check | Observed | Class |
| :--- | :--- | :--- | :--- |
| R1 | `crash-before-record`: payment sent, then the sending process killed with SIGKILL right after broadcast, before the hash was stored | One payment of 0.01 USDC: tx `0xd5e83b918cdd19f50eb6ad36de245963c54f96fe66e7c79235703f8a443c27fc`, block 68527844. Signer nonce 9 to 10. Vendor +0.01 USDC. One `SettlementExecuted` log for the order id. Signer balance 4844089273337643373 to 4831355073337643373 wei (0.01 payment plus gas). Contract `dailySpent` 0.02 USDC (both live payments fall in one window). Child exit signal SIGKILL with the kill marker recorded; before the restart the order was `settling` with no hash and the effect `started`. | VERIFIED_REMOTE |
| R2 | First orchestrator run ended after the kill | Stopped as BLOCKED because the node refuses `eth_getLogs` spans over 100000 blocks ("max block range 100000"); the harness read logs from the deploy block (67155017) to the head in one request. Nothing was sent after the kill. | BLOCKED |
| R3 | Product finding from R2: `ArcL1SettlementAdapter` recovery lookup (`findTransfer`) used the same single-range read, so it could not find a pending payment on this node | Fixed in commits 75cf69c (chunked, newest-first windows of at most 90000 blocks, `src/adapters/settlement/log-scan.ts`) with 19 unit tests against a stub that refuses spans over 100000 blocks. Not yet re-run live. | LOCAL_PASS |
| R4 | `--resume` of the same scenario (sends nothing): guards read live | Chain id 5042002, owner equals the signer, vendor whitelisted, code present at the deploy block, `settledOrders(orderId)` = true, one log found, signer nonce stayed 10, vendor balance delta exactly 0.01 USDC. No second payment. | LIVE_READ_PASS |
| R5 | Recovery adoption after the crash: order reaches `reconciled` with the on-chain hash and the same key repeated sends nothing | **Not proven.** The restart tick moved the order to `payment_hold`, but the retry was refused by the effects ledger with `EffectConflictError`: the stored request used the whitelisted vendor address, while the order's supplier row had since been reset to its simulated address. Cause: the integration test `supplier-payment-address-migration` drops and re-adds `suppliers.payment_address` on the shared local database, and the full integration runs of the build agents did that to this live fixture between the crash and the restart. The ledger refusing a changed request is correct behaviour; the fixture was contaminated by shared test infrastructure. The order stays `payment_hold`, effect `started`, no hash adopted. | BLOCKED |
| R6 | `crash-before-confirm` | Not run. | NOT_RUN |
| R7 | `timeout-retry` | Not run. | NOT_RUN |

What the live run showed so far: a killed process leaves exactly one payment on chain (the contract refuses a second for the same order), the restart does not
send again, and the harness refuses to send for an order already settled on chain. What it did not show: adoption of the pending payment and a clean
`reconciled` record. The next steps are to repair the one fixture field, resume without a new payment, and run the other two scenarios against an
isolated database that the other test suites cannot touch (a separate database for live runs). Each remaining scenario is one more 0.01 USDC payment.

## Live crash and timeout recovery on Arc testnet (2026-10-22 and 2026-10-23), completed

Follow-up to the partial section above, on the owner's go-ahead (option 1: repair the one local fixture row, resume without a new payment, run the other two
scenarios on an isolated database). Total live spend: three payments of 0.01 USDC (one per scenario) plus gas. No mainnet, no new contract, no change to
the contract's owner, limit or whitelist (read back after the runs: owner is the signer, `dailySpendLimit` 1e18, vendor whitelisted).

Fixture repair (local database only, disclosed): the order's supplier row `payment_address` was set back to the whitelisted vendor
`0xa8358AED200D6CB6C856F972D853C1be833006ea`, the value it had when the payment was sent. The stored request hash was then recomputed and matched the
effect row. The resume markers in the state file were cleared so `--resume` could run again; the first resume's evidence is kept as it was. Scenarios 2
and 3 ran on a separate database (`bind_live_recovery`) that no other test suite uses.

| # | Check | Observed | Class |
| :--- | :--- | :--- | :--- |
| R8 | `crash-before-record`, resume (sends nothing) after the repair | Order `reconciled` with tx `0xd5e8…27fc` and block 68527844 from the on-chain log; `settlement_submitted_at`, `settlement_confirmed_at`, `settlement_confirmed_block` set; one `settlement.confirmed` audit; effect `completed` with attempts 1 (adopted, not re-sent); repeat of the same key returned `alreadyReconciled` and the signer nonce stayed 10; one `SettlementExecuted` log for the order id; vendor delta exactly 0.01 USDC. 21 of 21 checks pass. This supersedes R5. | VERIFIED_REMOTE |
| R9 | `crash-before-confirm` (kill inside `confirm()`, after the hash was stored and `settlement.submitted` written) | Before the restart: order `settling` with hash, `settlement_submitted_at` set, `settlement_confirmed_at` null, no `settlement.confirmed` audit, effect `completed`. After two worker ticks: `reconciled`, tx `0x1113b9259e37650919ef379159d420dfead77601487dbc4be390b35970a78238`, block 68762038, receipt success, gas 76026. One log, nonce 10 to 11 (exactly one broadcast), vendor delta exactly 0.01 USDC, repeat sent nothing (nonce stayed 11). 23 of 23 checks pass. | VERIFIED_REMOTE |
| R10 | `timeout-retry` (broadcast forwarded, then a timeout error; same key retried at once and again after mining) | Attempt 1 threw `SettlementTransportError` after exactly one broadcast (order `confirmed`, effect `failed`, as designed). The retries sent nothing further: tx `0xf5386cbbff55e08a2f785ec3c8d6e0b13dd9300e971630bbd8693f5e5d7b1cce`, block 68762071, receipt success, gas 72912; nonce 11 to 12; one log; vendor delta exactly 0.01 USDC; order `reconciled` with that hash. 11 checks pass. | VERIFIED_REMOTE |

Balances at the end: signer 4808301844337643373 wei (nonce 12), vendor 0.091 USDC in total across all live settlements to it, contract `dailySpent` 0.02 USDC.

Limits of this evidence:
- In R10 the retry found the first transfer already mined (one broadcast only). The in-flight case, where a second broadcast races the first and reverts with
  `OrderAlreadySettled`, was **not** observed live; its fix (ADR 0079, adopting the first confirmed transfer) is covered by integration tests against a spy adapter
  and a real database only.
- Each scenario was run once. The recovery lookup trusts the adapter's log read by order id; it does not check payer, supplier or amount (known follow-up from the review).
- The harness and its guards were rehearsed offline (local simulator) and reviewed, then exercised live only in these runs. Crash recovery of a real business
  payment account is out of scope until the owner approves one and who holds its funds.

## Tab ledger for sub-cent charges (ADR 0081), built 2026-10-23 and 2026-10-24

Evidence class for everything in this section: LOCAL_PASS (local Postgres, a spy adapter and the local simulator). No live Arc run, no Anvil run, no real key
and no payment were made for this work.

| # | Check | Command | Observed | Class |
| :--- | :--- | :--- | :--- | :--- |
| T1 | Unit and integration suites on the merged branch | `NODE_ENV=test DATABASE_URL=<local> npx vitest run tests/unit tests/integration` | 149 files passed, 1 skipped (the Anvil settlement suite), 1666 tests passed, 10 skipped; `npx tsc --noEmit` clean | LOCAL_PASS |
| T2 | Accrual, floor and carry-over, idempotency, gates (paused, unverified, no payee address, approval threshold in chunks, shared daily budget), cross-tenant refusal, API auth and validation | `tests/integration/tab-ledger.test.ts`, `tab-api.test.ts`, `tests/unit/tab-units.test.ts` | Passing, including that the adapter is never given a sub-cent or non-whole amount | LOCAL_PASS |
| T3 | Crash and recovery: crash after the clear before the payment, after the adapter returned before "submitted" was recorded, between "submitted" and "confirmed"; rejected before send; failed confirm; lookup unavailable | `tests/integration/tab-recovery.test.ts`, `tab-fuzz.test.ts` | Passing; a tab is never paid twice and a payment that may have been sent is never reversed (two double-payment bugs found in review were reproduced, fixed and covered by regression tests that fail without the fix) | LOCAL_PASS |
| T4 | Order and tab spend share one daily budget | `tests/integration/tab-budget-symmetry.test.ts` and the unchanged commitment-gate tests | Passing | LOCAL_PASS |
| T5 | Live Arc settlement of a tab | None run | Not run. Required before any live use: an operator route to resolve held tab settlements, adoption of a hash lost to a busy lock, and a live Arc run (ADR 0081 addendum). | NOT_RUN |

Known limits: held tab settlements keep their clear and have no exit route yet; above-threshold balances settle only in threshold-sized chunks; the replenishment
pre-check still uses the database's local day and does not count tab spend; with N persistently failing tabs a batch of N can still be filled by them.

## Tab ledger: the two live-use blockers (ADR 0081 items a and b), built 2026-10-24

Evidence class for everything here: LOCAL_PASS (local Postgres, spy adapter, local simulator). No live Arc, no Anvil, no real key, no payment.

| # | Check | Command | Observed | Class |
| :--- | :--- | :--- | :--- | :--- |
| H1 | Merged branch | `NODE_ENV=test DATABASE_URL=<local> npx vitest run tests/unit tests/integration`; `npx tsc --noEmit` | 155 files passed, 1 skipped (the Anvil suite), 1729 tests passed, 10 skipped; typecheck clean | LOCAL_PASS |
| H2 | Lost-hash adoption: a payment sent whose hash was not recorded (busy lock, concurrent hold) is adopted from the effect record or the lookup, then confirmed through the adapter, with exactly one transfer | `tests/integration/tab-held-reconcile.test.ts` | Passing | LOCAL_PASS |
| H3 | Exit for held settlements: worker adoption (never cancels), owner-only list and resolve routes, cancel-and-restore only under three proofs and an owner acknowledgement, exactly one reversal, repeat is a no-op, a refused attempt changes nothing; the duplicate-reverted case (first transfer paid, stored hash is the reverted duplicate) is refused | `tests/integration/tab-held-restore.test.ts`, `tab-held-worker.test.ts`, `tab-held-api.test.ts`, `tab-fuzz.test.ts` (held variant), `tests/unit/arc-is-order-settled.test.ts`, `held-responses.test.ts` | Passing. 24 mutation checks on a scratch copy, each caught by at least one failing test; backoff bounds the audit rows of a never-resolving hold to 6 attempts in 3 days | LOCAL_PASS |
| H4 | Arc `isOrderSettled` and the held-settlement reads against the real contract | None run | Not run. Item (c) of ADR 0081, a live Arc run of the tab path, is still required before any live use. | NOT_RUN |

Residuals: proof (iii) cannot exclude a transaction still in a mempool after 30 minutes, so it needs the owner's acknowledgement; the local simulator forgets payments on a process restart, so its proofs can restore a simulated payment after a restart (simulated money only).

## 12. Change evidence: zod 4 and the high-severity audit (ADR 0087), 2026-10-25

**Base:** `origin/claude/capabilities-overview-c6elxr` at `4685506` (the worktree was fast-forwarded to it; it was clean). **Database:** a private `bind_haiku_zod` (created for this run and dropped after; the shared `bind_local` was not used). **Node** 22.22.0, **npm** 10.9.4.

**Before the change:** `npm audit --audit-level=high` reported 4 high-severity findings, all for zod (GHSA-mrhx-c7xc-m3w5, zod before 4.6.6). Typecheck, lint and unit tests passed. Integration on the private database: 87 files passed and 1 skipped; 878 tests passed and 10 skipped.

| # | Check | Command | Observed | Class |
| :--- | :--- | :--- | :--- | :--- |
| Z1 | Clean install from the lockfile | `npm ci` | exit 0, 439 packages added | LOCAL_PASS |
| Z2 | High-severity audit (the gate) | `npm audit --audit-level=high` | exit 0, "found 0 vulnerabilities" | LOCAL_PASS |
| Z3 | Types, all three projects | `npm run typecheck` | exit 0 (root, `sdk/`, `mcp/`) | LOCAL_PASS |
| Z4 | Lint | `npm run lint` | exit 0 | LOCAL_PASS |
| Z5 | Unit tests | `npm run test:unit` | exit 0; 71 files, 944 tests passed (871 before, 73 new in `tests/unit/zod-4-migration.test.ts`) | LOCAL_PASS |
| Z6 | Integration, private database | `DATABASE_URL=…/bind_haiku_zod npx vitest run tests/integration/` | exit 0; 88 files passed, 1 skipped (as in the baseline); 881 tests passed, 10 skipped (3 new in `tests/integration/zod-4-error-fields.test.ts`) | LOCAL_PASS |
| Z7 | Error contract and API contract | included in Z6 (`error-contract`, `api-contract`) | passed | LOCAL_PASS |
| Z8 | Generated OpenAPI document | `npm run api:spec` | exit 0. Drift against HEAD: `docs/openapi.json`, 2 hunks, both the `contactEmail` schema (the old `not: {}` artifact removed) | LOCAL_PASS |
| Z9 | Generated SDK types | `npm run sdk:generate` | exit 0. Drift: `sdk/src/generated/api.d.ts`, 2 lines, `contactEmail` from `(unknown \| string) \| ""` to `string \| ""` | LOCAL_PASS |
| Z10 | Generated capabilities | `npm run capabilities:generate` | exit 0. No drift | LOCAL_PASS |
| Z11 | Production build | `npm run build` | exit 0 (`tsc` plus the SDK build) | LOCAL_PASS |
| Z12 | MCP build | `npm run mcp:build` | exit 0 | LOCAL_PASS |
| Z13 | Web bundle (Privy adapter) | `npm run web:bundle` | exit 0; `web/app/vendor/privy.js` 1,384,683 bytes | LOCAL_PASS |
| Z14 | Vercel build, step by step | `npm run build:vercel`; `npm run sdk:build`; `web:bundle`; copy `web/` and the brand assets into `public/`; `node scripts/copy-sdk-browser.mjs public/sdk`; `test -s public/app/vendor/privy.js` | every step exit 0. Run as separate commands because the sandbox would not run `scripts/vercel-build.sh` as one unit; the steps are the script's own commands in its order | LOCAL_PASS |
| Z15 | Browser (Playwright) tests | `npm run test:e2e` | Not run: Playwright browsers are not installed in worktrees | NOT_RUN |

**Differential checks (LOCAL_PASS).** The zod 3 side is HEAD's source, with `from "zod"` rewritten to the `zod/v3` subpath of the same zod 4 package, and was checked against real zod 3.25.76 for the sampled cases.
- **HTTP validation, all 96 registry routes:** 1,744 generated inputs (the sample body, missing and wrong-typed fields, unknown keys, scalars). Success and the `fields` the server answers with were compared. After the change, 10 inputs differ: 5 integers at or above 2^53 and 5 non-finite numbers (`1e400`). Both are the documented change in ADR 0087, decision 7. Before the `validationFields` fix there were 156 differing lines, most of them duplicated field names.
- **MCP tool validation text, all 17 tools:** 436 inputs. The text the MCP SDK would report matches zod 3 except 4 non-finite inputs.
- **Environment (`envSchema`), 31 cases:** same accept and refuse results, except `PORT=1e400` (accepted before, refused now). Other differences are default message wording at boot.
- **Advertised MCP input schemas (17 tools):** differ in two ways only (ADR 0087, decision 9).
- **`@privy-io/api-base` `APIError` schema:** identical results for six inputs under zod 3.25.76 and zod 4.6.7.
- **Email:** 41 samples, identical to zod 3 (in the unit test).
- **Offset date-time:** 21 samples, identical to zod 3 (in the unit test).

**Performance check that chose the engine (LOCAL_PASS).** An array of 2,000,000 strings against `.max(200)`: zod 4.6.5 (vulnerable) 45 ms and 16 MB; zod 4.6.7 native 1 ms and 0 MB; zod 4.6.7 `zod/v3` subpath 516 ms and 176 MB. The `zod/v3` path was therefore not used.

**Known risks and open items**
- **Privy override.** `@privy-io/api-base` is overridden to zod `^4.6.7`. Its declared range (`^3.25.76`) does not allow it, which is outside the rule we set for overrides. The reasons are in ADR 0087, decision 4. It has to be accepted by the owner, or reverted (which fails the audit gate again until privy releases zod 4 support).
- **Behaviour change, numbers.** Integers beyond ±(2^53 − 1) and non-finite numbers are refused with 400 and the field named (previously accepted). This is intended and recorded in ADR 0087, decision 7, but it is a change to the HTTP contract and needs the owner's acknowledgement.
- **MCP advertised schema** changes in two places (ADR 0087, decision 9).
- **Default message wording** for zod's own messages changed where we had no text. No HTTP response carries zod text.
- **Not run:** Playwright browser tests (Z15). One integration test file is skipped, as in the baseline.
- **Not verified live:** no live Arc, Privy or deployed environment was touched; this change is local only.
