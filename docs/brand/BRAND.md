# Bind brand direction, draft 1

Status: a proposal written on 2026-10-20 for the owner to accept or change. It is not a finished identity and nothing in the product uses it yet (the UI is orphaned, ADR 0016, and has not been rebuilt). `src/ui/` is not touched. Everything here is reproducible: `node docs/brand/build-assets.mjs` regenerates the SVGs, and `docs/brand/board.html` shows the system live.

The brief was the "Chief Brand Designer" prompt. Sections it asked for that were not requested are left out on purpose: mascot, pitch deck and hackathon story, and image-generation prompts.

## A. Brand core

- **Name.** Keep **Bind**. It already means three useful things: a binding commitment, the thing that holds a sauce together in a kitchen, and a clasp. No rename is worth the cost.
- **Positioning, one line.** Bind is the connectivity layer that brings agents into a business: connect once, and a team of agents works inside your real tools so the owner and staff can spend their time on the work itself.
- **Tagline (recommended).** **Connect once. Get back to work.** It says what Bind is (a connection, made once) and what the owner gets (their time back), and it matches the build brief word for word: a business "connects once". Alternatives: "Agents that fit your business" (accurate, a little flat) and "Your business, with agents in the room" (warm, but longer and vaguer). An earlier draft used "Agents propose. Rules decide." It was dropped: that line describes a safety layer, and Bind is a connectivity layer. Control still matters, but it is a supporting proof point on the page, not the headline.
- **Personality.** Calm, capable, a little dry. The tone of a good sous chef who takes things off your plate and tells you plainly what got done.
- **Target user.** A kitchen owner or operator who is not technical and does not want to learn agent infrastructure. They approve things from a phone, often between tasks.
- **Emotional hook.** Time back. "The ordering, the chasing, the paperwork is handled, and I can get on with the food and the people."
- **What makes it memorable.** The mark is a ring being closed. A loop that clasps shut is a connection made, and "bind" is the verb. The same picture doubles as a status light in the product: open means something is waiting for the owner, closed means it is done.

## B. Direction (opinion, with the reasons)

1. **Warm and physical, not fintech.** The category defaults to neon on near-black with gradients. Bind sits in a kitchen: bone paper, ink, copper, enamel. That is the difference people will notice.
2. **One idea, used everywhere.** Connecting: a loop that closes. Not a mascot, not a pattern system. A mascot would add character but cost production time and dilute the one idea. Recommendation: no mascot.
3. **Neutral by default, colour means state.** The brand is ink on bone with a single copper latch. Saffron, herb, slate and tomato appear only when something has a status. If every card is colourful, status stops reading.
4. **Quiet motion.** The Corporate archetype from the LottieFiles motion skill (200 to 400 ms, almost no overshoot), which that skill itself lists for financial and enterprise products. One moment of delight: the latch seating.
5. **Plain, accurate copy.** The product says "waiting", "confirming", "done", "paused", "refused". It does not say "approved" or "paid" before the system has confirmed it. This is a wording habit that builds trust, not the brand's headline.

What I rejected, and why: a chain-link or knot logo (generic, and a knot does not animate cleanly to a status); a lowercase "b" monogram (every second startup has one); gradients and glass (they fight the bone palette and cost contrast).

## C. Logo

- **Mark.** A ring with a latch at the top (`assets/bind-mark.svg`). The ring is ink. The latch is copper and overlaps the ring ends slightly, like a bolt. Geometry: ring radius 20 in a 64 box, stroke 6, round caps, a 56 degree gap with a 48 degree latch.
- **Wordmark.** Lowercase `bind`, drawn as monoline strokes on the same round-capped geometry (`assets/bind-wordmark.svg`). No font is needed, so it never renders differently. The dot of the `i` is the latch colour.
- **Lockup.** Mark left, wordmark right (`assets/bind-lockup.svg`). Reverse versions for dark backgrounds, a currentColor mono mark, and a theme-aware favicon with a heavier stroke so it holds at 16 px.
- **Clear space and minimum size.** Keep one ring-stroke of space (6 units of the 64 box) around the mark. Minimum: mark 16 px (use the favicon version), lockup 96 px wide.
- **Do not.** Recolour the ring, put the latch in a status colour outside a status context, add a drop shadow or gradient, or rotate the mark.

## D. Animated logo

`assets/bind-mark-animated.svg`, about 1.5 s, plays once:

| Time | What happens |
| --- | --- |
| 0 to 700 ms | The ring draws itself around, standard easing |
| 640 to 1160 ms | The latch drops 14 px, fades in, seats with a 1 px settle |
| 1100 to 1480 ms | The whole mark swells 3.5 percent and settles |

The animation is inside `prefers-reduced-motion: no-preference`, so the default and the reduced-motion view are the finished mark. Checked in a real browser: frames at 250, 500, 750, 950, 1250 and 2000 ms show the sequence, and with reduced motion emulated the inline and directly opened SVG show the finished mark with no animation. **Not verified:** when the SVG is loaded through an `<img>` tag, the emulated reduced-motion setting did not stop the animation in Chromium. Use the static SVG in `<img>` and inline the animated one only where the page can honour the preference, or drive it from the host page. A real operating-system setting was not tested.

**The mark as a status light** (`tokens.css`, `.bind-mark[data-state=...]`):

| State | Latch | Colour | Words |
| --- | --- | --- | --- |
| idle | seated | copper | none |
| pending | lifted 9 px, breathes 3 px | saffron | Waiting for you |
| confirming | stays lifted | saffron | Confirming |
| approved | seated, one settle | herb | Done |
| held | seated, turned 16 degrees | slate | Agents paused |
| refused | lifted and askew | tomato | Refused |

The latch position carries the state, colour agrees, and a text label always sits next to it. `board.html` lets you click through these, including "Approve" showing "Confirming" for a moment before "Done".

## E. Colour and type

All values are in `tokens.css` and `tokens.json`. Contrast is WCAG 2.x relative luminance; APCA was not computed.

| Role | Light | Dark |
| --- | --- | --- |
| Background | Bone `#F5F0E6` | `#14110E` |
| Surface | Flour `#FBF8F2` | `#1D1914` |
| Border | Crust `#E8E0D0` | `#2E2822` |
| Text | Ink `#1A1612` (15.84 on bone) | `#F2EBDD` (15.86) |
| Muted text | Char `#5E5648` (6.37) | `#A89E8E` (7.12) |
| Brand accent | Copper `#A94F25` (4.82 on bone, 5.17 on flour) | `#E08A57` (7.12) |

Status colours (text and tint pairs, all at least 5.0 in light and 6.2 in dark): saffron `#7A5200` on `#F6E3B4`, herb `#1F6A3E` on `#D5EBDD`, slate `#3F5A7A` on `#D9E3EF`, tomato `#A8321C` on `#F6D9D2`. The copper accent was first `#B4572B` and failed text contrast (4.26), so it was darkened.

**Type.** Newsreader (display, used sparingly for headlines and empty states), Geist (interface), Geist Mono with tabular figures (money, quantities, ids). They are free on Google Fonts under the OFL; confirm the licence when adding them. The board falls back to system fonts, so type rendering has not been seen with the real fonts.

**Motion tokens.** 120 ms (press), 200 ms (chips, rows), 320 ms (clasp, panels), 520 ms (the mark on first load), easing `cubic-bezier(.2,0,0,1)`, 40 ms stagger under 400 ms total. Transform and opacity only.

## F. Landing page direction

A single page, calm, one scroll. No claim that is not true today (see `docs/RELEASE_EVIDENCE.md`).

1. **Hero.** The ring, large, with the latch lifted and breathing, then closing as the page loads. Headline: "Connect once. Get back to work." Sub-line: "Bind brings a team of agents into your kitchen's real tools, so you and your staff can focus on the food and the people." One button. Beside it, a small live card that shows the agents doing a piece of the job: "Low on butter. Order drafted for Sysco Metro, $392.00. Waiting for you." Approve and Refuse. Pressing Approve shows "Confirming" and then "Done", the board's exact sequence. It shows the work being taken off your plate and you staying in charge, in one gesture.
2. **How it connects.** Three steps, each with a ring: connect your tools once; tell Bind how you run things (preferences, limits, who approves what); meet your team. Say only what exists today and name what is coming.
3. **The team.** Three roles (procurement, fulfilment, menu and feedback): what each takes off your hands.
4. **A day in the kitchen.** Four steps as four rings: stock runs low, agent proposes, owner approves, order is confirmed. The ring changes with scroll position.
5. **You stay in charge, and proof.** One short block: you set the limits and approve what matters, and the agents work inside them. Then what has been tested and what has not (local tests pass; no live supplier or payment connection yet). A page that says what is not done earns more trust than one that hides it.
6. **Close.** One button.

Layout: 12 column grid, generous space, content width 960 px, bone background, flour cards, no photography of food in the first version (stock photos would pull it toward every other restaurant-tech site). Sections enter with a 200 ms fade and 12 px rise, staggered 40 ms, once.

## G. Creative recommendation

Build the brand around one promise and one picture. The promise: **connect once, get back to work.** The picture: **a ring that closes.** Ship the mark, the status light and the plain wording first. Treat everything else (landing page, empty states, social) as applications of that promise. If a design choice does not say "connected", "handled for you" or "you are in charge", it is probably decoration and can wait.

## H. Known limits of this draft

- No real user has seen it. The mark is untested at very small sizes beyond one favicon render.
- Fonts were not loaded in the renders. Colour contrast is WCAG 2 only.
- The animated mark is verified inline and as a direct document, not through `<img>` under reduced motion (see D).
- The latch-as-status idea needs a second look for people who cannot see colour: position carries the state, and the label is mandatory, but the held and refused positions are close. Test with real users before relying on it.
- No trademark or name search was done for "Bind" or the mark.
- Inputs studied but not copied: the ten skill repositories. Rules were borrowed from LottieFiles' motion skill (archetype and timing), `designer-skills` (state machines, motion tokens), `inclusive-design-skills` (reduced motion, status without colour alone), colour-expert (semantic layers, contrast checks) and the DESIGN.md idea from brand-to-design-md. No brand's own design was reproduced.
