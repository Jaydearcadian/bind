# ADR 0085: No model-facing tool moves value

## Status
Accepted (by the owner's instruction of 2026-10-25). Builds on ADR 0015 (the single commitment gate), ADR 0020 (the effects
ledger), ADR 0031 (untrusted input), ADR 0037 (the MCP tool table), ADR 0076 (the BindSettlement contract) and ADR 0080 (the
business payment account). Does not change the settlement adapters, the gate or the ledger.

## Context
A review of `src/agents/bindCircleDeepAgent.ts` found a path that moved value outside Bind's settlement code. The deep agent
exposed a model-facing tool, `execute_circle_wallet_arc_settlement`, that called `CircleAgentStackAdapter.executeBindSettlement`,
which ran `circle wallet execute` against BindSettlement.sol on Arc. That path:
- did not go through the settlement adapter (`src/adapters/settlement/`), so no effects-ledger row, no idempotency key and no
  settlement milestone (ADR 0079) were written;
- did not go through the commitment gate (ADR 0015), so the pause, the budget and the owner's approval did not apply;
- was guarded only by an approve, edit or reject interrupt in the agent harness (`interruptOn`), which is a model-loop control,
  not deterministic policy (AGENTS.md: model reasoning and policy enforcement are kept separate).
The same agent also loaded `~/.agents/skills` (`os.homedir()`), which would give the model any skill installed in the operator's
home directory.

Nothing in `src/`, `scripts/`, `mcp/`, `sdk/`, `templates/` or the package scripts imported `bindCircleDeepAgent.ts` or
`createBindCircleAgent`, so the file was reachable only from a test that does not exist. The brief assumed the adapter had no
test importers; two test files did use it (see "Tests changed").

Circle CLI and Circle Agent Wallets are not Bind's payment rail. The coordinator's reading of Circle's documentation (not
re-verified in this change, which made no network call) is that spending policies apply on mainnet only and that the login
uses an emailed one-time code, which cannot run unattended. Neither fits a server that pays without a person present.

## Decision
1. **The rule.** A model-facing tool may only (a) read, (b) make an external request that creates no commitment, or (c) call
   the deterministic commitment path. Value moves only in the settlement adapters (`src/adapters/settlement/`), reached through
   the effects ledger and the commitment gate. No tool, prompt or agent may run a CLI or a contract write to move USDC.
2. **Removed.**
   - `src/agents/bindCircleDeepAgent.ts` (deleted). Its read-only preflight duplicated `bindTemplateAgent`'s benchmark tool and
     was used by nothing.
   - `CircleAgentStackAdapter.executeBindSettlement`, its result type, its failure classifier, its tx-hash parser, and the
     `circle wallet` approval-prefix list with `requiresOwnerApprovalGate` (deleted from `src/adapters/circleAgentStack.ts`).
     The file keeps only `queryVendorWhitelistStatus`, a read-only `circle contract query` for the vendor allowlist, and the
     flag and redaction helpers it uses. Nothing in `src/agents/` imports it.
   - The printed `circle wallet execute` command in the workflow evidence record (`src/agents/antiDriftWriter.ts`,
     DECISION_EVIDENCE.md section 4). A printed command is a second, unguarded path. The record now says that settlement is
     performed only by the settlement adapter.
   - The home-directory skills load (`~/.agents/skills`). Agents load only the virtual `/skills/` folder of the template
     directory, with `virtualMode: true`.
3. **Kept.** `src/adapters/marketBenchmark.ts` (an external search request, read by `bindTemplateAgent` and `procurement`) and
   the replenishment tools (`src/agents/replenishmentTools.ts`).
4. **Parked.** Developer-controlled wallets (a Circle wallet whose keys the Bind server holds, with spending limits set by
   Bind) are a candidate for the business payment account in ADR 0080. Not built, not decided, and not part of this change.

## The allowlist test
`tests/unit/no-value-moving-model-tools.test.ts` reads the source with `fs` (no network, no process, no model). It fails when:
- **(a)** a value-moving primitive (`writeContract(`, `sendTransaction(`, `sendRawTransaction`, `walletClient`, `circle wallet`,
  `wallet execute`, or a `child_process` exec or spawn of `circle` or `cast send`) appears in a product file outside
  `src/adapters/settlement/`. The one exception is `src/adapters/circleAgentStack.ts` (read-only), whose exception is checked
  to contain no write command text.
- **(b)** a file under `src/agents/` imports `child_process`, `viem/accounts`, the settlement adapter, the Circle adapter, the
  settlement workflow or the tab ledger.
- **(c)** a tool is registered (`tool(` in `src/`, `tool(` or the MCP `read(` helper in `mcp/src/`) whose name is not in
  `TOOL_ALLOWLIST`, is listed for another file, or is listed but not registered. Each entry carries its effect class and a note.
  A `commercial_commitment` in `src/` must call `authorizeCommitment(`. The MCP may not import the database, the policy code or
  `src/` at all; its commitments are decided by the API routes.
- **(d)** a file under `src/` or `templates/` combines `homedir` with `.agents`, or a deep agent's `skills` option is anything
  other than the literal `/skills/` on a `virtualMode: true` backend.
- **(e)** a file other than `src/workflows/settlement.ts` and `src/tabs/ledger.ts` calls `.transferUSDC(`.

Each check has a self-test that the scanner matches the text it guards, and the first check asserts that the settlement adapter
does contain the primitives, so an empty scan cannot pass.

The allowlist has 24 entries (7 in `src/`, 17 in `mcp/src/tools.ts`). Each entry gives its tool one of three classes:
- **read**: `get_business_context`, `get_stock_snapshot`, `get_approved_supplier_quotes`, `get_request_status`,
  `inspect_quotes_and_benchmarks`, and the MCP's twelve read tools. `create_replenishment_proposal` is also listed as read: it
  writes a proposal into the workflow's own context, with no money and no supplier contact. The commitment decision is made by
  `request_policy_evaluation`. Reclassify it if it ever sends anything.
- **external request** (creates no commitment): `submit_feedback`, `propose_menu_change`.
- **commercial commitment**: `request_policy_evaluation` (through `authorizeCommitment`; its owner notification uses the effects
  ledger, ADR 0020), `request_replenishment`, `create_customer_order` and `cancel_customer_order` (the API's gate decides; the
  MCP holds no authority, ADR 0037).

## Tests changed
No test was weakened to pass. Each change below removes a test of code that no longer exists, and the coverage of the
remaining code is kept:
- `tests/unit/circle-agent-stack.test.ts`: 11 cases became 5. Seven cases were removed because they exercised
  `executeBindSettlement` (simulated execution, a live success with and without a hash, revert classification, timeout, a
  missing binary, malformed output). The live-flag cases were kept and now call `queryVendorWhitelistStatus`, and one case was
  added for the no-wallet path.
- `tests/unit/bindTemplateAgent.test.ts`: the test that checked the settlement gate and settlement fallback was renamed to
  check only the read-only vendor query. Its assertions on `requiresOwnerApprovalGate` and `executeBindSettlement` were removed.
- No other existing test was changed. Nothing in `tests/integration/` imported the removed code.

## Consequences
- The only route that moves value is the settlement adapter, reached through the gate and the ledger, as before.
- A new model-facing tool fails the allowlist test until it is reviewed and listed with its effect class.
- A new `circle` or `cast` write, a new contract write outside the adapter, or a new home-directory skill fails a test.
- The scan is text-based. It catches the primitives and imports named above. It does not prove that a commitment tool's logic is
  correct, and it cannot see a write made through a library function it does not name. Reviewers still read new tools.
- Historical records (ADR 0057, the completion plan under `docs/superpowers/plans/`) still name `bindCircleDeepAgent`. They are
  not edited.

## Evidence
Greps (run on this tree, before the deletion, to confirm the brief's claim, and again after it):
- `grep -rn "bindCircleDeepAgent\|createBindCircleAgent" src scripts mcp sdk tests templates docs package.json` before the
  change: the file and its `createBindCircleAgent` export, plus the docs listed above (the completion plan, ADR 0057,
  `docs/CODEBASE_MAP.md`). Nothing imported it. The brief's "tests" claim was wrong for `circleAgentStack`, not for this file.
- `grep -rn "executeBindSettlement\|execute_circle_wallet_arc_settlement" ...` before the change: the deep agent, the adapter, and
  the two test files named under "Tests changed".
- `grep -rn "homedir" src templates`: only `bindCircleDeepAgent.ts` combined `homedir` with `.agents`.

Commands (see `docs/RELEASE_EVIDENCE.md` for the run record):
- `npx tsc --noEmit`: exit 0.
- `npx eslint` on the touched files: exit 0.
- `npx vitest run tests/unit`: 70 files, 875 tests passed (includes the 20 cases of the new test).
- Integration, with the private local PostgreSQL: `api-contract`, `mcp`, `hosted-mcp`, `hosted-mcp-hardening`, `demo`,
  `demo-failure-injection`, `replenish-key`, `openapi-route`, `sdk`: 9 files, 101 tests passed.
- `npm run map:functions` and `git diff --exit-code docs/CODEBASE_MAP.md` (the map drift check). The committed map was already
  stale at HEAD: a clean export of HEAD generates 2394 functions and 95 routes, and the committed file said 1909 and 89. The
  regenerated map is therefore larger than this change alone. It is committed so the drift gate matches the code.

Mutation proof (`/tmp/claude-0/-home-user-bind/efa03819-b474-56c8-b12f-105e813ff429/scratchpad/mutate.sh`, a scratch copy, not the
worktree). Each mutation was applied to a fresh copy of `src/`, `mcp/` and `templates/`, and the scan test was run:
- M1 a new tool `send_usdc_payment` in `src/agents`: (c) fails.
- M2 a `walletClient.writeContract` call in an agent file: (a) and (c) fail.
- M3 an agent file importing the settlement adapter: (b) fails.
- M4 `execFile("circle", ["wallet", "execute", ...])` in `src/workflows`: (a) fails.
- M5 `path.join(os.homedir(), ".agents", "skills")` in `src/agents`: (d) fails.
- M6 `skills: ["/home/user/.agents/skills"]` on the template agent: (d) fails. This case first passed; the rule was tightened
  to allow only `/skills/` on a virtual backend, and then it failed.
- M7 a second `.transferUSDC(` caller in `src/workers`: (e) fails.
- M8 `authorizeCommitment(` renamed in `replenishmentTools.ts`: (c) fails.
- M9 `import { query } from "pg"` in `mcp/src`: (c) fails.
- M10 the unmodified tree: all 20 pass.

Classification:
- `LOCAL_PASS`: the unit and integration runs above, the typecheck, the lint and the mutation proof.
- `NOT_RUN`: any live Circle call, any network call, and any test against a live Arc chain. None was made.
- `NOT_RUN`: the Circle CLI and Agent Wallet findings above. They are the coordinator's reading and were not re-verified here.
