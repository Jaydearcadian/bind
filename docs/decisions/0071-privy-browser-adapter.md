# 0071: Privy browser SDK, self-hosted, behind a small adapter

Status: Accepted. Follows ADR 0051 (Privy for sign-in) and ADR 0059 (access keys on the website). Sign-in still works with an access key; this adds Google and wallet sign-in beside it.

## Decision
- The sign-in page gets Privy's browser SDK (`@privy-io/js-sdk-core@0.78.0`, exact pin) as a bundle served from our own origin. The site's CSP is `script-src 'self'` with no CDN, so no script is loaded from Privy's or any other host.
- The bundle is an ES module. The page loads it with `import()`.
- `scripts/build-web-bundle.mjs` (npm script `web:bundle`, esbuild 0.28.2 exact pin) bundles `scripts/web-entry/privy.js` into `web/app/vendor/privy.js`. The output is generated and gitignored. `scripts/vercel-build.sh` builds it and then fails the build if `public/app/vendor/privy.js` is missing or empty. The web Playwright server builds it too. It is not committed.
- SDK version. 0.78.1 was considered, but it was published 2026-10-07, 13 days 21 hours before this change, so it fails the 14-day rule. 0.78.0 (published 2026-10-02) is the newest release that passes.
- The adapter is `createPrivyAdapter({ appId, Privy, storage, location, history })`. `Privy`, `storage`, `location` and `history` can be replaced in tests. Browser globals are read only when used, so importing the module needs no window. It exposes `getAccessToken`, `startGoogle`, `finishOAuth`, `connectWallet` and `logout`.
- One Privy client is constructed on first use and initialized once. If initialization fails, the next call tries again. A failed attempt clears only its own slot, never a newer one.
- Google sign-in:
  - `startGoogle` refuses, before any network call, a return address that is not on this site (same origin as the page).
  - It assigns the browser only to an `https:` URL whose host is exactly one of `auth.privy.io` or `accounts.google.com` (`ALLOWED_AUTH_HOSTS`). Suffix and wildcard matching are not used. Anything else, including `javascript:`, `data:`, `http:` and lookalike hosts, is refused without navigating.
  - `finishOAuth` always uses provider `google`. It ignores any `privy_oauth_provider` parameter.
  - `finishOAuth` removes the Privy parameters from the address bar before calling `loginWithCode`, so codes stay out of history even when the login fails. An absent history object is tolerated.
  - Errors carry no `cause` and never include the code or state. Nothing is logged.
- Storage:
  - Privy's tokens and PKCE state live in `sessionStorage`, so they last for this tab only. They never go to `localStorage`.
  - Keys are namespaced `privy:`. The SDK never reads other keys in the tab, such as Bind's access key.
  - Writes go to an in-memory mirror first. Reads prefer the mirror and read `sessionStorage` only when the mirror has no entry.
  - When a `sessionStorage` write fails, the stored value for that key is removed, so an older value cannot win.
  - Non-JSON garbage under a `privy:` key is dropped, not parsed.
- Concurrency: `startGoogle` and `connectWallet` allow one attempt at a time. A second call while one is running returns the same pending promise. The slot is cleared when the attempt settles.
- A wallet sign-in is identity only. It proves control of an address through Sign-In With Ethereum and grants no payment authority. Spending limits and approvals stay in Bind's policy code, as AGENTS.md requires.
- Wallet errors: code 4001 and `ACTION_REJECTED` become a "cancelled" message. -32002 becomes "a request is already pending in your wallet". The wallet's own text is never shown. A signature that is not a string is refused.
- Content-Security-Policy: the connect-src entry for `https://auth.privy.io` is ADR 0070, a separate change. Until it lands, the production policy (`connect-src 'self'`) refuses the SDK's own calls to Privy in the browser, and the adapter's network-dependent calls fail.

## Dependencies
- `ox` override (`"overrides": { "ox": "0.14.56" }`). `@privy-io/js-sdk-core@0.78.0` has an optional peer on `permissionless`, which has an optional peer on `ox@^0.8`. viem 2.57.6 needs `ox@0.14.56`. npm reports ERESOLVE on that chain. Still needed with 0.78.0, as checked on 2026-10-21. `--legacy-peer-deps` was rejected because it removed unrelated lock entries (`langchain`, `langgraph`, `react`, `vue`).
- `viem` held at 2.57.6. The SDK declares an optional peer on `viem@2.56.5` (exact). Without a pin, npm moves the server's viem down to 2.56.5. Root `viem` is therefore pinned to `2.57.6` (the version the base commit had), with a matching override, because npm refuses an override that conflicts with a direct dependency range. Result: `npm ls viem` reports no invalid peer. The mismatch is still real: `@privy-io/ethereum` declares an exact `viem@2.56.5`, and this build runs 2.57.6. Its code paths are not used by the adapter, but an upgrade of viem or the SDK should recheck this.
- `esbuild@0.28.2` was already in `node_modules` through `tsx` and `vite`. It is now a direct devDependency at the same version.
- A unit test checks that the installed `ox` is the pinned override.

## Buffer
- The bundle contains bare `Buffer` references. A static trace of the minified code finds them only in transaction serialization (`CM` calls `OM`), in the embedded-wallet raw-sign branches (`secp256k1_sign`, `eth_sign`) and in Solana signing. None is reached by `initialize`, `getAccessToken`, `oauth.generateURL`, `oauth.loginWithCode`, `siwe.init`, `siwe.loginWithSiwe` or `logout` in the paths the adapter takes before the network. No shim was added, because none is needed for these paths.
- Limits: the Chromium check cannot reach the post-login steps, because Privy's network calls are refused in that environment. A live login is needed to see whether Privy's embedded-wallet setup after login touches `Buffer`. Such a use would appear as a ReferenceError in the browser console, and the Playwright spec fails on any ReferenceError logged to the page.

## Evidence
- `tests/unit/web-privy-adapter.test.ts`: 49 tests, Vitest, no network. They cover construction and initialize once; retry after failed start; module import without a window; token pass-through; Google start with each refused URL and return address; the allowed hosts; one Google start at a time; OAuth return parsing; provider fixed to `google`; address-bar scrub before `loginWithCode`, also when the login fails; absent history; console silence and no `cause` on both success and failure; wallet order (account, SIWE init, `personal_sign`, login); wallet error mapping; non-string signature; one wallet sign-in at a time; logout; default storage with stubbed `sessionStorage` and `localStorage` (no `localStorage` access); `privy:` namespace; garbage handling; the in-memory preference; the failed-write removal; the bundle build within 60 s, under 3 MB, ES module, and free of `eval(`, `new Function(` and `Function(`; the pinned `ox`.
- `tests/web/privy-bundle.spec.ts` (Playwright, real server, real helmet CSP): `/app/vendor/privy.js` returns 200 as JavaScript. A same-origin module imports the bundle, creates the adapter, and calls the local-only methods. It asserts no uncaught exception, no `ReferenceError` in the console, and no `script-src` or `unsafe-eval` violation. Its last run logged `token=null` and 4 `connect-src` refusals (the ADR 0070 gap).
- Chromium check of the bundle under a strict CSP (scratchpad, earlier run): import, adapter creation and calls with zero CSP violations; Privy's network calls were blocked in that harness.
- Live Google and live wallet sign-in against Privy's service and the deployed site: `NOT_RUN`. A person must complete both on the deployed site before either is claimed to work.

## Not done
- The connect-src entry for `https://auth.privy.io` (ADR 0070).
- Sign-in page UI for the two new options. The `appId` comes from `GET /api/public-config`, another change.
- Live Google and wallet sign-in.
