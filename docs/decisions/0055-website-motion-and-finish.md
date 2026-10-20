# 0055: Website motion, the glass header, the intro and a glossy finish

Status: Accepted (2026-10-20), at the owner's request after reviewing the first landing page.

## Context
The owner found the page too still and too flat: no motion direction, a square header, no loading screen or logo animation. They asked for a rounded header that tightens on scroll with the logo moving, a crisper, glossy, slightly rounded look "almost like glass or water reflection", and a loading screen, without overdoing it.

## Decision
- **Header:** a floating pill of frosted glass (translucent surface, blur, a one-pixel top highlight, a soft shadow). Past 24 px of scroll it tightens: narrower (780 px), shorter, a smaller lockup and a firmer shadow. On phones the menu opens as a matching glass panel.
- **Logo on scroll:** the bead in the header's mark travels round the ring with the page, one turn from top to bottom. The gap cut from the ring moves with it, so the mark is whole at every angle. Off with reduced motion.
- **Intro (loading screen):** on the first visit of a session the ring draws itself (640 ms), the bead slides in and seats with a small overshoot, the word BIND fades in, then the page appears and the hero rises in. About 1.3 s in all, once per session (session storage; with no storage it is skipped). Never with reduced motion. If the script fails the page shows itself after 2.4 s by CSS alone.
- **Scroll motion:** sections ease up 18 px into place the first time they come into view, in groups staggered by 60 ms. The broken links in the problem section move from apart to their resting gap as they arrive. The final mark's bead seats when the closing section arrives.
- **Finish:** larger radii (14, 18 and 24 px; buttons and the header are pills); cards, tabs and the story picture use translucent glass with a faint top sheen and highlight; the primary button has a gentle gloss. One soft copper glow sits behind the hero picture, and the hero ring has a faint water reflection beneath it. Dark mode has its own, fainter highlights and deeper shadows.
- **Brand note:** BRAND.md said no gradients or glow and no mark animation beyond the specified ones. The owner asked for this finish and this motion, so they are now part of the brand, kept faint: one glow, sheens under 6% in dark mode, and the bead orbit only in the header.

## Evidence
`tests/web/landing.spec.ts` now has 26 passing browser tests (4 skipped by design), including: the intro plays once per session and then removes itself; a reload skips it; reduced motion has no intro, no hidden reveals and a still logo; the header tightens on scroll and returns at the top; the bead and the ring's gap rotate together; a section is hidden before it is reached and fully visible after. Screens inspected by eye at 1280 and 390 px, light and dark. `LOCAL_PASS`.

## Not tested
Frame rate on a low-end phone, Safari's blur rendering, a real reduced-motion setting (emulated only).
