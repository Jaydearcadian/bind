# 0063: The demo workspace in the website and app

Status: Accepted. Uses the demo backend of ADR 0057.

## Decision
- `/demo` explains the demo in three lines (four hours, simulated suppliers, nothing real ordered or paid, resettable, deleted afterwards) and has "Start the demo". It calls `POST /api/demo` directly (public route, no key yet), keeps the returned owner key for this tab only, and opens the app.
- On a demo workspace every app page (Today, Activity, Team and limits) shows a banner: "This is a demo", sample data and simulated suppliers, the time left, "Reset demo" and "Make this yours" (to `/start`). Reset calls `resetDemo`, keeps the new key for the tab and reloads; the old key stops working. A real workspace never shows the banner (it reads `is_demo` from the workspace row).
- Errors are plain: switched off on this server (404), too many recent demos (429), busy (503), or unreachable.

## Evidence
`tests/web/demo.spec.ts`: starting a demo opens the app with the banner on all three pages, Today shows the seeded pending purchase as simulated, Reset issues a new workspace and the old key gets 401; a real workspace shows no banner. `tests/web/landing.spec.ts` updated for the new demo page text. `LOCAL_PASS`.

## Not done
A per-browser limit (the server has none), and a "Make this yours" flow beyond linking to `/start` (sign-in with Privy is not configured).
