import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { AgentsPausedError, ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";

const run = Date.now();
const wsId = `ws-paused-restock-${run}`;
const SKU = "FOOD-PAUSE-FLOUR";

describe("a paused restock is refused with a typed code (ADR 0023, ADR 0040)", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  let ownerToken = "";
  let staffToken = "";

  async function api(method: string, routePath: string, token: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsId, "Paused Restock Kitchen", "kitchen-v1");
    ownerToken = (await issueToken(wsId, "owner", "paused-owner")).token;
    staffToken = (await issueToken(wsId, "staff", "paused-staff")).token;
    await query(
      `INSERT INTO inventory_items (id, workspace_id, sku, name, category, unit, current_quantity, par_level, reorder_quantity, unit_price_cents, updated_at)
       VALUES ($1, $2, $3, 'Pause Test Flour', 'Dry Goods', 'bag', 1, 10, 5, 1000, NOW());`,
      [`inv_${wsId}_${SKU}`, wsId, SKU]
    );
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

  it("a paused restock answers 400 with the AGENTS_PAUSED code and the same message", async () => {
    const paused = await api("PUT", `/api/workspaces/${wsId}/agents-paused`, ownerToken, { paused: true });
    expect(paused.status).toBe(200);

    const refused = await api("POST", `/api/workspaces/${wsId}/replenish`, staffToken, { sku: SKU });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("AGENTS_PAUSED");
    expect(refused.body.error).toBe(
      "[AGENTS_PAUSED] The owner has paused the agents for this workspace. Resume them before starting a replenishment."
    );

    // The runner throws the typed error that the route maps, and the message is unchanged from the one the sweep matches.
    const thrown = await new ProcurementWorkflowRunner().startReplenishment(wsId, SKU, "owner_manual_trigger").catch((e) => e);
    expect(thrown).toBeInstanceOf(AgentsPausedError);
    expect((thrown as AgentsPausedError).code).toBe("AGENTS_PAUSED");
    expect((thrown as Error).message).toBe(refused.body.error);

    // Nothing started: no workflow exists for the sku.
    const wf = await query(`SELECT COUNT(*)::int AS n FROM workflows WHERE workspace_id = $1 AND context_data->>'sku' = $2;`, [wsId, SKU]);
    expect(wf.rows[0].n).toBe(0);

    await api("PUT", `/api/workspaces/${wsId}/agents-paused`, ownerToken, { paused: false });
  });
});
