# 0066: Business data

Status: Accepted. Follows the UX brief ("Team, Connections and Business data").

## Decision
- `/app/data` shows the workspace's data in tabs named by its template, with one shared table design and a search across every tab. For a kitchen: Stock, Purchases, Customer orders, Menu. The brief said "Stock, Orders, Customers, Menu"; Bind has no separate customer records, and "Orders" alone would blur buying from suppliers with selling to customers, so the tabs are Purchases and Customer orders. Another template shows "No data views for this team yet" rather than an empty kitchen layout.
- Read-only. Agents and workflows change this data and the page shows what the server holds, sorted usefully (low stock first, newest purchases and orders first, dishes by name).
- Status words keep commitments apart. Purchases: Sent, not confirmed; Confirmed by supplier; Payment in progress; Payment held; Payment sent, outcome not confirmed; Paid and matched; Cancelled. Customer orders: Accepted, Partly available, Declined, Needs you, Cancelled, Done. An unknown status shows as the server sends it.
- Search filters every tab at once, jumps to the first tab with a match when the current one has none, shows counts on the tabs and a "Found in" line, and says plainly when nothing matches. Tabs follow the ARIA tab pattern (arrows, Home, End) and the URL fragment remembers the tab.
- On phones every row becomes a labelled card and the tabs stay on one scrollable line.
- Class names `.dtab`/`.dtabs` avoid the landing page's `.tab`/`.tabs` (a clash found in the phone screenshot); the earlier `.row` clash on People was renamed to `.line` the same way.

## Evidence
`tests/web/data.spec.ts` (desktop and phone): stock rows match the server, low items first and counted; tabs by click and keyboard, fragment kept across reload; a purchase approved through the API reads "Confirmed by supplier" and never "Paid"; a customer order shows its lines and "Needs you" as the server decided; search across tabs, its hit line and the no-match state; phone cards carry labels, the tabs fit one line and nothing scrolls sideways. `LOCAL_PASS`.

## Not done
Editing (stock counts, menu changes go through proposals and approvals elsewhere), row detail views, documents and the ledger as tabs, pagination for large data sets.
