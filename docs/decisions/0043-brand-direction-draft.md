# ADR 0043: Brand direction, draft 1 (assets only; the UI is not touched)

## Status
Superseded by ADR 0044 (2026-10-20); the files it described were removed. It was Proposed and never accepted. Needs the owner's acceptance. Builds on ADR 0016 (the UI is orphaned and will be rebuilt) and the design inputs studied the same day.

## Context
The owner asked for a logo, an animated logo, colours, typography, assets, a landing page direction and a creative recommendation, produced with the supplied "Chief Brand Designer" prompt. `src/ui/` must not be edited.

## Decision
The draft lives entirely in `docs/brand/`: `BRAND.md` (the direction), `tokens.css` and `tokens.json`, `assets/*.svg`, `board.html` (a standalone brand board), and `build-assets.mjs` (regenerates the SVGs). Nothing under `src/`, `sdk/`, `mcp/` or `tests/` depends on it.
Key choices: keep the name Bind; tagline "Agents propose. Rules decide."; a ring-and-latch mark whose open or closed state doubles as a status light; a warm neutral palette in which colour means status; quiet Corporate-archetype motion; no mascot; the product never shows "approved" or "paid" before the server confirms.

## Consequences
- The new UI can adopt `tokens.css` and the mark states unchanged, or replace them. Accepting this ADR is what makes them the starting point.
- The animated SVG respects reduced motion inline but not, as tested, through `<img>`. Details in `BRAND.md` section D.
- Not verified: real fonts, real users, trademark clearance, APCA contrast, behaviour under a real operating-system reduced-motion setting.
