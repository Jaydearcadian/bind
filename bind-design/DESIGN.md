# Bind Design System and Experience Specification

**Status:** Implementation handoff  
**Product:** Bind  
**Program:** Tameion Agents Hackathon  
**Primary deliverable:** A polished marketing page with a working **Open app** action leading to a real in-app workflow page.  
**Audience:** Independent business owners and operators who need help coordinating routine operations without handing over business authority.  
**Visual reference:** The user-supplied long-page Superpower screenshot. Borrow its editorial pacing, confident photography, warm white space, orange action color, product-preview cards, and clear section rhythm. Do not copy its brand, exact compositions, copy, imagery, or health-specific content.

---

## 0. Chief brand direction: creative decisions are now explicit

This section is the short-form creative brief for the implementation team. The full strategic rationale, naming, character system, UX narrative, pitch direction, and reusable prompts live in [`BRAND_DIRECTION.md`](./BRAND_DIRECTION.md). If a visual decision is unclear, follow that file and the product-truth rules below.

### Brand in one sentence

**Bind brings coordinated AI agents into the way a real business already works, while the business keeps control of its context, permissions, money, and decisions.**

### Recommended tagline

**Your business runs on your rules.**

Supporting line: **Agents for the way business actually works.**

### Chosen creative direction

- **Positioning:** practical business coordination, not an agent marketplace, generic chatbot, crypto wallet, or settlement product.
- **Personality:** grounded, capable, warm, composed, clear, and quietly technical.
- **Visual language:** premium editorial photography, warm paper, deep ink/teal, restrained orange for action, precise typography, a small number of purposeful product previews.
- **Memorable motif:** three lines or soft bands joining into one clear path, representing business context, bounded authority, and real-world fulfilment. Do not use chain-link graphics or generic AI circuitry.
- **Human element:** show the owner/operator and the work they do. Avoid AI robots, glowing brains, anonymous neon people, and fake dashboard filler.
- **Product mark:** a restrained `bind` wordmark with a compact join glyph. Keep the glyph simple enough to work at favicon size. Do not add a mascot face to the logo.
- **Character/mascot policy:** no cartoon mascot in core operational UI. A secondary abstract “Join” character may appear in onboarding, empty states, slide illustrations, and social assets. It must never signal transaction success, approval, or fulfilment on its own.
- **Primary CTA:** `Open app` routes to `/app`. It is a real navigation action, not a decorative button.
- **Demo truth:** simulated supplier sourcing, seeded business data, Arc Testnet settlement, owner approval, and physical fulfilment must be distinguishable in visible copy and evidence.

### Brand decision hierarchy

When style and truth conflict, follow this order:

1. Correct business meaning and accurate workflow state.
2. Understandable task hierarchy and owner control.
3. Accessibility and responsive behavior.
4. Visual refinement and motion.

Do not add features, status labels, partner claims, metrics, testimonials, or decorative animation to make the page look more complete than the product is.

---

## 1. Product truth and design intent

Bind is a **business-side agent deployment and coordination layer**. It brings agents into real business operations, allowing a business to define its context, policies, and spending authority while agents coordinate repetitive work under those rules.

For this hackathon slice, the experience should make one workflow tangible: **a low-stock signal becomes a replenishment decision, a policy check, a possible Arc Testnet settlement, and a fulfilment record that remains open until a three-way match is complete.**

The experience must never imply that a testnet transaction proves a real supplier was paid in production, that a simulated supplier adapter is a live integration, or that settlement means goods have arrived. Show evidence and state honestly.

### Design principles

1. **Human business first.** Show real work, real operators, useful workflow context, and business outcomes. Do not use robot faces, floating AI brains, circuit-board gradients, or generic “AI magic” imagery.
2. **Calm authority.** The page should feel premium, warm, and confident. Keep layouts spacious and let strong headings, photography, and product evidence do the work.
3. **One obvious next step.** Marketing page primary CTA is `Open app`. In the app, the primary action depends on the actual workflow state, such as `Review approval`, `Run low-stock check`, or `View evidence`.
4. **Evidence over claims.** Mark simulated adapters, testnet state, owner approvals, and fulfilment status explicitly. Never use decorative success states that contradict the persisted workflow record.
5. **Progressive disclosure.** Explain the business value at the landing-page level. Put policy details, transaction hashes, contract links, decision hashes, and reconciliation detail inside the app’s evidence view.
6. **Built for the narrow demo, extensible by design.** Implement a credible kitchen/supplies workflow now. Do not create empty pages for a future marketplace, agent directory, or multi-industry console.

---

## 2. Art direction from the visual reference

### What to preserve from the reference

- A single cinematic hero with a human subject and short, high-confidence headline.
- Warm white and pale neutral backgrounds for most of the page.
- Generous vertical spacing between story sections.
- A strong warm-orange CTA that is visually unmistakable.
- UI panels layered over photography or open space to preview the actual product.
- Alternation between editorial image sections, concise product explanations, and tangible interface previews.
- A distinct closing section and considered footer rather than an abrupt end.

### What to change for Bind

- Use real small-business settings: a kitchen, stockroom, café counter, supplier delivery, or operator checking incoming stock. Use licensed photography or project-owned visuals.
- Replace health stats, symptom lists, memberships, and clinician testimonials with an honest operations workflow, permission gates, audit evidence, and fulfilment states.
- Never invent business adoption statistics, performance claims, customer logos, testimonials, or financial outcomes.
- Use actual screenshots from Bind when available. Until then, build faithful UI mockups from real workflow states and label any fixture data as demo data.
- The marketing site should look editorial and human. The in-app page should become a practical operations tool: denser, clearer, more structured, still visually related.

### Visual mood words

**Human, grounded, editorial, precise, trustworthy, tactile, warm, quietly technical.**

Avoid: neon, cyberpunk, casino styling, oversized glassmorphism, loud gradients, dashboard-card overload, fake terminal screens, animated coins, robot imagery, or a stock-photo wall.

---

## 3. Brand system

### Color tokens

Use these as the initial implementation tokens. If contrast testing or visual verification shows a failure, adjust the token rather than adding one-off colors to components.

| Token | Hex | Purpose |
|---|---|---|
| `--bind-ink` | `#17211F` | Primary text, dark sections, app navigation |
| `--bind-ink-soft` | `#263430` | Secondary dark surface and hover surface |
| `--bind-teal` | `#174A4A` | Deep brand tone, selected navigation, dark hero overlay |
| `--bind-teal-pale` | `#E5EFEB` | Soft supporting panels and workflow context |
| `--bind-paper` | `#FAF8F4` | Main warm-white page background |
| `--bind-white` | `#FFFFFF` | Cards, forms, and app content surfaces |
| `--bind-text-muted` | `#626C67` | Secondary text, only after contrast check |
| `--bind-border` | `#E6E4DD` | Dividers, input borders, card borders |
| `--bind-orange` | `#F45B36` | Primary CTA and important active emphasis |
| `--bind-orange-hover` | `#D94A29` | CTA hover/pressed state |
| `--bind-orange-pale` | `#FCEAE3` | Light orange callout background |
| `--bind-success` | `#24734E` | Confirmed success state, paired with text/icon |
| `--bind-warning` | `#95540E` | Waiting/approval-required state, paired with text/icon |
| `--bind-danger` | `#B42318` | Failed/blocked state, paired with text/icon |

**Rules:**

- Paper and white are the default. Dark ink/teal is used for the hero, a few emphasis sections, and the app’s navigation/identity zone.
- Orange is an action color, not a general decorative color. Do not use it for every icon or every card edge.
- Status must never be communicated by color alone. Pair each status color with a plain-language label and, where useful, a Heroicon.
- Verify actual text/background pairs against WCAG 2.2 AA contrast. Do not assume the listed palette automatically passes for every font size and opacity.
- Use OKLCH internally only if supported by the current project’s CSS architecture; preserve a sensible hex fallback or tested build output when required.

### Typography

Use **Manrope** for headings and **Inter** for body/UI text if available through the existing project’s font pipeline. Otherwise use the closest installed geometric sans-serif and keep one primary UI family. Do not block the build on a new font service.

| Style | Desktop target | Mobile target | Weight / line-height |
|---|---:|---:|---|
| Display / hero | `clamp(2.75rem, 5vw, 5.25rem)` | `2.65–3.25rem` | 600–700 / 0.98–1.08 |
| H1 | `3.25–4.5rem` | `2.5–3rem` | 650 / 1.05 |
| H2 | `2.25–3rem` | `1.85–2.25rem` | 600 / 1.12 |
| H3 | `1.25–1.5rem` | `1.2–1.35rem` | 600 / 1.25 |
| Body large | `1.125rem` | `1.05rem` | 400–500 / 1.55 |
| Body | `1rem` | `0.95–1rem` | 400 / 1.55 |
| Label / eyebrow | `0.75–0.875rem` | same | 600–700 / 1.3, slight tracking |
| Metadata | `0.8125–0.875rem` | same | 400–500 / 1.4 |

Keep marketing copy short and specific. Prefer a short two-line headline to a centered paragraph wall. Avoid uppercase body copy. Avoid ultra-light type for operational data.

### Layout and spacing

- Main content max-width: `1200px` (allow up to `1280px` for app tables or evidence panels only when content benefits).
- Marketing gutters: `clamp(1rem, 4vw, 3.5rem)`.
- App desktop layout: `240px` navigation rail plus flexible content; collapse to drawer or bottom navigation at small widths.
- Use a 12-column desktop grid, 8-column tablet grid, and 4-column mobile grid where the existing codebase supports explicit grids.
- Spacing scale: `4, 8, 12, 16, 24, 32, 48, 64, 80, 112px`.
- Section spacing: `96–128px` desktop, `64–80px` tablet, `48–64px` mobile. Tighten if a section’s content is short; do not pad for padding’s sake.
- Card radius: `14–18px`; large media/feature panel radius: `18–24px`; input/button radius: `10–12px`; pill controls are allowed for main CTAs and small status chips.
- Shadows should be soft and rare. Prefer borders and surface contrast over a stack of floating cards.

### Surface treatment

- Main surfaces: warm paper, pure white cards, subtle 1px neutral border.
- Use blur only for a small overlay on photography where the text remains legible; do not build the whole UI out of frosted glass.
- Use small tonal blocks to group information rather than gradients on every panel.
- Photos should have an intentional crop and natural lighting. A teal/ink overlay can support white hero text. Never make text depend on the brightest part of an image.

---

## 4. Site architecture and routes

### Required routes

- `/` — marketing landing page.
- `/app` — in-app overview / demo workspace entry.
- `/app/workflows/:workflowId` — a selected workflow detail with timeline and evidence. If the current router is static or simpler, use an equivalent stable route/query pattern while ensuring browser back/forward works.

### Open app behavior

The header’s **Open app** CTA must navigate to `/app` using a real route/link. It must not be a dead button, modal with no next step, anchor to a page section, external explorer link, or connect-wallet screen without context.

If the app is not authenticated in this hackathon slice, open a clearly labelled demo workspace seeded from persisted demo records. If authentication is part of the current repository, preserve it but return the user to the intended app route after sign-in. Never render a blank or fake login page as the only result.

On `/app`, show a small environment badge such as `Arc Testnet` only when the active configuration confirms it. Clearly mark seeded information as `Demo workspace` or `Demo data`. Keep links back to the marketing page unobtrusive, e.g. a Bind mark or `Back to site` in the app shell.

### Navigation

**Marketing navigation:**
- Bind wordmark
- How it works
- Authority and evidence
- Open app (primary action)

Avoid a large navigation bar with every potential product module.

**App navigation:**
- Overview
- Workflows
- Approvals (only if approval workflow exists and is actionable)
- Evidence
- Business setup (only if the settings are implemented; otherwise expose as a limited section in the workflow, not a dead destination)

Show the active item clearly. Do not add empty navigation destinations just to imply product breadth.

---

## 5. Landing page content and composition

Design the homepage as one deliberate narrative. Reuse the same header, type scale, button styles, and card language throughout.

### Section 1: Header

- Wordmark at left, no huge logo lockup in the nav.
- Small set of anchor links; use no more than three.
- Right-aligned orange `Open app` pill/button.
- Sticky behavior is optional. If sticky, reduce its background noise and ensure it does not obscure anchor headings or keyboard focus.
- At mobile widths, collapse navigation to a menu and keep `Open app` visible when space allows.

### Section 2: Cinematic hero

**Eyebrow:** `BUSINESS OPERATIONS, WITH YOU IN CONTROL`  
**Headline option:** `Your business runs on your rules.`  
**Supporting line:** `Bind coordinates AI agents around the way your business actually works, with clear limits and a record of every important action.`  
**Primary CTA:** `Open app`  
**Secondary CTA:** `See how it works` (scrolls to the workflow explanation).

Composition:

- Wide, cinematic photo showing a real operator in a small business environment. Subject sits off-center so copy can breathe.
- Dark teal/ink gradient overlay from the text side into the photo, carefully tuned for contrast.
- Hero content sits toward the left on desktop, centered or left-aligned within a narrow column on mobile.
- A single product evidence card may overlap the image edge: `Low stock detected`, `Policy checked`, or `Owner approval required`, depending on actual fixture/live state. It must be visually obvious that it is a workflow UI card, not a floating AI assistant.
- Keep hero headline under about 10 words. No animated typewriter effect.

### Section 3: The Bind model

**Heading:** `Context. Authority. Fulfilment.`  
**Supporting line:** `Agents need more than instructions. They need business context, bounded permissions, and a clear way to confirm what happened.`

Use three connected columns or three calm panels:

1. **Business context** — products, suppliers, budgets, preferences, and operating rules.
2. **Bounded authority** — policy checks, spending limits, allowlists, and owner approval where required.
3. **Real-world fulfilment** — quotes and orders tracked separately from on-chain settlement, with goods receipt verified before completion.

Use a very light connector line on desktop and a vertical sequence on mobile. Do not imply that these are three separate apps or tokens.

### Section 4: Product preview / replenishment workflow

**Heading:** `From low stock to a decision.`

Show an actual or faithfully reproduced product panel with an ordered workflow:

1. A stock threshold is crossed.
2. A quote request is initiated.
3. Business policy evaluates vendor and spending authority.
4. The workflow is approved or held for owner review.
5. If the permitted path is executed, the app records Arc Testnet settlement evidence.
6. Physical fulfilment remains pending until a three-way match is complete.

Use real timestamps and persisted states when bound to the backend. If the preview uses fixtures, mark it `Demo workflow`.

Composition options: large screenshot/panel on one side with concise explanatory copy on the other, then alternate on the next section. Keep the visible product as a single cohesive panel, not six unrelated dashboard cards.

### Section 5: Business-role cards

**Heading:** `Let agents handle the repeatable work.`

Use up to three cards only if those roles are represented in the implementation or clearly labelled as the product direction:

- **Supplies:** watch stock levels and prepare replenishment requests.
- **Operations:** coordinate workflow steps and surface exceptions.
- **Owner control:** review anything that exceeds the business’s configured authority.

For the hackathon slice, label unimplemented role breadth as `Designed to extend` or omit it. Do not present an aspirational roadmap as live functionality.

### Section 6: Evidence and trust

**Heading:** `Every important action leaves a trail.`

Use a clean evidence preview with these concepts:

- Decision hash
- Policy evaluation result
- Contract address link
- Arc Testnet transaction link, if present and verified in the workflow record
- Supplier adapter label, such as `SIMULATED_SUPPLIER_ADAPTER`, when applicable
- Settlement lifecycle label, such as `SETTLED_ON_ARC_TESTNET`
- Fulfilment label, such as `NOT_FULFILLED_AWAITING_3WAY_MATCH`

Provide readable status text and copyable hashes. Use icons to support meaning, not replace labels. Avoid giant cryptographic visuals or pseudo-blockchain animations.

### Section 7: Final CTA

A warm paper, pale blush, or deep teal closing section. Keep the ask simple:

**Heading:** `Keep the business in control.`  
**Copy:** `Start with one workflow. Set the rules. See every decision.`  
**CTA:** `Open app`

### Footer

- Bind wordmark and one-line value statement.
- Links to app, how it works, and relevant repository or technical evidence where appropriate.
- Do not invent terms, privacy pages, social accounts, partner logos, or contact details.
- The Tameion/Circle/Arc affiliation may only be shown using correct approved branding and wording; do not imply official endorsement.

---

## 6. In-app page: `/app`

The in-app page is not a marketing page shrunk down. It is a clear, calm operations workspace. It must open successfully from the landing page and show a useful, intelligible state immediately.

### Main app frame

Desktop:

- Left rail: Bind wordmark, workspace label, primary navigation, environment marker near the bottom.
- Main header: `Kitchen Operations` or actual business name, workflow context, current environment badge, user/workspace menu if supported.
- Content canvas: `Overview`, open workflow, approvals, and recent activity arranged by importance rather than arbitrary card count.

Mobile:

- Compact top bar and a menu/drawer or bottom navigation, whichever best fits the current implementation.
- Stack panels into a single column; never force the user to scroll horizontally to understand workflow status.
- Workflow timeline becomes a vertical step list. Evidence opens a full-screen sheet or dedicated detail section.
- Keep high-priority action controls thumb-reachable and avoid sticky UI that covers the last item.

### Overview hierarchy

1. **Page heading:** `Kitchen Operations` with a small `Demo workspace` tag if seeded.
2. **Top-level situation:** a concise sentence summarizing the current workflow state, e.g. `One replenishment workflow is awaiting review.` The sentence must derive from current persisted state.
3. **Primary active workflow:** low-stock item, estimated/requested amount, adapter source, current status, next step.
4. **Decision and authority panel:** vendor allowlist result, spending-limit result, owner-approval requirement. Hide technical detail behind `View policy evidence` if it is not the operator’s immediate task.
5. **Activity/evidence panel:** chronological events, decision hash, contract link, transaction link when present, and clear distinction between settlement and goods received.
6. **Recent workflows:** optional and only if it helps navigate real workflow records; no fake chart cards or invented KPI totals.

### Workflow state design

Render the workflow as a timeline with both a label and a status for every stage. A stage may be `Complete`, `In progress`, `Needs approval`, `Blocked`, or `Waiting for fulfilment`. Do not style a waiting state like success.

Canonical lifecycle concepts:

- `LOW_STOCK_DETECTED`
- `RFQ_INITIATED`
- `POLICY_EVALUATED`
- `AWAITING_OWNER_APPROVAL` (when required)
- `SETTLED_ON_ARC_TESTNET` (only when supported by the verified transaction record)
- `AWAITING_3WAY_MATCH`
- `FULFILLED` (only when the required three-way match is satisfied)
- `BLOCKED` / `FAILED` (when the persisted workflow indicates it)

Use human-readable labels in the interface while retaining canonical codes in the evidence panel.

### Primary workflow card content

Include:

- Item / supply name and low-stock reason
- Reorder quantity and expected cost, when defined by actual business data
- Counterparty and source attribution
- Policy decision: allowed, held, or denied, with a direct explanation
- Next permitted action and its authority requirement
- Event timeline link and decision hash
- Settlement status and transaction link only if the stored transaction is present
- Fulfilment state, separate from payment state

Never invent a cost, quantity, supplier response, transaction, contract outcome, or fulfilment confirmation just to fill empty space. A missing value should be omitted or labelled `Not configured`.

### Action behavior

- `Run low-stock check` must call the implemented workflow and surface success/failure from the real result. Disable while in flight, show a clear loading state, and prevent accidental duplicate submissions.
- `Review approval` opens the actual approval/decision path. If no approval is available, do not render it as an enabled button.
- `View evidence` opens the evidence drawer or detail route with copyable hashes and explorer links.
- `Copy decision hash` must copy the actual value, give confirmation, and handle clipboard failure.
- `Open Arcscan` opens a verified transaction or contract URL in a new tab and must use the record’s actual chain/environment.
- For destructive or irreversible actions, explain what will happen and require explicit user confirmation. Do not make irreversible actions happen on hover, page load, or scroll.

### Evidence drawer / detail view

Title: `Workflow evidence` or `Decision evidence`.

Group information into:

1. **Decision**: decision hash, timestamp, result, canonical rule/version.
2. **Authority**: vendor whitelist result, spending limit result, approval record.
3. **On-chain**: network, chain ID, contract address, transaction hash, transaction link, confirmation status. Omit or label fields unavailable in the record.
4. **Supplier source**: exact adapter/source attribution (simulated vs live).
5. **Fulfilment**: three-way match components and which ones are still outstanding.

Copyable text should be selectable on mobile and desktop. Long hashes wrap or have a copy control without widening the page. A screen reader should receive a meaningful label when copy succeeds or fails.

---

## 7. Motion direction and detailed choreography

### Motion personality

**Editorial precision, not spectacle.** Motion should make the page feel considered, help users understand sequence, and make workflow state changes legible. It should not be used to hide missing functionality or delay access to content.

### Global motion tokens

| Token | Duration | Easing | Use |
|---|---:|---|---|
| `--motion-fast` | `140ms` | `cubic-bezier(0.2, 0, 0, 1)` | Button, icon, focus-adjacent decoration |
| `--motion-ui` | `200ms` | `cubic-bezier(0.2, 0, 0, 1)` | Dropdown, popover, tab/panel change |
| `--motion-panel` | `240ms` | `cubic-bezier(0.22, 1, 0.36, 1)` | Drawer, dialog, route transition |
| `--motion-reveal` | `480ms` | `cubic-bezier(0.22, 1, 0.36, 1)` | Major image/text sections entering view |
| `--motion-state` | `260ms` | `cubic-bezier(0.2, 0, 0, 1)` | Workflow status/step changes |
| `--motion-stagger` | `60–90ms` | n/a | Children in a short choreographed group |

Use transform and opacity for most movement. Do not animate layout dimensions, shadows, large blur fields, or high-cost effects every frame. These are starting values, not a reason to animate components that do not need it.

### Landing page entrance sequence

At initial load, stage the hero deliberately:

1. Header becomes visible immediately or fades in over `160ms`. Do not hold navigation back.
2. Hero eyebrow fades in, duration `320ms`, delay `40ms`.
3. Headline fades in and translates from `y = 12px` to `0`, duration `500ms`, delay `80ms`.
4. Supporting copy follows after `70ms`, duration `400ms`.
5. CTA group follows after `70ms`, duration `360ms`.
6. Evidence preview card enters from `y = 10px`, duration `420ms`, delay `100ms` after the CTA begins.

The entire sequence should be calm and complete in roughly `800–1000ms`. Do not animate every word independently. Do not type out the headline character-by-character.

### Scroll choreography

Use section-level reveals triggered when each section enters the viewport, once per page visit:

- Section heading first.
- Supporting copy next, `60ms` after the heading.
- Visual/product panel next, `80ms` after the copy.
- Cards in a small group stagger by `60–80ms`, capped at three or four visible child animations.
- Translation distance: `12–18px` maximum. Opacity and small translation are sufficient.
- Duration: `420–520ms`.
- Do not leave content at opacity zero if observer initialization fails. Content must be visible without JavaScript and remain readable if motion does not execute.
- Do not trigger a new animation every time the user scrolls a few pixels up and down.

### Hero image behavior

- Optional background parallax: maximum `6–10px` offset on wide screens, driven by low-frequency scroll position; no aggressive depth effects.
- Foreground text and CTA must not drift independently enough to impair reading.
- Do not require a looping video. Use a strong static image first; video is optional only if it improves the story and has a poster/fallback.
- If a subtle ambient card drift is used, keep it under `4px`, use a long cycle of at least `6s`, and disable it for reduced-motion users. Prefer no continuous loop if the hero already has layered visual depth.

### CTA and card interaction

- Button hover: lift `1px` and slightly deepen background/shadow over `140–180ms`.
- Button pressed: return to baseline and use a restrained pressed shade; no bounce.
- Card hover: maximum `translateY(-2px)` over `180ms` when the card is genuinely interactive. Static cards do not need hover movement.
- Links: color transition over `140ms`, with a visible underline or other non-color cue where appropriate.
- Focus appearance must remain immediate and high-contrast. Do not hide focus while an animation runs.

### Open app transition

When the user activates `Open app`:

1. Navigate to `/app` immediately; do not add an artificial interstitial.
2. If the framework supports a stable route transition, crossfade the app shell over `160–220ms` and translate the main content by no more than `8px`.
3. Keep the route change, heading, and workspace context accessible with keyboard and screen reader. Move focus to the new page heading when appropriate to the router implementation.
4. App data can load independently. Do not block route navigation on optional imagery or nonessential analytics.

### App workflow state motion

When a workflow stage changes:

- Update the text/status as soon as the persisted result is available.
- Crossfade the changed status chip over `160–220ms`.
- Animate the timeline’s newly completed icon using a short opacity/stroke reveal of `220–300ms` if practical. A simple check icon swap is acceptable.
- Newly appended activity entries enter from `y = 6px`, duration `220–280ms`.
- An approval-required or blocked state may use a brief attention cue once, such as a subtle border/color transition. Do not shake, pulse indefinitely, or flash.
- Settlement should use a restrained confirmation, not confetti, coins, a full-screen green flash, or a false implication of physical delivery.
- After settlement, keep fulfilment visibly pending until the real matching evidence is present.

### Evidence drawer / responsive detail transition

- Desktop right-side evidence drawer: slide `12px` from the right and fade in over `220–260ms`, with a dim backdrop appearing over `160ms`.
- Mobile evidence view: bottom sheet or full-screen detail fades/slides in over `220–260ms`; ensure the focused content is in view and the background cannot be accidentally activated.
- Closing restores focus to the invoking control.
- If the user prefers reduced motion, replace slide/scale transitions with immediate state changes or a short opacity transition of `100ms` or less.

### Loading, success, error

- Loading: use a static skeleton or modest opacity pulse on one surface; avoid high-contrast shimmer moving forever.
- Success: show the actual status label, an icon, and optional short confirmation. Do not depend on animation to communicate completion.
- Failure: explain what failed and what the user can do next. Do not shake the whole card; focus the error summary if the action failed after submission.
- Pending/held: use a calm amber/neutral style with a clear reason and next action.
- Long-running work: show a progress/status message if the backend can report real steps. Never fake a progress percentage for an operation whose progress is unknown.

### Reduced motion and accessibility

- Implement `prefers-reduced-motion: reduce`. Remove parallax, perpetual drift, large translations, and nonessential stagger. Content must not disappear when motion is off.
- Motion cannot be the only indication of active, completed, blocked, or selected state.
- Respect keyboard interaction and focus order even with drawers, menus, and transitions.
- Avoid flashing or large full-screen motion. Honor the browser/system preference from first paint where possible.
- Test on a mid-range mobile device. Animation should not cause visible scroll jank or delay tapping the primary CTA.

---

## 8. Heroicons policy

Use **Heroicons** as the sole UI icon family: <https://heroicons.com/>.

- Prefer **Outline** icons at `20–24px` with consistent stroke and visual weight for navigation, supporting actions, and neutral workflow steps.
- Use **Solid** icons selectively for filled active navigation or compact status emphasis. Do not mix three icon families.
- When the repository already uses React, prefer `@heroicons/react` and the version consistent with its dependency tree. In a vanilla HTML/JS project, inline the official Heroicons SVG assets or use project-owned SVG files sourced from Heroicons. Do not add a new UI framework just for icons.
- Keep icons decorative when the adjacent label already communicates the action (`aria-hidden="true"`). Icon-only controls need accessible names and a visible focus state.
- Do not use emoji as UI icons. Do not use the doodle icons from the wireframer skill in the production UI.

### Suggested icon mapping

| Purpose | Heroicons icon | Notes |
|---|---|---|
| Workspace / business | `building-storefront` | App/workspace identity |
| Overview | `squares-2x2` | Navigation |
| Workflow / tasks | `clipboard-document-list` | Workflow list |
| Evidence / audit | `document-magnifying-glass` | Evidence detail; confirm availability in selected Heroicons package version |
| Policy / authority | `shield-check` | Policy decision, paired with textual result |
| Approval / completed check | `check-circle` | Use only for actual success/approval |
| Attention / waiting | `clock` | Pending state, paired with label |
| Budget / money | `wallet` or `banknotes` | Monetary context; do not imply custody by icon alone |
| Supplier / delivery | `truck` | Purchase/physical fulfilment |
| Configuration | `cog-6-tooth` | Settings, only if settings exist |
| External explorer link | `arrow-top-right-on-square` | Opens an external Arcscan page |
| Copy hash | `document-duplicate` | Copy action, with a text label or tooltip |
| Expand / navigate | `chevron-right` | Avoid using it as decoration without a destination |
| Error / blocked | `exclamation-triangle` or `x-circle` | Pair with a reason; never just red icon |

Icon names vary by package version. Confirm every selected icon exists in the installed Heroicons version; if one is unavailable, choose the closest current Heroicon rather than drawing a fake match.

---

## 9. Accessibility and inclusive interaction requirements

Apply accessibility during design, not as a last-minute audit.

- Meet WCAG 2.2 AA for text contrast, focus appearance, keyboard operability, labels, and non-text controls.
- Every page has one clear H1, sequential headings, semantic landmarks, useful link text, and predictable tab order.
- All actions can be performed with keyboard. Focus must be visible, not clipped, and not hidden under sticky headers or drawers.
- Main CTA hit target should be at least `44 × 44px`; meet WCAG minimum target-size requirements and increase targets where practical.
- Forms have persistent visible labels, help text for non-obvious requirements, validation near the affected field, and a summary for multiple errors.
- Error messages use plain language and say how to recover. Preserve entered values after recoverable errors.
- Use status text such as `Awaiting owner approval`, not just a yellow dot. Announce asynchronous action results to assistive technology through an appropriate live region without over-announcing every timeline item.
- Provide accessible names for icon-only controls; keep decorative icons hidden from the accessibility tree.
- Ensure mobile layouts work at 320px viewport width and with text zoom. Test long addresses/hashes, not only ideal content.
- Meaningful images need concise alt text. Decorative backgrounds should use empty alt text or CSS backgrounds. Do not use alt text to repeat the full nearby paragraph.
- Never autoplay sound. Video requires captions/transcript where relevant and a pause mechanism.
- Test `prefers-reduced-motion` and high contrast/forced-colors behavior where supported.
- The workflow must distinguish `settled` from `fulfilled` in both text and accessible structure.

---

## 10. Responsive behavior contract

Design mobile-first, then define the intended behavior at each range. Do not treat responsiveness as merely reducing font size.

### Breakpoint starting points

Use project-standard breakpoints if already established. Otherwise start with:

- Small: `< 480px`
- Mobile/large phone: `480–767px`
- Tablet: `768–1023px`
- Desktop: `1024–1279px`
- Wide desktop: `≥ 1280px`

Prefer content-driven grid changes and container queries where supported rather than rigid device assumptions.

### Required behavior by component

| Component | Desktop | Tablet | Mobile |
|---|---|---|---|
| Marketing header | Inline links + Open app | Compact links if space permits | Menu/drawer, keep Open app easy to reach |
| Hero | Wide image with text left and optional preview card | Reduce media height and overlap | Stacked text + image; remove overlap that reduces legibility |
| Three-part model | 3 columns | 2 + 1 or compact row | Vertical sequence |
| Workflow preview | Split text and detailed UI | Narrow split or stacked | Text first; simplify preview; no horizontal scrolling |
| Evidence panel | Right drawer/side panel | Drawer with narrower content | Full-screen view or bottom sheet |
| App navigation | Persistent left rail | Collapsible rail | Drawer or bottom nav |
| Workflow timeline | Timeline alongside evidence | Stacked panels | Vertical timeline with short labels |
| Tables/long hashes | Columns and truncation/copy controls | Hide lower-priority columns behind detail | Convert to labelled rows; allow copy/wrap |
| CTA | Inline primary/secondary | Inline if fits | Stacked or full-width when needed |

### Container and scroll rules

- Marketing content uses a centered max-width container and fluid gutters.
- The app should scroll naturally as one document unless there is a specific reason to isolate a table/log region. Avoid nested scroll containers that trap touch gestures.
- Keep sticky header/sidebar interactions from fighting with each other. Only one primary region should be sticky at a time on mobile.
- Long workflow evidence must wrap, collapse, or move into details; never widen the entire app for a long hash.
- A card can change structure between breakpoints. Do not force a three-column desktop card layout into narrow mobile by shrinking each column.
- Avoid hover-only affordances. Any action visible on hover must also be reachable by focus and touch.

### Required viewport review

Inspect screenshots or live browser previews at `320`, `375`, `430`, `768`, `1024`, `1280`, and `1440` CSS px wide. At minimum validate 375px mobile, tablet around 768px, and desktop 1440px before submission. Check both homepage and `/app`, including open evidence drawer and workflow state variants.

---

## 11. Sequential skill workflow: use the repositories in this exact order

The ten repositories below form a gated design sequence. Work through one stage at a time and produce its artifact before advancing. A later stage may refine an earlier artifact, but it must not silently override product truth or accessibility constraints.

### 1. Motion direction — `LottieFiles/motion-design-skill`

Repository: <https://github.com/LottieFiles/motion-design-skill>

**Purpose:** Decide the intent and choreography before implementing animation.

**Actions:**
- Adopt the motion personality and motion tokens in Section 7.
- Map each animation to a job: direct attention, show sequence, communicate state, or indicate response.
- Remove animation that is purely decorative or increases reading time.
- Define reduced-motion equivalents before coding.

**Deliverable:** `motion-map.md` or a reviewed version of Section 7.

**Gate:** Every proposed motion has a purpose, duration, easing, trigger, and reduced-motion behavior. Only then proceed.

### 2. Inclusive design — `Owl-Listener/inclusive-design-skills`

Repository: <https://github.com/Owl-Listener/inclusive-design-skills>

**Purpose:** Design accessible tasks, understandable copy, adaptive behavior, and forgiving failure flows from the start.

**Actions:**
- Walk through Open app, run low-stock check, review approval, copy hash, and open Arcscan using keyboard and touch.
- Rewrite vague labels into plain language.
- Specify empty, waiting, blocked, failed, and success states.
- Check focus order, focus restoration, text zoom, and reduced motion.

**Deliverable:** Accessibility and inclusive-flow checklist tied to actual screens.

**Gate:** No core action has only an icon/hover cue; all workflow states have readable status and recovery instructions.

### 3. Low-fidelity wireframes — `agilek/wireframer-skill`

Repository: <https://github.com/agilek/wireframer-skill>

**Purpose:** Set information hierarchy and task flow before decorating the UI.

**Actions:**
- Wireframe the landing page, the `/app` overview, workflow detail, and evidence drawer.
- Mark primary/secondary action hierarchy and real route links.
- Verify there is a direct path from marketing page to a useful in-app state.
- Keep the sketch wireframes disposable; do not ship the wireframer’s hand-drawn visual style.

**Deliverable:** Low-fidelity screen set plus a list of route transitions.

**Gate:** A reviewer can complete the intended demonstration from homepage to workflow evidence without guessing where to click.

### 4. Icon and application identity — `anhao/icon-generator-skill`

Repository: <https://github.com/anhao/icon-generator-skill>

**Purpose:** Define a consistent Bind application icon asset if the app needs installable/PWA/launcher assets.

**Actions:**
- Create or refine a simple, scalable Bind mark only if a real product mark already exists or can be specified without inventing brand history.
- If producing PWA/mobile assets, generate the required sizes and manifest assets from one master source.
- For normal navigation and workflow icons, ignore the skill’s icon-generation output and use Heroicons per Section 8.

**Deliverable:** Optional app icon source and generated size set; otherwise record `not required for this web-only slice`.

**Gate:** App identity remains legible at small sizes and does not introduce a second icon style into the UI.

### 5. Color validation — `meodai/skill.color-expert`

Repository: <https://github.com/meodai/skill.color-expert>

**Purpose:** Refine the palette through color science and measurable contrast, not intuition alone.

**Actions:**
- Validate foreground/background pairs for body text, headings, button labels, focus rings, status chips, and disabled states.
- Keep orange reserved for primary actions and meaningful emphasis.
- Check color appearance on warm-white surfaces and dark-teal surfaces.
- Adjust tokens globally when a contrast pair fails; do not patch each individual component with an arbitrary color.

**Deliverable:** Reviewed token table with contrast notes.

**Gate:** All critical text/status pairs meet the required contrast and are not dependent on hue alone.

### 6. Product-wide design review — `Owl-Listener/designer-skills`

Repository: <https://github.com/Owl-Listener/designer-skills>

**Purpose:** Align research, UX strategy, design system, interaction design, and delivery into one product language.

**Actions:**
- Review the one-workflow demo against Bind’s established product definition.
- Check narrative order, content hierarchy, repeated components, tokens, and interaction consistency.
- Remove visual filler and aspirational features that the backend does not implement.
- Ensure marketing content and the in-app product show the same lifecycle states and source attributions.

**Deliverable:** Design system review checklist and any corrections to this `DESIGN.md`.

**Gate:** Product truth, page hierarchy, and core component rules agree across both site and app.

### 7. Production UI architecture — `kozz36/frontend-designer-skill`

Repository: <https://github.com/kozz36/frontend-designer-skill>

**Purpose:** Translate the design into maintainable UI code, tokens, component boundaries, and responsive behaviors.

**Actions:**
- Inspect the repository’s current framework and CSS architecture before making changes.
- Implement design tokens, type scale, spacing, surface styles, components, focus/hover/disabled states, and reduced-motion rules.
- Use CSS layers or equivalent component architecture if appropriate to the current stack.
- Prefer container-query-friendly patterns when components need to respond to their own container.
- Do not replace the application stack or install a new UI system without a real need.

**Deliverable:** Working components and CSS/design tokens aligned to this file.

**Gate:** No duplicate token systems, hard-coded one-off styles, or app-wide CSS regressions. Existing functional workflow logic remains intact.

### 8. Flow and state mapping — `ThomasPraun/ux-flow-designer`

Repository: <https://github.com/ThomasPraun/ux-flow-designer>

**Purpose:** Make routes, use cases, and state transitions explicit.

**Actions:**
- Produce a small screen map for `/`, `/app`, workflow detail, and evidence.
- Map the low-stock-to-reconciliation journey, including approval, blocked, failure, and retry paths supported by the backend.
- Verify browser back/forward behavior and the path from each CTA.
- Keep a single canonical representation of the lifecycle states.

**Deliverable:** `docs/ux-flow.md` with screen map, task flow, and workflow-state diagram.

**Gate:** Every visible action has a valid destination or state transition, and no state is labelled more optimistically than backend evidence supports.

### 9. Source-aware brand specification — `shaom/brand-to-design-md-skill`

Repository: <https://github.com/shaom/brand-to-design-md-skill>

**Purpose:** Produce and maintain a clear design handoff informed by actual visual evidence.

**Actions:**
- Treat the user-supplied screenshot as a visual reference for composition rhythm and tone only.
- Record which decisions are inferred from that reference and which are Bind-specific choices.
- Compare this file with the implemented page and fix drift between documented tokens/components and the actual UI.
- Do not scrape/claim a Bind brand system from an unrelated health brand. Do not transfer its logo, text, or distinctive assets.

**Deliverable:** This `DESIGN.md`, kept source-aware and updated to match implementation.

**Gate:** The design document accurately describes the shipped page and explicitly records product-specific decisions rather than presenting guesses as extracted brand facts.

### 10. Responsive review — `kylezantos/responsive-craft`

Repository: <https://github.com/kylezantos/responsive-craft>

**Purpose:** Validate layout behavior deliberately across real in-between sizes and operational page states.

**Actions:**
- Audit desktop, tablet, mobile, and narrow mobile sizes.
- Check navigation collapse, hero image/copy order, workflow cards, evidence drawer, hashes, tables, sticky regions, and touch targets.
- Test long text, no data, loading, error, approval-required, settled-awaiting-fulfilment, and completed states.
- Fix structural issues rather than hiding overflow or shrinking text until it fits.

**Deliverable:** Responsive QA notes or screenshots for key widths and states.

**Gate:** No horizontal page overflow, clipped primary actions, inaccessible drawer, illegible hashes, or mobile navigation traps.

### Overall rule for the sequence

Do not claim that a repository skill was installed or executed merely because its README was reviewed. This section defines the ordered design workflow and the expected outputs. Install/run each skill in the active agent environment when available, inspect the produced artifact, and record actual results. Preserve its license and follow its installation instructions.

---

## 12. Motion and interface implementation checklist

- [ ] `Open app` is a real link to `/app` from both header and closing CTA.
- [ ] Hero animation completes within about one second and does not block navigation.
- [ ] Scroll reveals run once, have no dependency for content visibility, and are disabled/attenuated under reduced motion.
- [ ] App route transition is short and never delays data interaction.
- [ ] Workflow status is updated only from the real workflow result.
- [ ] Settlement and fulfilment are visually and textually distinct.
- [ ] Copy-hash confirmation works with screen readers and clipboard failure is handled.
- [ ] Drawer/dialog focus is trapped where appropriate and restored on close.
- [ ] Loading, pending, error, blocked, and success states do not depend on animation alone.
- [ ] All interactions work by keyboard, touch, and pointer.
- [ ] No excessive continuous animation, unnecessary parallax, or layout-jumping transitions.

---

## 13. Implementation acceptance criteria

The design is acceptable when all of the following are true:

1. The landing page communicates Bind’s business-side coordination proposition within the first screen.
2. `Open app` is immediately visible and takes the user to a functional in-app route.
3. The visual language resembles the reference in polish and pacing but is unmistakably Bind-specific.
4. The first fold contains a human/business context, crisp headline, concise support copy, and a clear next action.
5. Every section has a clear purpose and the page does not invent customer metrics, testimonials, integrations, or product functionality.
6. The app landing state shows the current workflow condition and the next valid action derived from backend state.
7. Source attribution distinguishes the simulated supplier adapter from live external services.
8. Contract/transaction evidence is shown only when present in the saved workflow record; external links point to the correct environment.
9. `SETTLED_ON_ARC_TESTNET` and `NOT_FULFILLED_AWAITING_3WAY_MATCH` can coexist without visual contradiction.
10. Heroicons are used consistently for UI actions and status support.
11. Layouts work at minimum 320px mobile width through wide desktop; no critical horizontal overflow.
12. Reduced-motion mode, keyboard navigation, contrast, labels, focus, errors, and drawer behaviors pass manual QA.
13. The app retains the existing functional workflow and anti-drift code. Styling must not rewrite or bypass policy enforcement.
14. Tests cover the direct homepage-to-app route and the key workflow states, including failure and pending fulfilment.

---

## 14. Visual QA checklist

### Landing page
- [ ] Header alignment, brand mark, and CTA work at every breakpoint.
- [ ] Headline contrast holds against the darkest and brightest hero-image areas.
- [ ] Hero image has a fallback and does not cause layout shift.
- [ ] Section rhythm is varied but consistent; no accidental huge blank spaces.
- [ ] Product preview reflects actual workflow labels and truthful source attribution.
- [ ] Final CTA works and does not point to a placeholder.

### In-app page
- [ ] `/app` loads directly from URL and after browser refresh.
- [ ] App shell is visually related to marketing but optimized for work.
- [ ] Current workspace/environment is understandable without opening settings.
- [ ] Main workflow state and next action are clear in under five seconds.
- [ ] Long hashes and addresses remain selectable/copyable on mobile.
- [ ] Approval, blocked, waiting, settlement, and fulfilment states are distinct.
- [ ] Explorer links use the correct network and open safely.
- [ ] Errors provide a recovery path and do not erase useful context.

### Motion and access
- [ ] `prefers-reduced-motion: reduce` removes nonessential continuous/scroll motion.
- [ ] Keyboard focus is obvious at all times.
- [ ] Navigation, drawers, and buttons work without hover.
- [ ] Zoom/text scaling does not hide action labels or status text.
- [ ] No auto-playing sound or deceptive progress animation.

---

## 15. Agent implementation instruction

Use this file as the visual and interaction source of truth while implementing Bind’s landing page and `/app` experience.

**Before coding:** inspect the current repository, framework, routes, existing UI, workflow model, persisted evidence fields, and test scripts. Reuse existing working logic and design primitives where appropriate. Do not assume that every feature in this file already exists in the backend.

**Build order:**

1. Inspect the repository and write a short implementation map: existing route system, UI stack, backend fields, and test commands.
2. Implement the shared visual tokens, typography, header, buttons, status labels, and app shell.
3. Implement the landing-page sections and working `/app` navigation.
4. Implement/adjust the workflow overview and evidence drawer to bind to real fields and truthfully render missing/pending/simulated/live states.
5. Add purposeful motion and reduced-motion fallbacks only after the static UI and state flow work.
6. Validate the ten skill stages in Section 11 in their specified order, recording evidence instead of claiming unrun tools.
7. Run repository tests and responsive/accessibility checks. Add or adjust tests for the navigation and lifecycle states.
8. Report exact files changed, tests run and results, unresolved blockers, and any visual state that remains a fixture rather than a live integration.

**Do not:** replace the product with a generic SaaS dashboard, invent additional product modules, alter contract authority rules to fit the UI, fabricate supplier/settlement/fulfilment events, use a dead Open app button, or treat testnet settlement as proof of goods fulfilment.

---

## 16. Skill and icon sources

This document is informed by the following repositories, in the exact order requested:

1. [LottieFiles/motion-design-skill](https://github.com/LottieFiles/motion-design-skill)
2. [Owl-Listener/inclusive-design-skills](https://github.com/Owl-Listener/inclusive-design-skills)
3. [agilek/wireframer-skill](https://github.com/agilek/wireframer-skill)
4. [anhao/icon-generator-skill](https://github.com/anhao/icon-generator-skill)
5. [meodai/skill.color-expert](https://github.com/meodai/skill.color-expert)
6. [Owl-Listener/designer-skills](https://github.com/Owl-Listener/designer-skills)
7. [kozz36/frontend-designer-skill](https://github.com/kozz36/frontend-designer-skill)
8. [ThomasPraun/ux-flow-designer](https://github.com/ThomasPraun/ux-flow-designer)
9. [shaom/brand-to-design-md-skill](https://github.com/shaom/brand-to-design-md-skill)
10. [kylezantos/responsive-craft](https://github.com/kylezantos/responsive-craft)

Icon source: [Heroicons](https://heroicons.com/)

The reference screenshot is supplied by the user and is not a Bind brand asset.
