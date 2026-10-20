# ADR 0023: The pause covers payments; a stock count is kept during a pause; audit rows name the real actor

## Status
Accepted (2026-10-19). Implements Task 6c of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`: the follow-ups
from the Task 6b review. Builds on ADR 0022 (the pause switch and webhook authentication) and ADR 0021 (workspace tokens).
ADR 0022 is not edited. Its "Not done" items on settlement and on the owner literal are resolved here.

## Context
After ADR 0022, three gaps remained:
1. `OrderSettlementService.settle` sent the USDC transfer while `workspaces.agents_paused` was true. `POST
   /api/orders/:id/reconcile` could pay an order that was already confirmed.
2. A stock count from a surface while paused stored the quantity, then answered 400 with the `[AGENTS_PAUSED]` error from
   `startReplenishment`. The count was kept, but the caller saw an error for a valid fact.
3. The literal `owner@bind.local` was still the audit actor in document extraction (staff can call it), in workspace
   onboarding, and in agent role configuration. Those rows named an owner who was not identified.

## Decision

### What the pause blocks
| Action | While the workspace is paused |
|---|---|
| Starting a replenishment (`POST /api/workspaces/:id/replenish`) | Refused with `[AGENTS_PAUSED]` (400). No workflow, no quote request. (ADR 0022) |
| A commitment through the gate, including approving a held order | Denied with `AGENTS_PAUSED` (409 `POLICY_DENIED`). A pause wins over every escalation. (ADR 0022) |
| A payment (`settle`): `POST /api/orders/:id/reconcile`, and owner document confirmation that completes a match | Not sent. See below. |
| A stock count from a surface, below par | The count is stored. No replenishment starts. The event is answered 200 (see below). |

**Payments, in code.** `settle` checks the order's match and payee holds first. Then it re-reads `agents_paused` for the
order's workspace. The check sits after the match and the holds and before the transfer effect (`settlement.transfer_usdc`),
inside the claimed section. When the flag is true:
- The claim is released to the status the order had before the call (`confirmed` or `payment_hold`). Nothing else changes:
  no transfer, no effect row, no transaction hash, no restock, no journal entry, no workflow transition.
- Audit row `settlement.paused_hold`: actor type `system`, actor id `settlement_engine`, decision `DENY`, evidence
  `{ orderId, hold: "AGENTS_PAUSED" }`.
- The result is `{ status: MATCHED, reconciled: false, hold: "AGENTS_PAUSED" }`. The reconcile route answers 200 with that
  body, not an error. `ReconcileHold` gains `AGENTS_PAUSED`.

A hold that already applies is reported first. An order held for an unverified supplier stays `payment_hold` with
`SUPPLIER_NOT_VERIFIED` while paused, and reports `AGENTS_PAUSED` only once the supplier is fixed.

**Document confirmation.** `POST /api/workspaces/:id/documents/:docId/confirm` calls `settle`, so it is held the same way.
It still answers 200 (the staged document is confirmed), with `hold: "AGENTS_PAUSED"` and `reconciled: false` in the body.
The order stays `confirmed`. The owner calls reconcile again after resuming.

**Stock counts, in code.** `SURFACE_STOCK_OBSERVED` writes the observed quantity first, as a fact. When the workspace is
paused and the count is below par, `startReplenishment` is not called. The answer is 200 with the usual fields,
`replenishmentTriggered: false`, `replenishmentResult: null` and `replenishmentSkipped: "AGENTS_PAUSED"`. The
`replenishmentSkipped` field appears only when a replenishment was skipped. A skipped replenishment is not queued. After
the owner resumes, the next count below par, or a manual replenishment, starts one.

### What the pause does not block
- **Confirming a payment that was already sent**: `POST /api/orders/:id/confirm-settlement` (`confirmSettlement`). It asks
  the adapter for the outcome and pays nothing. Recording that money already moved is a fact, not a new commitment.
- **An order already reconciled**: it still returns its stored result, with `alreadyReconciled: true`.
- **Reads**: every `GET` route.
- **Staff document extraction**: it stages a draft and commits nothing.
- **Owner administration**: the pause toggle itself (so the owner can resume), token issue and revoke, spending policy,
  suppliers, agent roles, surface bindings, the webhook secret view and rotation.
- **Rejecting or revoking an approval**: it commits nothing.
- **An owner accepting a held customer order** (`acceptHeldOrder`): a human decision that moves no money through the commitment gate (ADR 0026). Any restock it triggers is still refused while paused (ADR 0027).

### Audit actors
- Document extraction: `actor_type` is the token's role (`owner` or `staff`), `actor_id` is the token label. Evidence is
  unchanged. Action `document.extract_staged`.
- Workspace onboarding: `actor_type` `system`, `actor_id` `system:workspace-create`. The workspace does not exist yet, so
  there is no token. Action `workspace.onboard_configured`.
- Agent role configuration: `actor_type` `owner`, `actor_id` is the owner token's label. Action `agent_role.configure`.
- `extractDocumentDraft(workspaceId, rawInput, actor)`, `onboardBlankWorkspace(rawInput, actor)` and
  `upsertAgentRole(workspaceId, rawInput, actor)` take an `AuditActor` (`src/auth/tokens.ts`). The parameter is required,
  with no default. The routes pass the actor: the token's role and label, `system:workspace-create`, or the owner's label.
- `grep -rn "owner@bind.local" src --include=*.ts | grep -v "^src/ui"` prints nothing.
- `src/ui/` is not touched (ADR 0016). The orphaned UI still sends `decidedBy: "owner@bind.local"`. The server ignores
  the body's `decidedBy` on every route (ADR 0021, ADR 0022).

## Test changes (recorded, per AGENTS.md)
- **Added**: `tests/integration/settlement-pause.test.ts` (7 tests, including one extra: an order held for a payment
  problem is released to that hold while paused), `tests/integration/surface-pause.test.ts` (1 test) and
  `tests/integration/audit-actors.test.ts` (3 tests).
- **Call site only**: `tests/integration/studio-settle-once.test.ts` calls `extractDocumentDraft` directly. It now passes the
  required actor `{ type: "owner", id: "settle-once-test" }`. No assertion changed.
- No existing assertion changed.

## Consequences
- A paused workspace sends no transfer through the server. An order that was payable stays payable and is paid once
  after the owner resumes and reconciles.
- A stock count is never refused because of a pause, so a surface bridge does not retry a valid fact.
- Audit rows name the actor that made the change. The label is a token label, which is only as strong as the token (ADR 0021).

## Known risks and not done
- **Race window.** The pause is re-read immediately before the transfer, but the re-read and the adapter call are not in one
  transaction. A pause written in that window can still pay. Closing it fully needs a lock that the external transfer
  cannot take. The window is one database round trip. This is recorded, not hidden.
- Document confirmation while paused confirms the document but not the payment. The owner must reconcile after resuming.
  A later task can queue this explicitly. Nothing is queued silently here.
- A skipped replenishment is not queued (see above).
- A pending approval is still re-checked at approval (ADR 0022). The pause does not cancel it.
- The surface bridge is trusted with the workspace secret (ADR 0022).
- `docs/RELEASE_EVIDENCE.md` is updated at the release step, not here.
