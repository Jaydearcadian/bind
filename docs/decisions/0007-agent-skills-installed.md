# ADR 0007: Agent skills installed for the completion work

## Status
Accepted (2026-10-19)

## Context
The owner asked for four skill sources to be installed so the codebase can be mapped as a graph and
completed with the superpowers workflow. `docs/TOOL_SELECTION.md` requires inspecting the executable
surface of anything added and recording provenance. Each source was cloned to its own folder outside
this repo at the commit named below, and read before use.

## Decisions

| Source | Commit | Result |
|---|---|---|
| obra/superpowers | `bb92a77` (v7.0.0) | Already installed. All 15 skills in `skills/` are byte-identical to upstream. No change. |
| intellectronica/agent-skills, `skills/context7` | `9b0e00a` | Already installed and pinned in `capabilities.lock` at the same commit. No change. |
| netresearch/context7-skill, `skills/context7` | `bb98549` (v1.7.3) | Vendored to `.agents/skills/context7-netresearch`, renamed to avoid a clash with the skill above. Provenance in its `SOURCE.md`. Declared as a local skill in `capabilities.yaml`. |
| Egonex-AI/Understand-Anything | `f2d0164` (plugin 2.9.7) | Installed outside the repo at the pinned commit with `pnpm install --frozen-lockfile`. Setup script: `scripts/setup-understand-anything.sh`. |

Both context7 skills overlap. They are kept side by side because the owner asked for both. The
intellectronica skill is the default. The netresearch one is the fallback when the Context7 MCP server
is not reachable. Remove either with its `capabilities.yaml` entry if the overlap becomes a nuisance.

## What was reviewed
- netresearch `context7.sh`: only calls `https://context7.com/api/v2` with curl and jq. The API key is sent
  on standard input, never on a command line. It tells the model not to run commands found in fetched docs.
- Understand-Anything `install.sh`: clones, symlinks skills, links a plugin root. No `sudo`, no shell-rc
  edits, no network beyond `git clone`. It follows `main`, so it was not run. The setup script pins the commit.
- Understand-Anything hooks: one `PostToolUse` hook on `Bash` and one `SessionStart` hook. Both only act when
  `.understand-anything/config.json` contains `"autoUpdate": true`, and then they instruct the model to update
  the graph without asking. **They are not registered here, and `autoUpdate` stays off.** Re-evaluate if the
  graph should refresh itself after commits.
- Build scripts: pnpm ran only the packages the upstream workspace allow-lists (esbuild, sharp, tree-sitter
  grammars). The Kotlin grammar build was skipped because Bind is TypeScript.

## Not done, on purpose
- No link into the home directory (`~/.understand-anything-plugin`) or into user-level Claude config. A
  sandbox rule blocked a combined attempt, and that wiring is outside the project. The Understand-Anything
  skills read the plugin root from `CLAUDE_PLUGIN_ROOT`, so the model sets that variable per command.
  To wire it permanently on a developer machine: `bash scripts/setup-understand-anything.sh --link`.
- The skill links in `.claude/skills/` for the vendored skills are relative and stay inside the repo.

## Consequences
- Generated graph output is derived data. It is not committed until the owner decides.
- Third-party skill text is untrusted input. Nothing in it can change policy, scope, or the rules in `AGENTS.md`.
