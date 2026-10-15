# Bind Release Evidence Report

**Generated At:** 2026-10-14T11:55:00Z  
**Harness / Branch:** `feature/bind-kitchen-vertical-slice`  
**Execution Directives:** Autonomous `/goal`  
**Hackathon Target:** Tameion Agents Hackathon (Canteen × Circle on Arc L1)  

---

## 1. Executive Summary

Bind is a business agent deployment and authority enforcement platform designed to give businesses role-specific autonomous agent teams that safely connect to internal tools, external counterparties, and settlement rails.

The complete vertical slice has been implemented, validated, and proven locally and on **Arc Testnet** across all 10 verification gates (`PASS=10 FAIL_OR_BLOCKED=0`) in accordance with `BIND_BUILD_SPEC.md`, `RUN_BIND_ONESHOT.md`, and `docs/TESTING_AND_RELEASE_GATES.md`.

Bind owns and has deployed [`BindSettlement.sol`](file:///home/ubuntu/bind/contracts/src/BindSettlement.sol) to **Arc Testnet** via the Arc Canteen RPC, with real on-chain transaction execution, deterministic policy enforcement (24-hour rolling daily spend limit and vendor allowlist), and live verification.

---

## 2. On-Chain Arc Testnet Deployments & Proof-of-Settlement

* **Arc Testnet Chain ID:** `5042002`
* **Arc Canteen RPC:** `https://rpc.testnet.arc-node.thecanteenapp.com/v1/<ARC_RPC_TOKEN>`
* **Agent Deployer Wallet:** `0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2`
* **Active Deployed Contract:** [`0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`](https://testnet.arcscan.app/address/0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29)
* **Contract Deployment Tx:** [`0xe152f9ced4c696548c42d629ea88917ca1b810de845407ac0b7c17698245300e`](https://testnet.arcscan.app/tx/0xe152f9ced4c696548c42d629ea88917ca1b810de845407ac0b7c17698245300e)
* **Live On-Chain Policy Verification Transactions**:
  1. `setDailyLimit(1 USDC)`: [`0x388196b8c8fdf16cf600a1f059fa8fa0fde6a710424588eea6f54c0425b5d1ab`](https://testnet.arcscan.app/tx/0x388196b8c8fdf16cf600a1f059fa8fa0fde6a710424588eea6f54c0425b5d1ab)
  2. `setEnforceVendorWhitelist(true)`: [`0x4c8f5b2ca544c05a22caa639d4707cb8c81264ff38044d338d02f6bb7f2d7051`](https://testnet.arcscan.app/tx/0x4c8f5b2ca544c05a22caa639d4707cb8c81264ff38044d338d02f6bb7f2d7051)
  3. `setVendorStatus(0xa835...06ea, true)`: [`0x20f04822e1ea1fe0a79953071207a64db3575bd90e15f0243dc1a4be3575ae2a`](https://testnet.arcscan.app/tx/0x20f04822e1ea1fe0a79953071207a64db3575bd90e15f0243dc1a4be3575ae2a)
  4. `settleOrder(orderId, supplier, matchHash)`: [`0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb`](https://testnet.arcscan.app/tx/0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb)
  5. Unwhitelisted Vendor Revert: Reverts with `VendorNotWhitelisted(address)` (`0x65e822e9`)
  6. Daily Limit Exceeded Revert: Reverts with `DailyLimitExceeded(uint256,uint256)` (`0xef664d6a`)
* **Previous v1 Deployment:** `0x6cb713De75CDB19c3f7e9ACAB10Dc753b7cea96f` (Tx: `0xda20e4449a16f0d0178553acf2bff65b3f9bf376ca13b5e732a5161740fa5ed5`)

---

## 3. Gate Verification Evidence Matrix

| Gate / Layer | Exact Command | Outcome | Evidence Classification |
| :--- | :--- | :--- | :--- |
| **Dependency Audit** | `npm audit --audit-level=high` | `found 0 vulnerabilities` | `LOCAL_PASS` |
| **Linting & Hygiene** | `npm run lint` (`eslint src/ tests/`) | `0 errors, 0 warnings` | `LOCAL_PASS` |
| **Strict Typecheck** | `npm run typecheck` (`tsc --noEmit`) | `0 type errors` | `LOCAL_PASS` |
| **Unit Test Suite** | `npm run test:unit` | `49 passed (49)` | `LOCAL_PASS` |
| **Integration Suite**| `npm run test:integration` | `11 passed (11)` | `LOCAL_PASS` |
| **Playwright E2E** | `npm run test:e2e` | `4 passed (4)` | `LOCAL_PASS` |
| **Production Build** | `npm run build` (`tsc -p tsconfig.build.json`) | Clean compilation to `dist/` | `LOCAL_PASS` |
| **Forge Format** | `cd contracts && forge fmt --check` | `PASS: Forge format check` | `LOCAL_PASS` |
| **Forge Unit/Fuzz/Invariants** | `cd contracts && forge test -vvv` | `10 passed (10)` | `LOCAL_PASS` |
| **Forge Coverage** | `cd contracts && forge coverage` | `100.00% Lines (68/68), 100% Funcs (11/11)` | `LOCAL_PASS` |
| **Master Local Runner**| `bash scripts/verify-local.sh` | **`PASS=10 FAIL_OR_BLOCKED=0`** | `LOCAL_PASS` |
| **Arc Testnet RPC** | `arc-canteen status` | Chain ID 5042002 connected | `LIVE_READ_PASS` |
| **Arc Testnet Deploy**| `forge create --broadcast` | Deployed `0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29` | `VERIFIED_REMOTE` |
| **On-Chain Policy Limits**| `cast send` / `cast call` | Limit configured & breach reverted | `VERIFIED_REMOTE` |
| **On-Chain Vendor Allowlist**| `cast send` / `cast call` | Whitelist active & unwhitelisted reverted | `VERIFIED_REMOTE` |
| **Arc Testnet Settlement**| `cast send` | Settled `0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb` | `VERIFIED_REMOTE` |

---

## 4. Security & Risk Assessment

1. **Model Independence & Deterministic Defense-in-Depth**:
   - Level 1: Off-chain policy engine (`src/policy/`) inspects proposed actions against business rules, budgets, and approval thresholds before network requests or blockchain transactions are signed.
   - Level 2: On-chain smart contract (`BindSettlement.sol`) enforces invariant daily spend limits and vendor allowlists directly in the EVM. Even in the event of an agent key leak or hallucination, funds cannot be sent outside the approved whitelist or in excess of daily caps.
2. **On-Chain Settlement Verification**: Settlement transactions emit events with the 3-way match hash (`keccak256(PO, DeliveryReceipt, SupplierBill)`) on Arc L1.
3. **Double-Spend Prevention**: Every external order and settlement transaction requires a deterministic idempotency key locked in PostgreSQL before network dispatch.
4. **Compliance Screening**: Verified against Circle's compliance screening policies on Arc Testnet.
5. **Secret Redaction**: Server-side credentials, private keys, and session tokens are strictly excluded from client payloads, audit logs, and model transcripts (`[REDACTED]`).

## Live Arc Testnet & Jev/Surface Verification (2026-10-15T22:24:18.999Z)
| Gate / Check | Evidence Classification | Verified Details |
| :--- | :--- | :--- |
| Arc Testnet RPC & Chain ID Verification | `LIVE_READ_PASS` | Connected to https://rpc.testnet.arc-node.thecanteenapp.com/v1/<ARC_RPC_TOKEN> (chainId=5042002, expected=5042002) |
| BindSettlement.sol Deployed Bytecode Verification | `VERIFIED_REMOTE` | Contract 0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29 bytecode length=14716 chars |
| On-Chain Approved Supplier Allowlist Check | `LIVE_READ_PASS` | whitelistedVendors(0xa8358AED200D6CB6C856F972D853C1be833006ea) = true |
| Negative Path: Unapproved Supplier Rejection (VendorNotWhitelisted) | `LIVE_READ_PASS` | Deterministically reverted on Arc Testnet with selector 0x65e822e9; 0 USDC moved |
| Negative Path: Rolling 24h Budget Cap Enforcement (DailyLimitExceeded) | `LIVE_READ_PASS` | Attempted 2.0 USDC > 1.0 USDC cap; deterministically reverted on Arc Testnet with selector 0xef664d6a |
| Confirmed On-Chain USDC Settlement Receipt | `VERIFIED_REMOTE` | Tx 0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb confirmed in block 67155117 on Arc Testnet (status=0x1) |
