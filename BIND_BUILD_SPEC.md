# Bind: product and implementation contract

## Product definition

Bind is a business agent deployment and connectivity layer. A business connects once, sets its preferences and authority, and receives role-specific agents that understand its operations and can interact with internal tools, external services, and other agents.

The product outcome is to make a business agent-capable without requiring the owner to assemble agent infrastructure.

## First vertical: kitchen

The first one-click template provisions three coordinated roles:

1. **Procurement agent**: reads stock, detects replenishment needs, finds eligible suppliers through configured adapters, requests quotes, compares them against the business's budget and preferences, and submits an order only when its authority permits it.
2. **Customer and fulfilment agent**: records or receives orders, manages fulfilment requirements and times, tracks status, and keeps the owner informed. It must not promise availability or delivery dates that the system cannot substantiate.
3. **Menu and feedback agent**: summarizes customer feedback and proposes menu or workflow improvements. It may not publish operational or UI changes outside its granted authority.

The first complete workflow is an order or low-stock event leading to inventory calculation, supplier quote request, policy evaluation, approval if needed, one authorized order, fulfilment state, and a traceable owner-facing activity history.

## Required user capabilities

- Create a business workspace and deploy the kitchen template.
- Inspect and configure each agent's role, tools, permitted effects, budget/thresholds, and approval requirements.
- Connect or configure tools with server-side credential storage. Never send secrets to the browser, model context, or plugin output.
- See current workflow state, execution evidence, tool calls, approvals, failures, retries, and the next required action.
- Approve, reject, expire, or revoke a pending operation.
- Recover a failed workflow without duplicated orders, accounting effects, or payments.
- Distinguish a simulated connector from a verified live connection.

## Integration boundaries

Choose a transport based on the actual counterparty:

- REST/OpenAPI and webhooks for ordinary business services.
- MCP for tool servers that expose a valid MCP interface.
- A2A or another verified protocol for independent remote agents.
- OpenRails only where the real SDK/runtime provides the necessary supported lifecycle, read, evidence, payment, or settlement path.

Bind's contribution is onboarding, business-specific semantics, capability selection, authority enforcement, orchestration, recovery, and auditable operations. Do not duplicate OpenRails lifecycle schemas or assume its read-only MCP can sign/broadcast transactions.

A connector authenticates and exchanges data with a service. A tool is a callable operation. A skill is a procedure for using tools. A remote agent is an independent counterparty. Keep these concepts distinct.

## Effect and authority model

Every tool/action must declare and be checked against one of these effect classes:

- `read`: inspect information without changing external state.
- `external_request`: ask another system/person for information or consideration; this is not a commitment.
- `commercial_commitment`: place an order, accept an offer, incur a charge, move funds, or otherwise bind the business.

The policy engine must check workspace membership, agent identity, effect class, per-tool grants, limits, approval conditions, request expiry, and idempotency key before execution. Natural-language model output cannot grant authority.

Represent business operations with explicit states such as `draft`, `awaiting_approval`, `request_sent`, `quote_received`, `authorized`, `submitted`, `confirmed`, `failed`, `cancelled`, and `reconciled`, using only states relevant to the actual operation. Do not collapse a request, a quote, an acceptance, and a confirmed external effect into one `success` state.

## Build boundaries

First build the complete kitchen vertical slice locally. Avoid premature work on:

- a general-purpose marketplace for all agents and plugins;
- a new agent communication protocol;
- multi-chain abstractions that do not serve the first workflow;
- a generalized clearing or saga engine unless an actual first-slice requirement needs it;
- arbitrary user-supplied executable plugin code in the main process;
- custom smart contracts without a justified trust/settlement requirement;
- live-money or production deployment paths enabled by default.

Use local fixtures/simulators for unavailable supplier systems, with obvious labelling. Implement integration boundaries so a real connector can replace the simulator; do not represent simulated behavior as live.

## Local-first target

- Run the application and dependencies locally.
- Run EVM code against Foundry Anvil with local-only funded accounts.
- Use local PostgreSQL for durable workflow state where suitable.
- Keep chain ID, contract addresses, RPC URLs, token addresses, settlement mode, and external credentials in environment configuration.
- Default to local/simulated settlement and block testnet/mainnet actions unless an explicit deployment profile and authorization are present.
- Do not require testnet credentials to complete unit, integration, contract, browser, or local end-to-end suites.

## Data and auditability

Record workflow identity, workspace/actor, triggering event, policy decision, exact tool/action, sanitized input/output evidence, approval provenance, external reference IDs, retry status, timestamps, and final reconciliation. Store only the data required for operations; redact secrets and avoid logging raw sensitive payloads. Preserve enough evidence to explain why the agent acted and what actually happened.

## Product quality

The interface should prioritize the owner's actual work: what's happening, what needs approval, what has changed, what failed, and what's next. Avoid a primitives-first console full of agent jargon. Loading, empty, permission-denied, partial, stale, offline, failed, and recovery states are part of the product, not optional polish.
