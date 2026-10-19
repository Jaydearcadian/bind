# ADR 0006: Owner authentication for approval decisions (OPEN)

## Status
Accepted by default (2026-10-19): option 1, per-workspace owner and staff tokens. The owner was asked and did not choose
between the options, and the choice is reversible (sessions can be added later). Implementation is Task 6 of
`docs/superpowers/plans/2026-10-19-bind-completion-plan.md`.

## Context
The HTTP API has no authentication or session layer. Any caller who can reach the server can:

- approve, reject, or revoke any approval, passing any `decidedBy` in the body;
- read every workspace's data by id (`/api/workspaces/:id/...`);
- trigger replenishment and document confirmation.

The spec requires that authorization, tenancy, and approval thresholds be enforced by code. Owner
and staff roles are enforced for surface-card events only, through the verified surface binding.
Direct HTTP calls have no equivalent check. `SESSION_SECRET` is in the env example but unused.

## Options
1. **Per-workspace owner token.** The owner sets a token during onboarding. The server stores its
   hash and requires it on every mutating route. Simple and auditable. The browser would hold the
   token, which the spec allows only for the owner's own credential, not for service secrets.
2. **Sign-in with a session cookie.** An email magic link or passkey, bound to a workspace
   membership table. Correct for multiple owners and staff. Larger, and it needs an email provider.
3. **Keep open for the hackathon demo, with an explicit warning in the UI and evidence.** Not
   acceptable for the production path in the spec.

## Recommendation
Option 1 now, with the membership table from option 2 as the next step. Decide before any deployment
beyond the demo workspace.

## Consequences until decided
Approval, rejection, and revocation remain callable without proof of identity. The live deployment
must be treated as a demo. Recorded as a known risk in `docs/RELEASE_EVIDENCE.md`.
