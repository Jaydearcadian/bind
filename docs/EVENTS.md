# Workspace events

The event stream lets a client follow what happens in one workspace without polling every route. It is specified in
ADR 0035 (`docs/decisions/0035-event-stream.md`). This page is the reference for a client.

## What an event is

An event is a row of `audit_logs`, read after it is committed. Nothing is invented: an action that writes no audit row
has no event. The event **type** is the audit action string, so the list below is the set of actions the code records.
It is a list of what exists, not a promise of more. (`docs/superpowers/plans/2026-10-19-bind-completion-plan.md` named
types such as `approval.requested` and `effect.failed`; those are not audit actions and are not sent.)

## Routes

Both routes are member routes: the token of the workspace in the path, as an `Authorization: Bearer` header. A token in
the query string is not accepted (401). A token of another workspace gets 404.

| Route | Answer |
|---|---|
| `GET /api/workspaces/:id/events` | `text/event-stream`. Live events, in order. |
| `GET /api/workspaces/:id/events/poll?after=<id>&limit=<1-200>` | JSON `{ events, nextCursor, hasMore }`. The same events as pages. |

Use the poll route from a client that cannot hold a connection open (serverless functions, short-lived jobs).

## Event ids and the cursor

An id is `<txid>.<seq>`: the transaction id that wrote the row, then the row's sequence number, both decimal. Events are
ordered by `(txid, seq)`. Only rows whose transaction has finished are sent, so a transaction that commits late is never
skipped. `0.0` means "before everything".

A cursor that is not `<digits>.<digits>` (at most 19 digits each, not above the largest 64-bit signed value) is a 400
`{ "error": "Invalid cursor", "code": "INVALID_CURSOR" }`.

## The stream

Frames:

```
retry: 3000

id: 459940.3293
event: approval.approved
data: {"id":"459940.3293","type":"approval.approved","at":"2026-10-20T10:00:00.000Z", ...}

: ping
```

- `id` is the cursor. A client that reconnects sends it back as `Last-Event-ID` (header) or, if it cannot set headers,
  as the `lastEventId` query parameter. The header wins when both are given.
- With neither, the stream starts **after the newest event**: it does not replay history. To read history, use the poll
  route, or pass a cursor you have.
- A reconnect with a cursor receives every event after it, once each, in order (ADR 0035).
- `: ping` is a comment sent when the stream has been idle for about 15 seconds. It keeps proxies open.
- `event: shutdown` with `data: {}` means the server is stopping. Reconnect to another instance with your last id.
- The stream ends by itself after one hour, when its token is revoked, or when the client stops reading (see below).
  Reconnect with your last id each time.

Browsers' native `EventSource` cannot send an `Authorization` header. Use a client that can: the fetch API with a
streaming body, or the SDK once it exists. Do not put a token in a URL.

### Caps and refusals

| Cap | Default |
|---|---|
| open streams per token | 5 |
| open streams per workspace | 50 |
| open streams per process | 500 |

A stream over a cap is answered `429 { "error": "Too many event streams", "code": "TOO_MANY_STREAMS" }` with
`Retry-After: 5`, before any event is sent. A client that does not read is disconnected after 10 seconds of a full buffer.

## The envelope

```json
{
  "id": "459940.3293",
  "type": "orders.submit",
  "at": "2026-10-20T10:00:00.000Z",
  "effectClass": "commercial_commitment",
  "decision": "ALLOW",
  "actor": { "type": "agent", "id": "procurement_agent" },
  "workflowId": "wf_...",
  "data": { "orderId": "ord_...", "supplierId": "sup_...", "status": "submitted" }
}
```

- `effectClass` is `read`, `external_request` or `commercial_commitment`. `decision` is the policy decision
  (`ALLOW`, `REQUIRE_APPROVAL`, `DENY`).
- `workflowId` appears only when the row belongs to a workflow.
- `data` holds only these evidence keys: ids (`*Id`, `*Ids`), `status`, `state`, `fromState`, `toState`, `hold`, `code`,
  `codes`, `reasonCodes`, `kind`, `decision`, `connectorId`, `txHash`, `orderNumber`, `attempts`, `effectId`, `units`,
  `sku`, `channel`, `surface`, `promisedFor`, `slotId`. A value is kept only when it is a string of at most 200 characters,
  a finite number, a boolean, or a list of at most 20 such strings. Everything else is dropped: free text (reasons, errors,
  notes, labels, messages, rationales), nested objects and extracted document text. `txHash` comes from the row's
  transaction hash.
- Every kept string is redacted (tokens, bearer values, credentials in URLs, configured secrets) before it is sent.

## Who receives what

An owner receives every event. Staff do not receive events whose type starts with `auth.`, `connector.` or
`kitchen_capacity.`. A staff stream or poll simply does not contain them.

## Poll

`GET .../events/poll`:

- With no `after`: the newest `limit` events (default 50), oldest first. `hasMore` is false.
- With `after`: up to `limit` events after the cursor, oldest first. `hasMore` is true when more remain.
- `nextCursor` is the id of the last row read, to pass as the next `after`. When a staff caller's page holds only hidden
  rows, `events` is empty and `nextCursor` still moves on.
- `limit` must be an integer from 1 to 200. Anything else is a 400 `INVALID_LIMIT`.

## Event types

Every type is an audit action. The source column names the file that records it; the list was taken from the code, not
from the plan.

| Type | Recorded when | Source |
|---|---|---|
| `auth.token_issued`, `auth.token_revoked` | an owner issues or revokes a workspace token | `src/auth/tokens.ts` |
| `auth.member_joined`, `auth.member_removed`, `auth.member_role_changed`, `auth.invite_created`, `auth.invite_revoked` | a person joins, leaves or changes role, or an invitation is created or revoked | `src/accounts/service.ts` |
| `auth.webhook_secret_viewed`, `auth.webhook_secret_rotated` | the webhook secret is read or rotated | `src/studio/workspaceControls.ts` |
| `workspace.agents_paused_changed` | the agents are paused or resumed | `src/studio/workspaceControls.ts` |
| `workspace.onboard_configured` | a workspace is onboarded | `src/studio/onboarding.ts` |
| `agent_role.configure` | an agent role is set up | `src/studio/onboarding.ts` |
| `connector.credential_set`, `connector.credential_revoked`, `connector.credential_verified`, `connector.credential_verification_failed`, `connector.credential_rotated` | a connector credential changes or is verified | `src/credentials/store.ts` |
| `kitchen_capacity.set` | kitchen capacity is set | `src/workflows/fulfilment.ts` |
| `approval.approved`, `approval.rejected`, `approval.revoked` | an owner decides an approval | `src/workflows/procurement.ts` |
| `commitment.evaluate`, `commitment.recheck` | the commitment gate evaluates or rechecks an order | `src/agents/replenishmentTools.ts`, `src/workflows/procurement.ts`, `src/workflows/recovery.ts` |
| `orders.submit`, `orders.submit.in_doubt`, `orders.submit.response_invalid` | an order is submitted to a supplier | `src/workflows/procurement.ts` |
| `suppliers.request_quote.response_invalid` | a supplier's quote response is refused | `src/workflows/procurement.ts` |
| `inventory.detect_low_stock` | low stock is detected | `src/workflows/procurement.ts` |
| `replenishment.propose` | a replenishment is proposed | `src/agents/replenishmentTools.ts` |
| `replenishment.sweep_skipped`, `replenishment.sweep_failed` | the restock sweep skips or fails | `src/workers/runner.ts` |
| `replenishment.trigger_skipped`, `replenishment.trigger_failed` | a restock trigger is skipped or fails | `src/workflows/fulfilment.ts` |
| `settlement.reconcile_and_pay`, `settlement.submitted`, `settlement.paused_hold`, `settlement.reattached` | a settlement step runs | `src/workflows/settlement.ts` |
| `settlement.recovered_to_submitted`, `settlement.recovered_to_hold` | the worker recovers a settling order | `src/workers/runner.ts` |
| `accounting.three_way_match_failed` | a three-way match fails | `src/workflows/settlement.ts` |
| `workflow.cancelled` | a workflow is cancelled | `src/workflows/cancel.ts` |
| `notification.in_doubt`, `notification.failed`, `notification.skipped_no_recipient` | a notification is in doubt, fails or has no recipient | `src/notifications/dispatch.ts`, `src/agents/replenishmentTools.ts`, `src/workflows/fulfilment.ts` |
| `customer_order.accepted`, `customer_order.partially_available`, `customer_order.declined`, `customer_order.held` | a customer order is decided (`held` is `needs_owner`) | `src/workflows/fulfilment.ts` |
| `customer_order.cancelled`, `customer_order.fulfilled` | a customer order is cancelled or fulfilled | `src/workflows/fulfilment.ts` |
| `feedback.ingested` | customer feedback is recorded | `src/workflows/feedback.ts` |
| `menu.proposed`, `menu.propose_refused`, `menu.approved`, `menu.rejected`, `menu.cancelled`, `menu.published`, `menu.publish_refused` | a menu change moves through its states | `src/workflows/menu.ts` |
| `surface.bind_identity` | a social surface identity is bound | `src/adapters/socialSurface.ts` |
| `document.extract_staged`, `document.confirm_quote` | a document is extracted or confirmed | `src/studio/documentsAndAccounting.ts` |

A `*_refused` or `*_skipped` type is a decision that was recorded, not a failure of the stream. An event type not in this
table is not sent by the server.
