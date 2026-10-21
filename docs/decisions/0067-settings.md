# 0067: Settings, with For builders

Status: Accepted. Follows the UX brief ("People, Settings, Help and the shell").

## Decision
- `/app/settings` has: Workspace (name, team, start date, your role, the device's time zone), Appearance, Notifications, Signing in, For builders (owners), and a separated "Leaving or closing" zone.
- **Appearance** (follow device, light, dark) is per device in `localStorage` (`bind-theme`), applied before first paint by `web/app/boot.js` and the landing page's `web/assets/boot.js`. Without storage it follows the device.
- **Only what exists can be switched.** In-app notifications are on; email and messaging channels, renaming, time zone and business hours, Google and wallet sign-in, export, leave and delete say "Coming" instead of offering a control that does nothing. Approval strictness stays where the limits are (Team and limits), not duplicated here.
- **Access keys** (owner-only): make a key with a purpose and a role (staff by default), shown once with Copy and cleared on Done; list active keys with role and age and the last few removed; Remove behind a confirm. The key this browser uses is marked only when `/api/me`'s label matches exactly one active key, and removing it warns that it signs you out. The server's last-owner-key rule is shown in plain words. Revocation uses an idempotency key.
- **Signing secret** for messaging adapters: shown only on request (the server audits each view), hidden again on demand (cleared from the page), replaced behind a confirm (old secret stops at once). A server without a master secret says signing isn't set up.
- Links to the OpenAPI description and the browser SDK for builders. A separate Developers page waits for outbound webhooks and event subscriptions (brief).
- The browser test server gets the committed test-only `BIND_MASTER_SECRET` from `vitest.config.ts`, as it already does the credential key.

## Evidence
`tests/web/settings.spec.ts` (desktop and phone): dark is kept, applied on other app pages and the landing page, and "follow device" clears it; a new key is shown once, works as staff via `/api/me`, never appears in the list API, is cleared on Done, survives "Keep it", and returns 401 after Remove; this browser's sole owner key is marked, warned about, and refused by the server with the plain message; the signing secret shown equals the server's, hides, and changes on Replace; staff see no keys or secrets (403 from the API) and every coming item is labelled with no stray switches. `LOCAL_PASS`.

## Not done
Account linking and sign-in methods (Privy), notification channels, workspace rename, time zone, quiet hours, export, leave and delete.
