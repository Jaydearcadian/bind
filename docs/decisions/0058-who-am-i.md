# 0058. Who am I: `GET /api/me`

Status: Accepted

## Context

The browser app has no way to learn who is signed in. A workspace token (`bnd_`) and an account session (`bns_`, ADR 0052)
both resolve to the same `req.actor` (`src/auth/middleware.ts`, `src/auth/tokens.ts`, `src/accounts/sessions.ts`), but no route
reports that actor back. The app needs the workspace, the role, a display label, which kind of credential it holds, and whether
agents are paused, before it can show the right screens.

## Decision

- `GET /api/me`, operationId `getMe`, access `authenticated` (any valid token; the answer is the caller's own workspace only).
- The answer carries six fields, from `MeSchema` (`src/api/schemas.ts`, `.passthrough()` like the other response schemas, so an additive field does not break the contract). The server builds the answer field by field, so no secret can reach it:
  `workspaceId`, `workspaceName`, `role`, `label`, `credential`, `agentsPaused`.
- `workspaceName` and `agentsPaused` are read from the `workspaces` row. `credential` is `account_session` when `req.actor.tokenId`
  starts with `ses_`, otherwise `workspace_token`. `label` is the actor's label. Each field is set by name, so no token, session id,
  token id or hash can reach the answer.
- A missing workspace row answers 404 with `{ error: "Workspace not found" }`, the body other routes use. Workspace deletes cascade
  to tokens and sessions (`ON DELETE CASCADE`), so this branch cannot be reached through the data model. It is defensive only.
- `Cache-Control: no-store` on the answer.
- Registry entry with `contractTested: true`, so `tests/integration/api-contract.test.ts` calls it with a staff token and validates
  the response. `docs/ecosystem/exposure.json` classifies it as `read`. `me()` is a convenience wrapper in `sdk/src/client.ts`.
- The route is listed as an any-role route in `tests/integration/auth-tenancy.test.ts`.

## Base branch (a decision taken during the work)

The task was written against the stack that lives on `claude/capabilities-overview-c6elxr` (commit `409c2bb`). The worktree
branch was on `main` (`d517c1a`), which does not contain `src/auth`, `src/accounts`, `src/api/registry.ts`, `sdk/` or
`docs/ecosystem/`. `d517c1a` is an ancestor of `409c2bb`, and the worktree was clean. The worktree branch was therefore
fast-forwarded with `git merge --ff-only claude/capabilities-overview-c6elxr`. No commit was lost, and nothing was pushed.
The change is on top of `409c2bb`, not `main`. Reverting to `main` would mean resetting the branch to `d517c1a`, which
drops this change along with the 81 commits underneath it.

## Shared database (a finding, and a local decision)

Two sibling worktrees (`agent-a1f6b592d3e279857`, `agent-a9084eb5cccdc5111`) run the integration suite against the same
`bind_local` database. The first baseline run of `tests/integration` on the unmodified stack failed 5 tests:
`events.test.ts` (4, cross-workspace events visible on a stream and by poll) and `migration-lock.test.ts` (1, a deadlock
between concurrent migrations). Both are caused by the shared database, not by this change. For this worktree a separate
database, `bind_wt_abbae4a7`, was created on the same cluster, and every gate run here used
`DATABASE_URL=postgres://bind_local:bind_local_only@127.0.0.1:5432/bind_wt_abbae4a7`. The baseline on that database passed in full
(580 tests, 10 skipped, before this change). No other database or process was touched.

## Process incident (recorded, corrected)

`tests/unit/sdk.test.ts` already existed on the stack, with 18 tests. The first version of this change overwrote the file with a
new 3-test file without reading it first. The unit count fell from 423 to 408, which exposed the overwrite. The file was restored
byte for byte from the committed version (`git show HEAD:tests/unit/sdk.test.ts`, verified identical with `git diff --quiet`).
The two `me()` tests were then appended to it. The final diff for that file has 33 insertions and 0 deletions.

## Generated artifacts

`npm run api:spec`, `npm run sdk:generate`, `npm run capabilities:generate` and `npm run map:functions` were run. The OpenAPI,
SDK and capabilities diffs contain only the `getMe` additions and the count changes they imply (81 to 82 operations, 71 to 72
public API, 36 to 37 reads). The committed `docs/CODEBASE_MAP.md` was already stale before this change: its layer table had
been produced by an earlier tree, so regenerating it rewrote that table as well as adding the new route and functions (1608 to
1616 functions). The map was first regenerated before the last test files were added, which made `map drift` fail. It was
regenerated again from the final test set, and the drift gate then passed.

## Follow-up after review (2026-10-21)

The reviewer approved the first commit (941033e). The coordinator then asked for three changes, made on this branch after
merging the latest `claude/capabilities-overview-c6elxr` (4f189b6, a fast-forward):

1. `MeSchema` is `.passthrough()`, like every other response schema, instead of `.strict()`. An additive field no longer breaks the
   contract. The no-secret guarantee rests on the server building the answer field by field and on the HTTP test that searches
   every answer for token shapes.
2. `tests/integration/me.test.ts` gained an expired-session case: the session's `expires_at` is set to the past and the route answers 401.
   The closed-schema unit assertion became a passthrough assertion (an additive field passes, a wrong `role` value fails).
3. The 500 path of `GET /api/me` logs `me.unavailable` with the request id and the error message, through `log.error`, as
   `src/server/idempotency.ts` does. The response body is unchanged: `{ error: "Identity unavailable" }`.

The generated files were regenerated with the npm scripts. The code map changed more than this follow-up alone, because the merged
coordinator work changed the stack. The run below is the record for the final tree.

## Commands and results

Run from the worktree root, after `npm ci` (ran with Node v22.22.0). Integration and the full gate ran against
`bind_wt_abbae4a7`.

| Command | Result |
| --- | --- |
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npx vitest run tests/unit` | 54 files passed; 425 tests passed |
| `npx vitest run tests/integration` | 68 files passed, 1 skipped; 609 tests passed, 10 skipped (a standalone run of the same command on this tree printed 67 and 599; see the note below) |
| `npx vitest run tests/integration/me.test.ts` | 13 tests passed |
| `npx vitest run tests/unit/sdk.test.ts` | 20 tests passed (18 existing, 2 new) |
| `bash scripts/verify-local.sh` | `PASS=19 FAIL_OR_BLOCKED=0 NOT_RUN_ACCEPTED=0`; its integration gate printed 68 passed, 1 skipped; 609 passed, 10 skipped |

Note on the integration counts: `tests/integration` holds 68 `*.test.ts` files on disk. The runner reported 67 + 1 skipped in one run
and 68 + 1 skipped in the verify run, both on the same tree. The extra file in the verify run was not identified. Every file that ran
passed.

Gates inside `verify-local.sh`, all PASS: lint, typecheck, unit, integration, the contract in-process suite (4 files, 32 tests),
build, sdk:build, mcp:build, audit (`found 0 vulnerabilities`), spec drift, sdk drift, map drift, forge fmt --check, forge build,
forge test (24 tests across 3 suites), forge coverage, anvil integration, slither (`--fail-medium`), and test:e2e (10 tests).

Baseline before the change, for comparison: lint and typecheck exit 0, unit 54 files and 423 tests, integration 65 files
and 580 tests (plus 10 skipped) on the isolated database.

## What the tests cover

`tests/integration/me.test.ts` runs the app over real HTTP against PostgreSQL. It checks the owner token, the staff token, an
owner account session and a staff account session (the staff one through an invitation). Each gets the right role, label and
credential, and the exact six-key answer. It checks 401 for no token, a malformed token and an unknown token, the same 401 body
for each, and 401 after a workspace token is revoked and after an account session is revoked. It checks that the answer is
the token's own workspace only, that no answer contains `bnd_`, `bns_`, `tok_`, `ses_`, a token, a session id or a token id,
that `agentsPaused` follows `PUT /api/workspaces/:id/agents-paused` for both roles, and that `Cache-Control` is `no-store`.
The response also validates against `MeSchema` and the registry schema.

## Not verified

- The 404 branch (a missing workspace row) is not exercised. It cannot be produced through the data model.
- Privy sign-in uses a generated ES256 key, as in `accounts.test.ts`. Privy's own key and app are not exercised (see ADR 0051).
- No browser or UI check. The app does not call `/api/me` yet; this change only adds the endpoint and its contract.
- No remote, staging or hosted deployment check. CI (`.github/workflows/quality-gates.yml`) was not run.
- No race test for revoking a token during a request. The revocation tests run sequentially.
- The ADR numbers 0056 and 0057 do not exist in this tree. This ADR uses 0058 as the task specified.
