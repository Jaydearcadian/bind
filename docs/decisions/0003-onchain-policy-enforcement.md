# ADR 0003: On-Chain Policy Enforcement on Arc L1

## Status
Accepted

## Context
Bind separates model reasoning from deterministic policy enforcement. While off-chain policy gates (in `src/policy/`) govern agent actions prior to dispatching transactions, mission-critical safety guarantees for decentralized autonomous agents require smart-contract-level invariant enforcement. If an agent key is compromised, misconfigured, or experiences unexpected behavior, the smart contract itself must reject transfers that violate business limits or pay non-approved parties.

## Decision
We implemented deterministic policy enforcement directly inside `BindSettlement.sol` on Arc L1:
1. **24-Hour Rolling Daily Spend Limit**:
   - Business owner configures `dailySpendLimit` (in native USDC wei).
   - Any order settlement or escrow deposit increments `dailySpent`.
   - If `dailySpent + amount > dailySpendLimit`, the contract reverts with custom error `DailyLimitExceeded(attempted, limit)`.
   - The rolling counter automatically resets when `block.timestamp >= lastDayReset + 1 days`.
   - Refunds restore the active day's budget.
2. **Vendor Whitelist (Allowlist)**:
   - Business owner can toggle `enforceVendorWhitelist(bool)`.
   - Specific supplier/contractor addresses can be authorized via `setVendorStatus(address, bool)`.
   - Attempting to pay or deposit escrow to an unwhitelisted recipient reverts with custom error `VendorNotWhitelisted(address)`.
3. **Owner-Gated Administration**:
   - `onlyOwner` modifier protects all policy configuration functions (`setDailyLimit`, `setVendorStatus`, `setEnforceVendorWhitelist`).

## Verification
- Local: 10 Forge unit, fuzz, and invariant tests covering limits, rolling resets, and whitelist reversals with 100% line coverage and 100% function coverage.
- Live Arc Testnet: Deployed to `0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`. Verified `setDailyLimit` (Tx: `0x388196b8c8fdf16cf600a1f059fa8fa0fde6a710424588eea6f54c0425b5d1ab`), `setEnforceVendorWhitelist` (Tx: `0x4c8f5b2ca544c05a22caa639d4707cb8c81264ff38044d338d02f6bb7f2d7051`), `setVendorStatus` (Tx: `0x20f04822e1ea1fe0a79953071207a64db3575bd90e15f0243dc1a4be3575ae2a`), `settleOrder` (Tx: `0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb`), and live reverts for unwhitelisted addresses and daily limit breaches.
