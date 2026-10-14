---
name: bind-testing-gates
description: Use whenever implementing contracts, workflows, integrations, permissions, persistence, releases, or reporting test status for Bind. Prevents false passes and requires evidence-backed repairs.
---

# Bind Testing Gates

- Read `docs/TESTING_AND_RELEASE_GATES.md` before designing or running tests.
- Inspect existing tests and commands first; retain conventions but close missing coverage.
- Add meaningful assertions for success, invalid inputs, authorization denial, retries, duplication, concurrent requests, partial failure, and recovery.
- For Solidity, use Forge unit/fuzz/invariant tests, access-control and revert checks, deployment validation, event/client integration, coverage, and relevant static analysis.
- Deploy the real contract code to Anvil; never add empty contracts or meaningless tests only to satisfy CI.
- Test every actual API/adapter boundary. Keep mocked, simulated, local-chain, read-only live, and verified remote evidence separate.
- Missing suites or scripts are blockers. Never skip or weaken a failing test merely to obtain a green result.
- On failure: diagnose, fix the defect, add a regression test, rerun the failed suite and related regressions.
- Include exact commands, results, coverage, unresolved risks, and skipped tests in `docs/RELEASE_EVIDENCE.md`.
