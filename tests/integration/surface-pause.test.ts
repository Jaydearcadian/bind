import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { config } from "../../src/config/env.js";
import { signPayload, workspaceWebhookSecret } from "../../src/webhooks/signing.js";

/*
 * A stock count from a surface while the workspace is paused (ADR 0023). The count is a fact and is stored. The
 * replenishment it would start is skipped, and the event is answered with 200, not an error.
 */

const run = Date.now();
const wsP = `ws-spause-${run}`;
const SKU = `SKU-SPAUSE-${run}`;
const SURFACE_PATH = "/api/webhooks/incoming";
const MASTER = config.BIND_MASTER_SECRET ?? "";

const nowSec = () => Math.floor(Date.now() / 1000);

/** The two headers that authenticate a raw body, over its exact bytes. */
function signHeaders(raw: string, secret: string, timestamp: number = nowSec()): Record<string, string> {
  return {
    "x-bind-timestamp": String(timestamp),
    "x-bind-signature": signPayload(secret, timestamp, raw),
  };
}

function stockEvent(workspaceId: string, actorId: string, observedQuantity: number, eventId: string) {
  return {
    eventType: "SURFACE_STOCK_OBSERVED",
    eventId,
    workspaceId,
    surface: "whatsapp",
    actorId,
    actorRole: "owner",
    sku: SKU,
    observedQuantity,
  };
}

describe("A stock count during a pause is stored and replenishment is skipped", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  const ownerActor = `owner-sp-${run}`;

  async function call(method: string, routePath: string, opts: { token?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsP, "Surface Pause Kitchen", "kitchen-v1");
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
    const owner = await issueToken(wsP, "owner", "alice-surface-pause");
    const add = await call("POST", `/api/workspaces/${wsP}/inventory`, {
      token: owner.token,
      body: {
        sku: SKU,
        name: "Surface Pause Flour",
        category: "Dry Goods",
        unit: "bag",
        currentQuantity: 10,
        parLevel: 10,
        reorderQuantity: 5,
        unitPriceCents: 1000,
      },
    });
    expect(add.status).toBe(201);
    const bind = await call("POST", `/api/workspaces/${wsP}/surfaces`, {
      token: owner.token,
      body: { surface: "whatsapp", actorId: ownerActor, actorLabel: ownerActor, actorRole: "owner" },
    });
    expect(bind.status).toBe(201);
    const paused = await call("PUT", `/api/workspaces/${wsP}/agents-paused`, { token: owner.token, body: { paused: true } });
    expect(paused.status).toBe(200);
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await query(`DELETE FROM inbound_webhooks WHERE provider = $1;`, [`surface:${wsP}:whatsapp`]);
    await query(`DELETE FROM workspaces WHERE id = $1;`, [wsP]);
    await fs.rm(path.resolve(process.cwd(), "templates", wsP), { recursive: true, force: true });
    await closePool();
  });

  it("a stock count during a pause is stored and replenishment is skipped with 200", async () => {
    const eventId = `evt_surface_pause_${run}`;
    const raw = JSON.stringify(stockEvent(wsP, ownerActor, 3, eventId));
    const res = await fetch(`${baseUrl}${SURFACE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signHeaders(raw, workspaceWebhookSecret(MASTER, wsP, 1)) },
      body: raw,
    });
    const body: any = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: "processed",
      eventType: "SURFACE_STOCK_OBSERVED",
      observedQuantity: 3,
      parLevel: 10,
      replenishmentTriggered: false,
      replenishmentSkipped: "AGENTS_PAUSED",
    });
    expect(body.replenishmentResult).toBeNull();

    const stored = await query(`SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`, [wsP, SKU]);
    expect(Number(stored.rows[0].current_quantity)).toBe(3);

    const workflows = await query(
      `SELECT COUNT(*)::int AS n FROM workflows WHERE workspace_id = $1 AND context_data->>'sku' = $2;`,
      [wsP, SKU]
    );
    expect(workflows.rows[0].n).toBe(0);
  });
});
