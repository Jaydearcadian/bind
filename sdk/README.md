# @bind/sdk

A typed, dependency-free client for the Bind API. It is private to this repository (not published), and it runs in Node 22
and in browsers. Its rules are in `docs/decisions/0036-sdk.md`.

## Use

Inside this repository, import from the source (or from `sdk/dist` after `npm run sdk:build`):

```ts
import { BindClient, BindApiError } from "../sdk/src/index.js";

// The caller supplies the token. The SDK never reads the environment.
const client = new BindClient({ baseUrl: "https://bind.example", token: workspaceToken });

const items = await client.listInventory(workspaceId);
await client.replenish(workspaceId, "FOOD-FLOUR-50LB");

try {
  await client.owner.approveApproval(approvalId); // needs an owner token; a staff token gets a 403
} catch (err) {
  if (err instanceof BindApiError && err.status === 403) {
    // not an owner
  }
}
```

Options: `baseUrl` (no credentials, query or fragment), `token`, and optionally `fetch`, `timeoutMs` (default 30000),
`maxRetries` (default 2, GET and HEAD only), `userAgent`.

## Calls

- Any operation of the API, by its id: `client.call(operationId, { params, query, body, signal })`. Path parameters are encoded,
  undefined query values are dropped, and the body is JSON. The result is typed from the contract.
- Wrappers: `workspace`, `listInventory`, `upsertInventory`, `replenish`, `listApprovals`, `listOrders`, `listWorkflows`,
  `needsAttention`, `createCustomerOrder`, `listCustomerOrders`, `cancelCustomerOrder`, `ingestFeedback`, `feedbackSummary`,
  `proposeMenuChange`, `listMenu`, `listAudit`, `pollEvents`.
- Owner-only operations, under `client.owner`: `approveApproval`, `rejectApproval`, `revokeApproval`, `reconcileOrder`,
  `confirmOrderSettlement`, `acceptCustomerOrder`, `cancelWorkflow`, `recoverWorkflows`, `updatePolicy`, `setKitchenCapacity`,
  `upsertSupplier`, `upsertAgentRole`, `upsertSurfaceBinding`, `setAgentsPaused`, `issueToken`, `listTokens`, `revokeToken`,
  `getWebhookSecret`, `rotateWebhookSecret`, `listConnectors`, `setConnector`, `revokeConnector`, `verifyConnector`,
  `confirmDocument`, and the menu proposal actions. The server decides each call; the group only names them.

## Events

```ts
const stream = client.events(workspaceId, { lastEventId, signal });
for await (const event of stream) {
  // event.id, event.type, event.at, event.actor, event.data ...
}
```

Each event is yielded once, in order. A dropped connection is resumed from the last event yielded. The loop ends quietly when
`signal` aborts or the loop breaks. A 401, 403 or 404 (a revoked token, for example) throws a `BindApiError`.

Without a `lastEventId`, the cursor of the newest event is read when `events()` is called (a poll request, retried like a GET).
Every event written after that call is delivered, including events written before the first connection succeeds and events
written while a connection is down. To resume a stream you started earlier, pass the `lastEventId` you stored; a caller's
`lastEventId` is used as given. If the poll answer carries no usable cursor, the stream starts after the newest event instead,
which can miss events written during a gap (ADR 0036).

Browsers cannot use the native `EventSource` for this API, because it cannot send an `Authorization` header. Use
`client.events()`. Never send an owner token to a browser you do not control.

## Errors

All errors extend `BindError`. `instanceof` works, and each has a stable `name`.

- `BindApiError`: a non-2xx answer. Fields: `status`, `message`, `code`, `reasonCodes`, `requestId`, `retryAfterSeconds`, `body`.
- `BindNetworkError`: no answer. `BindTimeoutError`: the request ran past `timeoutMs`. `BindStreamError`: an event stream
  failed in a way that reconnecting cannot fix.

No error carries the token, the `Authorization` header or a URL.

## Tokens and retries

- The token is held in a private field. `JSON.stringify`, `String` and `util.inspect` never show it.
- The token is sent only in the `Authorization` header, never in a URL.
- Only GET and HEAD are retried, on a network failure, a 502, 503 or 504, and once on a 429 when `Retry-After` is 10 s or less.
  POST, PUT, PATCH and DELETE are never retried: a retry could repeat an order, a payment or a decision.

## Regenerating the types

The types come from `docs/openapi.json`. After the API changes, run:

```sh
npm run sdk:generate        # rewrites sdk/src/generated/api.d.ts and operations.ts (both committed)
npm run sdk:build           # compiles sdk/src to sdk/dist
```

A unit test fails when the committed generated files are stale.
