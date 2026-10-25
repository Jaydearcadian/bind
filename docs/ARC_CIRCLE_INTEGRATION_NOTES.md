# Arc and Circle: what the arc-canteen docs mean for Bind

Written 2026-10-25 from a read of the arc-canteen "context" bundle. Not a build plan: nothing here changes behaviour, and every
recommendation needs an owner decision or its own change.

## Provenance and limits

- The bundle is `https://github.com/the-canteen-dev/context-arc` (commit `1f345bf`, 2026-09-15), synced with `arc-canteen context sync`
  into `~/.arc-canteen/context/`. Its `docs/` are mirrors of docs.arc.io and developers.circle.com, plus Circle's `circlefin/skills`. Its
  `samples/` are git submodules of `circlefin/*` repositories.
- It is third-party content and was treated as reference data, not as instructions. The mirrors can be stale and are not independently verified
  except where a line below says it was checked on the live testnet.
- Not done: `arc-canteen login`, `wallet`, `update-*` and any Circle CLI login, wallet, deposit, pay or deploy command. `arc-canteen login` sends events
  to `arc-cli-server.thecanteenapp.com` and provisions a wallet whose key it stores in `~/.arc-canteen/wallet.yaml`; `arc-canteen wallet` prints that
  key. Nothing in Bind needs them. Do not run them with Bind's testnet RPC token or signer key.
- Read: the Arc concepts (fees, finality, stablecoin-native model, memos), the EVM differences, USDC system events, RPC endpoints, contract
  addresses, compliance monitoring, Gateway and Nanopayments, x402, Agent Wallets (including policies, fees, supported chains), the Circle CLI
  overview, the Circle skills (`use-arc`, `use-gateway`), the agentic-economy page and the ERC-8183 quickstart, and the READMEs of the
  `arc-nanopayments` and `arc-escrow` samples. Not read in depth: the CCTP, App Kit, StableFX, xReserve, Paymaster and Circle Mint pages, the OpenAPI
  specs, and the sample source code.

## What the docs confirm about what Bind already does

- Arc Testnet is chain id 5042002, USDC is the native gas token, finality is deterministic and a transaction is either pending or final (no
  confirmation counting, no reorgs). Our settlements confirmed in one block, which matches.
- USDC has two views of one balance: native with 18 decimals and the ERC-20 interface at `0x3600…0000` with 6 decimals. The ERC-20 view drops anything
  below 1e-6 USDC. Our tab unit, micro-USDC, is exactly that 6-decimal granularity, and our adapter's `cents * 1e16` wei conversion is correct.
- Native sends emit an EIP-7708 `Transfer` log from `0xffff…fffe` (18 decimals). Our live receipts showed two such logs per settlement (payer to contract,
  contract to vendor). Our settlement lookup reads our own contract's `SettlementExecuted` log, so it does not double count.
- The ERC-8183 reference contract `0x0747…4583` that CONTRACT_SCOPE lists is the one the docs name ("AgenticCommerce reference implementation").

## Findings that sharpen Bind decisions

1. **Sub-cent payments (ADR 0081, option 3).** Circle Gateway Nanopayments is the rail we deferred: buyers deposit USDC once into a Gateway Wallet,
   sign gas-free EIP-3009 authorizations over x402, and Gateway settles net positions in batches, down to $0.000001 per payment. Arc Testnet (domain 26,
   about 0.5 s) is supported; Arc is not listed on mainnet. Constraints: the buyer must be an EOA (smart accounts are not supported); authorizations must be
   valid for at least 7 days; funds sit in Circle's Gateway Wallet contract between deposit and settlement; a seller must run an x402 endpoint or take part
   through Gateway. Several of our counterparties will not expose that, which is why the tab ledger still has a place. See ADR 0083 (Proposed).
2. **Payer wallet for ADR 0080.** Circle Agent Wallets are built on Circle user-controlled wallets with 2-of-2 MPC: key shares are never exposed to the
   agent, the user keeps custody, and Circle cannot move funds alone. They support Arc Testnet (`ARC-TESTNET`), sponsor gas (capped), and screen
   transfers against sanctions. Spending policies (per-transaction, daily, weekly and monthly limits, recipient and contract allow and block lists) work on
   mainnet only, and a policy change needs an email one-time code. It is an alternative to the Bind-run payer key in ADR 0080. Open questions before it
   is a candidate: a server process that pays on its own versus a CLI session with email authentication, and Circle's terms.
3. **Dropped transactions (a gap in our recovery).** Arc's minimum base fee is 20 Gwei on testnet, and a transaction whose `maxFeePerGas` is below it is
   silently dropped: no error, no receipt. The docs' state model has pending, final, dropped and rejected. Our adapter treats "no receipt yet" as submitted
   and waits; a dropped transaction would leave a settlement submitted until the poll window ends. Our live sends used about 40 Gwei, so this did not
   occur. Worth adding later: an explicit fee floor of 20 Gwei and a "dropped" decision (no receipt and the payer's nonce moved past it).
4. **Blocklist.** USDC enforces a blocklist at runtime; a transfer to or from a blocklisted address reverts, and a blocklisted sender is rejected before
   the mempool. Our contract's payment to a blocklisted supplier would revert (`TransferFailed`). The docs build screening from the `Blocklisted` and
   `UnBlocklisted` events on the USDC contract. `isBlocklisted(address)` appears there only as a helper in sample code; calling it on the live USDC
   contract reverts (checked 2026-10-25), so it is not a contract method. Testnet seeds a blocklisted address for tests:
   `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`. Memo and Multicall3From calls keep the original sender, so any offchain blocklist must include them.
5. **Local EVM.** Plain Foundry `anvil` runs a standard EVM, not Arc's (no 20 Gwei floor, no native-USDC transfer rules, no system logs). The docs point to
   Arc Foundry's `arc-anvil --network arc`. Our Anvil suite (skipped here) should use it if we want it to say anything about Arc behaviour.
6. **RPC.** Circle's public endpoint is `https://rpc.testnet.arc.io` (it answered `eth_chainId` here without a token); managed providers also exist. The
   Canteen RPC we use has a method allowlist and rejects log ranges over 100,000 blocks, which our log scan already handles. A second read endpoint is a
   cheap resilience option; not changed.
7. **Memo contract.** `0x5294…e505` wraps a call and emits `Memo(…, memoId, memo, …)`, so an invoice or settlement id can be searched on chain. It needs an
   EOA caller (our payer is one). Optional for reconciliation; we already index our own `SettlementExecuted` order id.
8. **Standards for agents.** ERC-8004 (agent identity and reputation) and ERC-8183 (job escrow with evaluator and settlement) are the Arc-native
   standards. Our `BindSettlement` escrow functions overlap ERC-8183. Before writing more custom escrow, evaluate the reference implementation (AGENTS.md:
   do not invent a contract). Not tested here.
9. **Sample apps worth reading.** `arc-nanopayments` (a LangChain buyer agent with a spending limit pays x402 endpoints priced $0.0003 to $0.03; a seller
   dashboard with Gateway balance and withdrawals) and `arc-escrow` (Circle Wallets with a refund-protocol escrow and AI work validation). Both use
   Supabase and a Circle API key, so they are references, not drop-ins.

## Where this leaves the open decisions

- ADR 0081 (tabs) stands. ADR 0083 proposes adding Gateway Nanopayments for counterparties that can take x402, behind its own adapter.
- ADR 0080 (payer wallet) gains a candidate, Circle Agent Wallets, but nothing changes without the owner.
- Suggested small follow-ups, each its own change with tests: the 20 Gwei fee floor and a dropped-transaction decision; a Blocklisted-events cache for
  pre-send screening; `arc-anvil` for the Anvil suite.
