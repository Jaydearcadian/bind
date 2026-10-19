# ADR 0010: Integration files run one at a time

## Status
Accepted (2026-10-19)

## Context
Every integration file shares one PostgreSQL database and calls `runMigrations()` in `beforeAll`.
`tests/integration/three-way-match-migration.test.ts` drops and recreates the unique index on
`three_way_matches(order_id)`. With files in parallel, migrations deadlocked, upserts failed with
"no unique or exclusion constraint matching the ON CONFLICT specification" during that index window,
and unrelated tests failed intermittently (3 of 8 full runs before this change).

## Decision
- `fileParallelism: false` in `vitest.config.ts`. Tests inside a file still run in order.
- No test was changed to achieve this. The migration test and its assertions are unchanged.

## Consequences
- Integration runs are serial. The suite still finishes in a few seconds.
- Concurrent migrations from separate processes (for example two server instances starting at once) are
  not covered by this setting. `schema.sql` still runs as one unlocked multi-statement query there.
