# Bind operations runbook

For the person on call. Commands come from `package.json`, the routes in `src/server/app.ts`, and the ADRs in
`docs/decisions/`. A command marked **(not run here)** was checked against the code and its tests, not against live data.
Decisions behind a behaviour are cited as ADR numbers. Shell examples assume the process runs in the repository root.

## 1. What runs

- **One Node process** (`node dist/index.js`, started by `npm start` after `npm run build`). It serves the HTTP API, the
  orphaned static UI (ADR 0016) and, unless `BIND_WORKER_ENABLED=false`, the background worker (ADR 0029). The worker ticks
  every 15 seconds. Each tick runs, in order: approval expiry, recovery of interrupted workflows, settlement confirmation
  polling, recovery of orders stuck in `settling`, and the restock sweep (only when `BIND_RESTOCK_SWEEP=true`, ADR 0030).
- **PostgreSQL.** The only durable store. Every workflow, order, effect, token and audit row is in it. Derived files
  (template materialisation, workflow evidence) are written under the working directory (`templates/`, `workflows/`) unless
  `BIND_ARTIFACTS_DIR` is set. The database is the source of truth; the files are not.
- **Serverless (Vercel), a caveat.** `vercel.json` sends `/api/*` and `/health` to `api/index.js`. That handler runs the
  migrations and the demo provisioning on the first request of each instance, and runs **no worker** (ADR 0029). Its
  `/ready` and `/metrics` requests fall through to the static shell, because `vercel.json` routes only `/api/*` and
  `/health` to the function. Rate-limit counters are per function instance (ADR 0033). Do not rely on the worker,
  readiness or metrics there without an external scheduler and a different health check. Production on Vercel must set
  `DATABASE_URL`, or the function refuses to load (section 2).

## 2. Environment variables

Read from `src/config/env.ts` and from the code paths named. `.env.local` and `.env` are loaded at start-up and never override
values already set in the environment. A value that fails validation stops startup with exit code 1, and the message names the
variable.

| Variable | Required | Unset means | Notes (ADR) |
|---|---|---|---|
| `NODE_ENV` | Set to `production` | `development` | Rate limits are off when it is `test` (ADR 0033). Never set `test` in a deployed environment. |
| `PORT` | No | 3000 | |
| `DATABASE_URL` | **Yes in production** | Development and test: a local URL with the password `bind_local_only`. Production: **startup is refused**, with an error that names the variable | The default is for local use only. `NODE_ENV=production` without `DATABASE_URL` (or with it empty) exits 1 (ADR 0033). A `.env.local` or `.env` file in the working directory counts as configuration. |
| `APP_BASE_URL` | No | `http://127.0.0.1:3000` | Used to build the links in owner notifications (ADR 0025) and the link in owner emails (ADR 0074). It is the one public base URL; there is no second one. With `BIND_EMAIL_PROVIDER` set it must be `https`, or `http` on 127.0.0.1 or localhost outside production. |
| `BIND_MASTER_SECRET` | For webhook signing | Webhook routes and the owner's webhook-secret routes answer **503** and process nothing (fail closed) | At least 32 characters. Derives every workspace's signing secret (ADR 0022). |
| `BIND_WEBHOOK_SECRET` | For standard webhooks | `POST /api/webhooks/incoming` (standard events) answers **503** | At least 32 characters. HMAC key for non-surface events (ADR 0022). |
| `BIND_CREDENTIAL_KEY` | For connector credentials | The credential store is disabled; the connector routes answer **503** | Base64 of exactly 32 bytes. Never stored in the database (ADR 0024). |
| `BIND_CREDENTIAL_KEY_PREVIOUS` | Only during key rotation | Nothing to decrypt with the old key | Decrypt-only (ADR 0024). Remove after a rotation with `failed=0`. |
| `PRIVY_APP_ID`, `PRIVY_VERIFICATION_KEY` | To let people sign in with Google or a wallet (ADR 0051) | The account routes answer **503**; workspace tokens are unaffected | The verification key is one to four `-----BEGIN PUBLIC KEY-----` blocks (P-256), concatenated; Privy lists two keys at once during rotation, so set both (fetch them from `https://auth.privy.io/api/v1/apps/<app id>/jwks.json`). A certificate, a private key, or a key of another type stops startup. Both variables must be set. Live sign-in is `NOT_RUN` until tried against the real Privy app. |
| `BIND_SESSION_MINUTES` | No | 60 | 5 to 1440. How long an account session lasts. |
| `BIND_METRICS_TOKEN` | To scrape metrics | `GET /metrics` answers **404** | At least 32 characters. Not a workspace token (ADR 0032). |
| `BIND_DEMO_OWNER_TOKEN` | No | No demo token is stored | Format `bnd_` plus 43 base64url characters. Its hash is stored as an owner token labelled `demo` on `ws-kitchen-main`. Removing the variable does **not** revoke it (ADR 0021). |
| `BIND_CORS_ORIGINS` | No | No CORS headers are sent | Comma-separated origins (ADR 0021). |
| `BIND_WORKER_ENABLED` | No | The worker runs | Only the exact value `false` disables it (ADR 0029). |
| `BIND_RESTOCK_SWEEP` | No | **Off** | Only the exact value `true` enables it. It starts replenishments on its own, within policy (ADR 0030). Any other value is ignored. |
| `BIND_TRUST_PROXY` | Behind a proxy | `0`: the socket address is the client | Number of proxy hops that append to `X-Forwarded-For`. Must be a non-negative integer (ADR 0033). |
| `BIND_PUBLIC_URL` | Yes, in production | The request's own host (wrong behind a proxy: see below) | The https origin of the deployment, for example `https://bind.example` (no path). It is the address `/mcp` reports and the only origin its Origin check accepts. `http` only for `127.0.0.1` and `localhost`. An invalid value stops startup. Precedence (ADR 0075, point 7): `BIND_PUBLIC_URL`; else an explicitly set `APP_BASE_URL` that is https (one setting is enough); else the request's host. Production with neither logs one startup warning naming `BIND_PUBLIC_URL`. |
| `BIND_EMAIL_PROVIDER` | To send owner notices by email (ADR 0074) | Email is **simulated**: a notice is recorded in memory and labelled `simulated`, nothing is sent, and the owner email routes answer **503** `EMAIL_NOT_CONFIGURED` | Only `resend`. Startup is refused unless `BIND_EMAIL_API_KEY` and `BIND_EMAIL_FROM` are set and `APP_BASE_URL` is https (or local outside production). Live sending is `NOT_RUN` until tried against a real provider account. |
| `BIND_EMAIL_API_KEY` | With `BIND_EMAIL_PROVIDER` | As above | The Resend API key, at least 8 characters, no spaces. It is never logged and never written to an error or an audit row, and text that carries it is redacted. Keep it in the host's secret store. |
| `BIND_EMAIL_FROM` | With `BIND_EMAIL_PROVIDER` | As above | The sender, for example `Bind <notices@your-domain>`. The domain must be verified at the provider. |
| `BIND_EMAIL_API_BASE` | No | `https://api.resend.com` | `https` only. Plain `http` is accepted only on 127.0.0.1 or localhost outside production; the tests use a local fake provider this way. |
| `BIND_RATE_LIMITS` | No | Limits are on (off in `NODE_ENV=test`) | Only `off` is accepted. For **local development only** (ADR 0033). |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn` or `error` (ADR 0032). Any other value stops startup. |
| `BIND_SETTLEMENT_ADDRESS` | For `arc-testnet` settlement | Arc settlement refuses, naming this variable | The settlement contract address (ADR 0013). |
| `ARC_RPC_URL` | For `arc-testnet` settlement | Falls back to `RPC_URL` | RPC endpoint of the Arc chain. Treat the whole URL as a secret: a provider URL often carries its access token in the path. `.env.local.example` shows only the placeholder `<ARC_RPC_TOKEN>`. |
| `ARC_SIGNER_PRIVATE_KEY` | For `arc-testnet` settlement | Arc settlement refuses, naming this variable | The single signer for every settlement transfer (ADR 0013). A secret. |
| `ARC_CHAIN_ID` | No | `5042002` (Arc testnet) | Explorer links are built only for this chain (ADR 0013). |
| `BIND_SETTLEMENT_DEPLOY_BLOCK` | No | `0` | First block scanned when looking up an earlier settlement (ADR 0013, ADR 0019). |
| `RPC_URL` | No | `http://127.0.0.1:8545` | Fallback RPC endpoint (`src/adapters/settlement/arc-l1.ts`). |
| `NEBIUS_API_KEY`, `NEBIUS_MODEL` | For `arc-testnet` replenishment | An `arc-testnet` replenishment fails with `INVARIANT_10_BLOCKED`; local workspaces take the offline path | Read directly from `process.env` (`src/workflows/procurement.ts`). Default model `nousresearch/Hermes-4-405B`. |
| `PARALLEL_API_KEY`, `TAVILY_API_KEY` | No | A deterministic offline reference is returned (`integrationMode: OFFLINE_DETERMINISTIC_FALLBACK`), not a live price | Read directly from `process.env` (`src/adapters/marketBenchmark.ts`). Do not treat that reference as a market price. |
| `TYPESAFE_API_KEY`, `TYPESAFE_API_URL`, `TYPESAFE_JEV_MODEL` | No | The external scorer is not called | Read directly from `process.env` (`src/domain/jevScorer.ts`). |
| `ENABLE_LIVE_CIRCLE_CLI`, `CIRCLE_AGENT_WALLET_ADDRESS` | No | The live Circle CLI is not used | Read by `src/adapters/circleAgentStack.ts`. |
| `SURFACE_PROVIDER_VERIFIED` | No | A surface binding cannot be stored as `verified` | Any non-empty value allows `verified`. Set it only after the provider is verified outside Bind (`src/adapters/socialSurface.ts`). |
| `BIND_ARTIFACTS_DIR`, `WORKFLOW_ARTIFACTS_DIR`, `TEMPLATES_ARTIFACTS_DIR` | No | Files go under the working directory; on Vercel, `/tmp/bind-artifacts` | `src/utils/artifacts.ts`. Derived output only. |
| `SETTLEMENT_MODE` | No | `local` | Read only as the default of `getSettlementAdapter()`, which no caller uses without an argument. The mode that counts is each workspace's `settlement_mode`. |
| `SESSION_SECRET` | No | Empty | Not read by runtime code. If set, its value is redacted from logs and stored text (`src/utils/redact.ts`). |
| `CHAIN_ID`, `SUPPLIER_ADAPTER_MODE`, `ALLOW_NO_CONTRACTS`, `GEMINI_API_KEY`, `LANGSMITH_API_KEY` | No | No effect | Declared in `src/config/env.ts` but not read by any runtime path (`GEMINI_API_KEY` and `LANGSMITH_API_KEY` are only redacted). Suppliers are simulated in code. |

Generate values with:

```
openssl rand -base64 48          # BIND_MASTER_SECRET, BIND_WEBHOOK_SECRET (at least 32 characters)
openssl rand -base64 32          # BIND_METRICS_TOKEN (at least 32 characters); BIND_CREDENTIAL_KEY (32 bytes)
node -e "console.log('bnd_' + require('crypto').randomBytes(32).toString('base64url'))"   # BIND_DEMO_OWNER_TOKEN
```

## 3. Start, stop and migrate

**Build and start.**

```
npm run build
npm start                 # node dist/index.js
```

Startup order: the migrations run under the migration lock (section 3.2), then the demo kitchen is provisioned (a failure
there is logged as `demo.not_provisioned` and does not stop startup), then the server listens, then the worker starts
(`worker.started`). A failed migration stops the process with exit code 1. Starting the process sends nothing by itself. The
worker's first tick, 15 seconds later, resumes interrupted workflows through the effects ledger (section 7.4).

**Stop.** Send `SIGTERM` (or `SIGINT`). The order is fixed (ADR 0032):

1. The server stops accepting connections.
2. The worker stops. A tick in progress is allowed to finish; no new tick starts.
3. In-flight requests have **20 seconds** to finish. After that every connection is closed (`shutdown.requests_cut_off`) and
   the process exits with code 1.
4. The database pool is closed. The process exits 0 when nothing was cut off, and the log says `shutdown.completed` with
   `forced`.

If shutdown itself hangs, the process exits 1 five seconds after the 20-second deadline. An unhandled rejection or uncaught
exception is logged and runs the same shutdown with exit code 1. A second signal does not start a second shutdown.

**Confirmed here:** a `SIGTERM` on an idle instance completed in about 200 ms with exit code 0. The 20-second cut-off is from
the code (`src/index.ts`); it was not exercised with a slow request.

### 3.1 Migrations

The schema is `src/db/schema.sql`. It runs on **every start**, so a separate step is optional:

```
npm run build
npm run db:migrate        # node dist/db/migrate.js
npm run db:migrate:dev    # tsx src/db/migrate.ts (needs the dev dependencies)
```

Each prints `db.migrate.started`, `db.migrate.completed` and `db.migrate.cli_completed`. The DDL is idempotent
(`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), with one exception: the file **deletes duplicate `three_way_matches` rows**
after copying them to `three_way_matches_archive`, so the unique index can be created. It changes nothing once no duplicates
remain. Take a backup (section 13) before the first start of a version that changes that statement.

**The first start of the event-stream schema rewrites `audit_logs` once** (ADR 0035). The statement
`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS txid xid8 NOT NULL DEFAULT pg_current_xact_id()` has a volatile default, so
PostgreSQL rewrites every existing row, under an exclusive lock on `audit_logs`. On a small database this is immediate. On a
large audit table it blocks reads and writes of that table for as long as the rewrite runs. Before that first start:

```
# Size of the table (the rewrite takes about as long as a full read and write of it):
psql "$DATABASE_URL" -c "SELECT pg_size_pretty(pg_total_relation_size('audit_logs'));"
# Take a backup (section 13.1), then run the migration alone, in a maintenance window, before any instance starts:
npm run db:migrate
```

Later starts do nothing for these columns.

**Query indexes (ADR 0040).** The first start also builds four indexes: `idx_audit_order` (audit rows by `orderId`),
`idx_workflows_state_global` (workflows by state, across workspaces), `idx_orders_status` and `idx_effects_status`. A plain
`CREATE INDEX` blocks writes to its table while it builds. On a large `audit_logs`, `workflows`, `orders` or `effects` table, run
the migration in a maintenance window as above, or build the index first with `CREATE INDEX CONCURRENTLY` (same definition). The
later `IF NOT EXISTS` then skips it. The workflow index has a different name from `idx_workflows_state` (workspace and state):
`IF NOT EXISTS` skips a name that already exists, so a reused name would silently build nothing.

### 3.2 Migration lock

Migrations take the session advisory lock `migrations` on a dedicated connection. Two instances that start together run the DDL
one after the other. A second instance waits up to 60 seconds. If the lock is still held, it fails with
`another process is running migrations and the lock was not free after 60 seconds`. The lock is released when its session ends,
so a crashed holder does not leave it held. Check `pg_stat_activity` for a long-running migration before you kill anything.

## 4. Health, readiness and metrics

| Endpoint | Auth | Answers | Meaning |
|---|---|---|---|
| `GET /health` | none | `200 {status:"ok", postgres:"connected", timestamp}`, or `500 {status:"error"}` | Liveness. The process is up and `SELECT 1` succeeds. It does not check the schema. |
| `GET /ready` | none | `200 {status:"ready"}`, or `503 {status:"not_ready"}` | Readiness. `SELECT 1` answers within 2 seconds and the `workspaces` and `effects` tables exist. The reason (`database_unavailable`, `database_timeout`, `schema_missing`) is logged as `ready.not_ready`, never in the body. |
| `GET /metrics` | `Authorization: Bearer $BIND_METRICS_TOKEN` | Prometheus text (0.0.4) | `404` when the token is unset; `401` when missing or wrong; `503 {error:"Metrics unavailable"}` when the database read fails. |

```
curl -s http://127.0.0.1:3000/health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/ready
curl -s -H "Authorization: Bearer $BIND_METRICS_TOKEN" http://127.0.0.1:3000/metrics
```

**Metrics** (per process; labels are aggregate only, never a workspace id, token or customer text):

- `bind_http_requests_total{method,route,status_class}`, `bind_http_request_duration_seconds` (histogram)
- `bind_rate_limited_total{scope}`: requests answered 429, by scope (ADR 0033)
- `bind_workflows{state}`, `bind_orders{status}`
- `bind_approvals_pending`, `bind_approvals_oldest_pending_age_seconds`
- `bind_effects_unresolved{status}` (`started`, `failed`), `bind_effects_retried`
- `bind_worker_last_tick_timestamp_seconds`, `bind_worker_tick_duration_seconds`, `bind_worker_step_errors_total{step}`,
  `bind_worker_lag_seconds`

**Scrape from another address.** A metrics scrape from an address that is over the auth-failure limit is refused with 429 until the
window ends (section 9). `/health` and `/ready` from the same address still answer 200. This was seen on a test instance: the
scrape from the blocked address got 429, and the same scrape from a different address got 200.

**Suggested alerts.** Thresholds are starting points to tune, not values the code enforces.

| Signal | Suggested alert | Meaning |
|---|---|---|
| `bind_worker_lag_seconds` | `> 120` for 5 minutes | No tick for two minutes. `-1` means this process runs no worker (`BIND_WORKER_ENABLED=false`) or has not finished a tick since start. A deployment with no worker in any process has nothing to finish settlements. |
| `bind_approvals_oldest_pending_age_seconds` | `> 3600` | An owner decision is waiting. Approvals past their window are expired by the worker. |
| `bind_effects_unresolved{status=~"started\|failed"}` | `> 0` for 10 minutes | An external call whose outcome is unknown. A person must look (section 7). |
| 5xx ratio | `sum(rate(bind_http_requests_total{status_class="5xx"}[5m])) / sum(rate(bind_http_requests_total[5m])) > 0.01` | Failing requests. |
| `bind_rate_limited_total` | `sum by (scope) (rate(bind_rate_limited_total[5m])) > 0` sustained | Credential guessing, or a shared address that has been locked out (section 9). |
| `bind_worker_step_errors_total` | any increase over 10 minutes | A worker step failed. The message is in `worker.step_failed` in the logs. |
| `/ready` | not 200 for 2 minutes | The database is unreachable, or the schema is missing. |

No metric counts payment holds or needs-attention items. Those are read per workspace with the API (section 7). Metrics are
per process: across several instances, aggregate with `sum` before you alert.

## 5. Logs

One JSON object per line. `info`, `warn` and `debug` go to stdout; `error` goes to stderr. The level is `LOG_LEVEL`.

- `http.request`: `requestId`, `method`, `route` (the route pattern, never the path), `status`, `durationMs`, and `workspaceId`
  when a token authenticated the request.
- `http.error`: the same `requestId`, and the redacted message. There is no stack.
- `rate_limited`: `requestId`, `scope`, `ipHash` (section 9).
- `worker.step_failed`, `ready.not_ready`, `db.migrate.*`, `server.*`, `shutdown.*`, `demo.*`.

Every response carries `x-request-id`. A safe incoming id (8 to 64 letters, digits, `_` or `-`) is kept, so a caller can
send its own id and find its lines. Find a request's lines:

```
grep '"requestId":"<id>"' <log file>
```

Never logged: the URL, the query string, headers, the body, a bearer or workspace token, a credential, or a stack. A client
that disconnects before the response finishes is not logged (ADR 0032).

## 6. Owner controls

### 6.1 The pause switch

```
curl -s -X PUT -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"paused":true}' http://127.0.0.1:3000/api/workspaces/<workspaceId>/agents-paused
```

Use `{"paused":false}` to resume. Owner only. The answer is `{workspaceId, paused}`, read back from the row.

While paused (ADR 0023): a replenishment is refused; a commitment is denied at the gate (`AGENTS_PAUSED`); an approval given
after the pause is recorded as rejected by the policy re-check (ADR 0022), so the replenishment must be started again after
resuming; a payment is not sent (the order keeps its status, and the reconcile answer carries `hold: AGENTS_PAUSED`; reconcile
again after resuming); a stock count is stored, and no replenishment starts.

Not stopped by a pause: confirming a payment that was already sent (`POST /api/orders/:id/confirm-settlement`), reads, rejecting
or revoking an approval, cancelling a workflow, token, policy and supplier administration, and the webhook secret.

**Known gap.** The pause is checked immediately before a transfer, and the check and the transfer are not in one transaction.
A pause written in that short window can still pay (ADR 0023).

### 6.2 The restock sweep (opt-in)

`BIND_RESTOCK_SWEEP=true` makes the worker start a replenishment for each low stock item it finds, at most 25 per tick, at most
one per item every 6 hours. A replenishment whose amount is under the workspace's approval threshold and daily budget is placed
without an owner's approval (ADR 0030). It is off unless set.
To turn it off, unset the variable and restart. Paused workspaces are not swept.

## 7. Recover a stuck workflow

Use this section when an owner reports an order, a payment or an approval that has not moved.

### 7.1 Look first

```
curl -s -H "Authorization: Bearer $OWNER_TOKEN" http://127.0.0.1:3000/api/workspaces/<workspaceId>/needs-attention
```

The answer is `{items, capped}`, oldest first, at most 200 items. Each item has `kind`, `id`, `since`, `codes` and `nextAction`.
Items carry ids, codes and times only. Read the item, then act on it:

| `kind` | What it means | Action |
|---|---|---|
| `order_submission_in_doubt` (`SUPPLIER_OUTCOME_UNKNOWN`, `RESOLVE_ORDER_WITH_SUPPLIER`) | A workflow in `submitted` for over 5 minutes whose order is still `submitted`. The supplier may or may not have the order. | Check the supplier's own records for the order number (below). Do not resend. Then run section 7.3. |
| `effect_in_doubt` (`RESOLVE_EFFECT`) | An external call (supplier, order or transfer) with no recorded result (section 7.4). | Check the external system for the call. No route or script marks an effect resolved (see 7.4). |
| `payment_hold` (`RECONCILE_ORDER`) | A payment is held. The code is the `hold` of the latest audit row for the order (section 7.5). | Fix the cause the code names, then reconcile (section 7.5). |
| `settlement_unconfirmed` (`CONFIRM_SETTLEMENT`) | A transfer was sent and its outcome is not confirmed. `POLLING_STOPPED` means the worker stopped asking after 24 hours. | Usually let the worker finish. If it stopped, `POST /api/orders/:id/confirm-settlement` (owner, **not run here**) asks the adapter for the outcome. It pays nothing. |
| `customer_order_held`, `menu_proposal_awaiting`, `approval_pending` | An owner decision is waiting. | Decide through the owner routes (`/api/approvals/:id/approve` or `/reject`, `/api/workspaces/:id/customer-orders/:orderId/accept`, the menu proposal routes). |

Owner notifications are **not delivered**. The notification emitter records each one in memory and answers `status: simulated`
(`src/adapters/web2/notifications.ts`). Owners see a waiting item only by reading this list or the approvals list, so check them.

For the supplier's order number of workflow `wf-…`, the order id is `ord_<workflowId>` and the order number is `PO-` followed by
the first 8 hex characters of its SHA-256, in upper case:

```
node -e "console.log('PO-' + require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0,8).toUpperCase())" "ord_<workflowId>"
```

For `wf-example-1` this prints `PO-8F4B724C`. (Verified.)

### 7.2 The workflow list

```
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/workspaces/<workspaceId>/workflows
```

Workflow states: `draft`, `request_sent`, `quote_received`, `awaiting_approval`, `authorized`, `submitted`, `confirmed`,
`reconciled`, `failed`, `cancelled` (`src/workflows/types.ts`).

### 7.3 The explicit recovery route

```
curl -s -X POST -H "Authorization: Bearer $OWNER_TOKEN" http://127.0.0.1:3000/api/workspaces/<workspaceId>/recover
```

Owner only, for one workspace. It answers `{recoveredCount, failedCount, inDoubt, details}`. It resumes each interrupted workflow
through its own records only: a `submitted` workflow through its own order id, an `authorized` workflow after the commitment gate
checks it again. A submission the ledger reports in doubt is listed in `inDoubt` and is **not resent**.

Do not run it for a workflow that a request is handling right now. The worker's recovery skips workflows updated in the last 60
seconds, but this route has no such filter (ADR 0029). The effects ledger still prevents a second supplier call for the same key.

### 7.4 What "in doubt" means, and why nothing is resent

A call is **in doubt** when the effects ledger (`effects` table, ADR 0017) has a row that is `started` or `failed` with no
result. The call may have reached the supplier or the chain, or it may not have. A crash between the call and the record, a
timeout, or an unknown error all leave this state.

Bind repeats an in-doubt call **only** when the adapter's lookup reports that the earlier call is not there (`found: false`). Then
the ledger allows exactly one more attempt (ADR 0017, ADR 0018). For an order or a transfer, an adapter without a lookup is never
repeated. Quote requests are a separate case: the supplier dedupes them on the key (ADR 0018). Two things follow:

- The **simulated supplier has a lookup**, so the worker's recovery (and the explicit recover route) can send a simulated order
  once more. Real adapters must implement a lookup against their own records before they are used in production. None exists yet.
- The Arc transfer adapter has a lookup too, but a transfer is repeated only when a person calls the reconcile route (section 7.5).

The unresolved rows:

```
psql "$DATABASE_URL" -c "SELECT id, workspace_id, operation, idempotency_key, status, attempts, updated_at
  FROM effects WHERE status IN ('started','failed') ORDER BY updated_at;"
```

To resolve one, look in the external system for the call, using its key: the supplier key `idem_ord_<orderId>` and the ledger key
`<workspaceId>:order:<orderId>` for an order; the adapter key `idem_pay_<orderId>` and the ledger key `<workspaceId>:settle:<orderId>`
for a transfer. Record what you found in the incident note.
**No route or script changes an effect row.** A person (an engineer) must change it, after the outcome is known. Until then
the row stays in `needs-attention`. Do not resend the call to see what happens: a second supplier order or a second transfer is
money, and the ledger exists to prevent exactly that.

### 7.5 Payment holds and reconciliation

`POST /api/orders/:id/reconcile` (owner, **not run here**, because it can move money) asks the settlement engine to pay a
confirmed order. It answers with `status`, `reconciled`, and, when it did not pay, a `hold`. The holds (`src/workflows/settlement.ts`):

| `hold` | Meaning | Before you reconcile |
|---|---|---|
| `SETTLEMENT_OUTCOME_UNKNOWN` | An earlier transfer attempt may have moved money. The order is held in `payment_hold`. | See below. |
| `SETTLEMENT_REJECTED` | The contract or the request refused the payment. No transfer was made. | Fix the reason in the audit row (`settlement.rejected`). A reconcile sends the transfer again. |
| `SETTLEMENT_FAILED` | The transfer reverted, or the adapter refused it. | Check the audit row (`settlement.failed`). A reconcile tries again, after a lookup. |
| `AGENTS_PAUSED` | The workspace is paused (ADR 0023). | Resume the workspace (6.1), then reconcile. |
| `SUPPLIER_NOT_VERIFIED`, `SUPPLIER_PAYMENT_ADDRESS_MISSING`, `WORKSPACE_SETTLEMENT_ADDRESS_MISSING` | A payee or payer record is missing or not verified. Nothing is paid or restocked. | Correct the supplier's payment address (`POST /api/workspaces/:id/suppliers`) or the workspace settlement address (`PUT /api/workspaces/:id/policy`), then reconcile. |
| `RECONCILE_IN_PROGRESS` | Another call holds the claim. | Wait, then look again. |

**`SETTLEMENT_OUTCOME_UNKNOWN` on Arc testnet.** Before reconciling, find out whether the transfer happened:

1. Read the audit row `settlement.in_doubt` for the order (`GET /api/workspaces/<workspaceId>/audit`). It holds the effect id,
   the attempts and the hold, never a transaction hash.
2. Compute the lookup key the adapter uses (`keccak256(toHex(orderId))`), with the order id in an environment variable:

   ```
   ORDER_ID="ord_<workflowId>" node --input-type=module -e "import { keccak256, toHex } from 'viem'; console.log(keccak256(toHex(process.env.ORDER_ID)))"
   ```

   (Verified: `ord_wf-example-1` gives `0xbe7dd8e9…8307`.)
3. Look for a `SettlementExecuted` event with that indexed order id at the settlement contract (`BIND_SETTLEMENT_ADDRESS`) on the
   Arc testnet explorer (the adapter builds transaction links under `https://testnet.arcscan.app/tx/`). Check the signer's recent
   transactions to the contract as well. A transfer still in flight has no event yet, so the lookup cannot see it (ADR 0019).
4. If the event exists, reconcile: the lookup adopts that transfer and does not send again.
   If none exists **and** no transfer can still be in flight, reconcile sends one transfer. The contract refuses a second
   settlement for the same order (`OrderAlreadySettled`), but do not rely on that alone.

On the local simulator (`settlement_mode` `local`) transfers exist only in memory and are lost on restart. No money moves.

### 7.6 Mandatory rules

- Do not replay an effect by hand: no supplier order, no transfer, no quote request.
- Do not edit a row in `orders`, `effects` or `workflows` to make a state look finished. Record the outcome; an engineer changes
  the state through the code.
- A restart does not resolve anything. The worker's next tick acts on whatever is in the database, as in section 7.4.

## 8. Cancel a workflow

```
curl -s -X POST -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"reason":"Customer withdrew the request"}' \
  http://127.0.0.1:3000/api/workspaces/<workspaceId>/workflows/<workflowId>/cancel
```

Owner only (not run here). `reason` is optional, at most 200 characters, stored as data and never echoed in an error.

| Answer | Meaning |
|---|---|
| `200 {workflowId, state:"cancelled"}` | Cancelled. `alreadyCancelled: true` when it already was. |
| `404 WORKFLOW_NOT_FOUND` | Not in this workspace, or missing. |
| `409 WORKFLOW_NOT_CANCELLABLE` with `nextAction` | `submitted`: `RESOLVE_ORDER_WITH_SUPPLIER` (the order may already be placed). `confirmed`: `RECONCILE_OR_CONTACT_SUPPLIER`. `reconciled` or `failed`: `NONE_FINISHED`. |
| `409 WORKFLOW_STATE_CHANGED` | The state moved while the cancel was running. Nothing was cancelled. Read the state again. |

Cancelling a workflow awaiting approval revokes its approval. A cancel never orders, pays or contacts a supplier.

## 9. Rate limits

Defaults (ADR 0033, `src/security/rate-limit.ts`): failed authentications per client address, 10 per minute; webhook calls per
address, 300 per minute; bad webhook signatures per address, 10 per minute; workspace creation per address, 5 per hour; requests
per token, 600 per minute. A refused request gets `429 {"error":"Too many requests","code":"RATE_LIMITED"}` and a `Retry-After`
header in seconds.

**What a block means.** A client address over the failed-authentication limit is refused for **every** request, including
requests with a valid token, until its window ends. The exceptions are `GET /health` and `GET /ready`, which still answer 200 from a
blocked address, so an orchestrator or load balancer keeps seeing the instance. `/metrics` is refused. A shared NAT or proxy means
one person's failures can block everyone behind it.

**See it.**

```
curl -s -H "Authorization: Bearer $BIND_METRICS_TOKEN" http://127.0.0.1:3000/metrics | grep bind_rate_limited_total
```

Then the log lines: `grep '"event":"rate_limited"' <log file>`. They show `scope` and `ipHash`, never the address. To find the
hash of an address you suspect (**verified**):

```
node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex').slice(0,12))" 203.0.113.7
```

**Respond.** A block ends by itself when its window ends. The state is in memory and per process: a restart clears every block
on that process. Several instances need a restart each, and a block on one instance does not apply on another.

**Check the trusted-proxy setting first** whenever many clients are blocked at once. If Bind runs behind a proxy and
`BIND_TRUST_PROXY` is `0`, every client looks like the proxy and one person's failures block all of them. Set
`BIND_TRUST_PROXY` to the number of proxy hops that add to `X-Forwarded-For`. Too high a value lets a client choose its own
address. Confirm the value with the platform's documentation, not by guessing.

Limits are code defaults. Changing one needs a deploy.

## 10. Tokens

Workspace tokens are bearer secrets (ADR 0021). Only their SHA-256 hash is stored. The plaintext is shown once, when issued.
Roles: `owner` (everything, including tokens and the webhook secret) and `staff` (read, inventory, replenish, extract documents).

### 10.1 Issue the first token for an older workspace

```
npm run token:issue -- <workspaceId> <label> owner     # or: staff
```

It prints the token once, then `id=… workspace=… role=… label=…`. An unknown workspace prints `Workspace '<id>' not found.` and
exits 1. (Verified with a throwaway workspace; both error paths checked.) Give the token to its holder through a secure channel.

### 10.2 Rotate a workspace token

There is no single rotate call. Issue, verify, revoke.

```
# 1. Issue the replacement (owner token in the header). Returns 201 {id, role, label, token}; the token is shown once.
curl -s -X POST -H "Authorization: Bearer $OWNER_TOKEN" -H "Content-Type: application/json" \
  -d '{"role":"owner","label":"<new label>"}' http://127.0.0.1:3000/api/workspaces/<workspaceId>/tokens

# 2. Confirm the new token works, then find the old token's id:
curl -s -H "Authorization: Bearer $OWNER_TOKEN" http://127.0.0.1:3000/api/workspaces/<workspaceId>/tokens

# 3. Revoke the old token (200 with its summary; the old token gets 401 from the next request).
curl -s -X DELETE -H "Authorization: Bearer $NEW_OWNER_TOKEN" \
  http://127.0.0.1:3000/api/workspaces/<workspaceId>/tokens/<oldTokenId>
```

Revocation answers `404 TOKEN_NOT_FOUND` for another workspace's token, an unknown token, or one already revoked. It answers
`409 LAST_OWNER_TOKEN` when the revocation would leave no active owner. Create the replacement first, and revoke with a token that
is still valid. (Verified: create 201, revoke 200, old token 401, last owner 409, bad role 400.)

A staff token cannot call owner routes (403), so it cannot issue, rotate or revoke tokens.

### 10.3 Connect an agent by URL (hosted MCP, ADR 0075)

Issue a **staff** token for the agent (`POST /api/workspaces/:id/tokens` with `"role": "staff"`), then give the agent the URL
`https://<your-bind-api-host>/mcp` and the header `Authorization: Bearer <that token>`. To stop an agent, revoke its token
(`DELETE /api/workspaces/:id/tokens/:tokenId`); its next call is `401`. An owner key or an account session at `/mcp` is `403`.

The endpoint is stateless, so there is nothing to clean up on the server when an agent disconnects.

**What is recorded.** Each write tool (a tool that is not read-only) writes one audit row, `action` `agent.tool_called`, when its call
finishes. Its `actor_type` is `staff_key`, its `actor_id` is the key's id (`tok_…`), and its `evidence` is the key's label, the tool name,
`outcome` (`ok` or `error`) and `status` (the API's HTTP status for a refusal, `null` for a success). Its `request_id` is the same as the
API call's and as the rows that call wrote, so you can join them. Read tools write no row. The token, the arguments and the answer are never
recorded. The row is visible in the audit log and in the activity feed to staff and owner alike (ADR 0075, point 10).

**Rate limits.** Each `tools/call` costs exactly two of the token's per-token hits: the MCP request and the API call it makes. Batches are
refused, so one request runs one tool call (ADR 0033, 0075).

**Client addresses.** Limits are keyed by the client address. When `/mcp` is exposed, set `BIND_TRUST_PROXY` to the number of proxy hops
in front of the app. At `0` behind a proxy, every client shares the proxy's address, so one client's bad keys block all of them.

Check the endpoint is up: an authenticated `GET /mcp` answers `405` with its own address; an unauthenticated one answers `401`.
If `POST /mcp` answers `503` with "The MCP endpoint is not available", the deployment is missing the built MCP module
(`npm run mcp:build`, which `scripts/vercel-build.sh` runs) and the rest of the API is unaffected.

## 11. Webhook secrets

Two secrets, two mechanisms (ADR 0022). Both sign the **raw bytes** of the body. Headers: `x-bind-timestamp` (seconds) and
`x-bind-signature` (HMAC-SHA256, hex, over `<timestamp>.<raw body>`). A timestamp more than 300 seconds old, or 60 seconds in
the future, is refused. Bind does not queue events it refuses, so the sender must retry.

### 11.1 A workspace's surface secret (the messaging bridge)

Shown to the owner only (`Cache-Control: no-store`; the view is audited):

```
curl -s -H "Authorization: Bearer $OWNER_TOKEN" http://127.0.0.1:3000/api/workspaces/<workspaceId>/webhook-secret
```

Rotate:

```
curl -s -X POST -H "Authorization: Bearer $OWNER_TOKEN" \
  http://127.0.0.1:3000/api/workspaces/<workspaceId>/webhook-secret/rotate
```

The answer is the new `{secret, version}`. **The old secret stops validating at once, with no grace period.** So: rotate,
and switch the bridge to the new secret in the same moment. Events signed with the old secret are refused with 401 until it
switches. (Verified: version 1 becomes 2.)

### 11.2 The standard webhook secret (`BIND_WEBHOOK_SECRET`)

There is no route for it. Change the value in the environment (at least 32 characters) and restart. Senders must change at the
same moment. Between the restart and the switch, deliveries get 401; if the variable is unset the route answers 503. (Verified:
a signed event is accepted, a replay is answered `accepted:false` as a duplicate, and a wrong secret gets 401.)

### 11.3 The master secret (`BIND_MASTER_SECRET`)

Every workspace's surface secret is derived from it with the workspace id and version (ADR 0022). Changing it changes **every
workspace's secret at once**, and it takes a restart. Then each bridge must fetch its workspace's new secret with the owner view
route in 11.1. Nothing is stored that could keep the old value. Plan this as a maintenance event.

## 12. Connector credential key

Connector secrets are encrypted with `BIND_CREDENTIAL_KEY` (ADR 0024). The database holds ciphertext, not keys.

**Never change `BIND_CREDENTIAL_KEY` alone.** Stored credentials cannot be decrypted with a different key. Rotate:

```
# 1. Generate the new key:
openssl rand -base64 32
# 2. Set BIND_CREDENTIAL_KEY=<new key> and BIND_CREDENTIAL_KEY_PREVIOUS=<the old key>, then restart the process.
# 3. Re-encrypt every live credential (prints counts only, never a key):
npm run credentials:rotate-key          # prints rotated=N skipped=N failed=N
# 4. Only when failed=0: unset BIND_CREDENTIAL_KEY_PREVIOUS and restart.
```

Without both keys set, the script prints `Set BIND_CREDENTIAL_KEY (the new key) and BIND_CREDENTIAL_KEY_PREVIOUS (the old key)
before rotating. No key is printed.` and exits 1 (**verified**). With `failed` above zero, the rows that could not be re-encrypted
are unchanged and the exit code is 1: keep the previous key until it is zero. The rotation itself was not run against data here;
the test suite covers it (`tests/integration/credentials.test.ts`).

No live verifier exists yet (ADR 0024). A credential is therefore never shown as `verified`; it reads `configured_unverified`.

## 13. Backup and restore

### 13.1 Back up

```
pg_dump -Fc --no-owner --no-privileges -f bind-$(date +%Y%m%d-%H%M).dump "$DATABASE_URL"
```

This is a snapshot of one consistent point. Store the file encrypted and off the host. The custom format is the input for
`pg_restore`. (Verified against the local database.) A backup contains connector ciphertext, audit rows and token hashes.

### 13.2 Restore (generic PostgreSQL procedure)

```
createdb <new database name>                                   # or create it through your provider
pg_restore --no-owner --no-privileges --exit-on-error -d "<connection URL of the new database>" bind-<stamp>.dump
```

(Verified into a throwaway database: the row counts of the restored database matched the source.)

### 13.3 Bind checks after a restore

1. **Keep the worker off until you have reviewed the data.** Start with `BIND_WORKER_ENABLED=false`. Keep `BIND_RESTOCK_SWEEP` unset.
   The worker's recovery can repeat an in-doubt order through the simulated supplier's lookup (section 7.4), so a restored database
   must not be worked on by the worker before review. (Verified: the server started with the worker off, and
   `bind_worker_lag_seconds` read `-1`.)
2. **Migrate.** `npm run db:migrate`, or let the server migrate on start. Then `GET /ready` must answer 200.
3. **Check the tokens.** Hashes survive a restore, and a token that was revoked stays revoked. A token issued after the backup
   does not exist in the restored database. (Verified: an owner token issued before the backup still authenticated.)
4. **Check each workspace's needs-attention list** (section 7.1), and every `effect_in_doubt` row.
5. **Compare with the outside world before you act.** A backup is a past state. An order, a payment or a revocation after the
   backup time happened outside Bind and is not in the restored database. Check suppliers and the chain before anything is
   reconciled or cancelled.
6. **Do not replay.** A restore does not make a workflow safe to run again. Section 7.6 applies.
7. **Rotate what may have leaked.** Token hashes do not reveal tokens (they are 256-bit random values), so a leaked backup alone
   does not require token rotation. Rotate `BIND_MASTER_SECRET` (section 11.3) if the backup's host or the environment could have
   leaked too. Rotate `BIND_CREDENTIAL_KEY` (section 12) if the old key was in the same place as the backup: the ciphertext in the
   backup is readable with that key. Rotate `BIND_METRICS_TOKEN` and `BIND_WEBHOOK_SECRET` if they were stored with the backup.
8. **Re-enable the worker** only after steps 1 to 7, by removing `BIND_WORKER_ENABLED=false` and restarting.

The rate-limit state and the metrics are not in the database. Nothing to restore there.

## 14. Known limits

- **Rate limits are per process and in memory** (ADR 0033). No shared store. Serverless instances keep their own counters.
- **Metrics are per process.** Aggregate across instances before alerting.
- **One Arc signer.** `ARC_SIGNER_PRIVATE_KEY` signs every settlement transfer. Its loss stops settlement; its leak exposes the
  funds it controls.
- **Suppliers and messaging are simulated.** No live supplier or messaging connector exists. Owner notifications are recorded in
  memory and never delivered (section 7.1). The simulated supplier keeps accepted orders in memory, so a restart can resend a
  simulated order (ADR 0018). Real adapters must look orders up in their own records.
- **In-doubt calls can be repeated** when an adapter's lookup reports the earlier call as not found (section 7.4). Only the
  simulated supplier and the Arc transfer adapter have a lookup.
- **Market benchmarks fall back to a fixed reference** when no search key is set (section 2).
- **The local settlement simulator is in memory.** Its transfers are lost on restart (ADR 0019).
- **Settlement pause window.** A pause written during the final round trip before a transfer can still pay (ADR 0023).
- **No external scheduler for serverless.** The worker runs only in the server process (ADR 0029, ADR 0030).
- **Owner identity is a token label**, not a verified person (ADR 0021). Audit rows name the label.
- **Migrations run on every start** and include the duplicate-match deletion (section 3.1).
- **`DATABASE_URL` outside production has a local default** with a password (section 2). Production refuses to start without it.
- **The UI is orphaned** (ADR 0016). The static UI is served but not maintained. The API is the product surface.
- **Disconnected requests are not logged** (ADR 0032). Lines are written when a response finishes.
- **No live Arc run here.** Settlement against the Arc testnet was not exercised in this check; the unit and integration tests use
  the simulator and a local EVM.
- **No dashboards or alert rules are shipped.** The suggestions in section 4 are not configured anywhere in this repository.

## 15. The workspace event stream

`GET /api/workspaces/:id/events` (text/event-stream) and `GET /api/workspaces/:id/events/poll` (JSON pages) send a workspace's
finished audit events, in order, with ids a client resumes from (ADR 0035, `docs/EVENTS.md`). Both take the token in the
`Authorization` header only. Caps per process: 5 open streams per token, 50 per workspace, 500 in all (a refused stream is
`429 TOO_MANY_STREAMS` with `Retry-After: 5`). A stream ends after one hour, on a revoked token, or when its client stops
reading; the client reconnects with its last id. At shutdown every stream gets `event: shutdown` before the server closes.

**The global horizon.** A stream sends an event only when every transaction that started before it has finished, anywhere in
the database. A transaction left open (`idle in transaction`) therefore holds back the events of every workspace, not one.
The symptom is that writes happen and no stream or poll returns new events. Find the session:

```
psql "$DATABASE_URL" -c "SELECT pid, usename, application_name, client_addr, now() - state_change AS idle_for,
  now() - xact_start AS transaction_age, left(query, 120) AS last_query
  FROM pg_stat_activity WHERE state = 'idle in transaction' ORDER BY state_change;"
```

Decide before acting. `SELECT pg_terminate_backend(<pid>);` ends that connection and rolls back its transaction, so any work
in it is lost. A database setting bounds the problem for the future; it is not set by this repository:
`ALTER DATABASE <name> SET idle_in_transaction_session_timeout = '60s';` (an operator decision, made per database).

The poll route is the way for a client that cannot hold a connection (serverless). It shares the same horizon.

## 16. Operator and development scripts

### 16.1 Accounting journal backfill (operator, ADR 0040)

The ledger GET (`GET /api/workspaces/:id/accounting/ledger`) only reads stored entries. It used to write journal entries for
reconciled orders that had none, and it no longer does. A reconciled order without an entry is written only by this command:

```
npm run accounting:backfill -- <workspaceId>            # dry run: prints counts, writes nothing (the default)
npm run accounting:backfill -- <workspaceId> --apply    # writes the missing entries
npm run accounting:backfill -- --all [--apply]          # every workspace that has a reconciled order
```

Each line of output is one workspace: `reconciled` (reconciled orders), `with_entry` (already have an entry), `missing` (need a
write), `written` (writes made) and `conflicts`. Only counts are printed: no amount, memo, hash or customer text. The writes use
the same idempotent journal writer as settlement, so a second `--apply` writes nothing. A conflict means the entry's key belongs to
another workspace or to another amount. Nothing is changed for that order, and a person must look at it. The backfill writes no
audit row (not done in ADR 0040).

### 16.2 Test fixture cleanup (development only: never against production)

```
npm run test:clean            # dry run: lists the fixture workspaces and template directories it would remove
npm run test:clean -- --apply # deletes them
```

It matches workspace ids that start with one of the fixture prefixes in `scripts/clean-test-fixtures.ts` (`FIXTURE_PREFIXES`):
the suite families (`ws-contract-`, `wu-`, `ws-gate-`, `ws-e2e-blank-`, `ws-test-`, `ws-untrusted-`, `ws-mcp-`, `ws-sdk-`,
`ws-probe`, and the per-file prefixes such as `ws-cred-`, `ws-approval-`, `ws-policy-`), and the `templates/<id>` directory of each.
A directory is removed only when git does not track it. It never matches the demo workspace `ws-kitchen-main` or the reference
templates `kitchen-ops` and `coffee-roaster`. `ws-kitchen-` and short generic names such as `ws-a-` are not in the list.

**Never run this against a production database.** It deletes workspaces, and every table that refers to a workspace cascades, so
the workspace's rows go with it. The script refuses when `NODE_ENV` is `production`, but that is a guard, not the control. Before
you run `--apply`, check that `DATABASE_URL` points at a local or test database.

