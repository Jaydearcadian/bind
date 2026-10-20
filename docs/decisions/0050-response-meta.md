# 0050: `_meta` on command responses

Status: Accepted

## Context
ADR 0047 specified a `_meta` object so a caller, human or agent, can read the outcome of a command in one vocabulary and see what its own role may do next.

## Decision
- The 18 command operations (the same set as ADR 0049) add `_meta` to a 2xx JSON object answer, beside the existing fields. No field moves; the HTTP status does not change. Other routes are untouched.
- `_meta` is derived by code from the answer body (`src/server/response-meta.ts`), never from text: requestId, status, state, processing, nextActions, warnings. It holds ids, state names and fixed labels only; a test checks that body text does not leak into it.
- Status vocabulary: `completed` (done and recorded), `accepted` (started, not finished), `held` (waiting for a person), `refused` (a rule said no). A replenishment that is submitted or authorized is `accepted`, not `completed`; only `confirmed` or `reconciled` is `completed`. An approval whose payment outcome is unknown is `accepted` with the warning `SETTLEMENT_OUTCOME_UNKNOWN`, never done.
- `nextActions` lists only what the caller's role may do. A held replenishment offers approve and reject to an owner; to staff it offers nothing and warns `OWNER_DECISION_NEEDED`.
- The warning `IDEMPOTENCY_KEY_MISSING` is sent when a keyed command arrives without a key.
- On an idempotent replay the stored body is sent again with a fresh `_meta.requestId`.
- OpenAPI documents `_meta` on those operations' 2xx answers; the SDK types follow.

## Not done
- `provenance`, `asOf` and `links` are not produced. `provenance` needs a verifier that does not exist; `links` and `processing.poll` need `getWorkflow`, `getOrder` and `getApproval`, which are separate additive reads.
- Single-resource reads do not carry `_meta` yet.
- Idempotent replays of a config command carry the same `_meta.status` as the original.

## Evidence
Lint, typecheck, unit 411 passed, integration 560 passed with 10 skipped. Unit tests check `_meta` against `response-meta-v1.schema.json` for every command operation; an integration test checks it over HTTP and checks the replay request id. `LOCAL_PASS`.

## Test assertion changes
Two assertions in `tests/integration/webhook-auth.test.ts` compared an exact body or key list; they now ignore `_meta` (additive). Nothing was deleted or skipped.
