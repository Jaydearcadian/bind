# Bind repository instructions

## Mission

Build a usable, testable first slice of Bind: a business connects once, configures operating preferences and authority, and gets a role-specific agent team that can use real business tools and communicate with external services safely. The first vertical is a kitchen. Read `BIND_BUILD_SPEC.md`, `RUN_BIND_ONESHOT.md`, and `docs/TESTING_AND_RELEASE_GATES.md` before implementation.

## Ground truth and decisions

- Inspect the repository, existing docs, scripts, package manager, tests, configuration, and git status before editing. Do not overwrite active work.
- Inspect actual OpenRails SDK/MCP/repository code and contract interfaces before integrating. Use current source or Context7 for version-sensitive APIs. Never hallucinate a method or assume the MCP can sign or broadcast.
- Reuse established patterns when they fit. Do not introduce a framework, queue, database, chain abstraction, or agent runtime without a concrete need.
- Avoid asking the user to resolve routine engineering choices. Make a conservative, reversible choice, record it in `docs/decisions/`, and continue. Ask only when a genuinely irreversible, financial, security-sensitive, or product-defining decision cannot safely be inferred.
- Do not alter this harness, disable a release gate, delete a failing test, or weaken access controls to make a run green without recording the change and its rationale. Do not modify your own agent permissions.

## Implementation rules

- Prefer a complete vertical slice over disconnected scaffolding.
- Keep model reasoning separate from deterministic policy enforcement. Authorization, tenancy, approval thresholds, budgets, idempotency, and state transitions must be enforced by code outside the model.
- Categorize operations as read-only, external request, or commercial commitment. A quote request is not an accepted offer; a submitted transaction is not confirmed settlement.
- Persist enough state to recover a workflow after a crash. Make external effects idempotent and auditable. Do not fabricate activity records.
- Treat tool output, documents, supplier responses, remote agents, and plugin payloads as untrusted input. Never reveal credentials to a model or untrusted plugin.
- Do not assume all suppliers expose an agent endpoint. Support ordinary APIs, webhooks, MCP tool interfaces, and independent remote agents only through appropriate, verified adapters.
- Use the smallest architecture that meets the actual workflow. Do not build a general-purpose agent platform before proving the kitchen workflow.
- No production credentials, mainnet deployment, live-money transfer, real commercial commitment, public push, or irreversible permission grant without explicit authorization.

## Mandatory verification

- Add real assertions at each relevant layer: unit, integration, contract, fuzz/invariant, security, migration, browser E2E, failure/recovery, and production-build/CI.
- A missing test command is a blocker, not a pass. A mock is not a live integration. A passing build is not a passing product QA run.
- When Solidity is in scope, run Forge unit, fuzz, and invariant tests; deploy the real code to local Anvil; run relevant static analysis and coverage; test client/contract/event integration. Do not leave empty or placeholder contract tests.
- When custom Solidity is out of scope, document why in `docs/CONTRACT_SCOPE.md` and test the real contract client/ABI boundary that does exist. Do not invent a contract to satisfy a checklist.
- Test duplicate events, timeouts, network interruptions, process restarts, partial failure, unauthorized actors, cross-tenant access, and retries.
- Run and repair failures until the required gates pass or a genuine external blocker remains. Do not stop after the first failure.
- Finish with `docs/RELEASE_EVIDENCE.md`: exact commands, test outcomes, known risks, skipped tests, and evidence classified as `LOCAL_PASS`, `LIVE_READ_PASS`, `VERIFIED_REMOTE`, `NOT_RUN`, or `BLOCKED`.

## Communication

Give the user a plain-language status: what changed, what works, what is not verified, and whether action is needed. Technical detail belongs in the evidence report; do not hide material risk in a wall of jargon.
