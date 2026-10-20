# Bind UX brief (draft, decisions so far)

Status: draft. No UI has been built. `src/ui/` stays untouched (ADR 0016). This file records what the owner has decided in the look-and-feel discussion, and what is still a suggestion. Brand is the bead ring (ADR 0045, `docs/brand/`).

## Decided by the owner
- Bind is not limited to the kitchen. The kitchen is the first ready-made team and appears in the app, not on the landing page.
- The landing page speaks to business owners first. Feel: confident infrastructure, in the warm palette. Theme follows the device (both designed).
- Landing sections: statement, problem, how it works, who it is for and why Bind, trust and boundaries, integrations and protocols, for builders (docs), pricing, FAQ.
- Problems to name: agents cannot reach the business; setup is a project; owners lose their time; nobody can see what agents did, what waits, what failed and what is next.
- Hero visual: a "connect once" diagram with the bead ring as the connection point.
- Who it is for: studios, workshops and trades; clinics and local services; food and hospitality; shops and retail; social media managers. The owner chose to keep the page aspirational about breadth.
- Trust promises: you decide what agents may do; everything is recorded; secrets stay out of the model.
- Pricing: "free while we build".
- Landing nav: How it works / Why Bind, For builders (docs), Pricing, Sign in.
- References to steer by: Cloudflare (diagrams that explain), Stripe (decision-maker clarity, no hype). The owner will look for more sites; they are collected in the list below.
- App: approvals are "open, read, confirm". Agents' names are the owner's choice (plain roles by default, renamable). Nudges: in app first, with a per-event channel choice in Settings.

## Landing page, round 2 (decided)
- Suggestions above are accepted.
- Diagram: scroll-driven, with a finished still for reduced motion and a simpler version on small screens. The owner also wants a throwaway preview of an interactive diagram to judge the feel before deciding whether to add it.
- Copy: short with detail on demand; voice plain with warmth.
- Builders: a short block on the landing page plus a fuller "For builders" page behind it.
- FAQ: what Bind is in plain words; can agents spend my money; who sees my data and keys; what can I connect (general, with a growing ready/coming list); what if an agent gets it wrong; is it really free; do I need to be technical; which agents does it work with; can I stop everything; can my staff use it; can I take my data with me; how do I know a connection is real; does it replace my software; what happens when an agent needs me. "How long does it take to start" waits until onboarding is timed.
- What is ready today (for the FAQ): messaging apps send signed events in, bound to roles; text from documents becomes a draft an owner confirms; feedback comes in as data; the ledger exports as CSV. Not built: social posting, direct PDF or image reading, charts.
- Footer: product and builders links; security and trust; status and changelog; privacy, terms, contact; plus an accessibility statement and a plain "what we have tested, and what we have not" page drawn from the release evidence.
- First load: a brief mark reveal on the first visit of a session, and the quiet loader whenever the page is slow.
- Section order: hero; problem; how it works; who it is for; trust; integrations; builders; pricing; FAQ; final call; footer.
- Who it is for: a switcher (Studio, Clinic, Shop, Food, Social) showing a labelled "An example day"; the bead ring moves between states as it changes. Examples are illustrative and never claim a connector that does not exist.
- Problem: four short statements in large type, each with a small broken link that clicks into the ring in the how-it-works scroll.
- Final call: the line "Get back to work." with two buttons, "Try a demo workspace" and "Start your own workspace".

## Sign-in and accounts (decided)
- Sign in with Privy: Google and/or a wallet. Privy proves identity only. Bind keeps its own account records, workspace memberships and roles, and enforces authorization in code. The Privy token is verified on the server and swapped for a short-lived Bind session. Verify against the current Privy docs before building (the older server-auth library is deprecated in favour of @privy-io/node).
- Workspace tokens stay for the SDK, MCP and agents. Builders get an "Use an access key" door on the sign-in page.
- A Privy app id and secret are credentials the owner supplies through environment config. They never go in the repository. Local tests use a fake verifier; live sign-in is NOT_RUN until run against the owner's Privy app.
- A wallet sign-in is identity only and never grants payment authority.
- Browser storage: signed-in people hold no long-lived key in the browser; the short-lived Bind session lives in memory and refreshes. Only a pasted access key gets "remember this device", default tab-only.
- Demo: a throwaway sandbox, four hours, a demo banner on every page, a Reset button, no sign-in, limits per browser and address. "Make this yours" asks for sign-in and starts a fresh workspace.
- Staff join by a single-use, expiring invite link or QR, then sign in and join as staff. Email invitations come later when a provider exists.
- One person can belong to several workspaces, with a workspace switcher.
- Google and a wallet can be linked to one account in Settings, only after signing in with both in one session and an explicit confirm.
- Several owners per workspace, with the last owner always protected (as the API behaves today). An owner-plus-admins role is a later idea.
- First sign-in with no workspace: "Start a workspace" or "I have an invite link" (recommended; awaiting confirmation).

## First run (decided)
- First sign-in with no workspace: "Start a workspace" or "I have an invite link".
- Team setup: a gallery of ready-made teams (only the kitchen team is ready; others show "coming") plus a clear "start blank", with a "describe your business" box that only routes to a ready team or blank and labels what is ready. Generated suggestions are a later project.
- Setup asks two things (name, team). Limits and connections are asked the first time an agent needs one. A "Getting started" list stays on Today until done.
- After setup: Today with the starter list. No sample items in a real workspace (never fabricate activity); sample items exist only in the demo workspace, clearly labelled.

## Today and approvals (decided)
- A "Needs you" item: plain headline, why it is waiting, who asked and when, amount or effect, what happens if nothing is done (including expiry), a simulated or live label, an irreversible marker where it commits the business, and a tap through to details.
- Failures sit at the top of "Needs you", calm and specific, with a distinct Failed status and the next step beside them.
- "What is happening": a plain-language feed by default, with jobs in progress as a slim strip above it.
- Stale or offline: a quiet banner with "Refresh now". Data stays visible with its age. Server-dependent actions pause with a reason. Nothing shows as done before the server confirms.
- Approval panel (open, read, confirm) shows: the action in plain words; the amount against the limit and threshold; what was compared and why this was chosen; what happens next; what happens on reject; simulated or live; an irreversible marker; evidence and history behind "Show details"; the expiry; supplier and customer text as quoted, untrusted data; who can still change it and until when (for example revoke before submission); and a decision trail.
- Confirm step is tiered by amount: one deliberate tap for small items, press and hold over the owner's approval threshold, typing the amount for the largest. Settings may tighten it, never loosen it below one deliberate tap.
- Activity: a timeline by day with filters, and "Follow this" on any item opening its full history.

## Team, Connections and Business data (decided)
- Team: a card per agent (renamable name, one-line role, what it can do, per-tool switches, tap for detail). Limits are per workspace today (daily limit and approval threshold), so "Your team's limits" sits at the top as sentences with sliders plus Cautious, Balanced and Trusting presets that fill both numbers. The authority view is a plain list with the full matrix behind "See everything".
- Pause: always in the header, with one confirm. While paused the app's accent changes to a calm held state. Per-agent pause and per-agent budgets are not offered until the API has them.
- Connections: grouped by kind (tools and services, suppliers, messaging apps, other agents) with a health strip on top ("1 needs attention"). Adding is pick, guide, test, save; the page says the key is stored on the server and never shown again; Test runs a verifier where one exists and says so where none does. No catalogue of logos until connections exist.
- Connection status words: Simulated, Added not verified, Verified live, Needs attention, Revoked. "Verified live" appears only when a verifier succeeded.
- Business data: tabs named by the template (kitchen: Stock, Orders, Customers, Menu) plus a global search, with shared table, detail and empty-state design.

## Suggested, awaiting a yes
- Headline "Connect once. Get back to work." with a specific subline ("Bind connects your tools to agents that can actually use them, and you decide what they are allowed to do.").
- Main button: "Try a demo workspace" (simulated, labelled, throwaway, capped lifetime), secondary "Start your own workspace".
- How it works, three steps: connect once; decide what agents may do; get on with your work (see everything, step in for exceptions).
- App navigation: left sidebar on desktop that becomes a bottom tab bar on phones.
- App areas: Today, Activity, Team and limits, Connections, Business data (named by template: Stock, Orders, Bookings, Content), People and access, Settings, Help. Approvals live inside Today ("Needs you") and in each item, not as their own page. A pause-all-agents control is always visible in the header.
- Today: one focused column on phones; on desktop two columns (needs you | what is happening). No kanban lanes.

## Risks to keep honest
- Landing copy may be aspirational about breadth, but must not state a specific capability that does not exist. Where a team or connector is simulated or not yet available, the app says so (Connections page, labels).
- Email and messaging nudges need outbound providers that do not exist yet; Settings can show those channels as "coming" while in-app works.
- A demo workspace is a real workspace with a staff or owner token; abuse limits and expiry are required before it ships.

## References (to be extended by the owner)
- Stripe and Linear teardowns: <https://landingdoctors.com/teardowns>
- Stripe, Linear, Vercel design-rule reconstructions (third party): <https://opendesigner.io/it/blog/recreating-stripe-linear-vercel-design-systems-with-design-md>
- Cloudflare: owner-nominated, to be reviewed in the browser.
