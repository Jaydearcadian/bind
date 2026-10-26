# ADR 0091: Analytics reports: provider interface, simulated provider first, deterministic analysis

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
- **Materiality.** Two values are "about the same" unless they differ by at least 5% of the larger one (`MATERIAL_RELATIVE_DIFFERENCE`).
  The comparison uses the values the text prints: reach medians to one decimal place, rates to 0.1%. So the text never says "did worse"
  for two numbers it prints as equal, and a five-post difference of a fraction of a percent is not reported as a finding.
- **Ranking order.** Every post is placed once, in one fixed order: engagement rate descending, then the provider's post id ascending.
  The top three are the head of that order. The bottom three are the tail of the same order, read from the end, so the two lists never
  share a post. Ties are therefore broken by id, and the bottom list shows the highest id first among tied posts.
- **Hours** are read in the account's time zone through `Intl` (`h23`). The tests cover a spring and an autumn daylight-saving change
  in New York, and midnight as hour 0. Ties between hours are broken by the lower hour first.
- **Wording.** The text says "did better" or "did worse" (or "about the same"). It never gives a cause ("because", "due to" and similar
  are absent, and a test checks it).
- The findings are typed (`Findings`). `renderReportText` makes the plain-English text from them.

### 4. Storage: idempotent sync, one report per period
- `analytics_accounts`, `analytics_posts` and `analytics_reports` (`src/db/schema.sql`, additive). Every table carries
  `workspace_id`; every foreign key to a workspace row is composite on `(workspace_id, id)`.
- **A sync is an upsert** keyed by `(workspace_id, account_id, external_id)`, in one statement with `unnest`. The posts are sorted by
  the provider's id first, so two syncs take the row locks in the same order. The count of posts inserted and updated is returned, and
  a second sync of the same window inserts nothing. The window is the last 90 UTC days, ending at the start of the sync's day.
- **A report is written at most once per period.** The key is `(workspace_id, account or all brands, kind, period)`. The insert is
  `ON CONFLICT DO NOTHING`; when nothing is inserted, the existing row is returned. The unique index uses `COALESCE(account_id, '')`,
  because two NULLs are never equal in a plain unique index, and an all-brands report would otherwise be written twice.
- **A period with no stored posts is refused, not stored.** `409 ANALYTICS_NO_DATA_YET`. Without this, a report asked for before the
  first sync would keep an empty result for its period, and the owner could not correct it.
- Periods are UTC days: `period_start` inclusive, `period_end` exclusive. A period is 1 to 92 days and ends by today.
- The weekly report covers the last full ISO week (Monday to Monday, UTC).

### 5. The owner's notice: at most once, naming nothing
- A report is ready for the owner through the existing owner-notice path (`sendOwnerNotification`, ADR 0074). Its kind is
  `analytics_report`, its operation is `notifications.send_summary` (an external request), and its effects-ledger key is
  `${workspaceId}:notify:analytics_report:${reportId}`, with the recipient suffix ADR 0074 uses for an additional owner address.
- The text is "Your report is ready." and a link to the app's front page. For simulated data it is "Your report is ready (sample
  data)." The notice names no finding, no figure, no account and no brand. The closing line says that reading it changes nothing.
  The WhatsApp or Telegram message says the same.
- **At most once per (workspace, report, recipient).** A recipient whose ledger row is `completed` is not contacted again. A row that
  is `started` or `failed` is not sent again either, and is not audited again.
- **Failures are recorded at first sight.** A notice whose row was written and then left `started` (the send may have reached the
  provider) is `notification.in_doubt`, audited in the same pass. A row marked `failed` (the provider refused) is `notification.failed`,
  audited in the same pass. The worker's tick report counts them (`failed`, `noticesInDoubt`).
- **A send that fails before its ledger row exists is tried again (review S-D).** Nothing was sent and nothing is recorded, so it is
  not audited at once. The report stays not done, and each later delivery tries that recipient again. `analytics_reports.notice_attempts`
  counts the deliveries that found a recipient untried. At `MAX_NOTICE_ATTEMPTS` (3) the recipient is audited once as
  `notification.failed` (`reason: not_attempted`) and the report is done. A retry that succeeds is sent once, with no audit row.
- **Each report is done once.** `analytics_reports.notice_done` is set when every recipient has been dealt with: sent, already sent,
  failed, in doubt, none to tell, or retries exhausted. The weekly job lists only the reports that are not done. A workspace with no
  owner contact is done at once, so it never holds a batch slot. A crash between two recipients leaves the report not done, and the
  next pass sends only the recipients that have no row yet. Recipients with a row are never sent again.
- Email delivery off, or simulated, and demo refusal behave as the other owner notices do: the dispatcher and the recipient resolver
  are unchanged.

### 6. The weekly job (opt-in, worker step 6)
- Off unless `BIND_ANALYTICS_REPORTS=true` (`docs/RUNBOOK.md`, section 6.3). The entry point builds the worker's options with
  `workerOptionsFromEnv` (`src/workers/options.ts`), so the switch is one tested function. Any other value is ignored.
- Each pass takes the active accounts of workspaces whose template has an analytics data source, that have no weekly report for the
  last full ISO week and are not in backoff, oldest-due first, at most 25. For each it syncs (unless the account was attempted within
  the minimum interval) and writes the week's report, then delivers the notice.
- **Backoff.** A failed sync or report puts the account into backoff: 15 minutes after the first failure, doubling, capped at 12 hours.
  A provider that is not available or that answers invalid data waits the full 12 hours at once. A successful sync resets the backoff.
  A report that fails after a good sync does not reset it: the sync resets the count, so the job passes the count the account had before
  the pass, and the wait keeps doubling while the report keeps failing (review S-A). A report that is written clears the backoff.
  Over 48 hours with a report that always fails and a pass every 16 minutes, the provider is called 9 times. The gaps between calls are
  16, 32, 64, 128, 240, 480, 720 and 720 minutes: the 15, 30, 60 and 120 minute steps, quantised to the 16-minute pass grid
  (`tests/integration/analytics-notices.test.ts`).
  Broken accounts therefore cannot fill every batch: they are retried later, and the healthy accounts are served first (tested with 30
  broken accounts older than one healthy one).
- **Minimum interval.** Each sync attempt, manual or by the worker, claims the account with one conditional update: it succeeds only
  when the previous attempt is at least `BIND_ANALYTICS_MIN_SYNC_INTERVAL_MS` old (default 5 minutes). The API answers a refused manual
  sync with `429 ANALYTICS_SYNC_TOO_SOON` and `Retry-After`. The worker treats a refused sync as "already synced", and writes the report
  from the posts stored.
- **Timeout.** A provider call has 20 seconds, and the provider is sent an abort signal. A provider that does not answer in time is
  abandoned with `502 ANALYTICS_PROVIDER_UNAVAILABLE`, nothing is stored, and the account backs off. The pass also starts no new
  account or notice after 120 seconds (`ANALYTICS_PASS_DEADLINE_MS`), so one slow provider cannot hold the tick.
- **Audit only a sync that changed data.** A stored post is rewritten only when one of its values differs (its `synced_at` is still
  stamped on every sync, so the account view shows the latest sync). `analytics.synced` is written, in the same transaction as the
  rows, only when at least one post was inserted or changed. A re-sync of unchanged posts writes no audit row. `updated` in the sync
  result still counts every existing post the sync covered.
- **Scoped passes (tests only).** `runWeeklyAnalyticsReports` and the worker tick take `workspaceIds` / `analyticsWorkspaceIds`. The
  integration tests use them so one file's pass cannot reach another file's rows. Production passes neither, so the job runs over every
  real analytics workspace.
- A pass does nothing that was already done. Demo workspaces and disabled accounts are not selected at all (the query excludes them),
  so they are not attempted and cannot fail.

### 7. Refusals and tenancy
- A workspace whose template has no analytics data source gets `400 TEMPLATE_HAS_NO_ANALYTICS` on every write, the same way the stock
  routes refuse a template with no stock (ADR 0084). The reads answer `[]` (accounts and reports) and `404` (one report), as the stock
  reads answer `[]`. A workspace that names no template is refused too: the module check fails closed.
- Writes are owner only (staff get 403). A demo workspace refuses every write with `403 ANALYTICS_DEMO_REFUSED`; its reads still work.
- Every query is scoped to the workspace in the path. Another workspace's account or report id is `404`.
- **Connecting accounts is bounded under concurrency.** The account count is taken under the workspace's row lock (`SELECT ... FOR UPDATE`
  on the workspace row), so twenty concurrent connects give exactly ten accounts and ten `409 ANALYTICS_ACCOUNT_LIMIT`.
- A connect request with an `Idempotency-Key` is replayed: the same key and body give the first account, not a second one (tested).

### 8. Audit, events and the evidence allowlist
- Three audit actions for the feature: `analytics.account_created`, `analytics.synced` and `analytics.report_generated` (member-visible).
  Their evidence holds ids, the provider's name, `status`, and counts only. Two notice actions are reused: `notification.in_doubt` and
  `notification.failed`, with the kind, the report id and the effect id.
- The event evidence allowlist gains three count keys: `posts`, `inserted` and `updated`. **These keys carry numbers only**: a string
  or a list under one of them is dropped (`src/api/events.ts`, tested). The rule that no free text leaves the server is unchanged.
- The sync audit row is written in the same transaction as the upsert.

### 9. API and MCP
- Six routes (`src/api/registry.ts`, `src/server/app.ts`): `GET` and `POST` accounts, `POST` sync (owner, `Idempotency-Key`), `GET`
  reports and report, and `POST` reports (owner, `kind: "on_demand"` only, idempotent per period).
- **Contract coverage, as built.** Four of the six routes are `contractTested: false`: the account creation, the sync, the report
  creation and the report by id. The shared contract fixture is a kitchen workspace, which has no analytics module, so these routes
  cannot succeed there. Their reasons are recorded in the registry. Their response schemas are checked instead by
  `tests/integration/analytics.test.ts`, which parses real responses with the registry's schemas. The excluded-GET list in
  `tests/integration/api-contract.test.ts` gained the report-by-id route, and `MAX_NOT_CONTRACT_TESTED` rose from 13 to 17 for the four
  routes (ADR 0052 and 0074 set the same kind of cap for their routes). The two read routes are contract-tested on the kitchen fixture:
  they answer `[]`.
- Idempotency-Key: the sync and the account creation are in `IDEMPOTENT_ROUTES`. The idempotency test names both as keyed for a reason
  other than economic (a provider call, and a row per call). Neither is economic or irreversible.
- The exposure classification (`docs/ecosystem/exposure.json`) is `preview` for all six. The sync is `external_request`; the account
  creation is `owner_configuration`; the report write is `operational`.
- Two read-only MCP tools: `list_analytics_reports` and `get_analytics_report`. Both are `read`. Neither writes an audit row (tested),
  and no analytics write is on the MCP allowlist.

### 10. Errors
- New codes in `src/server/error-contract.ts` and `docs/ecosystem/spec/error-catalogue.json`: `TEMPLATE_HAS_NO_ANALYTICS`,
  `ANALYTICS_PROVIDER_NOT_AVAILABLE`, `ANALYTICS_PROVIDER_OUTPUT_INVALID` (502), `ANALYTICS_PROVIDER_UNAVAILABLE` (502),
  `ANALYTICS_ACCOUNT_NOT_FOUND`, `ANALYTICS_REPORT_NOT_FOUND`, `ANALYTICS_ACCOUNT_DISABLED`, `ANALYTICS_ACCOUNT_LIMIT`,
  `ANALYTICS_DEMO_REFUSED`, `ANALYTICS_SYNC_TOO_SOON` (429, with `Retry-After`) and `ANALYTICS_NO_DATA_YET` (409).

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
  and a report over one account reads its hours in that zone. This is tested end to end: a New York account's report reports
  `America/New_York`.
- An all-brands report pools the accounts' posts and reads hours in UTC: one hour has to mean one thing across brands.
- This is a reversible choice. A workspace-level zone can replace the account column later, with the report code unchanged.

### 13. Test seams
- `setAnalyticsProviderForTests` replaces the provider for chosen accounts, and sets the sync timeout. It works only when `NODE_ENV` is
  `test`, and production code cannot arm it. Tests use it to make a provider hang or refuse, and to check the backoff sequence.
- `BIND_ANALYTICS_MIN_SYNC_INTERVAL_MS` is a configuration value that the analytics integration test sets to zero (no throttle) for
  its repeated syncs, and to 5 minutes for the throttle test. The vitest configuration is not changed.

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
- **A crash in the middle of one notice send.** If the process dies while the provider call is in flight, the ledger row stays
  `started`. The next pass does not resend it and does not audit it either (the audit is written by the pass that saw the failure). The
  owner sees the report in the app. This is the at-most-once rule (ADR 0017), not a gap in the audit.
- **Reports are fixed when written.** A later sync that brings new posts for an already-written period does not update that report. A
  correction is a new period, not a rewrite.
- **The all-brands report pools the posts of different brands,** so its medians mix brands. It is for an overview. It names no brand.
- **A report step that fails every time is retried for ever, on the backoff.** It costs one provider call and one failed report per
  step, at the 12-hour cap at most. Tracking it further (a stop after N failures, an owner notice) is not built.
- **Real providers are not built.** The backoff, the timeout and the throttle are tested with fake providers. Their values (15 minutes,
  12 hours, 20 seconds, 5 minutes) are a first choice, to be revisited when a real provider's rate limits are known.

## Consequences
- The owner can connect a simulated account, sync, and read a report for any period. The weekly job is off until it is switched on.
- A real platform can be added later as one more provider, behind the same validator, with the simulated provider still available for
  tests. Its data is never stored unless it passes the validator.
- Nothing in this slice moves money, posts, replies or runs an ad. The template still declares none of those.

## Verification
- Unit (`tests/unit/analytics-*.test.ts`, `worker-options.test.ts`): the analysis (golden text, the sample guards, zero reach, ties,
  daylight-saving hours, materiality and rounding, the follower and country breakdowns, the ranking, determinism), the validator (the
  rejects, the dropped text, the 24:00 rule), the simulator, the notice text (real and simulated), the template, the flag builder, and
  the event allowlist's numeric keys.
- Integration, on a private database: `tests/integration/analytics.test.ts` (refusals, tenancy, roles, staff refused on every write with
  no row and no audit written, the demo refusal, the connect limit under 20 concurrent requests, idempotent connects, the sync upsert and
  its replay, the minimum interval with `Retry-After`, a hanging provider and the backoff sequence, the report once per period under
  concurrency, the zero-post refusal, the New York time zone, the response schemas of the four routes outside the contract sweep) and
  `tests/integration/analytics-notices.test.ts` (the notice at most once, concurrent deliveries, email off, no contact, the crash between
  report and notice, the crash during the send, a refused send, in-doubt and failed sends audited by the worker at first sight, the
  weekly job's gate, isolation, replay, disabled and demo accounts, the batch of one with an owner who cannot be mailed, and 30 broken
  accounts older than one healthy account, an account in backoff not called six minutes later, the 48-hour backoff schedule with a
  failing report, the 120-second budget constant, the provider abort signal, the no-data deferral, the upsert order, a re-sync with no
  change writing no audit row, and the notice retry: a recipient untried for three deliveries is audited once and the report is done).
  The worker tick and the job both run at a real clock or a scoped set of workspaces, so the suite is hermetic across files (review S-C).
- The mutation checks and their results are in `docs/RELEASE_EVIDENCE.md`, section 0d.
