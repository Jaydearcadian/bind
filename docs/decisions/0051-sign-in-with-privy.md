# 0051: Sign-in with Privy, on top of workspace tokens

Status: Accepted (2026-10-20). The backend account layer is built (ADR 0052); no UI uses it yet.

## Context
Sign-in today is a workspace token (ADR 0021). That is right for the SDK, MCP and agents, and wrong for a business owner. The owner chose Privy, with Google and wallet sign-in, for people.

## Decision
- Privy proves who a person is. Bind keeps its own account records, workspace memberships and roles, and enforces authorization in code. A wallet sign-in is identity only and never grants payment authority.
- The browser sends the Privy token; the server verifies it against the app's verification key and issues a short-lived Bind session. Verify against the current Privy documentation before building: the older `@privy-io/server-auth` package is deprecated in favour of `@privy-io/node`.
- Workspace tokens stay for machines. The sign-in page keeps an "Use an access key" door for builders.
- A person may belong to several workspaces. Several owners are allowed with the last owner protected, as today. Staff join by a single-use, expiring invite link.
- Google and a wallet may be linked to one account only after signing in with both in one session and an explicit confirm.
- The Privy app id and secret are credentials the owner supplies through environment configuration. They are never committed.

## Consequences
- A new account layer (accounts, memberships, invites, sessions) is required before the new UI can sign anyone in. That is a backend task with its own tests: cross-tenant access, replayed or expired invites, revoked memberships, last-owner protection.
- Local tests use a fake verifier. That is a mock, not a live integration; live Privy sign-in is `NOT_RUN` in the release evidence until run against the owner's Privy app.
- The UX decisions are recorded in `docs/ux/UX_BRIEF.md`.
