# ADR 0084: Stock and suppliers are optional template modules; a social media manager template

## Status
Accepted (2026-10-24), as an experiment. Each part is small and reversible: remove the `social-v1` template and the descriptive fields to undo it.
The descriptive fields change no behaviour.

## Context
A template (ADR 0002) was roles plus `seedInventory` and `seedSuppliers`. That shape only fits a business that buys stock. Bind is meant to be
business-agnostic, so a template with no stock or purchasing has to be a valid template, and provisioning, onboarding, the starter list and the API must
not assume stock.

## Experiment framing
We are trying three businesses that differ on purpose, to see which parts of the template shape are general and which are kitchen-specific:

- a commercial kitchen (`kitchen-v1`): buys stock, orders from suppliers, needs replenishment;
- a digital agency (`agency-v1`): buys contractor time and API credits, and invoices clients;
- a social media manager (`social-v1`): buys nothing, reads analytics and writes reports and drafts. It has no stock and no supplier.

The third template is the first test of the optional-module shape. Nothing here names a real business or person. The template is "a social media manager".

## Decision

### 1. Stock and suppliers are optional modules
- A template with no `seedInventory` has no stock module. A template with no `seedSuppliers` has no purchasing module. Provisioning and onboarding
  already skipped missing seeds. This change makes the rest tolerate them.
- `GET /api/templates` adds a derived `modules: { stock, suppliers }` to each template. It is computed from the template, not stored.
- A replenishment start (`POST /api/workspaces/:id/replenish`) and a stock write (`POST /api/workspaces/:id/inventory`) on a workspace whose
  template is a known template without stock are refused with `400`, the repo's error body, and `code: "TEMPLATE_HAS_NO_STOCK"`. The refusal happens
  before any workflow or row is written. A paused workspace keeps its existing `AGENTS_PAUSED` answer, which comes first.
- A workspace whose `template_id` names no template (a blank workspace from `POST /api/workspaces/onboard`, whose template id is its own id) is not
  refused. Its stock routes behave as before.
- Reading inventory returns `[]` for a stock-less workspace. Supplier routes stay generic data endpoints and are not refused.
- The starter list on Today hides the "Approve a real supplier" step when the template has no purchasing module. An unknown template keeps the step.

### 2. Descriptive metadata: `dataSources`, `triggers`, `outputs`
- Three optional fields on the template type, as data only. `dataSources` (id, label, kind, `readOnly: true`), `triggers` (id, kind
  `schedule` | `event` | `manual`, description), and `outputs` (id, kind `report` | `notice` | `order`, description).
- They are exposed through the existing template listing and documented in the OpenAPI schema.
- **No behaviour is wired to them.** No agent is gated by a `dataSource`, no worker fires from a `trigger`, and no output is produced from an
  `outputs` entry. Wiring any of them needs its own decision, and the check that makes it safe must be code, not this metadata.
- Filled for the kitchen only where it is plainly true: its stock levels are read (`inventory_levels`); the restock sweep is a schedule trigger, but only
  when `BIND_RESTOCK_SWEEP` is on (the description says so); the owner's manual reorder is a manual trigger; a purchase order is an `order` output.
- The agency template is left without the three fields. Its billing and invoicing behaviour is described in its roles, but no code path shows a clear
  data source, trigger or output yet. It can be filled later.

### 3. `social-v1`: a social media manager
- Roles, all with `spendingLimitCents: 0n`. No role has `commercial_commitment`.
  - `analytics_agent`: reads post analytics per brand (reels against other posts, followers against non-followers, time of day, country). Effects `read`, `external_request`.
  - `reporting_agent`: turns the findings into a short report and sends the owner a notice. Effects `read`, `external_request`.
  - `content_planner_agent`: drafts a content calendar and copy. Drafts only. Effect `read` only.
- `defaultDailyLimitCents` and `defaultApprovalThresholdCents` are `0n`. No money moves in this template.
- `dataSources`: `instagram_insights` (read only). `triggers`: a weekly schedule (`weekly_report`) and a post-published event (`post_published`).
  `outputs`: one `report`.
- Posting, ads and replies are not in this template. The description says so, and says that anything public or paid needs a later, separately
  approved capability.

## Consequences
- The template shape now has three cases: stock and purchasing, purchasing only (none today), and neither. The stock routes refuse the last case. Only
  the stock-less template exercises the refusal; the unit and integration tests cover it.
- `dataSources` for `social-v1` is declared, not connected. No Instagram adapter exists, so the analytics agent cannot read real insights today.
  The template gives the owner the shape, and the adapter is a later step with its own tests.
- The web onboarding sign-in still offers only the kitchen and agency teams. `social-v1` is created through the API (`POST /api/workspaces`) for now.
- An existing test changed: `tests/unit/kitchen-template.test.ts` asserted that `listTemplates()` returns exactly 2 templates. It now asserts 3 and
  checks that `social-v1` is registered. This is the only change to an existing test, and it is forced by adding a third template. The kitchen and
  agency role assertions are unchanged.
- Not changed, and noted for later: `onboardBlankWorkspace` still creates a `procurement_agent` role with `commercial_commitment`. That path is not template
  based, so it sits outside this ADR. The settings page still shows a non-kitchen template by its raw id.

## Verification
- Unit: `tests/unit/social-template.test.ts` (shape, no commercial commitment anywhere, every limit `0n`, no stock or purchasing module, read-only
  data source, the refusal predicate, and the kitchen and agency modules unchanged). The count assertion in `kitchen-template.test.ts` is updated as above.
- Integration: `tests/integration/social-template.test.ts` on a private database. It creates a `social-v1` workspace through `POST /api/workspaces`,
  checks the stored roles and limits, lists the template with its modules, refuses replenish and the stock write with `TEMPLATE_HAS_NO_STOCK` and
  writes nothing, checks cross-tenant refusal, and checks that the kitchen replenish and stock write are unchanged.
- The API contract was regenerated with `npm run api:spec`, `npm run sdk:generate` and `npm run capabilities:generate`. `docs/CODEBASE_MAP.md` could not
  be regenerated in the worktree (no `.ua` graph) and was not edited by hand.
