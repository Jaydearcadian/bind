import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../../src/server/app.js";
import { closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { query } from "../../src/db/client.js";
import { config } from "../../src/config/env.js";
import { signPayload, workspaceWebhookSecret } from "../../src/webhooks/signing.js";
import { setLogSink } from "../../src/observability/logger.js";

const run = Date.now();
const wsId = `ws-echo-${run}`;

describe("error text does not echo untrusted ids (ADR 0031, ADR 0040)", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  let ownerToken = "";

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsId, "Echo Kitchen", "kitchen-v1");
    ownerToken = (await issueToken(wsId, "owner", "echo-owner")).token;
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

  it("document confirm errors do not echo ids", async () => {
    const docId = `doc_unknown_${run}`;
    const res = await fetch(`${baseUrl}/api/workspaces/${wsId}/documents/${docId}/confirm`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: "Document could not be confirmed" });
    expect(text).not.toContain(docId);
    expect(text).not.toContain(wsId);
  });

  it("an unauthorized surface actor gets a generic 403 with a code and no actor id", async () => {
    // An actor with no binding in the workspace. The event is signed, so it reaches the authorization check.
    const actorId = `stranger-echo-${run}@echo.example`;
    const raw = JSON.stringify({
      eventType: "SURFACE_STOCK_OBSERVED",
      eventId: `evt_echo_${run}`,
      workspaceId: wsId,
      surface: "whatsapp",
      actorId,
      actorRole: "owner",
      sku: "FOOD-ECHO-FLOUR",
      observedQuantity: 3,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = workspaceWebhookSecret(config.BIND_MASTER_SECRET!, wsId, 1);

    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/webhooks/incoming`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bind-timestamp": String(timestamp),
          "x-bind-signature": signPayload(secret, timestamp, raw),
        },
        body: raw,
      });
    } finally {
      setLogSink(null);
    }

    const text = await res.text();
    expect(res.status).toBe(403);
    expect(JSON.parse(text)).toEqual({ error: "Actor is not authorized for this event", code: "SURFACE_ROLE_VIOLATION" });
    expect(text).not.toContain(actorId);
    // The detail, with the actor id, is in the server log (redacted), never in the response.
    expect(lines.some((line) => line.includes("surface.authorization_refused") && line.includes(actorId))).toBe(true);
  });
});
