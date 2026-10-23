# 0059: The app shell, sign-in with an access key, Today and Activity

Status: Accepted. First app screens built; the other areas show as "Soon".

## Context
The UX brief (`docs/ux/UX_BRIEF.md`) settled the app: a glass header with the pause switch, a sidebar on desktop and a tab bar on phones, Today with "Needs you", a live feed and an "open, read, confirm" approval panel, and Activity with filters and "Follow this". Google and wallet sign-in need Privy credentials (ADR 0051), which are not configured.

## Decision
- **Where:** `web/app/` (plain HTML, CSS and ES modules, no build step), served by the website static mount: `/app/` (Today), `/app/activity`, `/app/sign-in`. The pages import the typed SDK from `/sdk/index.js` (ADR 0056) and learn who is signed in from `GET /api/me` (ADR 0058).
- **Sign-in for now:** an access key (workspace token or account session), checked with the server before it is kept; kept for the tab unless "Remember this device" is ticked. Google and wallet sign-in slot in with Privy.
- **Today:** pending approvals in plain words built from the workflow (item, quantity, supplier as quoted, untrusted text), why each waits, who asked, expiry, amount, "Simulated supplier" and "Commits the business"; failures from the needs-attention route; a plain-language feed from real events; work in progress; loading, empty, paused, offline and staff states.
- **Approval panel:** limits and threshold, supplier and price, why now (stock against par), what was compared, what approving and rejecting do, expiry, details, and a tiered confirm (tap, hold 900 ms, or type the amount above half the daily limit). Approve and reject carry an idempotency key per opened panel. The result comes from the server's `_meta`: "Done" only when the server says the order is confirmed.
- **Pause:** in the header for owners, one confirm to pause, none to resume; the state shown is the value the server read back; the accent turns to the held colour while paused.
- **Offline:** the SDK retries reads with backoff, so one failed refresh shows the offline banner; data stays visible.
- **Activity:** the event history read forward through the poll route (newest 2000 kept), grouped by day, filters by area and "Only problems"; "Follow this" shows a work item's whole story and its current state read from `getWorkflow`. Staff do not see the team and access filter (they never receive those events).
- `[hidden]` now always hides (`site.css`), because components with an explicit `display` overrode it.

## Evidence
`tests/web/app.spec.ts`: 22 browser tests (desktop and phone) against the real server and database: sign-in refusals without and with a server check; redirect without a key; Needs you content; the approval panel's content, a tap that does nothing on a hold-tier amount, then a hold that approves (checked in the database); reject buys nothing (checked in the database); staff read-only and no pause; pause stored on the server; offline banner and recovery; sign-out; Activity filters and Follow this; staff filter set. `bash scripts/verify-local.sh`: PASS=19, FAIL_OR_BLOCKED=0, with 52 browser tests. Screens inspected at 1280 and 390 px, light and dark. `LOCAL_PASS`.

## Not done
Team and limits, Connections, Business data, People, Settings and Help; the workspace switcher; Google and wallet sign-in; the "Getting started" list; the type-the-amount tier has no browser test; Safari, Firefox, real phones and screen readers are not tested.
