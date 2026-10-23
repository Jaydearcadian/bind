# Bind testing and production-readiness gates

This document defines required evidence. Adapt command names to the repository's actual package manager, but do not remove a gate because the current stack lacks a command. Add the missing script or document a genuinely not-applicable boundary with a reason and tests for the actual boundary.

## 1. Baseline engineering gates

- Clean dependency install from a lockfile.
- Formatting, lint, strict type checking, compile/build, unit tests, integration tests, and clean-start smoke test.
- Database migration from an empty database and from the previous supported schema.
- CI must fail on any required gate failure; no empty test suites, swallowed errors, test-only production bypasses, or blanket skipped tests.
- Review compiler warnings, dependency vulnerabilities, secrets, and generated artifacts.

## 2. Contract gates when Solidity is in scope

Run against the actual Bind-owned contract code, not a placeholder.

### Forge / local Anvil

- Compilation and `forge fmt --check`.
- Unit tests for initialization, roles, permissions, business rules, events, revert conditions, boundary values, and all relevant state transitions.
- Fuzz tests for addresses, values, deadlines, IDs, and inputs; cover zero/max values, decimals, rounding, overflows, and invalid state combinations.
- Stateful invariant tests for accounting conservation, authorization, settlement finality, and lifecycle consistency.
- Adversarial tests for replay/nonces/signatures if used, reentrancy where reachable, external-call failures, callback assumptions, double execution, and denial-of-service surfaces.
- Deploy the real contract using the real local deployment script to Anvil. Assert bytecode, constructor/configuration values, role ownership, and deployed addresses.
- Call contracts through the same ABI/client used by the application. Verify emitted logs, decoded results, persisted event state, and reconciliation behavior.
- Run `forge coverage`, gas measurements or `forge snapshot` when relevant, and a Solidity static analyzer such as Slither or Aderyn. Resolve material warnings or document an exception with impact and evidence.
- Verify fresh local-chain deployment and repeatable initialization. Confirm wrong chain IDs and missing/wrong addresses fail safely.
- Test local token implementations when token behavior affects business logic. Do not assume a mock proves a third-party token's live behavior.

### Contract scope exception

If the architecture legitimately has no Bind-owned Solidity, `docs/CONTRACT_SCOPE.md` must identify this as an explicit decision, describe all external ABI/client/event boundaries, and list the corresponding integration tests. Mark the Forge suite `NOT_APPLICABLE` with that rationale. Never create meaningless contracts or claim contract-level verification from an empty `forge test` run. If any Bind-owned Solidity is later added, the Forge gate immediately becomes mandatory.

## 3. Backend/API/integration gates

- Unit tests for policy rules, effect classification, per-tenant authority, approval thresholds, lifecycle transitions, money/quantity calculations, routing, retries, and idempotency.
- API contract/schema validation and invalid-input handling.
- Real local integration tests for database transactions, queue/worker persistence, tool adapter calls, auth/session behavior, webhooks, and event processing.
- Test signed webhook validation, replay, duplicate delivery, reordered events, malformed payloads, rate limiting, timeouts, partial data, and upstream failures.
- Test a worker or app process terminating at every effectful transition; recovery must not create a duplicate order or payment.
- Test connection loss, RPC timeout, reverted transaction, unknown transaction outcome, and reconciliation where on-chain operations exist.
- Test external adapter responses as untrusted data. Never treat text returned by a tool as permission to override policy.

## 4. Permission, safety, and tenant gates

- Cross-tenant reads/writes; guessed or substituted object IDs; missing/expired roles; revoked authority; and service-to-service scope bypass.
- Read-only tool cannot write. `external_request` cannot silently become `commercial_commitment`.
- Approval required, accepted, rejected, expired, revoked, and repeated-approval cases.
- Budget/quantity/price thresholds, changed quotes, expired quote, supplier mismatch, duplicate request and concurrent order cases.
- Prompt injection in supplier descriptions, customer content, web pages, documents, and tool output. Confirm it cannot grant tools, leak secrets, bypass approval, or trigger an unauthorized commitment.
- Secrets never appear in model messages, client payloads, logs, activity evidence, source control, error traces, or plugin output.
- Credential scopes and rotation/revocation. Malicious, unavailable, or malformed plugin/remote-agent responses.

## 5. Browser and UX gates

Use Playwright as a project dependency and CI suite. Test the real running app, not just component render snapshots.

Required critical journeys:

1. Create a workspace and apply the kitchen template.
2. Inspect and change agent roles, tools, supplier preferences, budget, and approval authority.
3. Trigger an order/low-stock event and verify the inventory gap.
4. Request and receive a simulated supplier quote; label the simulator visibly.
5. Verify policy decision and approval pause when outside authority.
6. Approve/reject and confirm only the authorized effect is submitted, once.
7. Inspect activity evidence, status, external references, failures, and recovery.
8. Exercise cancellation, expiry, unavailable supplier, duplicate event, timeout, and retry.

Also verify mobile and desktop layouts, keyboard navigation, visible focus, semantic labels, form validation, loading/empty/error/stale/offline/permission states, browser console, failed requests, hydration, and broken navigation. Assert meaningful visible UI state and backend state. A screenshot alone is not a pass.

## 6. Reliability and operations

- Concurrent workflows, duplicate submissions, queue redelivery, worker restarts, and partial outages.
- Test graceful shutdown and resumption after restart.
- Health/readiness endpoints, structured logs, useful error identifiers, metrics for queue age/failures/retries, and secret redaction.
- Measure representative workflow latency and load; set budgets from actual measurements rather than invented pass targets.
- Verify database backup/restore and documented recovery when persistent local/remote data is in the release scope.
- Test rate limit handling, connection pool exhaustion behavior, memory/queue growth, slow queries, and bounded work.

## 7. Settlement and chain boundary

- Amount precision, token decimals, fees, rounding, allocation, balance/state invariants, idempotency, and double-submit prevention.
- Separate `requested`, `authorized`, `submitted`, `confirmed`, and `reconciled` states.
- Chain ID, contract/token address, insufficient gas/balance, reverted tx, RPC down, timeout with unknown outcome, duplicate event, and reorganization/confirmation behavior where the selected chain requires it.
- Run local EVM paths on Anvil with development keys only. CI must never send public-chain transactions or use real funds.
- For external contracts, verify client ABI and event behavior against the tested interface; distinguish local fixture/fork results from live-network checks.

## 8. Security / supply chain

- Type/lint/compiler gate; language-specific static analysis; dependency audit; secret scan; contract static analysis where relevant.
- Review unsafe endpoints, object-level authorization, injection, SSRF, unsafe parsing, CORS, cookies, session settings, rate limits, debug endpoints, and log redaction based on the actual implementation.
- Maintain an explicit threat model and residual risk list. Tool success or a clean scanner does not constitute a security audit.
- Pin tool/skill versions and commit `capabilities.lock`; review dependencies before adding an MCP server or plugin.

## 9. Production release gate

Before testnet:

- Reproducible build and lockfile install.
- All critical tests passing, coverage results attached, no unexplained skips.
- Local end-to-end business workflow passes against real local components and Anvil when relevant.
- Explicit deployment profile; chain ID/address checks; signer permissions; environment inventory; migration plan; verify/deploy script; smoke tests; logging/monitoring; and rollback or forward-recovery plan.
- No production credential in repository or model context. No live external write until explicitly authorized.
- Clearly state what remains unverified because credentials/network are not yet supplied.

## 10. Evidence classifications

- `LOCAL_PASS`: verified against local components, actual assertions and recorded command.
- `LIVE_READ_PASS`: verified against a live, read-only integration.
- `VERIFIED_REMOTE`: an actual remote mutation was completed and independently verified. Do not use this status without explicit authorization.
- `NOT_RUN`: no test has run.
- `BLOCKED`: execution was attempted or required, but an external blocker prevented verification.
- `FAILED`: the call ran, but its output did not match the expectation (for example a revert gate whose call succeeded,
  or a read that returned a different value). Added by Task 13b for `scripts/verify-live-arc.ts`. It is neither a pass nor a blocker.
  `FAILED` is a status of the live-check script's own output only. It is not an evidence class in `docs/RELEASE_EVIDENCE.md`,
  which uses the five classes above, and no row there is recorded as `FAILED`. (`tests/unit/docs-honesty.test.ts` enforces this.)
- `NOT_APPLICABLE`: a documented architectural reason makes a gate irrelevant; provide the substitute boundary test.

Never promote a simulator or mock to a live pass. Report exact commands, counts, coverage, known failures, and skipped tests in `docs/RELEASE_EVIDENCE.md`.
