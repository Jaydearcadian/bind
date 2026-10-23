# ADR 0025: Approval requests go to the owner's own binding, with a plain link

## Status
Accepted (2026-10-20). Implements Task 7b. Supersedes the recipient and link part of ADR 0020 ("The recipient and the
approval link are unchanged"). Builds on ADR 0021 (bearer tokens), ADR 0022 (surface bindings and signed surface events)
and ADR 0016 (API first; the UI is orphaned).

## Context
- The owner approval request went to a hard-coded WhatsApp number (`+12125550199`). One business's approval details
  were sent to a number that is not that business's owner.
- The payload carried `actionUrl: http://127.0.0.1:3000/api/approvals/<id>/approve` and `approvalToken: <id>`. After ADR
  0021 the approve route needs a bearer token. An approval id is not a credential: it appears in approval listings
  (visible to every member of the workspace), in audit rows and in workflow records. A link that approves with the id as
  its token, sent in a chat message, lets anyone who can read that message decide spend.

## Decision

### 1. The recipient is the owner's own surface binding
`resolveOwnerRecipient(workspaceId)` (`src/notifications/recipients.ts`) reads `surface_bindings` for that workspace
only (`workspace_id = $1`), with `actor_role = 'owner'` and `surface` in `whatsapp`, `telegram`, `email`.
- Channel order: whatsapp, then telegram, then email.
- Within a channel: the oldest binding (`created_at ASC, id ASC`).
- The recipient is the binding's `actor_id`. Nothing is hard-coded.
- Staff bindings and other workspaces' bindings are never used.
- No matching binding: returns `null`.

The owner sets the binding through `POST /api/workspaces/:id/surfaces`, which is owner-only (`src/server/app.ts`, route
guarded by `workspaceOwner`).

### 2. No binding means no send, and the skip is audited
In `request_policy_evaluation` (`src/agents/replenishmentTools.ts`), when the owner has no binding:
- `sendApprovalNotification` is not called.
- Audit row `notification.skipped_no_recipient`: actor `system` / `system:notifications`, effect class
  `external_request`, decision `ALLOW`, evidence `{ approvalId }`.
- The approval still exists and is `pending`. The owner can decide it in the app.

A skip is not retried later. If the owner adds a binding afterwards, nothing re-sends the request.

### 3. The link is a plain page link
`approvalLink(approvalId)` (`src/notifications/links.ts`) returns
`${APP_BASE_URL without trailing slashes}/app/approvals/${encodeURIComponent(approvalId)}`.
- No token, no query string.
- It is a page. Opening it decides nothing.
- The payload carries `actionUrl` and no `approvalToken`. The message text is unchanged.

### 4. The send keeps its ledger key
The key stays `${workspaceId}:notify:approval:${approvalId}` (ADR 0020). `dispatch.ts` is unchanged. The send is at most
once per approval.

### 5. `approvalToken` is no longer sent
`replenishmentTools.ts` no longer sets `approvalToken`. The optional field stays in `NotificationPayload`
(`src/adapters/web2/types.ts`), because `tests/integration/notification-effects.test.ts` still sets it. Remove the field
in a later task, when that test is updated.

## Why an approval id is not a credential
- Approval ids are readable by every member of the workspace, and they are written to audit rows, workflow records and
  logs. Anyone who can see the id can name the approval.
- A bearer token (ADR 0021) is a secret. Only its hash is stored, it is checked on every request, and it can be revoked.
- So the message carries no token at all. A link with the id as its token would let whoever reads a chat message
  approve spend.

## How a decision is made
Nothing in the message decides an approval. There are two ways to decide, and both need proof of identity:
1. An authenticated owner opens the approval in the app and calls the approve route with their bearer token. The route
   checks the owner of the approval's workspace (ADR 0021, owner-any).
2. A signed surface event (ADR 0022) that reports an owner's approval decision. The sender holds the workspace's
   webhook secret, and the actor must have an owner binding. The bridge that holds the secret is trusted to name the
   actor, as ADR 0022 describes.

## Known limits
- **No live messaging connector.** `NotificationEmitter` records each payload in memory with status `simulated`. Nothing
  reaches a phone. The audit row `notification.in_doubt` and the ledger "completed" state both mean "recorded by the
  emitter", not "delivered".
- **The approval page does not exist yet.** `/app/approvals/:id` is a link to future UI (ADR 0016). Until that page is
  built, the link leads nowhere, and the owner must decide through the API.
- **Bindings are used whatever their `integration_status`.** A binding marked `simulated` or `configured_unverified` is
  used as the recipient. The owner chose that binding, so this is accepted. Revisit it when the connectors are verified.
- **Pre-existing row-id collision (follow-up, not fixed here).** `upsertSurfaceBinding` builds the row id as
  `surf_<workspaceId>_<surface>_<actorId with non-alphanumerics removed>`. Two actor ids that differ only in punctuation
  (for example `+1 212 555 0100` and `+12125550100`) map to the same primary key, and the second upsert overwrites the
  first row. Fix in a later task: derive the id from a hash of the full actor id, or stop deriving it from the actor id.
- **No retry for a skipped or failed request.** Accepted, as in ADR 0020.

## Tests
- `tests/integration/notification-recipients.test.ts`: owner binding is the recipient, staff binding is never used,
  another workspace's binding is never used, whatsapp is preferred over telegram and email, no binding means nothing is
  sent and the skip is audited, the message carries a plain link and no token, and no hard-coded phone number remains
  in `src` (outside `src/ui`).
- `tests/unit/approval-link.test.ts`: plain page link, trailing slash stripped, approval id encoded.
- Fixture-only changes, no assertion changed: `tests/integration/workflow-orchestrator.test.ts` and
  `tests/integration/notification-effects.test.ts` (`freshWorkspace`) each give the workspace an owner whatsapp
  binding through `upsertSurfaceBinding`. Without it, those tests have no recipient to send to.
