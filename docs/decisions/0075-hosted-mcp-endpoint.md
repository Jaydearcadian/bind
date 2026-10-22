# ADR 0075: A hosted MCP endpoint at POST /mcp, stateless, for staff keys

## Status
Accepted (2026-10-22), amended the same day after review (points 1, 2, 5, 6, 7, 8, 10 and the verification list changed). Extends
ADR 0037 (the MCP tool table and its rules, unchanged: the same seventeen tools and the same startup guard). Uses ADR 0021 (workspace
tokens and roles), ADR 0033 (rate limits), ADR 0025 (APP_BASE_URL, the public base for links), ADR 0035 (the event feed), ADR 0051 and
0058 (account sessions and who-am-I), ADR 0057 (demo workspaces). ADR 0037 said "stdio only, a network transport would need its own
authentication". This ADR is that decision: the authentication is the API's own, so the HTTP transport adds none.

## Context

A business's own agents (Claude, Cursor, other MCP clients) should connect to its Bind workspace by URL, with nothing running on their
side. Until now the MCP server spoke stdio only, so each agent needed the repository and a local process.

## Step 0: what the installed MCP SDK provides (read from `@modelcontextprotocol/sdk` 1.32.1, not from memory)

- `server/streamableHttp.d.ts`: `StreamableHTTPServerTransport` is a Node wrapper over `WebStandardStreamableHTTPServerTransport`.
  `handleRequest(req, res, parsedBody?)` takes the pre-parsed body from Express. `sessionIdGenerator: undefined` is stateless.
- `server/webStandardStreamableHttp.d.ts`: options `enableJsonResponse` (JSON answers instead of an SSE stream), `maxRequestBodySize`
  (4 MiB default; not applied when `parsedBody` is given), and the DNS-rebinding options `allowedHosts`, `allowedOrigins`,
  `enableDnsRebindingProtection`, all marked deprecated in favour of external middleware. This ADR does not use them: the Origin rule is
  in our own middleware (point 7).
- `webStandardStreamableHttp.js`: a stateless transport refuses reuse, so one transport and one server per request. POST needs `Accept`
  to list both `application/json` and `text/event-stream`, and `Content-Type: application/json`, else 406 or 415. GET opens an SSE
  stream when `Accept` lists `text/event-stream`; DELETE closes a session. We answer GET and DELETE ourselves, before the transport, with
  a 405 that names the endpoint.

## Decision

1. **`POST /mcp` on the Express app**, mounted in `createApp` before the unknown-path fallbacks (`src/server/mcp-route.ts`). Stateless,
   JSON answers, one fresh `McpServer` and transport per request, both closed when the response closes. No session id is kept, so any
   serverless instance can answer any request. `GET /mcp` and `DELETE /mcp` answer `405` with `Allow: POST` and a body naming the
   endpoint URL and the header (`code: METHOD_NOT_ALLOWED`); they sit behind the same auth as POST, so an unauthenticated GET is `401`.

   **Vercel.** `vercel.json` rewrites `/mcp` to `/api/index`, after the `/api/(.*)` and `/health` rewrites and before nothing else. No
   static file or directory named `mcp` exists in `web/`, and `cleanUrls` would not map it. `tests/unit/vercel-config.test.ts` reads
   the file and asserts the rewrite exists, that no earlier rewrite matches `/mcp`, that no later rewrite sends it elsewhere, and that
   the function includes `mcp/dist/**` and `docs/openapi.json`. **If database or migration initialisation fails** (`api/_handler.js`),
   `/mcp` answers the same clear `503` as `/api/` (`SERVICE_INITIALIZATION_FAILED`), and is never served against an unmigrated database.
   **NOT_RUN:** a live request to `/mcp` on a Vercel deployment. It is the coordinator's check after deploy.

2. **Staff keys only.** The bearer token goes through the REST API's own `authenticate` middleware: the same hash lookup, revocation and
   demo expiry (`resolveToken`). The route then accepts only `actor.role === "staff"` and a token that is not an account session (its
   actor id is not `ses_…`). An owner key or an account session gets `403` with `Give agents a staff key; owner keys are for people`,
   whatever the session's role: a staff member's `bns_` session is refused by the session check, not by the owner check (tested). No
   token, a malformed one, an unknown one or a revoked one gets `401` in the repo's error body. Why: an owner key can approve what an
   agent requests (ADR 0034, ADR 0037). An agent must not hold that authority, and an account session is a person's sign-in.

3. **The workspace is the token's workspace**, taken from the verified actor (`actor.workspaceId`), not discovered through
   `GET /api/workspaces` as the stdio server does. The token is bound to exactly one workspace by construction. The tool table still
   takes no workspace id, so an agent cannot name another workspace.

4. **Tool calls are in-process HTTP to this same app, over a loopback listener.** On the first MCP request, `mountHostedMcp` creates one
   `http.Server(app)` on `127.0.0.1`, ephemeral port, unref'd, for the life of the process. Its handler marks a request as a loopback call
   (`markLoopback`, `src/server/loopback.ts`) only when the request carries that listener's random per-process secret in the
   `x-bind-loopback` header. The factory (`mcp/src/hosted.ts`) builds a `BindClient` whose fetch adds two headers to every call: the
   secret, and `x-request-id` set to the `/mcp` request's id, so the API call and the rows it writes carry the same id as the `/mcp` request.
   An abort signal is passed to every call and fires when the client goes away before the answer (point 6). The tools call the REST
   routes as any client does, so every role check, tenancy rule (`scopeToWorkspace`, `404` for another workspace), idempotency rule and
   audit row is the REST code's. Why this and not the alternatives:
   - *A public URL to self.* It sends the caller's token out through the edge and back in, depends on DNS, TLS and the platform's
     firewall, adds a round trip per call, and the public address is not known to the function in every deployment.
   - *Calling the Express handler with fabricated request and response objects.* Express and its response helpers read the socket and
     stream fields, so faking them is fragile across releases. Rejected.
   - *The loopback listener* costs one listen per process, paid on the first MCP request of an instance. It keeps the path identical to a
     real client. Accepted.
   The token goes only to `127.0.0.1` and only into this app. Its host and forwarded headers are never read: the origin is the constant
   listener address (tests send spoofed `Host`, `X-Forwarded-Host` and `X-Forwarded-Proto` and assert the loopback origin is unchanged).
   The token is never logged: the route's log objects carry the tool name, the outcome, the status, the code, the request id and the
   token id, and a test spies on the logger's inputs (not only its output) to assert the raw token is never passed to it.

5. **One JSON-RPC message per request; batches are refused.** An array body gets `400` with `Batch requests are not supported: send one
   JSON-RPC message per request` in the repo's error format, before any tool runs. Why: a batch would run several tool calls under one
   request, which the per-request accounting and the audit row (point 10) are not built for. Limits: `initialize` and `tools/list` cost one
   per-token hit. A `tools/call` costs exactly two: the `/mcp` request (counted by the route's `tokenRateLimit`) and its API call (counted
   by the API route's `tokenRateLimit`).

6. **The MCP module is built by `mcp/` and loaded, not compiled into the API build.** The API build is rooted at `src/`
   (`tsconfig.build.json`), and nothing under `src/` imports `sdk/` or `mcp/`. So `mcp/src/hosted.ts` is compiled by `npm run mcp:build`
   and the deployment entry points load it: `api/_handler.js` with a literal `import("../mcp/dist/mcp/src/hosted.js")` (the bundler
   traces it), and `src/index.ts` with the same path relative to `import.meta.url`. `createApp` takes the loader as `options.hostedMcp`.
   Without a loader the route answers `503`. A loader that rejects answers `503` for each request, is retried on the next request, and
   never crashes the process. `scripts/vercel-build.sh` runs `npm run mcp:build`.

7. **The origin of the endpoint, and the Origin rule.** The endpoint address and the Origin check use one origin, in this precedence:
   1. `BIND_PUBLIC_URL`, when set. It must be an https origin with no path, query or credentials (`http` only for `127.0.0.1` and
      `localhost`). An invalid value stops startup.
   2. Else `APP_BASE_URL`, when it was set explicitly (not the localhost default) and is an https origin. This lets an owner set one public
      address, since APP_BASE_URL is also the link base for email (ADR 0025). An APP_BASE_URL that is not usable is ignored, with a warning.
   3. Else the request's own scheme and host. Behind Vercel the scheme seen by Express may be `http` (`BIND_TRUST_PROXY` is 0), so this
      origin is wrong there. In production with none of the above set, the app logs one startup warning naming `BIND_PUBLIC_URL`.

   A request with an `Origin` header is refused with `403` unless its origin equals that origin exactly (the scheme included). Agents
   are not browsers and send none. `Origin: null` is refused. No CORS headers are added. Limitation: with no configured origin, the Host
   header is the client's, and a rebinding page's Origin matches its own Host, so the check alone does not stop DNS rebinding. The bearer
   token is still required, and a page that rebinds cannot read it. Production sets `BIND_PUBLIC_URL`.

8. **Rate limits: the one gate, and the loopback exception.** `/mcp` runs through the global `rateLimitGate` like every path:
   `authFailures` counts its 401s per address, so an unauthenticated flood is refused by the same limiter, including with a valid key
   afterwards. After `authenticate`, `tokenRateLimit` counts the request against the token (`apiPerToken`). The loopback calls are not
   counted against the loopback address: the gate returns early for a marked request (point 4), so one tenant's failures can never put
   `127.0.0.1` into the auth-failure block for another. The loopback calls still pass the API route's per-token limit. An external flood of
   401s still blocks, as before (tested: ten failures, then the eleventh is refused, and a good key is refused too). Because every key is
   keyed by `req.ip`, `BIND_TRUST_PROXY` must be set to the real number of proxy hops whenever `/mcp` is exposed: at `0` behind a proxy,
   every client shares the proxy's address and one client's failures block all of them (runbook 9, 10.3).

9. **Body and method limits.** The app's `express.json` limit (256 KB) applies to `/mcp`, so an oversized body is `413` before any tool
   runs. A non-JSON content type is `415` from the transport. Other methods get the app's standard 404.

10. **Attribution: one audit row per finished write.** A `tools/call` of a tool that is not read-only (`readOnly: false` in the tool table)
    writes exactly one row when the call finishes, before the answer is sent. Its shape:
    - `action`: `agent.tool_called` (registered in `src/api/event-catalogue.ts`, `docs/ecosystem/spec/event-names.json` and `docs/EVENTS.md`).
    - `actor_type`: `staff_key` (new; the schema comment lists the older types, which are unchanged). `actor_id`: the token id (`tok_…`),
      never the token.
    - `effect_class`: the tool's effect (`external_request` or `commercial_commitment`).
    - `policy_decision`: `ALLOW` when the API accepted the call, `DENY` when it refused it or the call failed.
    - `evidence`: `{ "label": <the key's label, redacted with the same redaction as other labels and cut to 80 characters>, "tool": <tool name>, "outcome": "ok" | "error", "status": <the API's HTTP status for a refusal, or null for a success> }`. `status` is null on success because the SDK returns the body only. Never the token, the arguments or the answer.
    - `request_id`: the `/mcp` request's id. It is the id of the API call the tool made, so the downstream row (for example `feedback.ingested`)
      carries the same `request_id`, and the two join.

    Read tools write no row. A failure to write the row is logged (`mcp.tool_record_failed`, the error name only) and the answer is still
    returned, because the API call has already happened. This is a known gap: an agent's write can happen without its row if the database
    fails at that moment. The row is durable once written, like every other audit row.

    **Activity feed.** `agent.tool_called` is not owner-only, so staff see it, as they see `notification.*`: the rule (`src/api/events.ts`) hides
    only `auth.`, `connector.` and `kitchen_capacity.` from staff. The feed's evidence allowlist passes `status` and drops `label`, `tool` and
    `outcome`, so a staff member sees the event, the key's id as the actor, and the status. The label and tool are in the audit row, which the
    audit route (`GET /api/workspaces/:id/audit`, a member route) returns to staff and owner alike. Before this ADR, staff writes were labelled with the agent role or a `system:` actor, and only token issue and revoke
    carried the token's label. Those rows are unchanged; the new row is the attribution.

11. **Route inventory, stated honestly.** `tests/integration/auth-tenancy.test.ts` lists `POST`, `GET` and `DELETE /mcp` in
    `STAFF_KEY_ROUTES`, which feeds the "no token gives 401" and "every route is listed" checks. `tests/integration/api-contract.test.ts` has
    one named exemption, `NOT_REST_OPERATIONS`, for those three keys: the endpoint is not a REST operation, so it has no OpenAPI entry. The
    assertion is otherwise unchanged. The registry, `docs/openapi.json` and the SDK are not touched: `api:spec`, `sdk:generate` and
    `capabilities:generate` were run and produced no diff.

12. **Results are untrusted data.** The result shaping in `mcp/src/format.ts` is unchanged: each answer lists its `untrustedTextFields`,
    and nothing in the envelope echoes a token.

## Verification (LOCAL_PASS, on a private database)

- `tests/integration/hosted-mcp.test.ts` (23 tests) and `tests/integration/hosted-mcp-hardening.test.ts` (12 tests): the real app and
  PostgreSQL, through the SDK's Streamable HTTP client and raw HTTP. Covered: the tool list equals the stdio table; no approval, payment,
  credential or token tool by name; reads and writes with their real effects; a duplicate is a no-op; a paused workspace answers as REST
  does; `401` for no, malformed and revoked keys; `403` with the message for an owner key, an owner's account session and a staff
  account session; tenant isolation; concurrent requests with two keys never mix, including with one request held inside the server;
  `Origin` refused and own origin allowed, with and without `BIND_PUBLIC_URL`; spoofed `Host` and forwarded headers do not change the
  loopback origin; `413`; `415`; a batch is `400`; `GET` and `DELETE` answer `405` with the endpoint, `401` without a key and `403` for an
  owner or a session; `Cache-Control: no-store`; the token is never passed to the logger and appears in no response; a demo's staff key works
  and stops after expiry; an unwired app answers `503` and keeps the API; a failed load answers `503` and recovers; a client that goes away
  aborts the request's signal; the per-token and auth-failure limits apply to `/mcp`, and loopback calls do not block an address while an
  external flood still does; a write produces exactly one `agent.tool_called` row joined to the downstream row by request id, a read produces
  none, and the token is absent from the row.
- `tests/unit/hosted-abort.test.ts`: an aborted API call is made once and not retried.
- `tests/unit/hosted-public-origin.test.ts`: the precedence, the production warning, the feed visibility of `agent.tool_called`.
- `tests/unit/vercel-config.test.ts`: the `/mcp` rewrite, its shadowing, the static-file check, the include set.
- The stdio server's suite (`tests/integration/mcp.test.ts`) still passes.
- **NOT_RUN:** live checks against Claude, Cursor or other MCP clients; a Vercel deployment (the coordinator's check after deploy).

## Not done (and why)

- **OAuth for clients that cannot send an `Authorization` header** (for example a ChatGPT connector). It needs an authorization server and
  a consent flow, a separate decision.
- **Per-agent scopes and budgets.** A staff key has the same tools as any staff key.
- **Per-agent last-seen.** The endpoint records no "last used" time for a key.
- **SSE streaming and resumability.** Answers are JSON; server-initiated messages are not sent; the GET stream is answered 405, as the spec
  allows for a server that does not offer one.
- **Failed attribution does not fail the call** (point 10). Making it fail would turn a completed external effect into a reported error.
- **Live checks against Claude, Cursor or other clients: NOT_RUN.**
- **A Vercel deployment: NOT_RUN.** The rewrite, the include set and the handler are verified locally; the live request is the
  coordinator's check. A real cold start with the loopback listener under the platform is not verified.
