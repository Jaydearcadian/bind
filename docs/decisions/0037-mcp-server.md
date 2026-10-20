# ADR 0037: An MCP tool server over the Bind SDK, with no approval, payment or credential tools

## Status
Accepted (2026-10-20). Implements part 4 of Task 12b of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`
(the MCP server). Builds on ADR 0016 (the API is the product surface), ADR 0021 (workspace tokens and roles), ADR 0034 (the
registry and `x-bind-access`), and ADR 0036 (the SDK). `src/ui/` is not touched (ADR 0016).

## Step 0: what the installed MCP SDK provides (read from the package, not from memory)

Installed: `@modelcontextprotocol/sdk` **1.32.1** (the newest 1.x release at install time; 1.32.1 was published 2026-10-05).
`npm audit --audit-level=high` reports 0 vulnerabilities after the install.

Import paths and signatures used by this server (verified in `node_modules/@modelcontextprotocol/sdk/dist/esm`):
- `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"`
  - `new McpServer(serverInfo: { name, version }, options?: { maxToolInputElements?: number, ...ServerOptions })`.
  - `registerTool(name, config: { title?, description?, inputSchema?, outputSchema?, annotations?, _meta? }, cb)`. `inputSchema`
    is either a zod raw shape or a zod object schema. A zod object is used here so that `.strict()` takes effect: a raw shape
    is wrapped in a non-strict object and would strip unknown keys silently instead of refusing them.
  - The callback returns a `CallToolResult`: `{ content: [{ type: "text", text }], isError?: boolean }`.
- `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"`: `new StdioServerTransport()`, reads
  `process.stdin`, writes `process.stdout`.
- `import { Client } from "@modelcontextprotocol/sdk/client/index.js"`: `connect(transport)`, `listTools()`,
  `callTool({ name, arguments })`, `close()`.
- `import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"`: `new StdioClientTransport({ command, args,
  env, stderr })`. When `env` is given it is merged over the SDK's safe default variables (PATH, HOME and similar), not used alone.
- `import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"`: `InMemoryTransport.createLinkedPair()` returns
  `[serverSide, clientSide]`.
- `ToolAnnotations` (in `types.js`): `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, all optional
  booleans except `title`. They are returned unchanged by `tools/list`.

Behaviour verified by running the installed package (a probe in the scratchpad, not committed):
- A strict zod object is advertised as JSON Schema with `additionalProperties: false`, `maxLength`, `minimum`, `maximum`.
- A bad argument is returned as a tool error, not thrown: `isError: true`, text
  `MCP error -32602: Input validation error: Invalid arguments for tool <name>: <zod messages joined by newlines>`.
  Zod's default messages echo the unknown key's name (`Unrecognized key(s) in object: '...'`) and an invalid enum's value.
  Every validator here therefore has its own message (for example `.strict("unknown field")`), so no input value is echoed.
- An unknown tool name is also a tool error, not a thrown error: `isError: true`, `Tool <name> not found`.
- A handler that throws is returned as a tool error with the thrown message. The handlers here never throw an API message.
- Arguments that are not a JSON object are refused by the protocol layer (a JSON-RPC error), before any tool runs.

Dependency facts:
- The SDK declares `zod` as a peer `^3.25 || ^4.0` and imports `zod/v3` and `zod/v4` internally. The repository's `zod` 3.25.76
  satisfies it; this server imports `zod` (the v3 API) from the same package.
- The SDK depends on `zod-to-json-schema ^3.25.1`. The repository depends on `zod-to-json-schema` for the OpenAPI document
  (ADR 0034), pinned at 3.24.6. A plain install would have moved the shared copy to 3.25.2, which changes what the
  OpenAPI builder is run against. The root dependency is therefore pinned exactly to `3.24.6`, and npm installs 3.25.2 nested
  under `@modelcontextprotocol/sdk` only. `docs/openapi.json` is unchanged by the install (the drift test verifies it).

## Layout, and one deviation from the brief

- `mcp/src/server.ts`: `createBindMcpServer`.
- `mcp/src/tools.ts`: the tool table, the operation allowlist and the startup guard.
- `mcp/src/access.ts`: reads the access table from `docs/openapi.json` (`x-bind-access`).
- `mcp/src/format.ts`: the result envelope, truncation, error results, and secret scrubbing.
- `mcp/src/logger.ts`: one JSON line per entry to stderr, with redaction.
- `mcp/src/main.ts`: the stdio entry point and configuration.

**Deviation.** The brief puts the compiled entry at `mcp/dist/main.js`. The server imports the SDK from `../../sdk/src/index.js`
(the brief's rule), which is outside `mcp/src`. TypeScript then places the output under the common root of both trees, so the
compiled entry is `mcp/dist/mcp/src/main.js` and the SDK's compiled files are under `mcp/dist/sdk/src/`. `bin`, `mcp:start` and
the packaging test use `mcp/dist/mcp/src/main.js`. Moving the entry to `mcp/dist/main.js` would need a copy or a shim, and
neither is worth it for a private package.

## The access table and the startup guard

- `docs/openapi.json` carries `x-bind-access` for every operation (ADR 0034). `loadAccessTable()` reads it when the server is created. It
  searches upward from the module's own folder for `docs/openapi.json`, and it fails closed (throws) when the file is missing or
  unreadable. The MCP does not import anything from `src/`.
- `assertToolTable(tools, access)` runs in `createBindMcpServer` before any tool is registered. It throws when:
  1. a tool's `operationId` is not in the static allowlist `ALLOWED_OPERATION_IDS` (in `tools.ts`);
  2. an allowlisted operation is not in the SDK's `OPERATIONS` table;
  3. an allowlisted operation's `x-bind-access` is not `member`;
  4. two tools share a name, or a tool has no name.
  Rule 3 is what keeps an owner-only operation out: even if someone adds it to the allowlist, the guard refuses it unless its
  access is `member`.

## Tool table

Effect classes are the server's own (`src/policy/effect-classifier.ts`): `read`, `external_request`, `commercial_commitment`.
Every tool's MCP annotations are `destructiveHint: false` and `openWorldHint: false`. Reads are `readOnlyHint: true`.

| Tool | Effect | operationId | Access | Notes |
|---|---|---|---|---|
| `get_workspace` | read | `getWorkspace` | member | |
| `list_inventory` | read | `listInventory` | member | |
| `list_approvals` | read | `listApprovals` | member | Read only. Deciding an approval is not provided. |
| `list_orders` | read | `listOrders` | member | |
| `list_workflows` | read | `listWorkflows` | member | |
| `needs_attention` | read | `getNeedsAttention` | member | |
| `list_customer_orders` | read | `listCustomerOrders` | member | |
| `list_menu` | read | `listMenu` | member | |
| `list_menu_proposals` | read | `listMenuProposals` | member | Read only. Approving or publishing is not provided. |
| `feedback_summary` | read | `getFeedbackSummary` | member | Optional `since` (date-time). |
| `list_audit` | read | `listAudit` | member | |
| `poll_events` | read | `pollEvents` | member | Optional `after` cursor, `limit` 1 to 100. |
| `request_replenishment` | commercial_commitment | `replenish` | member | Starts the normal replenishment workflow. The policy gate, the approval threshold and the spending limits are the server's. The result may be an approval waiting for an owner. |
| `create_customer_order` | commercial_commitment (when accepted) | `createCustomerOrder` | member | The server decides: it may hold the order for the owner (`needs_owner`) or decline it. |
| `cancel_customer_order` | commercial_commitment (cancelling an accepted order) | `cancelCustomerOrder` | member | |
| `submit_feedback` | external_request | `ingestFeedback` | member | Stores external text. A repeated source and external id is a duplicate, so the call is idempotent. |
| `propose_menu_change` | external_request | `proposeMenuChange` | member | Creates a proposal that stays `proposed` until an owner acts on it through the API. |

## Never provided, and how that is enforced

Not provided, even with an owner token (the MCP does not hold any owner operation):
- approving, rejecting or revoking an approval (`approveApproval`, `rejectApproval`, `revokeApproval`);
- reconciling an order or confirming a settlement (`reconcileOrder`, `confirmOrderSettlement`);
- cancelling a workflow (`cancelWorkflow`), recovering workflows (`recoverWorkflows`);
- policy, suppliers, agent roles, surface bindings, kitchen capacity, the agents pause switch (`updatePolicy`, `upsertSupplier`,
  `upsertAgentRole`, `upsertSurfaceBinding`, `setKitchenCapacity`, `setAgentsPaused`);
- accepting a held customer order (`acceptCustomerOrder`);
- approving, rejecting, cancelling or publishing a menu proposal (`approveMenuProposal`, `rejectMenuProposal`,
  `cancelMenuProposal`, `publishMenuProposal`);
- tokens, connectors and credentials, webhook secrets (`issueToken`, `listTokens`, `revokeToken`, `listConnectors`, `setConnector`,
  `revokeConnector`, `verifyConnector`, `getWebhookSecret`, `rotateWebhookSecret`);
- signing or broadcasting anything: the MCP has no key material and no chain client, and the SDK has no such operation.

Enforcement, in three layers:
1. The allowlist is the only source of operation ids, and the guard rejects anything outside it or not `member`.
2. The server enforces every check again. A staff token gets the server's 403 for owner routes, and the MCP's tools are member routes
   only. The MCP never sends a token of its own choosing: it uses the one it was started with.
3. The integration test sends the owner token through the same tool list and asserts the same 17 names and no owner operation.

## Authentication model

The MCP has no authority of its own. Every tool call is an ordinary API call made with `BIND_API_TOKEN`, so the token's role,
the workspace's tenancy, the policy gate and the rate limits all apply as they do for any client. Revoking the token makes every
tool fail with `401`, and the server keeps running (it does not cache a success).

Use a **staff** token for an agent, never an owner token. The tools would accept an owner token, and it would change what they do:
the comment in `src/server/app.ts` at the menu proposal route (ADR 0028) says that an owner's token proposes a menu change as the
owner, so a pause does not block it, while a staff token proposes as the menu agent and the pause applies. An owner token can also
decide approvals, which an agent must never reach. The staff role is the boundary the design relies on; the server enforces it.

## Untrusted output

Every successful result is a single text item holding JSON:
`{ "source": "bind-api", "workspaceId": "...", "untrustedTextFields": [...], "data": ... }`.
`untrustedTextFields` lists the JSON paths of free text written by customers, suppliers or staff (notes, feedback, menu names and
descriptions, supplier names, audit reasons and actor labels, workflow error messages). Each tool's description says the same.
The text is data. An agent must not treat it as instructions, and the integration test checks that feedback which asks for an
approval or a publication changes nothing.

Output caps: an array longer than 100 items is cut to 100, and a string longer than 2,000 characters is cut to 2,000. The envelope
then carries `"truncated": true` and `"truncatedPaths"`, one entry per cut value with its original length or count.

Errors: a `BindApiError` becomes a tool error whose text is JSON with `status`, `code`, `message`, `requestId` and `reasonCodes`
only. A network failure or a timeout becomes the fixed text `Bind API unreachable`. Any other failure becomes a fixed text. The
token, an `Authorization` header and any URL with a query never appear in a result, a tool error or a log line. The output is
also scrubbed of the configured secrets and of any `bnd_` token pattern, as a second line of defence.

## Stdio only, and stderr logging

- Transport: stdio only. A network (Streamable HTTP) transport is **not** provided. It would need its own authentication layer
  (who may call the MCP, and with which token), which is a separate decision and not part of this slice. Exposing the MCP on a
  port with a Bind token as the only credential would let anyone who can reach the port act with that token.
- Stdout is reserved for the protocol. Every log line goes to stderr as one JSON object, redacted (the token and any `bnd_`
  pattern are replaced in every value and key). A tool call logs its tool name, outcome, duration, status, code and request id,
  never its arguments or its results.
- Startup configuration: `BIND_API_URL` and `BIND_API_TOKEN` are required. A missing or malformed value exits with status 1 and a
  message naming the variable, never its value. The workspace is not configured: at startup the MCP calls `GET /api/workspaces`,
  which returns only the caller's workspace, and uses the single result. Zero or several results exit with status 1.

## What is NOT done

- No network transport (see above).
- No MCP resources and no prompts; the tools are the whole surface.
- No per-tool rate limits beyond the API's own (ADR 0033). The per-token limit applies, and a `429` surfaces as a tool error with
  its code. The SDK retries a GET once after a short `Retry-After`; a write is never retried.
- No automated test against a real model client. The tests drive the server with the SDK's own client over an in-memory transport
  and over stdio. Whether a model uses the tools well is not measured.
- Input bounds are narrower than the API's, on purpose: `quantity` is an integer from 1 to 10000 (the API takes any number);
  `priceCents` is an integer from 0 to 1,000,000; `lines` has at least one line; `text` and `note` have a minimum length of 1
  where the API has none; `sku` is at most 120 characters, as the other SKU fields are (the API sets no maximum for it). A request
  outside these bounds is refused by the MCP before any call.
- No dependency on `src/`: the MCP reads the contract (`docs/openapi.json`) and calls the API. It does not import the server.

## Findings about the API (recorded, not changed here)

Found by calling the live API while writing the integration tests (`src/` is not edited by this change):
- `POST /api/workspaces/:id/replenish` refused a paused workspace with `400` and **no structured code**. The code is written into
  the message text as `[AGENTS_PAUSED] The owner has paused...` (`src/workflows/procurement.ts`), and `reasonCodes` is absent. The
  MCP reports the answer as it is, and its test asserts the bracketed code in the message. A structured `code` for this route is a
  follow-up for the API (ADR 0034 lists the error-body follow-up).
- `GET /api/workspaces/:id/feedback/summary?since=` takes a date-time with an offset (`2026-01-01T00:00:00Z`). A date alone is
  refused with `400`. The MCP accepts the same form.
- The SDK has no convenience wrapper for `listMenuProposals`. The MCP calls every operation through `client.call`, which is
  typed by operation id, so the tools do not depend on which wrappers exist.
- A staff token's menu proposal goes through the menu agent role (`ROLE_NOT_PERMITTED` as `403` when that role is disabled), and an
  owner token's proposal does not (`src/server/app.ts`, ADR 0028). The MCP is therefore given staff tokens only (see Authentication).

## Consequences

- An agent gets a bounded set of 17 tools, each one a single API call, none of which can approve, pay, reconcile, change policy
  or touch a credential, whatever the token's role.
- The guard makes an owner operation a startup error, not a silent addition.
- The MCP depends on the checkout for `docs/openapi.json`. It fails closed when that file is missing.
- A new API route that should be exposed needs a new tool, an allowlist entry, and `member` access in the contract. Nothing is
  exposed by default.

## Evidence

Commands run on this commit's tree (PostgreSQL local, no network dependency beyond the npm registry):
- `npm run lint`: clean (eslint over src/, tests/, sdk/src/, mcp/src/).
- `npm run typecheck`: exit 0 (root, sdk and mcp projects).
- `npm run test:unit`: 44 files, 312 tests passed (the 12 in `tests/unit/mcp.test.ts` among them).
- `npm run test:integration`: 49 files, 497 tests passed (the 11 in `tests/integration/mcp.test.ts` among them).
- `npm run build`, `npm run sdk:build`, `npm run mcp:build`: exit 0.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `npm run map:functions`: 1376 functions, 67 routes; `docs/CODEBASE_MAP.md` regenerated (it lists the new `mcp` layer).
- The MCP unit and integration tests were run three times: 23 of 23 each time.

Mutation checks (each applied to one file, the tests run, the file restored and its checksum verified):
- M1, an owner-only operation wired into `list_approvals` (`approveApproval`): 21 tests failed. The guard refuses the table, so every
  test that creates the server fails, including `every tool calls exactly one allowlisted operation and it is a member operation in the registry`,
  `with an owner token the tool list is still the same and has no owner operations`, and `no owner-only operation can be wired in (startup guard throws)`.
- M2, the untrusted wrapper removed from successful results: 8 tests failed, the first named `results are wrapped as untrusted data with the free-text field paths listed`.
  Seven integration tests failed with it, including `feedback containing instructions to approve or publish changes nothing`.
- M3, the startup guard call removed: `no owner-only operation can be wired in (startup guard throws)` failed. The packaging test also failed,
  because the unused import of `assertToolTable` is a compile error under `noUnusedLocals`.

Classification:
- `LOCAL_PASS`: unit and integration tests above, against the real API on PostgreSQL and the built stdio entry point.
- `NOT_RUN`: a real MCP client (Claude Desktop or another model client) was not run; the tests use the SDK's own MCP client.
- `NOT_RUN`: a network transport (not provided by design).
- `VERIFIED_REMOTE`: none. Nothing was deployed or pushed.
