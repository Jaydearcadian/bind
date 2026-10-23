# ADR 0017: Durable ledger for external effects

## Status
Accepted (2026-10-19). Module and tests in Task 5a. Order and quote call sites are wired in Task 5b (ADR 0018).

## Context
External effects (supplier quote and order, settlement transfer, owner notification) were not recorded durably
before they happened. After a crash nobody could tell whether the call went out. Recovery either repeated the
call (a double order or a double payment) or stuck the workflow.

## Decision
`src/effects/ledger.ts` provides `runEffect(spec, fn, opts)` and `listUnresolvedEffects(workspaceId?)`, backed by
the `effects` table in `src/db/schema.sql`.

- One row per idempotency key, written before `fn` runs: `status='started'`.
- `fn` resolves: the result is stored as JSON (bigint and Date tagged, see `src/effects/serialize.ts`) and the row
  becomes `completed`.
- `fn` throws: the row becomes `failed` with a redacted, 500-character message. The original error is rethrown.
- The request is never stored. Only `request_hash` (sha256 of the canonical tagged request) is stored.
- Callers for one key are serialized by a PostgreSQL session advisory lock (`pg_try_advisory_lock`) on a dedicated
  connection, held for the whole call. Waiters poll for up to 5 seconds, then report the key in doubt.
- Recovery (`reconcile`) and retry claims run only while holding that lock, and the retry claim is also a
  compare-and-swap on `attempts`.
- Fault injection (`src/effects/faults.ts`) is armed only when `NODE_ENV` is `test`.

## What the ledger guarantees
- A non-dedupe effect (`externalDedupes` not set) runs `fn` at most once per key. A row that is `started` or `failed`
  is an effect in doubt. It is reported as `EffectInDoubtError` and is not repeated, unless `opts.reconcile` returns
  `{found: false}`, which allows exactly one retry.
- `reconcile` returning `{found: true, result}` adopts the external result. `fn` is not called.
- An `externalDedupes` effect may be retried after a failure, because the external system dedupes on the key.
  `attempts` increases on each retry.
- Two concurrent callers never both run `fn` for one key. A recovery caller cannot reconcile a call that another
  caller (in this process or another one) is still making.
- The same key with a different request, or a key that belongs to another workspace, is refused with
  `EffectConflictError`. The message does not name the other workspace.
- A `completed` key replays its stored result (`replayed: true`) and never calls `fn` again.
- A database failure while marking `completed` leaves the row `started` (in doubt). `fn` is not run again.

## What the ledger does not guarantee
- It does not make an unknown outcome known. It records the unknown outcome and reports it. Resolution needs
  `reconcile` (an external lookup by key) or a person.
- A process that dies between the external call and the `completed` write leaves the row `started`. Recovery
  cannot tell whether the call happened, so it reports the row.
- A process that dies before the call also leaves the row `started`. The ledger cannot tell that case apart, so it
  is reported as in doubt too.
- A result that cannot be encoded (a function, a class instance, NaN) leaves the row `started` after the external
  call succeeded. Adapters must return plain data.
- A `failed` non-dedupe row is still in doubt. A throw does not prove the call did not go out.
- Idempotency keys are globally unique (`UNIQUE (idempotency_key)`). The existence of a key is therefore visible to
  any workspace that presents it. Task 5b must build keys that include the workspace id, so one tenant cannot
  probe another tenant's keys. The refusal message already reveals nothing else.

## Consequences
- Each `runEffect` call holds one dedicated PostgreSQL connection for the duration of `fn`. The shared pool is not
  used for the lock, so a burst of effects cannot starve it. Concurrent effects open one connection each.
- A lock wait is bounded at 5 seconds. A long external call makes a waiter report `EffectInDoubtError` rather than
  wait forever.
- The advisory key is a 64-bit hash of the idempotency key. A hash collision only causes unneeded waiting, never a
  wrong result, because the row lookup still compares workspace and request hash.
- `operation` is free text. It is not checked against `OPERATION_EFFECT_MAP` in `src/policy/effect-classifier.ts`,
  because the operations named in the plan (for example `supplier.submit_order`) are not in that map yet. Task 5b
  should add them to the map, or make `runEffect` enforce the map.

## Existing idempotency store (src/utils/idempotency.ts)
- `canonicalStringify` is exported. It is the one canonical JSON encoder, shared with the effects request hash.
  Its output for existing inputs is unchanged.
- `MemoryIdempotencyStore` and `PostgresIdempotencyStore` have no production callers. `MemoryIdempotencyStore` is used
  only by `tests/unit/idempotency.test.ts`. `PostgresIdempotencyStore` has no caller at all. Only
  `generateIdempotencyKey` is used in production (`src/workflows/procurement.ts`). Task 5b decides whether the stores
  are removed or replaced by this ledger.
- The `idempotency_keys` table is still required by `tests/integration/db-migrations.test.ts`, so it stays.

### Follow-up: the stores are deleted (ADR 0040)
Task 5b's decision is taken: `MemoryIdempotencyStore`, `PostgresIdempotencyStore`, their `IdempotencyStore` interface and
`DuplicateExecutionError` are deleted from `src/utils/idempotency.ts`, with the two tests that used only them. Reason: no production
caller, and the effects ledger is the single mechanism. Kept: `canonicalStringify` and `generateIdempotencyKey`, and the
`idempotency_keys` table (still required by `db-migrations.test.ts`).
