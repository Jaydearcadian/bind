# ADR 0004: Serverless (Vercel) Deployment and Derived-Artifact Redirection

## Status
Accepted

Note (2026-10-20, Task 14). The deployment, endpoint and "Verification" results in this ADR are earlier-session claims. Task 14
did not reproduce them: this environment has no network, and several of the endpoint checks were writes, not reads. See the
appendix of `docs/RELEASE_EVIDENCE.md`.

## Context
Bind is a single Express application (`src/server/app.ts`) that serves a static SPA
(`src/ui/public/`) from the same origin as the `/api/*` routes, backed by PostgreSQL.

We needed a public deployment. Two constraints shaped the design:

1. **No database on the deployment host.** The Express app requires PostgreSQL
   (`DATABASE_URL`). Serverless functions have no local Postgres, so the deployment
   must point at a hosted database (here: Neon via the Vercel marketplace integration,
   which provisions and injects `DATABASE_URL`).
2. **The deployment bundle is read-only.** Two code paths wrote *derived* artifacts to
   `process.cwd()`:
   - `src/agents/antiDriftWriter.ts` — `workflows/<id>/STATE_ANCHOR.md` and
     `DECISION_EVIDENCE.md` per replenishment decision.
   - `src/studio/onboarding.ts` — `templates/<ws>/AGENTS.md` and
     `skills/supply-replenishment/SKILL.md` per workspace.

   On Vercel, `cwd` is `/var/task` (read-only), so these writes failed with
   `ENOENT: mkdir '/var/task/workflows/...'`, which aborted a replenishment at
   `QUOTE_RECEIVED` even though the workflow row had already persisted.

A third constraint was bundling: `deepagents` transitively pulls in
`@langchain/langgraph-sdk`, which ships a vendored pnpm copy of `p-retry` as an ES
module without a `"type": "module"` boundary. When the Vercel Node builder bundles the
function as CommonJS, loading that file throws `SyntaxError: Cannot use import
statement outside a module`, so the whole function failed at module-init with
`FUNCTION_INVOCATION_FAILED`.

## Decision
1. **Single serverless entry (`api/index.js` → `api/_handler.js`).** The handler wraps
   the existing Express app; on first invocation it runs migrations and provisions the
   demo workspace (`ws-kitchen-main`, `kitchen-v1`). It is idempotent and memoised.
   If initialisation fails, `/api/*` returns `503 SERVICE_INITIALIZATION_FAILED` rather
   than leaking a database error. Static SPA files are built into `public/` and served
   by Vercel; `/` and `/app*` rewrite to `index.html`, `/api/*` and `/health` rewrite
   to the function.
2. **Derived artifacts are redirected to a writable root.** A single helper
   (`src/utils/artifacts.ts`) resolves the artifact root: `BIND_ARTIFACTS_DIR` if set,
   else `/tmp/bind-artifacts` when `VERCEL` is set, else `process.cwd()`. Local
   development and the test suite therefore keep writing to the checkout.
   PostgreSQL remains the canonical source of truth; these files are derived output.
3. **Artifact writes are best-effort, not authoritative.** The evidence-file write in
   `generateVerifiableDecisionRecord` is wrapped so a read-only or full filesystem
   cannot fail a replicated decision record. The decision `decisionHash` and record are
   persisted in the workflow `context_data` regardless.
4. **`deepagents` is imported lazily.** The two server-graph imports of `deepagents`
   (`src/agents/bindTemplateAgent.ts`, `src/workflows/procurement.ts`) became dynamic
   imports inside the code paths that actually run the LLM agent (guarded by
   `NEBIUS_API_KEY` / `arc-testnet`). The deterministic replenishment path — the one
   the demo exercises — no longer pulls the langgraph bundle into module init.

## Consequences
- The public deployment serves the full SPA and API against hosted PostgreSQL.
- Generated `STATE_ANCHOR.md` / `DECISION_EVIDENCE.md` files are ephemeral on
  serverless (`/tmp`); durable evidence remains in PostgreSQL and in the API responses
  (`evidencePath`, `decisionHash`, audit log). This is acceptable: the files are derived.
- Running the live LLM agent path (`arc-testnet` + `NEBIUS_API_KEY`) on this serverless
  target is still unverified and would require validating the langgraph bundle in the
  function runtime.

## Verification
See the deployment section of `docs/RELEASE_EVIDENCE.md` (2026-10-18) for the exact
commands and live endpoint results.
