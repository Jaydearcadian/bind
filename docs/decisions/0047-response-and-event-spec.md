# ADR 0047: Response model and event surface specification, draft 1

## Status
Accepted as a draft specification (2026-10-20). Nothing in it is implemented. Builds on ADR 0034, 0035, 0036, 0037 and 0046.

## Context
The ecosystem audit (ADR 0046) found that the interfaces lack a client idempotency key, a structured error contract, a versioned and correlated event envelope, outbound webhooks, and single-resource reads for asynchronous work. Decision D-5 was to specify before building.

## Decision
`docs/ecosystem/RESPONSE_AND_EVENT_SPEC.md` specifies the changes, all additive: an `Idempotency-Key` on the 18 economic or irreversible write operations, a `_meta` object on command responses, error body v2 with a category and retryability, event envelope v1 with past-tense names, and owner-registered signed outbound webhooks that reuse the existing signing scheme. Draft JSON Schemas, an error catalogue, an event name table and valid and invalid examples are in `docs/ecosystem/spec/` and are checked by `tests/unit/ecosystem-spec.test.ts`.
`ajv` 8.20.0 becomes an explicit devDependency. It was already installed through the MCP SDK at the same version; the lockfile change is re-hoisting only.

## Consequences
- No API, SDK, MCP, worker or database code changed. Six decisions are left to the owner (section 12 of the spec).
- Not verified: no real response was validated against these schemas yet (that is stage 1), the exact HTTP status of many service error codes was not checked, six event names are inferred, and no correlation id exists until an `audit_logs` column is added.
