# 0071: Privy browser SDK, self-hosted, behind a small adapter

Status: Accepted. Follows ADR 0051 (Privy for sign-in) and ADR 0059 (access keys on the website). Sign-in still works with an access key; this adds Google and wallet sign-in beside it.

## Decision
- The sign-in page gets Privy's browser SDK (`@privy-io/js-sdk-core@0.79.0`, exact pin) as a bundle served from our own origin. The site's CSP is `script-src 'self'` with no CDN, so no script is loaded from Privy's or any other host.
- `scripts/build-web-bundle.mjs` (npm script `web:bundle`, esbuild 0.28.2 exact pin) bundles `scripts/web-entry/privy.js` into `web/app/vendor/privy.js`. The output is generated, gitignored, and built by `scripts/vercel-build.sh` and the web Playwright server. It is not committed.
- The adapter is `createPrivyAdapter({ appId, Privy, storage, location })`. `Privy`, `storage` and `location` can be replaced in tests. It exposes `getAccessToken`, `startGoogle`, `finishOAuth`, `connectWallet` and `logout`.
- One Privy client is constructed on first use and initialized once. If initialization fails, the next call tries again.
- Privy's tokens and its PKCE state live in `sessionStorage`, so they last for this browser tab only. They never go to `localStorage`. Keys are namespaced `privy:`, so the SDK never reads other keys in the tab, such as Bind's access key. If `sessionStorage` throws, values are held in memory for the page load.
- A wallet sign-in is identity only. It proves control of an address through Sign-In With Ethereum and grants no payment authority. Spending limits and approvals stay in Bind's policy code (AGENTS.md: authority is enforced outside the model and the login).
- The adapter never logs or echoes the OAuth code, state or tokens. Its error messages are generic.

## Evidence
- `tests/unit/web-privy-adapter.test.ts` (27 tests, Vitest, no network): one construction and one initialize across calls; token pass-through and null on error; Google start navigates only to an https URL returned by Privy; OAuth return parses code, state and provider and throws without echoing them; wallet sign-in orders account request, SIWE init with the page's host and origin, `personal_sign`, then `loginWithSiwe`; missing wallet and user rejection fail clearly; logout swallows errors; the default storage falls back to memory; `npm run web:bundle` produces a bundle under 3 MB with no `eval(`, `new Function(` or `Function(`. `LOCAL_PASS`.
- A bundle load in Chromium under a strict CSP (`script-src 'self'`, no `unsafe-eval`) imported the module, created the adapter and resolved calls with zero CSP violations. Privy's network calls were blocked in that harness, so `getAccessToken` returned null. `LOCAL_PASS`, and not a live test.
- Live Google and wallet sign-in against Privy's service and the deployed site are `NOT_RUN`. A person must complete both on the deployed site before either is claimed to work.

## Consequences and notes
- Dependency resolution. The SDK's optional peer chain (`permissionless`, then `ox@^0.8`) conflicts with viem's `ox@0.14.56`, so `npm ci` fails with ERESOLVE. The root `package.json` now has `"ox": "0.14.56"` under `overrides`, so `ox` stays at the version viem uses. `--legacy-peer-deps` was rejected because it removed unrelated entries from the lockfile (`langchain`, `langgraph`, `react`, `vue`). The SDK requires `viem@2.57.7`, so viem moved from 2.57.6 to 2.57.7 (patch). `esbuild@0.28.2` was already in `node_modules` through `tsx` and `vite`.
- The SDK released 0.79.0 on 2026-10-16. The version was pinned as requested, five days before this change.
- The SDK's `Storage` interface is `get`, `put`, `del` and `getKeys`, not the `getItem`/`setItem` shape. The wrapper implements the SDK's interface.
- SDK 0.79.0 returns only `privy_oauth_code` and `privy_oauth_state` on the return URL. It never sends `privy_oauth_provider`, so the adapter reads that parameter when present and otherwise uses `google`. The provider only feeds analytics inside the SDK.
- The SDK has no fetch hook, so the adapter takes no `fetchImpl`.
- Parts of the bundle use `Buffer` (viem and Privy signing helpers). The adapter's flows do not reach them. A live test would confirm this, and an unexpected use would surface as a ReferenceError in the browser.
- The bundle is about 964 KiB, minified.
- Wiring the adapter into the sign-in page needs the public configuration endpoint (`GET /api/public-config`, another change) for `appId`. That wiring is not part of this change.
- `scripts/` is outside the ESLint scope, so the new `.js` and `.mjs` files are not linted. The `.ts` tests are.

## Not done
- Live Google sign-in and live wallet sign-in on the deployed site: `NOT_RUN`.
- Sign-in page UI for the two new options.
