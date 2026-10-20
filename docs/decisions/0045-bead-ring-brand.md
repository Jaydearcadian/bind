# ADR 0045: The bead ring is the brand direction

## Status
Accepted (2026-10-20), on the owner's word ("the bead ring is okay. Going with that"). Supersedes ADR 0044 (the dovetail study) as the direction; ADR 0043 was already superseded.

## Context
Three directions were compared side by side (`docs/brand/compare/compare.html`): the dovetail, the original ring, and the bead ring. The owner kept the ring's own wordmark, its Newsreader and Geist type and its palette, and asked for the ring to be made ownable and smooth. The bead ring changes only the mark: the ring's even round stroke with a copper bead that is also the dot of the i.

## Decision
The bead ring is the Bind identity. Its sources are `docs/brand/compare/ring-v2/` (mark, assets, board, build script) and the ring wordmark and tokens in `docs/brand/compare/ring/`. The dovetail study in `docs/brand/` stays as a record and is not used.

## Consequences
- Not yet done: promote the bead assets and the ring tokens to the canonical `docs/brand/` location, write its brand document (the dovetail's `BRAND.md` still describes the dovetail), and regenerate the status marks' wording.
- Root `DESIGN.md` and `BRAND_DIRECTION.md` still describe an older, different direction. They are not reconciled with this decision.
- Known weak points, not resolved: the bead ring is less distinctive than the dovetail, a ring with a dot can read as a notification badge, and "waiting" and "refused" differ mainly by colour and a small shift (needs a colour-blind test). Not tested: other operating systems' font rendering, device performance, trademark clearance.
