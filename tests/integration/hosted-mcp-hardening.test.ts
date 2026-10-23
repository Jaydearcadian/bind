import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../../src/server/app.js";
import type { HostedMcpModule } from "../../src/server/mcp-route.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { upsertAccount } from "../../src/accounts/service.js";
import { createSession } from "../../src/accounts/sessions.js";
import { closeAllEventStreams } from "../../src/api/event-streams.js";
import { isVisibleToRole } from "../../src/api/events.js";
import { log } from "../../src/observability/logger.js";
import { createHostedMcpServer } from "../../mcp/src/hosted.js";

/*
 * The hosted MCP endpoint, hardening (docs/decisions/0075, points 2, 4, 5, 6, 7, 10). Same setup as hosted-mcp.test.ts: the real
 * app and PostgreSQL, nothing mocked except where a test wraps the loader to observe or hold a request.
 */

const run = Date.now();
const WA = `ws-hard-a-${run}`;
const WB = `ws-hard-b-${run}`;
const AGENT_LABEL = `hardening-agent-${run}`;

const real = createHostedMcpServer as unknown as HostedMcpModule["createHostedMcpServer"];
const realLoad = async (): Promise<HostedMcpModule> => ({ createHostedMcpServer: real });

let staffA: { id: string; token: string };
let staffB: { id: string; token: string };
let ownerA: { id: string; token: string };
let staffSession: string;
let ownerSession: string;
let baseUrl = "";
let app: ReturnType<typeof createApp>;
let server: Server;
const opened: Array<() => Promise<void>> = [];

function listen(application: ReturnType<typeof createApp>): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const started = application.listen(0, "127.0.0.1", () => {
      const addr = started.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server: started, url: `http://127.0.0.1:${port}` });
    });
  });
}

async function closeServer(target: Server): Promise<void> {
  target.closeAllConnections();
  await new Promise<void>((resolve) => target.close(() => resolve()));
}

/** A raw request, with any headers given (including Host, which fetch would not let us set). */
function rawRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; text: string; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: init.method ?? "POST",
        headers: {
          accept: "application/json, text/event-stream",
          ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
          ...(init.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, text, json, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "hardening", version: "0" } },
};

/** An SDK client on /mcp with a bearer key and optional extra headers. */
async function mcpClient(token: string, extra: Record<string, string> = {}, origin = baseUrl): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}`, ...extra } },
  });
  const client = new Client({ name: "hardening-test", version: "0.0.0" });
  await client.connect(transport);
  opened.push(() => client.close().catch(() => undefined));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const first = result.content[0];
  const text = first && first.type === "text" ? (first.text as string) : "";
  let body: Record<string, any> = {};
  try {
    body = JSON.parse(text) as Record<string, any>;
  } catch {
    body = { raw: text };
  }
  return { isError: result.isError === true, body, text };
}

function postMcp(url: string, token: string | null, body: unknown = INITIALIZE, headers: Record<string, string> = {}) {
  return rawRequest(`${url}/mcp`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body });
}

describe("the hosted MCP endpoint, hardened (docs/decisions/0075)", () => {
  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(WA, "Hardening Kitchen A", "kitchen-v1");
    await provisionWorkspace(WB, "Hardening Kitchen B", "kitchen-v1");
    ownerA = await issueToken(WA, "owner", "hardening-owner-a");
    staffA = await issueToken(WA, "staff", AGENT_LABEL);
    staffB = await issueToken(WB, "staff", `hardening-agent-b-${run}`);

    // Account sessions: a staff member's and an owner's, both for workspace A.
    const staffAccount = await upsertAccount(`did:privy:hard-staff-${run}`);
    await query(`INSERT INTO workspace_memberships (account_id, workspace_id, role) VALUES ($1, $2, 'staff');`, [staffAccount.id, WA]);
    staffSession = (await createSession(staffAccount.id, WA, 60))!.token;
    const ownerAccount = await upsertAccount(`did:privy:hard-owner-${run}`);
    await query(`INSERT INTO workspace_memberships (account_id, workspace_id, role) VALUES ($1, $2, 'owner');`, [ownerAccount.id, WA]);
    ownerSession = (await createSession(ownerAccount.id, WA, 60))!.token;

    app = createApp({ rateLimits: { enabled: false }, metrics: { token: null }, hostedMcp: { load: realLoad } });
    const started = await listen(app);
    server = started.server;
    baseUrl = started.url;
  });

  afterAll(async () => {
    await Promise.all(opened.map((close) => close()));
    await app.locals.closeHostedMcp();
    await closeServer(server);
    closeAllEventStreams();
    await closePool();
  });

  // ---- point 10: attribution ---------------------------------------------------------------------------------------------

  it("a write tool call writes exactly one agent.tool_called row, joined to the downstream row by request id, with no token", async () => {
    const rid = `hard-write-${run}`;
    const client = await mcpClient(staffA.token, { "x-request-id": rid });
    const externalId = `hard-fb-${run}`;
    const result = await call(client, "submit_feedback", { source: "pos", externalId, text: "Bread was late" });
    expect(result.isError).toBe(false);

    const agentRows = await query(
      `SELECT actor_type, actor_id, effect_class, policy_decision, evidence FROM audit_logs
       WHERE workspace_id = $1 AND action = 'agent.tool_called' AND request_id = $2;`,
      [WA, rid]
    );
    expect(agentRows.rows).toHaveLength(1);
    const row = agentRows.rows[0];
    expect(row.actor_type).toBe("staff_key");
    expect(row.actor_id).toBe(staffA.id);
    expect(row.effect_class).toBe("external_request");
    expect(row.policy_decision).toBe("ALLOW");
    expect(row.evidence).toEqual({ label: AGENT_LABEL, tool: "submit_feedback", outcome: "ok", status: null });
    expect(JSON.stringify(row)).not.toContain(staffA.token);

    // The downstream effect's own row carries the same request id: the two join.
    const downstream = await query(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'feedback.ingested' AND request_id = $2;`,
      [WA, rid]
    );
    expect(downstream.rows[0].n).toBe(1);
  });

  it("a read tool call writes no agent row", async () => {
    const rid = `hard-read-${run}`;
    const client = await mcpClient(staffA.token, { "x-request-id": rid });
    expect((await call(client, "get_workspace")).isError).toBe(false);
    expect((await call(client, "list_inventory")).isError).toBe(false);
    const rows = await query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'agent.tool_called' AND request_id = $2;`, [WA, rid]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("a refused write is recorded as an error with the API status, and the event is visible to staff like notification events", async () => {
    const rid = `hard-refused-${run}`;
    const client = await mcpClient(staffA.token, { "x-request-id": rid });
    const result = await call(client, "cancel_customer_order", { orderId: `no-such-order-${run}` });
    expect(result.isError).toBe(true);
    const rows = await query(
      `SELECT policy_decision, evidence FROM audit_logs WHERE workspace_id = $1 AND action = 'agent.tool_called' AND request_id = $2;`,
      [WA, rid]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].policy_decision).toBe("DENY");
    expect(rows.rows[0].evidence).toMatchObject({ tool: "cancel_customer_order", outcome: "error", status: 404 });
    // Not an owner-only type, so staff see it, as they see notification.* events.
    expect(isVisibleToRole("staff", "agent.tool_called")).toBe(true);
    expect(isVisibleToRole("staff", "notification.failed")).toBe(true);
  });

  // ---- point 4: logs, headers, sessions, Origin, concurrency ----------------------------------------------------------------

  it("the route never hands the raw token to the logger, in any call of the request path", async () => {
    const info = vi.spyOn(log, "info");
    const error = vi.spyOn(log, "error");
    const warn = vi.spyOn(log, "warn");
    try {
      const client = await mcpClient(staffA.token);
      await call(client, "get_workspace");
      await call(client, "submit_feedback", { source: "pos", externalId: `hard-log-${run}`, text: "Soup" });
      await call(client, "cancel_customer_order", { orderId: `none-${run}` });
      await postMcp(baseUrl, ownerA.token);
      await postMcp(baseUrl, null);
      await rawRequest(`${baseUrl}/mcp`, { method: "GET", headers: { authorization: `Bearer ${staffA.token}` } });
      const everything = [...info.mock.calls, ...error.mock.calls, ...warn.mock.calls].map((args) => JSON.stringify(args));
      expect(everything.length).toBeGreaterThan(0);
      for (const logged of everything) expect(logged).not.toContain(staffA.token);
      // The label is logged only as the token id.
      expect(everything.join("\n")).toContain(staffA.id);
    } finally {
      info.mockRestore();
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("spoofed Host, X-Forwarded-Host and X-Forwarded-Proto never change where the token is sent", async () => {
    const seen: string[] = [];
    const spy: HostedMcpModule = {
      createHostedMcpServer: (options) => {
        seen.push(options.baseUrl);
        return real(options as never);
      },
    };
    const spoofed = createApp({ rateLimits: { enabled: false }, metrics: { token: null }, hostedMcp: { load: async () => spy } });
    const started = await listen(spoofed);
    try {
      const res = await postMcp(started.url, staffA.token, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "get_workspace", arguments: {} },
      }, { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9" });
      expect(res.status).toBe(200);
      expect(seen.length).toBeGreaterThan(0);
      for (const origin of seen) expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(res.text).toContain(WA);
    } finally {
      await spoofed.locals.closeHostedMcp();
      await closeServer(started.server);
    }
  });

  it("an account session of a STAFF membership is refused with 403, not by the owner check", async () => {
    const res = await postMcp(baseUrl, staffSession);
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ error: "Give agents a staff key; owner keys are for people" });
    expect(res.text).not.toContain(staffSession);
  });

  it("GET and DELETE with an owner key or an owner's account session are 403, and a staff session on GET is 403", async () => {
    for (const method of ["GET", "DELETE"]) {
      const owner = await rawRequest(`${baseUrl}/mcp`, { method, headers: { authorization: `Bearer ${ownerA.token}` } });
      expect(owner.status, `${method} owner key`).toBe(403);
      expect(owner.json).toMatchObject({ error: "Give agents a staff key; owner keys are for people" });

      const ownerBns = await rawRequest(`${baseUrl}/mcp`, { method, headers: { authorization: `Bearer ${ownerSession}` } });
      expect(ownerBns.status, `${method} owner session`).toBe(403);

      const staffBns = await rawRequest(`${baseUrl}/mcp`, { method, headers: { authorization: `Bearer ${staffSession}` } });
      expect(staffBns.status, `${method} staff session`).toBe(403);
    }
  });

  it("with BIND_PUBLIC_URL set, the own origin is allowed and any other origin, or the wrong scheme, is refused", async () => {
    const pinned = createApp({
      rateLimits: { enabled: false },
      metrics: { token: null },
      hostedMcp: { load: realLoad, publicUrl: "https://bind.example" },
    });
    const started = await listen(pinned);
    try {
      expect((await postMcp(started.url, staffA.token, INITIALIZE, { origin: "https://bind.example" })).status).toBe(200);
      const httpSame = await postMcp(started.url, staffA.token, INITIALIZE, { origin: "http://bind.example" });
      expect(httpSame.status).toBe(403);
      const other = await postMcp(started.url, staffA.token, INITIALIZE, { origin: "https://evil.example" });
      expect(other.status).toBe(403);
      // The endpoint address reports the configured origin, not the request's host.
      const get = await rawRequest(`${started.url}/mcp`, { method: "GET", headers: { authorization: `Bearer ${staffA.token}`, host: "evil.example" } });
      expect(get.json.endpoint).toBe("https://bind.example/mcp");
    } finally {
      await pinned.locals.closeHostedMcp();
      await closeServer(started.server);
    }
  });

  it("two keys on concurrent calls never mix, even when one request is held inside the server", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = false;
    const gated: HostedMcpModule = {
      createHostedMcpServer: (options) => {
        const mcp = real(options as never);
        if (armed && options.token === staffA.token) {
          const connect = mcp.connect.bind(mcp);
          mcp.connect = async (transport) => {
            await gate;
            return connect(transport);
          };
        }
        return mcp;
      },
    };
    const held = createApp({ rateLimits: { enabled: false }, metrics: { token: null }, hostedMcp: { load: async () => gated } });
    const started = await listen(held);
    try {
      const clientA = await mcpClient(staffA.token, {}, started.url);
      const clientB = await mcpClient(staffB.token, {}, started.url);
      armed = true;
      const heldA = call(clientA, "get_workspace");
      const bResults = await Promise.all(
        Array.from({ length: 12 }, (_v, i) => call(clientB, i % 2 === 0 ? "get_workspace" : "list_inventory"))
      );
      release();
      const a = await heldA;
      armed = false;
      expect(a.body.workspaceId).toBe(WA);
      expect(a.body.data.workspace.id).toBe(WA);
      expect(bResults).toHaveLength(12);
      for (const b of bResults) expect(b.body.workspaceId).toBe(WB);
    } finally {
      release();
      await held.locals.closeHostedMcp();
      await closeServer(started.server);
    }
  });

  // ---- point 6: abort -------------------------------------------------------------------------------------------------------

  it("a client that goes away aborts the request's signal, so its API calls stop with it", async () => {
    let seenSignal: AbortSignal | undefined;
    const hanging: HostedMcpModule = {
      createHostedMcpServer: (options) => {
        seenSignal = options.signal;
        return { connect: async () => undefined, close: async () => undefined };
      },
    };
    const hangingApp = createApp({ rateLimits: { enabled: false }, metrics: { token: null }, hostedMcp: { load: async () => hanging } });
    const started = await listen(hangingApp);
    try {
      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            hostname: "127.0.0.1",
            port: new URL(started.url).port,
            path: "/mcp",
            method: "POST",
            headers: {
              authorization: `Bearer ${staffA.token}`,
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
            },
          },
          () => undefined
        );
        req.on("error", () => resolve());
        req.end(JSON.stringify(INITIALIZE));
        setTimeout(() => {
          req.destroy();
          resolve();
        }, 300);
      });
      const deadline = Date.now() + 3000;
      while (seenSignal === undefined || !seenSignal.aborted) {
        if (Date.now() > deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(seenSignal).toBeDefined();
      expect(seenSignal!.aborted).toBe(true);
    } finally {
      await hangingApp.locals.closeHostedMcp();
      await closeServer(started.server);
    }
  });

  // ---- point 5: batches -----------------------------------------------------------------------------------------------------

  it("a JSON-RPC batch (an array body) is refused with 400 in the repo's error format", async () => {
    const res = await postMcp(baseUrl, staffA.token, [
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_workspace", arguments: {} } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_workspace", arguments: {} } },
    ]);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: "Batch requests are not supported: send one JSON-RPC message per request" });
    expect(res.json.requestId).toBeTruthy();
  });

  // ---- point 2: limits share the gate, loopback calls do not count against the address ----------------------------------

  it("loopback calls never block an address, an external flood still does, and a tool call works with the limits on", async () => {
    const captured: { baseUrl?: string; secret?: string } = {};
    const capturing: HostedMcpModule = {
      createHostedMcpServer: (options) => {
        captured.baseUrl = options.baseUrl;
        captured.secret = options.headers["x-bind-loopback"];
        return real(options as never);
      },
    };
    const limited = createApp({
      rateLimits: { enabled: true },
      metrics: { token: null },
      hostedMcp: { load: async () => capturing },
    });
    const started = await listen(limited);
    try {
      const client = await mcpClient(staffB.token, {}, started.url);
      const works = await call(client, "get_workspace");
      expect(works.isError).toBe(false);
      expect(works.body.workspaceId).toBe(WB);
      expect(captured.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(captured.secret).toMatch(/^[0-9a-f]{64}$/);

      // Fifteen loopback calls with a key that is not valid: each is a 401, and none counts against the address.
      for (let i = 0; i < 15; i += 1) {
        const loop = await rawRequest(`${captured.baseUrl}/api/workspaces/${WB}/inventory`, {
          method: "GET",
          headers: { authorization: `Bearer bnd_${"Y".repeat(43)}`, "x-bind-loopback": captured.secret! },
        });
        expect(loop.status).toBe(401);
      }
      // A second tenant's agent is not blocked by them.
      const other = await postMcp(started.url, staffB.token);
      expect(other.status).toBe(200);

      // An external flood still blocks, as before: ten failures, then the eleventh is refused.
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        statuses.push((await postMcp(started.url, `bnd_${"Z".repeat(43)}`)).status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
      expect((await postMcp(started.url, staffB.token)).status).toBe(429);
    } finally {
      await limited.locals.closeHostedMcp();
      await closeServer(started.server);
    }
  });

});
