# ADR 0085: No model-facing tool moves value

## Status
Accepted (by the owner's instruction of 2026-10-25). Revised after review (the second commit on this branch). Builds on ADR 0015
(the single commitment gate), ADR 0020 (the effects ledger), ADR 0031 (untrusted input), ADR 0037 (the MCP tool table), ADR 0076
(the BindSettlement contract), ADR 0079 (settlement milestones) and ADR 0080 (the business payment account). Does not change the
settlement adapters, the gate or the ledger.

## Context
`src/agents/bindCircleDeepAgent.ts` exposed a model-facing tool, `execute_circle_wallet_arc_settlement`, that called
`CircleAgentStackAdapter.executeBindSettlement`, which ran `circle wallet execute` against BindSettlement.sol on Arc. That path:
- did not go through the settlement adapter (`src/adapters/settlement/`), so no effects-ledger row, no idempotency key and no
  settlement milestone (ADR 0079) were written;
- did not go through the commitment gate (ADR 0015), so the pause, the budget and the owner's approval did not apply;
- was guarded only by an approve, edit or reject interrupt in the agent harness (`interruptOn`), which is a model-loop control,
  not deterministic policy (AGENTS.md: model reasoning and policy enforcement are kept separate).
The same agent loaded `~/.agents/skills` (`os.homedir()`), which would give the model any skill installed in the operator's home
directory.

Review of the first change found two more places that told the model to pay. The four agent-memory and skill files under
`templates/` (each template's `AGENTS.md` and `skills/supply-replenishment/SKILL.md`, in `kitchen-ops` and `coffee-roaster`)
instructed the agent to run `circle wallet execute`, and they are loaded as the agent's memory and skills
(`src/agents/bindTemplateAgent.ts`, `src/workflows/procurement.ts`). Those instructions are rewritten in this change.

Circle CLI and Circle Agent Wallets are not Bind's payment rail. The coordinator's reading of Circle's documentation (not
re-verified here; this change made no network call) is that spending policies apply on mainnet only and that the login uses an
emailed one-time code, which cannot run unattended. Neither fits a server that pays without a person present.

## Decision
1. **The rule.** A model-facing tool may only (a) read, (b) make an external request that creates no commitment, (c) write
   Bind's own records with no money and no outside contact, or (d) call the deterministic commitment path. Value moves only in
   the settlement adapters (`src/adapters/settlement/`), reached through the effects ledger and the commitment gate. No tool,
   prompt, memory file or skill may tell an agent to run a CLI, a contract write or a payment.
2. **Removed.**
   - `src/agents/bindCircleDeepAgent.ts`. Its read-only preflight duplicated `bindTemplateAgent`'s benchmark tool, and nothing
     imported it.
   - `src/adapters/circleAgentStack.ts`, the whole module. Before deleting it, a grep over `src`, `scripts`, `mcp`, `sdk`,
     `templates`, `tests` and the package scripts found no importer other than its own two test files. Its one remaining
     function, a read-only `circle contract query`, was used by no route, so the module was dead code.
   - `tests/unit/circle-agent-stack.test.ts`, which tested only that module (see "Tests changed").
   - The printed `circle wallet execute` command in the workflow evidence record (`src/agents/antiDriftWriter.ts`). The record now
     says that settlement is performed only by the settlement adapter.
   - The `circle wallet` instructions in the four template files named above. Each section now says that Bind's policy code and
     the settlement adapter enforce spending authority, that the agent does not run a vendor check or a wallet command, and that
     the settlement status comes from the ledger. The tests fail if `wallet execute` or `circle wallet` returns to a template.
   - The two commented Circle variables in `.env.local.example`, and the RUNBOOK row and the architecture-document line that
     described the Circle CLI flag. Nothing reads those variables now.
   - The home-directory skills load (`~/.agents/skills`). Agents load only the virtual `/skills/` folder of the template
     directory, with `virtualMode: true`.
3. **Kept.** `src/adapters/marketBenchmark.ts` (an external search request, read by `bindTemplateAgent` and `procurement`) and the
   replenishment tools (`src/agents/replenishmentTools.ts`). `src/agents/antiDriftWriter.ts` still prints one read-only
   `circle contract query` line in the evidence record, as an audit aid for a reader who runs it themselves. No code runs it, and
   it is the only Circle CLI text left under `src/`.
4. **Parked.** Developer-controlled wallets (a Circle wallet whose keys the Bind server holds, with spending limits set by Bind)
   are a candidate for the business payment account in ADR 0080. Not built, not decided, and not part of this change.

## Vocabulary of effect classes
Each model-facing tool in `TOOL_ALLOWLIST` has one class:
- **read**: no change to the outside world or to Bind's records.
- **internal_write**: changes Bind's own database and writes an audit row. No money, no supplier or customer contact.
- **external_request**: asks an outside party or a search provider. Creates no commitment.
- **commercial_commitment**: may bind money or a supplier. It goes through the commitment gate (`authorizeCommitment`), or the
  API route that calls it.

## The allowlist test
`tests/unit/no-value-moving-model-tools.test.ts` reads the source, the scripts and the templates with `fs` (no network, no
process, no model). It is a text scan with a small comment-stripping pass. It fails when:
- **(a)** a value-moving primitive (`writeContract (`, `deployContract (`, `sendTransaction (`, `sendRawTransaction`,
  `walletClient`, `circle wallet`, `wallet execute`, a `child_process` exec or spawn of `circle`, or `cast send`) appears in a
  code file outside `src/adapters/settlement/`. The scan covers `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.mts` and `.cts`
  under `src/`, `mcp/src/` and `scripts/`. Exceptions are listed with a reason and must still match: `scripts/live-recovery-arc.ts`
  (a live harness whose transport forwards `eth_sendRawTransaction`). A template (`.md`, `.ts`, `.json`, `.txt` under
  `templates/`) that contains `wallet execute` or `circle wallet` in any case fails.
- **(b)** a file under `src/agents/` imports `child_process`, `execa`, `cross-spawn`, `viem` (any path), the settlement adapter, the
  settlement workflow or the tab ledger. Imports are read from `import`, `from`, dynamic `import()` and `require()`.
- **(c)** the tool surface is closed and reviewed:
  - the only import from `@langchain/core/tools` is `import { tool } from "@langchain/core/tools"`; an alias (`tool as X`), a
    namespace import, a `require` or any other form fails;
  - no other tool-making form appears: `new ...Tool(`, `DynamicTool`, `DynamicStructuredTool`, `StructuredTool`, a `.tool(` method
    call, or `registerTool(` outside `mcp/src/server.ts`;
  - every registration (`tool(` in `src` and `mcp`, the `read(` helper in `mcp`) has a literal name that is in `TOOL_ALLOWLIST`,
    is registered once, and is registered in the file the allowlist names. Adding a tool fails until it is reviewed;
  - a `commercial_commitment` in `src/` must call `authorizeCommitment(` inside its own handler, with comments removed. A call
    in a comment or elsewhere in the file does not count;
  - the MCP never imports `pg`, the database, the policy code or `src/`.
- **(d)** a file under `src/`, `scripts/` or `templates/` combines `homedir` with `.agents`; a deep agent's `skills` option is
  anything other than the literal `/skills/` on a `virtualMode: true` backend; or a file that calls `createDeepAgent(` does not
  build a `FilesystemBackend`, or references a sandbox. The last rule matters because deepagents registers an `execute` tool
  (see below), which becomes a shell on a sandbox backend.
- **(e)** outside `src/adapters/settlement/`, any mention of `transferUSDC` in code (after comments are removed, so a call through
  `?.`, a bracket, a destructured alias or a `.bind` also counts) is in `src/workflows/settlement.ts`, `src/tabs/ledger.ts`, or
  the listed operator script `scripts/live-recovery-arc.ts`. Both entry points must really call it. No file outside the
  settlement adapter may re-export from it.

Each check has a self-test that the scanner matches the text it guards and ignores a comment, and the first check asserts that the
settlement adapter does contain the primitives, so an empty scan cannot pass. The test file has 31 cases.

**What the scan does not catch.** It is a tripwire on reviewed code, not a proof. Obfuscation is beyond a text scan: string
concatenation, a name built at run time, `eval`, a value passed through a variable from another file, or a library call that the
rules do not name. Reviewers still read new tools and new wallet code. A future change that needs one of these forms must be
reviewed as a new decision.

The allowlist has 24 entries (7 in `src/`, 17 in `mcp/src/tools.ts`):
- **read**: `get_business_context`, `get_stock_snapshot`, `get_approved_supplier_quotes`, `get_request_status`,
  `inspect_quotes_and_benchmarks`, and the MCP's twelve read tools.
- **internal_write**: `create_replenishment_proposal`. It sets the workflow's `context_data` and inserts one audit row, with no money
  and no supplier contact. Its audit row's `effect_class` column says `commercial_commitment`. That label is inconsistent with the
  tool's class. This change does not alter audit data, so the inconsistency is recorded here for a separate decision.
- **external request**: `submit_feedback`, `propose_menu_change`.
- **commercial commitment**: `request_policy_evaluation`. It runs `authorizeCommitment` (threshold, budget, pause, approval), and
  only the gate decides. Its owner notification uses the effects ledger (ADR 0020). It also writes the anti-drift files and may
  make an external benchmark request: `generateVerifiableDecisionRecord` is called with `allowExternal` set to "not a demo
  workspace", so a demo makes no outside call (ADR 0057). The MCP's `request_replenishment`, `create_customer_order` and
  `cancel_customer_order` are commitments too; the API's gate decides, and the MCP holds no authority (ADR 0037).

## deepagents' built-in tools
The installed deepagents package (1.15.0) gives each deep agent model-facing filesystem tools: `read_file`, `write_file`,
`edit_file`, `ls`, `glob`, `grep`, and `task` (checked by grep of the package). None moves value. They are confined to the template
directory by `virtualMode: true`. The package also registers an `execute` tool. It returns an error unless the backend implements
`SandboxBackendProtocol`, and `FilesystemBackend` does not, so today it is refused. The scan pins the backend (see (d)).

Caveat, not addressed here. The write and edit tools can change `AGENTS.md` and the skills files in the template directory, and
those files are loaded as memory and skills on later runs. A model that is steered by hostile input could therefore leave an
instruction behind for later runs. This is a persistent prompt-injection surface. Restricting it (read-only memory, or an
owner-approved write path) is a separate decision.

## Map drift (`docs/CODEBASE_MAP.md`)
This change deliberately does not regenerate `docs/CODEBASE_MAP.md`. The file was already stale at base: the committed file says
1909 functions and 89 routes, and a clean export of the base generates 2394 functions and 95 routes. The CI map-drift gate
(`scripts/verify-local.sh:50`, and `.github/workflows/quality-gates.yml:80-83`, both `npm run map:functions && git diff --exit-code
docs/CODEBASE_MAP.md`) is therefore red for that pre-existing reason, and remains red until the map is regenerated. The
coordinator will regenerate it once, in its own commit, after all parallel work is merged.

## Tests changed (existing tests)
No other test was weakened, and no test that tested live code was removed. The changes:
- `tests/unit/circle-agent-stack.test.ts`: deleted with `src/adapters/circleAgentStack.ts`. It had 11 cases at base. Seven exercised
  `executeBindSettlement` and were removed in the first commit (simulated execution, a live success with and without a hash,
  revert classification, timeout, a missing binary, malformed output). The remaining four exercised the read-only query and the
  flag helper, which only this dead module used, so the file was deleted in this change.
- `tests/unit/bindTemplateAgent.test.ts`: 6 cases at base. The first commit renamed one case to check only the read-only vendor
  query and removed its assertions on `requiresOwnerApprovalGate` and `executeBindSettlement`. This change deletes that case and
  its import of the removed module. 5 cases remain.
- `tests/integration/`: no test imported the removed code.

## Consequences
- The only route that moves value is the settlement adapter, reached through the gate and the ledger, as before.
- A new model-facing tool fails the allowlist test until it is reviewed and listed with its effect class.
- A new wallet command, a new contract write outside the adapter, a new `transferUSDC` caller, a new spawn in product code, a
  home-directory skill, a sandbox backend, or a wallet instruction in a template fails a test.
- The scan is a text scan. Its limits are stated above.
- Historical records (ADR 0057, the completion plan under `docs/superpowers/plans/`, and the generated `.ua/` graph) still name the
  removed modules. They are not edited.

## Evidence
Greps, on this tree after the change (the brief's claim was confirmed before the change):
- `circleAgentStack` importers outside docs and `.ua/`: none. Before the deletion, the only importers were
  `tests/unit/circle-agent-stack.test.ts` and `tests/unit/bindTemplateAgent.test.ts`.
- `wallet execute` and `circle wallet` in `templates/` and `src/templates/`: none.
- `homedir` with `.agents` in `src/` and `templates/`: none. Before the first commit, only `bindCircleDeepAgent.ts` matched.

Commands (run on this tree):
- `npx tsc --noEmit`: exit 0. `npm run typecheck` (root, sdk, mcp): exit 0. `npm run lint`: exit 0.
- `npx vitest run tests/unit`: 69 files, 880 tests passed. The scan test has 31 cases.
- Integration, with the private local PostgreSQL (`DATABASE_URL` set to the `bind_gate_agent` database, `NODE_ENV=test`): the MCP
  files (`mcp`, `hosted-mcp`, `hosted-mcp-hardening`), `api-contract`, `openapi-route`, `sdk`, `demo`, `demo-failure-injection`,
  `replenish-key`, `workflow-orchestrator`, `untrusted-input`, `studio-flows`, `worker`, and the nine integration files that import
  `src/agents/`: 21 files, 243 tests passed.

Mutation proof. Each mutation was applied to a scratch copy under the scratchpad (`/tmp/claude-0/-home-user-bind/efa03819-b474-56c8-b12f-105e813ff429/scratchpad`), never to the worktree, and the scan test was run:
- Original set (`mutate.sh`, all 10 caught, control passes): M1 a new tool `send_usdc_payment` (c); M2 `walletClient.writeContract` in an
  agent file (a) and (c); M3 an agent importing the settlement adapter (b); M4 `execFile("circle", ["wallet","execute"])` in
  `src/workflows` (a); M5 `os.homedir()` with `.agents` (d); M6 `skills: ["/home/user/.agents/skills"]` (d); M7 a second
  `.transferUSDC(` caller (e); M8 `authorizeCommitment(` renamed (c); M9 `import ... from "pg"` in `mcp/src` (c); M10 control.
- Review set (`mutate2.sh`, all 15 caught, control passes): `new DynamicStructuredTool` with a payment name (c); an aliased
  `import { tool as t }` (c); a `registry.tool(` method call (c); `server.registerTool` outside the MCP server (c); `c.writeContract (`
  with a space (a); a `.cjs` file spawning `circle` (a) and the child-process rule; an unlisted `scripts/` spawn (child-process rule);
  `adapter?.transferUSDC?.()` (e); `adapter["transferUSDC"]()` (e); a re-export from the settlement adapter (e); an
  `authorizeCommitment(` that exists only in a comment, so the handler bypasses the gate (c); a destructured alias of
  `transferUSDC` (e); `circle wallet` in a template `.md` (a); a call placed before a trailing comment (e); `walletClient` in a `.mts`
  file (a).
- The FilesystemBackend pin: a deep agent built on a sandbox backend fails (d).

Classification:
- `LOCAL_PASS`: the typecheck, the lint, the unit and integration runs above, and the mutation proofs.
- `NOT_RUN`: any live Circle call, any network call, and any test against a live Arc chain. None was made.
- `NOT_RUN`: the Circle CLI and Agent Wallet findings above. They are the coordinator's reading and were not re-verified here.
- `docs/RELEASE_EVIDENCE.md` is not edited by this change. The coordinator adds the entry for this run.
