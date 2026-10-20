import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";

const run = Date.now();
const wsId = `ws-policy-types-${run}`;

describe("policy limits are JSON numbers, not numeric text (ADR 0040)", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  let ownerToken = "";

  async function putPolicy(raw: string) {
    const res = await fetch(`${baseUrl}/api/workspaces/${wsId}/policy`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: raw,
    });
    return { status: res.status, body: await res.json() };
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsId, "Policy Types Kitchen", "kitchen-v1");
    ownerToken = (await issueToken(wsId, "owner", "policy-owner")).token;
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await query(`DELETE FROM workspaces WHERE id = $1;`, [wsId]);
    await closePool();
  });

  it("policy limits must be integers, not numeric strings", async () => {
    const before = await query(`SELECT budget_daily_limit_cents, approval_threshold_cents FROM workspaces WHERE id = $1;`, [wsId]);

    // Numeric text is refused with the existing messages, although Number() would read it.
    const textBudget = await putPolicy('{"budgetDailyLimitCents":"100000","approvalThresholdCents":1000}');
    expect(textBudget).toMatchObject({ status: 400, body: { error: "budgetDailyLimitCents must be a positive integer." } });
    const textThreshold = await putPolicy('{"budgetDailyLimitCents":100000,"approvalThresholdCents":"1000"}');
    expect(textThreshold).toMatchObject({ status: 400, body: { error: "approvalThresholdCents must be a non-negative integer." } });
    const notANumber = await putPolicy('{"budgetDailyLimitCents":"NaN","approvalThresholdCents":1000}');
    expect(notANumber.status).toBe(400);
    const floatBudget = await putPolicy('{"budgetDailyLimitCents":1000.5,"approvalThresholdCents":10}');
    expect(floatBudget).toMatchObject({ status: 400, body: { error: "budgetDailyLimitCents must be a positive integer." } });
    const emptyText = await putPolicy('{"budgetDailyLimitCents":"","approvalThresholdCents":0}');
    expect(emptyText.status).toBe(400);

    // Nothing was stored by a refused request.
    expect(await query(`SELECT budget_daily_limit_cents, approval_threshold_cents FROM workspaces WHERE id = $1;`, [wsId])).toEqual(before);

    // Real JSON numbers are accepted.
    const ok = await putPolicy('{"budgetDailyLimitCents":100000,"approvalThresholdCents":1000}');
    expect(ok.status).toBe(200);
    expect(ok.body.workspace.budget_daily_limit_cents).toBe("100000");
  });
});
