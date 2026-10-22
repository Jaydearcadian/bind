# ADR 0074: Owner notices by email, behind a default-off provider and a verified address

## Status
Accepted (2026-10-22). Builds on ADR 0017 (effects ledger), ADR 0020 and ADR 0027 (owner notices at most once), ADR 0022
(surface bindings), ADR 0025 (the owner's own recipient and a plain link) and ADR 0033 (rate limits). Live sending is
`NOT_RUN`: no real provider account was contacted. Every provider call in the tests goes to a local fake server.

## Context
- An owner was told about an approval, or a customer order that waits for them, only through a messaging binding that nothing
  delivered. `NotificationEmitter` recorded each message in memory with status `simulated`.
- Email is the one channel an owner can set up without a phone-number integration. It needs a provider, so it must be
  switched on deliberately, and an address must not be usable by someone who only typed it.

## Decision

### 1. One email transport, chosen by environment, off by default
- `BIND_EMAIL_PROVIDER` is the only switch. The only value is `resend`. Unset, the emitter behaves as before: email is
  recorded and labelled `simulated`, nothing leaves the server, and every existing test passes unchanged.
- Resend was chosen for a single HTTPS call with a bearer key and a JSON body. The adapter (`src/adapters/email/resend.ts`) is
  about one function and needs no SDK. It is injectable (a `fetch` option, a timeout, and the base URL), so tests run against a
  local server.
- `BIND_EMAIL_API_KEY`, `BIND_EMAIL_FROM` and `BIND_EMAIL_API_BASE` complete the setup. Startup is refused when a provider is set
  without its key or sender, or when the app link base is not https (or local outside production). A bad value names its
  variable and never shows the value.
- The base URL rule (`emailBaseUrlAllowed`, `src/config/env.ts`) is https, or `http` on `127.0.0.1` or `localhost` outside
  production. Userinfo is refused. The rule applies to the API base and to the app link base.

### 2. The adapter sends at most once, and reports only what the provider says
- No retry is made inside the adapter. A send is a `runEffect` (ADR 0017) with `externalDedupes: false`, so a send that fails
  or has an unknown outcome leaves its row `failed` or `started`. The owner is not sent it again. A timeout after the provider
  accepted the message is therefore in doubt, and is reported as `notification.in_doubt`, never resent.
- `status: "sent"` is returned only for a 2xx answer that carries a non-empty id of at most 200 characters. Every other answer,
  including a 2xx without a usable id, is an `EmailTransportError` with a reason (`timeout`, `network`, `http`,
  `malformed_response`). The error message names the reason and, for an HTTP answer, the status. It never carries the key, the
  address, the subject or the provider's body.
- The key is redacted from every error text (`BIND_EMAIL_API_KEY` joins the configured secrets in `src/utils/redact.ts`). No
  log line carries the key or an address.

### 3. The content is plain, short, and built from facts
- Subject: `Something is waiting for you in Bind`. Body: one sentence, a link to `${APP_BASE_URL}/app/`, and the line `Open Bind
  to look at it and decide. Nothing happens until you do.`
- The sentence names what the notice is about and nothing else: for an approval, the supplier and the amount in USD (the
  supplier name is untrusted text: control characters, line breaks and bidi controls become spaces, and the text is cut to 80
  characters); for an order, a fixed sentence with no order detail. The builder reads the notice kind from the payload
  metadata, never from the message text, so a customer's note or reference cannot reach an email.
- No approve or reject link, no token, no query string. The link opens the app's front page; opening it decides nothing (ADR
  0025). The verification mail carries the code and nothing else.

### 4. The owner's address is verified before it can receive a notice
- `owner_emails` (one live row per workspace and address; `src/db/schema.sql`) holds the address, the salted SHA-256 of a
  six-digit code (`code_salt`, `code_hash`), the expiry, the attempt count, `verified_at`, the id of a surface binding the row
  created (`binding_id`), and `removed_at`. A code is never stored, logged or returned. Only the email carries it.
- A new request replaces the code. A code is valid for 10 minutes. Five wrong codes end it: a new request is needed, and the
  request gives a new code that resets the count. The comparison is constant-time over two fixed-length digests.
- At most three codes per address per workspace per hour (table `owner_email_sends`). The count is kept per address, not per
  row, so removing and re-adding an address does not reset it.
- Verifying creates the owner's `email` surface binding (`surface_bindings`, `actor_role = 'owner'`) only when no binding for
  that address exists. An existing binding (staff or owner, simulated or not) is never changed by verification. Removal
  deletes the binding only when the row created it.
- The binding's `integration_status` follows the existing gate (ADR 0022): `verified` is stored only with
  `SURFACE_PROVIDER_VERIFIED` set, otherwise `configured_unverified`. The proof that the owner controls the address is
  `owner_emails.verified_at`, not the binding status. An operator who wants the binding itself marked `verified` sets
  `SURFACE_PROVIDER_VERIFIED`, as before. This ADR does not change that gate.
- Only a verified address receives notices. A pending address is listed and receives nothing.

### 5. Recipients
- `resolveOwnerRecipients` (`src/notifications/recipients.ts`) keeps the channel order: a whatsapp binding, then a telegram
  binding, each the single recipient. Only when neither exists does email apply: first the owner's verified addresses (oldest
  verified first), then, as before, an email surface binding.
- Several verified owner addresses are each told. The **first** recipient keeps the ledger key used before there were several:
  `${workspaceId}:notify:${kind}:${refId}`. Each **additional** recipient's key adds its `owner_emails` id:
  `${workspaceId}:notify:${kind}:${refId}:${ownerEmailId}`. Each recipient is told at most once per (kind, refId).
- Known edge: if the first recipient is removed and a notice for the same (kind, refId) is later sent again, the next owner
  receives that notice once under the bare key, although it may already have had the notice under its own key. A notice is
  not normally re-sent, so this is recorded and not handled.
- One recipient's failure is audited as `notification.failed` and does not stop the others.

### 6. Routes, errors and events
- `GET /api/workspaces/:id/notifications`, `POST /api/workspaces/:id/notifications/email`,
  `POST /api/workspaces/:id/notifications/email/verify`, `DELETE /api/workspaces/:id/notifications/email/:emailId`. All are
  owner only, through the same middleware as the other owner routes. Staff get 403, a token for another workspace gets 404, and
  an anonymous call gets 401.
- Refusals use the error catalogue: `EMAIL_NOT_CONFIGURED` (503), `EMAIL_NOT_FOUND` (404), `EMAIL_SEND_LIMITED` (429, with
  `Retry-After`), `EMAIL_SEND_FAILED` (502), `EMAIL_CODE_INVALID` (400), `EMAIL_CODE_EXPIRED` and `EMAIL_ATTEMPTS_EXCEEDED`
  (409). Malformed input is `INVALID_INPUT` (400).
- Audit rows, all by the owner token's label: `notification.email_code_sent`, `notification.email_send_failed`,
  `notification.email_verified`, `notification.email_verify_failed` and `notification.email_removed`. Evidence holds ids and the
  masked address (`o***@k***.com`), never the full address or a code. The event names are in `src/api/event-catalogue.ts`,
  `docs/ecosystem/spec/event-names.json` and `docs/EVENTS.md`.
- The four operations are classified in `docs/ecosystem/exposure.json` as `owner_configuration` (and `read` for the listing). They
  are not agent exposed. They are not in `IDEMPOTENT_ROUTES` (ADR 0049), which is the set of economic or irreversible writes;
  the send limit protects against a repeated request instead.
- The three routes that need a configured provider or a code only the email carries are `contractTested: false` with a
  reason, because the contract sweep cannot reach a 2xx answer for them. The cap in `tests/integration/api-contract.test.ts`
  rises from 10 to 13 for that reason. Their behaviour is tested in `tests/integration/owner-email-routes.test.ts`.

### 7. A binding id that cannot collide
- `surfaceBindingId` (`src/adapters/socialSurface.ts`) is now a hash of the whole actor id. The old id dropped punctuation, so
  `jo.smith@x` and `josmith@x` shared a primary key and the second insert failed. This closes the follow-up recorded in ADR
  0025. Ids of existing rows are not changed: the unique key `(workspace, surface, actor)` still decides which row an upsert
  updates.

## Risks accepted
- **A third party can be sent a code.** The address is typed by an owner, and a code goes to it, at most three times an hour
  per workspace. The limit is per address, so one workspace can cycle addresses. A per-workspace daily cap is the next step if
  this is seen in practice.
- **The verification mail goes to an address the owner chose.** It is a code and says so. It carries no link.
- **The notification audit events are member-visible.** `event-names.json` marks every `notification.*` event as visible to
  staff, and this ADR does not change that rule. The evidence holds only the masked address.
- **A provider that accepts a message and then times out leaves the notice in doubt.** It is not sent again. The owner sees
  the order or approval in the app either way.

## What is NOT done
- No SMS, WhatsApp or push delivery through this path. Those channels keep their existing behaviour.
- No per-event preferences, no daily digest, no bounce or complaint handling, no unsubscribe link. An owner removes an address
  in the app.
- No second public URL. `APP_BASE_URL` (ADR 0025) is the base for every link, including the email link.
- No retry of a failed send, and no re-send when an owner adds an address later (ADR 0020, ADR 0027).
- Live sending is `NOT_RUN`. The fake provider proves the request shape, the timeouts, the errors and the ledger behaviour, not
  the provider's acceptance.

## Verification
- `tests/unit/owner-email-content.test.ts`: sanitising, the 80-character limit, the sentence per kind, the link, no approve link
  or token, no customer text, unknown kinds refused, the verification mail, masking and address rules.
- `tests/unit/email-config.test.ts`: the base URL rule and the environment rules (startup refusal names a variable, never a
  value).
- `tests/unit/resend-transport.test.ts`: a local fake server. Success, 4xx, 5xx, timeout, a malformed 2xx, an unreachable host,
  one request per send (no retry), and no key, address, subject or provider body in any error or log line.
- `tests/integration/owner-email-routes.test.ts`: owner only (staff 403, anonymous 401, cross-tenant 404), simulated refusal, the
  send limit and its `Retry-After`, the attempts limit, the expiry, a wrong code, the binding a verified address creates and
  its idempotent re-verification, removal, a removed-and-re-added address, a pre-existing binding left alone, audit rows with
  masked addresses, and responses with no code or hash.
- `tests/integration/owner-email-notices.test.ts`: a real approval through the replenishment flow sends exactly one email to a
  verified owner; a second trigger sends none; a provider failure leaves the approval pending, is audited, and is not resent;
  two verified owners are each told once; a removed address is not told; a customer note never reaches an email; with no
  provider the notice is simulated and nothing reaches the fake.

## Consequences
- An owner who sets up email receives one real message for each approval or held, declined or part-filled customer order, and
  opening the link decides nothing.
- Nothing is sent until an operator sets `BIND_EMAIL_PROVIDER`. A deployment without it behaves exactly as before.
- The email path adds one table for codes, one for the send count and one per-owner ledger key suffix. The surface binding
  id is a hash now, which changes only new bindings.
