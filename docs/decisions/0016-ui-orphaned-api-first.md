# ADR 0016: The current UI is orphaned; the build is API first

## Status
Accepted (2026-10-19), by the owner's direct instruction.

## Context
The owner will rebuild the UI from the ground up, later. The existing UI under `src/ui/public` is not
to be touched. It also still contains hard-coded claims (a sample settlement hash and the label
`SETTLED_ON_ARC_TESTNET`) that the backend no longer makes.

## Decision
1. No task edits `src/ui/`. The files stay as they are and are served as before, but they are unsupported.
   Nothing in the backend may depend on them, and nothing may be changed to keep them working.
2. The product surface for the rebuild is the backend itself: HTTP API, an event stream (SSE), a typed
   client SDK, and an MCP server. These are built as the deliverable (Task 12b in the plan) so the new UI,
   agents and tools all use the same contract.
3. Task 6 (authentication) no longer adds a token wrapper to the UI. Once the API requires a token, the
   legacy browser tests in `tests/e2e/` that drive the old UI cannot pass and are not repaired. They move
   behind a separate script `npm run test:e2e:legacy` (not part of the release gate), and the release
   evidence reports browser E2E for the new UI as `NOT_RUN` until the rebuild ships. This is a recorded
   change to a gate, not a silent one. Meanwhile the same flows are covered by HTTP-level integration
   tests, which are the real gate for behaviour.
4. Hard-coded UI claims are not fixed; they disappear with the rebuild. They are listed in the release
   evidence as known false text in an unsupported UI.

## Consequences
- The e2e count falls out of the release gate until the new UI exists. That is a coverage gap and is said so.
- API stability matters more: every endpoint needs a schema, an error shape and tests, because the new UI
  is built on it with no old UI to lean on.
- Reversible: the legacy script can be promoted back to a gate if the old UI is kept.
