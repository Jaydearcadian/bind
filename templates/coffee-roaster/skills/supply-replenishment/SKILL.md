---
name: supply-replenishment
description: SOP for green coffee bean and roasting packaging replenishment with live commodity spot price benchmarking.
---

# Roastery Supply Replenishment SOP

1. Verify green coffee SKU par level and packaging bag burn rate.
2. Benchmark simulated supplier quotes against live specialty coffee wholesale spot pricing (`LIVE_WEB_BENCHMARK`).
3. Verify counterparty whitelist status (`0xa8358AED200D6CB6C856F972D853C1be833006ea`) and `1.0 USDC` daily spend cap before recommending settlement or escrow lock on `BindSettlement.sol`.

## Settlement on Arc L1 (`ARC-TESTNET`) Rules

1. **Why Policy Is Enforced Outside You:** Native spending limits from Circle's wallet product are not used on Arc Testnet. Spending authority is enforced by Bind's deterministic policy code and on-chain by **`BindSettlement.sol` (`0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`)**.
2. **Vendor Allowlist Check:** Bind's code reads the vendor's whitelist status. Report the result; do not run a command for it.
3. **Settlement Is Not Yours to Run:** Only Bind's settlement adapter performs settlement, through the effects ledger and the commitment gate. Never run, print or suggest a wallet, contract-write or payment command. Record the `decisionHash` in the decision record; the settlement status comes from the ledger.
