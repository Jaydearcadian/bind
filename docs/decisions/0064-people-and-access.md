# 0064: People and access, invite links, and the phone More menu

Status: Accepted. Uses the account layer of ADR 0052; follows the UX brief ("People, Settings, Help and the shell").

## Decision
- `/app/people` is owner-only in content. Staff see one line ("Only owners manage people") and the API refuses them (403) whatever the page does.
- **Invite someone:** a name and a lifetime (1, 3 or 7 days). The server returns a single-use staff code once; the page shows it as a link `/app/join#bni_…` with Copy and a QR code, and forgets it on "Invite someone else". The code sits in the URL fragment so opening the link never sends it to a server log. Invites always join as staff; an owner promotes after they join.
- **Waiting to join:** live invites with time left and who made them, each with Cancel. Used, expired and cancelled ones are folded away below.
- **People:** account members with a role select (Owner or Staff) and Remove behind a confirm. The server's last-owner rule is shown in plain words ("A workspace always keeps at least one owner"); after any change the list is reloaded from the server.
- **The join page** (`/app/join`) checks the code's shape, keeps it in this tab only, removes it from the address bar and history, and says plainly that joining needs Google or wallet sign-in, which is not switched on yet. A malformed link says so and asks for a fresh one. No workspace name is shown: there is no public lookup by code, on purpose.
- **Phones:** the tab bar gains "More" (Business data, People and access, Settings, Help; the unbuilt ones marked Soon). Escape and an outside tap close it.
- Access keys are not listed here; they belong to Settings, For builders (brief).
- Shared fix found by the tests: `.btn:hover` lifts the button 1px, which made a pointer resting on the bottom edge flicker hover on and off (and kept the button "unstable" for Playwright). A 2px strip under each button keeps the hit area still.

## Evidence
`tests/web/people.spec.ts` (desktop and phone): invite made, shown once, listed, absent from the list API, cleared from the page, cancelled (server agrees); role change and remove with confirm and cancel (server agrees); last owner can't demote or remove themself, with the plain message, using a real account session row; staff see the note and get 403 from the API; the join page strips the code from the URL and survives a reload, a broken link says so; on a phone More opens People with no sideways scroll. Members are written straight into the local database because joining needs Privy; everything after that goes through the page and the API. QR encoder: `tests/unit/web-qr.test.ts` decodes with jsQR (reviewed). `LOCAL_PASS`.

## Not done
Accepting an invite in the browser (needs Privy credentials; `NOT_RUN`), email invites (no provider), and showing who "you" are in the member list when signed in with an account.
