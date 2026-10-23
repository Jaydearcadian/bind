# ADR 0005: Approval lifecycle (decide once, expire, reject, revoke)

## Status
Accepted (2026-10-19)

## Context
An approval gates a commercial commitment: a replenishment order above the workspace
threshold waits in `awaiting_approval` until the owner decides. Before this change:

- `approve` checked neither `expires_at` nor the approval's current status before submitting.
- `reject` updated the approval row but left its workflow in `awaiting_approval` forever.
- The surface-card reject path wrote the approval row directly and skipped the workflow.
- There was no revoke operation, and nothing applied the `expired` status.
- An unknown approval id surfaced as a generic `400`.

## Decision
1. **One statement moves the approval and its workflow together.** `WorkflowEngine.resolveApproval`
   updates the approval (only while `pending` and `expires_at > NOW()`) and the linked workflow
   (only while `awaiting_approval`) in a single data-modifying CTE. A crash cannot leave an approved
   approval attached to a workflow that is still waiting, and two concurrent approvals cannot both win.
2. **Three decisions, three outcomes.**
   - `approved` → workflow `authorized`, then submitted through the existing supplier path.
   - `rejected` → workflow `cancelled`, reason stored in `error_message`.
   - `revoked` → workflow `cancelled`, for an owner who withdraws a pending proposal.
   No decision submits an order except `approved`.
3. **Expiry is enforced at decision time and on read.** A decision after `expires_at` marks the
   approval `expired`, cancels its workflow, and returns `APPROVAL_EXPIRED`. Listing a workspace's
   approvals also runs `expireApprovals` for that workspace only, so a stale card never shows as
   actionable. There is no background sweeper yet. Add one when a worker process exists.
4. **Typed errors map to HTTP status.** `APPROVAL_NOT_FOUND` → `404`; `APPROVAL_NOT_PENDING` and
   `APPROVAL_EXPIRED` → `409`, with a `code` field. Other failures keep the existing `400`.
5. **New route:** `POST /api/approvals/:id/revoke`. Reject and revoke share `declineApproval`.

## Consequences
- A second decision on a resolved approval is refused and submits nothing, which the crash and
  duplicate-event rules require.
- Callers that relied on `reject` returning `200` for an already-decided approval now get `409`.
  The UI shows the error.
- `decidedBy` is still supplied by the client. This ADR does not add authentication. See ADR 0006.
- No schema change. `approvals.status` has no check constraint, so `revoked` and `expired` need no migration.

## Verification
`tests/integration/approval-lifecycle.test.ts` (8 tests): single approval, concurrent double
approve, reject, revoke, expiry, workspace-scoped sweep, unknown id, and a reject after approval.
Browser: the Revoke button is wired in `src/ui/public/app.js`, but no browser test covers it yet.
