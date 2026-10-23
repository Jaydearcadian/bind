# 0062: Team and limits

Status: Accepted. Built on existing routes; no API change.

## Decision
- `/app/team`: the workspace's two limits (approval threshold, daily limit) as plain sentences with a slider and a dollar field each, Cautious ($50/$250), Balanced ($250/$1,000) and Trusting ($1,000/$5,000) presets, a live summary, and Save. Saving calls `updatePolicy` with an idempotency key and shows the values the server stored. A threshold above the daily limit is refused before sending (the server refuses it too).
- A card per agent from `getAgents`: renamable name, description, permitted effects in plain words ("Can look", "Can ask suppliers and services", "Can commit the business, inside your limits and approvals"), each safe tool as a switch, the agent on or off, and "See everything" with the raw role, effects, tools, the role's configured spend limit and what is never allowed. Changes call `upsertAgentRole` with the role's other fields unchanged. An agent must keep at least one tool (the API requires it); the page says to turn the agent off instead.
- Staff see the same page read-only.
- Per-agent pause and per-agent budgets are not offered (the brief), and the role's configured spend limit is shown read-only as configuration, not as an enforced budget.

## Evidence
`tests/web/team.spec.ts`: 6 browser tests (desktop and phone): limits read from the server, an impossible pair refused, a preset saved and checked on the server; a tool switched off, a rename and turning an agent off, each checked on the server; staff read-only. Screens inspected at 1280 px light and 390 px dark. `LOCAL_PASS`.

## Not done
Adding a new agent role, changing permitted effects, and any per-agent budget.
