---
name: supply-replenishment
description: SOP for green coffee bean and roasting packaging replenishment with live commodity spot price benchmarking.
---

# Roastery Supply Replenishment SOP

1. Verify green coffee SKU par level and packaging bag burn rate.
2. Benchmark simulated supplier quotes against live specialty coffee wholesale spot pricing (`LIVE_WEB_BENCHMARK`).
3. Verify counterparty whitelist status (`0xa8358AED200D6CB6C856F972D853C1be833006ea`) and `1.0 USDC` daily spend cap before recommending settlement or escrow lock on `BindSettlement.sol`.

## Circle Agent Stack on Arc L1 (`ARC-TESTNET`) Execution Rules

1. **Why Dual-Layer Policy Enforcement Is Used:**
   - Circle Agent Wallets support native off-chain spending limits (`circle wallet limit set --chain ARC`) on Arc Mainnet.
   - Because this deployment operates on **Arc Testnet (`ARC-TESTNET`, Chain ID `5042002`)** where native wallet policies are disabled, deterministic spending authority is enforced on-chain by **`BindSettlement.sol` (`0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`)**.
2. **Required Circle CLI Pre-Flight:**
   - Query vendor whitelist status via `circle contract query "whitelistedVendors(address)(bool)" <vendor> --contract 0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29 --chain ARC-TESTNET`.
3. **Required Circle CLI Settlement Execution:**
   - Execute approved settlements via `circle wallet execute` targeting `0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29` on `--chain ARC-TESTNET`.
   - Record the exact `circle` CLI command, the `decisionHash`, the LangSmith trace link, and the resulting Arcscan transaction hash in the decision record.
