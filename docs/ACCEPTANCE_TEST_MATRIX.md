# Bind acceptance test matrix

Rebuilt on 2026-10-20 (Task 14) from the real test files. Each row names the files that assert the behaviour and the class
of this run's evidence on commit `407533a` (see `docs/RELEASE_EVIDENCE.md`). A row with no test is `NOT_RUN` or `BLOCKED`,
never a pass. "Simulated" means the test runs against an in-memory supplier, a recorded-only notice emitter, the in-memory
settlement simulator, or the in-process EVM. None of these is a live check.

## Part A: test layers

| Layer | Required proof | Primary failure cases | Proving test files | Class |
|---|---|---|---|---|
| Business logic | Unit tests for workspace, agents, policy, effect classification, budgets, approvals, order states | Invalid input, limit boundary, unauthorized actor, wrong state | `tests/unit/commitment-gate.test.ts`, `tests/unit/policy-engine.test.ts`, `tests/unit/effect-classifier.test.ts`, `tests/unit/order-statuses.test.ts`, `tests/unit/kitchen-template.test.ts` | LOCAL_PASS |
| API/schema | Request/response contract tests and validation | Missing/extra fields, malformed payload, auth failure, schema drift | `tests/integration/api-contract.test.ts`, `tests/unit/openapi.test.ts`, `tests/integration/openapi-route.test.ts`, `tests/integration/untrusted-input.test.ts` | LOCAL_PASS |
| Persistence | Database integration and migration tests | Failed transaction, duplicate writes, old schema, cross-tenant query | `tests/integration/db-migrations.test.ts`, `tests/integration/schema-indexes.test.ts`, `tests/integration/three-way-match-migration.test.ts`, `tests/integration/supplier-payment-address-migration.test.ts`, `tests/integration/auth-tenancy.test.ts` | LOCAL_PASS |
| Queue/worker | Durable execution and recovery tests | Crash between steps, redelivery, concurrent worker, backoff exhausted | `tests/integration/crash-recovery.test.ts`, `tests/integration/worker.test.ts`, `tests/integration/worker-sweep.test.ts`, `tests/integration/order-submission-recovery.test.ts` | LOCAL_PASS |
| Tool adapters | Contract test per adapter and local integration test | Timeout, bad response, rate limit, revoked credential, prompt injection | `tests/unit/supplier-validation.test.ts`, `tests/integration/notification-effects.test.ts`, `tests/unit/no-value-moving-model-tools.test.ts` (no model-facing tool moves value; ADR 0085), `tests/integration/credentials.test.ts` | LOCAL_PASS (simulated suppliers and emitter; no Circle CLI code path remains) |
| Commercial authority | Negative tests proving no unauthorized effect can execute | Over-budget order, no approval, expired approval, changed quote, replay | `tests/integration/commitment-gate.test.ts`, `tests/integration/commitment-recheck.test.ts`, `tests/integration/approval-lifecycle.test.ts`, `tests/integration/approval-atomic.test.ts`, `tests/integration/reconcile-once.test.ts` | LOCAL_PASS |
| Smart contracts, in-process | Client, ABI, events and custom errors against the compiled contract | Wrong config, chain mismatch, reverts, reentrancy | `tests/unit/contract-artifact.test.ts`, `tests/integration/local-chain.test.ts`, `tests/integration/arc-settlement-evm.test.ts`, `tests/integration/arc-find-transfer.test.ts`, `tests/integration/bind-settlement-properties.test.ts`, `tests/integration/bind-settlement-reentrancy.test.ts` | LOCAL_PASS (in-process EVM, not Anvil) |
| Smart contracts, Forge | Unit, fuzz, invariant and reentrancy tests in Solidity | Access-control bypass, replay, double settlement, wrong config | `contracts/test/BindSettlement.t.sol`, `contracts/test/BindSettlement.invariant.t.sol`, `contracts/test/BindSettlement.reentrancy.t.sol` | LOCAL_PASS (Forge 1.5.1, 2026-10-20: 24 of 24; branch coverage 72.73%) |
| Smart contracts, Anvil | Deployment of the real artifact to a local node, and the client against it | Wrong chain, wrong config, deployment failure | `tests/integration/anvil-settlement.test.ts` (10 original tests plus 6 `[arc-anvil]` tests, skipped without `ANVIL_RPC_URL`) | LOCAL_PASS (local arc-anvil, 16 of 16, 2026-10-25; the 10 of 10 result is 2026-10-20 on plain Anvil, see ADR 0088) |
| Events/reconciliation | Event and state reconciliation tests | Duplicate/out-of-order logs, reverted/unknown tx, incorrect external reference | `tests/integration/events.test.ts`, `tests/integration/events-shutdown.test.ts`, `tests/unit/events.test.ts`, `tests/integration/settlement-confirmation.test.ts`, `tests/integration/settlement-lost-claim.test.ts` | LOCAL_PASS |
| Browser E2E | Playwright journeys on the running app with UI and backend assertions | Broken onboarding, wrong status, missing approval, duplicate order, hidden failure | `tests/e2e/dashboard.spec.ts` (tests the orphaned UI; run only through `npm run test:e2e:legacy`) | NOT_RUN (`test:e2e` is BLOCKED; the UI is orphaned, ADR 0016) |
| Security/privacy | Dependency/secret scans, static analysis, auth and tenant isolation tests | Secret leakage, SSRF/injection where relevant, object ID substitution, unsafe debug endpoint | `tests/integration/auth-tenancy.test.ts`, `tests/integration/webhook-auth.test.ts`, `tests/unit/redaction.test.ts`, `tests/unit/redact-secrets.test.ts`, `tests/integration/error-echo.test.ts`, `tests/integration/route-failure.test.ts`; `npm audit` (LIVE_READ_PASS: a read of npm's advisory database); Slither (LOCAL_PASS, no medium or high findings) | LOCAL_PASS, with the exceptions named |
| Reliability | Restart, retry, fault injection and realistic load smoke | DB/RPC down, worker termination, backlog, pool exhaustion, unbounded work | `tests/integration/shutdown.test.ts`, `tests/integration/migration-lock.test.ts`, `tests/integration/rate-limit.test.ts`, `tests/integration/ops.test.ts`. Backup and restore (RUNBOOK section 13) and load tests: no test | LOCAL_PASS for the listed files; NOT_RUN for backup, restore and load |
| Production readiness | Reproducible clean install/build, CI parity, deployment dry-run, runbook | Missing env config, wrong chain ID, absent recovery instructions, unverified integration | `npm run build` and the drift checks (this run); `docs/RUNBOOK.md`. CI has never executed; no deployment dry-run exists | LOCAL_PASS for build and drift; NOT_RUN for CI and deployment |

Automated local tests do not establish live remote functionality. A row above is `LOCAL_PASS` when its files passed here.

## Part B: BIND_BUILD_SPEC.md requirements

Requirement IDs are added here for reference. Quotes are paraphrased from `BIND_BUILD_SPEC.md`.

### Vertical slice

| ID | Requirement | Proving test files | Class | What is simulated or not verified |
|---|---|---|---|---|
| V1 | Procurement reads stock, detects replenishment needs | `tests/unit/replenishmentTools.test.ts`, `tests/integration/workflow-orchestrator.test.ts`, `tests/integration/replenish-key.test.ts` | LOCAL_PASS | Stock is local PostgreSQL data |
| V2 | Procurement finds suppliers through configured adapters and requests quotes | `tests/integration/workflow-orchestrator.test.ts`, `tests/unit/supplier-validation.test.ts` | LOCAL_PASS | Suppliers are simulated (`SIMULATED_SUPPLIER_ADAPTER`); no live supplier |
| V3 | Procurement compares quotes with budget and submits only when authority permits | `tests/unit/commitment-gate.test.ts`, `tests/integration/commitment-gate.test.ts`, `tests/integration/commitment-recheck.test.ts` | LOCAL_PASS | As V2 |
| V4 | Customer and fulfilment agent records orders and keeps the owner informed | `tests/integration/customer-fulfilment.test.ts`, `tests/integration/customer-fulfilment-effects.test.ts` | LOCAL_PASS | The owner notice is recorded by a simulated emitter, not delivered |
| V5 | It never promises availability or dates the system cannot substantiate | `tests/unit/fulfilment-promise.test.ts`, `tests/integration/customer-fulfilment.test.ts` (concurrent orders cannot oversell; concurrent orders cannot overbook a slot) | LOCAL_PASS | None beyond the local data |
| V6 | Menu and feedback agent summarises feedback and proposes changes | `tests/integration/menu-feedback.test.ts`, `tests/unit/feedback-summary.test.ts` | LOCAL_PASS | No model wording; term counts only |
| V7 | Menu agent cannot publish without authority | `tests/integration/menu-feedback.test.ts` ("the menu agent role cannot publish even if its text asks to"; "a menu change cannot be published without an owner approval") | LOCAL_PASS | None |
| V8 | Order or low-stock event leads to one authorized order, fulfilment state and an owner-facing history | `tests/integration/workflow-orchestrator.test.ts`, `tests/integration/worker-sweep.test.ts`, `tests/integration/needs-attention.test.ts`, `tests/integration/events.test.ts` | LOCAL_PASS | Simulated supplier; the restock sweep is off by default |

### Required user capabilities

| ID | Requirement | Proving test files | Class | What is simulated or not verified |
|---|---|---|---|---|
| U1 | Create a workspace and apply the kitchen template | `tests/integration/studio-flows.test.ts` (Flow A), `tests/unit/kitchen-template.test.ts` | LOCAL_PASS | API only; the UI flow is NOT_RUN |
| U2 | Inspect and configure each role, its tools, effects, budget and approvals | `tests/integration/studio-flows.test.ts` (Flow B: a forbidden tool such as `transfer_usdc` is refused), `tests/integration/policy-types.test.ts`, `tests/integration/auth-tenancy.test.ts` | LOCAL_PASS | API only |
| U3 | Connect tools with server-side credential storage; secrets never reach the browser, model or plugins | `tests/integration/credentials.test.ts`, `tests/unit/credential-crypto.test.ts`, `tests/unit/redaction.test.ts`, `tests/integration/mcp.test.ts` (no credential tools) | LOCAL_PASS | No live connector; every credential reads `configured_unverified`; the browser side is NOT_RUN |
| U4 | See state, evidence, tool calls, approvals, failures, retries and the next action | `tests/integration/needs-attention.test.ts`, `tests/integration/events.test.ts`, `tests/integration/workflow-cancel.test.ts` | LOCAL_PASS | API only. The UI view is NOT_RUN |
| U5 | Approve, reject, expire or revoke a pending operation | `tests/integration/approval-lifecycle.test.ts`, `tests/integration/approval-atomic.test.ts`, `tests/integration/worker.test.ts` ("an untouched approval expires without anyone reading the list") | LOCAL_PASS | None |
| U6 | Recover a failed workflow without duplicated orders, accounting effects or payments | `tests/integration/crash-recovery.test.ts`, `tests/integration/order-submission-recovery.test.ts`, `tests/integration/reconcile-once.test.ts`, `tests/integration/settlement-effects.test.ts`, `tests/integration/journal-idempotency.test.ts`, `tests/integration/worker.test.ts` | LOCAL_PASS | A crash is simulated by leaving the persisted state a crash would leave, not by killing a process mid-effect. The simulated supplier's in-memory state is lost on restart (RUNBOOK section 7.4) |
| U7 | Distinguish a simulated connector from a verified live one | `tests/integration/credentials.test.ts` (`configured_unverified`), `tests/unit/socialSurface.test.ts`, `tests/integration/arc-settlement-evm.test.ts` (labels and no invented hashes) | LOCAL_PASS | The UI label check is NOT_RUN |

### Integration boundaries

| ID | Requirement | Proving test files | Class | What is simulated or not verified |
|---|---|---|---|---|
| B1 | REST/OpenAPI and signed webhooks for ordinary services | `tests/integration/api-contract.test.ts`, `tests/unit/openapi.test.ts`, `tests/integration/webhook-auth.test.ts`, `tests/integration/webhook-receiver.test.ts`, `tests/unit/webhook-signing.test.ts` | LOCAL_PASS | Bind's own webhook format only. Provider webhooks are not implemented |
| B2 | MCP for tool servers | `tests/unit/mcp.test.ts`, `tests/integration/mcp.test.ts` | LOCAL_PASS | Driven by the SDK's client over an in-memory transport and stdio. No real model client |
| B3 | A2A or another protocol for independent remote agents | none | NOT_RUN | Not built. No adapter, no test |
| B4 | OpenRails only where its SDK provides a supported path | none (no reference to OpenRails in `src/`, `sdk/`, `mcp/` or `tests/`) | NOT_RUN | Not integrated |
| B5 | Connector, tool, skill and remote agent kept distinct | none | NOT_RUN | A design rule. No test names it |

### Effect and authority model

| ID | Requirement | Proving test files | Class | What is simulated or not verified |
|---|---|---|---|---|
| E1 | Every tool declares one of three effect classes; policy checks membership, identity, grants, limits, approval, expiry and idempotency | `tests/unit/effect-classifier.test.ts`, `tests/unit/effect-classifier-fail-closed.test.ts`, `tests/unit/effects-operation-map.test.ts`, `tests/unit/commitment-gate.test.ts`, `tests/integration/untrusted-input.test.ts` | LOCAL_PASS | None |
| E2 | Explicit states; a request, a quote, an acceptance and a confirmed effect are not collapsed | `tests/unit/order-statuses.test.ts`, `tests/integration/settlement-confirmation.test.ts`, `tests/integration/workflow-orchestrator.test.ts` | LOCAL_PASS | None |
| E3 | Model output cannot grant authority | `tests/integration/untrusted-input.test.ts`, `tests/integration/menu-feedback.test.ts` ("the menu agent role cannot publish even if its text asks to"), `tests/unit/replenishmentTools.test.ts` | LOCAL_PASS (deterministic tools called directly) | No live model was run |

### Local-first target

| ID | Requirement | Proving test files | Class | What is simulated or not verified |
|---|---|---|---|---|
| L1 | Run the application and its dependencies locally | `tests/integration/*` (the whole suite, this run); the built-server smoke run (`docs/RELEASE_EVIDENCE.md` section 4) | LOCAL_PASS | Local PostgreSQL 16.15 |
| L2 | Run EVM code against Anvil with local-only funded accounts | `tests/integration/anvil-settlement.test.ts` | LOCAL_PASS | Local arc-anvil (Arc mode), chain 31337: 16 of 16 on 2026-10-25 (10 original plus 6 Arc tests). The 10 of 10 result is 2026-10-20, plain Anvil. CI runs plain Anvil, so the Arc block is NOT RUN there. Not live Arc (ADR 0088) |
| L3 | Durable workflow state in local PostgreSQL | `tests/integration/db-migrations.test.ts`, `tests/integration/migration-lock.test.ts` | LOCAL_PASS | None |
| L4 | Chain ID, addresses and credentials come from the environment; mismatches fail | `tests/integration/arc-settlement-evm.test.ts` ("a chain id mismatch is refused"; a missing `BIND_SETTLEMENT_ADDRESS` is refused, naming the variable), `tests/unit/database-url-config.test.ts` | LOCAL_PASS (in-process EVM) | No live chain was contacted |
| L5 | Local or simulated settlement by default; testnet or mainnet only when explicitly configured | `tests/unit/local-settlement-sim.test.ts`, `tests/integration/arc-settlement-evm.test.ts` | LOCAL_PASS | The default is the simulator, verified by code reading and these tests. No mainnet path exists |
| L6 | No testnet credentials needed for unit, integration, contract, browser or local suites | the whole unit and integration run, with `.env.local` moved aside | LOCAL_PASS | The browser suite is not part of this check (BLOCKED) |

### Data and auditability

| ID | Requirement | Proving test files | Class | What is simulated or not verified |
|---|---|---|---|---|
| A1 | Record workflow identity, actor, trigger, decision, tool, evidence, approval provenance, external reference, retries and timestamps | `tests/integration/audit-actors.test.ts`, `tests/integration/events.test.ts`, `tests/integration/effects-ledger.test.ts`, `tests/integration/approval-lifecycle.test.ts` | LOCAL_PASS | None |
| A2 | Redact secrets; keep raw sensitive payloads out of logs | `tests/unit/redaction.test.ts`, `tests/unit/redact-secrets.test.ts`, `tests/unit/logger.test.ts`, `tests/integration/error-echo.test.ts`, `tests/integration/ops.test.ts` | LOCAL_PASS | None |

### Product quality (the owner interface)

| ID | Requirement | Proving test files | Class | What is simulated or not verified |
|---|---|---|---|---|
| Q1 | Owner's work first; loading, empty, error, stale, offline and recovery states | `tests/e2e/dashboard.spec.ts` (old UI) | NOT_RUN | The UI is orphaned (ADR 0016). No new UI exists |
| Q2 | Mobile and desktop layouts, keyboard, focus, semantic labels | none that run | NOT_RUN | The UI is orphaned |
| Q3 | Owner-facing activity history | `tests/integration/events.test.ts`, `tests/integration/needs-attention.test.ts` (API only) | LOCAL_PASS | No UI |

## Gaps

- No test runs a live supplier, messaging, accounting, model or Arc call. Those are NOT_RUN by design until credentials exist.
- The Anvil and Forge suites ran locally once (2026-10-20), not in CI.
- Browser E2E is NOT_RUN for the owner interface, because there is none.
- Backup and restore, and load, have no test in this repository.
