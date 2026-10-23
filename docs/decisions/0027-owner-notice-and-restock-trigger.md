# ADR 0027: The owner is told when a customer order is held, declined or partly covered; a restock starts from available stock

## Status
Accepted (2026-10-20). Implements Task 8b of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`, completing the
customer-order workflow begun in Task 8a (ADR 0026). Builds on ADR 0017 (effects ledger), ADR 0020 (owner notifications at most
once), ADR 0023 (the pause), ADR 0025 (the owner's own binding and a plain link). `src/ui/` is not touched (ADR 0016).

## Context
- Task 8a decided customer orders, but nothing told the owner when an order needed a decision, and a low-stock check looked
  only at on-hand stock. After an order reserves stock, on-hand can stay at or above par while the stock that is really free
  is below par, so no restock started.
- The owner must learn about an order that waits for them, without the customer's text reaching a chat message, and a
  notification must never change the order.

## Decision

### 1. One owner notice function, one ledger key pattern
`sendOwnerNotification` (`src/notifications/dispatch.ts`) sends a notice through `runEffect`, as `sendApprovalNotification` did:
- Kinds: `approval`, `order_held`, `order_declined`, `order_partially_available`.
- Operation: `notifications.send_approval_request` for `approval`, `notifications.send_summary` for the others. Both are
  `external_request` in the effect map (ADR 0017).
- Ledger key: `${workspaceId}:notify:${kind}:${refId}`. The workspace id is in the key (ADR 0017). The approval key is unchanged,
  `${workspaceId}:notify:approval:${approvalId}`, because `sendApprovalNotification` now delegates to this function with
  `kind: "approval"`.
- `externalDedupes` is false. A notice is sent at most once per key. A send whose outcome is unknown returns
  `{ sent: false, reason: "in_doubt" }` and writes `notification.in_doubt`. Its evidence is `{ approvalId, effectId }` for an
  approval (unchanged) and `{ kind, refId, effectId }` for an order notice. No message text is in the audit row.
- Any other emitter error is rethrown. The caller audits it.

### 2. When the owner is told
Only for a **new** decision (not a replay) by `acceptCustomerOrder` or `acceptHeldOrder`, and only after the transaction has
committed:
| Decision | Notice | Title |
|---|---|---|
| `needs_owner` (held) | `order_held` | `Bind: customer order needs your attention` |
| `declined` | `order_declined` | `Bind: customer order declined` |
| `partially_available` | `order_partially_available` | `Bind: customer order partly available` |
| `accepted` | none | |

`acceptHeldOrder` can produce `declined` or `partially_available` (the owner's decision is re-checked against current stock), so it
notifies in those cases too, as the owner's own result.

**Recipient.** `resolveOwnerRecipient(workspaceId)` (ADR 0025). With no binding nothing is sent. The audit row
`notification.skipped_no_recipient` is written by the system actor `system:notifications`, effect class `external_request`,
decision `ALLOW`, evidence `{ orderId, status }`. The skip is not retried later (as ADR 0020 and ADR 0025).

**Errors.** Any error in the notice path (the recipient lookup, the emitter, the ledger) is caught and audited as
`notification.failed` with evidence `{ orderId, error }`, where `error` is `boundedErrorMessage(err)` (redacted, 500 characters
at most). The order result is unchanged.

### 3. What the notice contains, and what it never contains
- **Contains:** the workspace's own owner binding as recipient and channel, the title above, a message built from a fixed
  template (`Order <orderId> status: <status>. Reasons: <reason codes>.`), and the link `actionUrl`.
- **Reason skus.** A reason may name a sku. The customer chose that sku, so a sku is shown only when it matches
  `^[A-Za-z0-9._-]{1,40}$`. Any other sku is shown as `(sku withheld)`.
- **Never contains:** the customer's `note` and the `externalRef`. Both are customer-controlled text. The notice carries no
  quantity, price or customer name either, because none is needed to decide.
- **Link.** `customerOrderLink(orderId)` (`src/notifications/links.ts`) is `${APP_BASE_URL without trailing slashes}/app/customer-orders/<encoded id>`.
  It has no token and no query string, and opening it decides nothing (the same rules as ADR 0025's approval link).
- **Delivery.** `NotificationEmitter` is still a simulator (ADR 0025): a notice is recorded in memory with status `simulated`.
  "Sent" in this ADR means "recorded by the emitter".

### 4. The restock trigger
**Rule.** After a new decision that ends `accepted`, for each distinct sku of the order (in sku order), the trigger reads on-hand
stock and the active reservations for that sku, and computes **available = on-hand − sum of active reservations**. When
`available < par`, it calls `ProcurementWorkflowRunner.startReplenishment(workspaceId, sku, "customer_order", { availableQuantity: available })`.

**Basis.** Par and on-hand are the existing inventory rules (`startReplenishment`, ADR 0018). Reservations are the existing
commitments of ADR 0026, so a stock figure that counts reserved units as free would promise stock that is already promised.

**What the option changes.** `startReplenishment` takes an optional fourth argument `opts?: { availableQuantity?: number }`.
When it is given, it replaces `current_quantity` in the low-stock test, in the recorded `currentQty` and in the idempotency key.
Without it, behaviour is unchanged. The pause refusal, the active-workflow dedupe and the commitment-gate path are unchanged.

**Serialisation.** Each sku is checked under a PostgreSQL advisory lock, `restock:${workspaceId}:${sku}`, held on a dedicated
connection (`src/db/advisory-lock.ts`). The available quantity is read under the lock. Concurrent accepted orders therefore read in
turn, and the second caller sees the workflow the first one started (the active-workflow dedupe). A caller that does not get the
lock within 5 seconds writes `replenishment.trigger_skipped` with reason `LOCK_BUSY`. The sku is then covered by the workflow the
holder started, or by the next accepted order.

**Outcomes and audit.** Every audit row below has actor `system`, actor id `system:restock`, effect class `read` (no commitment or
external request is made by the trigger itself) and evidence `{ orderId, sku, ... }`. Only these three rows are written:
| Case | Audit action | Decision | Evidence |
|---|---|---|---|
| Workspace paused (`[AGENTS_PAUSED]` from `startReplenishment`) | `replenishment.trigger_skipped` | `DENY` | `reason: "AGENTS_PAUSED"` |
| Lock busy after 5 seconds | `replenishment.trigger_skipped` | `ALLOW` | `reason: "LOCK_BUSY"` |
| Any other error (gate denial, no supplier, a supplier error) | `replenishment.trigger_failed` | `ALLOW` | `error` (`boundedErrorMessage`) |

Available at or above par writes nothing. A started or already-running replenishment writes nothing new: the existing workflow
records it (`inventory.detect_low_stock`).

**Not done by the trigger.** It never creates an order, an approval, a quote or a payment. The replenishment goes through the
existing workflow, the commitment gate and the approvals, exactly as a manual replenishment does.

**Pause.** An owner's accepted order is allowed while paused (ADR 0023 and ADR 0026), but the restock it triggers is refused
while paused, and the refusal is audited. The order stays accepted.

**Order response time.** The trigger runs before the order response is returned, so the call waits for the trigger. In live
arc-testnet mode a replenishment runs an agent, which can take minutes. The accepted order would then return late. This is
accepted for this slice, and it is a known risk. Moving the trigger to a background worker is a later task.

### 5. Replays
A replayed `externalRef` made no decision. It sends no notice and starts no restock. This is the same rule that keeps a
replayed order from reserving stock twice (ADR 0026).

## What is NOT done
- **No customer-facing message.** Only the owner is told. Nothing is sent to the customer.
- **No retry of a skipped notice.** A skipped notice (no binding) or a failed one is not sent again later, even if the owner adds a
  binding afterwards (ADR 0020, ADR 0025). The owner sees the order in the app.
- **No re-trigger when stock is corrected.** A later stock count or a later accepted order is the only thing that starts a restock.
  A correction of on-hand stock does not start one.
- **No notice for an accepted order.** Accepting is not a request for the owner's attention.
- **Notices are not delivered.** The emitter is still the simulator (ADR 0025).
- **A pre-existing hazard, not changed here.** `createWorkflow` upserts on the idempotency key and returns the existing row, but
  `startReplenishment` keeps its own new id. If a sku's earlier workflow has reached a terminal state, and a later trigger computes the
  same available quantity, the two can collide. The lock and the dedupe make this unlikely, and it is recorded for a later task. Fixed by ADR 0040: the key
  now includes a round after a terminal workflow, and a start that finds the key existing returns that workflow.

## Tests
- `tests/integration/customer-fulfilment-effects.test.ts` (15 tests): one notice per declined, held and partly available decision; no
  notice for an accepted order; the notice holds neither the note nor the externalRef; no binding is audited and the result is unchanged;
  a failing emitter does not change the order; a replay does not notify; a crash after the send is in doubt and not sent again; a restock
  starts when available stock is below par; none when at or above par; a pause refuses the restock and the order stays accepted; a restock
  failure does not fail the order; concurrent accepted orders start one replenishment; `startReplenishment` uses the available quantity.
- `tests/unit/customer-order-link.test.ts`: the link has no token or query, strips trailing slashes, and encodes the order id.
- The concurrency test widens the race between a replenishment's active-workflow check and its workflow insert. With the per-sku
  lock removed in a scratch run, it fails (three workflows). With the lock it passes. The test would not catch a missing lock without
  that widening, because the dedupe alone covers the ordinary timing.
- Existing tests: `tests/integration/notification-effects.test.ts` is unchanged and passes, which shows that the approval key, the
  payload, the audit evidence and the in-doubt behaviour are unchanged.

## Consequences
- The owner learns of each order that waits for a decision, through the owner's own binding, with a link that decides nothing.
- A notice cannot carry customer text, so a customer cannot put words in front of the owner through the note or the reference.
- A restock is triggered by what is free to promise, not by what is on the shelf.
