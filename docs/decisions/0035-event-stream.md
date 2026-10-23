# ADR 0035: A replayable, ordered event stream per workspace, with a poll fallback

## Status
Accepted (2026-10-20). Implements part 2 of Task 12b of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`
(the event stream). Builds on ADR 0016 (the API is the product surface; the rebuilt UI, the SDK and agents follow it),
ADR 0021 (workspace tokens and tenancy), ADR 0031 (untrusted input), ADR 0032 (redaction, request ids, shutdown), ADR 0033
(rate limits) and ADR 0034 (the registry and the contract). `src/ui/` is not touched (ADR 0016). The client reference is
`docs/EVENTS.md`.

## Context
A rebuilt UI, the SDK and agents need to know what happens in a workspace (an approval decided, an order submitted, a
settlement held) without polling every route. The plan proposed an outbox table written by each action. This slice does
not add one: the audit log already records what happened, in the same transaction as the action, and it is what the
owner's history is read from. An event stream built on it has nothing to keep in sync and cannot announce something that
did not happen.

The hard part is ordering. A reconnecting client sends back the last id it received, and it must get every event it
missed, none twice, even when transactions commit out of order. A sequence number alone does not do this. A transaction
can take `seq` 5, another can take `seq` 6 and commit first, and a reader that has advanced to 6 never sees 5.

## Decision

### 1. The source is `audit_logs`, and the order is `(txid, seq)` with a visibility horizon
- `audit_logs` gets two columns (additive, idempotent, `src/db/schema.sql`):
  `seq BIGSERIAL` and `txid xid8 NOT NULL DEFAULT pg_current_xact_id()`, and the index `idx_audit_events` on
  `(workspace_id, txid, seq)`.
- An event id is `<txid>.<seq>`, both decimal. Rows are read in `(txid, seq)` order.
- A reader sees only rows with `txid < pg_snapshot_xmin(pg_current_snapshot())`. That is the oldest transaction still
  running at the reader's snapshot. Every transaction that has not finished has `txid >= xmin`, so its rows, and the rows
  of every later transaction, are held back until it finishes. When it finishes, its rows come in `(txid, seq)` order.
  A transaction that commits late is delivered before any row that committed after it began, so the stream never moves
  past it.
- Why this is safe: a row with `txid` T is delivered only when every transaction below T has finished. So when a cursor
  is at T, no row with a smaller txid can still appear. A cursor never has to go back.
- Why the sequence number is not the order: the sequence is taken when a row is written, not when its transaction
  commits, so two transactions can write in one order and commit in the other. The transaction id is assigned when the
  transaction first writes, so `txid` order and `seq` order can disagree. The late-commit test makes that happen on
  purpose (transaction A takes its id first, then B writes and commits, then A writes), so ordering by `seq` alone fails
  the test (checked; see the mutation table).
- The cursor predicate compares the native `xid8` values, `(txid, seq) > ($2::text::xid8, $3::bigint)`, ordered by
  `(txid, seq)`, so `idx_audit_events` serves the whole query (see "Index plan"). The id is rendered with `txid::text`.

### 2. The envelope and the allowlist
- `{ id, type, at, effectClass, decision, actor: { type, id }, workflowId?, data }`. `type` is the audit action. `at` is
  `created_at` as ISO 8601. `decision` is the policy decision.
- `data` is the audit evidence reduced to an **allowlist of keys** (identifiers, codes, statuses, quantities; the regex is
  in `src/api/events.ts`) and to **allowed value shapes** (a string of at most 200 characters, a finite number, a boolean,
  or a list of at most 20 such strings). Everything else is dropped: free text (reason, error, note, label, message,
  rationale), nested objects, extracted document text. The result is then redacted with `redactDeep` (ADR 0024), so a
  secret inside a kept string is replaced even if the writer forgot to redact it.
- `txHash` in `data` comes from the row's `tx_hash` column.
- The allowlist is an allowlist, not a denylist, so a new evidence key is not sent until someone decides it may be.

### 3. Staff filtering
- Staff do not receive types that start with `auth.`, `connector.` or `kitchen_capacity.` (the prefix includes the dot).
  Owners receive all. The filter is applied to every route that returns events, so a staff poll and a staff stream agree.
- This is per role, not per event. It is not a general per-event access control (see "Not done").

### 4. Routes, authentication and tenancy
- `GET /api/workspaces/:id/events` (stream) and `GET /api/workspaces/:id/events/poll` (JSON). Both are `member` routes, so a
  token of another workspace is 404 and no token is 401, as for every workspace route (ADR 0021).
- **The token is read from the `Authorization` header only.** A token in the query string is not read (401). The reason is
  that a URL is written to proxy logs, access logs, browser history and referrers. The consequence is that a browser's
  native `EventSource` cannot be used (it cannot set headers). Clients use the fetch API with a streaming body or the SDK.
  This is the only option that keeps the token out of a URL without a second credential.
- Reconnect cursor: the `Last-Event-ID` header, else the `lastEventId` query parameter (a convenience for clients that
  cannot set headers, which the EventSource API cannot do with a custom header). A new stream with no cursor starts after
  the newest event and does not replay history.

### 5. Reconnect rules
- The loop reads up to 100 finished events after its cursor, writes each as an SSE frame, and advances the cursor only
  after that frame has been written. A full batch is read again at once; otherwise the loop waits `pollIntervalMs` (default
  1 s).
- An id is `<txid>.<seq>`, so a reconnect with it is exact: the stream continues after that row.
- Rows a staff caller does not see still move the cursor on. A page of hidden rows is not read again forever.
- The poll route's `nextCursor` is the id of the last row **read**, not of the last event returned. Using the last returned
  event would leave a staff caller stuck on a page of hidden rows. This differs from the brief's wording, and only matters
  when rows are hidden.

### 6. Caps, backpressure and lifetime
- Caps are checked **before** any header is sent: 5 streams per token, 50 per workspace, 500 per process. A refused client
  gets `429 { "error": "Too many event streams", "code": "TOO_MANY_STREAMS" }` with `Retry-After: 5`. The check and the
  registration are one synchronous step, so two requests cannot both take the last slot.
- A write that the client does not drain is waited for at most 10 seconds (`writeWithBackpressure`), then the stream ends
  and the client reconnects with its last id. A slow client does not hold the server's memory.
- A stream ends by itself after one hour (`maxStreamAgeMs`), so a client's connection is refreshed and its cursor is
  re-taken from its own last id.
- Each loop checks that the token is not revoked. A revoked token's stream ends within one poll interval.
- Heartbeat: a comment `: ping` after 15 seconds without a write (`heartbeatMs`), to keep proxies open.
- On client disconnect the stream clears its timers, removes its listeners and releases its slot. The registry is
  process-wide, so shutdown can reach every stream.

### 7. Shutdown
- `createShutdown` takes an optional `beforeClose` hook. It is awaited first, before `server.close`. `src/index.ts` passes
  `closeAllEventStreams("shutdown")`, which writes `event: shutdown` and `data: {}` to each stream and ends it. A stream
  therefore never holds the 20-second shutdown; its client reconnects elsewhere with its last id.
- ADR 0032 said `server.close()` runs synchronously first. With the hook it runs after the hook's promise settles, one
  microtask later. Without the hook (the default, and all existing tests) it is still synchronous.

### 8. Metrics (aggregate only, ADR 0032)
- `bind_sse_streams` (gauge, open streams), `bind_sse_events_sent_total` (counter, events written; heartbeats are not
  counted), `bind_sse_streams_rejected_total{reason}` (`token`, `workspace`, `global`). No tenant label.
- The request log's `http.request` line and its duration are written when a stream ends by the server. A client that
  disconnects is not logged by the request middleware (as ADR 0032 already says of abandoned requests); the stream writes
  its own `events.stream_ended` line with the reason, the count and the duration.

### 9. Schema and migration
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for `seq` and `txid`, and one index. Idempotent: `schema.sql` was run twice on
  the local PostgreSQL 16.15 with no error. After the run, all 2,862 audit rows on that database had a `seq` and a `txid`.
- The rows that existed when the column was added share that migration's transaction id. Rows written later carry the
  ids of their own transactions (57 distinct ids on that database). That is harmless: a new stream starts from the newest
  event, and the (txid, seq) order among existing rows is the order of the scan that filled `seq`.
- The `GET /api/workspaces/:id/audit` route uses `SELECT *`, so its rows now also carry `seq` and `txid`. The contract
  allows extra fields (ADR 0034), and no existing field changed.

## Consequences
- An operator or client gets every event once and in order, across reconnects, instances (with the same database) and
  out-of-order commits, without a second table to keep consistent.
- Nothing is sent that is not an audit row, and nothing sent carries free text, nested objects or an unredacted secret.
- A workspace's events are never sent on another workspace's stream or poll: the workspace in the path is the filter, and
  the token must match it.
- The contract cannot test the stream like a JSON route (ADR 0034). The route is marked `contractTested: false` with the
  reason, and it is covered by `tests/integration/events.test.ts` and `events-shutdown.test.ts`.

## Index plan
The cursor query was checked with `EXPLAIN` on the local PostgreSQL 16.15, with `SET enable_seqscan = off`, because the
table is small and the planner would otherwise scan it. The workspace had 53 rows. The plan for the query after a cursor
(`ORDER BY txid, seq LIMIT 101`):

```
Limit
  ->  Index Scan using idx_audit_events on audit_logs
        Index Cond: ((workspace_id = $ws) AND (txid < pg_snapshot_xmin(pg_current_snapshot()))
                     AND (ROW(txid, seq) > ROW('474836'::xid8, '7867'::bigint)))
```

The newest-events query (`ORDER BY txid DESC, seq DESC`) is an `Index Only Scan Backward` on the same index. There is no Sort
node in either: the index order is the query order. With the default planner, this small table also takes the index for the
after-cursor query, because the workspace and cursor conditions are selective; the `enable_seqscan = off` setting only shows
that the index can serve it. The captured output is in the scratch run log, not in the repository.

**A bug found by the plan.** The first version selected `txid::text AS txid` and then `ORDER BY txid`. In an `ORDER BY`, an
output alias takes precedence over the column of the same name, so the sort was on the text, not the `xid8`. The plan showed a
Sort on `((txid)::text)`. Text order of decimal ids is wrong across a change in digit count (`"10"` sorts before `"9"`). The
existing tests did not catch it, because their transaction ids all had the same number of digits. The fix renames the output
columns (`cursor_txid`, `cursor_seq`), and the test `the order is numeric: transaction ids of different digit counts keep their
order` writes rows with explicit transaction ids 9, 10 and 100. Mutation M6 (order by `txid::text`) fails that test.

## Test changes
Three existing tests cannot sweep a long-lived route as they sweep a JSON route. They were changed, and only in these ways.
The authorisation is the coordinator's ruling on Task 12b, part 2.

1. `tests/integration/api-contract.test.ts`, "responses of the read routes validate against their schemas": the expected list of
   GET routes that are not contract tested is `["GET /api/workspaces/:id/events", "GET *"]` (the registry's order). A sibling
   assertion checks that the routes whose registry 200 is `text/event-stream` are exactly the stream route.
2. `tests/integration/api-contract.test.ts`, "the access level in the registry matches the behaviour": for a member route whose
   registry 200 is `text/event-stream`, the staff request is read for its status line only and then aborted. The body is never
   read, because the stream never ends. The no-token check still runs first. The skip is keyed on the registry content type.
3. `tests/integration/untrusted-input.test.ts`, "every route answers hostile input...": the GET query variants are not sent to a
   route whose registry 200 is `text/event-stream`, because a valid request would stay open. Path variants still run. The test
   asserts that the skipped set equals the stream route(s) exactly. The stream's own hostile input is tested in
   `tests/integration/events.test.ts`, "hostile input to the stream and poll routes is a JSON 4xx with no internal detail"
   (a NUL in the cursor, a 5,000-character `Last-Event-ID`, a SQL-looking cursor, array and NUL values on the poll route).

No assertion was weakened or removed. Each change is the same assertion with the stream route accounted for.

## Mutation checks
Each mutation was applied alone to the working tree, the named tests were run, and the file was restored and compared
byte for byte with its copy. The table is for the final code (the native `xid8` predicate).

| Mutation | Test that fails, and the assertion |
|---|---|
| M1: visibility horizon removed (`FINISHED` is `workspace_id = $1` only) | `a late-committing transaction is never skipped`: `round 1: nothing before A commits: expected [ ... ] to deeply equal []` |
| M2: ordering by `seq` only (cursor and order use `seq`) | `a late-committing transaction is never skipped`: `round 1: expected 'late.b1' to be 'late.a1'` |
| M3: per-token cap removed | `the per-token stream cap answers 429 and a closed stream frees its slot` |
| M4: key allowlist removed (every key kept) | `event data contains only allowed keys and no free text`, `the envelope keeps only allowed keys`, `long strings and nested values are dropped` |
| M5: staff filter removed | `staff do not receive auth, connector and capacity events but the owner does`, `staff filter hides sensitive event types` |
| M6: ordering by `txid::text` (the text-order bug above) | `the order is numeric: transaction ids of different digit counts keep their order`: `expected [ 10, 100, undefined ] to deeply equal [ 9, 10, 100 ]` |

## Tests
- `tests/unit/events.test.ts`: the cursor round-trip and its rejection, the envelope and allowlist, long and nested values,
  the staff filter, the backpressure helper.
- `tests/integration/events.test.ts`: the stream and poll routes over HTTP against PostgreSQL, including the late-commit
  scenario run five times, reconnect with no gaps and no duplicates, numeric order across digit counts, the hostile-input
  case for the stream and poll routes, cross-tenant isolation, the caps, revocation, heartbeats, metrics and resource release.
- `tests/integration/events-shutdown.test.ts`: a shutdown with an open stream ends it promptly with `event: shutdown`.
- `tests/integration/shutdown.test.ts`: the `beforeClose` hook runs before `server.close`.

## Not done
- **No LISTEN/NOTIFY.** A stream learns of a new event on its next poll, so latency is up to `pollIntervalMs` (1 s by
  default). Adding notifications would be a latency optimisation, not a correctness change; the poll is the source of truth.
- **No retention.** An audit row older than the retention the owner chooses cannot be replayed. No retention is defined
  yet, so no event is removed and none is promised beyond the audit log's own life.
- **No per-event access control** beyond the staff filter. Owners see every event of their workspace; staff see the
  allowed subset. A finer rule would need a decision about who may see which action.
- **Events exist only for audited actions.** An action that writes no audit row has no event, and this ADR does not add one.
  The plan's names (`approval.requested`, `effect.failed`, ...) are not audit actions and are not sent; `docs/EVENTS.md`
  lists the real ones.
- **Serverless.** A function instance cannot hold a stream for an hour. Use the poll route there (`docs/EVENTS.md`).
  The caps are per process, so on several instances the effective cap is the cap times the number of instances.

## Risks
- **A long transaction anywhere holds back every stream.** The horizon is global: the oldest running transaction of the
  database, not of the workspace. A transaction left open for minutes delays every workspace's events by that long. The
  writers hold transactions for short, bounded work; a leaked connection with an open transaction would stall the stream.
  Watch for `idle in transaction` sessions (`docs/RUNBOOK.md` section 15).
- **The first start after this change rewrites `audit_logs` once.** Adding a column with a volatile default rewrites the
  table under an exclusive lock, held by the migration. On this database (2,862 rows) that is immediate. On a large audit
  table it blocks reads and writes of that table for the rewrite. `docs/RUNBOOK.md` section 3.1 says to size the table and to
  run `npm run db:migrate` alone, in a maintenance window, after a backup.
- **An idle transaction holds back every stream** (see the first risk). `docs/RUNBOOK.md` section 15 has the `pg_stat_activity`
  query that finds it.
- **Clock and id assumptions.** The order relies on PostgreSQL's transaction ids, which increase monotonically within a
  cluster and never wrap for `xid8`. A future replica or a second database would need its own ordering; that is not in scope.
