# ADR 0018: Reserve spend before the supplier call, and resume orders through the effects ledger

## Status
Accepted (2026-10-19). Implements Task 5b. Builds on ADR 0015 (commitment gate) and ADR 0017 (effects ledger).
Settlement is unchanged here (Task 5c).

## Context
- The commitment gate (ADR 0015) counts committed spend from the `orders` table, but the order row was inserted only
  after the supplier call. Two concurrent commitments could both pass the daily limit.
- Crash recovery had five faults: an unscoped query adopted any order with an external reference; a crash after the
  supplier accepted but before the order row existed left the workflow in `submitted` forever; the authorized branch
  resubmitted without a policy re-check; the order number came from `Date.now()`, so a retried submit sent a different
  payload; and the simulated supplier returned a random reference on each call, so it could not dedupe.

## Decision

### Shared advisory lock
`src/db/advisory-lock.ts` provides `acquireAdvisoryLock(key, waitMs)`. The effects ledger uses it per idempotency key
with its existing 5 second wait and unchanged behaviour. The order reservation uses it per workspace spend
(`spend:<workspaceId>`) with a 10 second wait. A busy spend lock is an error, never a skipped check.

### Reservation before the supplier call (`src/orders/reservation.ts`)
`reserveOrder` runs under the spend lock:
1. If the order row `ord_<workflowId>` already exists, it returns `created: false` without deciding again. The
   reservation was made earlier, and the order may already be placed, so a later denial could strand a live order.
2. Otherwise it calls `authorizeCommitment` on the stored quote's values (`procurement_agent`).
   - DENY: nothing is written. The workflow fails with the reason codes.
   - REQUIRE_APPROVAL: proceeds only when an owner approval for this workflow has status `approved`. Otherwise it is
     refused, so a limit change between authorization and submission cannot commit money without the owner.
   - ALLOW: writes the order row as `submitted` (a spend-counting status) before any supplier call.
3. The lock is released in `finally`.

The order's supplier, SKU, quantity and prices come from the stored quote row, which is read with the workspace id.

### Order number and idempotency
- `orderNumberFor(orderId)` = `PO-` plus the first 8 hex characters of sha256(orderId). It is stable across retries.
- The supplier idempotency key stays `idem_ord_<orderId>`. Its order id contains the globally unique workflow id.
- Ledger keys include the workspace: `<workspaceId>:order:<orderId>` and `<workspaceId>:quote:<rfqId>`.

### Submission through the ledger (`ProcurementWorkflowRunner.resumeOrderSubmission`)
- It accepts a workflow in `authorized` (transition to `submitted`) or `submitted` (a resume). Any other state is refused.
- After reservation, `runEffect` with `orders.submit` (commercial commitment) calls the supplier at most once per key.
  When the adapter has `lookupOrder`, the ledger reconciles through it first.
- `EffectInDoubtError`: the order and the workflow stay `submitted`. An audit row `orders.submit.in_doubt` records the
  effect id. Nothing is cancelled, and the supplier is not called again.
- Supplier response `rejected`: the order becomes `cancelled` (the budget is released) and the workflow `failed`.
- Any other thrown error: the ledger records the effect as failed. The order and workflow stay `submitted`, and the
  error is rethrown. The outcome is unknown, so nothing is cancelled.
- Success: the order becomes `confirmed` with the external reference, and the workflow becomes `confirmed`.
- A quote request (`suppliers.request_quote`, external request, `externalDedupes`) also goes through the ledger.
  A repeat with the same rfq id replays the stored quote, and the quote row is written once.

### Recovery (`src/workflows/recovery.ts`)
- `draft` and `request_sent`: aborted (unchanged).
- `authorized`: the gate decides again from the stored quote. DENY, or REQUIRE_APPROVAL without an approved approval,
  fails the workflow with the reason and audit row `commitment.recheck`. Otherwise it resumes.
- `submitted`: reads only `ord_<workflowId>` in the workspace.
  - Accepted status (`confirmed` or later): the workflow becomes `confirmed`.
  - `cancelled`: the workflow becomes `failed`.
  - Missing or `submitted`: resumes through the workflow's own order id. It never adopts another workflow's order.
- Submissions reported in doubt go to `report.inDoubt` with the effect id. They count as neither recovered nor failed.
- An error in one workflow counts as `failedCount`, and the scan continues.

## What stays in doubt, and why
- A crash after the supplier call and before the ledger completes: the ledger row is `started`. Without `lookupOrder`
  the order stays `submitted` and is reported in doubt, and it is never resent. With `lookupOrder`, a supplier that has
  the order adopts it.
- A crash before the supplier call: the ledger cannot tell this from the case above. With `lookupOrder` the lookup
  returns not found and the order is sent exactly once. Without it, the order stays in doubt.
- An unknown error from the supplier call: a throw does not prove the call did not go out, so the row is `failed`
  and in doubt for a non-dedupe effect.
- A lock wait that times out: the effect is reported in doubt and not run.
- Once the ledger row is `completed`, a resume replays the stored result, so a crash after the call but before the
  order update completes on the next recovery.

## Known limitations
- The simulated supplier keeps accepted orders in memory (its own state, as the brief allows). A process restart forgets
  them, so `lookupOrder` then reports not found, and a crash that spans a restart can resend a simulated order. Real
  adapters must look orders up in their own durable records. This does not apply to any real supplier today.
- The supplier-facing idempotency key does not contain the workspace id. It is unique because it contains the workflow
  id. The ledger keys, which are checked by the ledger for cross-tenant use, do contain it.
- Reservations use one spend lock per workspace. This serializes commitments within a workspace, which is intended, and
  is not a cross-process fairness guarantee.

## Consequences
- The daily limit holds under concurrency: two commitments that together exceed it cannot both reserve (tested with ten
  races).
- Every order submission reaches the supplier through the ledger, so the "call at most once per key" rule of ADR 0017
  now applies to orders and quotes.
- ADR 0015's parked race is closed by the reservation lock.
