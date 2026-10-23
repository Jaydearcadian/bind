# ADR 0074: Owner notices by email, behind a default-off provider and a verified address

## Status
Accepted (2026-10-22). Builds on ADR 0017 (effects ledger), ADR 0020 and ADR 0027 (owner notices at most once), ADR 0022
(surface bindings), ADR 0025 (the owner's own recipient and a plain link), ADR 0033 (rate limits) and ADR 0057 (demo
workspaces). Live sending is `NOT_RUN`: no real provider account was contacted. Every provider call in the tests goes to a
local fake server.

## Context
- An owner was told about an approval, or a customer order that waits for them, only through a messaging binding that nothing
  delivered. `NotificationEmitter` recorded each message in memory with status `simulated`.
- Email is the one channel an owner can set up without a phone-number integration. It needs a provider, so it must be
  switched on deliberately, and an address must not be usable by someone who only typed it, or who only wrote a binding.

## Decision

### 1. One email transport, chosen by environment, off by default
- `BIND_EMAIL_PROVIDER` is the only switch. The only value is `resend`. Unset, the emitter behaves as before: email is
  recorded and labelled `simulated`, nothing leaves the server, and every existing test passes unchanged.
- Resend was chosen for a single HTTPS call with a bearer key and a JSON body. The adapter (`src/adapters/email/resend.ts`) is
  one function and needs no SDK. It is injectable (a `fetch` option, a timeout, and the base URL), so tests run against a
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
- The ledger keeps only a hash of the request (ADR 0017). For email, the request is the payload with the recipient replaced
  by the SHA-256 hex digest of the lowercased address, and the stored `request_hash` is `requestHash` of that request. The
  address is therefore never an input to the stored hash. The send itself uses the real payload. The test
  `the stored request hash is over the request with a digest of the address` checks the stored hash against both forms.
- `status: "sent"` is returned only for a 2xx answer that carries a non-empty id of at most 200 characters. Every other answer,
  including a 2xx without a usable id, is an `EmailTransportError` with a reason (`timeout`, `network`, `http`,
  `malformed_response`). The error message names the reason and, for an HTTP answer, the status. It never carries the key, the
  address, the subject or the provider's body.
- The key is redacted from every error text (`BIND_EMAIL_API_KEY` joins the configured secrets in `src/utils/redact.ts`). No
  log line carries the key or an address.

### 3. The content is plain, short, and built from facts
- Subject: `Something is waiting for you in Bind`. Body: one sentence, a link to `${APP_BASE_URL}/app/`, and the line `Open Bind
  to look at it and decide. Nothing happens until you do.`
- The sentence names what the notice is about and nothing else: for an approval, the supplier and the amount in USD. The
  supplier name is untrusted text. Control characters, line breaks and bidi controls become spaces, and the text is cut to 80
  characters. The name is first folded to NFKC and format characters (`\p{Cf}`, such as zero-width spaces) are removed, so a
  lookalike cannot hide a domain. Then an allowlist applies: letters, digits, spaces, `&`, apostrophes (straight and curly),
  full stops and hyphens (`^[\p{L}\p{N} &'’.-]+$`). A name outside it is left out, and so is one that is shaped like a domain
  in any script, that contains `www.`, or that holds six or more digits in all. Those names give the generic sentence. For an
  order the sentence is fixed and holds no order detail. The builder reads the notice kind from the payload metadata, never
  from the message text, so a customer's note or reference cannot reach an email.
- No approve or reject link, no token, no query string. The link opens the app's front page; opening it decides nothing (ADR
  0025). The verification mail carries the code and nothing else.

### 4. The owner's address is verified before it can receive a notice
- `owner_emails` (one live row per workspace and address) holds the address, the salted SHA-256 of a six-digit code
  (`code_salt`, `code_hash`), the expiry, the attempt count, `verified_at`, the id and the marker of a surface binding the row
  created (`binding_id`, `binding_marker`), and `removed_at`. A code is never stored, logged or returned. Only the email carries it.
- **Proof of control.** The owner's control of the address is `owner_emails.verified_at`: the owner received the code there and
  entered it. It is the only proof the server acts on.
- **Binding status.** The email surface binding is stored as `configured_unverified`. Verification does not change that. The
  decision is that `verified` on a surface binding stays reserved for provider-confirmed inbound identity, the case that
  `SURFACE_PROVIDER_VERIFIED` (ADR 0022) exists for. No second route to `verified` is added here.
- **Limits, all enforced in the database transaction and counted under a per-workspace lock:**
  - A code is six digits, valid 10 minutes. A new request replaces the code.
  - Five wrong guesses end a code (per code). The fifth wrong guess is still answered as a wrong code (0 attempts left); a
    guess after that is refused as exceeded.
  - Ten wrong guesses per address per 24 hours, across all its codes and re-sends (table `owner_email_failures`, one row per
    wrong guess). When the count reaches ten, the address is refused for both sending and verifying (409
    `EMAIL_ATTEMPTS_EXCEEDED`, "Too many wrong codes for this address. Try again in a day."), and nothing is sent until the
    rows age out. A successful verification of the address clears them.
  - Three codes per address per hour (table `owner_email_sends`). The count is kept per address, so removing and re-adding an
    address does not reset it.
  - Five distinct addresses per workspace per 24 hours. An address already asked for in that day is not a new one.
  - Ten codes per workspace per 24 hours, in total.
  - `Retry-After` on the limits: for the daily total, the time until the oldest send in the day ages out. For the distinct
    addresses, the time until the earliest of the day's addresses drops out of the day's set, that is the minimum over
    addresses of (its latest send + one day). For the wrong-guess cap (409), the time until the oldest counted wrong guess
    ages out. Each answers 429 `EMAIL_SEND_LIMITED`, or 409 `EMAIL_ATTEMPTS_EXCEEDED` with `Retry-After` for the guess cap.
  - Concurrency is handled by one transaction-level advisory lock per workspace (`pg_advisory_xact_lock`), taken before the
    counts are read. Without it, parallel requests all see the same counts and exceed the caps. Two tests fail without it.
- **Demo workspaces send and verify no email.** A demo (ADR 0057) answers 403 `EMAIL_DEMO_REFUSED` ("Demo workspaces do not send
  email. Use a real workspace to get owner notices by email.") on both the send and the verify route. Nothing is recorded.
- **Binding creation on verification.** It is `INSERT ... ON CONFLICT (workspace_id, surface, actor_id) DO NOTHING RETURNING
  id`. A binding is created only when none exists, so a binding written through `/surfaces` is never changed here, and a
  concurrent `/surfaces` write never fails the verification. `binding_marker` is the binding's `updated_at` when this row created
  it.
- **Removal** deletes the binding only when this row created it and the binding is unchanged (its `updated_at` still equals the
  marker). A binding that existed before the verification, or that the owner set through `/surfaces` afterwards, survives.

### 5. Recipients, and the last check before a send
- `resolveOwnerRecipients` (`src/notifications/recipients.ts`) keeps the channel order: a whatsapp binding, then a telegram
  binding, each the single recipient. Email applies only after those.
  - A demo workspace gets no email recipient at all.
  - Otherwise the owner's verified addresses (oldest verified first) are the email recipients.
  - An email surface binding is a recipient only while email delivery is **off** (the simulated behaviour before this ADR). With
    delivery on, a binding is never a recipient unless it is a verified owner address. So writing a binding through `/surfaces`
    cannot make the server mail an address.
- Several verified owner addresses are each told. The **first** recipient keeps the ledger key used before there were several:
  `${workspaceId}:notify:${kind}:${refId}`. Each **additional** recipient's key adds its `owner_emails` id:
  `${workspaceId}:notify:${kind}:${refId}:${ownerEmailId}`. Each recipient is told at most once per (kind, refId).
- Known edge: if the first recipient is removed and a notice for the same (kind, refId) is later sent again, the next owner
  receives that notice once under the bare key, although it may already have had the notice under its own key. A notice is
  not normally re-sent, so this is recorded and not handled.
- Defence in depth. With email on, `sendOwnerNotification` refuses an address that is not a live, verified owner address of the
  workspace before the ledger runs, and writes `notification.skipped_no_recipient` with reason `email_not_verified` (ids and the
  kind only). `sendOwnerNoticeEmail` checks the same rule and throws `EmailRecipientNotVerifiedError` if it is ever reached
  without it. The dispatcher turns that into the same skip.
- One recipient's failure is audited as `notification.failed` and does not stop the others.

### 6. Routes, errors and events
- `GET /api/workspaces/:id/notifications`, `POST /api/workspaces/:id/notifications/email`,
  `POST /api/workspaces/:id/notifications/email/verify`, `DELETE /api/workspaces/:id/notifications/email/:emailId`. All are
  owner only, through the same middleware as the other owner routes. Staff get 403, a token for another workspace gets 404, and
  an anonymous call gets 401.
- Refusals use the error catalogue: `EMAIL_NOT_CONFIGURED` (503), `EMAIL_DEMO_REFUSED` (403), `EMAIL_NOT_FOUND` (404),
  `EMAIL_SEND_LIMITED` (429, with `Retry-After`), `EMAIL_SEND_FAILED` (502), `EMAIL_CODE_INVALID` (400),
  `EMAIL_CODE_EXPIRED` and `EMAIL_ATTEMPTS_EXCEEDED` (409, with `Retry-After` when it is the wrong-guess cap). Malformed input is
  `INVALID_INPUT` (400).
- Audit rows, all by the owner token's label: `notification.email_code_sent`, `notification.email_send_failed`,
  `notification.email_verified`, `notification.email_verify_failed` and `notification.email_removed`. Evidence holds ids and the
  masked address (for example `o***@k***.com`), never the full address or a code. A skipped unverified send is
  `notification.skipped_no_recipient` with reason `email_not_verified`. The event names are in `src/api/event-catalogue.ts`,
  `docs/ecosystem/spec/event-names.json` and `docs/EVENTS.md`.
- The four operations are classified in `docs/ecosystem/exposure.json` as `owner_configuration` (and `read` for the listing). They
  are not agent exposed. They are not in `IDEMPOTENT_ROUTES` (ADR 0049), which is the set of economic or irreversible writes;
  the send limits protect against a repeated request instead.
- The three routes that need a configured provider or a code only the email carries are `contractTested: false` with a
  reason, because the contract sweep cannot reach a 2xx answer for them. The cap in `tests/integration/api-contract.test.ts`
  rises from 10 to 13 for that reason. Their behaviour is tested in `tests/integration/owner-email-routes.test.ts`.

### 7. A binding id that cannot collide
- `surfaceBindingId` (`src/adapters/socialSurface.ts`) is now a hash of the whole actor id. The old id dropped punctuation, so
  `jo.smith@x` and `josmith@x` shared a primary key and the second insert failed. This closes the follow-up recorded in ADR
  0025. Ids of existing rows are not changed: the unique key `(workspace, surface, actor)` still decides which row an upsert
  updates.

## Risks accepted
- **The verification mail goes to an address the owner chose.** It is a code and says so. It carries no link. The limits above
  bound how many codes one workspace can send and to how many addresses, and the wrong-guess cap bounds how long an address can
  be tried.
- **The notification audit events are member-visible.** `event-names.json` marks every `notification.*` event as visible to
  staff, and this ADR does not change that rule. The evidence holds only the masked address.
- **A provider that accepts a message and then times out leaves the notice in doubt.** It is not sent again. The owner sees the
  order or approval in the app either way.
- **A send can be refused after the ledger row has started.** The dispatcher checks the address first, so this only happens if
  an address is removed between that check and the send. The row is then failed, and a retry is in doubt, so the notice is not
  sent. The owner sees the approval or order in the app.
- **The ledger request hash for email changed in this ADR** (see section 2). Before it, a stored email request's hash was taken
  over the address. Only an effect started under the earlier hash could conflict, and only if the same key were replayed after
  the change. No such row exists in a released deployment, because email was not sent before this ADR.
- **The address pattern is letters, digits and `._+-` in the local part.** A `%` is not accepted (a deliberate narrowing;
  such addresses are rare and are refused, not guessed at).

## What is NOT done
- No per-IP limit on the send route. The per-workspace and per-address caps above are the limits. A per-IP scope in the existing
  rate limiter (ADR 0033) is the next step if it is needed.
- No SMS, WhatsApp or push delivery through this path. Those channels keep their existing behaviour.
- No per-event preferences, no daily digest, no bounce or complaint handling, no unsubscribe link. An owner removes an address
  in the app.
- No second public URL. `APP_BASE_URL` (ADR 0025) is the base for every link, including the email link.
- No retry of a failed send, and no re-send when an owner adds an address later (ADR 0020, ADR 0027).
- Live sending is `NOT_RUN`. The fake provider proves the request shape, the timeouts, the errors, the limits and the ledger
  behaviour, not the provider's acceptance.

## Verification
- `tests/unit/owner-email-content.test.ts`: sanitising, the 80-character limit, the sentence per kind, the link, no approve link
  or token, no customer text, supplier names with an address, a domain, `www.` or a long number dropped, unknown kinds refused,
  the verification mail, masking, and the stricter address rules (no leading or doubled dot, no hyphen at a label edge).
- `tests/unit/email-config.test.ts`: the base URL rule and the environment rules (startup refusal names a variable, never a
  value).
- `tests/unit/resend-transport.test.ts`: a local fake server. Success, 4xx, 5xx, timeout, a malformed 2xx, an unreachable host,
  one request per send (no retry), and no key, address, subject or provider body in any error or log line.
- `tests/integration/owner-email-routes.test.ts`: owner only (staff 403, anonymous 401, cross-tenant 404), simulated refusal, a
  demo workspace refused on send and verify, the per-address hourly limit with `Retry-After`, the sixth distinct address in a
  day refused, the eleventh code in a day refused, five concurrent sends for one address sending three, the expiry, a wrong
  code, twenty concurrent wrong guesses on one code (exactly five wrong-code answers and five counted), ten wrong guesses across
  re-sends refusing the address until the day passes, the binding a verified address creates and its idempotent re-verification,
  a concurrent `/surfaces` write racing a verification (both succeed, one binding), a binding touched through `/surfaces` after
  verification surviving removal, removal, a removed-and-re-added address, a pre-existing binding left alone, audit rows with
  masked addresses, and responses with no code or hash.
- `tests/integration/owner-email-notices.test.ts`: a real approval through the replenishment flow sends exactly one email to a
  verified owner; a second trigger sends none; a provider failure leaves the approval pending, is audited, and is not resent;
  two verified owners are each told once; a removed address is not told; a customer note never reaches an email; an
  owner-created binding with no verified address sends nothing when email is on, and so does a demo owner; the send function
  itself refuses an unverified address; the ledger row holds no address; with no provider the notice is simulated and nothing
  reaches the fake.

## Consequences
- An owner who sets up email receives one real message for each approval or held, declined or part-filled customer order, and
  opening the link decides nothing.
- Nothing is sent until an operator sets `BIND_EMAIL_PROVIDER`. A deployment without it behaves exactly as before. A demo
  workspace never sends email, whatever the provider setting.
- The email path adds two tables, one for the send count and one for the wrong guesses, a binding marker column, and a per-owner
  ledger key suffix. The surface binding id is a hash now, which changes only new bindings.
