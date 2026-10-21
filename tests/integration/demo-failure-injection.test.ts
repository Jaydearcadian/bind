import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { setLogSink } from "../../src/observability/logger.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { createDemoWorkspace } from "../../src/demo/service.js";
import { deleteDemoRows, purgeExpiredDemos } from "../../src/demo/purge.js";

/**
 * Demo creation and reset when a write fails (docs/decisions/0057). Real PostgreSQL and real HTTP through createApp. Only the
 * failing write is injected, and only in this test file's process: the audit write of a new demo is made to reject once, and
 * the delete of the old demo is made to reject once. Everything else is the real code path. Faults are not injected with
 * database triggers, because the database is shared with the other integration files and a trigger on `workspaces` or
 * `audit_logs` would reach their writes.
 *
 * Two failures are covered:
 *  - the audit row of a new demo cannot be written: the half-made demo must not be left behind, and the error must surface;
 *  - the old demo of a reset cannot be deleted: the visitor gets the new demo, the old one keeps working until it expires,
 *    and no extra workspace is left.
 */

vi.mock("../../src/demo/purge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/demo/purge.js")>();
  // The export is a pass-through until a test makes one call reject. purgeExpiredDemos keeps its own reference, as before.
  return { ...actual, deleteDemoRows: vi.fn(actual.deleteDemoRows) };
});

const AUDIT_ERROR = "injected audit write failure";
const DELETE_ERROR = "injected delete failure";
const createdDemoIds = new Set<string>();

interface Reply {
  status: number;
  text: string;
  body: any;
}

async function call(base: string, method: string, routePath: string, opts: { token?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${routePath}`, { method, headers, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, text, body };
}

async function listen(app: ReturnType<typeof createApp>): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const port = addr && typeof addr === "object" ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A demo created through the public route. Recorded for cleanup. */
async function createDemo(url: string): Promise<{ workspaceId: string; token: string }> {
  const reply = await call(url, "POST", "/api/demo");
  expect(reply.status, reply.text).toBe(201);
  createdDemoIds.add(reply.body.workspaceId);
  return { workspaceId: reply.body.workspaceId, token: reply.body.token };
}

async function demoIds(): Promise<string[]> {
  const res = await query(`SELECT id FROM workspaces WHERE is_demo ORDER BY id;`);
  return res.rows.map((row) => String(row.id));
}

describe("demo creation and reset with a failing write (docs/decisions/0057)", () => {
  const app = createApp({ rateLimits: { enabled: false }, metrics: { token: null }, demo: { enabled: true, maxActive: 10_000 } });
  let server: { url: string; close: () => Promise<void> };
  let auditSpy: ReturnType<typeof vi.spyOn>;
  const logLines: string[] = [];

  beforeAll(async () => {
    await runMigrations();
    server = await listen(app);
    auditSpy = vi.spyOn(WorkflowEngine.prototype, "recordAudit");
  }, 120_000);

  afterAll(async () => {
    auditSpy?.mockRestore();
    setLogSink(null);
    if (server) await server.close();
    const ids = [...createdDemoIds];
    if (ids.length > 0) {
      await query(`DELETE FROM idempotency_keys WHERE workspace_id = ANY($1::text[]);`, [ids]);
      await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [ids]);
    }
    for (const id of ids) {
      await fs.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    }
    await closePool();
  });

  it("a demo whose audit row cannot be written is not left behind, and the error reaches the caller", async () => {
    const before = await demoIds();
    auditSpy.mockRejectedValueOnce(new Error(AUDIT_ERROR));
    await expect(createDemoWorkspace({ maxActive: 10_000 })).rejects.toThrow(AUDIT_ERROR);

    // No demo workspace was added, and no owner token exists for one.
    const leaked = (await demoIds()).filter((id) => !before.includes(id));
    expect(leaked).toEqual([]);
    const orphanTokens = await query(
      `SELECT COUNT(*)::int AS n FROM workspace_tokens t JOIN workspaces w ON w.id = t.workspace_id
        WHERE w.is_demo AND t.label = 'demo-owner' AND w.id <> ALL($1::text[]);`,
      [before]
    );
    expect(Number(orphanTokens.rows[0].n)).toBe(0);
  });

  it("the route answers 500 with no internal detail when a create cannot be recorded, and creates nothing", async () => {
    const before = await demoIds();
    auditSpy.mockRejectedValueOnce(new Error(AUDIT_ERROR));
    const reply = await call(server.url, "POST", "/api/demo");
    expect(reply.status).toBe(500);
    // The standard error envelope (ADR 0050) with the generic message and no database detail.
    expect(reply.body.error).toBe("Demo operation failed");
    expect(reply.body.code).toBe("INTERNAL_ERROR");
    expect(reply.text).not.toContain(AUDIT_ERROR);
    expect((await demoIds()).filter((id) => !before.includes(id))).toEqual([]);
  });

  it("a reset whose new demo cannot be recorded leaves the visitor's demo working and creates nothing", async () => {
    const demo = await createDemo(server.url);
    const before = await demoIds();
    auditSpy.mockRejectedValueOnce(new Error(AUDIT_ERROR));
    const reply = await call(server.url, "POST", `/api/workspaces/${demo.workspaceId}/demo/reset`, { token: demo.token });
    expect(reply.status).toBe(500);
    expect(reply.text).not.toContain(AUDIT_ERROR);

    // The old demo was never touched: it still exists, and its token works.
    expect((await demoIds()).filter((id) => !before.includes(id))).toEqual([]);
    expect((await demoIds()).includes(demo.workspaceId)).toBe(true);
    const still = await call(server.url, "GET", `/api/workspaces/${demo.workspaceId}`, { token: demo.token });
    expect(still.status, still.text).toBe(200);
  });

  it("a reset whose old demo cannot be deleted still returns the new demo, keeps the old one working until it expires, and leaves no extra workspace", async () => {
    const demo = await createDemo(server.url);
    const oldExpiry = (await query(`SELECT demo_expires_at FROM workspaces WHERE id = $1;`, [demo.workspaceId])).rows[0].demo_expires_at;
    const before = await demoIds();

    logLines.length = 0;
    setLogSink((line) => {
      logLines.push(line);
    });
    // The first delete of a demo's rows in this call is the old demo's, because provisioning the new one does not delete.
    vi.mocked(deleteDemoRows).mockRejectedValueOnce(new Error(DELETE_ERROR));
    let reset: Reply;
    try {
      reset = await call(server.url, "POST", `/api/workspaces/${demo.workspaceId}/demo/reset`, { token: demo.token });
    } finally {
      setLogSink(null);
    }

    // The visitor gets the new demo with credentials, as the reset promises.
    expect(reset.status, reset.text).toBe(201);
    expect(Object.keys(reset.body).sort()).toEqual(["expiresAt", "token", "workspaceId"]);
    const fresh = { workspaceId: String(reset.body.workspaceId), token: String(reset.body.token) };
    createdDemoIds.add(fresh.workspaceId);

    // The failure is logged with the old demo's id and the real error.
    const logged = logLines.map((line) => JSON.parse(line)).find((entry) => entry.event === "demo.reset_cleanup_failed");
    expect(logged, logLines.join("\n")).toBeDefined();
    expect(logged.workspaceId).toBe(demo.workspaceId);
    expect(logged.error).toContain(DELETE_ERROR);

    // The old demo is still there, its expiry is unchanged, and its token still works until it expires.
    const oldRow = await query(`SELECT is_demo, demo_expires_at FROM workspaces WHERE id = $1;`, [demo.workspaceId]);
    expect(oldRow.rows.length).toBe(1);
    expect(oldRow.rows[0].is_demo).toBe(true);
    expect(oldRow.rows[0].demo_expires_at).toEqual(oldExpiry);
    const oldStill = await call(server.url, "GET", `/api/workspaces/${demo.workspaceId}`, { token: demo.token });
    expect(oldStill.status, oldStill.text).toBe(200);

    // No orphan: the new demo is the only new workspace, its one owner token is the one returned, and it is seeded like any demo.
    expect((await demoIds()).filter((id) => !before.includes(id))).toEqual([fresh.workspaceId]);
    const tokens = await query(
      `SELECT COUNT(*)::int AS n FROM workspace_tokens WHERE workspace_id = $1 AND label = 'demo-owner' AND revoked_at IS NULL;`,
      [fresh.workspaceId]
    );
    expect(Number(tokens.rows[0].n)).toBe(1);
    const freshDetail = await call(server.url, "GET", `/api/workspaces/${fresh.workspaceId}`, { token: fresh.token });
    expect(freshDetail.status, freshDetail.text).toBe(200);
    expect(freshDetail.body.workspace.is_demo).toBe(true);
    const approvals = await call(server.url, "GET", `/api/workspaces/${fresh.workspaceId}/approvals`, { token: fresh.token });
    expect(approvals.body.filter((a: any) => a.status === "pending").length).toBe(1);

    // Once the failure is gone, the expiry sweep removes the old demo, and the new one is untouched.
    await query(`UPDATE workspaces SET demo_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1;`, [demo.workspaceId]);
    const purged = await purgeExpiredDemos(10);
    expect(purged.failures).toEqual([]);
    expect((await query(`SELECT id FROM workspaces WHERE id = $1;`, [demo.workspaceId])).rows.length).toBe(0);
    const oldAfter = await call(server.url, "GET", `/api/workspaces/${demo.workspaceId}`, { token: demo.token });
    expect(oldAfter.status).toBe(401);
    const freshAfter = await call(server.url, "GET", `/api/workspaces/${fresh.workspaceId}`, { token: fresh.token });
    expect(freshAfter.status).toBe(200);
  });
});
