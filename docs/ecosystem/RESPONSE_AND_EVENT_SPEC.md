# Response model and event surface: specification, draft 1

Status: a specification. **Nothing in it is built.** It follows the audit (`ECOSYSTEM_AUDIT.md`, decision D-5: specify before building) and answers findings S1 to S5, S7, S11 and S13. No API, SDK, MCP, worker or database code changed. What is new is data and tests: draft JSON Schemas, an error catalogue, an event name table and valid and invalid examples in `docs/ecosystem/spec/`, validated by `tests/unit/ecosystem-spec.test.ts` (34 tests, with a mutation check that the tests fail when a schema or table is wrong).

Words used: **today** means the code as it is in this repository; **proposed** means this specification; **decision** means the owner must choose before it is built (section 12).

## 1. The compatibility promise

Every change here is **additive** under ADR 0034 section 3: objects are open, named fields are stable, a new field is compatible. Nothing is removed, renamed or retyped on the wire. Today's clients keep working, and a client that ignores the new parts loses nothing.

- Error bodies keep `error`, `code` and `reasonCodes`; they gain fields.
- Responses keep every field; command responses gain an optional `_meta` object.
- Events keep `type` and every envelope field; they gain `name`, `schemaVersion`, `workspaceId`, `object` and `correlationId`.
- HTTP status codes do not change. `createCustomerOrder` still answers 201 for a declined or held order (S14); `_meta.status` becomes the authoritative outcome, and the HTTP code is fixed only by a versioned change.

## 2. Idempotency (S1)

> **Built (stage 3, ADR 0049).** The header, the table `api_idempotency`, replay, conflict, in-progress, stale-lock takeover, 24-hour retention and the SDK `idempotencyKey` option exist and are tested. The `IDEMPOTENCY_KEY_MISSING` warning, the worker sweep and the MCP key are also built (ADRs 0049, 0050).

**Today:** no client idempotency key. Repeats are safe only by natural keys: `externalRef` on customer orders, feedback duplicate detection, and a repeated replenishment that returned the same workflow while it awaited approval (ADR 0042). The effects ledger already makes external effects at-most-once (ADR 0017); this section protects the API boundary, so a client can retry a command after a timeout without learning whether it ran.

**Proposed**
- **Header:** `Idempotency-Key: <key>`, 1 to 128 characters from `[A-Za-z0-9._:-]`. A UUID is the recommended form.
- **Where:** accepted on the 18 operations with an economic or irreversible effect and a write method (`acceptCustomerOrder`, `approveApproval`, `cancelCustomerOrder`, `cancelWorkflow`, `confirmDocument`, `createCustomerOrder`, `fulfilCustomerOrder`, `publishMenuProposal`, `rejectApproval`, `replenish`, `revokeApproval`, `revokeConnector`, `revokeToken`, `rotateWebhookSecret`, `setAgentsPaused`, `updatePolicy`, `upsertAgentRole`, `upsertSupplier`). The list is the `economic` or `irreversible` rows of `docs/capabilities.json`. Ignored on reads. Optional on the rest.
- **Scope:** one key means one request within `(workspace, token, key)`. A different token does not see another token's stored response. A rotated token starts a new scope; the effects ledger still protects the effect.
- **Fingerprint:** SHA-256 over the method, the path with its parameters, and the canonical body. The same key with the same fingerprint replays; with a different fingerprint it is refused.
- **Replay:** the original status and body are returned unchanged, with the header `Idempotent-Replayed: true`. Stored for 24 hours.
- **Same key, first request still running:** 409 `IDEMPOTENCY_IN_PROGRESS` with `Retry-After`.
- **Same key, different request:** 422 `IDEMPOTENCY_KEY_REUSED`. A malformed key: 400 `IDEMPOTENCY_KEY_INVALID`.
- **What is stored:** the outcome of a request that finished with 2xx, or with a 4xx that a retry would repeat. A 429, 500 or 503 is **not** stored, and its lock is released, so the retry runs again. This is safe only because effects are at-most-once in the ledger.
- **No key sent:** allowed, for compatibility. The response carries `_meta.warnings` with `IDEMPOTENCY_KEY_MISSING` on the 18 operations, so a careless client is told.
- **With `externalRef`:** unchanged. `externalRef` is the business's own reference for a customer order and still returns the earlier decision. The idempotency key is transport safety and is checked first.
- **Storage (sketch, not a migration):** one table keyed by `(workspace_id, token_id, key)` with the operation, the fingerprint, the state (`in_progress` or `done`), the stored status and body, and timestamps; swept after 24 hours.

## 3. Response semantics (S13)

**Proposed `_meta`**, added to JSON-object responses of command operations and of the single-resource reads below (`response-meta-v1.schema.json`):

| Field | Meaning |
| --- | --- |
| `requestId` | The `x-request-id` header's value (required) |
| `status` | `completed` (done and recorded), `accepted` (started, not finished), `held` (waiting for a person), `refused` (a rule said no). Required |
| `state` | The resulting state of the main resource, in its own vocabulary |
| `provenance` | `verified`, `configured_unverified`, `simulated` or `not_applicable`: whether the outside party is live. Never `verified` unless a verifier succeeded (no verifier exists today, so it will not be) |
| `asOf` | When a read was taken |
| `processing` | `remaining` steps, and `poll` and `events` links, while work continues |
| `nextActions` | Only actions the **caller's role** may take now: id, label, actor, method, href, whether to confirm first |
| `warnings` | Code and message pairs |
| `links` | Related resources |

List responses are arrays and stay as they are; they get the `x-request-id` header only.

**Not a success flag.** `completed` is used only when the state is recorded and, for an external effect, confirmed. A submitted order is `accepted` with `processing.remaining` naming the supplier confirmation; a submission is never reported as completion (AGENTS.md).

**What each state implies for `nextActions`** (vocabularies as the code names them):

| Resource | State | Owner may | Staff may |
| --- | --- | --- | --- |
| Workflow | `awaiting_approval` | approve or reject the approval; cancel the workflow | nothing; a warning says an owner decides |
| Workflow | `submitted`, `confirmed` | reconcile or confirm settlement if stuck (internal operations) | read only |
| Workflow | `failed` | read the reason; cancel | read only |
| Approval | `pending` | approve, reject | none |
| Approval | `approved` | revoke (if still allowed) | none |
| Customer order | `needs_owner` | accept, cancel | cancel |
| Customer order | `accepted`, `partially_available` | fulfil, cancel | fulfil, cancel |
| Customer order | `declined`, `cancelled`, `fulfilled` | none | none |
| Menu proposal | `proposed` | approve, reject, cancel | none |
| Menu proposal | `approved` | publish, cancel | none |

The workflow states are `draft`, `request_sent`, `quote_received`, `awaiting_approval`, `authorized`, `submitted`, `confirmed`, `reconciled`, `failed` and `cancelled` (`src/db/schema.sql`); approvals `pending`, `approved`, `rejected`, `expired` (and the decision result `revoked`); customer orders `accepted`, `partially_available`, `declined`, `needs_owner`, `cancelled`, `fulfilled`; menu proposals `proposed`, `approved`, `rejected`, `published`, `cancelled`. The table's exact action sets are a proposal to check against each route's own rules when built.

**Additive operations needed so `links` and `processing.poll` have somewhere to point.** Today there is `getCustomerOrder` but no read of one workflow, one order or one approval, only lists. Proposed: `getWorkflow`, `getOrder`, `getApproval` (member routes, same visibility as their lists). They would be the **operation resources**: asynchronous work is observed by reading its workflow, never by guessing from a status flag.

## 4. Error model v2 (S2, S7)

**Proposed body** (`error-v2.schema.json`): `error`, `code`, `category`, `retryable`, `requestId` required; `retryAfterSeconds`, `reasonCodes`, `details`, `recovery` and `docs` optional.

- **Category:** `validation`, `authentication`, `authorization`, `not_found`, `conflict`, `policy`, `rate_limited`, `upstream`, `unavailable`, `internal`.
- **Retryable** is true only when the same request, unchanged, can succeed: `rate_limited` always (with `retryAfterSeconds`), `unavailable`, and a few conflicts that clear (`WORKFLOW_STATE_CHANGED`, `IDEMPOTENCY_IN_PROGRESS`). Never for validation, authentication, authorization, not-found or policy. The schema enforces both rules.
- **Recovery:** up to five typed actions (`fix_request`, `authenticate`, `use_other_role`, `retry`, `wait_and_retry`, `refresh_and_retry`, `ask_owner`, `contact_support`).
- **Safe by construction:** `details` holds safe context such as field names, never customer, supplier or document text (ADR 0031). The 500 message stays the fixed generic text and the real error stays in the log under the request id.
- **Request id** in the body is the same as the header.
- **Codes:** `error-catalogue.json` lists 18 codes that exist today (each checked against the source by a test, with the HTTP status from the handlers in `src/server/app.ts` and `docs/EVENTS.md`) and 11 proposed ones. The proposed ones give a code to today's code-less 401, owner-required 403, missing-workspace 404, generic 400 validation, 500, 503, and the idempotency and webhook errors. A test fails when a proposed code appears in the source, so the catalogue is flipped when it ships. Codes beyond those 29 (for example `NOT_HELD`, `ALREADY_FULFILLED`, `EXTERNAL_REF_REUSED`, `CAPACITY_BELOW_USED`, and the menu and quote refusals) are produced by services, and their exact HTTP statuses were not all checked, so they are **not** in the catalogue yet. Cataloguing them is part of implementation.

## 5. Event envelope v1 (S4)

> **Built (stage 4, ADR 0053).** `name`, `schemaVersion`, `workspaceId`, `object` and `correlationId` are sent on the stream and the poll. `audit_logs.request_id` records the request. Every event is checked against `event-envelope-v1.schema.json`.

**Today** (`docs/EVENTS.md`): an event is an audit row after commit. `id` is the cursor `<txid>.<seq>`; `type` is the audit action string.

**Proposed fields** (`event-envelope-v1.schema.json`), added to today's, none removed:

| Field | Meaning | Source |
| --- | --- | --- |
| `name` | A past-tense name from `event-names.json` | the table |
| `schemaVersion` | `1` | constant |
| `workspaceId` | The workspace | the row |
| `object` | `{ type, id }`: what the event is about | the table gives `type`; `id` from the row's evidence keys, null if none |
| `correlationId` | The request id that caused it | **needs a new `request_id` column on `audit_logs`** (additive) and the request context; omitted until recorded |

- **Names:** all 56 documented types have a name; 21 are renamed (for example `orders.submit` becomes `order.submitted`, `commitment.evaluate` becomes `commitment.evaluated`, `workspace.onboard_configured` becomes `workspace.onboarded`) and 35 already read as past tense and keep their name. Six names are marked "confirm against the recording code" because they were inferred from the type string alone.
- **No object version.** The prompt asks for one; no table keeps a version column, so adding one would be invented. It is omitted, and listed as a gap rather than faked.
- **Delivery, ordering, replay (unchanged):** at-least-once with a total order by `(txid, seq)` per workspace; reconnect with the last id and every later event arrives once, in order (ADR 0035); only committed rows are sent.
- **Consumers must** deduplicate by `id`, resume from the last `id`, and read the current state when an event arrives out of the order they expect: an event says something happened, the resource says what is true now.
- **Visibility (unchanged):** staff do not receive `auth.`, `connector.` or `kitchen_capacity.` events. `event-names.json` marks them `visibility: owner`, and a test keeps that equal to `docs/EVENTS.md`.
- **Retention:** there is no purge today, so audit rows (and thus events) are kept. Decision: whether to state a replay window (section 12).
- **Versioning:** `schemaVersion` changes only with a breaking change. Additive fields do not bump it. A consumer ignores fields it does not know.

## 6. Outbound webhooks (S5)

**Today:** inbound signed webhooks only (ADR 0022). A developer can follow events only with a held-open stream or polling. **Proposed:** owner-registered endpoints that Bind calls, so the important changes are pushed.

- **Registration** (owner routes; `webhook-endpoint.schema.json`): create with `url`, `events` (names or `*`), `audience`; the response carries the endpoint and the **secret once**. List, disable, rotate (new secret once), and read deliveries.
- **Security:** `https` only; a URL that resolves to a private, loopback or link-local address is refused at registration **and at every delivery** (SSRF); no redirects followed; a 10-second timeout; the payload is the allowlisted envelope, so no secrets or free text.
- **Audience:** staff-visible events by default. `audience: owner` adds the owner-only events and needs the owner token (decision, section 12).
- **Signature:** the existing scheme, reused. Headers `x-bind-timestamp` and `x-bind-signature`; the signature is HMAC-SHA256 over `timestamp + "." + rawBody` (`signPayload` in `src/webhooks/signing.ts`), with the same replay window (300 seconds old, 60 ahead). The endpoint secret is derived, like the surface secret: `HMAC(master, "bind-webhook-out-v1:" + endpointId + ":" + version)`, so none is stored.
- **Also sent:** `x-bind-event-id` (the cursor), `x-bind-delivery-id`, `x-bind-delivery-attempt`.
- **Delivery:** at least once. Success is a 2xx within the timeout. Retry with backoff after 1 minute, 5 minutes, 30 minutes, 2 hours, 6 hours and 24 hours (6 retries, 7 attempts in all, about 32 hours); then `abandoned`. Failures never block the stream or poll. An endpoint that fails for three consecutive days is disabled with a reason.
- **Order:** not guaranteed between events. Each carries its cursor `id`; the consumer orders by it.
- **Replay:** the owner can redeliver one delivery, or ask for events after a cursor again; the poll route stays the source of truth.
- **What it never does:** call an endpoint with a credential, deliver an event the endpoint's audience may not see, or put a free-text field in a payload.

## 7. SDK and MCP projections

**SDK (proposed, in the handcrafted layer, not the generated one)**
- Every command takes `idempotencyKey?`. If omitted on the 18 operations, the SDK generates a UUID per logical call and reuses it for its own retries. It retries a write only on a network error, a timeout, a 429 or a 503, and only with a key; it never retries a write without one (today it retries GETs only).
- Errors become typed (`category`, `retryable`, `recovery`, `requestId`), still ordinary classes.
- `waitForWorkflow(id)` polls `getWorkflow` until a terminal state, honouring `processing`.
- `webhooks.verify(rawBody, headers, secret)` reuses the signing rules; `events()` keeps the cursor rules.
- Paid, sensitive or irreversible calls carry a `warns` marker from the catalogue, shown in editors and in logs.

**MCP (proposed)**
- Tool results gain `_meta`; the existing result envelope (`source`, `workspaceId`, `untrustedTextFields`, `data`) is unchanged.
- The tool's idempotency key is derived from the MCP request id and tool name, so a retried call is safe and a deliberate second call is not blocked.
- Resources, for readable state the model can attach: the needs-attention list, pending approvals, and recent events. Prompts, for user-invoked workflows: a morning brief and a low-stock review. Both are proposals only, listed so the surface stays a deliberate subset (the audit's S10).

## 8. Versioning and deprecation (S11)

Proposed, not yet decided: the contract's `info.version` moves to `0.2.0` when the additive changes ship, the stability of each operation (`stable`, `preview`, `internal`, from `exposure.json`) is published in the contract, and a deprecation uses `Deprecation` and `Sunset` headers with a 90-day minimum for `stable` operations and a changelog entry with a migration note. No breaking change is planned.

## 9. Conformance (what is tested now, what will be)

**Now** (`tests/unit/ecosystem-spec.test.ts`): every example validates or fails as labelled; today's envelope is rejected by v1 for exactly the three missing fields and accepted once they are added, and keeps its other fields; every existing catalogue code is in the source and no proposed code is; the category, status and retryability agree; the event table covers exactly the types in `docs/EVENTS.md`, with unique names and the staff-visibility split.

**Next, with the implementation:** the real server's error bodies and command responses validated against the schemas in the existing contract test; idempotency replay, conflict, in-progress and no-store-on-5xx; webhook signature, replay window, retry schedule, SSRF refusal and redelivery; SDK and MCP parity with the API.

## 10. The nine tests, applied to this specification

| Test | Result |
| --- | --- |
| Capability | Pass: each addition answers a recorded finding |
| Projection | Pass: the SDK and MCP changes are projections of the API's |
| Misuse | Partial: webhooks add an SSRF surface, handled by the refusal rules, to be tested |
| Agent | Pass: results stay structured; the model never holds a secret or a key it must invent |
| Payment | Not applicable (D-4) |
| Failure | Pass: errors, retry and replay are specified; not yet implemented |
| Privacy | Pass: allowlisted payloads, audience split, safe `details` |
| Evolution | Pass: additive only; `schemaVersion` defined |
| Ecosystem | Partial: outbound webhooks exist only on paper |

## 11. Rejected

- Wrapping every response in `{ data, meta }`: breaking.
- Fixing the 201 for held and declined orders now: breaking, so versioned later.
- An object version or `ETag` and `If-Match` for upserts: no version column exists; deferred.
- Adopting CloudEvents: the envelope is already close, and a framework adds no value for one producer.
- Letting a webhook endpoint set its own secret.
- A payment header or any paid-access logic (D-4).

## 12. Decisions the owner must make

1. **Idempotency scope:** per `(workspace, token, key)` (proposed) or per workspace.
2. **Retention:** state a replay window for events (proposed: 90 days via poll, audit rows kept) or promise nothing.
3. **Webhook audience:** staff-visible by default with owner opt-in (proposed), or owner-only events never delivered.
4. **Backoff schedule** and the three-day disable rule.
5. **`getWebhookSecret`** (S7): keep, or show the secret only on create and rotate. This specification assumes the second for outbound endpoints and leaves the inbound route as it is.
6. **Whether to build outbound webhooks at all now.** With no external developer audience (D-1), stages 1 to 4 below stand alone; stage 5 can wait.

## 13. Implementation stages (each ends with evidence; none is started)

1. **Contract only:** add the schemas, error codes and `_meta` to the route registry and regenerate `docs/openapi.json`; extend the contract test to check real responses. Evidence: the test.
2. **Error v2 and request id in the body:** one handler change in the error layer. Evidence: error contract tests per category.
3. **Idempotency:** the table and middleware on the 18 operations. Evidence: replay, conflict, in-progress, no-store-on-5xx, cross-token scope.
4. **Event envelope v1:** `request_id` column, the name table, the new fields. Evidence: the envelope contract test and the stream and poll tests.
5. **Outbound webhooks:** the endpoint resource, the sender, the retry worker. Evidence: signature, SSRF, retry and redeliver tests.
6. **SDK and MCP projections:** after the API stages. Evidence: parity tests.

**The next evidence-producing step is stage 1**, because it changes no behaviour and turns this document into a failing test if the server disagrees.
