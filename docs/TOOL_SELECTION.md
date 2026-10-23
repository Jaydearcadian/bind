# Tool selection and non-selection decisions

The reference list is useful as a catalog, not a mandate to install everything. Multiple orchestration products, agent runtimes, UI generators, memory systems, and skill packs would compete for control and increase setup, security, and debugging work.

## Base environment

| Source | Decision | Intended use |
|---|---|---|
| [infragate/capa](https://github.com/infragate/capa) | Adopt | Shared, version-controlled skill/MCP/agent configuration; commit its generated lockfile. Review executable surfaces before installation. |
| [fynnfluegge/agtx](https://github.com/fynnfluegge/agtx) | Adopt as the single orchestrator | One-shot task board and parallel worktree execution. Its oneshot workflow merges work into its configured base branch, so set that to a dedicated feature branch before running; otherwise AGTX may prefer `main`/`master`. Do not add Kandev or another coordinator alongside it. |
| [upstash/context7](https://github.com/upstash/context7) and [intellectronica/agent-skills](https://github.com/intellectronica/agent-skills) | Adopt | Current version-specific library/framework documentation and skill guidance. API key is optional for higher Context7 rate limits. |
| [bitjaru/styleseed](https://github.com/bitjaru/styleseed) | Adopt | Locked visual direction and a design quality review loop. Its numeric score is not expert sign-off and must be paired with real browser QA. |
| [anthropics/skills: frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | Adopt | UI design judgment during implementation; not a separate application framework. |
| [Microsoft Playwright](https://playwright.dev/docs/test-intro) | Adopt as project test dependency | Local browser automation. The E2E suite is not run and is not in CI: the UI is orphaned (ADR 0016), and `npm run test:e2e` is BLOCKED. Prefer this over a credential-gated hosted UX-evaluation tool for required tests. |
| [umputun/revdiff](https://github.com/umputun/revdiff) | Optional, recommended for final review | Annotated diff/spec/CI review; works as a local terminal tool and does not require a hosted evaluation API. |
| [Foundry / Anvil](https://www.getfoundry.sh/anvil/overview) | Adopt when EVM contract boundaries exist | Local EVM, deployment, Forge tests, fuzzing, invariants, coverage, and gas checks. |
| [kharmanskyi/open-steps](https://github.com/kharmanskyi/open-steps) | Pattern only | Plain-language progress and delivery summaries. The project instructions in this kit already require this style, so it need not be installed as another pack. |

## Optional only when the need arises

- [bgauryy/octocode](https://github.com/bgauryy/octocode): useful for local/GitHub/npm code research. Add only if the active coding agent lacks adequate repository search; authenticated GitHub access is optional but improves limits/private-repo access.
- [Egonex-AI/Understand-Anything](https://github.com/Egonex-AI/Understand-Anything) **or** [Jakedismo/codegraph-rust](https://github.com/Jakedismo/codegraph-rust): codebase graphing/impact analysis can help with an already large existing repo. These overlap enough that only one should be evaluated, after ordinary source search proves insufficient. Initial indexing can consume substantial tokens/resources.
- [refreshdotdev/web-eval-agent](https://github.com/refreshdotdev/web-eval-agent): optional secondary UX review only if its external service/API key is available. It is not needed for mandatory local Playwright testing.
- [nexu-io/open-design](https://github.com/nexu-io/open-design): optional collaborative design workspace. Do not make it a dependency of local build/test or require its cloud service.
- [spec-kitty](https://github.com/spec-kitty/spec-kitty): sound reference for repo-native specs and review gates, but its work package/worktree governance overlaps with the chosen AGTX workflow. Do not run both as active orchestrators in the base environment. Re-evaluate only if AGTX fails the actual workflow.
- [vibe-check](https://github.com/TexasBedouin/vibe-check), [AI Product Development Toolkit](https://github.com/TechNomadCode/AI-Product-Development-Toolkit), and product-planning skill packs: useful before product boundaries are settled, but should not keep reopening Bind's already-defined initial vertical slice during implementation.

## Do not install in the base environment

These items are not rejected as projects; they are excluded because they solve different or overlapping problems, bind to a different hosting stack, or are full agent runtime/application products rather than necessary coding-harness components.

- [Kandev](https://github.com/kdlbs/kandev), [Kaku](https://github.com/tw93/Kaku), [Mysti](https://github.com/DeepMyst/Mysti), [AgentSys](https://github.com/agent-sh/agentsys), [Ruflo](https://github.com/ruvnet/ruflo), [Swarms](https://github.com/kyegomez/swarms), and other parallel-agent managers: do not put multiple coordinators in charge of the same run.
- [Dify](https://github.com/langgenius/dify), [Flowise](https://github.com/FlowiseAI/Flowise), [Sim](https://github.com/simstudioai/sim), [Solace Agent Mesh](https://github.com/SolaceLabs/solace-agent-mesh), [DeerFlow](https://github.com/bytedance/deer-flow), and [PocketFlow](https://github.com/The-Pocket/PocketFlow): agent frameworks/platforms are possible future product decisions, not extra base dependencies. First implement Bind's smallest real workflow.
- [CloudBase AI Toolkit](https://github.com/TencentCloudBase/CloudBase-AI-Toolkit) and [Cloudflare VibeSDK](https://github.com/cloudflare/vibesdk): useful inside their respective platforms, but unnecessary unless Bind explicitly selects that hosting/runtime.
- [Lotti](https://github.com/matthiasn/lotti): product/architecture reference for proposed actions, user approval, and auditable history. It is a separate Flutter application under GPL-3.0; do not copy its source into Bind without a deliberate license review.
- Do not add unrelated frameworks, marketing skill packs, UI generators, data viewers, and app starters just because they appear in an awesome-list. Keep the lockfile and attack surface small.

## Required provenance for any added tool

Before adding a capability, record the exact job it solves, why existing tools cannot solve it, required credentials/permissions, license, local-vs-hosted behavior, pinned source/version, and removal path. Run CAPA's dry run and inspect the executable surface. Never grant a research sub-agent write/push/deploy authority by default.
