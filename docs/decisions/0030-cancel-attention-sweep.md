# ADR 0030: The owner can cancel a workflow; a needs-attention list; a restock sweep; the lost-claim fix

## Status
Accepted (2026-10-20). Implements Task 10b of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`. It completes the
worker of ADR 0029: "owner cancel, the needs-attention list and the restock sweep are Task 10b", and the lost-claim item in
ADR 0029's "Known risks" is closed here. Builds on ADR 0005 (approval lifecycle), ADR 0017 (effects ledger), ADR 0021 (tokens
and tenancy), ADR 0023 (the pause), ADR 0027 (the restock trigger and available quantity). `src/ui/` is not touched (ADR 0016).

## Context
- An owner could stop a replenishment only by revoking its approval. A workflow that had not reached an approval (a draft or a
  quote) had no route to stop it.
- Nothing listed what waited for the owner: an effect in doubt, a payment on hold, a settlement that the worker had stopped
  asking about, a held customer order, a menu proposal, an approval about to expire. Each was visible only in its own table.
- Low stock started a replenishment only when an order was accepted or a count was recorded. Stock that stayed low was never
  looked at again.
- ADR 0029 recorded that a slow settle could lose its claim after money had moved, and that the post-transfer write ignored
  its row count, so the payment was left unrecorded in `payment_hold`.

## Decision

### 1. Owner cancel
`POST /api/workspaces/:id/workflows/:workflowId/cancel`, owner only. Body `{ reason?: string }`, at most 200 characters. An
invalid body is answered 400 with the field names only. The service is `cancelWorkflow` in `src/workflows/cancel.ts`.

| State read | Result |
|---|---|
| Not in this workspace, or missing | 404 `{ error: "Workflow not found", code: "WORKFLOW_NOT_FOUND" }`. The same body for both. |
| `cancelled` | 200 `{ workflowId, state: "cancelled", alreadyCancelled: true }`. No audit row. |
| `draft`, `request_sent`, `quote_received`, `authorized` | One guarded transition from the state that was read. 200. |
| `awaiting_approval` with a pending approval | `declineApproval(approvalId, "revoked", "owner:<label>", workspace, reason)`. The approval and the workflow change in one statement (ADR 0005). 200 with `approvalId`. |
| `awaiting_approval` with no pending approval | A guarded transition from `awaiting_approval`. There is nothing to revoke. |
| `submitted` | 409 `WORKFLOW_NOT_CANCELLABLE`, `nextAction: RESOLVE_ORDER_WITH_SUPPLIER`. The order may already be placed. |
| `confirmed` | 409 `WORKFLOW_NOT_CANCELLABLE`, `nextAction: RECONCILE_OR_CONTACT_SUPPLIER`. |
| `reconciled`, `failed` | 409 `WORKFLOW_NOT_CANCELLABLE`, `nextAction: NONE_FINISHED`. |

**Race.** If the state moved between the read and the change (the guarded transition matched nothing, or the approval was
decided or expired first), the answer is 409 `WORKFLOW_STATE_CHANGED` with the state as it is now, and nothing is cancelled.

**Audit.** `workflow.cancelled`: actor type `owner`, actor id `owner:<label>`, effect class `read`, decision `ALLOW`, evidence
`{ workflowId, fromState }`. The reason text is not written to this row.

**Reason.** Stored as data: in `approvals.reason` for an approval, and in `workflows.context_data.cancelReason` otherwise. It
is never echoed in an error.

**Scope.** A pause never blocks a cancel. A cancel never touches an order, a supplier or a payment.

### 2. The needs-attention list
`GET /api/workspaces/:id/needs-attention`, member access. The response is `{ items, capped }`. An item is
`{ kind, id, since, codes, nextAction }`. At most 200 items, oldest `since` first. `capped` is true when more items exist.
Each kind reads at most 201 rows, so `capped` is exact. The pure merge, sort and cap is `assembleAttention`; each kind has one
SQL function in `src/workflows/needs-attention.ts`.

| Kind | Rows | `since` | `codes` | `nextAction` |
|---|---|---|---|---|
| `effect_in_doubt` | `effects` with status `started` or `failed`, `updated_at` older than 2 minutes | `updated_at` | operation, status | `RESOLVE_EFFECT` |
| `payment_hold` | `orders` in `payment_hold` | `updated_at` | the `hold` of the latest audit row of that order that has one, else `UNKNOWN` | `RECONCILE_ORDER` |
| `settlement_unconfirmed` | `orders` in `settlement_submitted`, sent more than 5 minutes ago | the transfer's `created_at` (the order's `updated_at` if no transfer record) | `AWAITING_SETTLEMENT_CONFIRMATION`; `POLLING_STOPPED` when the transfer is older than 24 hours; `NO_TRANSFER_RECORD` and `POLLING_STOPPED` when there is no transfer record | `CONFIRM_SETTLEMENT` |
| `order_submission_in_doubt` | `workflows` in `submitted` for more than 5 minutes whose order (`ord_<workflowId>`) is still `submitted` | `updated_at` | `SUPPLIER_OUTCOME_UNKNOWN` | `RESOLVE_ORDER_WITH_SUPPLIER` |
| `customer_order_held` | `customer_orders` in `needs_owner` | `updated_at` | the reason codes | `ACCEPT_OR_CANCEL_ORDER` |
| `menu_proposal_awaiting` | `menu_proposals` in `proposed` or `approved` | `updated_at` | the status | `APPROVE_REJECT_OR_PUBLISH` |
| `approval_pending` | `approvals` pending, `expires_at` within 1 hour | `created_at` | the action requested | `DECIDE_APPROVAL` |

**What an item never contains.** No customer note, external reference, reason sku, supplier name, feedback text, menu name,
rationale, or owner text. Items are built from ids, enum values and times only. Every code must match
`^[A-Za-z][A-Za-z0-9_.]{0,63}$` (`codesOnly`), so a value that is not a code is dropped rather than shown.

**Interpretations.** An approval already past its window, which the worker has not yet expired, is listed: it cannot be
decided, and the owner should see that. A settlement's age runs from the transfer, not from `orders.updated_at`, because every
poll refreshes `updated_at` (ADR 0029). An order with no transfer record is not polled by the worker (ADR 0029), so it is listed
with `NO_TRANSFER_RECORD`. That code is an addition beyond the brief.

### 3. The restock sweep (worker step 5)
`restock_sweep` runs after stuck-order recovery, under its own non-blocking lock `worker:restock_sweep`.

**Candidates**, in one query (`restockSweepStep`):
- the workspace is not paused (`agents_paused = FALSE`, ADR 0023);
- available quantity (on hand less active reservations, ADR 0027) is below par;
- no workflow for the sku was created within the cooldown (`restockCooldownMs`, default 6 hours);
- no workflow for the sku is active (state not `reconciled`, `failed` or `cancelled`);
- ordered by the stock row's `updated_at` ascending (the figure that has gone unchanged the longest), then workspace and sku;
- at most `batchSize`.

**Action.** `startReplenishment(workspaceId, sku, "worker_sweep", { availableQuantity })` for each candidate, in its own
try/catch. A success counts as `started`. An error whose message starts with `[AGENTS_PAUSED]` writes
`replenishment.sweep_skipped` with `reason: AGENTS_PAUSED` (decision `DENY`) and is not counted as a failure. Any other error
writes `replenishment.sweep_failed` with a redacted message of at most 200 characters (decision `ALLOW`) and counts as `failed`.
The other skus still run. The audit actor is `system:restock-sweep`, effect class `read`.

**The report.** `restockSweep: { skipped, started, failed }`. `skipped` is true when the step did not run: it is off, or its
lock was busy.

**Off by default in `runTick`.** The `restockSweep` option defaults to false, so `runTick` callers and tests do not start
replenishments unless they ask. `startWorker` passes the option through. The server enables it:
`startWorker({ restockSweep: config.BIND_RESTOCK_SWEEP !== "false" })`, with `BIND_RESTOCK_SWEEP` added to `src/config/env.ts`.

**Why the cooldown.** A sku whose replenishment just failed, was cancelled, or was reconciled is not started again for 6
hours. Without it the sweep would retry it on every tick (every 15 seconds by default).

**Commitments.** A sweep replenishment goes through the same commitment gate, daily limit, approval threshold and pause as a
manual one. It can therefore place an order by itself when policy allows. That is the purpose of the switch, and it is why the
switch is on in the server.

### 4. The lost-claim fix (ADR 0029, "Known risks")
In `settleClaimedOrder`, the write of `tx_hash` and the payment record after the transfer now checks its row count. A count of
zero means the claim was lost after the money moved. `reattachLostTransfer` then:
- re-reads the order. If it is not `payment_hold` with `tx_hash` NULL, it returns `{ status, reconciled: false, hold: "RECONCILE_IN_PROGRESS" }` and changes nothing;
- otherwise, in one transaction, sets `status = settlement_submitted`, `tx_hash` and the payment record on the row where
  `id = $1 AND status = 'payment_hold' AND tx_hash IS NULL`, and writes `settlement.reattached` (evidence `{ orderId, txHash }`,
  with the hash in the audit's `tx_hash` column). If the guarded update matches nothing, it does the same as the non-hold case;
- returns `{ status, reconciled: false, txHash, pending: "AWAITING_SETTLEMENT_CONFIRMATION" }`.

The in-flight settle does not confirm the payment itself. The worker's confirmation poll (ADR 0029, step 3) finishes it, so
the restock and the journal entry happen once, in the confirmation. The normal path, where the claim is held, is unchanged.

### 5. The dev entry point
`src/accounting/three-way-match.ts` re-exported the document types (`DeliveryReceiptDoc` among them) as values, which `tsx` cannot
load. They are now exported with `export type`. `MatchStatus` stays a value export, because settlement imports it as one.
`npm run dev` and `npx tsx src/index.ts` both start.

## Test changes (recorded, per AGENTS.md)
- Added: `tests/integration/workflow-cancel.test.ts` (10 tests), `tests/integration/needs-attention.test.ts` (13),
  `tests/integration/worker-sweep.test.ts` (11), `tests/integration/settlement-lost-claim.test.ts` (2).
- Route table (`tests/integration/auth-tenancy.test.ts`): two routes added, the cancel to `OWNER_ROUTES` and the attention
  list to `ANY_ROLE_ROUTES`. No assertion was changed.
- No existing assertion was changed.

## Verification
Results on the final tree, run in this order:
- `npm run lint`: 0 errors, 0 warnings.
- `npm run typecheck`: clean.
- `npm run test:unit`: 31 files, 195 tests, all pass.
- `npm run test:integration`: 38 files, 357 tests, all pass. Before this change: 34 files, 321 tests.
- `npm run build`: clean.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `npm run map:functions`: regenerated `docs/CODEBASE_MAP.md` (931 functions).

Mutation checks. Each mutation was applied to the working tree, the named tests were run, and the file was restored and
compared byte for byte with its backup.

| Mutation | Test that fails |
|---|---|
| Cancel from-state guard removed (the transition is given every state as its from-state) | `a state that moves between the read and the cancel is refused by the guarded transition` |
| Sweep cooldown removed (the `created_at` clause disabled, its parameter still bound) | `the sweep starts a replenishment for a low sku and not again within the cooldown` (the retry is counted as `failed`) |
| Row count ignored in the post-transfer write | `a transfer sent after the claim was lost is recorded and confirmed, not paid twice` and `a transfer after the order was already finished by someone else changes nothing` |
| Sweep lock removed (exploratory) | `two sweeps at once start one replenishment`, which failed in 1 of 3 runs. It is an intermittent detector, not a deterministic one. |

## Known risks and not done
- **No external scheduler for serverless.** `api/_handler.js` runs no worker (ADR 0029). The sweep runs only in the server process.
- **No push notification of attention items.** The list is read on request. Nothing tells the owner when an item appears.
- **No automatic cancel.** Nothing cancels a workflow without the owner.
- **Sweep retry collision (pre-existing, ADR 0027).** A replenishment's idempotency key includes the available quantity. A retry at
  the same quantity collides with the earlier, cancelled or failed workflow, and is recorded as `replenishment.sweep_failed` once
  per cooldown until the count changes. The sweep does not fix this.
- **The sweep can order on its own, including at server start.** The demo kitchen starts with flour and butter below par, so
  with the sweep on, the first tick (15 seconds after start) may place simulated orders within policy. Set
  `BIND_RESTOCK_SWEEP=false` to prevent that.
- **The payment-hold code is found by a correlated subquery over `audit_logs.evidence`.** It has no index on `evidence->>'orderId'`.
  That is acceptable at this size. An index is needed when the audit table grows.
- **An approval past its window, not yet expired by the worker.** Revoking it expires it (ADR 0005), and the answer is
  `WORKFLOW_STATE_CHANGED` with `state: "cancelled"`.
- **Two writes, not one transaction.** The cancel's transition and its audit row are separate statements, as in ADR 0021's
  open item on approval decisions.
- **The existing `approval.revoked` row carries the reason.** `declineApproval` writes it, as it does for every revoke (ADR 0005).
  The `workflow.cancelled` row, which this ADR adds, does not.
- **The lost-claim fix waits for the poll.** The payment is confirmed within one worker interval, not within the settle call. The
  residual pause window of ADR 0023 is unchanged.
- **Not done here:** `docs/RELEASE_EVIDENCE.md` (updated at the release step, ADR 0023), and any browser surface for these routes.
