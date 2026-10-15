# Business Profile: Hearth & Table Commercial Kitchen

## Operational Context
- **Business Archetype:** Full-Service Restaurant & Commissary Kitchen
- **Primary Currency & Settlement Rail:** Native USDC on Arc Testnet (Chain ID `5042002`)
- **On-Chain Policy Contract (`BindSettlement.sol`):** `0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`
- **Rolling 24-Hour Spend Limit:** `1.0 USDC` (enforced deterministically on-chain via `DailyLimitExceeded`)
- **Whitelisted Counterparty:** `0xa8358AED200D6CB6C856F972D853C1be833006ea` (enforced on-chain via `VendorNotWhitelisted`)

## Authority & Invariants
1. **Truthful Integration Badging:** Quotes from `MockSupplierAdapter` must always be labeled `SIMULATED_SUPPLIER_ADAPTER`. Live web price checks from Parallel or Tavily must be labeled `LIVE_WEB_BENCHMARK`.
2. **Settlement vs. Fulfilment Separation:** On-chain USDC settlement (`PAYMENT_SETTLED_ARC_TESTNET`) never marks physical ingredients as received. Physical receipt requires 3-Way Match reconciliation (`PO` + `Delivery Receipt` + `Invoice`).
3. **Owner Escalation:** Any order exceeding the active daily budget or targeting a non-whitelisted vendor must halt for explicit Owner approval.

## Circle Agent Stack on Arc L1 (`ARC-TESTNET`) Execution Rules
1. **Dual-Layer Policy Enforcement:**
   - Off-chain wallet limits on Circle Agent Stack require mainnet; therefore, on **Arc Testnet (`ARC-TESTNET`, Chain ID `5042002`)**, deterministic spending authority is enforced on-chain by **`BindSettlement.sol` (`0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`)**.
2. **Circle CLI Pre-Flight:**
   - Query vendor whitelist status via `circle contract query "whitelistedVendors(address)(bool)" <vendor> --contract 0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29 --chain ARC-TESTNET`.
3. **Circle CLI Settlement Execution:**
   - Execute approved settlements via `circle wallet execute` targeting `0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29` on `--chain ARC-TESTNET`.
   - Record the exact `circle` CLI command, the `decisionHash`, the LangSmith trace link, and the resulting Arcscan transaction hash in the decision record.
