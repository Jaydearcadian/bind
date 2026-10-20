# ADR 0045: The bead ring is the brand direction

## Status
Accepted (2026-10-20), on the owner's word ("the bead ring is okay. Going with that"). Supersedes ADR 0044 (the dovetail study) as the direction; ADR 0043 was already superseded.

## Context
Three directions were compared side by side (`docs/brand/archive/compare.html`): the dovetail, the original ring, and the bead ring. The owner kept the ring's own wordmark, its Newsreader and Geist type and its palette, and asked for the ring to be made ownable and smooth. The bead ring changes only the mark: the ring's even round stroke with a copper bead that is also the dot of the i.

## Decision
The bead ring is the Bind identity and lives in `docs/brand/`: `BRAND.md`, `tokens.css`, `tokens.json`, `assets/`, `fonts/`, `board.html` and `build_assets.py`. The dovetail study (`archive/dovetail/`), the original ring (`archive/ring-original/`) and the comparison page (`archive/compare.html`) are kept as a record and are not used.

## Consequences
- Done 2026-10-20: the bead ring was promoted to `docs/brand/` and its brand document written. The ring's wordmark is byte-for-byte the original (checked), the Newsreader, Geist and Geist Mono fonts and the palette are unchanged, and the board was re-tested in a browser (fonts load, swipe, status, loading, no console errors).
- Not done: the tagline is still working text the owner has not accepted; there is no animated lockup (only an animated mark); `bind-lockup-animated` from the dovetail has no bead equivalent yet.
- Root `DESIGN.md` and `BRAND_DIRECTION.md` still describe an older, different direction. They are not reconciled with this decision.
- Known weak points, not resolved: the bead ring is less distinctive than the dovetail, a ring with a dot can read as a notification badge, and "waiting" and "refused" differ mainly by colour and a small shift (needs a colour-blind test). Not tested: other operating systems' font rendering, device performance, trademark clearance.
