---
name: bind-oneshot
description: Use for the full Bind build, large feature mission, repo-level implementation, or release preparation. Inspects ground truth, implements the complete vertical slice, runs and repairs all relevant gates, and produces evidence rather than a plan-only response.
---

# Bind One-Shot

1. Read `AGENTS.md`, `BIND_BUILD_SPEC.md`, `RUN_BIND_ONESHOT.md`, and `docs/TESTING_AND_RELEASE_GATES.md`.
2. Inspect git status, repository documentation, stack, scripts, contracts, integrations, and existing tests before editing.
3. Ground API usage in current docs and actual SDK source. Do not invent integrations.
4. Write the smallest necessary architecture decision, then implement the complete vertical slice.
5. Keep agent permissions and approvals enforced by deterministic application code.
6. Run every relevant gate, repair failures, add regression tests, and rerun affected suites.
7. Exercise the live UI in a browser; do not substitute a screenshot or successful build for UX QA.
8. Produce `docs/RELEASE_EVIDENCE.md` with exact commands/results and status labels.
9. Do not push, deploy, use production secrets, send real funds, or trigger live commercial commitments.

Do not stop after planning or scaffolding. Continue until the gates pass or a concrete external blocker is demonstrated.
