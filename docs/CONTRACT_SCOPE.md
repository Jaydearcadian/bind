Decision: IN_SCOPE

# Contract Scope & Deployment: BindSettlement on Arc L1

## 1. Bind-Owned Smart Contracts

Bind deploys and owns [`BindSettlement.sol`](file:///home/ubuntu/bind/contracts/src/BindSettlement.sol):
- **Purpose**: Trustless on-chain milestone escrow, 3-way match hash recording (`keccak256(PO, DeliveryReceipt, SupplierBill)`), deterministic on-chain policy enforcement (rolling 24h daily spend limit, vendor allowlist), and native USDC settlement.
- **Network**: Arc Testnet (Chain ID `5042002`).
- **RPC**: Arc Canteen RPC (`https://rpc.testnet.arc-node.thecanteenapp.com/v1/<ARC_RPC_TOKEN>`).
- **Deployer / Owner Wallet**: `0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2`.
- **Active Deployed Contract Address**: [`0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`](https://testnet.arcscan.app/address/0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29).
- **Deployment Transaction Hash**: [`0xe152f9ced4c696548c42d629ea88917ca1b810de845407ac0b7c17698245300e`](https://testnet.arcscan.app/tx/0xe152f9ced4c696548c42d629ea88917ca1b810de845407ac0b7c17698245300e).
- **Previous Deployment**: `0x6cb713De75CDB19c3f7e9ACAB10Dc753b7cea96f` (Initial v1 without on-chain policy).

## 2. On-Chain Policy Verification (Live Arc Testnet)

1. **Daily Spend Limit (1.0 USDC / 1e18 wei)**:
   - Configuration Tx: [`0x388196b8c8fdf16cf600a1f059fa8fa0fde6a710424588eea6f54c0425b5d1ab`](https://testnet.arcscan.app/tx/0x388196b8c8fdf16cf600a1f059fa8fa0fde6a710424588eea6f54c0425b5d1ab).
   - Revert Verification: Attempted 2.0 USDC settlement reverts on-chain with `DailyLimitExceeded(2001000000000000000, 1000000000000000000)` (`0xef664d6a`).
2. **Vendor Whitelist Enforcement**:
   - Enforcement Enabled Tx: [`0x4c8f5b2ca544c05a22caa639d4707cb8c81264ff38044d338d02f6bb7f2d7051`](https://testnet.arcscan.app/tx/0x4c8f5b2ca544c05a22caa639d4707cb8c81264ff38044d338d02f6bb7f2d7051).
   - Vendor Whitelisted Tx: [`0x20f04822e1ea1fe0a79953071207a64db3575bd90e15f0243dc1a4be3575ae2a`](https://testnet.arcscan.app/tx/0x20f04822e1ea1fe0a79953071207a64db3575bd90e15f0243dc1a4be3575ae2a) (`0xa8358AED200D6CB6C856F972D853C1be833006ea`).
   - Revert Verification: Settle to unwhitelisted vendor reverts on-chain with `VendorNotWhitelisted(address)` (`0x65e822e9`).
3. **Live Whitelisted Settlement**:
   - Tx: [`0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb`](https://testnet.arcscan.app/tx/0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb).
   - Value: 0.001 USDC native transfer with `SettlementExecuted` event.
   - Resulting `dailySpent()`: 1000000000000000 (0.001 USDC).

## 3. External System Contracts Consumed

1. **Native USDC Precompile / System Emitter**:
   - ERC-20 NativeFiatToken Interface (6 decimals): [`0x3600000000000000000000000000000000000000`](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000).
   - EIP-7708 System Log Emitter (18 decimals): `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE`.
   - Live Verified Transfer: [`0x03f3f068d372737396fe8aebbf5e3aaf4bbd3b857698e24de8b4657f43965e01`](https://testnet.arcscan.app/tx/0x03f3f068d372737396fe8aebbf5e3aaf4bbd3b857698e24de8b4657f43965e01) (Block `67153050`).
2. **ERC-8183 AgenticCommerce / Escrow Standard**:
   - Reference contract on Arc Testnet: `0x0747EEf0706327138c69792bF28Cd525089e4583`.

## 4. Foundry Verification Gates

Executed in `contracts/` and verified via `scripts/verify-local.sh`:
- `forge fmt --check`: 100% compliant.
- `forge test -vvv`: 10 passed (unit, fuzzing, policy, invariant, and adversarial tests).
- `forge coverage`: 100% line coverage (68/68 lines), 100% function coverage (11/11 functions).
