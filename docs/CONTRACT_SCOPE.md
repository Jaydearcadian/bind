Decision: IN_SCOPE

# Contract Scope & Deployment: BindSettlement on Arc L1

Rewritten 2026-10-20 (Task 13) so that every claim says how it is known. Every fact from the earlier version is kept.

## How to read the labels

- `UNVERIFIED_CLAIM (earlier session; reproduce with: <command>)`: an earlier session stated this. The command is the reproduction the repository provides. This environment has no network access and no Foundry, so none of these claims was re-verified here. Running the command against the live network would verify only the part of the claim the command checks.
- `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`: no script in the repository checks this claim.
- `LOCAL_PASS (<command>)`: checked in this environment by the command shown.
- `BLOCKED` and `NOT_RUN`: as defined in `docs/TESTING_AND_RELEASE_GATES.md`, section 10.

Nothing in this document is a live pass or a remote verification. Those require a recorded run in `docs/RELEASE_EVIDENCE.md`.

Reproduction command used below: `ARC_RPC_URL=<arc-rpc-url-with-token> npx tsx scripts/verify-live-arc.ts`. The script requires `ARC_RPC_URL` (or `ARC_TESTNET_RPC_URL`). Its built-in default contains the literal placeholder `<ARC_RPC_TOKEN>` and cannot be used. Gates 3 to 5 call Foundry's `cast` binary, which must be on `PATH`. The optional `LAST_LIVE_SETTLEMENT_TX=<hash>` overrides the hash that gate 6 checks. Each run appends a table to `docs/RELEASE_EVIDENCE.md`.

## 1. Bind-Owned Smart Contracts

Bind deploys and owns [`BindSettlement.sol`](../contracts/src/BindSettlement.sol):
- **Purpose**: Trustless on-chain milestone escrow, 3-way match hash recording (`keccak256(PO, DeliveryReceipt, SupplierBill)`), deterministic on-chain policy enforcement (rolling 24h daily spend limit, vendor allowlist), and native USDC settlement.
  - Source note (read from `_checkAndUpdateDailyLimit`, not run): the daily limit is a fixed window, not a rolling one. `dailySpent` is reset only when a call arrives at or after `lastDayReset + 1 days`. `lastDayReset` changes only at construction and at that reset. `refundEscrow` subtracts the refunded amount from `dailySpent`.
- **Network**: Arc Testnet (Chain ID `5042002`). `UNVERIFIED_CLAIM (earlier session; reproduce with: ARC_RPC_URL=<arc-rpc-url-with-token> npx tsx scripts/verify-live-arc.ts)`. Gate 1 of that script reads `eth_chainId` and compares it with `5042002`.
- **RPC**: Arc Canteen RPC (`https://rpc.testnet.arc-node.thecanteenapp.com/v1/<ARC_RPC_TOKEN>`). The access token is supplied via `ARC_RPC_URL`/`RPC_URL` and is never committed. The adapter reads `ARC_RPC_URL` then `RPC_URL` (`src/adapters/settlement/arc-l1.ts`). The endpoint claim is `UNVERIFIED_CLAIM (earlier session; reproduce with: ARC_RPC_URL=<arc-rpc-url-with-token> npx tsx scripts/verify-live-arc.ts)`, since gate 1 connects to it.
- **Deployer / Owner Wallet**: `0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2`. `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`. No script reads `owner()`.
- **Active Deployed Contract Address**: [`0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29`](https://testnet.arcscan.app/address/0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29). `UNVERIFIED_CLAIM (earlier session; reproduce with: ARC_RPC_URL=<arc-rpc-url-with-token> npx tsx scripts/verify-live-arc.ts)`. Gate 2 checks only that the address has non-empty bytecode. It does not compare the bytecode with the artifact and does not check the owner.
- **Deployment Transaction Hash**: [`0xe152f9ced4c696548c42d629ea88917ca1b810de845407ac0b7c17698245300e`](https://testnet.arcscan.app/tx/0xe152f9ced4c696548c42d629ea88917ca1b810de845407ac0b7c17698245300e). `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`.
- **Previous Deployment**: `0x6cb713De75CDB19c3f7e9ACAB10Dc753b7cea96f` (Initial v1 without on-chain policy). `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`.

Local check of the committed artifact: `LOCAL_PASS (npx vitest run tests/unit/contract-artifact.test.ts)`. It confirms that `contracts/artifacts/BindSettlement.json` carries the SHA-256 of the current `contracts/src/BindSettlement.sol`. It does not show that any deployment uses that bytecode.

## 2. On-Chain Policy Verification (Live Arc Testnet)

1. **Daily Spend Limit (1.0 USDC / 1e18 wei)**:
   - Configuration Tx: [`0x388196b8c8fdf16cf600a1f059fa8fa0fde6a710424588eea6f54c0425b5d1ab`](https://testnet.arcscan.app/tx/0x388196b8c8fdf16cf600a1f059fa8fa0fde6a710424588eea6f54c0425b5d1ab). `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`. No script reads the transaction or the stored limit. Gate 5 shows only that a 2.0 USDC call reverts, which implies a limit below 2.0 USDC.
   - Revert Verification: Attempted 2.0 USDC settlement reverts on-chain with `DailyLimitExceeded(2001000000000000000, 1000000000000000000)` (`0xef664d6a`). `UNVERIFIED_CLAIM (earlier session; reproduce with: ARC_RPC_URL=<arc-rpc-url-with-token> npx tsx scripts/verify-live-arc.ts)`. Gate 5 simulates a 2.0 USDC `settleOrder` and checks that the error contains `0xef664d6a`. It does not check the two arguments. The first argument is `dailySpent + amount`, so 2.001 USDC means 0.001 USDC was already counted when that call reverted. Section 2.3 records that settlement. The order of events should be checked against the chain.
   - Selector `0xef664d6a`: `LOCAL_PASS (node --input-type=module -e 'import {toFunctionSelector} from "viem"; console.log(toFunctionSelector("DailyLimitExceeded(uint256,uint256)"))')`. The result matches the value above.
2. **Vendor Whitelist Enforcement**:
   - Enforcement Enabled Tx: [`0x4c8f5b2ca544c05a22caa639d4707cb8c81264ff38044d338d02f6bb7f2d7051`](https://testnet.arcscan.app/tx/0x4c8f5b2ca544c05a22caa639d4707cb8c81264ff38044d338d02f6bb7f2d7051). `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`. Gate 4 implies enforcement is on, because it expects a `VendorNotWhitelisted` revert, but it does not read the flag.
   - Vendor Whitelisted Tx: [`0x20f04822e1ea1fe0a79953071207a64db3575bd90e15f0243dc1a4be3575ae2a`](https://testnet.arcscan.app/tx/0x20f04822e1ea1fe0a79953071207a64db3575bd90e15f0243dc1a4be3575ae2a) (`0xa8358AED200D6CB6C856F972D853C1be833006ea`). The whitelist status of the vendor is `UNVERIFIED_CLAIM (earlier session; reproduce with: ARC_RPC_URL=<arc-rpc-url-with-token> npx tsx scripts/verify-live-arc.ts)`, because gate 3 reads `whitelistedVendors` for that address and expects `true`. The transaction hash itself is `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`.
   - Revert Verification: Settle to unwhitelisted vendor reverts on-chain with `VendorNotWhitelisted(address)` (`0x65e822e9`). `UNVERIFIED_CLAIM (earlier session; reproduce with: ARC_RPC_URL=<arc-rpc-url-with-token> npx tsx scripts/verify-live-arc.ts)`. Only a gate-4 row whose status is `VERIFIED_REMOTE` contains the selector check. A non-revert failure in gate 4 is reported as `LIVE_READ_PASS` with revert wording (see section 5).
   - Selector `0x65e822e9`: `LOCAL_PASS (node --input-type=module -e 'import {toFunctionSelector} from "viem"; console.log(toFunctionSelector("VendorNotWhitelisted(address)"))')`. The result matches the value above.
3. **Live Whitelisted Settlement**:
   - Tx: [`0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb`](https://testnet.arcscan.app/tx/0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb). `UNVERIFIED_CLAIM (earlier session; reproduce with: ARC_RPC_URL=<arc-rpc-url-with-token> npx tsx scripts/verify-live-arc.ts)`. Gate 6 checks that the receipt exists with status `0x1`. It does not check the block, the logs or the value.
   - Value: 0.001 USDC native transfer with `SettlementExecuted` event. `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`.
   - Resulting `dailySpent()`: 1000000000000000 (0.001 USDC). `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`.

## 3. External System Contracts Consumed

1. **Native USDC Precompile / System Emitter**:
   - ERC-20 NativeFiatToken Interface (6 decimals): [`0x3600000000000000000000000000000000000000`](https://testnet.arcscan.app/address/0x3600000000000000000000000000000000000000). The on-chain interface is `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`. The address constant is `LOCAL_PASS (npx vitest run tests/unit/arc-contract-boundary.test.ts)`, which checks `ARC_USDC_PRECOMPILE` against this value and the `transfer` selector. That is not evidence of on-chain behaviour.
   - EIP-7708 System Log Emitter (18 decimals): `0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE`. `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`. No source file in the repository references this address.
   - Live Verified Transfer: [`0x03f3f068d372737396fe8aebbf5e3aaf4bbd3b857698e24de8b4657f43965e01`](https://testnet.arcscan.app/tx/0x03f3f068d372737396fe8aebbf5e3aaf4bbd3b857698e24de8b4657f43965e01) (Block `67153050`). `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`.
   - Decimal conventions in the code (`LOCAL_PASS` by reading `src/adapters/settlement/arc-l1.ts`, not a run): `getBalance` divides the 6-decimal precompile balance by 10^4 to get cents. Settlement sends 1 cent as 1e16 wei of the 18-decimal native USDC.
2. **ERC-8183 AgenticCommerce / Escrow Standard**:
   - Reference contract on Arc Testnet: `0x0747EEf0706327138c69792bF28Cd525089e4583`. `UNVERIFIED_CLAIM (earlier session; no reproduction command in the repository)`.
   - The adapter declares an `ERC8183_ABI`, but `depositEscrow` and `releaseEscrow` throw `SettlementNotSupportedError` (`docs/decisions/0013-arc-settlement-truthful-states.md`). No code calls that reference contract.

## 4. Foundry Verification Gates

The earlier session recorded these results. They are not reproduced here, and Forge is `BLOCKED` in this environment (not installed):
- `forge fmt --check`: 100% compliant. `UNVERIFIED_CLAIM (earlier session; reproduce with: cd contracts && forge fmt --check)`. Local result: `BLOCKED`.
- `forge test -vvv`: 10 passed (unit, fuzzing, policy, invariant, and adversarial tests). `UNVERIFIED_CLAIM (earlier session; reproduce with: cd contracts && forge test -vvv)`. Local result: `BLOCKED`.
  - Static check, not a run (`LOCAL_PASS (grep -c "function test" contracts/test/BindSettlement.t.sol)`): the file defines 10 test functions, nine `test_*` and one `testFuzz_*`. It defines no `invariant_*` function and imports no invariant helper. The word "invariant" appears only in a comment. The "invariant" part of the claim is therefore not supported by the file.
  - The adversarial tests are access-control checks (`test_PolicyAdmin_OnlyOwner`, `test_UnauthorizedCallerCannotRelease`). No reentrancy test exists.
- `forge coverage`: 100% line coverage (68/68 lines), 100% function coverage (11/11 functions). `UNVERIFIED_CLAIM (earlier session; reproduce with: cd contracts && forge coverage)`. Local result: `BLOCKED`.

Gaps against `docs/TESTING_AND_RELEASE_GATES.md` section 2, from the tree as it is:
- No invariant tests (see above).
- One fuzz test (`testFuzz_DepositAndRelease`, the deposit amount). No fuzzing of addresses, deadlines or IDs.
- No Foundry deployment script: `contracts/` has no `script/` directory. The Anvil suite (`tests/integration/anvil-settlement.test.ts`) deploys the committed artifact through viem, not through a Foundry script. It is `NOT_RUN` here.
- No gas snapshot (`forge snapshot` output is not in the repository).
- No static analysis has been run. Slither is `BLOCKED` here and configured in CI (see section 6).

## 5. Known issues found while writing this document (not fixed here)

1. `scripts/verify-live-arc.ts`, gates 4 and 5: the `catch` branch treats every failure of `cast call` as the expected revert. A network error, a rejected token, or a missing `cast` binary in those gates gives status `LIVE_READ_PASS` and the detail text "deterministically reverted". Only a `VERIFIED_REMOTE` row, which means the selector appeared in stderr, supports the revert claims in section 2.
2. The daily limit is described as rolling. The code is a fixed-window reset (section 1).
3. The script appends to `docs/RELEASE_EVIDENCE.md` on every run.
4. The earlier "invariant" wording in section 4 is not supported by the test file.
5. The configuration and deployment transactions in sections 1 and 2 are not checked by any script in the repository.
6. The live-reproduction script is not wired to any `package.json` script. Its usage is only the command above.

## 6. Which gate ran where

Local result is what happened in this container. CI is what `.github/workflows/quality-gates.yml` configures; no CI job has ever executed (`NOT_RUN` on GitHub).

| Gate | Command | Local container result | CI (configured, never executed) | Evidence class |
| --- | --- | --- | --- | --- |
| Forge format | `forge fmt --check` in `contracts/` | BLOCKED (forge not installed) | `contracts` job | UNVERIFIED_CLAIM (earlier session) |
| Forge build | `forge build` in `contracts/` | BLOCKED (forge not installed) | `contracts` job | NOT_RUN |
| Forge unit and fuzz tests | `forge test -vvv` in `contracts/` | BLOCKED (forge not installed) | `contracts` job | UNVERIFIED_CLAIM (earlier session: 10 passed; no invariant tests in the file) |
| Forge coverage | `forge coverage` in `contracts/` | BLOCKED (forge not installed) | `contracts` job | UNVERIFIED_CLAIM (earlier session: 100%) |
| Slither | `slither .` in `contracts/` (unverified invocation); CI uses `crytic/slither-action@v0.4.0` (unverified tag) | BLOCKED (slither not installed) | `contracts` job and `verify-local` job (which installs Slither unpinned) | NOT_RUN |
| Anvil deployment and client suite | `ANVIL_RPC_URL=<node> npx vitest run tests/integration/anvil-settlement.test.ts` | BLOCKED (anvil not installed; the suite also skips without `ANVIL_RPC_URL`) | `contracts` job (Anvil on 8545) and `verify-local` job (Anvil on 18545) | NOT_RUN |
| In-process EVM: client, ABI, events, artifact hash | `npx vitest run tests/unit/contract-artifact.test.ts tests/integration/local-chain.test.ts tests/integration/arc-settlement-evm.test.ts tests/integration/arc-find-transfer.test.ts` | LOCAL_PASS (4 files, 32 tests) | `contracts` job | LOCAL_PASS (in-process EVM, not Anvil) |
| Live Arc reads and recorded transactions | `ARC_RPC_URL=<arc-rpc-url-with-token> npx tsx scripts/verify-live-arc.ts` | NOT_RUN (no network, no token, no `cast`) | not configured (no secret in CI) | UNVERIFIED_CLAIM (earlier session) |
| Browser E2E | `npm run test:e2e` | BLOCKED (UI orphaned, ADR 0016); accepted as NOT_RUN only through `BIND_ACCEPT_NOT_RUN=test:e2e` | `verify-local` job, recorded as NOT_RUN_ACCEPTED | NOT_RUN (ADR 0016) |

The in-process EVM rows and the Anvil row are different evidence. The in-process EVM is `LOCAL_PASS` for the client boundary. It is not a deployment or a live-chain result, and it does not satisfy the Anvil gate.
