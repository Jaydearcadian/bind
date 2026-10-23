# 0052: The account layer: accounts, sessions, invitations, members

Status: Accepted. Backend only; no UI uses it yet.

## Context
ADR 0051 chose Privy for people. This ADR records what was built and the changes it forced in existing tests.

## Decision
- **Verifier** (`src/accounts/privy.ts`): ES256 only, checked with the app's public key (PEM, P-256) and no network call. The signature is checked before any claim is trusted; `aud` must be the app id; `iss`, if present, must be `privy.io`; `exp` and `sub` are required; a 30-second clock skew is allowed. `none`, HS256 keyed with the public key, other algorithms, other curves and oversized tokens are refused. Written against Privy's documented ES256 claims (`sub` the user DID, `aud` the app id); the docs disagree on the issuer claim, so it is optional here, and one page calls the key Ed25519 while importing it as ES256, so the code expects P-256 and fails at startup on anything else. Live behaviour with Privy's own tokens is `NOT_RUN`.
- **Tables**: `accounts` (Privy user id, optional display name), `workspace_memberships`, `account_sessions`, `workspace_invites`. Session tokens (`bns_`) and invitation codes (`bni_`) are stored as SHA-256 hashes only.
- **Sessions** are scoped to one workspace, last 60 minutes by default (`BIND_SESSION_MINUTES`) and resolve to the same `Actor` a workspace token does, so every route's authorization is unchanged. The role is read from the membership on every request: a role change takes effect at once, and removing a member (or marking the membership removed by any path) ends the session. The workspace switcher is a new session.
- **Invitations**: single use, expiring (72 hours by default, at most 14 days), staff only. One locked statement claims the code, so racing accepters cannot both get in. Unknown, malformed, used, revoked and expired codes are one answer (`INVITE_UNUSABLE`). An existing member does not consume a code.
- **Last owner**: a workspace always keeps at least one owner credential, counting owner tokens and owner memberships together. This applies to demoting or removing a member and to revoking a token.
- **Account creation of a workspace** makes the account the owner and issues no owner token.
- **Audit**: `auth.member_joined`, `auth.member_removed`, `auth.member_role_changed`, `auth.invite_created`, `auth.invite_revoked` (ids only; owner-only events). Documented in `docs/EVENTS.md` and `docs/ecosystem/spec/event-names.json`.
- **Configuration**: `PRIVY_APP_ID`, `PRIVY_VERIFICATION_KEY`, `BIND_SESSION_MINUTES`. Unset, the account routes answer 503 and nothing else changes.
- **API**: a new access level, `account` (a Privy access token). Eleven operations: `createSession`, `signOut`, `listAccountWorkspaces`, `createAccountWorkspace`, `acceptInvite`, `createInvite`, `listInvites`, `revokeInvite`, `listMembers`, `setMemberRole`, `removeMember`. Signing out with a workspace token answers `signedOut: false` and changes nothing.

## Changes to existing tests, recorded
- `tests/integration/api-contract.test.ts`: the cap on routes not contract tested rises from 2 to 10 (the rule says to raise it only with a reason here). Eight People routes need a Privy token or a seeded id that the contract harness does not mint; they are covered, with answers checked against the same registry schemas, by `tests/integration/accounts.test.ts`. `createInvite`, `listInvites` and `listMembers` are contract tested. The access test gained an `account` branch (no token and a workspace token both give 401). Invalid-body checks now run only for contract-tested routes. The list of GET routes not contract tested gained `GET /api/account/workspaces`.
- `tests/integration/auth-tenancy.test.ts`: the owner routes, `sign-out` and a new list of account routes are registered.
- `tests/integration/untrusted-input.test.ts`: runs with a configured test verifier; `POST /api/auth/sign-out` is listed with the other routes that ignore their body.
- `tests/unit/capabilities-catalogue.test.ts`: operations that return a secret once may have the `account` or `authenticated` access level as well as `owner` or `public`.
- `tests/helpers/privy.ts` is a real ES256 verifier keyed with a generated key.
- Nothing was deleted or skipped.

## Evidence
Lint, typecheck, unit 420 passed, integration 574 passed with 10 skipped. New: 9 verifier tests with real signatures; 14 account tests over HTTP and PostgreSQL covering cross-tenant sessions, expired, revoked and raced invitations, role and removal effects on live sessions, last-owner rules, hashes only in the database, and audit rows with ids only. Mutation checks: removing the membership condition from session resolution, or the last-owner check on removal, makes tests fail. `LOCAL_PASS`. Live Privy: `NOT_RUN`.

## Not done
- No UI. No email invitations. No per-account rate limit (the per-address limits apply). No refresh endpoint: signing in again with a fresh Privy token starts a new session.
