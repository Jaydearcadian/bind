# 0069: "Getting started" on Today

Status: Accepted. Follows the UX brief ("First run": a Getting started list stays on Today until done).

## Decision
- Owners of a real workspace see four steps on Today: look over your limits, approve a real supplier, connect a tool, invite someone. Each links to the screen where it is done.
- Steps are ticked from what the server holds: an approved, non-simulated supplier; a connector that isn't revoked; an invite or a member. Looking over the limits can't be read from the server (keeping the defaults is a valid choice), so it is the owner's own tick ("They look right"), kept on this device per workspace.
- The list disappears when all four are done, or when the owner chooses "Hide this list" (per device, per workspace). Staff never see it (setup is the owner's), nor does a demo (it isn't theirs to set up).
- No sample items are added to a real workspace to make Today look busy (brief: never fabricate activity).

## Evidence
`tests/web/starter.spec.ts` (desktop and phone): 0 of 4 at first; an invite and an approved real supplier made through the API tick two steps; the owner's limits tick survives a reload; a stored connector completes the list and it goes away; Hide keeps it hidden after reload; staff and a demo never see it. `LOCAL_PASS`.

## Not done
The workspace switcher (needs account sign-in, so Privy), and the first-run "Create or join" screen for a signed-in person with no workspace.
