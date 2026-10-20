# 0060: Arc is the payment rail, with fiat on and off ramps

Status: Accepted as a direction (2026-10-20), by the owner. Nothing new is built.

## Context
Bind settles in USDC on Arc behind a settlement adapter (ADR 0001), local and simulated by default, Arc testnet opt-in. The owner asked whether Bind needs it and then decided: an on-ramp and an off-ramp will be added soon, so a payment starts in fiat, travels through Arc and arrives in fiat. Agent-to-agent payments and paid services come later.

## Decision
- Arc stays and becomes the payment rail. The settlement adapter boundary stays: workflows never call Arc directly.
- Owners and suppliers deal in their own currency. The ramps convert at the edges; the app shows amounts in fiat and says plainly when a payment travels as USDC on Arc.
- The existing rules hold: a submitted payment is not a settled one; nothing is shown as paid before settlement is confirmed; agents pay only inside owner limits and approvals enforced in code; no live money without explicit authorization (AGENTS.md).

## To decide before building (owner or provider choices)
- Which on-ramp and off-ramp provider(s), and in which countries and currencies.
- Who holds funds and keys (custody model), and whether Circle developer-controlled wallets (ADR 0001) remain the choice.
- Identity checks (KYC/KYB) for businesses and suppliers, and who performs them.
- Fees, limits, refunds, chargebacks and failed conversions, and how each shows in the ledger.
- Legal advice on money transmission and licensing where Bind operates.

## Consequences
- New states to model and show: funding pending, converting, on chain, settled, paid out, failed, refunded.
- The ledger and reconciliation must carry both the fiat and the on-chain legs.
- Agent-to-agent payments and escrow (ERC-8183, ADR 0001) remain later work.
