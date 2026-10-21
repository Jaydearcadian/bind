# 0065: Connections

Status: Accepted. Uses connectors (ADR 0024), suppliers and surface bindings (ADR 0022); follows the UX brief ("Team, Connections and Business data").

## Decision
- `/app/connections` groups what agents can reach: Tools and services (connectors), Suppliers, Messaging apps (surface bindings), Other agents. A health strip on top counts what needs the owner, what is verified live, added but not verified, and simulated.
- **Status words are earned.** "Verified live" appears only for a connector whose verifier passed (`status: verified`). A connector without a verifier stays "Added, not verified", and Test says there is no automatic test for that kind yet (today no verifier is registered). A supplier's `verified` flag is the owner vouching for it, used by the commitment gate; the page calls it "Approved by you" and keeps the status "Added, not verified". An unapproved real supplier is "Needs attention" (agents can ask for quotes but nothing can be bought). Simulated suppliers say "Practice supplier". A surface binding's `verified` is set by an owner through the API, so it shows "Marked verified by an owner", never "Verified live".
- **Keys:** added with a name, a kind and the key; sent once, stored encrypted, never returned or kept by the page (the form is reset after saving). The id is made from the name. Remove destroys the ciphertext (with an idempotency key) behind a confirm. If the server has no credential key, the page says the server isn't set up to store keys yet.
- **Suppliers:** owners add a real supplier by name and optional email, quoting by email or phone (`manual_quote`), approved or not; Approve and Stop buying flip the approval and keep the other fields. A supplier's own ordering API is not offered: no adapter exists for it, so offering it would be a capability that doesn't work. A demo refuses real suppliers and the page explains.
- **Messaging apps** are listed read-only; adding bindings from the page waits for real surface adapters. **Other agents** says none are connected and that each will come through a checked adapter.
- Staff see suppliers and messaging apps; tools and keys are owner-only (the API returns 403).
- The browser test server now gets the same committed, test-only credential key as `vitest.config.ts`, so Connections can store keys in tests.

## Evidence
`tests/web/connections.spec.ts` (desktop and phone): the template's simulated suppliers say so and nothing claims "Verified live"; a key is added, never appears in the page or the list API, Test reports that no verifier exists and the status stays honest, Remove asks first and the server shows it revoked; a real supplier is added unapproved, needs the owner, is approved and unapproved with the server agreeing and its email kept; staff see no tools, no Add and no Approve, and get 403 on connectors; a demo refuses a real supplier with a plain reason. `LOCAL_PASS`.

## Not done
Live verifiers (none registered), editing a supplier's details, adding messaging bindings, remote agents, and a per-connection detail page.
