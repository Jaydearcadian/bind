import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import { createApp } from "../../src/server/app.js";
import { ASYNC_SAFE, wrapAsyncHandlers } from "../../src/server/errors.js";
import { closePool, query } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";

/*
 * A database failure inside a route (Task 11 follow-up, docs/decisions/0031). A failed query must answer a safe JSON error and
 * must never end the process. Express 4 does not catch a rejected promise from an async handler; the route wrapper does.
 */

/** The next query that is not a token lookup rejects once, with a driver-like error that names the SQL text. */
const failure = vi.hoisted(() => ({ armed: false }));

vi.mock("../../src/db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/client.js")>();
  const guarded: typeof actual.query = (text, params) => {
    // Authentication is not the failure under test: a token lookup is passed through, so the route's own query fails.
    if (failure.armed && !/token/i.test(String(text))) {
      failure.armed = false;
      const err = Object.assign(new Error(`relation "secret_table" does not exist (SQLSTATE 42P01) at ${String(text).slice(0, 80)}`), {
        code: "42P01",
      });
      return Promise.reject(err);
    }
    return actual.query(text, params);
  };
  return { ...actual, query: guarded };
});

const run = Date.now();
const SQL_TEXT = /SELECT|INSERT|FROM |relation|SQLSTATE|secret_table|42P01/i;

describe("Route failures: a database error inside a route is a safe JSON error and the server keeps serving", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  let owner: { id: string; token: string };
  const wsId = `wu-route-${run}`;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  async function send(method: string, routePath: string, json?: unknown) {
    const headers: Record<string, string> = { Authorization: `Bearer ${owner.token}` };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, text, body, contentType: res.headers.get("content-type") ?? "" };
  }

  beforeAll(async () => {
    process.on("unhandledRejection", onUnhandled);
    await runMigrations();
    await provisionWorkspace(wsId, "Route Failure Kitchen", "kitchen-v1");
    owner = await issueToken(wsId, "owner", "route-failure");
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    process.off("unhandledRejection", onUnhandled);
    failure.armed = false;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await query(`DELETE FROM workspaces WHERE id = $1;`, [wsId]);
    await fs.rm(path.resolve(process.cwd(), "templates", wsId), { recursive: true, force: true });
    await closePool();
  });

  it("a database failure in a read route answers 500 JSON and the server keeps serving", async () => {
    const reads: Array<[string, string]> = [
      ["inventory", `/api/workspaces/${wsId}/inventory`],
      ["audit", `/api/workspaces/${wsId}/audit`],
      ["orders", `/api/workspaces/${wsId}/orders`],
      ["approvals", `/api/workspaces/${wsId}/approvals`],
      ["workflows", `/api/workspaces/${wsId}/workflows`],
      ["suppliers", `/api/workspaces/${wsId}/suppliers`],
      ["ledger", `/api/workspaces/${wsId}/accounting/ledger`],
      ["needs-attention", `/api/workspaces/${wsId}/needs-attention`],
    ];
    for (const [label, routePath] of reads) {
      failure.armed = true;
      const r = await send("GET", routePath);
      expect(r.status, label).toBe(500);
      expect(r.contentType, label).toMatch(/json/);
      expect(r.body, label).toMatchObject({ error: "Internal error" });
      expect(SQL_TEXT.test(r.text), `${label} leaked SQL: ${r.text}`).toBe(false);
      expect(failure.armed, `${label}: the failure was not reached`).toBe(false);

      // The same server answers the next request normally.
      const after = await send("GET", `/api/workspaces/${wsId}/suppliers`);
      expect(after.status, `${label}: server after failure`).toBe(200);
    }
    expect(unhandled, "an unhandled rejection was raised").toEqual([]);
  });

  it("a database failure in a write route answers a safe error and the server keeps serving", async () => {
    failure.armed = true;
    const r = await send("POST", `/api/workspaces/${wsId}/inventory`, {
      sku: `FOOD-FAIL-${run}`,
      name: "Failure Probe",
      category: "food",
      unit: "kg",
      currentQuantity: 1,
      parLevel: 1,
      reorderQuantity: 1,
      unitPriceCents: 100,
    });
    expect(failure.armed, "the write failure was not reached").toBe(false);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(r.body).toMatchObject({ error: "Request could not be processed" });
    expect(SQL_TEXT.test(r.text)).toBe(false);

    const health = await send("GET", "/health");
    expect(health.status).toBe(200);
    expect(unhandled).toEqual([]);
  });

  it("every route handler is wrapped", () => {
    const stack = (createApp() as any)._router.stack as Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: any }> } }>;
    let checked = 0;
    for (const layer of stack) {
      if (!layer.route) continue;
      const method = Object.keys(layer.route.methods)[0].toUpperCase();
      for (const entry of layer.route.stack) {
        checked += 1;
        expect(entry.handle[ASYNC_SAFE], `${method} ${layer.route.path} has an unwrapped handler`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(80);
  });

  it("a handler that rejects reaches next, not an unhandled rejection", async () => {
    const probe = express();
    wrapAsyncHandlers(probe);
    const boom = new Error("boom from a route");
    probe.get("/x", async () => {
      throw boom;
    });
    probe.get("/y", () => {
      throw boom;
    });
    const layers = (probe as any)._router.stack.filter((l: { route?: unknown }) => l.route);
    const next = vi.fn();
    layers[0].route.stack[0].handle({}, {}, next);
    layers[1].route.stack[0].handle({}, {}, next);
    await new Promise((resolve) => setImmediate(resolve));
    expect(next).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenNthCalledWith(1, boom);
    expect(next).toHaveBeenNthCalledWith(2, boom);
    expect(unhandled).toEqual([]);
  });
});
