# ADR 0034: The API contract: one route registry, checked against the running server, and a generated OpenAPI document

## Status
Accepted (2026-10-20). Implements part 1 of Task 12b of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`
(the API contract). Builds on ADR 0016 (the API is the product surface), ADR 0021 (access levels), ADR 0022 (signed
webhooks), ADR 0031 (untrusted input and error text), ADR 0032 (request ids and redaction) and ADR 0033 (rate limits).
`src/ui/` is not touched (ADR 0016). The event stream (SSE), the typed SDK and the MCP server are the next parts of 12b.

## Context
The UI is orphaned and will be rebuilt. The new UI, the SDK and the MCP server will be built on the HTTP API alone, so the
API needs a machine-readable contract. Before this change, a route's access level, its request body, and its response
shape lived in `src/server/app.ts` and in the prose of ADR 0021, and were checked only by hand-written tables in tests.
Nothing described a response, so a field could be removed or retyped without any test noticing.

## Decision

### 1. The registry is the single source
- `src/api/registry.ts` holds one `RouteSpec` for every route that `createApp` registers. There are 66: the 65 routes that
  existed (including the UI catch-all `GET *`), and `GET /api/openapi.json`, which this change adds.
- A spec gives the operation id, method, Express path, `access`, tags, summary, the body and query schemas, every response
  the route can send (status, description, schema or content type), an optional `sampleBody`, and `contractTested` with a
  `notTestedReason` when it is false.
- `access` mirrors the middleware in `src/auth/middleware.ts`: `public`, `authenticated`, `member`, `owner`, `owner-any`,
  `metrics-token` (`BIND_METRICS_TOKEN`) and `signed-webhook` (ADR 0022). The contract test checks it against the server.
- A route's errors are added from its access level and inputs (`withGenericErrors`): 400 for malformed input, 401 for every
  non-public route, 403 for owner routes, 404 for workspace routes, 413 for a body, 429 for the rate limits (ADR 0033), 500
  for an unexpected failure, and 503 when the token lookup fails. A route lists its own success responses and its own errors.

### 2. Schemas are shared, and the routes use them
- `src/api/schemas.ts` holds every request and response schema. The existing request schemas (`InitialSupplyItemSchema`,
  `InitialSupplierSchema`, `OnboardWorkspaceSchema`, `AgentRoleUpsertSchema`, `SurfaceBindingUpsertSchema`,
  `SocialSurfaceEventSchema`, the document schemas, and the customer-order, kitchen-capacity, feedback and menu schemas) are
  imported and re-exported, not copied. The customer-order, feedback, menu and cancel schemas moved out of `app.ts`.
- Where a route validated inline, the schema is now what the route parses with, and the messages are unchanged:
  `POST /api/workspaces/:id/replenish`, `PUT /api/workspaces/:id/agents-paused`, `POST /api/workspaces` and
  `POST /api/approvals/:id/reject|revoke`. Where the service already parses (inventory, suppliers, agents, surfaces,
  documents, customer orders), the registry documents the same schema.
- Response schemas describe the JSON the route really sends. They were derived by reading each handler and by running the
  server against a seeded workspace; the contract test then checks every response it receives (section 5).

### 3. Response conventions
- **Objects are `.passthrough()`.** A field the schema does not name is allowed. The named fields are the stable ones a client
  may rely on, and they are required with their types. A new field is therefore compatible; a removed or retyped field fails.
- **Money and quantities.** PostgreSQL returns `NUMERIC` and `BIGINT` as strings (`"2.0000"`, `"9800"`). Those fields are
  `Decimal` = `string | number`. A value the code computes as a JS number (a menu price, kitchen units, a template amount in
  the blueprint) is a `number`.
- **Dates** are ISO 8601 strings with an offset (`Date.toJSON`).
- **Casing is documented, not changed.** Rows read with `SELECT *` are snake_case (inventory, suppliers, surfaces, approvals,
  workflows, orders, documents, ledger, audit). Service views are camelCase (customer orders, feedback, menu, tokens,
  connectors, needs-attention, approval decisions). The extraction response carries both. The contract describes what is
  sent. Changing it would break clients and is not part of this change.
- **Errors** are `ErrorBody` = `{ error: string, code?: string, reasonCodes?: string[] }`, passthrough, so a documented extra
  (`fields`, `state`, `nextAction`) is allowed. Health answers 500 `{ status: "error" }`, and readiness answers 503
  `{ status: "not_ready" }`; those are documented as they are.

### 4. The error shape is kept
`{ error, code?, reasonCodes? }` stays the one error shape. Changing it would break clients and roughly a hundred existing
assertions, and nothing in this task needs a different shape. The request id is in the `x-request-id` header (ADR 0032),
not in the body, so error bodies do not grow. The OpenAPI document shares one `ErrorBody` component by `$ref`.

Some messages carry request values, and they are recorded here rather than changed: the surface 403 message includes the
actor id from the event, and the document-confirm 400 names the workspace and document ids. Both are untrusted text echoed
in an error, and both are candidates for a later pass on ADR 0031.

### 5. Generated OpenAPI
- `buildOpenApiDocument(routes, version)` in `src/api/openapi.ts` builds OpenAPI 3.0.3 from the registry, with
  zod-to-json-schema (`zod-to-json-schema@3.24.6`, the newest release whose peer is `zod ^3.24.1`).
- The document has `info` (title `Bind API`, version `API_VERSION`), the `bearerAuth` scheme, per-operation `security`
  (`[]` for public, metrics-token and signed-webhook, which say how they authenticate in the description; `bearerAuth` for
  the rest), path parameters from the `:name` segments, query parameters from the query schema, request bodies, responses,
  tags, and an `x-bind-access` extension.
- The UI catch-all `GET *` is not an API operation, so the document leaves it out (65 operations).
- `API_VERSION` is a constant equal to the package version. A constant, not a read of `package.json`, because the Vercel
  bundle does not guarantee that file is present at run time. A unit test checks the two are equal.
- Output is deterministic: object keys are sorted at every depth, arrays keep their order, and the file ends with a newline.
- `npm run api:spec` (`scripts/generate-openapi.ts`) writes `docs/openapi.json`.
- `GET /api/openapi.json` is public, sends `Cache-Control: no-store`, and builds the same document from the registry at
  request time. The script and the route share the builder, so they cannot drift.
- Optional schemas are converted as their inner schema, so `required` says whether a body is needed. A plain zod object
  allows extra properties, because the server strips unknown fields rather than refusing them. Only `.strict()` is closed.

### 6. Drift guard
- In CI: `npm run api:spec` followed by `git diff --exit-code docs/openapi.json`. A stale committed document leaves a diff,
  and the build fails.
- Locally: the test `docs/openapi.json is current` compares the committed file with a fresh build, byte for byte. The test
  `GET /api/openapi.json equals the committed document` compares the served document with it.

## What the contract guarantees
Checked by `tests/integration/api-contract.test.ts` against the running app, over HTTP, on PostgreSQL:
- Every route in `createApp` has exactly one registry entry, and every entry has a route.
- The access level matches the server. For every non-public route, no token gives 401. For owner routes a staff token gives
  403. For member routes a staff token is accepted by auth. For `authenticated`, a staff token gets 200. For `metrics-token`
  and `signed-webhook`, a workspace token or an unsigned request gets 401. Public routes never answer 401 or 403.
- Every GET route except the UI catch-all is called with the right token, and each response it sends is documented for its
  status and validates against its schema. Lists seeded with rows are checked to be non-empty.
- The state-changing routes with real preconditions are seeded through the server (policy, inventory, replenishment,
  suppliers, agent roles, surface bindings, signed surface and standard events, document extraction and confirmation, kitchen
  capacity, customer orders, feedback, menu proposals, tokens, connectors, the pause switch, approvals, workflow cancel,
  recovery, reconciliation, and the signing-secret rotation). Each response is checked the same way.
- Valid sample bodies are accepted (2xx) for every route whose preconditions are safe to post.
- A wrong-typed or empty body is refused with 400 and an `ErrorBody`. A malformed or oversized body, a second app with the
  rate limit on (429), and a second app with no signing secret (503) each give a documented `ErrorBody`.
- Every route marked `contractTested` was really called by the file. A claim that a route is covered is checked.

## What the contract does not guarantee
- **Lower bounds only.** A response schema requires the named fields and types. It does not say that nothing else is sent,
  and it does not catch an added field. Compatibility additions are not failures by design.
- **No runtime validation.** The registry is not used to validate requests or responses in production. Each route still
  performs its own validation, as before. The schema documents it, and the contract test checks it.
- **Not every status is exercised.** A status a route documents but the test does not reach is not checked by a call. Those
  are the error paths listed per route; the common ones are covered by the error test.
- **Pagination** is not part of the contract yet. Lists are capped (50 or 100 rows); the cap is not documented as a parameter.

## Behaviour changes made in this task (recorded, per AGENTS.md)
No existing success response or error body changed. Existing assertions were not edited, except that one row was added to
the public route table in `tests/integration/auth-tenancy.test.ts` (`GET /api/openapi.json`), because one route was added.
Four routes now validate with their schema, and two of them refuse input they used to accept:
1. `POST /api/workspaces/:id/replenish`: a non-string `sku` (for example a number) was passed to the procurement runner. It
   now gets 400 `sku is required`, the message used for a missing sku.
2. `POST /api/approvals/:id/reject` and `/revoke`: `reason` must be a string of at most 500 characters, the bound on a
   surface event's reason. A longer or non-string reason was recorded before. It now gets 400
   `{ error: "Invalid request body", fields }`, and nothing is decided.
3. `PUT /api/workspaces/:id/agents-paused` and `POST /api/workspaces`: parsed with their schemas. The messages are unchanged.

## How to add a route
1. Implement it in `src/server/app.ts` with the middleware for its access level (`authenticated`, `workspaceMember`,
   `workspaceOwner` or `anyWorkspaceOwner`, or a new one with a recorded decision).
2. Put its request schema in `src/api/schemas.ts` and parse with it in the route, if the route validates inline. Put its
   response schemas there too, if they are shared.
3. Add its `RouteSpec` to `src/api/registry.ts`: access, tags, summary, `body` or `query`, every response with its status, a
   `sampleBody` if a valid body is safe to post, and `contractTested`. Set `contractTested: false` only with a reason.
4. Extend `tests/integration/api-contract.test.ts`: seed the route in `seedWorkspace` if it changes state, or leave it to the
   read sweep if it is a GET, or mark it not tested with a reason.
5. Run `npm run api:spec` and commit `docs/openapi.json`.

A missed step fails a named test: the route-table guard in `auth-tenancy.test.ts`, the exactly-one test, the access test, the
spec-current test, or a response test.

## Routes not contract tested
Only the UI catch-all `GET *` (ADR 0016), which serves the unsupported HTML shell. It is not an API route, and its access is
checked by the access test. The limit `MAX_NOT_CONTRACT_TESTED` in the contract test is 1; raising it needs a reason here.

## Dependencies
- `zod-to-json-schema@3.24.6` (peer `zod ^3.24.1`, the zod 3 line in use). `npm audit --audit-level=high` reports 0
  vulnerabilities. npm rewrote some optional `libc` fields in `package-lock.json` on install (a formatting difference of the
  npm version; no version changed).

## Not done (later parts of Task 12b, or later work)
- The event stream (SSE), the typed SDK, and the MCP server. They are built on this registry in the next parts.
- Runtime validation of requests and responses against the registry.
- Shared row schemas are inlined, so `docs/openapi.json` is about 400 KB. `$ref` components for the rows are a later
  refinement; the document is correct without them.
- `GET /api/openapi.json` builds the document on each request, as specified. If it shows in a profile, cache it on first use.
- Behaviour the contract records but does not change: the ledger GET writes journal entries when it backfills reconciled
  orders (a read with a write); a customer order is created with `201` whatever its decision (`needs_owner`, `declined`),
  so the status code does not carry the decision; the policy route accepts numeric strings through `Number()`, while the
  schema says number; and the webhook route's 200 is a union of two shapes.
- The release evidence (`docs/RELEASE_EVIDENCE.md`) is updated in the release step, not here.

## Evidence
The commands, counts and mutation checks are in the commit message and in the Task 12b report.
