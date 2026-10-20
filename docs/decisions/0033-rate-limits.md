# ADR 0033: Rate limits on failed authentication, webhooks and public creation; the operations runbook

## Status
Accepted (2026-10-20). Implements Task 12, part 2, of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`. Builds on
ADR 0021 (workspace tokens), ADR 0022 (webhook authentication), ADR 0031 (untrusted input: rate limiting was left for Task 12)
and ADR 0032 (metrics and logs, part 1). `src/ui/` is not touched (ADR 0016). The operations runbook is `docs/RUNBOOK.md`.
Amended the same day, before the commit was accepted: `GET /health` and `GET /ready` are exempt from the block, and a
production start without `DATABASE_URL` is refused (both described below).

## Context
Before this change nothing limited how often a client could hit an authentication failure, a webhook, the public workspace
creation routes or an authenticated route. A client could send unlimited bad tokens, unsigned webhook bodies or workspace
creation attempts. Each attempt costs a database lookup or a write, and a creation writes rows and template files.

The workspace tokens (ADR 0021) are 256 random bits, so guessing one is not the realistic threat. The limits bound what one
client can make the service do, and they make a probing client visible in the metrics and logs.

## Decision

### Scopes and defaults
All values can be overridden through `createApp({ rateLimits })`. Defaults are in `src/security/rate-limit.ts`.

| Scope | Keyed by | Window | Maximum | Counts |
|---|---|---|---|---|
| `authFailures` | client address | 60 seconds | 10 | every 401 response, on any route |
| `webhookCalls` | client address | 60 seconds | 300 | every `POST /api/webhooks/incoming` |
| `webhookBadSignatures` | client address | 60 seconds | 10 | 401 responses from `POST /api/webhooks/incoming` |
| `workspaceCreate` | client address | 1 hour | 5 | every `POST /api/workspaces/onboard` and `POST /api/workspaces`, successful or not |
| `apiPerToken` | token id | 60 seconds | 600 | every authenticated request, counted after authentication succeeds |

The client address is `req.ip`. The token key is the token's id, never the token.

### How a refusal works
- The gate is the first middleware after the request log, before body parsing. A refused request is answered
  `429 { "error": "Too many requests", "code": "RATE_LIMITED" }` with a `Retry-After` header of whole seconds, at least 1.
  The body carries no scope, count or detail.
- `apiPerToken` is checked by `tokenRateLimit`, placed right after `authenticate` in the route middleware arrays
  (`workspaceMember`, `workspaceOwner`, `anyWorkspaceOwner`, `authenticated`). Their exported names are unchanged.
- A 401 is counted when its response finishes, on every route. The webhook route's 401s are also counted in
  `webhookBadSignatures`. A 429 is never a 401, so a refusal is never counted as a failure.
- **A client over the `authFailures` limit is refused for every request, including with a valid token, until its window
  ends.** Its requests are not processed. The exception is `GET /health` and `GET /ready` (and `HEAD` on them): they skip the
  gate, so an orchestrator or a load balancer behind the same address as a bad client still sees the instance. They expose no
  data, and a 401 cannot happen on them. They still carry `x-request-id` and the request log. `/metrics` is not exempt: it is
  token-guarded and a target for guessing.
- Each 429 increments `bind_rate_limited_total{scope}` and writes one `rate_limited` warning with the request id, the scope
  and `ipHash`. `ipHash` is the first 12 hex characters of the SHA-256 of the address. The address, the token and the body
  are never logged.

### Why the block is per address, and refuses valid tokens too
The limit is on the address. A block that refused only the failed attempts would leave a hostile address able to use the
API with any valid credential it held. Refusing every request from the address for the window closes that. The cost is that
a shared address can be locked out: when a NAT or a proxy presents one address for many people, one person's failed attempts
block everyone behind it until the window ends. The operator must watch the `authFailures` scope (see the runbook).

### The client address and trusted proxies (`BIND_TRUST_PROXY`)
- `app.set("trust proxy", n)`, where `n` is `BIND_TRUST_PROXY` (a non-negative integer, default 0). With 0, `req.ip` is the
  socket address and `X-Forwarded-For` is ignored. The application never reads that header itself. Only Express's `req.ip`
  reads it, and only for the hops that are trusted.
- `n` must equal the number of proxies that append to `X-Forwarded-For` in front of the process.
  - Too small (0 behind a proxy): every client is the proxy's address, so one person's failures block everyone.
  - Too large: a client can put its own addresses in the header and choose its own key, which defeats the limit.
- A value that is not a non-negative integer stops startup and names the variable.

### Off by default only in tests (`rateLimitsEnabled`)
- An explicit `rateLimits.enabled` decides. Otherwise the default is **on**, except when `NODE_ENV` is `test`, where it is off.
- `BIND_RATE_LIMITS=off` turns the default off. It is for local development only. The only accepted value is `off`, so a typo
  such as `OFF` stops startup and names the variable.
- Why off in tests: every existing suite shares one client address and creates many workspaces. With the limits on by
  default, those suites would be refused. Tests that exercise the limits pass `enabled: true` and small limits.
- An explicit option in code wins over `BIND_RATE_LIMITS`, so a test that sets the option is not changed by a developer's
  local `.env.local`. The server does not pass an option, so the environment decides there.
- `NODE_ENV=test` in a deployed environment turns the limits off. Deployments must not set it.

### Storage and bounds
- The state is in memory, per process, and per scope. An expired window is removed when its key is next touched, and by a
  sweep every 256 hits.
- At most `maxKeys` (10,000 by default) keys are held per scope. Beyond that the oldest windows are removed first. Under a
  flood of distinct addresses a blocked address can therefore be released early. This is accepted: the alternative is
  unbounded memory.

## What is NOT done
- **No shared store.** Limits are per process. With N instances the effective limit is about N times the configured one, and
  a block on one instance does not apply on another. Serverless deployments (`api/_handler.js`) keep their counters per
  function instance, so the limits are not effective there.
- **No per-workspace quotas.** A single authenticated workspace is limited only per token, not per workspace.
- **No CAPTCHA or challenge.** A limited client is refused, not asked to prove it is a person.
- **Metrics is not exempt.** A metrics scrape from an address over the `authFailures` limit is refused with 429 until the window
  ends, while health and readiness from the same address still answer. A monitor that scrapes metrics from the same address as
  a bad client waits out the window. Accepted: exempting metrics would let a guesser probe the metrics token from a blocked
  address.
- **The 429 count is not directly tested.** A fixed window ends a block at the same instant whether or not the refused
  requests are counted, so no test observes "a 429 is not counted". The integration test
  `a 429 is not counted as an auth failure (the block does not extend itself)` checks the block's end time and
  `Retry-After` only. A mutation that counts 429s as failures passes every test (recorded below).

## Also in this change
- **Production DATABASE_URL (amendment, same change set).** The default `DATABASE_URL` names a local development database with
  a known password. `databaseUrlRule` (`src/config/env.ts`) refuses a production start (`NODE_ENV=production`) when
  `DATABASE_URL` is unset or empty, with an error that names the variable and never a value. Development and test keep the
  local default. The rule is in this ADR, not ADR 0032: that ADR covers logs, probes, metrics and shutdown. The check reads the
  environment after `.env.local` and `.env` are loaded, so a file in the working directory counts as configuration. In a
  checkout where `.env.local` sets `DATABASE_URL`, a production start passes; a production start without any file refuses.
- **The migration command.** `npm run db:migrate` (`node dist/db/migrate.js`) exited 0 without applying the schema, because the
  direct-run check matched only `migrate.ts`. `isDirectRun` now matches the program file, compiled or source. Verified by running
  both `npm run db:migrate` and `npm run db:migrate:dev`, and by `tests/unit/migrate-entry.test.ts`.
- **Schema on every start.** `src/db/schema.sql` runs on every server start under the migration lock. Its DDL is idempotent,
  with one data-changing step: duplicate `three_way_matches` rows are archived to `three_way_matches_archive` and deleted, so the
  unique index can be created. The step does nothing once there are no duplicates. The runbook says so.
- **Configuration.** `BIND_TRUST_PROXY` and `BIND_RATE_LIMITS` are validated at load (`src/config/env.ts`). Both are documented in
  `.env.local.example`.

## Mutation checks
Each mutation was applied alone to the working tree, the named tests were run, and the file was restored and compared byte for
byte with its backup.

| Mutation | Test that fails |
|---|---|
| Peek gate removed (a blocked address is no longer refused) | `repeated bad tokens from one client are answered 429 after the limit`, `a blocked client is refused even with a valid token until the window ends`, `another client is not affected by that block`, `the forwarded-for header is ignored when trust proxy is zero`, `a 429 has retry-after, the code and no other detail`, `rate limited requests are counted in the metrics and logged without the raw ip`, `a 429 is not counted as an auth failure (the block does not extend itself)` |
| Finish-hook counting of 401s removed | the same seven tests as above |
| Key bound removed | `a flood of distinct keys stays within the key bound` (unit) |
| Trust proxy forced to `true` (header always read) | `the forwarded-for header is ignored when trust proxy is zero` |
| Per-token limit removed from `workspaceMember` | `the per-token limit applies after authentication and counts per token` |
| Health and readiness exemption removed | `health and readiness answer while the client is blocked` |
| Production DATABASE_URL rule removed | `production without DATABASE_URL is refused`, `the refusal names the variable and never prints a value` (`tests/unit/database-url-config.test.ts`) |
| 429 counted as an authentication failure | none; see "The 429 count is not directly tested" above |

## Consequences
- An operator can see refusals by scope in the metrics and find the affected address by its hash in the logs.
- A client that fails authentication repeatedly is refused for every route until its window ends, at a bounded memory cost.
- Limits are not a security boundary across instances. The runbook says so, and says what to watch.
