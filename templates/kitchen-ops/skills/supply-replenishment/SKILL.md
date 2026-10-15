---
name: supply-replenishment
description: Standard operating procedure for commercial kitchen ingredient replenishment, supplier quote evaluation, and on-chain policy pre-flight verification.
---

# Kitchen Supply Replenishment SOP

## Step 1: Inventory Deficit & Burn-Rate Check
Calculate exact deficit quantity required to restore par stock without exceeding perishable shelf-life constraints (maximum 5-day perishables runway for produce/dairy; 14-day runway for dry goods).

## Step 2: Supplier Quote vs. Live Market Benchmark Evaluation
1. Inspect candidate vendor quotes returned by the supplier adapter (`SIMULATED_SUPPLIER_ADAPTER`).
2. Compare unit pricing against live wholesale commodity benchmarks (`LIVE_WEB_BENCHMARK` via Parallel/Tavily).
3. Verify that the selected vendor wallet address is whitelisted on `BindSettlement.sol` (`0xa8358AED200D6CB6C856F972D853C1be833006ea`).

## Step 3: Canonical Decision Record Generation
Output a structured JSON decision artifact containing:
- `selectedVendorAddress` and `integrationClassification` (`SIMULATED_SUPPLIER_ADAPTER`)
- `marketBenchmarkSummary` (`LIVE_WEB_BENCHMARK` or `OFFLINE_DETERMINISTIC_FALLBACK`)
- `policyPreFlight`: whether the order amount fits within the `1.0 USDC` rolling 24h cap on `BindSettlement.sol`
- `paymentStatus` (`PENDING_ONCHAIN_SETTLEMENT`) kept strictly separate from `fulfilmentStatus` (`AWAITING_PHYSICAL_DELIVERY_3WAY_MATCH`)

## Circle Agent Stack on Arc L1 (`ARC-TESTNET`) Execution Rules

1. **Why Dual-Layer Policy Enforcement Is Used:**
   - Circle Agent Wallets support native off-chain spending limits (`circle wallet limit set --chain ARC`) on Arc Mainnet.
   - Because this deployment operates on **Arc Testnet (`ARC-TESTNET`, Chain ID `5042002`)** where native wallet policies are disabled, deterministic spending authority is enforced on-chain by **`BindSettlement.sol` (`0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`)**.
2. **Required Circle CLI Pre-Flight:**
   - Query vendor whitelist status via `circle contract query "whitelistedVendors(address)(bool)" <vendor> --contract 0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29 --chain ARC-TESTNET`.
3. **Required Circle CLI Settlement Execution:**
   - Execute approved settlements via `circle wallet execute` targeting `0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29` on `--chain ARC-TESTNET`.
   - Record the exact `circle` CLI command, the `decisionHash`, the LangSmith trace link, and the resulting Arcscan transaction hash in the decision record.
