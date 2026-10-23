# ADR 0031: Untrusted input cannot grant authority, change a decision, crash the server or leak internals

## Status
Accepted (2026-10-20). Implements Task 11 of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`. Builds on ADR 0022
(webhook authentication), ADR 0024 (one redaction module), ADR 0028 (feedback is data) and ADR 0015 (the single commitment gate).
`src/ui/` is not touched (ADR 0016). Rate limiting is Task 12.

## Context
Bind takes input from many places it does not control: HTTP bodies and paths, supplier quotes and order answers, uploaded document
text, surface events from a messaging bridge, and arguments a language model chooses for its tools. AGENTS.md requires that all of
them are untrusted and that no credential, stack or database message reaches a client.

Before this task the rules were enforced in several places, and some were not enforced at all:
- Express's default error handler answered a malformed or oversized JSON body with an HTML page that included a stack trace in
  development mode. Routes answered every other failure with `err.message`, which can carry a database driver's text.
- A supplier's quote was stored and used as received. A quote with a zero price, a total that did not match its price and quantity,
  a past or far-future validity, or a supplier or sku other than the one requested, went into `quotes`. An order answer with any
  status other than `rejected` was treated as a confirmation, whatever its order number or reference.
- A model-facing status tool read any workflow by id, with no workspace filter.
- A model's quantity was stored in a replenishment proposal and checked only by the gate afterwards.
- A document's amounts were parsed without a bound, so `$99999999999999999999` became a 1e22 integer.
- Surface event fields had no maximum length, and an oversized count reached a `NUMERIC(12,4)` column.

This ADR records the one mechanism now used for each class of input, the bounds, the defects the probes exposed, and what is not
covered.

## Decision

### 1. One rule for what a client may see (`src/server/errors.ts`)
- `publicErrorMessage(err)` is the only function a route uses to put an error into a body. It returns:
  - `"Request could not be processed"` for a database driver error (a `DatabaseError`, or a five-character SQLSTATE code), a
    Node system error (`E` followed by capitals only, such as `ECONNREFUSED`), and any value that is not an `Error`;
  - `"Invalid request body"` for a zod error (the zod message names the rule and the limit, so it is not echoed);
  - otherwise the message of a domain error, after `redactText`, cut to 300 characters.
- A code made of capitals and underscores (`EXTERNAL_REF_REUSED`) is a domain code, not a system code, and keeps its message.
- The typed domain errors (`ApprovalDecisionError`, `WorkflowCancelError`, `FulfilmentError`, `FeedbackError`, `MenuError`,
  `SettlementOrderError`) keep their fixed texts, as before. They never echo input.
- `requestErrorHandler` is the last middleware of `createApp`. It answers:
  - `entity.parse.failed` (malformed JSON): `400 { error: "Malformed JSON body", code: "MALFORMED_JSON" }`;
  - `entity.too.large`: `413 { error: "Request body too large", code: "BODY_TOO_LARGE" }`;
  - any other 4xx from the parser or the router (for example a path that is not valid percent-encoding): `{ error: "Invalid request" }`
    with that status;
  - anything else: the real message is logged once with `console.error`, redacted and cut, and the client gets
    `500 { error: "Internal error" }`. No stack is ever sent.
- The JSON body limit is explicit: `express.json({ limit: "256kb" })`. The raw bytes are still kept for the signature check (ADR 0022).
- An unknown `/api` path is `404 { error: "Not found" }`, so no API path answers with the page.
- **Async routes.** Express 4 does not catch a rejected promise from an async handler, and on Node 22 an unhandled rejection
  ends the process. `wrapAsyncHandlers(app)` (src/server/errors.ts) is called first in `createApp`, before any route is registered.
  It wraps every handler given to `get`, `post`, `put`, `delete` and `patch`: a rejected promise, or a synchronous throw, calls
  `next(err)` and reaches the central handler above (500 `{ error: "Internal error" }`, the real error logged as a redacted
  message). Middleware order, paths and arguments are unchanged. Each wrapped handler carries the marker `ASYNC_SAFE`, which the
  guard test checks on every registered route. Two read routes that caught their own errors now let the central handler answer:
  `GET .../accounting/ledger` and `GET .../needs-attention` (they answered 400 and 500 with their own text).

### 2. NUL characters and malformed paths never reach the database (`rejectNulInput`)
PostgreSQL cannot store NUL in text, so a NUL reached the driver and came back as its own message. `rejectNulInput` runs after the
body is parsed, before any route:
- a NUL in any string of the parsed body (at any depth, in keys or values, walked without recursion), or in the query string, or in
  the decoded path (including `%00`), gets `400 { error: "Invalid characters in request", code: "INVALID_CHARACTERS" }`;
- the check runs on the parsed body, so a `\u0000` written as an escape in the JSON is caught too;
- it runs before authentication and before the signature check. It reveals nothing about a workspace, and an unsigned request
  containing a NUL gets 400 rather than 401.

### 3. Bounds on input (where each is set)
| Input | Bound | Where |
|---|---|---|
| JSON body | 256 kilobytes | `express.json` limit in `createApp` |
| Settlement address (policy) | a valid EVM address (`normalizePaymentAddress`), stored checksummed; otherwise 400 `settlementAddress must be a valid EVM address` | `PUT /api/workspaces/:id/policy` |
| Surface event `eventId` | 4 to 120 characters | `SocialSurfaceEventSchema` |
| Surface event `workspaceId` | 1 to 64 | `SocialSurfaceEventSchema` |
| Surface event `actorId`, `sku`, `approvalId` | 2 to 120 (sku 1 to 120) | `SocialSurfaceEventSchema` |
| Surface event `reason`, `note` | 500 characters | `SocialSurfaceEventSchema` |
| Surface stock count `observedQuantity` | integer, 0 to 1,000,000 (`MAX_OBSERVED_QUANTITY`) | `SocialSurfaceEventSchema` |
| Document text `rawText` | 20,000 characters (existing, tighter than the 50,000 the brief allowed) | `ExtractDocumentInputSchema` |
| Document amount (extracted or confirmed) | 1e12 cents; anything above is not used and is flagged `AMOUNT_OUT_OF_RANGE` | `parseDollarToCents`, `ConfirmDocumentInputSchema` |
| Document quantity | 1,000,000; above is not used and is flagged `QUANTITY_OUT_OF_RANGE` | `extractDocumentDraft`, `ConfirmDocumentInputSchema` |
| Supplier quote amount | integer, greater than 0, at most 1e12 (`MAX_AMOUNT_CENTS`) | `validateQuoteResponse` |
| Supplier quote quantity | equal to the requested quantity, at most 1,000,000 | `validateQuoteResponse` |
| Supplier quote validity | after now, at most 30 days ahead | `validateQuoteResponse` |
| Supplier name | 1 to 200 characters, no control characters (NUL included) | `validateQuoteResponse` |
| Supplier quote id | 1 to 64 characters of `[A-Za-z0-9._:-]` (the column is `VARCHAR(64)`) | `validateQuoteResponse` |
| Supplier order reference | 1 to 120 characters of `[A-Za-z0-9._:-]` | `validateOrderResponse` |
| Policy budget and threshold | safe integers (the database column is `BIGINT`) | `PUT /api/workspaces/:id/policy` |
| Template id | must be an own key of the template table | `getTemplate` |

Text is never truncated silently into a decision. A value out of bounds is refused, or (for document amounts, where the text is a
draft a person confirms) not used and flagged in the warnings.

### 4. Supplier responses are checked where they are consumed (`src/adapters/suppliers/validate.ts`)
Two pure functions, with no I/O:
- `validateQuoteResponse(request, response, now)` checks that the quote answers the request (supplier, rfq, sku, quantity), and the
  bounds above, and that the total equals unit price times quantity. The check runs **inside** the effect callback in
  `ProcurementWorkflowRunner.requestQuote`, so an invalid quote is recorded as a failed effect and never as completed, and is never
  inserted into `quotes`. `startReplenishment` catches the refusal, moves the workflow from `request_sent` to `failed` with the text
  `SUPPLIER_RESPONSE_INVALID: <reason>`, writes the audit row `suppliers.request_quote.response_invalid` (the code, the request's
  sku and quantity, never the supplier's text), and returns `FAILED`. No approval and no order follow.
- `validateOrderResponse(request, response)` checks the status is `confirmed` or `rejected`, the order number is the one sent, and
  the external reference is a bounded plain token. The check runs inside the `orders.submit` effect and in the reconcile lookup.
  An invalid answer is an **unknown outcome**: the order and the workflow stay `submitted`, the ledger effect is not completed,
  nothing is cancelled or confirmed, nothing is resent, and the audit row `orders.submit.response_invalid` holds the order id, the
  order number, the effect id and the code, never the supplier's text. The return is `inDoubt: true`, as for a timeout.
- A reason is one of a fixed set of codes (`PRICE_INVALID`, `SUPPLIER_MISMATCH`, `STATUS_UNEXPECTED`...). The supplier's own text is
  never returned or audited.

### 5. Model-facing tools (`src/agents/replenishmentTools.ts`)
- The decision, amounts and approvals come only from database rows and the commitment gate. The model's `reasonCodes`,
  `explanation` and `sourceRecordIds` are stored as data and read by no decision (a test shows that hostile text leaves the decision
  unchanged).
- `create_replenishment_proposal` refuses a quantity that differs from the stored quote (`Quantity N does not match the stored quote
  quantity M`). The supplier and quote are already checked against the workspace.
- `get_request_status` reads a workflow only in the caller's workspace. Before this change it read any workflow by id.
- The replenishment's offline path chooses only a quote for the quantity being ordered. A quote for another quantity was always
  refused by the gate (`QUOTE_CHANGED`), so this changes no outcome that was allowed before.

### 6. Surface events (ADR 0022 is unchanged)
The signature, replay and binding checks keep their order. The new bounds run in the schema, before the signature check, so an
over-length event is refused by schema. A signed event that fails the schema falls through to the standard webhook, which answers
401 for a surface signature, so no oversized event is processed. The replay window (300 seconds past, 60 seconds future) is
confirmed by a probe and is unchanged.

### 7. Supplier ids are not shared across workspaces (`POST /api/workspaces/:id/suppliers`)
A supplier row id is `<workspace>_<id>`, unique across all workspaces. A workspace id may hold an underscore, so one owner could name
another workspace's row. The upsert now updates a row only when `suppliers.workspace_id` equals the caller's. Otherwise nothing is
written and the route answers `409 { error: "Supplier id is not available" }`, as the workspace create route does.

## Defects found by the probes, and their fixes
Each probe was written against the code before the fix. Each row lists the failing probe (its title in
`tests/integration/untrusted-input.test.ts`), the symptom observed, and the fix.

| # | Probe | Symptom before the fix | Fix |
|---|---|---|---|
| 1 | a malformed JSON body is a 400 with a JSON code | Express default page, HTML, with a stack in development | `requestErrorHandler`: `MALFORMED_JSON` |
| 2 | a body over the size limit is a 413 with a JSON code | Express default 413 page (default limit 100 kb) | explicit 256 kb limit; `BODY_TOO_LARGE` |
| 3 | a NUL character in a body string is refused before it reaches the database | inventory `sku` with NUL reached the driver: the response was not the fixed code | `rejectNulInput` |
| 4 | a NUL character in a path id is a 400, not a 5xx | `GET .../customer-orders/%00` answered 500 | `rejectNulInput` (decoded path) |
| 5 | a database error never reaches the client as its own text | `value "100000000000000000000" is out of range for type bigint` returned | `publicErrorMessage` on every catch; budget must be a safe integer |
| 6 | every route answers hostile input with a JSON 4xx or a 2xx | HTML from the parser on a malformed body (test 1), and 500s on several routes (see rows 7, 8, 9) | the fixes in this table |
| 7 | an object id on the public workspace create is refused as bad input | `id: {a:1}` answered 500 | `typeof` checks on id, name and template id, 400 |
| 8 | a template id that names an object property is not found | `/api/templates/constructor/blueprint` answered 500 | `getTemplate` checks own keys only |
| 9 | an absurd settlement address or budget is refused, not stored | a 100,000-character settlement address was stored and answered 200 | EVM address check (`normalizePaymentAddress`); safe-integer budget |
| 10 | a quote for another supplier, sku or quantity is rejected | a quote for another supplier reached the database as a raw foreign-key error. The sku and quantity cases were not observed separately (the test stops at its first failure) | `validateQuoteResponse` in the effect |
| 11 | a quote with a zero, negative or absurd price is rejected | the quote was stored and the gate denied it with `INVALID_AMOUNT`, not the supplier code | `validateQuoteResponse` |
| 12 | a quote whose total is not unit price times quantity is rejected | stored; the gate denied it with `QUOTE_CHANGED` | `validateQuoteResponse` |
| 13 | a quote that is already expired or valid for more than 30 days is rejected | an expired quote was accepted and the order confirmed | `validateQuoteResponse` |
| 14 | quote text is bounded and stored as data | a 10,000-character supplier name was accepted and stored | 200-character bound, no control characters |
| 15 | an invalid quote stores nothing and starts no approval | a quote with a zero price was stored | `validateQuoteResponse` before the insert |
| 16 | an order response with an unexpected status or reference is an unknown outcome | an order answered `pending` was recorded as `confirmed`. The other variants (order number, reference) were not observed separately | `validateOrderResponse`, in-doubt handling |
| 17 | an oversized document is refused | a 20,001-character document returned the zod issue list (rule text and limit) | `publicErrorMessage` (zod names fields only) |
| 18 | absurd amounts are refused or flagged | `$99999999999999999999` produced `unitPriceCents` 1e22 in the staged draft | amount and quantity bounds with warnings |
| 19 | a supplier id that collides with another workspace's (found while reading, probed here) | an owner of one workspace overwrote another workspace's supplier and got 201 | update only the caller's own row; otherwise 409 |
| 20 | a workflow id from another workspace is not readable by the tools | `get_request_status` resolved for another workspace's workflow (it returned that workflow's status) | workspace filter |
| 21 | model-supplied quantity and supplier cannot differ from the stored quote | `quantity: 1000000000` was stored in the proposal and the call resolved. The quantity 9 case was not observed separately | quantity refused at proposal time |
| 22 | oversized fields in a surface event are refused | an event with a 5,000-character `eventId` from a bound owner was accepted (200) | schema bounds (section 3) |
| 23 | an unknown API path is a JSON 404 | (added with the fix, probed after) `POST /api/unknown` answered Express's HTML 404 | `app.use("/api", ...)` |

Row 6 is the all-routes sweep. It stops at its first failing request, which was the HTML answer to a malformed body (row 1), so
the other routes it covers were checked only after the fixes. Rows 7 to 9 are separate probes. Row 23 was found while correcting a
probe, and its test was added afterwards; its mutation check is recorded below.

Three further observations were made but not probed as separate failures, and are recorded as concerns:
- an out-of-range surface `observedQuantity` (above `NUMERIC(12,4)`) and a 100,000-character `reason` on an approval decision. Both
  were in the same probe as row 22, which stops at its first failure, so their behaviour before the fix was not recorded separately.
  Both are now refused by the schema.
- the offline choice of quote (section 5) is a behaviour change, made because a mismatched quote could otherwise be chosen and then
  refused by the gate after the workflow had started.

## Tests
- `tests/integration/untrusted-input.test.ts`: 38 tests (sections A to F, the supplier-collision probe, the JSON 404, the EVM
  settlement address). Each probe that is a defect is recorded in the table above with its observed failure.
- `tests/integration/route-failure.test.ts`: 4 tests. A database query rejects once inside a route, with a driver-like error that
  names SQL text. Eight read routes (inventory, audit, orders, approvals, workflows, suppliers, ledger, needs-attention) and one
  write route are exercised; each answers a safe JSON error, the server answers the next request, and no unhandled rejection is
  raised. The guard test checks that every registered handler is wrapped, and a stub that rejects reaches `next`.
- `tests/unit/supplier-validation.test.ts` (validators, 15 tests) and `tests/unit/server-errors.test.ts` (`publicErrorMessage`,
  `containsNul`, 11 tests).
- No existing test assertion was edited, and no existing test file was changed. The existing suites pass unchanged. Two behaviours
  changed: an over-limit body was an HTML 413 under the default 100 kb limit and is now a JSON 413 under 256 kb; and a supplier id of
  another workspace was silently overwritten and is now a 409. Neither was asserted by an existing test.

## Mutation checks
Each mutation was applied alone to the working tree, `tests/integration/untrusted-input.test.ts` was run, and the file was restored
and compared byte for byte.

| Mutation | Probes that fail |
|---|---|
| Central error handler removed (`requestErrorHandler`) | `a malformed JSON body is a 400 with a JSON code, never an HTML page with a stack`; `a body over the size limit is a 413 with a JSON code`; `an oversized document is refused`; `every route answers hostile input with a JSON 4xx or a 2xx, never a 5xx or an internal detail` |
| Quote validation removed from `requestQuote` | `a quote for another supplier, sku or quantity is rejected`; `a quote with a zero, negative or absurd price is rejected`; `a quote whose total is not unit price times quantity is rejected`; `a quote that is already expired or valid for more than 30 days is rejected`; `an invalid quote stores nothing and starts no approval`; `quote text is bounded and stored as data` |
| Surface `eventId` bound removed | `oversized fields in a surface event are refused` |
| NUL guard removed (`rejectNulInput`) | `a NUL character in a body string is refused before it reaches the database`; `a NUL character in a path id is a 400, not a 5xx`; `every route answers hostile input with a JSON 4xx or a 2xx, never a 5xx or an internal detail` |
| Order response validation removed | `an order response with an unexpected status or reference is an unknown outcome, not a confirmation` |
| Workspace scope removed from `get_request_status` | `a workflow id from another workspace is not readable by the tools` |
| `/api` JSON 404 removed | `an unknown API path is a JSON 404, never an HTML page` |
| Async wrapper removed (`wrapAsyncHandlers` not called) | `a database failure in a read route answers 500 JSON and the server keeps serving` (times out on the first read route, with an unhandled rejection recorded); `a database failure in a write route answers a safe error and the server keeps serving`; `every route handler is wrapped` |

Every mutation was caught by the probe that targets it. In each run, the valid-path probe `a valid quote and order response still work`
was not among the failures. The existing suites were not run under each mutation: they were run once, on the unmutated code.

## What is NOT covered
- **No live model was probed.** There is no model key in this environment. The tool tests call the deterministic tools directly, the
  same functions a model would call. The language-model path (`NEBIUS_API_KEY`) was not run.
- **No fuzzing campaign.** The probes are fixed examples. There is no property-based or coverage-guided fuzzing of the parsers.
- **Rate limiting and brute-force protection are Task 12.** Repeated hostile requests are not throttled.
- **Live suppliers.** Every supplier is simulated. The validators are tested against simulated and spy responses only.
- **Route failures outside the probed routes.** The async wrapper covers every registered route. Its tests fail a database query in
  eight read routes and one write route. Other routes are covered by the guard, not by a failure test each.
- **Surface actor identity.** A bridge holding a workspace secret can still claim any bound actor id (ADR 0022). That is unchanged.
- **`docs/RELEASE_EVIDENCE.md`** is not updated by this change (a release-step follow-up, as in ADR 0022).

## Supplier id collision (report item 20; section 7 and row 19 of the table)
A supplier row id is `<workspace>_<id>`, unique across all workspaces, and the upsert used to update the row whatever its
workspace. A workspace id may contain an underscore, so the owner of workspace `atk_<run>` posting `{ id: "v_supp" }` named the
row `atk_<run>_v_supp` that workspace `atk_<run>_v` had created, and the old upsert overwrote its name, verification and payment
address, answering 201. This is a cross-tenant write. The fix is in section 7: the update applies only to a row of the caller's own
workspace, and otherwise nothing is written and the route answers **409** `{ error: "Supplier id is not available" }`.
**Behaviour change:** a supplier post that used to overwrite another workspace's row now answers 409. No existing test relied on the
overwrite. The probe is `one owner cannot change another workspace's supplier through a colliding supplier id`.

## Consequences
- A client sees a fixed message or a domain message of at most 300 characters. A database or driver error cannot reach it.
- A supplier's answer is accepted only when it answers the request, is within bounds, and its identifiers are plain tokens. An
  answer that is not accepted is recorded as a failure, with its code.
- A model's arguments cannot select a different quantity from the stored quote, and cannot read another workspace's workflow.
- A document's absurd amount is flagged rather than stored, and cannot become a confirmed amount.
- The supplier upsert and the workflow status read are scoped to the caller's workspace.
