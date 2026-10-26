# ADR 0090: Analytics reports: provider interface, simulated provider first, deterministic analysis

## Status
Accepted (2026-10-26), as the first slice. Builds on ADR 0084 (`social-v1` and its descriptive `dataSources`), ADR 0017 (the effects
ledger), ADR 0074 (owner notices by email), ADR 0029 (the worker) and ADR 0049 (idempotency keys on the API). A real platform
adapter is NOT part of this decision. No network call is made to any platform, and no credential is read or stored.

## Context
The social media manager template (ADR 0084) says it will read a brand's post analytics and report what worked. Its
`dataSources` entry points at a platform that is not connected, so the template promises a capability the code cannot yet
deliver. The owner needs to see the shape of the reports (what worked, and what the owner can check) before any account is
connected, and the screens need real data to build against.

The work is split so the risky part is last. The provider boundary, the validation, the analysis, the report storage and the
owner's notice are built and tested against a simulated provider. A real adapter is a later decision with its own review.

## Decision

### 1. A provider interface, and only the simulated provider is available
- `PostAnalyticsProvider` (`src/analytics/types.ts`): an id, an `isSimulated` flag, `capabilities` (which breakdowns the provider
  supplies: per-post reach, follower split, hour of day, country, media type), `listAccounts()` and `fetchPosts({ accountId,
  since, until })`.
- `src/analytics/simulated-provider.ts` is the one provider. It is deterministic: its posts for a UTC day are a function of
  (workspace, account, day). It is labelled `isSimulated: true`, and every report that uses it says so at the top of the text
  and in its findings.
- The API accepts `provider: "simulated"` only. Any other value is `400 ANALYTICS_PROVIDER_NOT_AVAILABLE`. A stored account whose
  provider is no longer available is refused the same way on sync, before anything is read.

### 2. Untrusted data: no free text from a platform, ever
- Provider output is untrusted (AGENTS.md). `src/analytics/validate.ts` is the only way provider output becomes a stored post.
- It reads an allowlist of keys only. Any other key (a caption, a comment, a bio, a link) is dropped without being read.
- Ids follow one pattern (letters, digits, `_ . : -`, 1 to 128 characters). An id with a space, a line break or a sentence is
  refused, so free text cannot pass as an id.
- Counts are whole numbers from 0 to 1e9. A NaN, an infinity, a fraction, a negative, a numeric string or a boolean is refused.
  Reach cannot exceed impressions; a follower or country count cannot exceed reach; the two follower counts come together.
- A refusal throws `AnalyticsProviderOutputError` (`ANALYTICS_PROVIDER_OUTPUT_INVALID`, 502). Its message names the field and the
  rule, never the value. A malformed answer stores nothing.
- Stored rows (`analytics_posts`) hold ids, enums, counts, timestamps and the country map. The report text and the findings are
  built from numbers and ids only. The brand label is not copied into a report, a notice or an event.

### 3. Deterministic analysis, with sample-size guards
- `analysePosts` (`src/analytics/analyse.ts`) is pure: no model, no I/O, no clock. The same posts and options always give the same
  findings and text. The input is sorted into a fixed order before anything is counted, so arrival order does not change the answer.
- **A comparison is never stated from fewer than 5 posts in a group** (`MIN_GROUP_POSTS`). The text says "Not enough posts yet"
  instead. This applies to the format groups, the hours (at least two hours with 5 posts each), the follower split, the country
  list and the post ranking.
- **Engagement rate** is (likes + comments + saves + shares) / reach. A post with no reach has no rate and is left out of every rate.
  No division by zero is possible.
- **Ties** are broken by a fixed order: the hour (lower first) for hours, the provider's post id for posts. When every eligible hour
  has the same median reach, the text says no hour stood out.
- **Hours** are read in the account's time zone through `Intl` (`h23`). The tests cover a spring and an autumn daylight-saving change
  in New York, and midnight as hour 0.
- **Wording.** The text says "did better" or "did worse". It never gives a cause ("because", "due to" and similar are absent, and a
  test checks it).
- The findings are typed (`Findings`). `renderReportText` makes the plain-English text from them.

### 4. Storage: idempotent sync, one report per period
- `analytics_accounts`, `analytics_posts` and `analytics_reports` (`src/db/schema.sql`, additive). Every table carries
  `workspace_id`; every foreign key to a workspace row is composite on `(workspace_id, id)`.
- **A sync is an upsert** keyed by `(workspace_id, account_id, external_id)`, in one statement with `unnest`. The count of posts
  inserted and updated is returned, and a second sync of the same window inserts nothing. The window is the last 90 UTC days,
  ending at the start of the sync's day, so the same day gives the same window.
- **A report is written at most once per period.** The key is `(workspace_id, account or all brands, kind, period)`. The insert is
  `ON CONFLICT DO NOTHING`; when nothing is inserted, the existing row is returned. The unique index uses `COALESCE(account_id, '')`,
  because two NULLs are never equal in a plain unique index, and an all-brands report would otherwise be written twice. Ten concurrent
  requests write one report and one audit row (tested).
- Periods are UTC days: `period_start` inclusive, `period_end` exclusive. A period is 1 to 92 days and ends by today.
- The weekly report covers the last full ISO week (Monday to Monday, UTC).

### 5. The owner's notice: at most once, naming nothing
- A report is ready for the owner through the existing owner-notice path (`sendOwnerNotification`, ADR 0074). Its kind is
  `analytics_report`, its operation is `notifications.send_summary` (an external request), and its effects-ledger key is
  `${workspaceId}:notify:analytics_report:${reportId}`, with the recipient suffix ADR 0074 uses for an additional owner address.
- The text is "Your report is ready." and a link to the app's front page. It names no finding, no figure, no account and no brand.
  The closing line says that reading it changes nothing. The WhatsApp or Telegram message says the same.
- **At most once per (workspace, report, recipient).** A recipient whose ledger row is `completed` is not contacted again. A row that
  is `started` or `failed` is not sent again: the dispatcher reports it in doubt, audits it as `notification.in_doubt`, and sends
  nothing (ADR 0017). Replay after a crash before the notice sends it once; replay after a crash during the send does not send it
  again (both tested with the fake provider and the fault injection that the effects ledger already has).
- Email delivery off, or simulated, and demo refusal behave as the other owner notices do: the dispatcher and the recipient
  resolver are unchanged.

### 6. The weekly job (opt-in, worker step 6)
- Off unless `BIND_ANALYTICS_REPORTS=true` (`docs/RUNBOOK.md`, section 6.3). Any other value is ignored, like the restock sweep.
- Each pass syncs each active account of a workspace whose template declares an analytics data source, if that account has no weekly
  report for the last full ISO week, then writes the report. A second step tells the owner about each weekly report of that week
  whose primary recipient has no ledger row yet. Both steps are bounded by the worker's batch size (25), and each account or notice
  is isolated: one failure is counted in `analyticsReports.failed` and the others still run.
- Demo workspaces are not swept. A disabled account is not synced.
- Replaying a pass does nothing that was already done (tested).

### 7. Refusals and tenancy
- A workspace whose template has no analytics data source gets `400 TEMPLATE_HAS_NO_ANALYTICS` on every analytics route, the same
  way the stock routes refuse a template with no stock (ADR 0084). A workspace that names no template (a blank workspace) is refused
  too: the module check fails closed.
- Writes are owner only (staff get 403). A demo workspace refuses every write with `403 ANALYTICS_DEMO_REFUSED`; its reads still work.
- Every query is scoped to the workspace in the path. Another workspace's account or report id is `404`. An account of one workspace
  named in another workspace's report request is `404 ANALYTICS_ACCOUNT_NOT_FOUND`.
- A workspace holds at most 10 analytics accounts (`409 ANALYTICS_ACCOUNT_LIMIT`).

### 8. Audit, events and the evidence allowlist
- Three audit actions: `analytics.account_created`, `analytics.synced` and `analytics.report_generated`. They are member-visible
  (staff see them, as the spec's table requires), and their evidence holds ids, the provider's name, `status`, and counts only.
- The event evidence allowlist gains three count keys: `posts`, `inserted` and `updated` (`src/api/events.ts`). They are numbers. The
  allowlist's rule (no free text) is unchanged; `docs/EVENTS.md` names the new keys.
- The sync audit row is written in the same transaction as the upsert.

### 9. API and MCP
- Six routes (`src/api/registry.ts`, `src/server/app.ts`): `GET` and `POST` accounts, `POST` sync (owner, `Idempotency-Key`, added to
  `IDEMPOTENT_ROUTES`), `GET` reports and report, and `POST` reports (owner, `kind: "on_demand"` only, idempotent per period). Every
  route is contract-tested with a sample body where its preconditions are safe, so the contract sweep needs no raised cap.
- The exposure classification (`docs/ecosystem/exposure.json`) is `preview` for all six. The sync is `external_request`; the account
  creation is `owner_configuration`; the report write is `operational`.
- Two read-only MCP tools: `list_analytics_reports` and `get_analytics_report`. Both are `read`. Neither writes an audit row (tested),
  and no analytics write is on the MCP allowlist.

### 10. Errors
- New codes in `src/server/error-contract.ts` and `docs/ecosystem/spec/error-catalogue.json`: `TEMPLATE_HAS_NO_ANALYTICS`,
  `ANALYTICS_PROVIDER_NOT_AVAILABLE`, `ANALYTICS_PROVIDER_OUTPUT_INVALID` (502), `ANALYTICS_PROVIDER_UNAVAILABLE` (502),
  `ANALYTICS_ACCOUNT_NOT_FOUND`, `ANALYTICS_REPORT_NOT_FOUND`, `ANALYTICS_ACCOUNT_DISABLED`, `ANALYTICS_ACCOUNT_LIMIT`,
  `ANALYTICS_DEMO_REFUSED`.

### 11. The template
- `social-v1` now names its real ids: data source `post_analytics` (kind `post_analytics`, read only, labelled simulated until a
  provider is connected); triggers `weekly_report` (schedule, the worker flag) and `on_demand_report` (manual); output
  `analytics_report`. The `post_published` event trigger is removed: nothing emits it. The change to the assertions in
  `tests/unit/social-template.test.ts` and `tests/integration/social-template.test.ts` is deliberate, and the no-posting, no-ads, no-
  spend and no-commitment assertions are unchanged.
- `ANALYTICS_SOURCE_KIND` lives in `src/templates/types.ts`, which has no imports, so a template can use it without a circular import.

### 12. Time zone: per account, because the workspace has none
- The brief asks for the workspace time zone. No workspace has one today. Adding one to `workspaces` would change a core table and its
  seeding for one feature. The zone is stored on the analytics account (`time_zone`, default `UTC`, an IANA name, checked by Intl),
  and a report over one account reads its hours in that zone.
- An all-brands report pools the accounts' posts and reads hours in UTC: one hour has to mean one thing across brands.
- This is a reversible choice. A workspace-level zone can replace the account column later, with the report code unchanged.

## What a real Meta adapter will need (not built; to be verified against Meta's current documentation)
This slice makes no call to Meta and asserts no Meta API detail. Before a real adapter is built and reviewed, each of the following
must be checked against Meta's current documentation, with the date checked:
- the account type and the permission or scope a business account needs to read post insights (to be verified);
- which metrics exist for a post, and whether reach, impressions and plays are available per post (to be verified);
- whether a follower or non-follower split and a country breakdown are available per post, and in what unit (to be verified);
- how long insight data is retained, and whether a sync window older than that is refused (to be verified);
- the rate limits and the request quota for the account, and how the adapter backs off (to be verified);
- how an access token is issued, refreshed and revoked, and where it is stored (through the credentials store, ADR 0024, and never
  in a model context or an event) (to be verified);
- what a removed or changed post looks like on a later sync, and whether the upsert needs a delete path (to be verified);
- the review step that checks a real adapter's output against the same validator this slice uses, and a fixture of recorded
  responses, with `LIVE_READ_PASS` reserved for a read against a real account that someone has authorised (not yet).
Until then, every report says it is simulated.

## Known limitations (recorded, not handled in this slice)
- **Several owner addresses and a crash between two of them.** The weekly job's second step decides "already told" from the primary
  recipient's ledger row. If the process dies after the first recipient is told and before a later one, the later recipients are not
  told in a later pass. The report is in the app either way. The on-demand route sends no notice.
- **A workspace with no owner contact.** Its weekly reports are not listed by the second step, so they are not revisited. The report is
  written and readable. No notice is recorded, which is correct.
- **The weekly job retries a failing account on every tick** (every 15 seconds), counting each failure. It does not back off. A broken
  account therefore produces a bounded but repeated error count until it is fixed or disabled. A backoff is the next step if this
  shows up in the metrics.
- **The all-brands report pools the posts of different brands,** so its medians mix brands. It is for an overview, not for comparing
  brands. The report says nothing about which brand a post belongs to.
- **A report is not updated when a later sync brings new posts for its period.** The period is fixed when the report is written, as
  the brief asks. A correction is a new period, not a rewrite.

## Consequences
- The owner can connect a simulated account, sync, and read a report for any period. The weekly job is off until it is switched on.
- A real platform can be added later as one more provider, behind the same validator, with the simulated provider still available for
  tests. Its data is never stored unless it passes the validator.
- Nothing in this slice moves money, posts, replies or runs an ad. The template still declares none of those.

## Verification
- Unit: `tests/unit/analytics-analyse.test.ts` (27 tests: the group medians, the sample guards, zero reach, ties, the daylight-saving
  hours, the follower and country breakdowns, the ranking, determinism and the text), `tests/unit/analytics-validate.test.ts` (the
  rejects: NaN, infinity, negatives, fractions, huge counts, unknown media types, free-text ids, impossible dates; the caption that is
  dropped without being read), `tests/unit/analytics-simulated.test.ts` (determinism, the window, validation of its own output, the
  shape), `tests/unit/analytics-notice-and-template.test.ts` (the notice text, the ledger key, the template declaration).
- Integration, on a private database: `tests/integration/analytics.test.ts` (the refusals, tenancy, roles, the demo refusal, the account
  limit, the sync upsert and its replay, the report once-per-period under ten concurrent requests, the all-brands report, the period
  rules, the MCP read tools writing no audit row) and `tests/integration/analytics-notices.test.ts` (the notice at most once, ten
  concurrent deliveries, email off, no contact, the crash between report and notice, the crash during the send, a refused send, the
  weekly job's gate, isolation, replay, disabled and demo accounts, and the worker flag).
- The mutation checks and their results are in `docs/RELEASE_EVIDENCE.md`, section 0d.
