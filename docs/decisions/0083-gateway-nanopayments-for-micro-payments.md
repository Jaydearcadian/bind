# ADR 0083: Circle Gateway Nanopayments for agent-to-agent micro-payments

## Status
Proposed (2026-10-25). Not accepted; nothing is built, installed in the repo, or paid. Needs the owner's decision. Builds on ADR 0078 (whole cents only),
ADR 0081 (sub-cent charges accrue in tabs and settle in whole cents; option 3, a separate micro-payment path, was deferred), ADR 0080 (business payment
account) and ADR 0079 (submitted is not confirmed). Source: docs/ARC_CIRCLE_INTEGRATION_NOTES.md, a read of Circle's docs through the arc-canteen bundle
(a third-party mirror, not independently verified).

## Context
ADR 0081 deferred a true micro-payment path until a real product needs it. Circle's docs describe one that fits: Gateway Nanopayments, which carries
x402 (HTTP 402) payments. A buyer deposits USDC once into a Gateway Wallet contract, then signs gas-free EIP-3009 authorizations offchain; the seller (or its
facilitator) submits them to Gateway, which settles net positions onchain in batches. Payments can be as small as $0.000001. Arc Testnet (domain 26) is
supported, with about 0.5 s to confirm a deposit. Arc is not listed on Gateway's mainnet table, and Arc itself is testnet only at the time of reading.

Constraints from the docs: the buyer must be an EOA (smart accounts fail signature verification); an authorization must be valid for at least 7 days; the
deposited USDC is held in Circle's Gateway Wallet contract; a seller needs an x402-capable endpoint or a facilitator; there is no per-payment gas but a
deposit and a withdrawal are ordinary onchain transactions. The client library is `@circle-fin/x402-batching`.

## Options
- **A. Do nothing (ADR 0081 as is).** Sub-cent charges accrue in tabs and settle in whole cents through our own contract. Works for any counterparty
  with a payment address, including suppliers that expose no agent endpoint (AGENTS.md: do not assume they do). Costs about 0.003 USDC gas per settlement,
  so batching is the only economical form.
- **B. Add Gateway Nanopayments beside the tabs (recommended direction).** Use it only where the counterparty can take x402 (another agent or an API
  that Bind's agents pay per call). Keep the tab ledger for everyone else and for invoices.
- **C. Replace the tabs with Gateway.** Rejected: it would leave non-x402 counterparties unpaid and put all micro-spend in a third party's contract.

## Proposed decision (if the owner accepts B)
- A separate adapter and records, not an extension of `SettlementAdapter`. Its states differ: a signed authorization is not a settled payment until Gateway
  has batched it (AGENTS.md: a submitted transaction is not confirmed settlement). It would carry its own ledger entries, idempotency key, daily budget
  (shared with order and tab spend), pause check and audit rows, and the same crash-recovery rules.
- Funds: the Gateway deposit is a transfer to a third-party contract. It is a custody decision under ADR 0080 and needs the owner's approval of the
  business account first. The payer must be an EOA, which our payer is.
- Bounds: per-payment and per-day ceilings enforced in code; an allowlist of seller addresses and endpoints; the 7-day authorization window recorded as
  exposure; x402 responses and facilitator output treated as untrusted input.
- Testnet only, until ADR 0080's KYB and legal sign-off exist and Circle documents Arc for mainnet nanopayments. Circle's Developer Terms apply and need the
  owner's review.

## Steps before this could be accepted
1. Owner decision on B and on the Circle dependency and terms.
2. A read-only spike on testnet that calls only Gateway's balance and supported-kinds endpoints, with no deposit and no signing.
3. A small paid spike, separately authorized by the owner, on a dedicated testnet wallet that is not the settlement signer.
4. Tests and review as for the tab ledger (duplicates, crash between sign and settle, cross-tenant, budget races, recovery), then evidence in
   docs/RELEASE_EVIDENCE.md.

## Consequences
Until accepted, nothing changes: sub-cent single payments stay refused (ADR 0078) and sub-cent charges accrue in tabs (ADR 0081).
