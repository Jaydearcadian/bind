# Local development and testnet boundary

## Local profile

- PostgreSQL is local and disposable.
- EVM calls use Anvil chain ID `31337`, bound to `127.0.0.1`.
- Use only Anvil's development accounts and test contracts locally.
- Supplier/third-party simulators are explicit in API responses, logs, and test evidence (`SIMULATED_SUPPLIER_ADAPTER`, `simulated`). The UI is orphaned (ADR 0016), so it labels nothing.
- No production, testnet, or mainnet RPC is allowed in local CI configuration by default.
- Do not put real secrets in `.env.local.example`, local fixtures, screenshots, logs, or `capabilities.yaml`.

## Testnet profile is a separate, guarded configuration

Prepare but do not activate it until the local release gate passes. The report must list the actual values still needed, without requesting that secrets be pasted into chat:

- target chain/network and exact chain ID;
- RPC endpoint and provider limits;
- approved deployer/signer or wallet authorization method;
- contract addresses and required role/config values after deployment;
- token addresses/decimals and settlement-specific settings where relevant;
- credentials for each real service adapter and signed webhook callback URLs;
- funding/gas requirements, monitoring, verification, recovery, and test plan.

The application must reject mismatched chain IDs and missing/invalid addresses; it must not silently fall back from testnet to mainnet or from live integration to an unlabelled simulator. Any real transaction, external commercial commitment, deployment, or irreversible role change requires explicit authorization.
