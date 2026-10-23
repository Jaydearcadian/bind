# ADR 0046: Ecosystem audit round 1 and the capability catalogue

## Status
Accepted (2026-10-20). Builds on ADR 0034 (API contract), 0035 (events), 0036 (SDK), 0037 (MCP), 0041 (casing) and 0042 (model-driven MCP check).

## Context
The owner asked for the interface and ecosystem layer to be treated as a product: capability registry, exposure, response semantics, SDK, MCP, events, payments and compatibility. The interfaces already exist, so this round audited them before designing anything.

## Decision
- `docs/ecosystem/ECOSYSTEM_AUDIT.md` records the handoff, the capability map, the exposure decisions and 14 slop findings.
- `docs/ecosystem/exposure.json` classifies all 67 operations (exposure class, effect class, irreversible, economic, stability, flags, note).
- `docs/capabilities.json` is generated from the contract, the classification and the real SDK and MCP surfaces (`npm run capabilities:generate`). `tests/unit/capabilities-catalogue.test.ts` checks that it is current and that agents cannot reach owner decisions, credentials, configuration or internal operations.
- No payment protocol is built (D-4). The first external consumers are the owner's UI and agents (D-1).
- The next step is a written Response Model and Event Surface specification, before any code (D-5).

## Consequences
- Nothing in the API, SDK, MCP server or event stream changed. The new files are data, one generator, and one unit test.
- The classification is a reviewer's judgement. The tests check consistency, not correctness. Five assumptions are listed in the audit and need the owner's answer.
- Not verified: nothing was run against a live service, and no external developer has used any interface.
