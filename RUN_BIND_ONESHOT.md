# One-shot mission: build Bind locally, verify it, prepare testnet migration

Operate as the accountable implementation lead. Work through the full task now. Do not return only a plan, PRD, scaffold, screenshot, or demo. Read `AGENTS.md`, `BIND_BUILD_SPEC.md`, and `docs/TESTING_AND_RELEASE_GATES.md` first.

## Operating mode

- Inspect the live repository, git status, package files, scripts, existing docs, integrations, and CI before choosing an architecture. Preserve uncommitted user work.
- If the repository is empty, choose a minimal production-shaped TypeScript web application and backend, PostgreSQL for durable state, an appropriate agent/tool interface, and Foundry only for justified EVM contracts. If a repository already has a stack, reuse it unless a concrete blocker proves that impossible.
- Consult current documentation through Context7 for framework, library, SDK, and chain-specific API details. Read the actual OpenRails SDK/MCP and any referenced contracts before integrating. If access or evidence is missing, mark it as unverified instead of fabricating a method.
- Make routine, reversible decisions yourself and write short ADRs. Do not interrupt the user for ordinary implementation questions.
- Work on the dedicated feature branch. Parallelize independent work only when boundaries are clear. Integrate and test the combined application. Do not push, deploy, or merge to the protected default branch.
- No production secrets, public testnet actions, real-money operations, or external commercial commitments during the local build.

## Execution waves

### Wave 1: ground truth and runnable plan

1. Inspect the repository and linked system boundaries.
2. Write a short `docs/decisions/0001-build-boundaries.md` documenting the selected stack, what Bind owns, what it integrates, whether Bind-owned Solidity is justified, and any actual constraints.
3. Write `docs/CONTRACT_SCOPE.md`. If contracts are in scope, name their responsibilities and attack surfaces. If not, justify why and identify the actual ABI/client/event boundary that will be tested. Do not manufacture a contract to satisfy a test gate.
4. Define acceptance tests before implementation. Keep the plan executable, not a speculative catalogue of features.

### Wave 2: complete vertical slice

Implement the kitchen workspace template and three agent roles from `BIND_BUILD_SPEC.md`. Include onboarding, business preferences, scoped tools, deterministic authority/approval enforcement, stateful workflow orchestration, recoverable execution, supplier quote/order flow, owner activity/evidence, and useful failure states.

Use a locally runnable supplier simulator if no external service is available. Clearly label its status throughout configuration and UI. Keep the adapter interface production-shaped so live service integration can be added without pretending it has already been tested.

Make every commercial commitment require a verified policy decision and the correct approval path. Enforce tenant separation server-side. Add idempotency at event ingestion and effect submission. Persist recoverable state.

### Wave 3: contracts and external boundaries

If Bind-owned contracts are required, implement actual domain behavior, deployment scripts, and contract tests. Run Forge unit, fuzz, invariant, and coverage tests; run static analysis; deploy the real code to Anvil; verify app/ABI/event integration. If existing external contracts are consumed, test ABI encoding, receipt/log parsing, chain mismatch, revert, timeout, duplicate submission, and reconciliation with realistic local fixtures or a controlled fork when available.

Do not create fake successful remote settlement. The local profile must prevent public-network calls and real transfers by default.

### Wave 4: exhaustive verification and repair

Add and execute, where relevant:

- lint, type check, build, unit, integration, migration, and API contract tests;
- Foundry unit/fuzz/invariant/revert/access-control/event tests, gas/coverage reporting, and security analysis;
- authorization, cross-tenant, prompt-injection, malformed tool result, secret leakage, and credential-scope tests;
- browser E2E for onboarding, provisioning, approvals, quote/order workflow, activity evidence, and failure recovery;
- idempotency, concurrency, worker restart, queue recovery, partial failure, timeout, retries, and reconciliation tests;
- dependency/secret scanning and configuration validation;
- performance smoke and operational readiness checks for health, logs, metrics, and recovery;
- clean checkout and repeatable local startup.

Tests must assert real outcomes. A mocked test must be labelled as such and may not be described as a live integration. Missing mandatory scripts or test suites are blockers, not passes. Never weaken a test or disable a quality gate just to obtain a green result.

Use `scripts/preflight.sh` to inventory dependencies and `scripts/verify-local.sh` to run the configured local gates. If their script names do not match the repo's actual package manager, adapt the scripts while preserving all gates.

### Wave 5: UI quality and final human review

Use StyleSeed/Frontend Design guidance without blindly enforcing a numeric score as proof of quality. Run the actual UI in a browser, execute Playwright E2E tests, inspect representative screens at mobile and desktop sizes, and fix real defects. Review diffs and important configuration/test files with `revdiff` if available; otherwise do an equivalent explicit diff review.

### Wave 6: testnet preparation, not live deployment

Prepare the chain profile, environment variable inventory, RPC/signer requirements, deployment script, expected addresses/roles, contract verification steps, health checks, smoke-test commands, monitoring notes, and rollback/forward-recovery steps. Add validation preventing wrong-chain use and dangerous default profiles. Do not send a public transaction or deploy remotely without explicit authorization.

## Acceptance gates

The mission is not complete until:

1. the project starts from documented clean-local setup;
2. the entire kitchen flow passes end to end against local services and Anvil where contracts are in scope;
3. the relevant unit, integration, contract, security, migration, failure/recovery, and browser tests pass;
4. local authority boundaries and tenant isolation are proven by negative tests;
5. there are no known critical/high exploitable issues left undisclosed;
6. CI runs the same essential gates;
7. `docs/RELEASE_EVIDENCE.md` contains exact commands and results, code/test coverage where available, known issues, skipped gates, and an honest status classification for each major capability.

If a test fails, find the cause, fix it, add regression coverage, and rerun the affected suite plus relevant regressions. Continue until gates pass or a specific external blocker prevents a live-only check. Do not call an external blocker a code pass.

## Final output

Deliver the working changes plus:

- local startup and test commands;
- a clear inventory of what is implemented and what is only simulated;
- actual test commands, pass/fail counts, coverage, and scan output;
- unresolved bugs and residual risks;
- `LOCAL_PASS`, `LIVE_READ_PASS`, `VERIFIED_REMOTE`, `NOT_RUN`, or `BLOCKED` for each major claim;
- testnet migration checklist naming precisely which credentials/configuration remain and what cannot be confirmed until they are available.

A successful local build does not mean only credentials remain. State any outstanding deployment, verification, integration, funding, chain configuration, operational, or approval work accurately.
