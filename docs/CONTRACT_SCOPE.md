Decision: IN_SCOPE

# Contract Scope & Deployment: BindSettlement on Arc L1

## 1. Bind-Owned Smart Contracts

Bind deploys and owns [`BindSettlement.sol`](file:///home/ubuntu/bind/contracts/src/BindSettlement.sol):
- **Purpose**: Trustless on-chain milestone escrow, 3-way match hash recording (`keccak256(PO, DeliveryReceipt, SupplierBill)`), and native USDC settlement.
- **Network**: Arc Testnet (Chain ID `5042002`).
- **RPC**: Arc Canteen RPC (`https://rpc.testnet.arc-node.thecanteenapp.com/v1/<ARC_RPC_TOKEN>`).
- **Deployer / Owner Wallet**: `0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2`.
- **Deployed Contract Address**: [`0x6cb713De75CDB19c3f7e9ACAB10Dc753b7cea96f`](https://testnet.arcscan.app/address/0x6cb713De75CDB19c3f7e9ACAB10Dc753b7cea96f).
- **Deployment Transaction Hash**: [`0xda20e4449a16f0d0178553acf2bff65b3f9bf376ca13b5e732a5161740fa5ed5`](https://testnet.arcscan.app/tx/0xda20e4449a16f0d0178553acf2bff65b3f9bf376ca13b5e732a5161740fa5ed5) (Block `67152928`).

## 2. External System Contracts Consumed

1. **Native USDC Precompile / System Emitter**:
   - ERC-20 NativeFiatToken Interface (6 decimals): [`0x3600000000000000000000000000000000000000`](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000).
   - EIP-7708 System Log Emitter (18 decimals): `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE`.
   - Live Verified Transfer: [`0x03f3f068d372737396fe8aebbf5e3aaf4bbd3b857698e24de8b4657f43965e01`](https://testnet.arcscan.app/tx/0x03f3f068d372737396fe8aebbf5e3aaf4bbd3b857698e24de8b4657f43965e01) (Block `67153050`).
2. **ERC-8183 AgenticCommerce / Escrow Standard**:
   - Reference contract on Arc Testnet: `0x0747EEf0706327138c69792bF28Cd525089e4583`.

## 3. Foundry Verification Gates

Executed in `contracts/` and verified via `scripts/verify-local.sh`:
- `forge fmt --check`: 100% compliant.
- `forge test -vvv`: 5 passed (unit, fuzzing, and adversarial tests).
- `forge coverage`: 95.24% line coverage.
