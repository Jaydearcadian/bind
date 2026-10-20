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
