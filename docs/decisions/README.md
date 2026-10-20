# Architecture decision records: index

Each record is in this folder as `NNNN-title.md`. The status and title below were read from each file's header on 2026-10-20
(Task 14). Corrections made in Task 14:

- ADR 0006: the title no longer says "(OPEN)". Its status was already "Accepted; implemented by 0021". A historical note now
  marks its "Consequences until decided" section as out of date.
- ADR 0003 and ADR 0004: a status note now says that their "Verification" and deployment results are earlier-session claims
  that were not reproduced (see the appendix of `docs/RELEASE_EVIDENCE.md`), and ADR 0003 says the daily limit is a fixed
  window, not rolling.

Every record is dated 2026. "Accepted" means the decision stands. It does not mean the code it describes was verified against
a live system: `docs/RELEASE_EVIDENCE.md` is the place for that.

| ADR | Title | Status | One line |
| --- | --- | --- | --- |
| [0001](0001-build-boundaries.md) | System boundaries, architecture stack, and settlement model | Accepted | TypeScript on Node. What Bind owns and what it integrates. Settlement is local by default; Arc testnet is opt-in. |
| [0002](0002-template-driven-architecture.md) | Template-driven business agent engine | Accepted | A domain-agnostic engine with business templates. The kitchen comes first. |
| [0003](0003-onchain-policy-enforcement.md) | On-chain policy enforcement on Arc L1 | Accepted (corrected 2026-10-20) | A daily limit and vendor allowlist in `BindSettlement.sol`. The limit is a fixed window, not rolling. |
| [0004](0004-serverless-deployment-and-derived-artifacts.md) | Serverless (Vercel) deployment and derived artifacts | Accepted (note added 2026-10-20) | The serverless build writes derived files to `/tmp`. Its deployment results are earlier claims, not reproduced. |
| [0005](0005-approval-lifecycle.md) | Approval lifecycle | Accepted | An approval is decided once. Expire, reject and revoke each change the approval and its workflow in one statement. |
| [0006](0006-owner-authentication-open.md) | Owner authentication for approval decisions | Accepted; implemented by 0021 (title corrected) | The options for owner authentication. Option 1 was chosen in 0021. |
| [0007](0007-agent-skills-installed.md) | Agent skills installed for the completion work | Accepted | Third-party coding skills were reviewed and installed for the workflow. They are not part of the product runtime. |
| [0008](0008-reconcile-exactly-once.md) | Reconcile exactly once | Accepted | A second reconcile neither pays nor restocks again. The studio path had the same gap, which is recorded. |
| [0009](0009-no-invented-documents.md) | No invented documents, one settlement path | Accepted | A bill or a receipt on its own never moves money. Documents are not made up to make a match. |
| [0010](0010-serial-integration-files.md) | Integration files run one at a time | Accepted | The integration tests share one database, so they run one file at a time. |
| [0011](0011-supplier-payee-from-record.md) | The payee comes from the verified supplier record | Accepted | A payment goes to the supplier's own payment address. A missing address holds the payment. |
| [0012](0012-contract-test-chain.md) | Contract artifact and in-process test chain | Accepted | The compiled contract is checked by hash. The in-process EVM is a client test, not Anvil. |
| [0013](0013-arc-settlement-truthful-states.md) | Arc settlement reports only what the chain returned | Accepted | Settlement is `submitted`, `confirmed` or `failed`. No hash is made up. |
| [0014](0014-settlement-confirmation.md) | An order is paid only after the transfer is confirmed | Accepted | A submitted transfer is not a payment until it is confirmed. |
| [0015](0015-single-commitment-gate.md) | One commitment gate, decided in code and re-checked at approval | Accepted | Every commitment is decided by one function and checked again when the owner approves. |
| [0016](0016-ui-orphaned-api-first.md) | The current UI is orphaned; the build is API first | Accepted | `src/ui` is not maintained. The product surface is the API, SSE, the SDK and MCP. |
| [0017](0017-effects-ledger.md) | Durable ledger for external effects | Accepted | Each external call runs at most once per key. An unknown outcome is recorded as in doubt. |
| [0018](0018-order-reservation-and-recovery.md) | Reserve spend before the supplier call | Accepted | Spend is reserved under a workspace lock before the supplier is called. Recovery goes through the ledger. |
| [0019](0019-settlement-through-the-ledger.md) | The settlement transfer goes through the effects ledger | Accepted | Transfers go through the ledger. Adapters can look a transfer up. |
| [0020](0020-notifications-and-ids.md) | Approval notifications through the ledger; random row ids | Accepted | An owner notice is sent at most once. The journal stays outside the ledger. Row ids are random. |
| [0021](0021-workspace-tokens.md) | Per-workspace owner and staff tokens | Accepted | Bearer tokens, stored hashed, with owner and staff roles. Tenancy is checked on the server. |
| [0022](0022-webhook-authentication.md) | Webhooks prove who sent them; surface actors; a real pause switch | Accepted | HMAC over the raw body, a replay window, and surface actors taken only from bindings. |
| [0023](0023-pause-covers-payments.md) | The pause covers payments | Accepted | A paused workspace sends no payment and starts no restock. The race window that remains is recorded. |
| [0024](0024-connector-credentials.md) | Connector credentials: encrypted, owner-only, reported honestly | Accepted | Credentials are encrypted at rest with one environment key. No live verifier exists, so nothing is `verified`. |
| [0025](0025-notification-recipient-and-link.md) | Approval requests go to the owner's own binding | Accepted | Notices go to the owner's own binding with a plain link. Supersedes the recipient part of 0020. Nothing is delivered. |
| [0026](0026-customer-orders-and-promises.md) | Customer orders are promised only when covered | Accepted | A customer is promised a time only when reserved stock and slot capacity cover it. |
| [0027](0027-owner-notice-and-restock-trigger.md) | Owner notice and restock trigger | Accepted | The owner is told when an order is held or declined. A restock starts from available stock. |
| [0028](0028-feedback-and-menu-proposals.md) | Feedback is data; menu changes need approval and publish | Accepted | Feedback is counted, not acted on. A menu change goes live only after owner approval and an owner publish. |
| [0029](0029-worker-loop.md) | A background worker runs expiry, recovery and settlement confirmation | Accepted | One loop in the server process. It does not run on serverless. |
| [0030](0030-cancel-attention-sweep.md) | Owner cancel, needs-attention list, restock sweep, lost-claim fix | Accepted | The owner can cancel a workflow. The restock sweep is opt-in and off by default. |
| [0031](0031-untrusted-input.md) | Untrusted input cannot grant authority or leak internals | Accepted | Input is bounded and checked. Errors reach clients in a fixed, safe form. |
| [0032](0032-observability-and-lifecycle.md) | Logs, request ids, readiness, metrics, migration lock, shutdown | Accepted | Redacted structured logs and request ids. Metrics are per process. Shutdown waits for in-flight requests. |
| [0033](0033-rate-limits.md) | Rate limits on failed authentication, webhooks and public creation | Accepted | Limits are in memory, per process. They are off in `NODE_ENV=test`. |
| [0034](0034-api-contract.md) | The API contract: one route registry and a generated OpenAPI document | Accepted | One registry, checked against the running server. Schemas are lower bounds; no runtime validation. |
| [0035](0035-event-stream.md) | A replayable, ordered event stream per workspace | Accepted | Audit rows are sent as ordered events, with a poll fallback. An idle transaction can hold back every stream. |
| [0036](0036-sdk.md) | A typed, dependency-free client SDK | Accepted | A TypeScript client with no runtime dependencies. Tested under Node only. Not published. |
| [0037](0037-mcp-server.md) | An MCP tool server over the SDK | Accepted | 17 tools, each one API call. None can approve, pay, reconcile, change policy or touch a credential. |
| [0038](0038-contract-gates-and-ci.md) | Contract gates, CI layout, and what has not run | Accepted | Records what could not run here (Forge, Anvil, Slither, CI, live Arc) as BLOCKED or NOT_RUN. |
| [0039](0039-contract-properties-and-live-check.md) | Contract property tests, reentrancy, and an honest live check | Accepted | In-process property and reentrancy tests. The Forge invariant files and the live check have not been run. |
| [0040](0040-cleanup-round-13c.md) | Cleanup round for known defects | Accepted | The ledger GET is read-only, typed pause and restock codes, atomic approval decisions, and a restock key fix. |
| [0041](0041-api-casing.md) | API field casing is frozen as it is; new fields are camelCase | Accepted | The API is already mixed. No rename now. Any future unification is versioned, and a UI should go through the SDK. |
| [0042](0042-model-driven-mcp-check.md) | A real model drives the MCP server | Accepted | A real model used the tools correctly and resisted an injected note. One tool description was wrong and is fixed. |
| [0043](0043-brand-direction-draft.md) | Brand direction, draft 1 | Superseded | An earlier ring-and-latch draft, withdrawn and removed. Replaced by ADR 0044. |
| [0044](0044-brand-study-1.md) | Brand study 1: the handoff | Superseded | A dovetail mark study. Replaced by ADR 0045; kept as a record. |
| [0045](0045-bead-ring-brand.md) | The bead ring is the brand direction | Accepted | The ring's own wordmark, type and palette, with a copper bead that is also the dot of the i. Canonical in `docs/brand/`; the other directions are in `docs/brand/archive/`. |
| [0046](0046-ecosystem-audit.md) | Ecosystem audit round 1 and the capability catalogue | Accepted | 67 operations classified; a generated, tested catalogue; 14 findings; no payment protocol; specify before building. |
| [0047](0047-response-and-event-spec.md) | Response model and event surface specification, draft 1 | Accepted | Additive: an idempotency key, `_meta`, error v2, event envelope v1 and outbound webhooks. Draft schemas and tests only; nothing built. |
| [0048](0048-error-body-v2.md) | Error body v2 is live | Accepted | Every error gains code, category, retryable and requestId, added in one place. Existing text and status are unchanged. |
| [0049](0049-client-idempotency-keys.md) | Client idempotency keys | Accepted | `Idempotency-Key` on 18 write operations, scoped by workspace, token and key, with replay for 24 hours. |
| [0050](0050-response-meta.md) | `_meta` on command responses | Accepted | Outcome status, state, next actions for the caller's role and warnings, on the 18 command operations. Additive. |
