import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";

/** getWorkflow, getOrder and getApproval: one resource by id, scoped to the caller's workspace. */
const run = Date.now();
const wsA = `ws-reads-a-${run}`;
const wsB = `ws-reads-b-${run}`;

describe("single-resource reads", () => {
  const app = createApp({ rateLimits: { enabled: false } });
  let server: Server;
  let baseUrl = "";
  let ownerA: { token: string };
  let staffA: { token: string };
  let ownerB: { token: string };
  const ids: { workflowId?: string; orderId?: string; approvalId?: string } = {};

  async function get(route: string, token?: string) {
    const res = await fetch(`${baseUrl}${route}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsA, "Reads A", "kitchen-v1");
    await provisionWorkspace(wsB, "Reads B", "kitchen-v1");
    ownerA = await issueToken(wsA, "owner", "alice");
    staffA = await issueToken(wsA, "staff", "line-cook");
    ownerB = await issueToken(wsB, "owner", "bob");
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
    const inventory = await get(`/api/workspaces/${wsA}/inventory`, ownerA.token);
    const sku = (inventory.body as unknown as { sku: string }[])[0].sku;
    const res = await fetch(`${baseUrl}/api/workspaces/${wsA}/replenish`, {
      method: "POST",
      headers: { Authorization: `Bearer ${staffA.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sku }),
    });
    const started = (await res.json()) as Record<string, string>;
    ids.workflowId = started.workflowId;
    ids.orderId = started.orderId;
    ids.approvalId = started.approvalId;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [[wsA, wsB]]);
    for (const id of [wsA, wsB]) await fsp.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    await closePool();
  });

  it("returns the workflow, and the order or approval it produced, to staff of the workspace", async () => {
    expect(ids.workflowId).toBeTruthy();
    const wf = await get(`/api/workspaces/${wsA}/workflows/${ids.workflowId}`, staffA.token);
    expect(wf.status).toBe(200);
    expect(wf.body.id).toBe(ids.workflowId);
    // The same row the list returns.
    const list = await get(`/api/workspaces/${wsA}/workflows`, staffA.token);
    expect((list.body as unknown as { id: string }[]).find((r) => r.id === ids.workflowId)).toMatchObject({ id: wf.body.id, state: wf.body.state });
    if (ids.orderId) {
      const order = await get(`/api/workspaces/${wsA}/orders/${ids.orderId}`, staffA.token);
      expect(order.status).toBe(200);
      expect(order.body.id).toBe(ids.orderId);
    }
    if (ids.approvalId) {
      const approval = await get(`/api/workspaces/${wsA}/approvals/${ids.approvalId}`, staffA.token);
      expect(approval.status).toBe(200);
      expect(approval.body.id).toBe(ids.approvalId);
    }
    expect(ids.orderId || ids.approvalId).toBeTruthy();
  });

  it("answers another tenant's id exactly as it answers an id that does not exist", async () => {
    const reads: [string, string | undefined, string][] = [
      ["workflows", ids.workflowId, "WORKFLOW_NOT_FOUND"],
      ["orders", ids.orderId, "ORDER_NOT_FOUND"],
      ["approvals", ids.approvalId, "APPROVAL_NOT_FOUND"],
    ];
    for (const [kind, id, code] of reads) {
      if (!id) continue;
      const foreign = await get(`/api/workspaces/${wsB}/${kind}/${id}`, ownerB.token);
      const missing = await get(`/api/workspaces/${wsB}/${kind}/nope_${run}`, ownerB.token);
      expect(foreign.status, kind).toBe(404);
      expect(foreign.body.code, kind).toBe(code);
      expect({ ...foreign.body, requestId: 0 }, kind).toEqual({ ...missing.body, requestId: 0 });
      // Reading workspace A's path with B's token is the usual tenant refusal.
      expect((await get(`/api/workspaces/${wsA}/${kind}/${id}`, ownerB.token)).status, kind).toBe(404);
      expect((await get(`/api/workspaces/${wsA}/${kind}/${id}`)).status, kind).toBe(401);
    }
  });
});
