# 0056: The SDK in the browser, served at /sdk/

Status: Accepted (2026-10-20). Builds on ADR 0036 (the typed client) and ADR 0054 (the website and its strict policy).

## Context
A UI is being built separately against the SDK. It must run `import { BindClient } from "/sdk/index.js"` in a page served by
this server, under the strict policy of ADR 0054 (`script-src 'self'`, no CDN, no inline script). The SDK compiles to
`sdk/dist` (ES modules, nested folders). Nothing served those files, and the Vercel build did not build or copy them.

Checked before deciding: the compiled SDK imports only relative modules with `.js` extensions, and no `node:` module
(`grep -rln "node:" sdk/dist` found nothing; `sdk/dist` is covered by the existing `dist/` rule in `.gitignore`). So it runs in a
browser as compiled, and no bundler is needed.

## Decision
- **Serving.** `src/server/app.ts` mounts an allowlisted `express.static` at `/sdk` on `sdk/dist`, after the `/brand` mount and
  before the website. Only `GET` and `HEAD` of a path made of plain names ending in `.js` are served
  (`/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.js$/`). So `.d.ts` files, source maps, dotfiles and any path with `..` are not
  served, and a miss is a 404 (`fallthrough: false`, so the website's catch-all page is not used). It is static middleware, not an
  `app.get` route, so it needs no registry entry (`src/api/registry.ts`). Cache: `public, max-age=300`, as the other assets.
- **Build.** `npm run build` now runs `npm run sdk:build` after the server build, so `npm run build && node dist/index.js` serves
  the SDK. The Playwright web suite's `webServer` runs `npm run sdk:build && npx tsx src/index.ts`, so the dev server has the
  files too. No new dependency.
- **Missing build.** If `sdk/dist/index.js` is absent, the server still starts. `/sdk/*` answers 404 and one
  `sdk.browser_build_missing` warning is logged at startup. Nothing crashes.
- **Vercel.** `vercel.json`'s `buildCommand` runs `npm run sdk:build`, then `node scripts/copy-sdk-browser.mjs public/sdk`. That
  script copies only the compiled `.js` files, with their folders, from `sdk/dist` to `public/sdk`, so no `.d.ts` or source map
  is published. Vercel's own static output then serves `/sdk/index.js`. The `vercel.json` security headers already cover it.
- **Branch base.** The worktree branch was at `d517c1a`, an ancestor of `409c2bb` that holds the SDK and the website, with no
  unique commits and no local changes. It was fast-forwarded to `409c2bb` before any edit, so the work sits on top of the SDK.

## Evidence
All commands were run from the worktree `/home/user/bind/.claude/worktrees/agent-a9084eb5cccdc5111` on Node v22.22.0, against
the local PostgreSQL 16 server. The integration and browser runs used a private database, `bind_sdk_a9084`, created with
`CREATE DATABASE` on that server (see the note below).

| Check | Command | Result |
| --- | --- | --- |
| SDK compiles, no Node-only runtime import | `npm run sdk:build`; `grep -rln "node:" sdk/dist` | Built; no match |
| Serving rules (6 tests) | `npx vitest run tests/integration/sdk-browser-serving.test.ts` | 6 passed. Covers the JS content type and exact bytes, every compiled `.js` (including `generated/operations.js`), HEAD, `.d.ts` and `.js.map` refused, 14 path-escape attempts refused (`..`, `%2e%2e`, `%2f`, `%00`), and a POST refused |
| Browser: real import and call under the policy | `npx playwright test -c playwright.web.config.ts tests/web/sdk-browser.spec.ts` | First run: 1 failure, caused by my test assuming a template field `id` where the contract has `templateId`. Corrected. Re-run: the spec passes on desktop and phone |
| Full browser suite | `npx playwright test -c playwright.web.config.ts tests/web/` | 30 passed, 4 skipped (existing conditional skips in `landing.spec.ts`). Desktop and phone |
| Missing build | Moved `sdk/dist` aside, started `npx tsx src/index.ts` on port 3311, restored it | `/sdk/index.js` 404, `/health` 200, one `sdk.browser_build_missing` warning in the log |
| Production path | `npm run build`, then `node dist/index.js` on port 3312 | `/sdk/index.js` 200, `application/javascript; charset=UTF-8`, `max-age=300`, bytes identical to `sdk/dist/index.js`; `/sdk/index.d.ts` 404 |
| Vercel build command, run as written in `vercel.json` | `sh` on the command string | Exit 0; `public/sdk/` holds exactly 5 files: `index.js`, `client.js`, `errors.js`, `events.js`, `generated/operations.js` |
| Full gate script | `DATABASE_URL=postgres://bind_local:bind_local_only@127.0.0.1:5432/bind_sdk_a9084 bash scripts/verify-local.sh` | Exit 0. PASS=19, FAIL_OR_BLOCKED=0, NOT_RUN_ACCEPTED=0 |

Gate counts from that run: lint and typecheck passed. Unit: 54 files, 423 tests passed. Integration: 66 files passed and 1 was
skipped; 586 tests passed and 10 were skipped. Contract in-process suite: 4 files, 32 tests passed. Builds (`build`, `sdk:build`,
`mcp:build`) passed. `npm audit --audit-level=high`: passed. Drift checks (spec, SDK, map) passed. Forge fmt, build, test and
coverage passed. Anvil: 10 tests passed. Slither `--fail-medium` passed. Browser (`test:e2e`): 30 passed, 4 skipped.

**Two findings from getting these to pass:**
1. **Shared database.** The first integration run failed 7 tests with `deadlock detected`. Another session was running the same
   integration suite at the same moment against the default database, `bind_local`. The suite's files run one at a time within a
   run (ADR 0010), but two runs on one database collide. This run used `bind_sdk_a9084` instead. The database was created on the
   shared local server and can be dropped with `DROP DATABASE bind_sdk_a9084;`. The other session's process was not touched.
2. **Code map drift.** `docs/CODEBASE_MAP.md` on `409c2bb` did not match a fresh regeneration: 1,961 diff lines, with the same
   function totals (1608). That drift predates this change. It was regenerated and committed here, so the map gate passes. The
   regenerated map also counts the new test and script (1612 functions). The layer ordering in the regenerated file was not
   investigated further.

## Not verified
- **Vercel deployment.** The build command runs here and copies the files. I did not deploy, so `/sdk/index.js` on a Vercel URL,
  and the `vercel.json` headers on it, are unverified.
- **The strict policy is asserted by its header, not by a blocked load.** The browser test checks that the header is present, that
  the page imports the module with no console error, and that no `securitypolicyviolation` event fired. It does not try an inline
  script or a CDN to prove those are blocked.
- **Other browsers.** Only Chromium (desktop and Pixel 7 emulation) was run.
- **The missing-build case** was checked by hand, not by an automated test. Moving `sdk/dist` in a test would race the other
  integration files.
- **The UI itself.** Nothing here builds or checks the separate UI that will import the SDK.
