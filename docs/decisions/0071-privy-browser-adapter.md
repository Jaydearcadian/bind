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
- If the Privy app requires a passcode on create (`embedded_wallet_config.require_user_password_on_create`), the SDK throws "Password not provided yet is required by App configuration". The adapter maps that to `PASSCODE_REQUIRED` and invents no passcode. The owner reports this setting is `false` for Bind's app. That is the owner's report; the dashboard cannot be read from here.
- The owner reports Bind's app runs in `embedded_wallet_config.mode = "user-controlled-server-wallets-only"`, so creation takes the server path described in "Server-wallet mode" below, not the frame path.
- The wallet frame: the SDK runs embedded wallet calls inside a Privy page in an iframe. The frame is created lazily, on the first `create`, and at most once per adapter.
  - Its URL is `embeddedWallet.getURL()`. It is refused, before anything is appended, unless it parses, is `https:`, has host exactly `auth.privy.io`, has the default port, and has no credentials. A refused URL throws `WALLET_FRAME_REFUSED`.
  - The element is an `iframe` with `title="Privy wallet"`, `aria-hidden="true"`, `tabindex="-1"` and `display:none`, appended to the document body.
  - One `message` listener on the window. It forwards a message to `embeddedWallet.onMessage` only when `event.origin` equals the frame's origin and `event.source` is the frame's `contentWindow`. String data is parsed as JSON. Only objects with a string `event` field are forwarded. Anything else is dropped silently.
  - The SDK posts to the frame with the target origin `*`. The adapter's poster sends only to the frame's validated origin instead, so the messages (which carry access tokens) never go to any other origin.
  - The CSP entry that lets the frame load is `frame-src https://auth.privy.io` (ADR 0070).
  - Lifecycle. The frame element has the fixed id `bind-privy-wallet-frame`. An existing element with that id is reused only if its `src` is exactly the validated URL; any other element with that id is refused (`WALLET_FRAME_REFUSED`) and nothing is appended. If the page removed the frame, the adapter forgets it and its listener, and makes a new one on the next creation: still one live frame. `logout()` removes the listener and the frame. Two adapters on one page share the one element. Disposing it from one adapter removes it for the other, which is acceptable because the app has one adapter per page.
  - Attributes: `sandbox="allow-scripts allow-same-origin"`, `allow=""`. No `referrerpolicy`, no `credentialless`, and never `allow-top-navigation` or `allow-popups`. The sandbox is not a boundary against this page: allow-scripts with allow-same-origin lets the framed page lift its own sandbox. The origin and window checks above are the boundary. The sandbox flags and the real Privy handshake inside the frame are NOT_RUN live.
  - A message is dropped (no forward) when the frame's `contentWindow` is null, and when no frame client is set yet (the poster could not be installed).
  - `reload()` reloads the frame at its validated URL, never at a value the SDK supplies.
- Errors from the wallet calls carry a `code` and a plain message, never a `cause`, the SDK's or the wallet's text, a token, or an address. Codes: `PRIVY_UNAVAILABLE`, `WALLET_FRAME_REFUSED`, `PASSCODE_REQUIRED`, `WALLET_CREATE_FAILED`, `WALLET_NOT_FOUND`. Nothing is logged.
- Partial failure: if `create` throws for any reason other than the passcode message, the adapter reads the user once. If a wallet now exists it returns `{ address, created: false }`, which is true: the wallet exists, but this call did not finish creating it. Otherwise it throws `WALLET_CREATE_FAILED`.
- Caller decides: `ensureWallet` does not check how the person signed in. The sign-in page (`web/app/sign-in.js`) calls it only after a Google return, when `finishOAuth` returned true. It is never called after a wallet login or on a quiet re-entry. The Settings page calls `getWalletAddress` to show the address and calls `ensureWallet` only from its "Set up my wallet" button.
- Wired now: the merged sign-in and Settings pages call these methods as above. Live creation is NOT_RUN.

## Server-wallet mode (the owner's reported app setting)
The owner reports `embedded_wallet_config.mode = "user-controlled-server-wallets-only"`, `require_user_password_on_create = false` and `create_on_login` off. What the SDK 0.78.0 `create()` does in this mode, read from `dist/esm/index.mjs`:
- It first checks `this._proxy`. The adapter installs the poster before `create`, so this check passes. The frame is therefore created (it loads `https://auth.privy.io/apps/<app>/embedded-wallets`), but nothing waits for it and no message is sent to it.
- It does not take the passcode path: with no password, the password error cannot occur here.
- It calls `ar({ chainType: 'ethereum', idempotencyKey })`, which posts `{ chain_type: 'ethereum' }` through the SDK's `fetch` to the wallets route (api-types: `POST /v1/wallets`, under the SDK base URL). The request carries the session's access token (through the SDK request hook; the hook itself was not read line by line). The returned wallet object is discarded.
- It then returns `refreshSession(undefined)`, the SDK's refresh response, an `AuthenticatedUser` with `user`. The new wallet is read from that `user.linked_accounts`. If the refreshed user lacks it, the adapter reads the user once more (`user.get`).
- Calls the browser makes for a first Google sign-in in this mode, in order: the SDK initialize (app config, `getAppConfig`), `getAccessToken` (session in `sessionStorage`), `user.get` (no embedded wallet yet), the frame load (`auth.privy.io`, allowed by `frame-src`), `POST /v1/wallets` (SDK base URL), then the refresh (SDK base URL).
- Hosts: all of these use the SDK base URL, which defaults to `https://auth.privy.io`. So `connect-src 'self' https://auth.privy.io` covers them. One exception: if the app config sets `custom_api_url`, the SDK switches its base URL to that host, and `connect-src` would refuse it. The owner's report does not mention `custom_api_url`. It must be checked in the dashboard; if it is set, a new `connect-src` origin is a new decision (ADR 0070).
- Likely failure points for a Google-signed-in user in this mode, none verified live:
  1. The server-created wallet's linked-account shape. The adapter matches `connector_type: 'embedded'`, `wallet_client_type: 'privy'`, `chain_type: 'ethereum'`. If Privy lists a server-created wallet under a different shape, `ensureWallet` returns `WALLET_NOT_FOUND` although the wallet exists. The adapter fails closed; nothing is created twice.
  2. Refresh lag: if neither the refreshed user nor a fresh read shows the wallet, `WALLET_NOT_FOUND`. The next sign-in finds it.
  3. A `custom_api_url` host outside `connect-src` (above).
  4. The recovery model. In this mode the SDK passes no recovery method to `POST /v1/wallets`. The custody and recovery that Privy's TEE-based mode gives are not verified here. The owner should confirm them in Privy's documentation before relying on this.
- Tests: the unit tests simulate this mode (`walletMode: "user-controlled-server-wallets-only"`): the address comes from the user after `create`, no frame message is needed, and a lagging refresh is followed by a fresh read. A fake cannot prove what Privy's server returns.

## Dependencies
- `ox` override (`"overrides": { "ox": "0.14.56" }`). `@privy-io/js-sdk-core@0.78.0` has an optional peer on `permissionless`, which has an optional peer on `ox@^0.8`. viem 2.57.6 needs `ox@0.14.56`. npm reports ERESOLVE on that chain. Still needed with 0.78.0, as checked on 2026-10-21. `--legacy-peer-deps` was rejected because it removed unrelated lock entries (`langchain`, `langgraph`, `react`, `vue`).
- `viem` held at 2.57.6. The SDK declares an optional peer on `viem@2.56.5` (exact). Without a pin, npm moves the server's viem down to 2.56.5. Root `viem` is therefore pinned to `2.57.6` (the version the base commit had), with a matching override, because npm refuses an override that conflicts with a direct dependency range. Result: `npm ls viem` reports no invalid peer. The mismatch is still real: `@privy-io/ethereum` declares an exact `viem@2.56.5`, and this build runs 2.57.6. Its code paths are not used by the adapter, but an upgrade of viem or the SDK should recheck this.
- `esbuild@0.28.2` was already in `node_modules` through `tsx` and `vite`. It is now a direct devDependency at the same version.
- A unit test checks that the installed `ox` is the pinned override.

## Bundle size
- 989,874 bytes (966.7 KiB) minified, against 986,517 bytes for the HEAD adapter. The embedded-wallet code adds 3,357 bytes. The SDK was already in the bundle. Under the 3 MB limit the test enforces.

## Buffer
- The bundle contains bare `Buffer` references. A static trace of the minified code finds them only in transaction serialization (`CM` calls `OM`), in the embedded-wallet raw-sign branches (`secp256k1_sign`, `eth_sign`) and in Solana signing. None is reached by `initialize`, `getAccessToken`, `oauth.generateURL`, `oauth.loginWithCode`, `siwe.init`, `siwe.loginWithSiwe`, `logout`, `user.get` or `embeddedWallet.create` in the paths the adapter takes before the network. No shim was added, because none is needed for these paths.
- Limits: the Chromium check cannot reach the post-login steps, because Privy's network calls are refused in that environment. A live login is needed to see whether Privy's embedded-wallet creation touches `Buffer`. Such a use would appear as a ReferenceError in the browser console, and the Playwright spec fails on any ReferenceError logged to the page.

## Evidence
- `tests/unit/web-privy-adapter.test.ts`: 88 tests, Vitest, no network. The unit suite as a whole: 606 tests, `LOCAL_PASS`. They cover the earlier behaviour (construction and initialize once; retry after failed start; module import without a window; token pass-through; Google start with each refused URL and return address; the allowed hosts; one Google start at a time; OAuth return parsing; provider fixed to `google`; address-bar scrub before `loginWithCode`; absent history; console silence and no `cause`; wallet order; wallet error mapping; non-string signature; one wallet sign-in at a time; logout; default storage; `privy:` namespace; garbage handling; the in-memory preference; the failed-write removal; the bundle build; the pinned `ox`). The embedded-wallet tests (39, of which 10 are the hostile-URL cases) cover:
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
  - The frame lifecycle: a removed frame is recreated with one live frame and one listener; `logout` removes the frame and listener; two adapters share one element; a foreign element with the id is refused.
  - The frame attributes (sandbox, allow, no referrer policy or credentialless flag).
  - A null `contentWindow` and a message before the client is set are both dropped; `reload()` uses the validated URL.
  - Create failing after the wallet exists returns `created: false`; create failing with no wallet throws `WALLET_CREATE_FAILED`.
  - The server-wallet mode: the address comes from the user after create, with no frame message; a lagging refresh is followed by a fresh read.
  - The module's named exports are exactly `ALLOWED_AUTH_HOSTS`, `PRIVY_PROVIDER`, `createPrivyAdapter` and `createSessionStorage`.
- `tests/web/privy-bundle.spec.ts`, `tests/web/app.spec.ts`, `tests/web/wallet.spec.ts` together: 36 Playwright tests, desktop and phone, `LOCAL_PASS`. `wallet.spec.ts` uses the stub adapter in `tests/web/support/privy-stub.ts`, so it does not exercise this adapter's creation path.
- `tests/web/privy-bundle.spec.ts` (Playwright, real server, real helmet CSP, desktop and phone): the bundle is served and runs with no ReferenceError and no `script-src` or `unsafe-eval` violation, and the wallet methods return null when signed out. The frame-src check is in ADR 0070. `LOCAL_PASS`.
- `tests/integration/csp-policy.test.ts`: the policy includes `frame-src https://auth.privy.io` in helmet and `vercel.json`, and exactly one CSP header is declared there. `LOCAL_PASS`.
- Live Google and live wallet sign-in against Privy's service and the deployed site, and live embedded-wallet creation: `NOT_RUN`. A person must complete them on the deployed site before either is claimed to work.

## Not done
- The live embedded-wallet creation in the owner's server-wallet mode (`NOT_RUN`). The unit tests use a fake.
- The live frame handshake and the sandbox flags in a real browser (`NOT_RUN`).
- Checking the owner's dashboard for `custom_api_url` (if set, the SDK's calls leave `connect-src`), and for the server-created wallet's linked-account shape (`NOT_RUN`).
- Live Google and wallet sign-in.
