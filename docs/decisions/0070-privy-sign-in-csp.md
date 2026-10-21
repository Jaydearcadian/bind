# 0070: Privy sign-in: public config and the CSP

Status: Accepted. Follows ADR 0051 (sign-in with Privy) and ADR 0054 (the strict policy). Amended by ADR 0071 (embedded wallet), which adds one `frame-src` origin.

## Decision
- `GET /api/public-config` is public, unauthenticated and never cached (`Cache-Control: no-store`). It answers exactly `{ "privyAppId": string | null }`: the value of `PRIVY_APP_ID`, or null when it is unset. The app id is public by design and is shipped to every browser anyway. The verification key and every other setting are never returned.
- `connect-src` gains exactly one origin: `https://auth.privy.io`. Privy's browser SDK calls that host for sign-in and for the embedded wallet.
- `frame-src` gains exactly one origin: `https://auth.privy.io`. This is the hidden Privy wallet frame that the embedded wallet uses (ADR 0071). The frame is created only when a wallet is first created, never at page load.
  - Why `frame-src` alone and not `child-src`: `frame-src` is the directive the browser checks for an iframe. `child-src` is only a fallback for `frame-src` (it is consulted only when `frame-src` is absent) and it would also govern workers, which Bind does not use. With `frame-src` present, nothing else changes.
  - `frame-ancestors 'none'` is unchanged. Bind pages still cannot be framed by others. The wallet frame is one Bind embeds, not one that embeds Bind.
- `script-src` stays `'self'`. The Privy SDK is bundled and self-hosted, so no script origin is added. The wallet frame is a page that Privy serves, not a script Bind loads, so it needs `frame-src` and nothing else.
- The rest of the policy is unchanged: `default-src 'self'`, `style-src 'self'`, `img-src 'self' data:`, `font-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`.
- The policy is defined twice: helmet in `src/server/app.ts` and the headers block in `vercel.json`. A test reads the header the running app sends and the header `vercel.json` declares. It fails if they differ from each other or from this ADR. It scans every `headers[]` entry in `vercel.json` and requires exactly one Content-Security-Policy header, for `/(.*)`.

## Revisit when
- Privy adds a further frame, for example a CAPTCHA. Each new `frame-src` (or `child-src`) origin is a new decision, added here with its reason.
- Privy adds a further host the browser SDK must reach. Each one is a new `connect-src` origin, added here with its reason.

## Evidence
- `tests/integration/public-config.test.ts`: null when unset, the app id when set, exactly one key, `no-store`, no authentication needed, no verification key text in the body. `LOCAL_PASS`.
- `tests/integration/csp-policy.test.ts`: the live header equals this policy exactly, including `frame-src`. `vercel.json` equals the live header directive for directive, and exactly one CSP header exists in the file. `LOCAL_PASS`.
- `tests/web/privy-bundle.spec.ts`, "the CSP admits the wallet frame origin and refuses another frame origin": in headless Chromium against the real server, a frame to `https://auth.privy.io` raises no `frame-src` violation, and a control frame to `https://evil.example` does raise one, which proves the listener sees violations. Desktop and phone projects. `LOCAL_PASS`.

## Not done
- A live embedded wallet in a real browser: Privy's frame loaded from `auth.privy.io` against the owner's Privy app, with a real sign-in. `NOT_RUN`.
- The live Privy sign-in in a real browser (needs the owner's Privy app and a real login). `NOT_RUN`.
