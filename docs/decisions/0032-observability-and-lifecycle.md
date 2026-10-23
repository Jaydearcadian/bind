# ADR 0032: Structured redacted logs, request ids, readiness, metrics, a migration lock and graceful shutdown

## Status
Accepted (2026-10-20). Implements Task 12, part 1, of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`. Builds on
ADR 0024 (one redaction module), ADR 0029 (the worker that runs in the server process), ADR 0031 (a client never sees a
stack or a database message) and ADR 0016 (`src/ui/` is not touched). Rate limits, the runbook and the auth-failure
throttling are part 2 of Task 12 and are not here.

## Context
Before this change the server wrote unstructured `console` lines. Some of them could print a database connection string
(the startup failure in `api/_handler.js`), a failed audit write was swallowed without a trace, `/health` returned the
database error text to anyone who asked, and nothing told an operator how many requests failed, how many approvals were
waiting, or whether the worker was still ticking. Several instances starting together also ran the schema DDL at the same
time, and a stop signal ended the process without waiting for requests or the worker.

## Decision

### Logs (`src/observability/logger.ts`)
- `log.debug|info|warn|error(event, fields?)` writes one JSON line: `{ ts, level, event, ...fields }`. debug, info and warn
  go to stdout; error goes to stderr. The level is `LOG_LEVEL` (`debug|info|warn|error`, default `info`).
- Every field value passes through `redactDeep` (ADR 0024): configured secrets, workspace tokens, bearer values, private key
  assignments and URLs that carry credentials are replaced. The event name is redacted too.
- A string is cut to 500 characters after redaction. An `Error` is logged as `{ name, message }`. No stack is ever logged.
- A call never throws. A field that cannot be encoded is replaced by a fixed note.
- The test sink (`setLogSink`) is honoured only when `NODE_ENV` is `test`, the same guard as `src/effects/faults.ts`.
- No `console.*` call remains in `src/` outside `src/ui/`. The logger itself uses `process.stdout` and `process.stderr`, so
  the CLI branch of `migrate.ts` uses the logger too and no exception is needed.

**Logged:** the event name; the request id; method (one of the known methods, else `OTHER`); the route pattern; status;
duration; the workspace id when a token authenticated the request; and the error name and redacted message for failures.
Worker step names, order ids, workflow ids and transaction hashes are logged where they already were evidence.

**Never logged:** the raw URL or path, the query string, request headers, the request body, a bearer token or workspace
token, a credential, a supplier or customer's text, or any stack trace.

### Request ids and the request log (`src/observability/request-context.ts`)
- The first middleware of `createApp`. `req.id` is the incoming `x-request-id` only when it matches
  `^[A-Za-z0-9_-]{8,64}$`; otherwise a new `crypto.randomUUID()`. A client cannot choose a log id that fails the pattern.
- The `x-request-id` response header is set on every response: success, 401, 404, 413, 500, the error handler's replies and
  static files.
- On `finish`, one `http.request` line: `{ requestId, method, route, status, durationMs, workspaceId? }`. `route` is the
  Express route pattern (`req.baseUrl` plus `req.route.path`) or `unmatched`, so a path such as `/api/workspaces/<id>/inventory`
  is logged as `/api/workspaces/:id/inventory`.
- The error handler logs `http.error` with the same `requestId` and no stack. Its response bodies are unchanged (ADR 0031).

### Liveness and readiness
- `GET /health` (public, liveness). Success is unchanged: `{ status: "ok", postgres: "connected", timestamp }`. On a database
  error it answers 500 `{ status: "error" }` only. The error is logged. It used to return the database message.
- `GET /ready` (public, readiness). Ready means `SELECT 1` answers within 2 seconds and the schema is present
  (`to_regclass` for `public.workspaces` and `public.effects`). Ready answers 200 `{ status: "ready" }`. Otherwise 503
  `{ status: "not_ready" }` with no reason in the body. The reason (`database_unavailable`, `database_timeout`,
  `schema_missing`) is logged as `ready.not_ready`.
- Neither route returns workspace data. The route-table guard in `tests/integration/auth-tenancy.test.ts` lists both as public.

### Metrics (`src/observability/metrics.ts`, `src/observability/metrics-route.ts`)
- A small in-process registry with counters, gauges and one histogram type, rendered as Prometheus text exposition 0.0.4.
  Label values are escaped (backslash, quote, newline). Numbers are plain decimal, never an exponent.
- `GET /metrics` answers Prometheus text. Its metrics:
  - `bind_http_requests_total{method,route,status_class}` (counter) and `bind_http_request_duration_seconds` (histogram,
    buckets 0.005 to 10 seconds), updated by the request middleware.
  - `bind_workflows{state}`, `bind_orders{status}` (gauges by state or status).
  - `bind_approvals_pending`, `bind_approvals_oldest_pending_age_seconds` (gauges; age 0 when nothing is pending).
  - `bind_effects_unresolved{status}` (gauge, `started` and `failed`, always both present), `bind_effects_retried` (gauge,
    effects with more than one attempt).
  - `bind_worker_last_tick_timestamp_seconds` (gauge), `bind_worker_tick_duration_seconds` (histogram),
    `bind_worker_step_errors_total{step}` (counter), `bind_worker_lag_seconds` (gauge; seconds since the last tick, or -1
    before the first tick, computed at each scrape).
- The database gauges are read with a few aggregate queries per scrape. The result is reused for at most 5 seconds. A
  database error during a scrape answers 503 `{ error: "Metrics unavailable" }` with no partial output.
- **Aggregate only.** Labels are a method, a route pattern, a status class, a state, a status, or a worker step. No workspace
  id, token, customer, supplier, or feedback text is a label or a value. This keeps the endpoint safe to scrape from a
  monitoring system that does not belong to a tenant, and keeps cardinality bounded by the code, not by clients.
- **Token.** `BIND_METRICS_TOKEN` (optional; at least 32 characters when set) is a bearer token for this route only. It is
  not a workspace token and is never accepted elsewhere. The comparison is constant time (both sides are hashed first).
  Unset: the route answers 404 as if it did not exist. Missing or wrong: 401 with the workspace body
  `{ error: "Authentication required" }`. The variable is in the redaction list, so it never reaches a log.

### Migration lock (`src/db/migrate.ts`)
- `runMigrations` takes the session advisory lock `migrations` on a dedicated connection (`src/db/advisory-lock.ts`) for the
  duration of the DDL. It waits up to 60 seconds. If the lock is still held, it throws
  "another process is running migrations ...". Two instances that start together run the schema one after the other.
- A crashed holder drops the lock when its session ends, so a stuck lock is not a permanent state.

### Shutdown (`src/server/shutdown.ts`, `src/index.ts`)
Order, for SIGTERM and SIGINT, and for `unhandledRejection` and `uncaughtException` (which log, redacted, then run the same
shutdown and exit 1):
1. `server.close()` runs at once, so no new connection is accepted (synchronous, before any await).
2. The worker is stopped. Its stop waits for a tick in progress; no new tick starts.
3. In-flight requests get `timeoutMs` (20 seconds). If they do not finish, every connection is closed (`closeAllConnections`)
   and the shutdown is forced.
4. The worker's stop is awaited, and only then is the pool closed.
- The whole shutdown is memoised: a second signal returns the first call's promise, so the pool closes exactly once.
- The process exits 0 when the shutdown is clean and 1 when it is forced or the process had failed. A hard exit fires
  5 seconds after the deadline if the shutdown itself hangs.

## Consequences
- An operator can read one line per request and find its failures by request id, with no secret in it.
- `/health` no longer reveals the database message to an unauthenticated caller.
- A migration started by two instances at once is safe; a migration blocked by a stuck lock fails clearly after a minute.
- A deploy's stop no longer cuts a payment's confirmation or an in-flight request in half. Requests get 20 seconds.

## What is not done
- No rate limiting, and no throttling of repeated bad tokens or signatures. That is Task 12, part 2.
- No runbook (`docs/RUNBOOK.md`). That is Task 12, part 2.
- No distributed tracing and no log shipping. Logs go to stdout and stderr for the host to collect.
- Serverless (`api/_handler.js`) runs no worker and has no shutdown hook. A function instance is not stopped gracefully,
  and its metrics are not scraped from it.
- Metrics are per process. Two instances each answer their own counters; a dashboard must aggregate them.
- A request the client abandons before the response finishes is not logged or counted, because `finish` is not emitted.
- The route label is the route pattern. A request that matches no route is counted as `unmatched`, not by its path.
