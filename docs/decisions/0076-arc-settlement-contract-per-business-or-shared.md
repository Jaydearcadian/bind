# ADR 0076: One BindSettlement contract per business, or a redesigned shared one

## Status
Accepted (2026-10-22), on the owner's instruction: **Option A, one contract per business, for the pilot.** A redesign (Option B) comes
later, once a second business actually needs it. This ADR was Proposed earlier the same day; the options and reasoning below are unchanged.
Accepting it does not authorize any deployment: deploying or configuring a contract for a business, mainnet use, or larger amounts still
needs the owner's explicit approval of that business's payment account and of who holds its funds. No contract was deployed, changed or
reconfigured. Builds on ADR 0060 (Arc as the payment rail), ADR 0061 and ADR 0019 (settlement through the ledger). Evidence:
docs/RELEASE_EVIDENCE.md, sections "Live Arc Testnet read-only run" and "Live Arc Testnet settlement" (2026-10-22).

## Context
The deployed `BindSettlement` (`0x16E1…aA29`, Arc testnet) has, by construction:
- **One owner.** `owner()` is the signer `0xA4D1…9C2`. Only the owner can call `setDailyLimit`, `setVendorStatus` and
  `setEnforceVendorWhitelist`. `settleOrder` itself is not owner-gated: anyone can call it with value, but only to a
  whitelisted supplier, within the limit.
- **One global daily limit, in a fixed window.** `_checkAndUpdateDailyLimit` resets `dailySpent` to 0 when 24 hours have passed
  since `lastDayReset`, then checks the limit. The live settlement showed this: `dailySpent` went from 1e15 to 1e16, not to 1.1e16,
  because the window had expired. A limit of 0 means no limit.
- **One vendor list** shared by everyone who pays through it.
- **No upgrade path.** A deployed contract cannot be changed.

Today a single Bind signer key is the payer for every workspace (the adapter refuses any `fromAddress` that is not that signer). One
business works. With several businesses on one contract, they would share one limit (one business's spend can block another's), one
vendor list (a supplier one business approved is payable by all), and one owner who controls all of it. Those are tenancy
failures, not bugs in the contract as written.

Measured cost on Arc testnet: deployment used 1,681,387 gas (about 0.045 USDC at the 26.75 gwei paid), a configuration call about
47,600 gas, and a settlement 76,014 gas (about 0.003 USDC at 40 gwei). Testnet figures; mainnet pricing is unknown.

## Options

### A. One contract per business (no contract change)
Deploy the existing, already tested bytecode once for each business. The business's workspace row stores its contract address; its
owner is that business's signer; its limit and vendor list are its own.
- **Costs:** a deployment plus three configuration transactions per business (about 0.05 USDC on testnet). A signer key per
  business, which means key custody and funding per business. A registry of contract addresses, and event indexing that follows
  many contracts (`findTransfer` scans one contract's logs from `BIND_SETTLEMENT_DEPLOY_BLOCK`, so the deploy block must be stored
  per business too). Every deployment and configuration call needs the owner's authorization, and each is an irreversible permission
  grant on that contract. Fixing a flaw means redeploying every business's contract.
- **Gains:** real isolation of limit, vendor list and owner, today, with code that has unit, fuzz, invariant and coverage tests. No new
  Solidity. The blast radius of a compromised key is one business.
- **Still missing:** the fixed window stays (a business can spend twice its limit across a window boundary), and a limit of 0 still
  means unlimited, so the deploy step must always set a limit.

### B. Redesign into a multi-tenant contract
A new contract holding, per tenant, an owner, a limit, a window and a vendor list, with `settleOrder(tenant, …)`.
- **Costs:** new Solidity, with the full gate set from AGENTS.md (Forge unit, fuzz and invariant tests, Anvil deployment, static
  analysis, coverage, event integration), plus an outside review before real money. A one-time deployment, and a migration of the
  adapter, ABI, artifact and `findTransfer`. A bug affects every tenant at once. Tenant administration inside one contract needs its
  own access design (who may create a tenant; whether Bind or the business owns each tenant's settings).
- **Gains:** one address to operate, cheap onboarding (no deploy per business), a chance to fix the fixed window (a rolling limit)
  and to make a zero limit mean "nothing allowed".

## Recommendation
Option A for the pilot and the first few businesses, and keep B as a later redesign. The kitchen vertical needs isolation now, A
gives it with tested code and no new contract risk, and its cost per business is small on testnet. B is the right shape if the number
of businesses makes per-business deployment and key custody the bottleneck, or if the fixed window matters to a business; decide
that with real usage. Before any business shares settlement, the adapter must stop assuming one global signer and one global
contract address (a per-workspace contract address, deploy block and signer reference).

Do not start either until the owner says yes. Deploying or reconfiguring a contract is a separate explicit authorization each time.

## Also recorded: the adapter handles whole cents only (decided in ADR 0078)
`ArcL1SettlementAdapter.transferUSDC` takes `amountCents` and sends `amountCents * 10^16` wei. One cent is 0.01 USDC, so the
smallest payment the adapter can send is 0.01 USDC. The contract itself accepts any non-zero amount (the earlier 0.001 USDC
settlement was sent outside the adapter). Ledger, order and match types are cents too.

Amounts below one cent need a decision **before agent-to-agent payments**, which are often fractions of a cent. Options for later:
a smaller base unit in the types (a migration of order and ledger amounts), a separate micro-payment path, or batching small
amounts into whole cents. This ADR does not choose.

## Consequences if accepted
Option A would add a per-workspace contract address, deploy block and signer reference, a deploy-and-configure runbook step that
always sets a non-zero limit, and per-business evidence. Option B would add a new contract and its full test gates. Neither is done
here.
