# ADR 0080: The business payment account is a per-business contract owned by the business, paid from a small Bind-run float

## Status
Accepted (2026-10-23) as a direction, on the owner's instruction ("go with your recommendations"). The parameters below were closed on the owner's instruction (2026-10-23) with conservative defaults. They set limits only: nothing runs with real money, on
mainnet, or above the testnet limits until a later ADR records KYB and legal sign-off and the owner approves each step. Builds on ADR 0060 (Arc as the payment rail),
ADR 0073 (a wallet for each person), ADR 0076 (one contract per business) and ADR 0079 (submitted and confirmed settlement).

## Context
Today one server-held testnet key is both the contract owner and the payer for every workspace. That is acceptable for testnet only. A business needs
its own account, and the owner had to decide who holds the funds and the keys. Options considered: the business holds everything and a person signs each
payment (A), Bind holds the payer key (B), or a hybrid (C).

## Decision: option C, the hybrid
- **One contract per business** (ADR 0076). The contract's owner is a wallet **controlled by the business**. Bind never holds an owner key. The owner
  sets the daily limit and the vendor list, and can change them.
- **A Bind-run payer wallet** pays through the contract (`settleOrder` is not owner-gated; it only pays a whitelisted vendor within the limit). The business
  tops it up with a small **float**. The most that can be lost to a payer-key compromise is the float, bounded further by the contract's daily limit and the
  vendor whitelist.
- The code rules stay: agents pay only inside owner limits and approvals enforced outside the model; a submitted payment is not a settled one (ADR 0079);
  every payment goes through the settlement adapter and the effects ledger.
- Bind does hold the float, so the custody and money-transmission question (ADR 0060) is smaller, not gone. KYB and legal advice come **before any real money**.

## Parameters, closed on the owner's instruction (2026-10-23: "close the open with your recommendations")
These are conservative defaults the owner can change by a later ADR. They set limits; they do not authorize any transfer.
- **First business:** the kitchen workspace the owner nominates. Testnet only until the KYB and legal sign-off below is recorded.
- **Owner key (limits and vendor list):** a wallet the business controls and Bind never holds. For testnet, any wallet the owner chooses. For real money,
  one with recovery the business controls (a hardware wallet or a multisig); a Privy-managed embedded wallet (ADR 0073) is for testnet only.
- **Payer key:** one payer wallet per business, held in a managed key service (a KMS-backed signer, or a Circle developer-controlled wallet, ADR 0001), never in
  a plain environment variable in production, never visible to a model or a plugin. Rotated every quarter and at once on any suspected exposure. On testnet the
  existing environment variable is allowed, as today.
- **Float and daily limit:** the float is twice the contract's daily limit, funded by the business from its own account. Testnet: daily limit 1.0 USDC (as
  deployed) and a float of 2.0 USDC. First real-money period: daily limit at most 50 USDC and float at most 100 USDC, raised only by the owner after two weeks of
  clean reconciliation. The deploy step must always set a non-zero limit (a limit of 0 means unlimited on the deployed contract).
- **KYB and legal:** required before any mainnet or live-money transfer (ADR 0060). Until a later ADR records it, the adapters stay pinned to the Arc testnet
  chain id and refuse any other chain.
- **Still needed each time (not waived by this ADR):** the owner's explicit approval to deploy or configure a contract for a business, and to move real value.

## Consequences
- The adapter must stop assuming one global signer and one global contract: a per-workspace contract address, deploy block and payer reference (ADR 0076).
- A deploy-and-configure runbook step per business that always sets a non-zero limit (a limit of 0 means unlimited on the deployed contract).
- Deploying or configuring a contract for a business, and every transfer of real value, still needs the owner's explicit approval each time. This ADR grants none.
