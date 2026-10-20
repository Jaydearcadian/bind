# Bind brand direction, draft 1

Status: a proposal written on 2026-10-20 for the owner to accept or change. It is not a finished identity and nothing in the product uses it yet (the UI is orphaned, ADR 0016, and has not been rebuilt). `src/ui/` is not touched. Everything here is reproducible: `node docs/brand/build-assets.mjs` regenerates the SVGs, and `docs/brand/board.html` shows the system live.

The brief was the "Chief Brand Designer" prompt. Sections it asked for that were not requested are left out on purpose: mascot, pitch deck and hackathon story, and image-generation prompts.

## A. Brand core

- **Name.** Keep **Bind**. It already means three useful things: a binding commitment, the thing that holds a sauce together in a kitchen, and a clasp. No rename is worth the cost.
- **Positioning, one line.** Bind connects a business once and gives it an agent team that can use real tools, while rules the model cannot change decide what actually happens.
- **Tagline (recommended).** **Agents propose. Rules decide.** It is the product's central safety rule (`AGENTS.md`, `docs/BIND_MISSION_AND_ARCHITECTURE.md` section 2) said in four words. Two alternatives I would not use: "Your business, agent-ready" (generic, every AI product says it) and "Open ring, closed deal" (clever, but it explains the logo instead of the product).
- **Personality.** Calm, exact, a little dry. The tone of a head chef who has seen a supplier invoice go wrong. Never excited about money, never vague about what happened.
- **Target user.** A kitchen owner or operator who is not technical and does not want to learn agent infrastructure. They approve things from a phone, often between tasks.
- **Emotional hook.** Relief with control: "the agents ask, I say yes, and nothing happens behind my back."
- **What makes it memorable.** The mark is a status light. An open ring means a request is waiting. A closed ring means it is committed. The brand and the product's main rule are the same picture.

## B. Direction (opinion, with the reasons)

1. **Warm and physical, not fintech.** The category defaults to neon on near-black with gradients. Bind sits in a kitchen: bone paper, ink, copper, enamel. That is the difference people will notice.
2. **One idea, used everywhere.** Open versus closed. Not a mascot, not a pattern system. A mascot would add character but cost production time and would dilute the one idea that is true to the product. Recommendation: no mascot.
3. **Neutral by default, colour means state.** The brand is ink on bone with a single copper latch. Saffron, herb, slate and tomato appear only when something has a status. If every card is colourful, status stops reading.
4. **Quiet motion.** The Corporate archetype from the LottieFiles motion skill (200 to 400 ms, almost no overshoot), which that skill itself lists for financial and enterprise products. One moment of delight: the latch seating.
5. **Honest copy.** The product says "waiting", "confirming", "committed", "paused", "refused". It never says "approved" or "paid" before the server confirms it. This is a brand rule, not only a UX rule.

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
| approved | seated, one settle | herb | Committed |
| held | seated, turned 16 degrees | slate | Agents paused |
| refused | lifted and askew | tomato | Refused |

The latch position carries the state, colour agrees, and a text label always sits next to it. `board.html` lets you click through these, including the rule that "Approve" shows "Confirming" for a moment and only then "Committed".

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

1. **Hero.** The ring, large, with the latch lifted and breathing. Headline: "Agents propose. Rules decide." Sub-line: "Connect your kitchen once. Your agents ask before they spend." One button, and a small live demo card beside it: a $392 butter request, "Waiting for you", Approve and Refuse. Pressing Approve shows "Confirming" and then "Committed", the board's exact sequence. This is the wow moment and it is also the product's safety rule.
2. **The rule.** Four short lines, one per law: the model proposes, code decides; no entry without a document; no silent rounding; every effect happens once. Each with its ring state.
3. **The team.** Three roles (procurement, fulfilment, menu and feedback), what each can ask for and what it can never do.
4. **A day in the kitchen.** Four steps as four rings: stock runs low, agent proposes, owner approves, order is confirmed. The ring changes with scroll position.
5. **Proof, honestly.** What has been tested and what has not (local tests pass; no live supplier or payment connection yet). A page that says what is not done earns more trust than one that hides it.
6. **Close.** One button.

Layout: 12 column grid, generous space, content width 960 px, bone background, flour cards, no photography of food in the first version (stock photos would pull it toward every other restaurant-tech site). Sections enter with a 200 ms fade and 12 px rise, staggered 40 ms, once.

## G. Creative recommendation

Build the brand around one picture: **an open ring is a request, a closed ring is a commitment.** Ship the mark, the status light and the honest wording first, because they carry the product's difference. Treat everything else (landing page, empty states, social) as applications of the same picture. If a design choice does not use the open versus closed idea, state colour, or the honest vocabulary, it is probably decoration and can wait.

## H. Known limits of this draft

- No real user has seen it. The mark is untested at very small sizes beyond one favicon render.
- Fonts were not loaded in the renders. Colour contrast is WCAG 2 only.
- The animated mark is verified inline and as a direct document, not through `<img>` under reduced motion (see D).
- The latch-as-status idea needs a second look for people who cannot see colour: position carries the state, and the label is mandatory, but the held and refused positions are close. Test with real users before relying on it.
- No trademark or name search was done for "Bind" or the mark.
- Inputs studied but not copied: the ten skill repositories. Rules were borrowed from LottieFiles' motion skill (archetype and timing), `designer-skills` (state machines, motion tokens), `inclusive-design-skills` (reduced motion, status without colour alone), colour-expert (semantic layers, contrast checks) and the DESIGN.md idea from brand-to-design-md. No brand's own design was reproduced.
