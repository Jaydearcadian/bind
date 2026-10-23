# 0053: Event envelope v1

Status: Accepted

## Context
ADR 0047 (section 5 of the spec) added five fields to the event envelope so a consumer can name an event, know its workspace, know what it is about and trace it back to the request that caused it. The old fields stay with the same meaning.

## Decision
- New fields on the stream and the poll: `name`, `schemaVersion` (1), `workspaceId`, `object` ({ type, id }) and `correlationId`.
- `name` and `object.type` come from one table (`src/api/event-catalogue.ts`). A test keeps it equal to `docs/ecosystem/spec/event-names.json`, which a test keeps equal to the types in `docs/EVENTS.md`. An action with no entry is named `event.recorded` and has no `object`.
- `object.id` is the `<object>Id` key of the allowlisted evidence, or the workflow id for a workflow event, or null.
- `audit_logs.request_id` is a new nullable column (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, safe on a live database). All 17 places that write an audit row record `currentRequestId()`. The id comes from an `AsyncLocalStorage` set by a middleware that runs after body parsing (before it, the parser's stream callbacks can lose the context). Work no request started, such as the worker, records null.
- `correlationId` is sent only when the recorded id has the safe request-id shape. The server already replaces an unsafe client `x-request-id` with its own UUID.
- Delivery, ordering, replay and visibility are unchanged (ADR 0035).

## Test changes, recorded
- `tests/unit/events.test.ts`: the exact-envelope assertion now includes the new fields, and a new test covers name, object id, correlation and the unnamed fallback.
- `tests/integration/sdk.test.ts`: the sweep of member GET operations skips `getWorkflow`, `getOrder` and `getApproval`, because they need ids of resources that file does not create and `orderId` is also the customer-order parameter; `tests/integration/resource-reads.test.ts` reads each of them. The skip list is explicit and checked against the registry.
- Nothing was deleted.

## Evidence
Lint and typecheck clean; unit 423 passed; integration passes with the new `event-envelope.test.ts` (4 tests over HTTP and PostgreSQL: each event valid against the draft schema, correlation to the request, no correlation for work without a request, staff still do not see owner-only events, two concurrent requests keep their own ids). `LOCAL_PASS`.

## Not done
- No object version (no table keeps one).
- Rows written before this change have no `request_id`; their events have no `correlationId`.
- Outbound webhooks remain deferred.
