# ADR 0075: A hosted MCP endpoint at POST /mcp, stateless, for staff keys

## Status
Accepted (2026-10-22). Extends ADR 0037 (the MCP tool table and its rules, which are unchanged: the same seventeen tools and the
same startup guard). Uses ADR 0021 (workspace tokens and roles), ADR 0033 (rate limits), ADR 0051 and 0058 (account sessions and
who-am-I), ADR 0057 (demo workspaces). ADR 0037 said "stdio only, a network transport would need its own authentication". This
ADR is that decision: the authentication is the API's own, so the HTTP transport adds none.

## Context

A business's own agents (Claude, Cursor, other MCP clients) should connect to its Bind workspace by URL, with nothing running on
their side. Until now the MCP server spoke stdio only, so each agent needed the repository and a local process.

## Step 0: what the installed MCP SDK provides (read from `@modelcontextprotocol/sdk` 1.32.1, not from memory)

- `server/streamableHttp.d.ts`: `StreamableHTTPServerTransport` is a Node wrapper over `WebStandardStreamableHTTPServerTransport`.
  `handleRequest(req, res, parsedBody?)` takes the pre-parsed body from Express. `sessionIdGenerator: undefined` is stateless.
- `server/webStandardStreamableHttp.d.ts`: options `enableJsonResponse` (JSON answers instead of an SSE stream),
  `maxRequestBodySize` (4 MiB default; not applied when `parsedBody` is given), and the DNS-rebinding options `allowedHosts`,
  `allowedOrigins`, `enableDnsRebindingProtection`, all marked deprecated in favour of external middleware. This ADR does not use
  them: the Origin rule is in our own middleware (below).
- `webStandardStreamableHttp.js`: a stateless transport refuses reuse (`Stateless transport cannot be reused across requests`), so
  one transport and one server per request. POST needs `Accept` to list both `application/json` and `text/event-stream`, and
  `Content-Type: application/json`, else 406 or 415. GET opens an SSE stream when `Accept` lists `text/event-stream`; DELETE closes a
  session. Any other method gets the SDK's own 405. We answer GET and DELETE ourselves, before the transport, with a 405 that
  names the endpoint.

## Decision

1. **`POST /mcp` on the Express app**, mounted in `createApp` before the unknown-path fallbacks (`src/server/mcp-route.ts`).
   Stateless, JSON answers, one fresh `McpServer` and transport per request, both closed when the response closes. No session id is
   kept anywhere, so any serverless instance can answer any request. `GET /mcp` and `DELETE /mcp` answer `405` with `Allow: POST`
   and a body naming the endpoint URL and the header (`code: METHOD_NOT_ALLOWED`). They sit behind the same auth as POST, so an
   unauthenticated GET is `401`. The route is registered with `app.get`/`app.post`/`app.delete`, so the async-handler wrapper and
   the route inventory tests see it.

2. **Staff keys only.** The bearer token goes through the REST API's own `authenticate` middleware: the same hash lookup, the same
   revocation, the same demo expiry (`resolveToken`). After that, the route accepts only `actor.role === "staff"` and a token that
   is not an account session (`ses_` actor id). An owner key or an account session (`bns_`) gets `403` with
   `Give agents a staff key; owner keys are for people`. No token, a malformed one, an unknown one or a revoked one gets `401` in the
   repo's error body. Why: an owner key can approve what an agent requests (ADR 0034, ADR 0037). An agent must not hold that
   authority, and an account session is a person's sign-in. An owner who wants an agent to act gets a staff key for it.

3. **The workspace is the token's workspace**, taken from the verified actor (`actor.workspaceId`), not discovered through
   `GET /api/workspaces` as the stdio server does. Chosen because the token is bound to exactly one workspace by construction, so the
   answer of the discovery call is already known, and one request less is one less failure to handle. The tool table still takes no
   workspace id, so an agent cannot name another workspace.

4. **Tool calls are in-process HTTP to this same app, over a loopback listener.** `mountHostedMcp` creates, on the first MCP request,
   one `http.Server(app)` listening on `127.0.0.1` on an ephemeral port, unref'd, and keeps its origin for the life of the process.
   The factory (`mcp/src/hosted.ts`) builds a `BindClient` with that origin and the caller's token, and the tools call the REST routes
   as any client does. So every role check, tenancy rule (`scopeToWorkspace`, 404 for another workspace), idempotency rule and audit
   row is the REST code's. Why this and not the alternatives:
   - *A public URL to self.* It sends the caller's token out through the edge and back in again, depends on DNS and TLS and the
     platform's firewall, and adds a network round trip per tool call. The public address is also not known to the function in
     every deployment (`BIND_PUBLIC_URL` is optional).
   - *Calling the Express handler with fabricated request and response objects.* Express and its response helpers read the socket and
     several stream fields. Faking them is fragile across Express releases, and the usual library for it (`light-my-request`) is not a
     dependency. Rejected.
   - *The loopback listener* costs one listen per process, which is a cold-start cost only on the first MCP request of an instance.
     It keeps the code path identical to a real client. Accepted.
   The token goes only to `127.0.0.1` and only into this app. It is never logged (the tool log carries the tool name, the outcome, the
   status, the code and ids), never returned, and never in an error (`redactText` in the factory's results, the same as stdio).

5. **The MCP module is built by `mcp/` and loaded, not compiled into the API build.** The API build is rooted at `src/`
   (`tsconfig.build.json`), and nothing under `src/` imports `sdk/` or `mcp/`. Moving the tool table into `src/` would have pulled the SDK
   sources across that root. So `mcp/src/hosted.ts` is compiled by `npm run mcp:build` (rootDir is the repository) and the deployment
   entry points load it: `api/_handler.js` with a literal `import("../mcp/dist/mcp/src/hosted.js")` (the bundler traces it), and
   `src/index.ts` with the same path relative to `import.meta.url`. `createApp` takes the loader as `options.hostedMcp`. Without a loader
   the route answers `503`. A loader that rejects answers `503` for each request, is retried on the next request, and never crashes the
   process. `scripts/vercel-build.sh` runs `npm run mcp:build`.

6. **The contract file is loaded fail-closed.** The tool table's access check reads `docs/openapi.json` (ADR 0037), so `vercel.json`
   `includeFiles` is `{dist/**,mcp/dist/**,docs/openapi.json}`. The file is read once per process and not cached on failure. A missing
   or unreadable file makes the factory throw, so the request gets a `503` and the rest of the API keeps working. The brace form
   follows Vercel's documented glob syntax (`excludeFiles` examples use `{a/**,b/**}`).

7. **Origin rule against DNS rebinding.** A request with an `Origin` header is refused with `403` unless its origin equals the
   deployment's own origin: `BIND_PUBLIC_URL` when set, otherwise `<request protocol>://<Host>`. Agents are not browsers and send no
   `Origin`. No CORS headers are added. `Origin: null` is refused. Limitation: without `BIND_PUBLIC_URL`, the Host header is the
   client's, and a rebinding page's Origin matches its own Host, so the check alone does not stop rebinding. The bearer token is still
   required, and a page that rebinds cannot read it. Production should set `BIND_PUBLIC_URL`. `BIND_PUBLIC_URL` must be an https origin
   with no path, query or credentials (`http` only for `127.0.0.1`, `localhost`), and an invalid value stops startup.

8. **Rate limits: the one gate.** `/mcp` runs through the global `rateLimitGate` like every path (`authFailures` counts its 401s
   per address, so an unauthenticated flood is refused by the same limiter, including with a valid key afterwards). After
   `authenticate`, `tokenRateLimit` counts the request against the token (`apiPerToken`). Each tool call therefore costs two hits:
   the MCP request and the API request it makes. This is accepted and is documented in the runbook. The loopback calls come from
   `127.0.0.1`, so the per-address scopes see them as one address. Those scopes are only hit by the API's own 401s, which in practice
   happen only when a key is revoked between the two requests. Accepted.

9. **Body and method limits.** The app's `express.json` limit (256 KB) applies to `/mcp`, so an oversized body is `413` before any tool
   runs. A non-JSON content type is `415` from the transport. Other methods get the app's standard 404.

10. **Audit.** Writes made through a tool are audited by the REST code, with the request id of the API call (verified in the
    integration test on `submit_feedback`). Note: the current REST code labels staff writes with the agent role or a `system:` actor,
    not with the staff token's label. Only token issue and revoke carry the token's label. This ADR does not change that existing
    behaviour, so the audit row for an agent's write does not name which agent key made it. Recorded as a gap (see below).

11. **Route inventory, stated honestly.** `tests/integration/auth-tenancy.test.ts` lists `POST`, `GET` and `DELETE /mcp` in
    `STAFF_KEY_ROUTES`, which feeds the "no token gives 401" and "every route is listed" checks. `tests/integration/api-contract.test.ts`
    has one named exemption, `NOT_REST_OPERATIONS`, for those three keys: the endpoint is not a REST operation, so it has no OpenAPI
    entry. The assertion is otherwise unchanged. The registry, `docs/openapi.json` and the SDK are not touched, so no drift gate moves.

12. **Results are untrusted data.** The result shaping in `mcp/src/format.ts` is unchanged: each answer lists its `untrustedTextFields`,
    and nothing in the envelope echoes a token. The factory's secrets (the token) are passed to the same redaction.

## Verification (LOCAL_PASS)

- `tests/integration/hosted-mcp.test.ts`: 23 tests against the real app and PostgreSQL, through the SDK's Streamable HTTP client and raw
  HTTP. They cover: the tool list equals the stdio table; no approval, payment, credential or token tool by name; a read and a write
  with their real effects (the feedback row and its audit row); a duplicate is no-op; a paused workspace answers as REST does; `401` for
  no, malformed and revoked keys; `403` with the message for an owner key and for an account session; tenant isolation (another
  workspace's key sees only its own data, REST `404` on the other workspace); concurrent requests with two keys never mix workspaces;
  `Origin` refused and own origin allowed; `413` for an oversized body; `415`; `GET` and `DELETE` answer `405` with the endpoint, `401`
  without a key; `Cache-Control: no-store`; the token string appears in no response body and no log line; a demo's staff key works and
  stops after expiry; an unwired app answers `503` and keeps the API; a failed load answers `503` and recovers; the access table
  fails closed on a missing file; `BIND_PUBLIC_URL` validation; and the per-token and auth-failure limits apply to `/mcp`.
- The stdio server's suite (`tests/integration/mcp.test.ts`) still passes. `npm run mcp:build` passes. The built Vercel handler
  (`api/_handler.js` over `dist/` and `mcp/dist/`) answers `initialize` with 200, lists 17 tools and answers `GET` with 405
  (scratch script, not committed).

## Not done (and why)

- **OAuth for clients that cannot send an `Authorization` header** (for example a ChatGPT connector). This needs an authorization
  server, consent screens and token exchange, which are a separate decision. Such clients cannot use this endpoint.
- **Per-agent scopes and budgets.** A staff key has the same tools as any staff key. A per-agent narrowing needs its own design.
- **Per-agent last-seen.** The endpoint records no "last used" time for a key.
- **SSE streaming and resumability.** Answers are JSON. Server-initiated messages (progress, notifications) are not sent, and there is
  no event store. The GET stream is answered 405, as the spec allows for a server that does not offer one.
- **Live checks against Claude, Cursor or other clients: NOT_RUN.** The tests use the SDK's own client and raw HTTP. No real client
  has connected to a deployment.
- **A Vercel deployment: NOT_RUN.** The build script and the function's file set are verified locally (`vercel-build.sh` exits 0; the
  `includeFiles` pattern matches `docs/openapi.json` and `mcp/dist/mcp/src/hosted.js`); the handler is smoke-tested in Node. A real
  deployment's cold start and loopback listener under Fluid compute are not verified.
- **Per-workspace staff audit labels.** See point 10: REST staff writes are not labelled with the token label. Changing that is a REST
  audit change and is out of scope here.
