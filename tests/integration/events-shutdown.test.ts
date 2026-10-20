import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { issueToken } from "../../src/auth/tokens.js";
import { newId } from "../../src/utils/ids.js";
import { createShutdown, type ShutdownLog } from "../../src/server/shutdown.js";
import { closeAllEventStreams } from "../../src/api/event-streams.js";

/*
 * Shutdown with an open event stream (docs/decisions/0035). A long stream must not hold the shutdown for the 20 second
 * limit: the stream is told to reconnect elsewhere, and the server closes. Real HTTP on port 0, real PostgreSQL.
 */

const silentLog: ShutdownLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
const run = Date.now();
const WS = `ws-events-shutdown-${run}`;

describe("event streams and shutdown (docs/decisions/0035)", () => {
  let server: Server;
  let baseUrl = "";
  let token = "";

  beforeAll(async () => {
    await runMigrations();
    await query(`INSERT INTO workspaces (id, name, template_id) VALUES ($1, $2, 'kitchen-v1');`, [WS, "Shutdown events"]);
    token = (await issueToken(WS, "owner", "shutdown-owner")).token;
    await query(
      `INSERT INTO audit_logs (id, workspace_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
       VALUES ($1, $2, 'system', 'system:test', 'read', 'shutdown.seed', 'ALLOW', '{}'::jsonb, NOW());`,
      [newId("audit"), WS]
    );
    const app = createApp({ metrics: { token: null }, events: { pollIntervalMs: 50, heartbeatMs: 200 } });
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    // The shutdown under test has already closed the server. Only the database is released here.
    await query(`DELETE FROM workspaces WHERE id = $1;`, [WS]);
    await closePool();
  });

  it("shutdown ends open streams promptly and tells clients to reconnect", async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/workspaces/${WS}/events`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Reads until the shutdown frame arrives or the stream ends, and returns everything it saw.
    const readAll = async (): Promise<string> => {
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return text;
        text += decoder.decode(value, { stream: true });
        if (text.includes("event: shutdown")) {
          // The frame is complete when its blank line has arrived; the stream then ends.
          if (text.includes("data: {}\n\n")) return text;
        }
      }
    };

    // Let the stream reach its idle loop before shutdown starts.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const shutdown = createShutdown({
      server,
      worker: null,
      closePool: async () => undefined,
      timeoutMs: 20_000,
      log: silentLog,
      beforeClose: () => {
        closeAllEventStreams("shutdown");
      },
    });

    const started = Date.now();
    const reading = readAll();
    const result = await shutdown("SIGTERM");
    const elapsed = Date.now() - started;

    const text = await reading;
    expect(text).toContain("event: shutdown\ndata: {}\n\n");
    expect(result).toEqual({ forced: false });
    expect(elapsed, "shutdown does not wait for the stream").toBeLessThan(5000);
    controller.abort();
  });
});
