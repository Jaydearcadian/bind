# ADR 0020: Approval notifications through the ledger, random row ids, journal outside the ledger

## Status
Accepted (2026-10-19). Implements Task 5d. Builds on ADR 0017 (effects ledger) and ADR 0019 (settlement through the ledger).
A cross-workspace defect in the journal write was found during this task and is fixed in the same commit (see "Fixed in this commit").

## Context
- The owner approval request (WhatsApp) was sent with a direct `notificationEmitter.send` call. A crash after the send
  left no record, and a retry could send it again.
- Many row ids came from `Date.now()` and `Math.random()`. Two inserts in the same millisecond could collide, and the
  ids could be guessed.
- `Date.now().toString().slice(-6)` produced human-facing invoice and document numbers. Six digits collide easily.

## Decision

### 1. The owner approval notification goes through the ledger
`src/notifications/dispatch.ts` exports `sendApprovalNotification({ workspaceId, workflowId, approvalId, payload })`.
- It calls `runEffect` with `effectClass: EXTERNAL_REQUEST`, `operation: "notifications.send_approval_request"`,
  `idempotencyKey: \`${workspaceId}:notify:approval:${approvalId}\``, `externalDedupes: false`. A message cannot be
  unsent, so the send is at most once.
- The key includes the workspace id, as ADR 0017 requires for keys that could otherwise be probed across tenants.
- A replayed completed effect returns `{ sent: true }` and does not call the emitter again.
- An in-doubt effect (`EffectInDoubtError`) writes audit row `notification.in_doubt`
  (actor `system:notifications`, effect class `external_request`, decision `ALLOW`, evidence `{ approvalId, effectId }`).
  The evidence holds no message text. The function returns `{ sent: false, reason: "in_doubt" }`.
- Any other emitter error is rethrown. The ledger marks the row failed.
- In `replenishmentTools.ts` the call is wrapped. An error writes audit row `notification.failed`
  (evidence `{ approvalId, error }`, where `error` is the message after `boundedErrorMessage`: secrets redacted, at most
  500 characters) and the evaluation continues. A notification problem never fails the approval or the workflow.
- The recipient and the approval link are unchanged. They are hard-coded and parked for the connector-credential task.

### 2. Row ids are random and collision-free
`src/utils/ids.ts` exports `newId(prefix)`, which returns `${prefix}_${crypto.randomUUID()}`. The prefix must match
`/^[a-z][a-z0-9_]*$/`, otherwise it throws `TypeError`. Existing prefixes are kept (`audit_prop`, `wf_proc`, `audit`,
`audit_surf`, `audit_onboard`, `audit_role`, `msg_<channel>`, `doc`).
- Human-facing numbers (`INV-`, `DOC-`) use 8 uppercase hex characters from `crypto.randomBytes(4)`, for example
  `INV-3F9A01BC`. This matches the `PO-` format from ADR 0018.
- Simulated supplier ids keep the order id for readability and add a random suffix:
  `dr_<orderId>_<8 hex>` and `bill_<orderId>_<8 hex>`. They are not deterministic, so each document is a new row.
  The suffix is 8 hex characters so the id fits `VARCHAR(64)`. The workflow id is now 44 characters
  (`wf_proc_` + UUID), so the order id is 48 and the longest derived id is 62. The old `Date.now()` suffix was longer.
- Keys that must be stable across retries are not changed. Dedupe keys derived from `generateIdempotencyKey` and the
  ledger keys are unaffected.

Remaining `Date.now()` / `Math.random()` uses in `src` (not `src/ui`), and why each remains:
- `src/server/app.ts:660-661`: webhook fallback `eventId` and `timestamp`. Webhook handling, belongs to the auth and
  untrusted-input task.
- `src/adapters/web2/webhook-receiver.ts:22`: webhook timestamp check. Webhook handling, same task.
- `src/adapters/web2/webhook-receiver.ts:46`: `wh_${Date.now()}_${eventId}` row id. Webhook dedupe, same task.
- `src/workflows/procurement.ts:321`, `:415`, `src/studio/documentsAndAccounting.ts:275`,
  `src/adapters/suppliers/simulated.ts:48`: approval expiry check and quote validity windows (time arithmetic).
- `src/workflows/engine.ts:172`: approval expiry (time arithmetic).
- `src/db/advisory-lock.ts:25`, `:48`: lock wait deadline (time arithmetic).
- `src/adapters/settlement/arc-l1.ts:431`, `:439`: confirmation wait deadline (circle/arc adapter deadline code).

### 3. The journal stays outside the ledger
`recordIdempotentJournalEntry` (`src/accounting/journal.ts`) is one local database write:
`INSERT ... ON CONFLICT (idempotency_key) DO UPDATE`. It calls no external system, so the ledger's guarantees about
external calls (at most once, in-doubt reporting, reconcile) have nothing to protect. Its idempotency comes from the
unique `idempotency_key` in the database. The ledger would add a lock connection and an effects row per journal write,
with no benefit.
The conflict rule is set by the upsert in `recordIdempotentJournalEntry` (see "Fixed in this commit").
Test coverage: `tests/integration/journal-idempotency.test.ts`.

### 4. The idempotency stores are kept for now (superseded: deleted by ADR 0040)
`MemoryIdempotencyStore` and `PostgresIdempotencyStore` in `src/utils/idempotency.ts` have no production callers. Each
has a comment saying so. They are not deleted, because `tests/unit/idempotency.test.ts` still uses the memory store and
the `idempotency_keys` table is required by `tests/integration/db-migrations.test.ts`.
**Follow-up:** remove both stores, and the table, once the ledger is the single mechanism. Decide in a later task.

## Fixed in this commit
**Cross-workspace journal write.** `recordIdempotentJournalEntry` keys on `idem_je_<orderId>`. Before the fix, a call
from a second workspace with the same order id (probe, and the test
`a journal entry from another workspace cannot overwrite it`) did two things:
1. It received the first workspace's row back (`RETURNING *`): a cross-tenant read.
2. It replaced the stored `tx_hash` when it supplied a non-null one (`COALESCE(EXCLUDED.tx_hash, ...)`). In the probe,
   the stored value changed from `0xA` to `0xB`.

Behaviour now (`src/accounting/journal.ts`):
- The upsert is `ON CONFLICT (idempotency_key) DO UPDATE SET tx_hash = COALESCE(accounting_journal_entries.tx_hash,
  EXCLUDED.tx_hash) WHERE accounting_journal_entries.workspace_id = EXCLUDED.workspace_id AND
  accounting_journal_entries.amount_cents = EXCLUDED.amount_cents RETURNING *`.
- A repeat call with the same workspace and amount returns the stored row. A stored `tx_hash` is never replaced (the
  first one wins). A missing one can be filled in by a later call.
- A call from another workspace, or with another amount for the same key, changes nothing. The upsert returns no row,
  and the function throws `JournalConflictError`. Its message does not name the other workspace or the stored amount.
- The two callers (`src/workflows/settlement.ts`, `src/studio/documentsAndAccounting.ts`) are unchanged. They receive
  the error as a thrown exception, as for any other write failure.
- Tests (`tests/integration/journal-idempotency.test.ts`): the cross-workspace test passes, and so do
  `a different amount for the same entry is refused and changes nothing`, `a stored transaction hash is never replaced`
  and `a missing transaction hash is filled in by a later call`.

## Consequences
- An approval notification is sent at most once per approval. If the process dies after the send, the owner is not
  told a second time, and the audit log records `notification.in_doubt`. A person must check whether the message
  arrived.
- The row ids are longer. `wf_proc_` ids are 44 characters, so `ord_` and `appr_` ids are 48 and 49. All are within
  `VARCHAR(64)`.
- The ids are no longer time-ordered. Three queries use `id DESC` as the tie-breaker after `received_at`
  (`src/workflows/procurement.ts` lines ~675 and ~701, `src/studio/documentsAndAccounting.ts` line ~414). The old
  `dr_`/`bill_` ids ended in a millisecond timestamp, so a tie was broken by time. Now a tie (two receipts or bills for
  one order with the same `received_at`) is broken at random. This is a known risk, not changed here. A follow-up should
  order by a stored sequence or `created_at`.
- The journal stays outside the ledger, so the defect above is fixed in place and not by routing writes through the
  ledger.
- Accepted as a follow-up: the tie-breaker order on receipts and bills (the `id DESC` bullet above). `received_at` is
  set from `NOW()` with microsecond resolution, so a tie is very unlikely. The order is still recorded here.
- Accepted as designed: a failed notification send is not retried. The ledger row becomes `failed`, any retry is then
  in doubt, and the owner is not re-sent the message. The approval still shows in the app.
