# 0070: Privy sign-in: public config and the CSP

Status: Accepted. Follows ADR 0051 (sign-in with Privy) and ADR 0054 (the strict policy).

## Decision
- `GET /api/public-config` is public, unauthenticated and never cached (`Cache-Control: no-store`). It answers exactly `{ "privyAppId": string | null }`: the value of `PRIVY_APP_ID`, or null when it is unset. The app id is public by design and is shipped to every browser anyway. The verification key and every other setting are never returned.
- `connect-src` gains exactly one origin: `https://auth.privy.io`. Privy's browser SDK calls that host for sign-in. Nothing else changes.
- `script-src` stays `'self'`. The Privy SDK is bundled and self-hosted, so no CDN or inline script is needed (ADR 0054).
- No frame source is added. Sign-in with Google and a wallet needs none. `frame-ancestors 'none'` is unchanged.
- The rest of the policy is unchanged: `default-src 'self'`, `style-src 'self'`, `img-src 'self' data:`, `font-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`.
- The policy is defined twice: helmet in `src/server/app.ts` and the headers block in `vercel.json`. A test reads the header the running app sends and the header `vercel.json` declares, and fails if they differ from each other or from this ADR.

## Revisit when
- Embedded wallets, or any Privy feature that renders a frame (for example a CAPTCHA), is enabled. Those need a `frame-src` (or `child-src`) origin, which is a new decision.
- Privy adds a further host the browser SDK must reach. Each one is a new `connect-src` origin, added here with its reason.

## Evidence
`tests/integration/public-config.test.ts`: null when unset, the app id when set, exactly one key, `no-store`, no authentication needed, no verification key text in the body. `tests/integration/csp-policy.test.ts`: the live header equals this policy exactly, `vercel.json` equals the live header directive for directive, and a temporary edit to `vercel.json` makes the second test fail. `LOCAL_PASS`.

## Not done
The live Privy sign-in in a real browser (needs the owner's Privy app and a real login). `NOT_RUN`.
