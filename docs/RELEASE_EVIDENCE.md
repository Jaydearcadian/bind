# Bind release evidence

Rebuilt on 2026-10-20 (Task 14) from the command runs listed below. It replaces the earlier version. The claims in that version
that this task did not reproduce are kept, labelled, in the appendix at the end, and are not to be relied on.

**Commit the gates ran on:** `407533ac09f7121806836e25db4834be5c91c412` (HEAD of `claude/capabilities-overview-c6elxr` before the
commit that adds this document; the working tree was clean at that commit).

## Header

| Item | Value |
| --- | --- |
| Date (UTC) | 2026-10-20. Gate batch 10:17:57 to 10:30:05. Smoke run 10:30:49 to 10:30:50. |
| Branch | `claude/capabilities-overview-c6elxr` |
| Container | Linux 6.18.44-fc-v139, x86_64 |
| Node | v22.22.0 (npm 10.9.4). CI pins Node 24 (`.github/workflows/quality-gates.yml`) and this run did not use it. |
| PostgreSQL | 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1) on 127.0.0.1:5432, database `bind_local`. CI pins PostgreSQL 17. |
| Not available here | Foundry (`forge`), Anvil, Slither, `cast`; model keys (`NEBIUS_API_KEY`); search keys (`PARALLEL_API_KEY`, `TAVILY_API_KEY`); live supplier, messaging, accounting and payment connectors; an Arc RPC token; GitHub Actions. |
| Outbound network | Only the npm registry, through the configured proxy, was reached (by `npm audit`). No live supplier, chain, messaging or hosting endpoint was contacted by any step. |
| Clean-checkout condition | `.env.local` was moved aside for the whole gate batch and for the smoke run, and restored afterwards (the file is untracked and gitignored). |

## 1. Summary

- **Passes locally, on `407533a`:** lint, typecheck, the unit suite (340 tests), the integration suite (535 tests, run twice with
  the same result), the production, SDK and MCP builds, the API, SDK and map drift checks, the in-process contract suite (32 tests),
  and a smoke run of the built server. The dependency audit reports no high-severity findings.
- **What those passes cover:** a local PostgreSQL database; a simulated supplier; owner notices that are recorded but not delivered;
  a settlement simulator in memory; and the settlement contract run in an in-process EVM. None of these is a live check.
- **Not verified:** any live Arc read or transaction; the contract deployment and transactions named in earlier notes; Forge,
  Anvil and Slither (BLOCKED here); the browser suite (BLOCKED: the UI is orphaned); CI (BLOCKED: dispatched once, no runner); the hosted deployment.
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
| Forge format, build, unit, fuzz, invariant, coverage | `forge fmt --check`, `forge build`, `forge test -vvv`, `forge coverage` in `contracts/` | not run: `forge` is not installed | BLOCKED |
| Anvil deployment and client suite | `ANVIL_RPC_URL=<node> npx vitest run tests/integration/anvil-settlement.test.ts` | not run: `anvil` is not installed. Without `ANVIL_RPC_URL` the file's 10 tests are skipped. | BLOCKED |
| Slither | `slither .` in `contracts/` | not run: not installed | BLOCKED |
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
PASS=12 FAIL_OR_BLOCKED=3 NOT_RUN_ACCEPTED=1
PASS: lint, typecheck, unit, integration, contract in-process suite, build, sdk:build, mcp:build, audit,
      spec drift, sdk drift, map drift
BLOCKED: forge not installed (forge fmt --check, forge build, forge test -vvv, forge coverage)
BLOCKED: anvil not installed (anvil integration)
BLOCKED: slither not installed (slither (unverified invocation))
NOT_RUN accepted by BIND_ACCEPT_NOT_RUN: test:e2e (UI orphaned, ADR 0016)
```

The runner also ran the unit suite a second time and the integration suite a third time; both passed with the counts above. The three BLOCKED lines
make the runner exit 1 here, which is the intended result: a missing tool is never a pass.

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
| Settlement against Anvil | BLOCKED | `tests/integration/anvil-settlement.test.ts` (10 tests, skipped) | `anvil` is not installed. |
| Crash recovery and worker | LOCAL_PASS | `tests/integration/crash-recovery.test.ts`, `tests/integration/worker.test.ts`, `tests/integration/worker-sweep.test.ts`, `tests/integration/needs-attention.test.ts`, `tests/integration/workflow-cancel.test.ts`, `tests/integration/shutdown.test.ts`, `tests/integration/migration-lock.test.ts` | A crash is simulated by leaving the state a crash would leave. No test kills a process in the middle of an effect. The worker runs only in the server process. |
| Auth and tenancy | LOCAL_PASS | `tests/integration/auth-tenancy.test.ts`, `tests/integration/audit-actors.test.ts`, `tests/unit/tokens.test.ts`, `tests/integration/error-echo.test.ts`, `tests/integration/untrusted-input.test.ts` | The owner is identified by a token label, not a person (ADR 0021). |
| Webhooks and surface identity | LOCAL_PASS | `tests/integration/webhook-auth.test.ts`, `tests/integration/webhook-receiver.test.ts`, `tests/unit/webhook-signing.test.ts`, `tests/integration/surface-pause.test.ts`, `tests/unit/socialSurface.test.ts`, `tests/integration/notification-recipients.test.ts` | Bind's own signed format only. No WhatsApp, email, Telegram or POS connector. |
| Credentials store | LOCAL_PASS | `tests/integration/credentials.test.ts`, `tests/unit/credential-crypto.test.ts`, `tests/unit/redaction.test.ts`, `tests/unit/redact-secrets.test.ts` | No live verifier: every credential reads `configured_unverified`. |
| Customer orders | LOCAL_PASS | `tests/integration/customer-fulfilment.test.ts`, `tests/integration/customer-fulfilment-effects.test.ts`, `tests/unit/fulfilment-promise.test.ts`, `tests/unit/customer-order-link.test.ts` | No customer messages, prices or payments. |
| Menu and feedback | LOCAL_PASS | `tests/integration/menu-feedback.test.ts`, `tests/unit/feedback-summary.test.ts` | Term counts only. No model wording. |
| API contract, event stream, SDK, MCP | LOCAL_PASS | `tests/integration/api-contract.test.ts`, `tests/unit/openapi.test.ts`, `tests/integration/openapi-route.test.ts`, `tests/integration/events.test.ts`, `tests/integration/events-shutdown.test.ts`, `tests/unit/events.test.ts`, `tests/integration/sdk.test.ts`, `tests/unit/sdk.test.ts`, `tests/unit/sdk-sse.test.ts`, `tests/unit/sdk-stream.test.ts`, `tests/integration/mcp.test.ts`, `tests/unit/mcp.test.ts` | MCP is driven by the SDK client over an in-memory transport and over stdio. No real model client. |
| Observability and rate limits | LOCAL_PASS | `tests/integration/ops.test.ts`, `tests/unit/logger.test.ts`, `tests/unit/metrics.test.ts`, `tests/integration/rate-limit.test.ts`, `tests/unit/rate-limit.test.ts`, `tests/integration/route-failure.test.ts` | Limits and metrics are per process, in memory. |
| Contract tests, in-process | LOCAL_PASS | `tests/unit/contract-artifact.test.ts`, `tests/unit/helper-artifacts.test.ts`, `tests/unit/arc-contract-boundary.test.ts`, `tests/integration/bind-settlement-properties.test.ts`, `tests/integration/bind-settlement-reentrancy.test.ts`, `tests/integration/local-chain.test.ts` | In-process EVM. The property tests are not Forge invariant tests and are not a proof. |
| Contract tests, Forge (unit, fuzz, invariant, reentrancy) | NOT_RUN | `contracts/test/BindSettlement.t.sol` (10 functions), `contracts/test/BindSettlement.invariant.t.sol` (6 invariants), `contracts/test/BindSettlement.reentrancy.t.sol` (8 functions) | Written and compile-checked with solc-js. Never run by `forge`. |
| Contract tests, Anvil | BLOCKED | `tests/integration/anvil-settlement.test.ts` | `anvil` not installed. |
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
- **Forge, Anvil, Slither.** BLOCKED. Their suites are listed in section 5.
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
| The contract's and the adapter's tests run in-process. The Anvil and Forge suites have never run. | section 3; ADR 0038 | Install Foundry and Anvil, then run them. |
| The restock sweep starts replenishments on its own, within policy, when `BIND_RESTOCK_SWEEP=true`. It is off by default. | RUNBOOK 6.2; ADR 0030 | Leave it off unless deliberately enabled. |

## 8. Skipped tests

- **`tests/integration/anvil-settlement.test.ts`**: `describe.skipIf(!ANVIL_RPC_URL)`. Its 10 `[anvil]` tests were reported as
  skipped in both integration runs and in the runner's run. The integration gate exits 0 with them skipped, because a skip is not a
  failure. Do not read "535 passed" as covering Anvil.
- **`tests/e2e/dashboard.spec.ts`**: 4 tests in two Playwright projects (8 runs). Not run: the UI is orphaned (BLOCKED or NOT_RUN).
- **Solidity tests** in `contracts/test/`: 10 unit or fuzz functions, 6 invariants and 8 reentrancy functions. Not run (no `forge`).
- **CI jobs** in `.github/workflows/quality-gates.yml`. Never executed.
- **Searches for other skips.** `it.skip`, `describe.skip`, `test.skip`, `xit`, `xdescribe`, `it.todo`, `test.todo`, `.only`
  (in `tests/` and `contracts/test/`): none found. The only conditional skip is the Anvil file above.

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
