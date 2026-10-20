# ADR 0026: Customer orders are promised only when stock and kitchen capacity cover them

## Status
Accepted (2026-10-20). Implements Task 8a of `docs/superpowers/plans/2026-10-19-bind-completion-plan.md`. Builds on ADR 0015
(one commitment gate), ADR 0021 (workspace tokens and tenancy), ADR 0023 (the pause), and ADR 0016 (the UI is orphaned, so this
is API only; `src/ui/` is not touched).

## Context
The kitchen template has a second agent role, `fulfilment_agent`, whose job is to take customer orders from a POS, a messaging
surface or an API caller. Until now Bind had no customer order, no stock reservation and no kitchen capacity. A promise to a
customer is a commitment: accepting an offer is a commercial commitment (AGENTS.md). Two things must hold: Bind never gives a
date it cannot back with stock and capacity, and customer text never changes a quantity, a price or an approval.

## Decision

### Effect class
- `orders.accept_customer` is classified `commercial_commitment` in `OPERATION_EFFECT_MAP` (`src/policy/effect-classifier.ts`).
- The kitchen template's `fulfilment_agent` keeps `read` and `external_request` only. It is **not** granted more. An automated
  acceptance is therefore checked by `PolicyEngine.evaluate` for that role and held when the grant is missing.

### Who decides
| Actor | Role check | Pause check | Result when short |
|---|---|---|---|
| Automated (`fulfilment_agent`, via `POST /api/workspaces/:id/customer-orders`) | Required. Missing row, disabled role or no `commercial_commitment` holds the order for the owner (`ROLE_NOT_PERMITTED`) | Required. A paused workspace holds the order for the owner (`AGENTS_PAUSED`) | Held orders report the hold reasons only. Stock and capacity are not evaluated until the owner decides |
| Owner (`POST .../:orderId/accept`, for a held order) | Not needed (a human owner's decision) | See "Pause" below | Re-checked against current stock and capacity at the moment of acceptance |

Staff may create, cancel and fulfil. They may not accept a held order or set kitchen capacity (403).

### Promise rule (`src/workflows/fulfilment-promise.ts`, pure)
Rules are evaluated in order:
1. **Invalid input** (an empty line list, more than 50 lines, a quantity that is not an integer from 1 to 10000, or a duplicate sku in one
   order) is `declined` with `INVALID_QUANTITY`. Nothing else is reported and nothing is reserved. Duplicate skus are refused, not merged.
2. **Holds** (automated actor only): `ROLE_NOT_PERMITTED` and/or `AGENTS_PAUSED`, both reported when both apply, status `needs_owner`.
3. **Per line**: unknown sku (`UNKNOWN_SKU`), or `onHand - reserved < quantity` (`INSUFFICIENT_STOCK`). All lines short is `declined`.
   Some lines covered and some not is `partially_available`: no date, no reservation.
4. **Capacity**, only when every line is covered: the promise is `startsAt` of the earliest slot at or after `max(now, requestedFor)` with
   `capacityUnits - usedUnits >= units`. None is `declined` with `NO_CAPACITY_SLOT`. A requested time after every slot is declined, never
   given an earlier slot. `promisedFor` and `slotId` exist only on `accepted`.

One capacity unit is one unit of quantity; `units` is the sum of line quantities.

### Locks and transactions (`src/workflows/fulfilment.ts`)
- Creating an order runs in one transaction. The order row is inserted first with `ON CONFLICT (workspace_id, external_ref) DO NOTHING`.
  A concurrent attempt for the same `externalRef` waits on that insert. Once the first commits, the second loads the stored order.
- Lock order is always: order row, then inventory rows by sku (`FOR UPDATE`), then kitchen capacity rows by start time (`FOR UPDATE`).
  Reserved quantities and slot usage are read only under these locks.
- Fulfilment locks the order row and then the inventory rows, and checks on-hand stock before it changes anything.
- A slot update (`setKitchenCapacity`) is one upsert per slot, in time order, that applies only when `used_units <= new capacity`. One
  refused slot rolls back the whole batch.

### Idempotency and replay
- Identity is the `externalRef` within the workspace. `request_hash` covers the lines (sorted by sku) and `requestedFor`. It does not cover
  the note.
- The same `externalRef` with the same identity returns the stored result with `replayed: true`. No second reservation, booking or audit row
  is written. A different identity is refused with `EXTERNAL_REF_REUSED` (409).

### Customer text is data
- `note` is trimmed and truncated to 500 characters. It is stored and returned by the reads. No decision reads it. It is never part of the
  request hash. It is never written to an audit row. Route error messages never echo it.
- Quantity, price, approval and payment are not taken from it. The integration test
  `customer text in an order note cannot change quantity, price or approval` checks lines, reservations, status, the approvals and orders row counts,
  and the stored unit price.

### Pause
- Automated orders are held while the workspace is paused (ADR 0023: the pause covers commitments made by agents).
- **Deliberate difference from ADR 0023's table.** ADR 0023 denies "approving a held order" while paused, and that row concerns the
  commitment gate's approvals. This task follows the explicit requirement for customer orders: the owner can still accept a held order
  while the workspace is paused, after the stock and capacity are checked again. The reasoning is that the pause stops agents, and an owner's
  own decision is a human act. This is recorded here so the owner can change it. To align with ADR 0023, add a pause check in
  `acceptHeldOrder`, and change the test that asserts owner acceptance while paused (its title is in the Task 8a brief). Nothing else changes.

### Records
- Accepted: a `stock_reservations` row per line (`active`), `kitchen_capacity.used_units` increased by `units`, `slot_id` and `promised_for` stored.
- Lines are stored only for a valid request. An invalid request keeps its reasons, with `units` 0 and no lines.
- `decided_by` is `agent:<roleName>` or `owner:<label>`. It is set on accept, decline and hold. Cancel and fulfil do not change it; their actor is in the audit row.
- Audit rows (`audit_logs`, one per change in the same transaction): `customer_order.accepted|partially_available|declined|held|cancelled|fulfilled`
  and `kitchen_capacity.set`. Actor type is `agent`, `owner` or `staff`, with the label or role name as the id. Policy decision: `ALLOW`
  for accepted, cancelled and fulfilled; `REQUIRE_APPROVAL` for held; `DENY` for declined and partially available.
- Effect class: `commercial_commitment` when an accepted commitment is made, changed (cancelled) or fulfilled, and for `kitchen_capacity.set`
  (owner configuration, the precedent in ADR 0021). `read` for the other decision rows.
- Evidence holds ids, status, reason codes, units and the slot. It holds no customer text and no `externalRef`.

### Cancel and fulfil
- Cancel: an `accepted` or `needs_owner` order becomes `cancelled`, its active reservations become `released`, and an accepted order's slot
  gives back its units. A cancelled order is a no-op. A fulfilled order is refused with `ALREADY_FULFILLED`. Other statuses cancel with nothing to release.
- Fulfil: only `accepted` (`NOT_ACCEPTED` otherwise). A fulfilled order is returned unchanged. Each reserved quantity leaves `current_quantity` once and its
  reservation becomes `consumed`. If any sku is short, nothing changes (`INSUFFICIENT_ON_HAND`). A fulfilled order keeps its slot units: the kitchen did
  that work, so only a cancel gives units back.

### Access and tenancy
- Every query filters by `workspace_id`. A cross-workspace order id is `null` from the read and `ORDER_NOT_FOUND` (404) from the other operations.
- Routes (all listed in the route table in `tests/integration/auth-tenancy.test.ts`):

| Method | Path | Access |
|---|---|---|
| GET | `/api/workspaces/:id/customer-orders` | member (last 100, newest first) |
| POST | `/api/workspaces/:id/customer-orders` | member; 201 for a new order, 200 for a replay |
| GET | `/api/workspaces/:id/customer-orders/:orderId` | member |
| POST | `/api/workspaces/:id/customer-orders/:orderId/accept` | owner |
| POST | `/api/workspaces/:id/customer-orders/:orderId/cancel` | member |
| POST | `/api/workspaces/:id/customer-orders/:orderId/fulfil` | member |
| GET | `/api/workspaces/:id/kitchen-capacity` | member |
| PUT | `/api/workspaces/:id/kitchen-capacity` | owner (at most 200 slots) |

- Error codes: `ORDER_NOT_FOUND` 404; `EXTERNAL_REF_REUSED`, `NOT_HELD`, `NOT_ACCEPTED`, `ALREADY_FULFILLED`, `CAPACITY_BELOW_USED`,
  `INSUFFICIENT_ON_HAND` 409; invalid input 400. An unexpected error is 500 with a generic message.

### Schema
- Four additive tables in `src/db/schema.sql`: `customer_orders`, `customer_order_lines`, `stock_reservations`, `kitchen_capacity`.
  The status values are checked by the database. A workspace's `agent_roles` id is `role_<workspace>_<role>`, which must fit `VARCHAR(64)`.

## Not done (later tasks)
- **Partial acceptance.** A partly covered order is `partially_available` with no reservation. The customer re-submits with a new `externalRef`.
- **Prices and payment.** Customer prices, invoices and payment are out of scope. A customer line is an inventory SKU, and nothing is charged.
- **Owner notification and the low-stock replenishment trigger** (Task 8b).
- **SKU-to-recipe consumption.** A customer line consumes its own SKU, not the ingredients of a dish.
- **Delivery tracking** of fulfilled orders.
- **Re-check of a held order when the role is granted.** A grant does not decide held orders retroactively. The owner accepts them.
- **Race window for the pause.** The pause is read inside the decision transaction. A pause written after that read but before the owner's commit is not seen
  (the same class of window as ADR 0023).

## Consequences
- A customer is promised a time only when it is backed by reserved stock and a slot with room. Concurrency tests show 20 concurrent orders
  cannot oversell 5 units, and 10 concurrent orders cannot overbook a 3-unit slot.
- A retried request, including a concurrent retry, is one order with one reservation set.
- The fulfilment role cannot commit on its own until the owner grants `commercial_commitment`. The grant is a deliberate owner action, not a default.
