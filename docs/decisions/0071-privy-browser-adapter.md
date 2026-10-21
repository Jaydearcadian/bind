# 0071: Privy browser SDK, self-hosted, behind a small adapter

Status: Accepted. Follows ADR 0051 (Privy for sign-in) and ADR 0059 (access keys on the website). Sign-in still works with an access key; this adds Google and wallet sign-in beside it. Amended for the embedded wallet (Google sign-in gets a Privy embedded wallet): see "Embedded wallet" below. Its CSP entry is ADR 0070.

## Decision
- The sign-in page gets Privy's browser SDK (`@privy-io/js-sdk-core@0.78.0`, exact pin) as a bundle served from our own origin. The site's CSP is `script-src 'self'` with no CDN, so no script is loaded from Privy's or any other host.
- The bundle is an ES module. The page loads it with `import()`.
- `scripts/build-web-bundle.mjs` (npm script `web:bundle`, esbuild 0.28.2 exact pin) bundles `scripts/web-entry/privy.js` into `web/app/vendor/privy.js`. The output is generated and gitignored. `scripts/vercel-build.sh` builds it and then fails the build if `public/app/vendor/privy.js` is missing or empty. The web Playwright server builds it too. It is not committed.
- SDK version. 0.78.1 was considered, but it was published 2026-10-07, 13 days 21 hours before this change, so it fails the 14-day rule. 0.78.0 (published 2026-10-02) is the newest release that passes.
- The adapter is `createPrivyAdapter({ appId, Privy, storage, location, history, frameDocument, frameWindow })`. `Privy`, `storage`, `location`, `history`, `frameDocument` and `frameWindow` can be replaced in tests. Browser globals are read only when used, so importing the module needs no window.
- The adapter exposes exactly seven methods: `getAccessToken`, `startGoogle`, `finishOAuth`, `connectWallet`, `getWalletAddress`, `ensureWallet` and `logout`. A unit test asserts that list. No method signs or sends from the embedded wallet.
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
- Concurrency: `startGoogle`, `connectWallet` and `ensureWallet` each allow one attempt at a time. A second call while one is running returns the same pending promise. The slot is cleared when the attempt settles.
- A wallet sign-in is identity only. It proves control of an address through Sign-In With Ethereum and grants no payment authority. Spending limits and approvals stay in Bind's policy code, as AGENTS.md requires.
- Wallet errors: code 4001 and `ACTION_REJECTED` become a "cancelled" message. -32002 becomes "a request is already pending in your wallet". The wallet's own text is never shown. A signature that is not a string is refused.

## Embedded wallet
- Decision (owner): a person who signs in with Google gets Privy's embedded Ethereum wallet, created automatically at first sign-in, one per person. Privy holds the key. Bind's server never sees, stores, signs with or sends from it. Creating a wallet moves no money. A person who signed in with an external wallet already has a wallet and needs none.
- `getWalletAddress()` returns the embedded address, or null when signed out, when none exists, or on any error. It reads the user only. It never creates a wallet and never creates the frame.
- `ensureWallet()` returns null when signed out. Otherwise it reads the linked accounts (`user.get`). The embedded Ethereum wallet is the linked account with `type: 'wallet'`, `chain_type: 'ethereum'`, `connector_type: 'embedded'` and `wallet_client_type: 'privy'` (the `LinkedAccountEthereumEmbeddedWallet` shape in `@privy-io/api-types`). An external wallet never matches. If one exists it returns `{ address, created: false }`. Otherwise it calls `privy.embeddedWallet.create({})` and returns `{ address, created: true }`, reading the new address from the returned user (or from a fresh read).
- Recovery, as the SDK 0.78.0 code does it: `create({})` passes no password and no recovery method. The SDK then sets the recovery method to `privy` (its code is `recoveryMethod = recoveryMethod || (password ? 'user-passcode' : 'privy')`). That is Privy-managed recovery: the person is asked for no passcode, and Bind sets none. The consequence to accept: recovery depends on Privy. A passcode-based recovery would make the person's own secret the only way back, which is a product decision the owner has not made.
- If the Privy app requires a passcode on create (`embedded_wallet_config.require_user_password_on_create`), the SDK throws "Password not provided yet is required by App configuration". The adapter maps that to `PASSCODE_REQUIRED` and invents no passcode. Whether Bind's Privy app has this setting is NOT checked: the app dashboard cannot be read from here. The owner should check it in the Privy dashboard before relying on automatic creation.
- The SDK's `user-controlled-server-wallets-only` mode creates wallets through a server route instead. Bind's app mode is not checked here either.
- The wallet frame: the SDK runs embedded wallet calls inside a Privy page in an iframe. The frame is created lazily, on the first `create`, and at most once per adapter.
  - Its URL is `embeddedWallet.getURL()`. It is refused, before anything is appended, unless it parses, is `https:`, has host exactly `auth.privy.io`, has the default port, and has no credentials. A refused URL throws `WALLET_FRAME_REFUSED`.
  - The element is an `iframe` with `title="Privy wallet"`, `aria-hidden="true"`, `tabindex="-1"` and `display:none`, appended to the document body.
  - One `message` listener on the window. It forwards a message to `embeddedWallet.onMessage` only when `event.origin` equals the frame's origin and `event.source` is the frame's `contentWindow`. String data is parsed as JSON. Only objects with a string `event` field are forwarded. Anything else is dropped silently.
  - The SDK posts to the frame with the target origin `*`. The adapter's poster sends only to the frame's validated origin instead, so the messages (which carry access tokens) never go to any other origin.
  - The CSP entry that lets the frame load is `frame-src https://auth.privy.io` (ADR 0070).
- Errors from the wallet calls carry a `code` and a plain message, never a `cause`, the SDK's or the wallet's text, a token, or an address. Codes: `PRIVY_UNAVAILABLE`, `WALLET_FRAME_REFUSED`, `PASSCODE_REQUIRED`, `WALLET_CREATE_FAILED`, `WALLET_NOT_FOUND`. Nothing is logged.
- Not wired: the sign-in page does not call `ensureWallet` yet, and it has no UI for the wallet. Those are separate changes.

## Dependencies
- `ox` override (`"overrides": { "ox": "0.14.56" }`). `@privy-io/js-sdk-core@0.78.0` has an optional peer on `permissionless`, which has an optional peer on `ox@^0.8`. viem 2.57.6 needs `ox@0.14.56`. npm reports ERESOLVE on that chain. Still needed with 0.78.0, as checked on 2026-10-21. `--legacy-peer-deps` was rejected because it removed unrelated lock entries (`langchain`, `langgraph`, `react`, `vue`).
- `viem` held at 2.57.6. The SDK declares an optional peer on `viem@2.56.5` (exact). Without a pin, npm moves the server's viem down to 2.56.5. Root `viem` is therefore pinned to `2.57.6` (the version the base commit had), with a matching override, because npm refuses an override that conflicts with a direct dependency range. Result: `npm ls viem` reports no invalid peer. The mismatch is still real: `@privy-io/ethereum` declares an exact `viem@2.56.5`, and this build runs 2.57.6. Its code paths are not used by the adapter, but an upgrade of viem or the SDK should recheck this.
- `esbuild@0.28.2` was already in `node_modules` through `tsx` and `vite`. It is now a direct devDependency at the same version.
- A unit test checks that the installed `ox` is the pinned override.

## Bundle size
- 989,382 bytes (966.2 KiB) minified, against 986,517 bytes for the HEAD adapter. The embedded-wallet code adds 2,865 bytes. The SDK was already in the bundle. Under the 3 MB limit the test enforces.

## Buffer
- The bundle contains bare `Buffer` references. A static trace of the minified code finds them only in transaction serialization (`CM` calls `OM`), in the embedded-wallet raw-sign branches (`secp256k1_sign`, `eth_sign`) and in Solana signing. None is reached by `initialize`, `getAccessToken`, `oauth.generateURL`, `oauth.loginWithCode`, `siwe.init`, `siwe.loginWithSiwe`, `logout`, `user.get` or `embeddedWallet.create` in the paths the adapter takes before the network. No shim was added, because none is needed for these paths.
- Limits: the Chromium check cannot reach the post-login steps, because Privy's network calls are refused in that environment. A live login is needed to see whether Privy's embedded-wallet creation touches `Buffer`. Such a use would appear as a ReferenceError in the browser console, and the Playwright spec fails on any ReferenceError logged to the page.

## Evidence
- `tests/unit/web-privy-adapter.test.ts`: 73 tests, Vitest, no network. They cover the earlier behaviour (construction and initialize once; retry after failed start; module import without a window; token pass-through; Google start with each refused URL and return address; the allowed hosts; one Google start at a time; OAuth return parsing; provider fixed to `google`; address-bar scrub before `loginWithCode`; absent history; console silence and no `cause`; wallet order; wallet error mapping; non-string signature; one wallet sign-in at a time; logout; default storage; `privy:` namespace; garbage handling; the in-memory preference; the failed-write removal; the bundle build; the pinned `ox`). The embedded-wallet tests (24) cover:
  - `ensureWallet` returns null when signed out, and never creates.
  - An existing embedded Ethereum wallet is found and `create` is not called.
  - A missing wallet is created with exactly `{}` and returns `created: true`. A second call returns `created: false`.
  - Concurrent calls share one promise and create once.
  - An external wallet is never mistaken for the embedded one.
  - `getWalletAddress` reads only.
  - The frame is created only on first creation, once, hidden, with the exact URL and title, and never a second one, even after a failed create.
  - Eight hostile frame URLs and a throwing `getURL` are refused before anything is appended.
  - Messages from another origin or another window are ignored, and malformed ones are dropped. Messages from the frame's origin and window are forwarded, as a JSON string or as an object.
  - The poster targets the validated origin, never `*`.
  - Errors have codes, no `cause`, and no SDK or wallet text.
  - `PASSCODE_REQUIRED` is reported with no passcode invented.
  - `WALLET_NOT_FOUND` when creation succeeds but no wallet appears.
  - The exact method list.
- `tests/web/privy-bundle.spec.ts` (Playwright, real server, real helmet CSP, desktop and phone): the bundle is served and runs with no ReferenceError and no `script-src` or `unsafe-eval` violation, and the wallet methods return null when signed out. The frame-src check is in ADR 0070. `LOCAL_PASS`.
- `tests/integration/csp-policy.test.ts`: the policy includes `frame-src https://auth.privy.io` in helmet and `vercel.json`, and exactly one CSP header is declared there. `LOCAL_PASS`.
- Live Google and live wallet sign-in against Privy's service and the deployed site, and live embedded-wallet creation: `NOT_RUN`. A person must complete them on the deployed site before either is claimed to work.

## Not done
- The live embedded-wallet creation (`NOT_RUN`), and the check of Bind's Privy dashboard for the passcode setting (`require_user_password_on_create`) and the wallet mode.
- The sign-in page call to `ensureWallet` after Google sign-in, and any wallet UI.
- Live Google and wallet sign-in.
