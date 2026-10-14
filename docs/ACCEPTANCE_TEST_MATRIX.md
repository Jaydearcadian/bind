# Bind acceptance test matrix

| Layer | Required proof | Primary failure cases |
|---|---|---|
| Business logic | Unit tests for workspace, agents, policy, effect classification, budgets, approvals, order states | Invalid input, limit boundary, unauthorized actor, wrong state |
| API/schema | Request/response contract tests and validation | Missing/extra fields, malformed payload, auth failure, schema drift |
| Persistence | Database integration and migration tests | Failed transaction, duplicate writes, old schema, cross-tenant query |
| Queue/worker | Durable execution and recovery tests | Crash between steps, redelivery, concurrent worker, backoff exhausted |
| Tool adapters | Contract test per adapter and local integration test | Timeout, bad response, rate limit, revoked credential, prompt injection |
| Commercial authority | Negative tests proving no unauthorized effect can execute | Over-budget order, no approval, expired approval, changed quote, replay |
| Smart contracts | Forge unit/fuzz/invariant and Anvil deployment/client tests where applicable | Access-control bypass, replay, double settlement, wrong config, reentrancy where relevant |
| Events/reconciliation | Event and state reconciliation tests | Duplicate/out-of-order logs, reverted/unknown tx, incorrect external reference |
| Browser E2E | Playwright journeys on the running app with UI and backend assertions | Broken onboarding, wrong status, missing approval, duplicate order, hidden failure |
| Security/privacy | Dependency/secret scans, static analysis, auth and tenant isolation tests | Secret leakage, SSRF/injection where relevant, object ID substitution, unsafe debug endpoint |
| Reliability | Restart, retry, fault injection and realistic load smoke | DB/RPC down, worker termination, backlog, pool exhaustion, unbounded work |
| Production readiness | Reproducible clean install/build, CI parity, deployment dry-run, runbook | Missing env config, wrong chain ID, absent recovery instructions, unverified integration |

All reports must classify evidence. Automated local tests do not establish live remote functionality.
