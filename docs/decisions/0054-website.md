# 0054: The website, served by the API server

Status: Accepted. The landing page is built; the app screens are not.

## Context
The owner asked to start the UI. The look and feel was decided in `docs/ux/UX_BRIEF.md`; the brand is the bead ring (ADR 0045). The orphaned UI in `src/ui` (ADR 0016) still served false claims.

## Decision
- **Where:** a new top-level `web/` directory: `index.html` (landing), `start.html`, `demo.html`, `404.html`, and `assets/` (one stylesheet, a two-line boot script, the landing script). Plain HTML, CSS and JavaScript with no framework and no build step: the landing page needs none, and nothing here blocks adding a build when the app needs one.
- **Brand:** the pages use `docs/brand/tokens.css`, the fonts and the SVG assets directly, served at `/brand/`. Only `tokens.css`, `fonts/*.woff2` and `assets/*.svg` are reachable; the rest of `docs/brand` (notes, scripts, archive) answers 404.
- **Serving:** Express serves `web/` with clean URLs (`/start`, `/demo`). HTML is revalidated (`no-cache`); assets and fonts may be cached briefly. Any other GET path gets `404.html` with status 404, instead of the old UI with 200. The registry's catch-all entry says so.
- **The orphaned UI is no longer served.** Its files stay in `src/ui` untouched, as ADR 0016 required; the legacy browser suite is still `npm run test:e2e:legacy`.
- **Content Security Policy:** with no CDN and no inline script or style, every response now carries a strict policy (`default-src 'self'`, `script-src 'self'`, `style-src 'self'`, `frame-ancestors 'none'`, and so on). It was off before because the old UI loaded Tailwind from a CDN.
- **Honest buttons:** sign-in and the demo workspace are not built. "Try a demo workspace" and "Start your own workspace" lead to pages that say plainly they open with the next release and what will happen then. The only builder link is the OpenAPI document, which exists. The footer lists only pages that exist; Security and trust, status, privacy, terms, accessibility and "what we have tested" pages are not written yet.
- **Content rules:** illustrative examples are labelled ("An example day", "Example items", "Example labels"). The social example drafts and suggests; it does not claim posting, which has no connector.
- **Motion:** written inside `prefers-reduced-motion: no-preference`, so the resting page is the finished page. The how-it-works picture pins on wide screens and follows the step in view; on phones each step shows its own copy of its picture.
- **Vercel:** the build copies `web/` and the three brand folders into `public/`, uses clean URLs, drops the old catch-all rewrite to `index.html`, and sets the same security headers. Not deployed; `NOT_RUN`.

## Gate change, recorded
`npm run test:e2e` was a stub that always failed (ADR 0016) and `verify-local.sh` blocked it unless `BIND_ACCEPT_NOT_RUN` named it. It now runs the website's Playwright suite (`playwright.web.config.ts`, `tests/web/`) against the real server and database at desktop and phone sizes, and `verify-local.sh` runs it as an ordinary gate. Recording it as NOT_RUN still needs `BIND_ACCEPT_NOT_RUN=test:e2e` by name. `tests/unit/verify-local-script.test.ts` was updated to match. This is a stronger gate, not a weaker one.

## Evidence
`tests/web/landing.spec.ts`: 18 browser tests pass (4 skipped by design: the desktop-only and phone-only cases on the other size). They fail on console errors, failed requests or any HTTP error, and check the headline, the policy header, the loaded display face, no sideways scroll, the honest pages, the switcher by click and keyboard, the questions, the not-found page and status, the brand allowlist, reduced motion, dark tokens, the pinned story and the phone menu. Screens were also inspected by eye at 1280 and 390 px in light and dark. `LOCAL_PASS`.

## Not done
Sign-in (needs the Privy client and the owner's app id), the demo workspace, the app shell and its screens, the For builders page and the footer pages. Not tested: a real phone, Safari and Firefox, screen readers, colour-blind users, an operating-system reduced-motion setting (only emulated).
