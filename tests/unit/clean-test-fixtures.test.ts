import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isFixtureWorkspaceId } from "../../scripts/clean-test-fixtures.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("test fixture cleanup (npm run test:clean, ADR 0040)", () => {
  it("never matches the demo workspace or the reference templates", () => {
    expect(isFixtureWorkspaceId("ws-kitchen-main")).toBe(false);
    expect(isFixtureWorkspaceId("kitchen-ops")).toBe(false);
    expect(isFixtureWorkspaceId("coffee-roaster")).toBe(false);
    // The protected ids never match, even if a pattern were widened later.
    expect(isFixtureWorkspaceId("ws-test-kitchen-ops")).toBe(true);
    expect(isFixtureWorkspaceId("ws-kitchen-main-2")).toBe(false);
    expect(isFixtureWorkspaceId("ws-kitchen-main")).toBe(false);
  });

  it("matches the known fixture prefixes", () => {
    expect(isFixtureWorkspaceId("ws-contract-a-1792475249383")).toBe(true);
    expect(isFixtureWorkspaceId("wu-1792475249383")).toBe(true);
    expect(isFixtureWorkspaceId("ws-gate-a-1")).toBe(true);
    expect(isFixtureWorkspaceId("ws-e2e-blank-1792429139220")).toBe(true);
    expect(isFixtureWorkspaceId("ws-test-anything")).toBe(true);
    expect(isFixtureWorkspaceId("ws-untrusted-7")).toBe(true);
    // The fixture families the test suites create (ADR 0040): MCP, SDK and probe runs, and the per-file prefixes.
    expect(isFixtureWorkspaceId("ws-mcp-a-1792480602412")).toBe(true);
    expect(isFixtureWorkspaceId("ws-sdk-1")).toBe(true);
    expect(isFixtureWorkspaceId("ws-probe-new")).toBe(true);
    expect(isFixtureWorkspaceId("ws-probe2")).toBe(true);
    expect(isFixtureWorkspaceId("ws-cred-a-1")).toBe(true);
    expect(isFixtureWorkspaceId("ws-policy-types-1792488511210")).toBe(true);
    expect(isFixtureWorkspaceId("ws-approval-atomic-1")).toBe(true);
    // Prefixes that real data could use, or that are too short to be sure, are left out.
    expect(isFixtureWorkspaceId("ws-a-1")).toBe(false);
    expect(isFixtureWorkspaceId("ws-kitchen-test-1")).toBe(false);
    expect(isFixtureWorkspaceId("ws-kitchen-2")).toBe(false);
    expect(isFixtureWorkspaceId("ws-probe")).toBe(true);
    expect(isFixtureWorkspaceId("ws-unknown-family-1")).toBe(false);
    // An id that is not a plain token is never a path or a match, whatever its prefix.
    expect(isFixtureWorkspaceId("ws-test-../../x")).toBe(false);
    expect(isFixtureWorkspaceId("ws-test-a/b")).toBe(false);
    expect(isFixtureWorkspaceId("ws-test-a b")).toBe(false);
  });

  it("refuses to run when NODE_ENV is production, before it reads the database", () => {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
    const result = spawnSync(path.join(ROOT, "node_modules/.bin/tsx"), [path.join(ROOT, "scripts/clean-test-fixtures.ts")], {
      cwd: ROOT,
      encoding: "utf8",
      env,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Refused: NODE_ENV is production/);
    expect(result.stdout).toBe("");
  });
});
