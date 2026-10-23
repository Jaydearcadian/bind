# ADR 0041: API field casing is frozen as it is; new fields are camelCase

## Status
Accepted (2026-10-20). Builds on ADR 0034 (API contract, section 3). Nothing in the API, SDK or MCP server changes.

## Context
Before a UI is built on the SDK, the casing question had to be settled. The question was put as "snake_case or camelCase", with a
recommendation to keep snake_case. That framing was wrong: ADR 0034 already records that the API is mixed. Rows read with
`SELECT *` are snake_case (inventory, suppliers, surfaces, approvals, workflows, orders, documents, ledger, audit). Service views
are camelCase (customer orders, feedback, menu, tokens, connectors, needs-attention, approval decisions). The MCP result envelope
is camelCase. So there is no single casing to keep.

## Decision
1. **No rename now.** Every existing field keeps its casing. A rename would break the SDK, the MCP server, a hundred assertions and
   any client, for no behaviour gain, and no UI exists yet to benefit.
2. **New fields and new endpoints use camelCase.** The service views and the MCP envelope already lean that way.
3. **The casing of each response is part of its documented contract.** `docs/openapi.json` is the authority per endpoint.
4. **A UI should not scatter casing knowledge.** It should read the API only through the SDK. If the mix proves painful, the fix is
   a mapping layer in the SDK (one place, opt in, typed), not a change to the wire format. That would be a new ADR.
5. **If the wire format is ever unified**, it is a versioned change (a new path prefix or an explicit opt-in header), not an edit
   in place.

## Consequences
- The mix stays. It is ugly and documented, which is cheaper than a breaking change before there is a consumer.
- This decision is reversible until a second consumer (the new UI) ships. After that, point 5 applies.
