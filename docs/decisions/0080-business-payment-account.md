# ADR 0080: The business payment account is a per-business contract owned by the business, paid from a small Bind-run float

## Status
Accepted (2026-10-23) as a direction, on the owner's instruction ("go with your recommendations"). Parameters marked **Open** below are not decided, and
until the owner supplies them nothing runs with real money, on mainnet, or above the current testnet limits. Builds on ADR 0060 (Arc as the payment rail),
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

## Open (the owner must supply before anything is built for real money)
- Who holds the owner key for the first business (the business's own wallet; which kind), and who holds and protects the payer key (for example a custodian
  or key service) and how it is rotated.
- The first business's float and daily limit, and who funds the float.
- Which business, in which country and currency, and the KYB and legal sign-off.

## Consequences
- The adapter must stop assuming one global signer and one global contract: a per-workspace contract address, deploy block and payer reference (ADR 0076).
- A deploy-and-configure runbook step per business that always sets a non-zero limit (a limit of 0 means unlimited on the deployed contract).
- Deploying or configuring a contract for a business, and every transfer of real value, still needs the owner's explicit approval each time. This ADR grants none.
