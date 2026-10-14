---
name: bind-ui-quality
description: Use when building, revising, or approving Bind screens and interaction flows. Requires real browser inspection, meaningful states, responsive QA, and Playwright assertions.
---

# Bind UI Quality

- Read `BIND_BUILD_SPEC.md` and respect the business owner's workflow. Avoid primitives-first dashboards and agent jargon.
- Establish a deliberate visual system and persist its tokens/decisions. Prefer a restrained, readable infrastructure product aesthetic over template-like card grids and decorative gradients.
- Treat loading, empty, error, partial, stale, offline, permission-denied, approval-pending, and recovery states as part of the feature.
- Verify keyboard use, focus visibility, semantic labels, form errors, and mobile/desktop layouts.
- Run the app and inspect the real rendered UI. Use Playwright for repeatable critical journeys and assert visible state plus relevant backend outcome.
- Use StyleSeed as a repeatable design review loop, not as a substitute for human judgment or functional testing. A score is not evidence that the product works.
- Record browser errors, failed requests, broken navigation, and actual results; fix them before claiming completion.
