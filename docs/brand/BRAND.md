# Bind brand, study 1

Status: a proposal written on 2026-10-20 for the owner to accept or change. It is a fresh direction and does not build on any earlier brand file. Nothing in the product uses it yet (the UI is orphaned, ADR 0016, and `src/ui/` is not touched). `board.html` is a brand study, not the product UI; its ticket text is demo data.

Scope of this round, as asked: brand core, logo, animated logo, colour and type, landing page visuals, motion direction, the swipe, the loading screen and animated loading icon. Not in this round: the product film, demo run of show, pitch deck, and Hyperframe prompts. Hyperframe's real capabilities were not checked, so no tool-specific prompt is given here.

Reproduce everything: `python3 docs/brand/build_assets.py` (needs `pip install fonttools brotli shapely` and the three font files in `docs/brand/fonts-src/`, which are not committed; the script reads `BIND_FONT_SRC` if they live elsewhere). Open `docs/brand/board.html` in a browser.

## A. Product and brand core

**What exists** (`README.md`, `docs/RELEASE_EVIDENCE.md`): an API, an event stream, a TypeScript SDK and an MCP tool server, a kitchen template with three agent roles, and a set of connectors that are all simulated. **What is only planned:** real supplier, messaging and accounting connectors, and the owner-facing UI. The brand must never imply the second list exists.

- **Name.** Bind. It stays.
- **Positioning, one line.** Bind is the connectivity layer that brings agents into a business: connect your tools once, and a team of agents works inside them, so the owner and staff can get on with the work.
- **Tagline.** **Hand off the busywork.** Supporting line: *Connect your tools once. Your agents join the team, and you get back to the work.* I considered "Connect once. Get back to work." (clear, but it describes setup, not the benefit) and "Work changes hands here." (distinctive, too abstract for a hero). "Hand off the busywork" is plain, says what the owner gets, and contains the metaphor.
- **Core promise.** The routine work gets handled where the business already works, and you can see what was done.
- **Audience.** An owner-operator of a small, process-heavy business, first a kitchen, who is not technical and does not want to learn agent infrastructure. Secondary: the staff who do the stocktaking, receiving and ordering.
- **The problem.** Routine coordination eats the day: checking stock, chasing quotes, logging deliveries, answering the same questions. The owner is the human glue between their own tools.
- **Emotional hook.** Relief. "Somebody picked that up."
- **The defining metaphor: the pass.** In a kitchen, the pass is the counter where work changes hands, from the cooks to the floor. Every business is a chain of handoffs, and most of the pain is in the handoffs. Bind makes them clean.
- **The idea to remember.** *Clean handoffs.* The mark shows it: two pieces joined so they cannot pull apart sideways, only slide along the seam.
- **Differentiation, stated carefully.** Not a chatbot you talk to, not a no-code builder you assemble, not an agent marketplace. It is a layer a business connects to once. (No competitor was researched, so no named comparison is made.)
- **Personality and voice.** Calm, capable, plain-spoken, a little dry; a sous chef who takes things off your plate and tells you what got done. Short sentences. Say what happened, in kitchen words ("ticket", "on it", "bumped").
  Do: "Butter is low. Draft order ready for you." / Don't: "Unlock the power of intelligent automation."
- **Honest wording.** "On it", "Needs your OK", "Done", "Paused", "Needs you". Never "Done" or "Paid" before the server confirms it. This is a habit of the voice, not the headline.

## B. Creative strategy

Start from the reaction wanted: *"I get it in one second, and it looks like nothing else."* Work backward: one object (a ticket), one gesture (the bump), one moving part (the yolk piece), one loud colour. Everything else stays quiet.

Avoided on purpose: rings, knots, threads and chains (the usual "connect" logos), network nodes, gradients, glow, robots, floating UI, purple.

## C. Recommended visual direction

- **Palette idea:** a stainless kitchen at night. Near-black olive (Cast), stainless-sage light (Pass), and one yolk-yellow that means "in hand". Finished work goes quiet. Red appears only for "needs you".
- **The recurring object:** the order ticket, with a notched tear edge and a clip, set in monospace. Cards in the product are tickets.
- **Shapes:** a hard-edged, soft-cornered block (the mark), 14 px ticket corners, 2 px cast outlines on light surfaces. No shadows, no gradients, no glass.
- **Type:** big, heavy, slightly compressed headlines (Bricolage Grotesque Bold), calm body (Instrument Sans), monospace for tickets and amounts (IBM Plex Mono).
- **Photography:** none required for the first version. If used, close, tactile hands-and-surfaces, natural light, no staged smiles. Not stock.
- **Consistency rule:** if a thing is not the ticket, the mark, the yolk piece, or plain type, it needs a reason to be there.

## D. Identity and design system

**Logo.** `assets/bind-mark.svg` and `assets/bind-lockup.svg`. A rounded square split by a dovetail seam. The left piece carries a flared tongue and is yolk; the right piece holds the groove and is cast. The wordmark is `bind`, lowercase, outlined from Bricolage Grotesque Bold (no font needed to display it). The mark's height equals the ascender height, with its bottom on the baseline. Variants: reverse (for dark), mono (`currentColor`), a theme-aware favicon, and a yolk-field version.
Geometry (64 box): square 4 to 60, corner radius 9, seam at x = 32, tongue base 18 high and tip 32 high, a 1.4 unit gap between pieces.
Clear space: half the mark's width on every side. Minimum size: mark 16 px, lockup 96 px wide.
Do not: recolour the pieces outside a status context, add shadows or gradients, rotate or tilt the mark, separate the pieces permanently, or animate the mark except as specified below.

**Colour** (`tokens.css`, WCAG 2.x contrast; APCA not computed):

| Role | Hex | Notes |
| --- | --- | --- |
| Cast | `#1A1F12` | type and the dark field. On Pass 13.97, on Plate 15.89 |
| Olive | `#272E18` | raised surface on dark |
| Pass | `#E9EBE2` | the light field |
| Plate | `#F8F9F3` | cards, ticket stock |
| Seam | `#CBD0C0` | hairlines on light |
| Yolk | `#F5C518` | "in hand" and the one action colour. Cast on Yolk 10.32 |
| Chili | `#BE2F19` | "needs you". On Pass 4.83, on Plate 5.49 |
| Steel | `#5F675A` | "paused" and muted text. On Pass 4.88, on Plate 5.55 |
| Chili lit / Steel lit | `#FF7A63` / `#A9B0A0` | the same roles on the dark field: 6.58 and 7.53 on Cast |

Known weak pairs: Yolk on Pass is 1.35, so yolk is never text and never the only carrier of meaning on the light field (a label always accompanies it; the logo is exempt). Chili started at `#C8341D` (4.40 on Pass) and was darkened to pass.

**Type.** Display: Bricolage Grotesque 700, line-height 1.0 to 1.05, tight tracking. UI and body: Instrument Sans 400 to 600. Tickets, ids, amounts: IBM Plex Mono 500. All three are SIL OFL; the licences and web-font files are in `fonts/`. Checked here by rendering; not checked on other operating systems.

**Iconography.** Not decided in this round. Recommendation: a stroke icon set with 2 px strokes and round caps, matched to the mark's corner radius, chosen when the UI is built.

## E. Product UX and interaction direction

**Status mark.** The mark is a status light. The left piece's distance from the seat says the state, its colour agrees, and a label always sits beside it.

| State | Piece | Colour | Label |
| --- | --- | --- | --- |
| idle | seated | yolk | none |
| working | 10 up | yolk | On it |
| done | seated, goes quiet | same as the other piece | Done |
| held | 4 up | steel | Paused |
| failed | 10 down | chili | Needs you |

`board.html` runs these, including "Server confirms": it shows "Confirming" for 800 ms and only then "Done". The rule is that the product never sets "done" before the server has.

**The swipe: bump it.** I read "the swipe" as the signature gesture, and the landing page's horizontal strip. The gesture is the kitchen's *bump*: slide a ticket sideways off the rail. Right bumps (dealt with), left holds. The ticket follows the finger 1 to 1; past 35% of its width, or a quick flick, it commits; otherwise it seats back with a knock. Always also a Bump and a Hold button, and the arrow keys on a focused ticket; the result is announced to screen readers.
**What a swipe may not do:** anything that spends money or promises something to a customer. Those are a tap and a confirm. A swipe is for acknowledging: delivery notes, feedback summaries, "seen".
On the landing page the swipe is a scroll-snap strip of tickets along the rail, which needs no JavaScript to work.

**Loading.** One loader icon, 16 px up to a full screen. Full-screen loading shows the real thing being done ("Opening your workspace") over the loader on the Cast field. In the product those lines must come from the server. Never a made-up percentage.

## F. Landing page: storyboard and sections

The hero opening, on the dark field (all timings from page load; the page is usable immediately):

| Time | What happens | Motion |
| --- | --- | --- |
| 0 to 160 ms | Fixed piece of the mark fades in | opacity |
| 120 to 680 ms | Yolk piece slides up the seam from 30 units below, overshoots 1.6 up, seats | slide, ease-slide then ease-seat |
| 568 to 738 ms | Fixed piece takes a 0.9 unit knock as it seats | the seat knock |
| 560 / 610 ms | Headline line 1 and 2 rise 14 px and fade in | rise, ease-seat |
| 760 / 820 ms | Sub-line, then buttons | rise |
| 940 ms, each +45 ms | The four tickets slide in from the right and settle on the rail | slide-in, ease-seat |

Sections, each with one visual:
1. **Hero:** the large mark and the rail of demo tickets. Headline "Hand off the busywork."
2. **Connect once:** three tickets in a row: *Connect your tools*, *Meet your team*, *Hand it off*. Say only what exists today and label what is coming.
3. **The pass:** a swipeable strip of five tickets showing a day: stock low, order drafted, delivery in, feedback summarised, menu idea. Labelled demo.
4. **You stay in the loop:** one short block. Agents work inside limits you set, and you are asked when it matters. Not a security pitch.
5. **What has been tested, and what has not:** an honest panel linking `docs/RELEASE_EVIDENCE.md`.
6. **Close:** the mark assembles again and one button.

## G. Motion system: slide and seat

**Principles.** Things slide along one axis; they never just fade. The seat has a soft stop, not a bounce. Motion tells you where something is or what changed. Done is quiet.

**Hierarchy.** Functional (90 to 260 ms): state changes, hover, focus, press. Expressive (260 to 420 ms): tickets entering the rail, the swipe. Signature (rare): the logo assembling, the done-knock, the loader's tick-tock.

**Tokens** (`tokens.css`): tick 90 ms, slide 260 ms, seat 140 ms, rail 420 ms, page 380 ms, loop 1400 ms; ease-slide `cubic-bezier(.45,0,.2,1)`, ease-seat `cubic-bezier(.3,.9,.2,1)`; stagger 45 ms, under 300 ms total. Transform and opacity only.

| Animation | Trigger | What moves | How, how long | Says |
| --- | --- | --- | --- | --- |
| Logo assemble (`bind-mark-animated.svg`, `bind-lockup-animated.svg`) | first load, once | yolk piece up the seam, then a 0.9 unit knock; in the lockup the letters rise 40 units, 45 ms apart | 0.75 s for the mark, about 1 s for the lockup | the product joins things cleanly |
| State change | a real state result arrives | the yolk piece to its new offset and colour | 260 ms, ease-slide | what is happening now |
| Done knock | the server confirms | the fixed piece drops 0.9 units and returns | 170 ms, ease-seat | it landed |
| Ticket enters the rail | new item | slides 46 px from the right, overshoots 3 px, settles | 420 ms | something new is in hand |
| Bump / hold | swipe, button or key | ticket slides off 1 to 1 with the finger, or springs back | commit 320 ms; spring back 260 ms | dealt with, or put aside |
| Loader (`bind-loader.svg`) | waiting on work | yolk piece passes the seat twice per cycle, pausing on each pass | 1400 ms loop | working, steadily |

Before and after: before the logo animation the mark is invisible; after it, it rests seated forever. A ticket's neighbours do not move when it is bumped (they close up in the next 260 ms).

**Reduced motion.** The logo and loader animations are written inside `prefers-reduced-motion: no-preference`, so the default and the reduced view are the finished mark; the loader holds still 5 units off the seat. Tickets appear without sliding. Status still changes (position and label) with no transition.
**Verified:** inline and as a direct document, the emulated reduced-motion setting stops the animation. **Not verified:** when an animated SVG is loaded with an `<img>` tag, the emulated setting did not stop it (Chromium). Use the static files in `<img>` and inline the animated ones, or drive them from the host page. A real operating-system setting was not tested.
**Mobile and performance:** only transform and opacity animate; the loader is two paths; the rail uses CSS scroll-snap. Not measured on a device.

## L. Implementation priorities

Must have: tokens and fonts, the mark and lockup, the status mark, the loader, honest status wording. High impact: the hero assembly, the ticket as the card pattern, the bump gesture with button and key alternatives. Optional polish: the lockup letter reveal, a full-screen loading transition, photography.
Depends on a decision: icon set, and what the real connector list on the landing page can claim.

## M. Final creative recommendation, and the next decision

Make **the handoff** the whole brand: a yolk piece that is in hand, a ticket that you bump when it is dealt with, and a mark that seats when work is done. Keep everything else quiet so those three moments carry the product.

**The next decision:** accept or change the tagline "Hand off the busywork." and the mark. Everything downstream (landing build, loading screen, the motion map) follows from it. After that, I would write the motion map for the first UI screens.

## Known limits

- No real person has seen this. Not tested with colour-blind users: position and label carry state, but "held" (4 up) and "working" (10 up) are only 6 units apart, which needs a user test.
- Fonts were rendered here on Linux only. APCA contrast not computed. No trademark or name search for "Bind" or the mark.
- The animated SVG through `<img>` under reduced motion (above). Performance not measured on a device.
- The brand board's demos have no server. The swipe, "Server confirms" and the loading screen simulate one.
