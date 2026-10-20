# ADR 0029: A background worker runs expiry, recovery, settlement confirmation and stuck-claim recovery

## Status
Accepted (2026-10-20). Implements Task 10a of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`. Builds on ADR 0005
(approval expiry, which had no sweeper), ADR 0014 (settlement confirmation, which had no poller), ADR 0017 (effects ledger),
ADR 0018 (recovery), ADR 0019 (settlement through the ledger) and ADR 0023 (the pause covers payments). Owner cancel, the
needs-attention list and the restock sweep are Task 10b and are not here.

## Context
Four things only happened when someone opened a page or called a route:
- an approval past its window was expired only when someone listed approvals or decided it (ADR 0005 said "add a sweeper
  when a worker process exists");
- a workflow left in `authorized` or `submitted` by a crash was resumed only by the owner's explicit recover route;
- a payment sent but not confirmed stayed `settlement_submitted` until someone called `confirm-settlement` (ADR 0014);
- an order left in `settling` by a process that died held its claim forever, and `settle` reported it as in progress.

## Decision

### The tick (`src/workers/runner.ts`)
`runTick(opts)` runs four steps in order. Each step is bounded by `batchSize` (default 25).
1. **Approval expiry.** `WorkflowEngine.expireApprovals({ limit })`. With a limit, the statement takes at most that many
   pending, expired approvals, oldest window first, through `id IN (SELECT id ... LIMIT n FOR UPDATE SKIP LOCKED)`. Without a
   limit the statement is the original one, so existing callers see no change.
2. **Interrupted-workflow recovery.** `WorkflowCrashRecoveryRunner.recoverInterruptedWorkflows({ limit, staleAfterMs })`.
   With `staleAfterMs`, only workflows with `updated_at <= NOW() - staleAfterMs` are scanned, oldest-touched first. A workflow
   that a live request is still handling is left alone. Without the filter, the scan is exactly as before (the owner's
   explicit route). An in-doubt submission is counted in `recovery.inDoubt` and never retried.
3. **Settlement confirmation polling.** Orders in `settlement_submitted` whose last answer is at least `confirmAfterMs`
   old (default 30 s), oldest first, at most `batchSize`. Each goes to `ProcurementWorkflowRunner.confirmSettlement`, which
   asks the adapter and pays nothing. A paused workspace is polled (ADR 0023). A pending answer leaves the order
   `settlement_submitted`, and the answer itself refreshes `updated_at` (through `releaseClaim`), which is what backs the next
   poll off. This was checked by a test, not assumed.
4. **Stuck `settling` orders.** Orders in `settling` whose `updated_at` is older than `stuckSettlingAfterMs` (default 10
   minutes), oldest first, at most `batchSize`. Per order, in one transaction: lock the row with `FOR UPDATE SKIP LOCKED`,
   re-check `status = 'settling'` and the age, then
   - `tx_hash` set: the order becomes `settlement_submitted` (step 3 confirms it), audit `settlement.recovered_to_submitted`
     with the hash in the audit's `tx_hash` column and evidence `{ orderId }`;
   - `tx_hash` NULL: the order becomes `payment_hold`, audit `settlement.recovered_to_hold` with evidence
     `{ orderId, hold: "SETTLEMENT_OUTCOME_UNKNOWN" }`. Never `confirmed`, so nothing is sent again on its own.

   The worker never sends a transfer. A later explicit reconcile goes through the ledger (ADR 0019): a completed row replays,
   a `started` row is in doubt, and a missing row means no transfer was ever attempted, because the ledger writes `started`
   before the call.

### Single process, many processes
- Each step first tries a non-blocking session lock `worker:<step>` (`expiry`, `recovery`, `settlement_poll`,
  `stuck_settling`) through `acquireAdvisoryLock(key, 0)`. With a zero wait that function makes exactly one try, so it is
  unchanged. A busy lock skips the step, and the report says `skipped: true`.
- The operations are idempotent under the locks: the ledger serialises each effect key, the claims are compare-and-swap,
  and the recovery re-checks state. The locks avoid duplicate work and are not the only protection.
- `runTick` never throws. A step's error is redacted (`redactText`) and cut to 200 characters, recorded as
  `{ step, error }`, and the other steps still run. A per-order error in step 3 or 4 is recorded the same way.

### Lifecycle (`startWorker`)
- A self-rescheduling `setTimeout` runs one tick at a time, so two ticks never overlap in one process. The first tick
  runs one interval after start (default 15 s). A scheduled tick's errors are logged with their redacted text.
- `tickNow()` joins a tick in progress rather than starting another. It rejects with "The worker is stopped" after `stop()`.
- `stop()` clears the timer, then resolves when the tick in progress (if any) has finished. No new tick starts after it.
- `src/index.ts` starts the worker inside the `listen` callback unless `BIND_WORKER_ENABLED` is exactly `false`. SIGTERM and
  SIGINT stop the worker, then close the server and exit.

## Deviations from the plan, and why
- **The settlement poll's age window is measured from the transfer, not from `orders.updated_at`.** Every poll refreshes
  `updated_at` (the pending answer), so an age test on `updated_at` could never expire an order, and `maxPollAgeMs` would do
  nothing. Step 3 therefore joins the order to its transfer effect (`effects` row `settlement.transfer_usdc`, key
  `<workspaceId>:settle:<orderId>`) and requires `effects.created_at >= now - maxPollAgeMs`. `created_at` is set when the
  transfer starts and is never updated by a poll. Consequence: an order with no transfer effect row is never polled here
  (Task 10b surfaces it). Every order that reached `settlement_submitted` through the code has one.
- **Rows the recovery worker could not finish are touched.** In bounded mode, `recoverInterruptedWorkflows` sets
  `updated_at = NOW()` on each row it scanned, after the attempt. A workflow that stays in doubt, or keeps failing, otherwise
  stays at the front of the oldest-first queue and starves newer work (a test shows it). The explicit route (no filter) does
  not touch rows. This writes no state.
- **`now` anchors only the settlement and stuck-claim windows.** The expiry and recovery steps read the database clock,
  because `expireApprovals` and the recovery filter already use `NOW()`. The two clocks are the same machine in practice.
- **Expiry keeps two SQL forms.** Without a limit, the statement is the original (including its lock behaviour). Only the
  bounded form uses `SKIP LOCKED`.
- **The per-order error and the step error use one shape.** Both go to `errors` as `{ step, error }`.

## Verification
`tests/integration/worker.test.ts`, 19 tests, all passing on three consecutive runs. All 16 titles from the plan are present.
The batch-size title is split into an expiry test and a settlement test, which makes 17. Two tests were added: an in-doubt
workflow does not starve the batch, and one failing order does not stop the settlement poll.

Mutation checks (each change applied alone, then reverted):

| Mutation | Test that fails |
|---|---|
| No per-step lock (`worker:<step>` not taken) | `the worker does not touch another step's lock` |
| No staleness filter in recovery | `a workflow a live request is still handling is left alone` |
| No batch limit in any step | `a tick is bounded by batch size`, `a tick is bounded by batch size for settlement confirmations`, `an in-doubt workflow does not starve the rest of the batch` |
| No poll window (`maxPollAgeMs`) | `an order older than the poll window is not polled again` |
| No in-doubt touch | `an in-doubt workflow does not starve the rest of the batch` |
| No confirmation wait (`confirmAfterMs`) | `a settlement that is still unconfirmed is polled again only after the wait` |
| `stop()` does not wait for the tick | `stop() waits for the current tick and rejects new work` (five other tests also fail, because the held tick leaks into them) |
| No freshness re-check under the stuck-claim lock | none (see Known risks) |

`two workers running together do not duplicate effects` passes without the per-step lock. The ledger and the claim statements
hold the effects alone, so that test shows the effects are safe, not that the lock is needed.

## Known risks and not done
- **A slow settle can lose its claim to step 4 after money has moved.** If `settle` has sent the transfer but has not yet
  written `tx_hash`, and it takes longer than `stuckSettlingAfterMs` (10 minutes), step 4 moves the order to `payment_hold`.
  The in-flight `settle` then writes `tx_hash` with `WHERE status = 'settling'`, which matches nothing, and ignores the row count. Its
  finalising step then throws "lost its settlement claim". No second payment is made: the ledger row is `completed`, so a later
  reconcile replays the stored transfer. But the order sits in `payment_hold` with no hash until someone reconciles it. The
  fix is to check the row count of the post-transfer write, or to have step 4 check the transfer effect first. Not changed here,
  because it changes settlement semantics (the brief asked this to be reported).
- **Guarded writes, checked.** Every order-status write after a settlement claim carries `WHERE status = 'settling'` (or
  `settlement_submitted`), and the restock is in the same transaction as the guarded `reconciled` update. Two writes are not
  status-guarded: the `three_way_matches` upsert (keyed by order, not status) and the post-transfer `tx_hash` write (guarded,
  but its row count is ignored, see above).
- **The under-lock freshness re-check in step 4 has no test.** The candidate query already filters on age, so removing the
  re-check under the lock does not fail any test. Testing it needs a race hook.
- **Serverless.** `api/_handler.js` runs no worker. A serverless deployment needs an external scheduler that calls
  `runTick` (a later task).
- **Process lifetime.** The worker lives in the server process. A crash stops it until restart, and the next tick after
  restart picks up the stale work. Nothing is lost, because the work is in the database.
- **Shared test database.** The worker is global. The test file asserts on its own rows and its own spy calls, not on
  global counts. A leftover `settling` order from another test file (`ws-gate-spend-*`) is moved to `payment_hold` by the first
  tick that runs. It does not affect any assertion.
- **Pre-existing, not touched.** `npm run dev` (`tsx watch src/index.ts`) and `npx tsx src/index.ts` fail on HEAD at
  `src/accounting/three-way-match.ts`, which re-exports the type `DeliveryReceiptDoc` as a value. `tsc` elides it and the
  build works, so `npm start` on `dist/` is fine. This is outside this task. The worker was smoke-tested on `dist/index.js`.
- **Advisory lock keys** are a 64-bit hash of the key (ADR 0017). A collision only causes a skipped step, never a wrong result.

## Consequences
- Approvals expire, interrupted work resumes, confirmations finish and stranded claims are cleared without anyone opening a page.
- Nothing in the worker sends money. Its only money-related effect is the confirmation of a payment that was already sent.
- The owner's explicit recover route and every other existing caller behave as before.
