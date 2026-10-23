# 0049: Client idempotency keys

Status: Accepted

## Context
A client that times out cannot tell whether a command ran. ADR 0047 (section 2 of the spec) proposed an `Idempotency-Key` header. The older `idempotency_keys` table guards internal effects (the effects ledger, ADR 0017) and is keyed by a global string, so it cannot hold a per-caller scope.

## Decision
- A new table, `api_idempotency`, keyed by `(workspace_id, token_id, key)`. The old table is untouched.
- Middleware (`src/server/idempotency.ts`) runs last in the auth compositions, after authentication, rate limit, workspace scope and role, so an unauthorized caller never touches the table. It acts only on the 18 routes in `IDEMPOTENT_ROUTES`; a test compares that set to the economic or irreversible public writes in `docs/capabilities.json`.
- Same key and same request (method, path, canonical body): the stored status and body are replayed with `Idempotent-Replayed: true`. Same key, different request: 422 `IDEMPOTENCY_KEY_REUSED`. First request still running: 409 `IDEMPOTENCY_IN_PROGRESS` with `Retry-After: 1`. Malformed key: 400 `IDEMPOTENCY_KEY_INVALID`.
- Stored: 2xx, and 4xx a retry would repeat (not 408 or 429). Not stored, and the key is released: 429 and 5xx. The outcome is saved before the response is sent, so an immediate retry finds it.
- Retention is 24 hours (a stored row older than that is discarded when its key is used again). A lock older than 5 minutes belongs to a request that never finished (a crash) and is taken over; the effects ledger keeps the external effect at-most-once either way.
- Keys are optional. The 90-day figure in the earlier discussion applies to event polling, not to this.
- OpenAPI declares the header on those 18 operations; the capability catalogue derives `idempotency.clientKey` from the same set. The SDK takes `idempotencyKey` and, only when it is set, retries a command after a network failure.

## Follow-ups, now done
- The `IDEMPOTENCY_KEY_MISSING` warning is sent in `_meta.warnings` (ADR 0050).
- The worker removes rows past retention each tick (`idempotency_sweep` step, batched, under its own advisory lock).
- The MCP tools `request_replenishment`, `create_customer_order` and `cancel_customer_order` take an optional `idempotencyKey`; when none is given the server makes a random one per call. A key is never derived from the arguments, because a deliberate repeat of the same command must run again.
- A returned secret is never stored: a replay of `rotateWebhookSecret` omits `secret` and says `secretOmitted: true`.

## Evidence
Lint, typecheck, unit 401 passed; the new integration file `tests/integration/idempotency.test.ts` has 10 tests over real HTTP and PostgreSQL (replay without re-running, reuse, malformed keys, scope by token and tenant, stored 4xx, no table access when unauthenticated, in-progress and stale takeover, 24-hour expiry, ignored on other routes, catalogue match). `LOCAL_PASS` only.
