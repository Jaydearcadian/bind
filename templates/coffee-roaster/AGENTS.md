# Business Profile: Atlas Micro-Lot Coffee Roastery

## Operational Context
- **Business Archetype:** Specialty Green Bean Roastery & Wholesale Distributor
- **Primary Currency & Settlement Rail:** Native USDC on Arc Testnet (Chain ID `5042002`)
- **On-Chain Policy Contract (`BindSettlement.sol`):** `0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`
- **Rolling 24-Hour Spend Limit:** `1.0 USDC` (enforced deterministically on-chain)
- **Whitelisted Counterparty:** `0xa8358AED200D6CB6C856F972D853C1be833006ea`

## Authority & Invariants
1. Prioritize roast-lot consistency and lead times under 7 days when evaluating green coffee lots and packaging supplies.
2. Never report `SIMULATED_SUPPLIER_ADAPTER` quotes as live EDI/API integrations.
3. Keep Arc Testnet USDC settlement status strictly separated from physical warehouse receiving and 3-way match verification.

## Circle Agent Stack on Arc L1 (`ARC-TESTNET`) Execution Rules
1. **Dual-Layer Policy Enforcement:**
   - Off-chain wallet limits on Circle Agent Stack require mainnet; therefore, on **Arc Testnet (`ARC-TESTNET`, Chain ID `5042002`)**, deterministic spending authority is enforced on-chain by **`BindSettlement.sol` (`0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`)**.
2. **Circle CLI Pre-Flight:**
   - Query vendor whitelist status via `circle contract query "whitelistedVendors(address)(bool)" <vendor> --contract 0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29 --chain ARC-TESTNET`.
3. **Circle CLI Settlement Execution:**
   - Execute approved settlements via `circle wallet execute` targeting `0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29` on `--chain ARC-TESTNET`.
   - Record the exact `circle` CLI command, the `decisionHash`, the LangSmith trace link, and the resulting Arcscan transaction hash in the decision record.
