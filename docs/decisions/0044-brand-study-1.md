# ADR 0044: Brand study 1, "the handoff" (assets only; the UI is not touched)

## Status
Proposed (2026-10-20). Needs the owner's acceptance. Supersedes ADR 0043 (an earlier draft, now withdrawn and removed from `docs/brand/`).

## Context
The owner asked for a genuinely unique brand for Bind, a connectivity layer that brings agents into a business so the owner and staff can focus on the work, and not a security or governance product. `src/ui/` must not be edited (ADR 0016). Root `DESIGN.md` and `BRAND_DIRECTION.md` predate this study and describe a different direction; they are untouched and not used here.

## Decision
`docs/brand/` holds the whole study: `BRAND.md`, `tokens.css`, `tokens.json`, `assets/*.svg`, `fonts/` (OFL), `board.html`, `build_assets.py`. Nothing under `src/`, `sdk/`, `mcp/` or `tests/` depends on it.
Key choices: tagline "Hand off the busywork."; the metaphor of the pass (where work changes hands); a dovetail mark whose piece position is a status light; Cast, Pass and Yolk colours with yolk meaning "in hand"; Bricolage Grotesque, Instrument Sans and IBM Plex Mono; the order ticket as the card; "slide and seat" motion; a swipe called the bump, limited to acknowledgements; a loader that never shows a made-up percentage.

## Consequences
- Accepting this makes `tokens.css` and the mark the starting point for the rebuilt UI. Rejecting it costs only this folder.
- The animated SVGs respect reduced motion inline, not (as tested) through `<img>`.
- Not verified: other operating systems' font rendering, APCA contrast, colour-blind users, trademark clearance, device performance.
