# ADR 0002: Template-Driven Business Agent Engine Architecture

## Status
Accepted

## Context
`BIND_BUILD_SPEC.md` specifies a commercial kitchen as the initial vertical slice. However, real hackathon traction (30% of the Tameion judging rubric) requires genuine business usage, real/testnet USDC payment flow, and actual operational problem-solving during the event window. Building solely a rigid, hardcoded kitchen simulator risks synthetic isolation if the operator does not run a physical restaurant.

## Decision
We adopt a **Template-Driven Business Agent Engine**:
1. **Domain-Agnostic Core Engine**:
   * The policy evaluation engine, three-way document matching (`Order` ↔ `Receipt` ↔ `Invoice`), idempotency guards, durable state machine, Circle wallet integration, Arc L1 settlement, and Web2 surface adapters (WhatsApp, Email, Telegram) are 100% agnostic.
2. **First-Class Templates**:
   * **Template 1: Kitchen Vertical Slice (`kitchen-v1`)**: Retains full fidelity to `BIND_BUILD_SPEC.md` with simulated food distributors (Sysco, Baldor), ingredient replenishment, and kitchen fulfillment.
   * **Template 2: Digital Agency / Dev Studio (`agency-v1`)**: Enables immediate live dogfooding by the operator to manage real/testnet contractor milestones, API billing (Nebius, Parallel, OpenAI), client invoices, and cash runway.
3. **Workspace Provisioning**:
   * A business workspace specifies `template_id` (`kitchen-v1` or `agency-v1`) during onboarding, instantly binding the corresponding roles, tools, and threshold defaults.

## Consequences
* Satisfies the mandatory Kitchen vertical slice and all testing gates from `RUN_BIND_ONESHOT.md`.
* Unlocks immediate dogfooding and real traction with contractor payments and API spend.
* Prevents premature platform over-engineering by constraining the templates to two concrete, fully implemented workflows.
