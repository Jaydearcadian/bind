# ADR 0022: Webhooks prove who sent them; surface actors come only from bindings; a real pause switch

## Status
Accepted (2026-10-19). Implements Task 6b of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`. Builds on ADR 0021
(workspace tokens) and ADR 0016 (API first; `src/ui/` untouched).

## Context
Before this change, after ADR 0021:
1. Surface events (stock observed, owner approval decision, agent pause) carried no signature. Anyone could POST one.
2. `verifyAndAuthorizeSurfaceEvent` took the role claimed in the payload when the actor had no binding. An unbound
   sender could claim `owner` and approve spend.
3. Surface events were never deduplicated, so a replay repeated its effect.
4. The pause toggle only updated `updated_at`, and echoed `paused` back. Nothing was paused.
5. The standard webhook used a default secret literal, skipped its signature check when `NODE_ENV === "test"`,
   verified a re-serialized body, let `timingSafeEqual` throw (500) on a length mismatch, deduplicated across tenants,
   invented an `evt_${Date.now()}` id when none was sent, and returned raw database error text.
6. The audit actor for surface bindings was the literal `owner@bind.local`, and the document confirm route recorded the
   request body's `decidedBy`.

## Decision

### What a signature proves, and what it does not
A signature is an HMAC-SHA256 over `timestamp + "." + raw body`, in hex, in `x-bind-signature`, with the timestamp in
`x-bind-timestamp`. Checked by `src/webhooks/signing.ts`, a pure module.
- It proves that the sender held the secret for that workspace at that version, and that the bytes were not changed.
- It is fresh only within 300 seconds in the past and 60 seconds in the future.
- It does **not** prove which person sent the message. A person is identified only by a surface binding row in the
  database. Whoever holds a workspace's secret (the messaging bridge) can claim any bound actor id. The bridge is part of
  the trust boundary, and the surface identity is only as strong as that bridge.
- Verification uses the exact bytes received (`express.json({ verify })` keeps `rawBody`). It never re-serializes the body.
- `verifySignature` never throws. A wrong length, a non-hex value, a non-integer timestamp or an empty secret is `false`.

### Secrets
- `BIND_MASTER_SECRET` and `BIND_WEBHOOK_SECRET`: optional, at least 32 characters when set, no default in source. An
  empty value counts as unset. Both are documented in `.env.local.example` with no sample values.
- A workspace's surface secret is derived: `HMAC-SHA256(master, "bind-webhook-v1:" + workspaceId + ":" + version)`.
  No per-workspace secret is stored. `workspaces.webhook_secret_version` (default 1) selects the version.
- `GET /api/workspaces/:id/webhook-secret` (owner) returns `{ secret, version }`. Audit `auth.webhook_secret_viewed`,
  evidence `{ version }`.
- `POST /api/workspaces/:id/webhook-secret/rotate` (owner) increments the version and returns the new `{ secret, version }`.
  The old secret stops validating at once; there is no grace period. Audit `auth.webhook_secret_rotated`.
- Neither secret appears in any audit evidence, log or error body. The response carries a secret only on those two owner
  routes, and both send `Cache-Control: no-store`.
- **Fail closed.** With the needed secret unset, the routes answer `503 { "error": "Webhook signing is not configured" }`
  and process nothing. This includes the owner's webhook-secret routes.

### Surface events: the order of checks
Each check fails closed, in this order (`handleSurfaceEvent` in `src/server/app.ts`):
1. The body parses as a surface event.
2. The workspace exists. An unknown workspace gets `401 { "error": "Invalid signature or expired timestamp" }`, the same
   body as a bad signature, so workspace existence is not revealed.
3. The signature verifies over the raw body with that workspace's secret at its current version. Any failure is the same
   401. No master secret is `503`.
4. Replay. The event id is recorded in `inbound_webhooks` with provider `surface:<workspaceId>:<surface>`. A repeat
   answers `200 { "status": "duplicate", "eventId" }` and does nothing else. This runs only after step 3, so an unsigned
   request cannot use up an event id.
5. Binding. See below.

### The role comes only from the binding
- `verifyAndAuthorizeSurfaceEvent` looks up `(workspace, surface, actorId)`. **No row means 403 for every event type.**
  The payload's `actorRole` is kept in the schema for compatibility and is never used for authority.
- The role is the binding row's `actor_role`. Owner-only rules still apply to approval decisions and pause toggles.
- A surface approval or rejection is decided as `surface:<surface>:<actorId>`, and the approval is looked up with the
  event's workspace id. An approval of another workspace is `APPROVAL_NOT_FOUND` (404), with nothing changed.

### Replay
- Surface events: unique on `(provider, event_id)`, where the provider is scoped by workspace and surface. The same id in
  two workspaces is two events. A replay is refused forever after its first use, even outside the timestamp window.
- Standard events: the same unique key, with the provider as the signed body gives it. The id is required (400 if
  missing, not a string or over 200 characters). No fallback id is invented.
- The row id is `newId("wh")`. It carries no client text.

### Standard webhook (`POST /api/webhooks/incoming`, non-surface)
1. Signature with `BIND_WEBHOOK_SECRET` over the raw body. Missing, malformed or wrong = 401. The check is always on,
   including in tests. The `NODE_ENV` bypass and the `verified &&` bypass are removed.
2. `provider` and `eventId` must be non-empty strings (400 otherwise).
3. `WebhookReceiver.processEvent` stores the event. A duplicate answers `200 { accepted: false, reason }` as before.
   A storage failure answers `503 { accepted: false, reason: "Webhook could not be recorded" }`, which the caller may
   retry. The database's own error text is never returned.

### A real pause switch
- `workspaces.agents_paused` (default false). `SURFACE_AGENT_PAUSE_TOGGLE` from an owner binding sets it. Owner API:
  `PUT /api/workspaces/:id/agents-paused` `{ paused: boolean }` (owner only). Both write
  `workspace.agents_paused_changed` in the same transaction as the change, with evidence `{ paused, source }`. The response
  reports the value read back from the row.
- **Enforcement, in code.** The commitment gate denies with `AGENTS_PAUSED` while the workspace is paused. The denial
  wins over every escalation, so an owner approval cannot resume a commitment during a pause. `startReplenishment`
  refuses before any workflow row or quote request is created, with `[AGENTS_PAUSED] ...`.
- **Pending approvals.** An approval requested before the pause is re-checked when the owner approves. The re-check denies,
  and the approval is recorded as rejected by `system:policy-recheck`. It is not held. The owner must start the
  replenishment again after resuming.

### Owner-side fixes
- `upsertSurfaceBinding(workspaceId, rawInput, actor)` audits the actor the route passes: `owner:<token label>`. The literal
  `owner@bind.local` is gone from that path.
- `POST /api/workspaces/:id/documents/:docId/confirm` records `owner:<token label>`. The body's `decidedBy` is ignored.
  `ConfirmDocumentInputSchema.decidedBy` is now required, with no fixed fallback.

## Test changes (recorded, per AGENTS.md)
No existing assertion was changed. Three test files changed in a way that needs recording:
- `tests/integration/studio-flows.test.ts`, Flow C: the spoofing request to `/api/webhooks/incoming` is now signed with the
  workspace's current secret. Without a signature the request would be refused with 401 before the binding check, and the
  test is meant to reach the binding check. Its assertion (403, `SURFACE_ROLE_VIOLATION`) is unchanged. This is a fixture change.
- `tests/integration/auth-tenancy.test.ts`: three owner routes were added to the route table, so the table stays complete:
  `PUT /api/workspaces/:id/agents-paused`, `GET .../webhook-secret`, `POST .../webhook-secret/rotate`.
- `tests/unit/commitment-gate.test.ts`: one test was added (`denies while the workspace agents are paused`).

## Mutation checks
Each mutation below was applied alone to the working tree, the webhook suites were run, and the file was restored and
compared byte for byte.

| Mutation | Test that fails |
|---|---|
| Unbound actor takes the payload role | `an event from an actor with no binding is refused even when it claims the owner role` |
| Surface signature check removed | `a surface event without a signature is refused with 401`, `a surface event with a wrong, expired or future-dated signature is refused`, `a signature made for workspace A does not validate an event for workspace B`, `an unsigned request cannot burn an event id`, `the webhook secret is shown to the owner only and rotation invalidates the old signature` |
| Surface dedupe removed | `a replayed surface event is accepted once` |
| Standard signature skipped outside production | `the standard webhook requires a signature in the test environment too`, `the standard webhook with a signature of the wrong length answers 401, not 500`, `a signature is checked over the raw bytes, not a re-serialized body` |
| Gate ignores the pause | `denies while the workspace agents are paused`, `an approved order is not placed while paused (the commitment is denied)` |
| Standard signature over a re-serialized body | `a signature is checked over the raw bytes, not a re-serialized body` |
| Surface role taken from the payload when a binding exists | `Flow C: ...`, `a signed pause event from an owner binding ...`, `a staff binding cannot pause`, `a staff binding cannot approve even when the event claims owner` |

## Routes added (access levels, for the table in ADR 0021)
| Method | Path | Access |
|---|---|---|
| PUT | `/api/workspaces/:id/agents-paused` | owner |
| GET | `/api/workspaces/:id/webhook-secret` | owner |
| POST | `/api/workspaces/:id/webhook-secret/rotate` | owner |
| POST | `/api/webhooks/incoming` | public at the HTTP layer; authenticated by signature (surface: per workspace; standard: `BIND_WEBHOOK_SECRET`) |

## Consequences
- An unsigned or wrongly signed request reaches no state change and no dedupe row.
- A surface actor is trusted only through a binding the owner created. A staff binding cannot approve or pause, whatever it claims.
- The pause is enforced at the commitment gate and at replenishment start. It is not yet enforced at settlement (see below).
- Rotation is immediate. Signatures made with the old secret stop validating at once, so the bridge must switch to the new
  secret at the moment of rotation. Events signed with the old secret are refused until it does.

## Not done, and known risks
- **Settlement is not behind the gate or the pause.** `fulfillAndReconcile` → `OrderSettlementService.settle` calls
  `transferUSDC` without `authorizeCommitment`. So a paused workspace can still pay an order that is already confirmed, through
  `POST /api/orders/:id/reconcile`. This predates Task 6b. The brief's file list does not include `src/workflows/settlement.ts`,
  and changing it changes settlement behaviour. It needs an owner decision and a follow-up. Until then, the pause does not
  stop money that is already committed.
- Secrets are all derived from one master secret. A leak of the master exposes every workspace's secret. Moving them to a
  credential store is later work.
- An event that passes the signature (step 3) is recorded (step 4) before the binding check (step 5). An event refused at
  step 5, for an unbound actor or a staff role, therefore uses up its event id. A corrected retry needs a new id.
- The surface bridge is trusted with the workspace secret. Its `actorId` assertions are not independently verified.
- Rate limiting and brute-force protection are Task 12.
- `documentsAndAccounting.ts` (extraction audit row) and `onboarding.ts` still write the literal `owner@bind.local` as the
  actor of some audit rows. Those are outside this change and are listed for a follow-up.
- `ADR 0021`'s route table is not edited. The three routes added here are listed above.

## Evidence
Commands, counts and mutation results are in the Task 6b report. `docs/RELEASE_EVIDENCE.md` has not been updated for
this change yet; it is a release-step follow-up.
