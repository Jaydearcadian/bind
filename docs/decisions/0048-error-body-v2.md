# 0048: Error body v2 is live

Status: Accepted

## Context
ADR 0047 specified an additive error body. Stages 1 and 2 of that spec are now built.

## Decision
- Every JSON error that carries a string `error` is enriched in one place (`src/server/error-contract.ts`, wrapping `res.json`) with `code`, `category`, `retryable` and `requestId` (the same value as `x-request-id`), plus `retryAfterSeconds`, `reasonCodes`, `details.fields` and one typed recovery action where they apply. The existing `error` text and HTTP status are unchanged. About 93 call sites needed no edit.
- Health and readiness bodies, and bodies that already have a `category`, are left alone.
- OpenAPI, the generated SDK types and the capability catalogue are regenerated. The catalogue of codes is checked against the runtime table by a unit test.
- Owner decisions recorded as defaults for the next stages: idempotency scope is workspace, token and key; replay window is 90 days via polling; outbound webhooks default to a staff-visible audience with an owner opt-in; `getWebhookSecret` is left as is; outbound webhooks are deferred.

## Test assertion changes (recorded rationale)
About 40 integration assertions compared exact old error bodies, or compared the text of two refusals byte for byte. The new `requestId` differs per request and new fields are added, so those assertions now use `toMatchObject` or `stableText` (`tests/helpers/error-body.ts`). The properties they protect are unchanged: no tenant or token existence leak, same status, same message. No test was deleted or skipped. New tests: 9 unit and 12 integration (real errors validated with ajv against the draft schema).

## Evidence
Lint (0 warnings), typecheck, unit 399 passed, integration 547 passed with 10 skipped (as before). Local only (`LOCAL_PASS`).
