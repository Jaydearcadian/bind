# 0057: Demo workspaces: a throwaway, simulated sandbox per visitor

Status: Accepted (2026-10-20). Implements the "Demo" decision in `docs/ux/UX_BRIEF.md` ("Sign-in and accounts"): a throwaway
sandbox, four hours, no sign-in, limits per browser and address, "Make this yours" starts a fresh real workspace and never
migrates demo data. This record covers the backend. The demo banner, the Reset button and the entry page are UI work and are not here.

## Context

- The website's "Try a demo workspace" button needs a server route that gives a visitor a working workspace with real records and
  no sign-in. Before this change the only demo was `ws-kitchen-main`, a persistent kitchen that is re-provisioned on every boot
  (ADR 0021). It is not per visitor and is not expired, so it is left alone.
- A demo is a real workspace with a staff or owner token (UX brief). The brief requires abuse limits and expiry before it ships.
- Branch base. The worktree branch was at `d517c1a`, an ancestor of `claude/capabilities-overview-c6elxr` (`409c2bb`), which holds
  the UX brief, the ecosystem contracts and the registry this task refers to. The worktree was clean, so the branch was
  fast-forwarded to `409c2bb` (`git merge --ff-only`) before any edit. Nothing was overwritten.
- Corrections to the task brief, found in the code:
  - `provisionWorkspace` writes no files. The derived folder `templates/<id>` is written by `syncWorkspaceDerivedTemplateFiles`
    (src/studio/onboarding.ts), which runs when the owner changes policy or roles. Demo cleanup removes `templates/<demo id>`, and
    `workflows/<workflow id>` for the demo's own workflows, because a settled demo order writes decision evidence there
    (`writeWorkflowAntiDriftFiles`). Nothing else.
  - `SUPPLIER_ADAPTER_MODE` is declared in `src/config/env.ts` and read nowhere. Every supplier adapter in the code is a simulated
    class. The demo rule therefore checks the adapter itself (`isSimulated`), not the environment variable.
  - The ADR number 0057 was given by the task. At the time of the first commit the repository had no 0056 record. The upstream
    branch later added 0056 (the SDK in the browser), and the merge keeps both.

## Decision

1. **Creation.** `POST /api/demo` (public). It provisions `ws-demo-<16 hex>` from `kitchen-v1` in one transaction, with `is_demo`
   and `demo_expires_at` (now + 4 hours) on the workspace row, and settlement mode `local`. It issues one owner token (label
   `demo-owner`, actor `system:demo`) and writes a `demo.created` audit row. Then it seeds the demo through the real
   `ProcurementWorkflowRunner.startReplenishment` for `FOOD-BUTTER-36LB`, which is below par and whose order (4 at $98.00 = $392)
   is above the $250 approval threshold. The result is a real pending approval and a real workflow waiting for the owner.
   Response `201`: `{ workspaceId, token, expiresAt }`, `Cache-Control: no-store`.
2. **Seed failure.** The seed is best effort. A failure is logged as `demo.seed_failed` with the redacted message. The demo is
   still returned and its token works. No workflow, approval or other record is written to stand in for the failed step.
3. **Safety, in code.** A demo never uses live settlement or a live supplier:
   - `effectiveSettlementMode` (src/demo/policy.ts) returns `local` for any `is_demo` row, and is used by the settlement service
     (both adapter selections), the procurement arc branch, the workspace balance read, and the replenishment tools' reported mode.
   - `assertDemoAdapterSimulated` refuses a non-simulated adapter before any quote or order effect starts. A replenishment ends
     `failed` with the reason. This check is also used in order submission, the fulfilment evidence path, and supplier creation.
   - `POST /api/workspaces/:id/suppliers` refuses, for a demo, a supplier with `isSimulated: false` or an `endpointUrl` (400).
   - Environment values (`SETTLEMENT_MODE`, `SUPPLIER_ADAPTER_MODE`) do not reach demo creation, which always passes `local`.
4. **Expiry.** Token and session resolution (`resolveToken`, `resolveSession`) join the workspace and refuse an expired demo, which
   answers 401 like an unknown token. The worker gets a `demo_expiry` step after `idempotency_sweep`. It removes up to `batchSize`
   expired demos per tick (oldest expiry first). For each demo the files go first (`templates/<id>` and `workflows/<wf>`, through a
   path guard that refuses any name that is not a plain segment under its root), then the rows in one transaction with
   `idempotency_keys`. A failing demo is reported as a step error and retried next tick. The step runs whatever the demo flag says,
   so expired demos are still removed after demos are switched off.
5. **Reset.** `POST /api/workspaces/:id/demo/reset` (owner). Under the create lock it checks that the workspace is a demo (409
   `NOT_A_DEMO` otherwise, nothing changed), checks the cap before deleting anything, removes the old files and rows, and then
   provisions and seeds a new demo. The old token stops working because its workspace is gone. Response `201`, the same shape as
   create.
6. **Limits.**
   - Per client address: a new scope `demoCreate`, 5 attempts per hour (`src/security/rate-limit.ts`). `POST /api/demo` and
     `POST /api/workspaces/:id/demo/reset` both count against it, so a reset cannot be used to get around the create limit. Refused
     attempts get `429` with `Retry-After`, like the other scopes (ADR 0033).
   - Global cap: at most `BIND_DEMO_MAX_ACTIVE` (default 200) demos that have not expired. Over it, creation answers `503`
     `DEMO_CAPACITY_REACHED`. The count and the insert run under the advisory lock `demo:create`, so concurrent creates cannot pass the cap.
7. **Switch.** `BIND_DEMO_ENABLED` (`true` or `false`). Unset: on outside `NODE_ENV=production`, off in production. When off, create
   and reset answer `404` `DEMO_DISABLED`. `createApp({ demo: { enabled, maxActive } })` overrides both for tests.
8. **Contract.** Two registry entries (`createDemo`, `resetDemo`), response schema `DemoCreatedSchema`, exposure entries in
   `docs/ecosystem/exposure.json`, error codes `DEMO_DISABLED` (404), `NOT_A_DEMO` (409), `DEMO_CAPACITY_REACHED` (503) in
   `ERROR_CODES` and `docs/ecosystem/spec/error-catalogue.json`, and the audit action `demo.created` in `EVENTS.md`,
   `event-names.json` and `event-catalogue.ts`. The generated files are regenerated: OpenAPI, SDK types, capability catalogue and
   code map. No MCP tool is added: a demo is for a visitor, not an agent.
9. **Classification of reset.** `resetDemo` is marked `irreversible: false`. The catalogue test requires every irreversible public
   write to accept a client `Idempotency-Key`. A key cannot be honoured here: the reset deletes the workspace that stores the
   idempotency row, so a replay could not return the stored answer. A demo is a throwaway sandbox, so no real data is lost. The note
   in `exposure.json` says so. Recorded as a decision, not a test change.

## Test changes to existing files, and why

| File | Change | Why |
| --- | --- | --- |
| `tests/integration/api-contract.test.ts` | Seeding calls `POST /api/demo` and `POST /api/workspaces/:id/demo/reset` through HTTP and records both demos for cleanup. The error sweep checks `409` on a reset of a real workspace. The public access sweep records a demo it creates. | The contract requires every contract-tested route to be exercised, and every created workspace to be removed in `afterAll`. |
| `tests/integration/auth-tenancy.test.ts` | `POST /api/demo` is added to the public list. `POST /api/workspaces/:id/demo/reset` is added to the owner list. | The route-table test fails for any route not listed. |
| `tests/integration/untrusted-input.test.ts` | `POST /api/demo` is added to `bodyIgnored`, and the demos it creates are recorded for cleanup. Token-shaped values (`bnd_` plus 43 characters) are masked before the leak pattern runs. | The sweep expects a 4xx for every hostile body. A demo create ignores its body by design, as `recover` and `rotate` do, and is still checked for a safe response. The owner token is the answer of this route, and a random token can contain text such as `pg_`, which the leak pattern matched once in a run. The rest of the body is still checked. |

No assertion was removed or weakened. `MAX_NOT_CONTRACT_TESTED` is unchanged, since both new routes are contract-tested. No test was
skipped, and the idempotency test was not changed.

A failure found and fixed during the work, not a test change: the idempotency coverage rule classified `resetDemo` as irreversible,
so the rule demanded a client key for it. The key cannot be honoured (see decision 9), so the classification was changed to not
irreversible, with the reason in the catalogue note.

## Evidence

Gate run on merge commit `00032408f3129ce8eb1eeba93b572e28b8b00553`, which contains this feature plus
`claude/capabilities-overview-c6elxr` (`4f189b6`). Database: `bind_wt_a1f6`, a private database on the local PostgreSQL 16 server.
Browser suite port: `BIND_WEB_TEST_PORT=3311`. Command: `DATABASE_URL=postgres://bind_local:bind_local_only@127.0.0.1:5432/bind_wt_a1f6 BIND_WEB_TEST_PORT=3311 bash scripts/verify-local.sh`.

| Gate | Result |
| --- | --- |
| lint (`npm run lint`) | PASS, no warnings |
| typecheck (`tsc` for the app, SDK and MCP) | PASS |
| unit (`vitest run tests/unit`) | 54 files, 425 tests passed |
| integration (`vitest run tests/integration`) | 68 files passed and 1 skipped; 609 tests passed and 10 skipped |
| in-process contract suite | 4 files, 32 tests passed |
| build, sdk:build, mcp:build | PASS |
| audit (`npm audit --audit-level=high`) | PASS |
| spec, SDK and map drift | PASS (each regenerated file equals the committed one) |
| forge fmt, build, test, coverage | PASS |
| anvil integration | PASS (10 tests) |
| slither `--fail-medium` | PASS |
| test:e2e (`playwright -c playwright.web.config.ts`) | PASS: 52 passed, 4 skipped by design (ADR 0055) |

Summary line: `PASS=19 FAIL_OR_BLOCKED=0 NOT_RUN_ACCEPTED=0`.

Demo tests in that run: `tests/integration/demo.test.ts` (11) and `tests/unit/demo-policy.test.ts` (7). Mutation checks,
run before the commit: removing the demo settlement override, the token expiry check, the simulated-supplier check, the cap, or the
template-folder removal each made the matching demo test fail. The source was restored afterwards.

Earlier runs on this branch, reported for completeness: on `61e2b11` the run failed the unit gate (the ADR index row was added
after the unit step had read the index) and the integration gate (one batch-size worker test, see Known risks), and the browser
gate could not start because port 3210 was held by another worktree's server. On `ec0b2f5` all 19 gates passed. On the merge commit
all 19 passed.

## Not verified

- The demo banner, the Reset button and the entry page (UI, not built here). No browser test covers the demo.
- Live anything: no live supplier, settlement, Arc, model or connector is involved. Connectors are not blocked for a demo. No
  connector verifier is registered anywhere in the code, so verification cannot reach an outside service today.
- Serverless deployment. The worker does not run there (ADR 0029). On such a deployment an expired demo is refused at once
  (token and session checks), but its rows and files are not removed until a worker tick runs.
- Concurrency across several server processes. The cap is enforced by a PostgreSQL advisory lock, which holds across processes, but
  only in-process concurrency (three simultaneous creates) was run. The per-address limiter is in memory per process (ADR 0033).
- Per-browser limits. The server has no browser identity, so only the address limit is built. The brief's "per browser" part needs
  the UI or a cookie, and is not built.
- A lost create or reset response. The visitor cannot recover the token of a demo they never received; a new demo can be created
  (it counts against the limit).

## Known risks

- A reset whose response is lost leaves the visitor with no token for the new demo (the old token is gone). Accepted for a
  throwaway sandbox.
- A demo whose seed failed has no pending approval until the owner starts a replenishment; nothing retries the seed.
- A demo owner can add connector credentials. Nothing sends them anywhere today; this should be revisited when a verifier exists.
- `DemoSafetyError` reaches the approval and fulfilment routes only if a non-simulated adapter is injected. Those routes map unknown
  errors to a generic answer. Unreachable with the adapters in the code.
- Rate-limit behaviour behind a proxy depends on `BIND_TRUST_PROXY`, as with every other scope.
- Order-dependent failure seen once, not explained. In one full integration run on the worktree's database, "a tick is bounded by
  batch size" (`tests/integration/worker.test.ts`) found 10 expired approvals where 3 were expected. The same code and database
  passed on the next full run. No background tick or other writer of approvals was found in the test code. This is recorded
  rather than fixed; it is a pre-existing test, not one written for this feature.
- Shared local database. Other worktrees on this machine run their own suites against the same PostgreSQL server. A run against the
  default database can see their rows and processes. The gate runs for this record used a database of their own
  (`bind_wt_a1f6`), created on the same server.
