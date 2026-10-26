# ADR 0090: The live tab harness: a hard total cap, chain-decided resume, dedicated databases

## Status
Accepted (2026-10-26), by the engineering decision of the same date, within the owner's approved scope for the Arc testnet
tab rehearsal (three one-cent payments, cap 0.03 USDC). It changes `scripts/live-tab-arc.ts` and its shared checks only. It
does not change production code, the contract, or any gate.

## Context
- The live tab harness sends real testnet USDC. Its first review found that the harness had no cap of its own: the cap was a
  docstring. A `--fresh` run, a deleted state file, or a process that died after a broadcast could each lead to another payment.
- A send that started and has no recorded result (a timeout, a SIGTERM, a parent that died after broadcast, a crash between the
  state write and the broadcast) was refused on resume, so it was never decided. The only safe way out was a human reading the chain.
- The reporting said FAIL for a broadcast that was not confirmed in Bind's record. That is neither a pass nor a plain failure.
- Two runs in one database interact through the worker's global tab and order steps, so a clean database must mean one database per scenario.

## Decision

### 1. A total cap of three payments, counted two ways, checked before every broadcast
- The cap is `TOTAL_CAP_PAYMENTS = 3` payments of one cent (0.03 USDC) in total, across scenarios, runs and state files.
- Chain: every `SettlementExecuted` from the signer to the vendor, from the deploy block to the head (chunked). Ledger: the spend
  ledger, `.live-state/tab-spend-ledger.jsonl` under the repository (git-ignored; never under the temporary directory), one record per
  send attempt, appended and fsynced before the broadcast. Either count at the cap refuses the send.
- The orchestrator checks it before spawning the send child, and the child checks it again before each broadcast. `--fresh` does not
  skip either check. A rehearsal (local-sim) never reads or writes the ledger.
- The count includes payments from the signer to this vendor made by any harness since the deploy block. An operator runs `--preflight`
  before a live run to see the count.

### 2. The signer's balance and a simulation, before every broadcast
- Native balance at the latest block must cover one cent plus a 0.003 USDC gas margin (1e16 + 3e15 wei). A read that fails is BLOCKED.
- `eth_estimateGas` of the exact `settleOrder` call must succeed. Any failure refuses the send.

### 3. Resume and `--fresh` are decided by the chain
- A started send with no recorded result is classified from the chain (`classifySendFacts`):
  - PAID: the order's `SettlementExecuted` log exists. Resume recovers and verifies without a send.
  - NOT_SENT: no payment for the order, the signer's nonce unchanged, no broadcast recorded. Resume refuses (nothing is paid), because
    this harness does not re-send a settlement that Bind has already reserved. A new run is `--fresh` in a new, empty, dedicated database.
  - AMBIGUOUS, or any chain read that fails: a HARD STOP, "inspect the chain, do NOT use --fresh".
- Without `--resume`, a started send is refused.
- `--fresh` is refused unless the chain proves the prior send was not made. It can never produce a second payment for a settlement
  whose payment is on chain or unknown.

### 4. Reporting: submitted, confirmed, and SUBMITTED_UNCONFIRMED
- The report has top-level `submitted` (every broadcast hash) and `confirmed` (`bool` and `block`). `confirmed.bool` is true only when
  Bind's record and, on arc, the chain's log agree.
- A broadcast that is not confirmed is `SUBMITTED_UNCONFIRMED`: evidence class `SUBMITTED_UNCONFIRMED`, exit code 3. It is never a
  PASS, never reported as confirmed, and not a plain FAIL. A verdict is SUBMITTED_UNCONFIRMED only when the only failed checks are
  confirmation checks, the chain shows one payment, and the receipt did not revert.

### 5. One dedicated database per scenario
- The database name must start with `bind_live_` (or it must hold the `bind_live_marker` table). The workspaces table must be empty
  for a new run. On a reuse, and in every child, only the state's workspace may be present. This is checked read-only on every run.
- Fixture limits are one cent per day and a one-cent approval threshold.

### 6. `--preflight` is read-only
- It reads the contract, the balance, the nonce, the cap and the database, prints the plan, and exits 0 only when every check passes
  (`PREFLIGHT_READY`, evidence class `LIVE_READ_PASS`). A refused or blocked check exits 2, so a script never reads a not-ready plan
  as green. It spawns nothing, writes nothing, and takes no `--fresh`, `--resume` or `--write-evidence`.

### 7. A rehearsal integration test on a private database
- `tests/integration/live-tab-arc-rehearsal.test.ts` runs the orchestrator and the send child on local-sim against a private
  `bind_live_rehearsal_<random>` database that it creates and drops. It needs `BIND_LIVE_PG_ADMIN_URL` (a local admin URL) and is
  SKIPPED, with a printed reason, without it.

## Consequences
- The harness can now refuse a fourth payment, and a started send is never re-sent by resume. The cost: a NOT_SENT outcome needs a new
  empty database, and an operator must read the chain by hand for AMBIGUOUS outcomes.
- A state file that is deleted after a started send is not recoverable by the harness. The ledger and the chain still bound the total
  at three payments, and the operator must inspect the chain before any new run. This is a known residual risk (see RUNBOOK 16.4).
- The chain reads and the Arc RPC behaviour are not verified by the offline rehearsal. No live run was made for this change.

## Not done
- Automatic re-send of a NOT_SENT settlement (the Bind worker holds an unsent reservation; re-sending it would need a ledger change
  reviewed separately).
- Per-send outcome proof for ledger records whose state file was deleted (the ledger holds only the attempt, not the outcome).
