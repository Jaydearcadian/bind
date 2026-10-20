# Bind brand: the bead ring

Status: the direction the owner chose on 2026-10-20 (ADR 0045). The mark, wordmark, type, palette and motion below are decided. The tagline and the landing copy are working text the owner has not yet accepted. Nothing in the product uses the brand yet: the UI is orphaned (ADR 0016), `src/ui/` is not touched, and it will be rebuilt.

`board.html` is the brand board: a hero study, a swipe demo, a status demo and a loading screen, all with demo data and no server. Rebuild the SVGs with `python3 docs/brand/build_assets.py` (no dependencies). The two directions that were not chosen, and the comparison, are in `archive/`.

## A. Brand core

- **Name:** Bind.
- **What it is, in one line:** Bind is the connectivity layer that brings agents into a business: connect your tools once, and a team of agents works inside them, so the owner and staff can get on with the work itself.
- **Working tagline:** *Connect once. Get back to work.* Support line: *Bind brings a team of agents into your business's real tools, so you and your staff can focus on the work.* (Working text. An earlier "Hand off the busywork." belonged to the dovetail study.)
- **Audience:** an owner-operator of a small, process-heavy business, first a kitchen, who is not technical, and the staff who do stocktaking, receiving and ordering.
- **Emotional hook:** relief. "Somebody picked that up."
- **The idea behind the mark:** a ring is your business, a closed loop of tools and people. The bead is an agent. When it is out, it is on its way in or waiting. When it is seated in the ring, it has joined, and the work is done. The bead is also the copper dot of the i in the wordmark, so the name and the mark share one detail.
- **Voice:** calm, capable, plain-spoken, a little dry. Say what happened. "On it", "Waiting for you", "Done", "Paused", "Refused". Never say "Done" or "Paid" before the system has confirmed it.
- **What exists and what does not:** an API, an event stream, an SDK, an MCP server, a kitchen template and simulated connectors exist. Live supplier, messaging and accounting connections and the owner UI do not. The brand must not imply the second list exists.

## B. Direction

Warm, calm and editorial: a serif voice, an even rounded mark, copper used sparingly. Colour carries a state only together with a label and the bead's position. No gradients, glow, robots or purple. Quiet motion: one rounded ring, one moving bead.

## C. Logo

- **Mark** (`assets/bind-mark.svg`): the ring is one even stroke, 6 units wide with round caps, radius 20 in a 64 box. A copper bead of radius 6.4 sits in the ring at one o'clock, with a 1.7 unit clear gap cut from the ring around it. The ring's stroke is ink; the bead is copper.
- **Wordmark** (`assets/bind-wordmark.svg`): the ring's own lettering, unchanged: lowercase `bind` made of 5 unit strokes with round caps, and a copper dot on the i. It is drawn from strokes, so no font is needed to display it.
- **Lockup** (`assets/bind-lockup.svg`): the mark at 0.8 scale, then the wordmark. Reverse versions for dark backgrounds, a `currentColor` mono mark, and a theme-aware favicon.
- **Clear space and sizes:** keep half the mark's width clear on every side. Minimum: the mark 16 px (checked: the bead stays visible), the lockup 96 px wide.
- **Do not:** redraw or re-letter the wordmark, recolour the ring, put the bead in a status colour outside a status context, add shadows or gradients, rotate the mark, or animate the mark except as specified.
- **Known weak points:** a ring with a dot can read as a notification badge. The mark is less unusual than the dovetail study. "Waiting" and "refused" differ mainly by colour and a small sideways shift, so they need a colour-blind test before relying on them.

## D. Colour and type

All values are in `tokens.css` and `tokens.json` and are unchanged from the ring. WCAG 2.x contrast (APCA not computed):

| Role | Light | Dark |
| --- | --- | --- |
| Background | Bone `#F5F0E6` | `#14110E` |
| Surface | Flour `#FBF8F2` | `#1D1914` |
| Border | Crust `#E8E0D0` | `#2E2822` |
| Text | Ink `#1A1612` (15.84 on bone) | `#F2EBDD` (15.86) |
| Muted text | Char `#5E5648` (6.37) | `#A89E8E` (7.12) |
| Accent | Copper `#A94F25` (4.82 on bone, 5.17 on flour) | `#E08A57` (7.12) |

Status colours (text on tint, light and dark): saffron `#7A5200` on `#F6E3B4` (5.46) and `#F2C14E` on `#3A2D10` (8.01); herb `#1F6A3E` on `#D5EBDD` (5.25) and `#6FCB93` on `#12301F` (7.25); slate `#3F5A7A` on `#D9E3EF` (5.48) and `#8FB0D6` on `#1A2638` (6.78); tomato `#A8321C` on `#F6D9D2` (5.03) and `#F08470` on `#3B1812` (6.22). The bead's fill uses the saffron, herb, slate and tomato base colours as a graphic next to a label.

**Type:** Newsreader for display (large headlines, empty states), Geist for the interface, Geist Mono with tabular figures for money, quantities and ids. All three are SIL Open Font License; the web fonts and licences are in `fonts/`. Checked by rendering here only.

## E. Interaction

**Status bead.** The bead's distance from its seat says the state, its colour agrees, and a label is always beside it (`tokens.css`, `.bind-mark[data-state=...]`).

| State | Bead | Colour | Label |
| --- | --- | --- | --- |
| idle | seated | copper | none |
| pending | 11 units out | saffron | Waiting for you |
| approved | seated | herb | Done |
| held | 4 units out | slate | Paused |
| refused | 11 out, 7 right and 4 down | tomato | Refused |

`board.html` runs these, including "Server confirms": it shows "Confirming" for 800 ms and only then "Done". The product must never set "approved" before the server has.

**The swipe.** Slide a card sideways: right marks it done, left holds it. The card follows the finger 1 to 1; past 35% of its width, or a quick flick, it commits; otherwise it springs back. There are always buttons and arrow keys too, and the result is announced to screen readers. **A swipe is for acknowledging only** (delivery notes, feedback summaries, "seen"). Anything that spends money or promises something to a customer is a tap and a confirm.

**Loading.** One loader icon from 16 px up to full screen: the bead slides out of the ring, seats, pauses, and slides out again (1.4 s loop). A full-screen loading state names what is actually being done ("Opening your workspace") and never shows a made-up percentage. In the product those lines must come from the server.

## F. Motion

Rounded, even and quiet. Transform and opacity only.

| Token | Value | Used for |
| --- | --- | --- |
| `--dur-fast` | 120 ms | press, hover in |
| `--dur-base` | 200 ms | chip and badge change |
| `--dur-slow` | 320 ms | the bead moving, panels |
| `--dur-reveal` | 520 ms | the mark, first load |
| `--ease-standard` | `cubic-bezier(.2, 0, 0, 1)` | almost everything |
| `--ease-emphasis` | `cubic-bezier(.05, .7, .1, 1)` | entrances |

**Animated mark** (`assets/bind-mark-animated.svg`, about 1.1 s, plays once): the ring draws itself around in 640 ms, then the bead slides in along its line from 30 units out, overshoots 1.6 units and seats. In the hero, the headline lines rise 14 px and fade in, 60 ms apart, after the mark.

**Reduced motion.** The animations are written inside `prefers-reduced-motion: no-preference`, so the default and the reduced view are the finished mark; the loader holds still 5 units out. Checked inline in a real browser with the setting emulated. **Not verified:** an animated SVG loaded through an `<img>` tag did not honour the emulated setting in Chromium, so use the static SVGs in `<img>` and inline the animated ones. A real operating-system setting was not tested.

## G. Landing page

A calm single page on the dark field: the serif headline "Connect once. Get back to work.", the mark assembling, and a row of demo cards. Sections: hero; how it connects (connect your tools, say how you run things, meet your team; say only what exists today); a day in the business (a swipeable strip of demo cards); you stay in the loop (limits you set, asked when it matters; a short block, not the headline); what has been tested and what has not (link `docs/RELEASE_EVIDENCE.md`); a close. `board.html` is the hero study.

## Known limits

No real person has seen this. Not tested: colour-blind users, other operating systems' font rendering, device performance, trademark clearance for "Bind" or the mark. The tagline is working text. The root `DESIGN.md` and `BRAND_DIRECTION.md` still describe an older direction and are not reconciled with this one.
