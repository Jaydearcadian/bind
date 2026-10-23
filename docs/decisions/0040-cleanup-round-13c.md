# ADR 0040: Cleanup round for known defects (Task 13c)

## Status
Accepted (2026-10-20). Every item is done. Item 4 was stopped on the first pass and completed on review (see below). Implements Task 13c of
`docs/superpowers/plans/2026-10-19-bind-completion-plan.md`. Builds on ADR 0005 (approvals), ADR 0017 (effects ledger), ADR 0020
(idempotency), ADR 0023 (pause), ADR 0024 (credentials), ADR 0026 and ADR 0027 (customer orders, restock), ADR 0031 (untrusted
text in errors), ADR 0034 (API contract) and ADR 0035 (event stream). `src/ui/` is not touched (ADR 0016).

## Context
A review found a set of small defects. This round fixes them together, one test first for each, and records every deviation from
its brief. Each item below gives what changed, the existing assertion (if any) that was edited, and what was not done.

## Decision

### 1. The ledger GET does not write
- `getWorkspaceAccountingLedger` returns the stored entries only. The backfill is gone from the read path.
- `backfillReconciledJournalEntries(workspaceId, { apply })` (`src/studio/documentsAndAccounting.ts`) writes the missing entries
  through the same idempotent writer, `recordIdempotentJournalEntry`. It returns counts. `apply: false` writes nothing.
- `scripts/backfill-journal.ts` (`npm run accounting:backfill -- <workspaceId|--all> [--apply]`) is an operator command. A dry run is
  the default. Its parser and runner are exported and tested. Documented in `docs/RUNBOOK.md` section 16.1.
- Not done: the backfill writes no audit row. It is an accounting write of a fact that already exists (a reconciled order), not an
  external effect, and the brief asked for the smallest change.
- Tests: `tests/integration/ledger-backfill.test.ts`.

### 2. A paused restock answers a typed code
- `AgentsPausedError` (`src/workflows/procurement.ts`) has `code: "AGENTS_PAUSED"`. Its message is the old text, unchanged, with its
  `[AGENTS_PAUSED]` tag.
- `POST /api/workspaces/:id/replenish` answers the same 400 and the same `error` text, with `code: "AGENTS_PAUSED"`.
- The restock trigger (`src/workflows/fulfilment.ts`) and the worker sweep (`src/workers/runner.ts`) test `instanceof` instead of the
  message prefix. Their behaviour is unchanged.
- The replenish route's 400 is documented in the registry (`src/api/registry.ts`), so `docs/openapi.json` and the SDK types were
  regenerated.
- **Existing assertion edited (the one the brief named):** `tests/integration/mcp.test.ts`, "a paused workspace refuses
  request_replenishment with the server's code". Only the `code` expectation changed, from `toBeNull()` to `toBe("AGENTS_PAUSED")`.
  The comment above it said the route sends no code. On review it was rewritten (comment only) to say the route answers the code.
- Tests: `tests/integration/paused-restock.test.ts`.
- The surface route's replenishment path (`POST /api/webhooks/incoming`, stock-observed event) on review: a pause already stored
  at the check answers `200 { status: "processed", replenishmentSkipped: "AGENTS_PAUSED" }` (ADR 0023, unchanged, covered by
  `surface-pause.test.ts`). A pause that is set between that check and the call reached the catch and answered the bare message
  as 400. That path now answers the same 400 with `code: "AGENTS_PAUSED"`. This path has no test: it needs a pause between two
  statements, and no hook exists for that. The 200 and the 400 disagree (a race path answers 400 where the pre-check answers 200).
  That is left as it is, per the review.

### 3a. Credential rotation can be limited to one workspace
- `rotateCredentialKeys({ workspaceId })` takes one id or a list. Omitted, it covers every workspace, as before. The rotate-key
  script calls it with no argument.
- `tests/integration/credentials.test.ts`, "rotating the key re-encrypts every credential...": **the two calls now pass the test's own
  workspace ids.** Its two count queries (the expected count before rotation and the count left after it) are scoped to the same
  ids. Their expected values and every `expect` are unchanged. Scoping the queries was needed for the stated goal: a global count
  would include stale rows from other suites and fail. This goes beyond "call arguments only", and it is reported for review.
- Tests added: `rotation can be limited to one workspace`, `rotation without a filter still covers every workspace`. Each uses its
  own workspaces, which it creates and deletes.

### 3b. Test fixture cleanup
- `scripts/clean-test-fixtures.ts` (`npm run test:clean [-- --apply]`). A dry run is the default.
- Matches workspace ids with the prefixes in `FIXTURE_PREFIXES`: the original six (`ws-contract-`, `wu-`, `ws-gate-`,
  `ws-e2e-blank-`, `ws-test-`, `ws-untrusted-`) and, added on review, `ws-mcp-`, `ws-sdk-`, `ws-probe` (also matches
  `ws-probe-new` and `ws-probe2`) and the per-file prefixes `ws-cred-`, `ws-auth-`, `ws-hook-`, `ws-settle-`, `ws-approval-`,
  `ws-ledger-`, `ws-journal-`, `ws-policy-`, `ws-paused-`, `ws-replenish-`, `ws-echo-`, `ws-events-`, `ws-effects-`, `ws-crypto-`,
  `ws-audit-`, `ws-blank-`, `ws-operation-`, `ws-payee-`, `ws-reconcile-`, `ws-recheck-`, `ws-notify-`, `ws-menu-`,
  `ws-integration-`, `ws-crash-`, `ws-budget-`, `ws-attn-`, `ws-recip-`, `ws-payment-`, `ws-pause-`, `ws-spause-`, `ws-twm-`,
  `ws-fxe-`, `ws-ful-`. Each was found with `grep -rhoE "ws-[a-z]+-" tests`, and checked against `src`, `scripts`, `sdk/src` and
  `mcp/src`: no product code or seed creates a workspace with these prefixes. The demo prefix `ws-kitchen-` and the short
  generic `ws-a-` are left out on purpose. An id must
  also be a plain token (no slash, space or `..`), so an id is never a path. The demo workspace and the reference templates are never
  matched (`PROTECTED_IDS`, checked first).
- Removes a `templates/<id>` directory only when `git ls-files --error-unmatch` reports it untracked. Any other git failure counts as
  tracked, so nothing is removed.
- Refuses when `NODE_ENV` is `production`. Documented in `docs/RUNBOOK.md` section 16.2, with a warning that it must never run
  against production.
- Dry run only in this round: 566 workspaces and 129 template directories were listed. Nothing was deleted, and no protected id
  was listed.
- Tests: `tests/unit/clean-test-fixtures.test.ts` (matching, and the production refusal run as a child process).

### 4. Error text does not echo untrusted ids
- **Document confirm (done).** `POST /api/workspaces/:id/documents/:docId/confirm` answers `400 { error: "Document could not be
  confirmed" }` for any error that is not a schema error. The detail is logged once (`documents.confirm_refused`, redacted and cut,
  with the request id). A schema error keeps `Invalid request body`, which names no id. Test: `tests/integration/error-echo.test.ts`.
- **Surface 403 (done on review, option (a)).** `SurfaceAuthorizationError` messages carry the actor id. The route now answers
  `403 { error: "Actor is not authorized for this event", code: "SURFACE_ROLE_VIOLATION" }`. The detail, with the actor id, is
  logged once as `surface.authorization_refused` (redacted and cut, with the request id). The status is unchanged.
  - **Existing assertion edited (authorized on review):** `tests/integration/studio-flows.test.ts`, Flow C spoof check:
    `expect(spoofApproveRes.body.error).toContain("SURFACE_ROLE_VIOLATION")` became
    `expect(spoofApproveRes.body.code).toBe("SURFACE_ROLE_VIOLATION")`. The reason is that the message must be generic and the code
    is the stable value. The other surface 403 assertions read `res.text`, which still contains the code, and they are unchanged.
  - The registry 403 description names the code. `docs/openapi.json` and the SDK types were regenerated.
  - Test: `tests/integration/error-echo.test.ts`, `an unauthorized surface actor gets a generic 403 with a code and no actor id`.
  - Not changed: the e2e spec `tests/e2e/dashboard.spec.ts` (not run, UI orphaned, ADR 0016) checks the UI for the text
    `SURFACE_ROLE_VIOLATION`. A UI that prints the body will still show the code, but this was not checked.

### 5. Policy limits are JSON numbers
- `PUT /api/workspaces/:id/policy` reads `budgetDailyLimitCents` and `approvalThresholdCents` only when they are JSON numbers. A string,
  a float, or any other type is refused with the existing messages. No existing test sent a string.
- Test: `tests/integration/policy-types.test.ts`.

### 6. The OpenAPI document is built once and kept as bytes
- **The premise did not match the code.** `GET /api/openapi.json` never read `docs/openapi.json`. It built the document from the
  registry on every request (ADR 0034 names caching as the follow-up).
- The route now builds the document on first use and sends the same bytes after that. The bytes are the serialised output, so they
  equal `docs/openapi.json` (checked by the existing tests).
- It does not read the committed file at run time, on purpose. That file is not part of the serverless bundle (`build:vercel`
  copies only `schema.sql`), so a read could fail on Vercel. A read would also let the served document drift from the registry it is
  generated from.
- Test: `tests/integration/openapi-route.test.ts`. It counts builder calls and file reads, and checks the bytes.

### 7. An approval decision and its audit row are one transaction
- `WorkflowEngine.resolveApproval` and `WorkflowEngine.recordAudit` take an optional `PoolClient`. Without one they run on the pool as
  before.
- `ProcurementWorkflowRunner.approveAndSubmit` runs the decision and its `approval.approved` row in one `withTransaction`.
  `declineApproval` does the same for `approval.rejected` and `approval.revoked`. The policy-recheck rejection in `approveAndSubmit`
  does the same too, since it is the same pair.
- The order submission that follows an approval is still outside the transaction, because it calls the supplier.
- Tests: `tests/integration/approval-atomic.test.ts`. A real database failure is injected with a trigger on `audit_logs` (dropped
  afterwards), so the decision in the same transaction must roll back.

### 8. Replenishment keys do not collide with an earlier workflow
- **Round.** The key payload is `{ sku, currentQty }` for the first attempt, as before, and `{ sku, currentQty, round }` after that,
  where `round` is the number of earlier `kitchen_replenishment` workflows for the sku. The first key is unchanged, so the existing
  assertion in `customer-fulfilment-effects.test.ts` (which builds the key for `{ sku, currentQty }`) still holds, and existing rows
  keep their keys.
- **Order of reads.** `round` is read before the active-workflow check. Read after it, two concurrent starts could both pass the
  check and the second could take round 1 and create a second workflow.
- **Found, not created.** `createWorkflow` returns `WorkflowRecord & { created: boolean }`. `created` is true only when the row is the
  inserted one. Existing callers are unaffected. `startReplenishment` returns the existing workflow (its id, state, order and approval)
  when `created` is false, and does nothing else.
- Tests: `tests/integration/replenish-key.test.ts`. The "found by key" test plants a workflow with the key a start would compute. The
  planted row has another workflow type, so it is not counted, which is the outcome of a concurrent start that committed after the
  count. Before the change, that start failed with `Invalid state transition`.

### 9. Dead idempotency stores deleted
- Removed from `src/utils/idempotency.ts`: `MemoryIdempotencyStore`, `PostgresIdempotencyStore`, the `IdempotencyStore` interface, and
  `DuplicateExecutionError` (used only by the stores). Also the `query` import they needed.
- Kept: `canonicalStringify` and `generateIdempotencyKey`. The `idempotency_keys` table stays, because `db-migrations.test.ts` expects it.
- Removed from `tests/unit/idempotency.test.ts`: the two `it` blocks that used the stores. The two that test `generateIdempotencyKey`
  remain.
- Grep confirmed no other reference in `src`, `tests`, `scripts`, `sdk` or `mcp`. ADR 0017 and ADR 0020 are updated.

### 10. Docs and indexes
- ADR 0026 "Not done": the owner notice and the restock trigger are removed from the list (they are ADR 0027). The other items stay.
- `src/db/schema.sql` gains four indexes, idempotent, after the `effects` table they depend on:
  `idx_audit_order` (`audit_logs ((evidence->>'orderId'))`), `idx_orders_status` (`orders(status)`), `idx_effects_status`
  (`effects(status, updated_at)`), and `idx_workflows_state_global` (`workflows(state)`).
- **Deviation.** The brief named the workflow index `idx_workflows_state`. That name already exists on `workflows(workspace_id, state)`,
  and `CREATE INDEX IF NOT EXISTS` would skip the new statement without an error. The new name is `idx_workflows_state_global`.
- `docs/RUNBOOK.md`: section 3.1 notes the build time and lock, and section 16 documents the two scripts.
- Test: `tests/integration/schema-indexes.test.ts` (the four definitions exist, and a second migration run leaves them as they are).
- Stale notes in ADR 0034 and ADR 0027 are pointed at this ADR.

## What is not done
- The e2e spec for the surface simulator (not run, ADR 0016), and the release evidence rows that quote the old 403 text.
- An audit row for the backfill (item 1).
- The typed code on the surface replenishment path (item 2).
- `docs/RELEASE_EVIDENCE.md` is not updated here. ADR 0034 says the release evidence is updated in the release step.

## Consequences
- A GET does not change the database. A reconciled order with no journal entry stays that way until an operator runs the backfill.
- A paused restock and a refused approval both give callers a code they can test, without parsing text.
- A decision and its audit row succeed or fail together.
- A restock that is retried after a terminal workflow starts a new workflow. Two concurrent starts still produce one.
- Keys that existed before this round keep their values.
- The first start after this change builds four indexes. Section 3.1 of the RUNBOOK says how to build them without blocking writes.

## Verification
Commands, run in this order on the final tree (PostgreSQL 16 on `127.0.0.1:5432`, local `bind_local` database):

| Command | Result |
|---|---|
| `npm run lint` | exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run test:unit` | 48 files, 340 tests passed (baseline 47 files, 339) |
| `npm run test:integration` | 59 files passed, 1 skipped (`anvil-settlement.test.ts`: `ANVIL_RPC_URL` not set, NOT_RUN); 534 tests passed, 10 skipped (baseline 519 passed, 10 skipped) |
| `npm run build`, `npm run sdk:build`, `npm run mcp:build` | exit 0 |
| `npm audit --audit-level=high` | found 0 vulnerabilities |
| `npm run map:functions`, `npm run api:spec`, `npm run sdk:generate` | exit 0; `docs/CODEBASE_MAP.md`, `docs/openapi.json`, `sdk/src/generated/api.d.ts` regenerated (the SDK change is one description line) |
| The 20 touched integration files, three runs | 20 files, 155 tests passed each time |
| `BIND_ACCEPT_NOT_RUN=test:e2e bash scripts/verify-local.sh` | PASS 12 (lint, typecheck, unit, integration, contract in-process suite, build, sdk:build, mcp:build, audit, spec drift, sdk drift, map drift); BLOCKED 3 (`forge`, `anvil`, `slither` not installed here, as in the earlier round); NOT_RUN_ACCEPTED 1 (`test:e2e`, ADR 0016). Exit 1 because of the three BLOCKED gates. |

Mutation checks (each run once, then the file restored byte for byte):
- Item 1: the backfill put back on the ledger GET. `reading the ledger twice writes nothing` fails (the GET returns the entry it wrote).
- Item 7: the transaction removed (the callback runs on the pool). `a failing audit write rolls the approval decision back` and
  `a failing audit write rolls a rejection back too` both fail: the approval is `approved`, not `pending`.
- Item 8a: `round` removed from the key. `a second replenishment after a cancelled one at the same quantity starts a new workflow`
  fails: both starts return the same workflow id.
- Item 8b: the `created` check ignored. `a start that finds an existing workflow by key returns that workflow` fails with
  `Invalid state transition`.
- `two concurrent starts for one sku produce one workflow` passes under both item 8 mutations. The unique key dedupes concurrent
  starts as well as the active-workflow check, so that test guards the behaviour but does not isolate either mechanism. The
  ordering of the round read (before the active check) is argued above and is not mutation-tested.
