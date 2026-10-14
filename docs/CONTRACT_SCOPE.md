Decision: NOT_APPLICABLE

# Contract scope decision: Bind Initial Vertical Slice

## Does Bind own or deploy Solidity contracts?

- Decision: `NOT_APPLICABLE` (No custom Bind-owned Solidity deployed in Wave 1/2)
- Domain reason:
  Bind acts as the business agent deployment, orchestration, and authority layer. The required trust, settlement, and identity guarantees are provided by the established Arc L1 and Circle platform standards:
  1. Native USDC Settlement: Handled directly via Arc's native USDC precompile/system contract (`0x3600000000000000000000000000000000000000`).
  2. Autonomous Escrow & Task Contracts: Handled via the deployed ERC-8183 AgenticCommerce reference contract on Arc Testnet (`0x0747EEf0706327138c69792bF28Cd525089e4583`).
  3. Agent Identity & Reputation: Handled via the deployed ERC-8004 Identity and Reputation registries (`0x8004A818BFB912233c491871b3d84c89A494BD9e`).
  Inventing a redundant Bind-owned smart contract would add unnecessary attack surface, maintenance overhead, and gas costs without solving an unsolved domain problem.

- Contracts/interfaces in scope:
  - `IERC20`: Standard ERC-20 interface for USDC allowance and transfer queries.
  - `IERC8183`: `createJob`, `setBudget`, `fund`, `submitDeliverable`, `complete`, `refund`.
  - `IERC8004`: `registerAgent`, `recordReputation`, `verifyCredential`.

- External contracts consumed:
  - Arc Native USDC (`0x3600000000000000000000000000000000000000` on Arc Testnet)
  - ERC-8183 AgenticCommerce (`0x0747EEf0706327138c69792bF28Cd525089e4583`)
  - Circle CCTP TokenMessenger (`0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`)

- Chain and token assumptions:
  - Local mode: Anvil (Chain ID `31337`) with deployed mock ERC-20 / ERC-8183 test contracts.
  - Testnet mode: Arc Testnet (Chain ID `5042002`), 18-decimal native USDC gas token.
  - Transaction fee floor: 20 Gwei.

- Trust/authority enforced on-chain vs off-chain:
  - **On-chain**: Escrow holding of USDC until deliverable is submitted/evaluated; token transfer finality.
  - **Off-chain**: Workspace tenancy, agent role permissions, approval thresholds, budget enforcement, 3-way document matching, and owner escalation workflows.

## Required test mapping

The absence of custom Solidity does not exempt the system from contract-boundary verification:
1. **ABI Encoding / Decoding Tests**: Asserting payload generation for ERC-20 `transfer`, `approve`, and ERC-8183 `createJob`, `fund`, and `complete`.
2. **Local Anvil Integration Tests**: Deploying mock USDC and ERC-8183 contracts to local Anvil (`127.0.0.1:8545`) and verifying transaction broadcast, receipt parsing, and event log decoding.
3. **Revert & Error Handling Tests**: Simulating insufficient balance, expired deadlines, unauthorized caller reverts, and RPC network timeouts with idempotent recovery.
4. **Reconciliation Tests**: Polling transaction receipts, verifying onchain event logs against persisted database workflow states (`submitted` $\rightarrow$ `confirmed` $\rightarrow$ `reconciled`).
