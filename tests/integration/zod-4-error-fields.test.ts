import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import fsp from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";

/**
 * The `fields` a 400 names, from the real server (ADR 0087). zod 4 also runs a length check on a wrong-typed value, and it
 * refuses a number that JSON reads as infinity. Each failing field must still be named once, and the answer keeps its shape.
 * Two routes answer with `fields` (the customer-order and menu-proposal bodies); the error-contract wrapper moves them to
 * `details.fields`.
 */
const run = Date.now();
const wsId = `ws-z4f-${run}`;

describe("validation fields from the server after the zod 4 move", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  let owner: { token: string };

  async function send(route: string, body: string) {
    const res = await fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body,
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsId, "Zod Four Fields", "kitchen-v1");
    owner = await issueToken(wsId, "owner", "alice");
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await query(`DELETE FROM workspaces WHERE id = $1;`, [wsId]);
    await fsp.rm(path.resolve(process.cwd(), "templates", wsId), { recursive: true, force: true });
    await closePool();
  });

  it("an empty array given for a text field names that field once", async () => {
    const res = await send(
      `/api/workspaces/${wsId}/customer-orders`,
      JSON.stringify({ externalRef: [], lines: [{ sku: "FOOD-Z4-FIELDS", quantity: 1 }] })
    );
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual(["externalRef"]);
  });

  it("a number that JSON reads as infinity (1e400) names that field", async () => {
    const body = '{"change":{"type":"add_item","name":"Sample dish","priceCents":1e400},"rationale":"sample"}';
    const res = await send(`/api/workspaces/${wsId}/menu-proposals`, body);
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual(["change.priceCents"]);
  });

  it("a menu change of an unknown type names its type field", async () => {
    const body = JSON.stringify({ change: { type: "x", name: "Sample dish", priceCents: 100 } });
    const res = await send(`/api/workspaces/${wsId}/menu-proposals`, body);
    expect(res.status).toBe(400);
    expect(res.body.details.fields).toEqual(["change.type"]);
  });
});
