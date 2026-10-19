# ADR 0015: One commitment gate, decided in code and re-checked at approval

## Status
Accepted (2026-10-19)

## Context
Commitment decisions were made in two places that disagreed. `request_policy_evaluation` in
`src/agents/replenishmentTools.ts` had inline checks and created approvals with raw SQL. `PolicyEngine`
in `src/policy/engine.ts` had its own amount rules and no production caller. `approveAndSubmit` trusted an
approval made earlier, so limits, supplier status and quote expiry were never re-checked when the owner
approved. A role limit of 0 was treated as "no limit", and a missing `agent_roles` row was silently allowed.

## Decision
- `src/policy/commitment-gate.ts` is the only place a commitment of money is decided.
  - `decideCommitment(facts, input)` is pure. `authorizeCommitment(input)` loads the facts from PostgreSQL
    and calls it.
  - Every read is scoped to `workspace_id = input.workspaceId`. A quote or supplier from another workspace
    is not found, so it yields `QUOTE_NOT_FOUND` or `SUPPLIER_NOT_VERIFIED`.
- Rules are evaluated in order and every denial is collected:
  1. Role: the `agent_roles` row for `actorRole` must exist, be enabled and hold `commercial_commitment`.
     A missing workspace also denies here, since a workspace cannot have a role without one.
  2. Supplier: must exist in the workspace and be verified.
  3. Quote: must exist in the workspace (`QUOTE_NOT_FOUND`) and not be past `valid_until` (`<=` now is expired).
     The caller's `supplierId`, `quantity` and `totalPriceCents` must equal the quote row (`QUOTE_CHANGED`).
  4. Amount: `INVALID_AMOUNT` when the quote row's `total_price_cents` or `quantity` is <= 0, or when the caller's
     `quantity` or `totalPriceCents` is <= 0. A zero or negative commitment is never valid.
  5. Daily limit: committed spend today plus the quote amount must not exceed `budget_daily_limit_cents`
     (inclusive). Spend counts orders in `SPEND_COUNTING_ORDER_STATUSES` created today, excluding the order
     `ord_<workflowId>`.
- The amount is always the quote row's `total_price_cents`.
- Escalations are considered only when nothing was denied: amount above the role limit
  (`ROLE_LIMIT_EXCEEDED`), amount above the workspace approval threshold (`ABOVE_APPROVAL_THRESHOLD`), and
  `ownerReviewRequested` (`OWNER_REVIEW_REQUESTED`). All escalation reasons are reported together.
- Precedence: DENY over REQUIRE_APPROVAL over ALLOW. A denial reports only the denial codes.
- A role limit of 0 escalates every positive amount. Zero is not "unlimited".
- A role-limit breach is an escalation, not a denial, so an owner can authorize it. The daily cap stays the
  hard limit. This keeps the shipped behaviour.
- `ownerReviewRequested` (scorer or model) can only add `REQUIRE_APPROVAL`. It can never allow, and it
  cannot change a denial.
- The on-chain vendor whitelist is not read by the gate. `BindSettlement.sol` enforces it, and a rejected
  transfer already moves the order to `payment_hold`. The `CANONICAL_ARC_LOCK.whitelistedVendor` comparison is
  removed from the decision and from the decision record. The supplier wallet on a proposal is never used for
  authorization.
- The decision record's `onChainPolicyPreFlight.vendorWhitelisted` (and `selectedVendor.isWhitelistedOnChain`) is
  widened to `boolean | null`. The replenishment path passes `null`, meaning "not checked by Bind". Every rendering
  shows it as "not checked": the rationale reads `On-chain whitelist=not checked by Bind (enforced by
  BindSettlement.sol)`, and the anti-drift state anchor reads `NOT_CHECKED_BY_BIND`. A null never counts as a
  failed whitelist. `requiresOwnerOverride` is true only when the daily cap is exceeded or the whitelist check
  returned `false`.
- `PolicyEngine` is kept as the role stage. `evaluate` covers tenancy, role enabled and the effect grant, and
  `decideCommitment` calls it. Its amount, supplier, daily and threshold logic is deleted because the gate
  owns those rules now. `effect-classifier.ts` is unchanged.
- `request_policy_evaluation` calls `authorizeCommitment` and:
  - DENY: the workflow becomes `failed`. `error_message` lists the reason codes and text. Audit
    `commitment.evaluate` with `DENY`.
  - REQUIRE_APPROVAL: `WorkflowEngine.createApproval("appr_<workflowId>", ...)` (the only approvals insert in
    `src/`), the owner notification, workflow `awaiting_approval`, audit `commitment.evaluate` with
    `REQUIRE_APPROVAL`.
  - ALLOW: workflow `authorized`, audit `commitment.evaluate` with `ALLOW`.
  - The tool loads the workflow with `workspace_id` as well, so it cannot read another tenant's workflow.
  - Its JSON response keeps the existing fields and adds `reasonCodes`.
- `approveAndSubmit` re-checks a pending, unexpired approval before `resolveApproval`:
  - DENY: `resolveApproval(approvalId, "rejected", "system:policy-recheck", codes)` cancels the workflow. Then
    audit `commitment.recheck` with `DENY` and the reason codes. Then `ApprovalDecisionError("POLICY_DENIED")`,
    which the route maps to HTTP 409 with `code: "POLICY_DENIED"` and `reasonCodes`. No order is written and
    no supplier is called.
  - ALLOW or REQUIRE_APPROVAL: the owner's approval is the authorization for an escalation, so the approval
    proceeds.
  - A waiting workflow with no stored proposal is denied (`QUOTE_NOT_FOUND`). The re-check never skips.
  - A decision on an approval that is not pending is left to `resolveApproval`, which keeps
    `APPROVAL_NOT_PENDING` and `APPROVAL_EXPIRED` as before.
- `WorkflowEngine.sanitizeEvidence` keeps arrays as arrays. It used to turn them into index-keyed objects, so
  reason codes in the audit log were stored as `{"0": ...}`.

## Consequences
- Every commitment path (proposal, approval, and later the owner's surface approval) goes through one function.
- A quote or price change, a supplier that was un-verified, a quote that expired, or a daily limit used up
  between the request and the owner's approval now stops the order.
- Known gaps, not closed here:
  - Race, parked for Task 5: the re-check and the order write are not in one transaction. Two concurrent
    commitments can both pass the daily check before either writes an order. Task 5 adds an advisory lock around
    the spend check and the order insert.
