# Bind — Uniting Businesses and Agents in the Real World

## The Core Thesis
An AI agent with a wallet is not an operational business system. For an agent to coordinate real commercial workflows—and for real-world suppliers to transact with that agent—the agent and the business must be bound together into a single governed entity.

**Bind** is the connectivity and governance layer that unites businesses, agents, and real-world counterparties through three structural bonds:

1. **The Context & Role Bind (`AGENTS.md` + `SKILL.md` + Staff Roles):**
   Binds agents to the specific operational reality of a business (reusable templates, SKU burn rates, and role-scoped permissions).
2. **The Authority & Treasury Bind (Circle Agent Stack + `BindSettlement.sol` on Arc L1):**
   Binds agent execution to the business owner's deterministic authority—enforcing rolling 24-hour USDC spending limits (`1.0 USDC`), counterparty allowlists (`0xa8358AED200D6CB6C856F972D853C1be833006ea`), and owner approval gates on Arc Testnet (`0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`).
3. **The Real-World Fulfilment Bind (Extensible Adapters + 3-Way Match):**
   Binds digital agent decisions and on-chain USDC settlement to physical-world verification—strictly separating testnet payment confirmation from physical goods delivery and 3-way match accounting, while exposing stable contracts for external suppliers and service-provider agents to connect.

---

## Architecture & Verification

Bind implements a complete vertical slice proven locally and on **Arc Testnet** (`5042002`):
- **Core Engine:** TypeScript / Express / PostgreSQL 16 stateful durable workflows (`src/workflows/`) with crash-resilient restart recovery.
- **On-Chain Policy Contract:** [`BindSettlement.sol`](file:///home/ubuntu/bind/contracts/src/BindSettlement.sol) deployed at [`0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`](https://testnet.arcscan.app/address/0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29).
- **Dual-Layer Policy Enforcement:** Off-chain deterministic policy engine (`src/policy/`) + on-chain EVM invariant enforcement (`DailyLimitExceeded 0xef664d6a`, `VendorNotWhitelisted 0x65e822e9`).
- **Verifiable Decision Records & Anti-Drift Locks:** Every replenishment evaluation generates a canonical SHA-256 `decisionHash` and writes `STATE_ANCHOR.md` and `DECISION_EVIDENCE.md` into `workflows/<id>/`.
- **Honesty Attribution:** Explicitly badges quotes as `SIMULATED_SUPPLIER_ADAPTER` and market checks as `LIVE_WEB_BENCHMARK` or `OFFLINE_DETERMINISTIC_FALLBACK`.
- **Testing & Release Gates:** Verified via `bash scripts/verify-local.sh` across all 10 gates (`PASS=10 FAIL_OR_BLOCKED=0`).
