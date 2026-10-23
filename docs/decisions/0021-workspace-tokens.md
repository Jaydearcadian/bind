# ADR 0021: Per-workspace owner and staff tokens; tenancy enforced on the server

## Status
Accepted (2026-10-19). Implements option 1 of ADR 0006 (Task 6a of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`).
The session and membership-table option (ADR 0006 option 2) remains the next step before any deployment beyond the demo.

## Context
The HTTP API had no authentication. Any caller could read every workspace, approve or reject any approval with any
`decidedBy`, reconcile orders and confirm settlements (which move money), change spending policy and supplier payee
addresses, overwrite an existing workspace through the public onboarding routes, and recover the workflows of every
workspace. The demo workspace was re-provisioned on every boot, which reset any policy the owner had changed.
`SESSION_SECRET` had a hard-coded default. CORS allowed every origin.

The API is the product surface for the rebuild (ADR 0016). The new UI, the SDK and the MCP server all call these
routes with `Authorization: Bearer <token>`.

## Decision

### Tokens
- Format: `bnd_` followed by 32 random bytes in base64url (43 characters). `src/auth/tokens.ts`.
- Storage: `workspace_tokens` holds only the SHA-256 hash of the token. The plaintext is returned once, by the
  create response (or the onboarding response, or `npm run token:issue`), and is never stored, logged or audited.
- Revocation sets `revoked_at`. A revoked token stops working on the next request.
- Malformed tokens (wrong prefix, wrong length or characters) are refused without a database lookup.
- A token is accepted only in `Authorization: Bearer`. Query strings and cookies are never read.
- Every failure (missing, malformed, unknown, revoked) returns the same `401 { "error": "Authentication required" }`.
  No failure response echoes the submitted token.

### Roles
| Role | Can |
|---|---|
| owner | Everything a staff token can do, plus the owner-only routes below, plus token management for its workspace. |
| staff | Read its workspace; add inventory; trigger replenishment; extract (not confirm) documents. |

### Tenancy
- A token for workspace A on any `/api/workspaces/:id/...` route with `:id` = B gets **404** `{ "error": "Workspace not found" }`,
  the same body a missing workspace gets, so existence is not revealed. The check runs before the role check.
- The workspace id is taken from the path only, never from the body or the query.
- `/api/approvals/:id/*` and `/api/orders/:id/*` carry no workspace in the path. The owner's workspace is passed into
  the service. `approveAndSubmit`, `declineApproval`, `fulfillAndReconcile` and `confirmSettlement` take a required
  `workspaceId` and look the row up with `workspace_id = $n`. Another workspace's approval or order is reported
  as `APPROVAL_NOT_FOUND` / `ORDER_NOT_FOUND` (404, same code and message shape as a missing id), before any state change
  or external call.
- The surface-card webhook branch passes `event.workspaceId` to the same service calls, so a verified surface binding
  for workspace A cannot decide an approval of workspace B.

### Decisions are recorded from the token, not the body
- The body's `decidedBy` is ignored on the approval routes. The service receives `owner:<token label>`, which is
  stored in `approvals.decided_by`.
- Each approval decision writes an audit row: `approval.approved`, `approval.rejected` or `approval.revoked`,
  actor type `owner`, actor id = the recorded decider (`owner:<label>`). `reason` stays from the body.

### Route access
Access levels: **public** (no token), **member** (owner or staff of the workspace in the path), **owner** (owner of the
workspace in the path), **owner-any** (owner of the workspace the approval or order belongs to; checked by the service).

| Method | Path | Access |
|---|---|---|
| GET | `/health` | public |
| GET | `/api/templates` | public |
| GET | `/api/templates/:id/blueprint` | public |
| POST | `/api/workspaces/onboard` | public (returns owner token) |
| POST | `/api/workspaces` | public (returns owner token) |
| POST | `/api/webhooks/incoming` | public (webhook auth is Task 6b; logic unchanged) |
| GET | `*` (static UI and SPA shell) | public (unchanged; the UI is orphaned, ADR 0016) |
| GET | `/api/workspaces` | any valid token; returns only the caller's workspace |
| GET | `/api/workspaces/:id` | member |
| GET | `/api/workspaces/:id/inventory` | member |
| POST | `/api/workspaces/:id/inventory` | member |
| POST | `/api/workspaces/:id/replenish` | member |
| GET | `/api/workspaces/:id/approvals` | member |
| GET | `/api/workspaces/:id/workflows` | member |
| GET | `/api/workspaces/:id/orders` | member |
| GET | `/api/workspaces/:id/suppliers` | member |
| GET | `/api/workspaces/:id/agents` | member |
| GET | `/api/workspaces/:id/surfaces` | member |
| GET | `/api/workspaces/:id/documents` | member |
| POST | `/api/workspaces/:id/documents/extract` | member |
| GET | `/api/workspaces/:id/accounting/ledger` | member |
| GET | `/api/workspaces/:id/audit` | member |
| PUT | `/api/workspaces/:id/policy` | owner |
| POST | `/api/workspaces/:id/suppliers` | owner |
| POST | `/api/workspaces/:id/agents` | owner |
| POST | `/api/workspaces/:id/surfaces` | owner |
| POST | `/api/workspaces/:id/documents/:docId/confirm` | owner |
| POST | `/api/workspaces/:id/recover` | owner (recovers only this workspace) |
| POST | `/api/workspaces/:id/tokens` | owner |
| GET | `/api/workspaces/:id/tokens` | owner |
| DELETE | `/api/workspaces/:id/tokens/:tokenId` | owner |
| PUT | `/api/workspaces/:id/agents-paused` | owner (ADR 0022: the pause switch) |
| GET | `/api/workspaces/:id/webhook-secret` | owner (ADR 0022: shows the signing secret, audited) |
| POST | `/api/workspaces/:id/webhook-secret/rotate` | owner (ADR 0022: rotates the signing secret) |
| POST | `/api/approvals/:id/approve` | owner-any |
| POST | `/api/approvals/:id/reject` | owner-any |
| POST | `/api/approvals/:id/revoke` | owner-any |
| POST | `/api/orders/:id/reconcile` | owner-any |
| POST | `/api/orders/:id/confirm-settlement` | owner-any |

The test `every route in createApp is either protected or listed as public` fails when a route is added without being
listed here. A new route is therefore a deliberate choice of access level.

### Token routes
- `POST /api/workspaces/:id/tokens` `{ role: "owner" | "staff", label }` returns `201 { id, role, label, token }`.
- `GET /api/workspaces/:id/tokens` lists `{ id, role, label, createdAt, revokedAt }`. Never a hash or a plaintext.
- `DELETE /api/workspaces/:id/tokens/:tokenId` revokes. `404` (`TOKEN_NOT_FOUND`) for a token of another workspace, an unknown
  token, or one already revoked. `409` (`LAST_OWNER_TOKEN`) when it would leave the workspace without an active owner.
  The active owner rows are locked (`SELECT ... FOR UPDATE`) inside the revoke transaction, so two concurrent revokes
  cannot both pass the last-owner check.
- Issue and revoke write an audit row in the same transaction: `auth.token_issued` / `auth.token_revoked`, actor type
  `owner` and actor id = the caller's label (or `system:*` for onboarding and the operator script). Evidence holds
  `tokenId`, `role` and `label`, never the token. Effect class is `commercial_commitment`, following the existing
  owner-configuration precedent (`workspace.onboard_configured`); no effect class fits an access change.

### Public creation
- `POST /api/workspaces/onboard` and `POST /api/workspaces` refuse an existing id with
  `409 { "error": "Workspace id is not available" }` before the upsert runs, so an existing workspace is never overwritten.
- The check, the create and the first owner token run under an advisory lock on the id
  (`acquireAdvisoryLock`). Two concurrent requests for one new id therefore cannot both succeed.
- Atomicity: the workspace is created first, then its owner token is issued. If issuing the token fails, the new
  workspace is **deleted** (cascade removes its rows). A transaction spanning the onboarding module and the token module
  was rejected as more invasive; delete-on-failure is safe here because the advisory lock guarantees nobody else
  holds a token for the id yet.
- Responses are JSON-safe: BigInt values are sent as decimal strings, so a serialization error cannot follow a
  committed create and lose its token.

### Demo workspace
- `provisionWorkspace(..., { ifAbsent: true })` leaves an existing workspace completely untouched: no field reset, no role,
  supplier or inventory re-seeding. `src/server/demo.ts` uses it for `ws-kitchen-main` on every boot, from both
  `src/index.ts` and `api/_handler.js`.
- `BIND_DEMO_OWNER_TOKEN` (optional) must be in the issued format. Its hash is stored as an owner token labelled `demo`
  (`ON CONFLICT (token_hash) DO NOTHING`), so a restart does not add rows, and a token revoked stays revoked. The value
  itself is never stored.

### Operator token
`npm run token:issue -- <workspaceId> <label> [owner|staff]` mints a token for an existing workspace and prints it once.
This is how older workspaces without tokens get their first one.

### CORS
`cors()` for every origin is replaced by an allow-list from `BIND_CORS_ORIGINS` (comma-separated). Unset or empty:
no CORS middleware runs, so no CORS headers are sent. `createApp({ corsOrigins })` lets tests set the list.

### Configuration
- `SESSION_SECRET` has no hard-coded value. It is empty when unset. An empty value is ignored by log redaction
  (`src/effects/ledger.ts`). The schema default is `""` rather than optional so that the existing typed read in
  `tests/integration/effects-ledger.test.ts` still type-checks; that test requires `SESSION_SECRET` to be set in the
  environment (it is set in `.env.local`).
- `BIND_CORS_ORIGINS` and `BIND_DEMO_OWNER_TOKEN` are documented in `.env.local.example`.

### Test gate change (ADR 0016)
- `npm run test:e2e` now prints `BLOCKED: browser E2E is not run: the UI is orphaned (ADR 0016); use test:e2e:legacy`
  and exits 1. It does not run the browser tests.
- `npm run test:e2e:legacy` runs the existing Playwright tests in `tests/e2e/` unchanged. They cannot pass without a
  token and the UI is not maintained, so they are not part of the release gate.
- The same flows are covered by HTTP-level integration tests, which are the gate for behaviour. Browser E2E for the new
  UI is reported as `NOT_RUN` in the release evidence until the rebuild ships.

## Consequences
- Every protected route needs a token. Callers (the new UI, the SDK, the MCP server, the existing integration tests) must
  send one. Existing integration tests were updated to issue an owner token in setup and send it; no assertion was changed.
- Any owner can issue tokens and revoke other owners as long as one active owner remains. Owner tokens are equally
  powerful; there is no per-token scope beyond role.
- A token is a bearer secret. Whoever holds it has its role. The server stores only the hash, but the holder must keep it.
  There is no expiry; revocation is the only way to end a token.
- The owner's decision label is the token label. Two tokens with the same label are indistinguishable in audit.

## Not done (later tasks)
- A sessions and membership table (ADR 0006 option 2). Tokens are per workspace, with no per-person identity.
- Per-workspace webhook secret and webhook authentication: Task 6b. The public webhook route is unchanged.
- Rate limiting and brute-force protection: Task 12.
- Standard error body beyond `{ error }` with existing `code` fields: Task 12b.
- Document confirmation (`POST /api/workspaces/:id/documents/:docId/confirm`) still records the body's `decidedBy` as
  the confirming owner. It is owner-only, but the label is not the token label. Follow-up.
- Approval decision and its audit row are two statements. A failure between them leaves the decision without its
  audit row, and the caller sees an error. Follow-up: write both in one transaction.
- Token issuance is audited with actor `owner` and the label, not with a verified person. Accurate only to the
  token's label.

## Evidence
See `docs/RELEASE_EVIDENCE.md` for the exact commands, counts and the classification of each test.
