import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../../src/server/app.js";
import type { HostedMcpModule } from "../../src/server/mcp-route.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken, revokeToken } from "../../src/auth/tokens.js";
import { upsertAccount } from "../../src/accounts/service.js";
import { createSession } from "../../src/accounts/sessions.js";
import { createDemoWorkspace } from "../../src/demo/service.js";
import { closeAllEventStreams } from "../../src/api/event-streams.js";
import { setLogSink } from "../../src/observability/logger.js";
import { createHostedMcpServer } from "../../mcp/src/hosted.js";
import { loadAccessTable } from "../../mcp/src/access.js";
import { TOOLS } from "../../mcp/src/tools.js";

/*
 * The hosted MCP endpoint against the real app and PostgreSQL (docs/decisions/0075). The app listens on an ephemeral loopback
 * port; the SDK's own Streamable HTTP client connects to it with a staff key. Nothing is mocked: the tool calls go through the
 * REST routes, and the audit and feedback rows are read back from the database.
 */

const run = Date.now();
const WSA = `ws-hmcp-a-${run}`;
const WSB = `ws-hmcp-b-${run}`;
const LABEL_A = `hosted-agent-a-${run}`;

// The loader the deployment passes, typed as the route expects. The real module is mcp/src/hosted.ts.
const load = async (): Promise<HostedMcpModule> => ({ createHostedMcpServer: createHostedMcpServer as unknown as HostedMcpModule["createHostedMcpServer"] });

let app: ReturnType<typeof createApp>;
let server: Server;
let baseUrl = "";
const clients: Client[] = [];

let ownerA: { id: string; token: string };
let staffA: { id: string; token: string };
let staffB: { id: string; token: string };
let sessionToken: string;
let demo: { workspaceId: string; staffToken: string };

/** Starts an app on an ephemeral loopback port and returns its server and origin. */
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

/** An MCP client connected to /mcp with a bearer token, through the SDK's own Streamable HTTP transport. */
async function mcpClient(token: string, origin = baseUrl): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "hosted-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** Calls a tool and parses its text answer. */
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

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw-probe", version: "0.0.0" },
  },
};

/** A raw HTTP request to /mcp, for the refusals an SDK client never sends. */
async function raw(
  target: string,
  init: { method?: string; token?: string | null; headers?: Record<string, string>; body?: unknown; rawBody?: string } = {}
): Promise<{ status: number; text: string; json: any; headers: Headers }> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    ...(init.body !== undefined || init.rawBody !== undefined ? { "content-type": "application/json" } : {}),
    ...(init.headers ?? {}),
  };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const payload = init.rawBody ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  const res = await fetch(`${baseUrl}${target}`, { method: init.method ?? "POST", headers, body: payload });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json, headers: res.headers };
}

const postMcp = (token: string | null | undefined, body: unknown = INITIALIZE, headers: Record<string, string> = {}) =>
  raw("/mcp", { token, body, headers });

describe("the hosted MCP endpoint (docs/decisions/0075)", () => {
  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(WSA, "Hosted Kitchen A", "kitchen-v1");
    await provisionWorkspace(WSB, "Hosted Kitchen B", "kitchen-v1");
    ownerA = await issueToken(WSA, "owner", "hosted-owner-a");
    staffA = await issueToken(WSA, "staff", LABEL_A);
    staffB = await issueToken(WSB, "staff", `hosted-agent-b-${run}`);

    // An account session for a member of workspace A (bns_ tokens are account sessions, refused by this endpoint).
    const account = await upsertAccount(`did:privy:hosted-mcp-${run}`);
    await query(`INSERT INTO workspace_memberships (account_id, workspace_id, role) VALUES ($1, $2, 'owner');`, [account.id, WSA]);
    const session = await createSession(account.id, WSA, 60);
    sessionToken = session!.token;

    // A demo workspace with a staff key of its own (docs/decisions/0057).
    const created = await createDemoWorkspace({ maxActive: 10_000 });
    const demoStaff = await issueToken(created.workspaceId, "staff", `demo-agent-${run}`);
    demo = { workspaceId: created.workspaceId, staffToken: demoStaff.token };

    app = createApp({ rateLimits: { enabled: false }, metrics: { token: null }, hostedMcp: { load } });
    const started = await listen(app);
    server = started.server;
    baseUrl = started.url;
  });

  afterAll(async () => {
    setLogSink(null);
    await Promise.all(clients.map((c) => c.close().catch(() => undefined)));
    await app.locals.closeHostedMcp();
    await closeServer(server);
    closeAllEventStreams();
    await closePool();
  });

  it("initialize and tools/list answer with exactly the tool table of the stdio server", async () => {
    const client = await mcpClient(staffA.token);
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    expect(names).toEqual(TOOLS.map((t) => t.name).sort());
    expect(names).toHaveLength(TOOLS.length);
    expect(client.getServerVersion()?.name).toBe("bind");
  });

  it("the tool list has no approval, payment, credential or token tool (the read-only approval listing aside)", async () => {
    const client = await mcpClient(staffA.token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    const forbidden = /(payment|pay_|_pay|credential|token|secret|settle|publish|policy|revoke|reject|approve|owner)/i;
    expect(names.filter((n) => forbidden.test(n))).toEqual([]);
    // Anything about approvals is a listing.
    expect(names.filter((n) => /approv/i.test(n)).every((n) => n.startsWith("list_"))).toBe(true);
  });

  it("a read tool returns this workspace's own data, labelled as the API's answer", async () => {
    const client = await mcpClient(staffA.token);
    const result = await call(client, "get_workspace");
    expect(result.isError).toBe(false);
    expect(result.body.source).toBe("bind-api");
    expect(result.body.workspaceId).toBe(WSA);
    expect(result.body.data.workspace.id).toBe(WSA);
    expect(result.text).not.toContain(staffA.token);
  });

  it("a write tool has its real effect: the feedback row and its audit row exist, written by the request that made them", async () => {
    const client = await mcpClient(staffA.token);
    const externalId = `hosted-fb-${run}`;
    const result = await call(client, "submit_feedback", { source: "pos", externalId, text: "Soup was cold at lunch" });
    expect(result.isError).toBe(false);

    const rows = await query(`SELECT id FROM feedback_items WHERE workspace_id = $1 AND external_id = $2;`, [WSA, externalId]);
    expect(rows.rows).toHaveLength(1);
    const audit = await query(
      `SELECT action, actor_id, request_id FROM audit_logs WHERE workspace_id = $1 AND action = 'feedback.ingested' AND evidence->>'feedbackId' = $2;`,
      [WSA, rows.rows[0].id]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].request_id).toEqual(expect.any(String));
    // The audit row names the system that wrote it; it does not carry the token value.
    expect(JSON.stringify(audit.rows[0])).not.toContain(staffA.token);
  });

  it("a repeated write with the same external id is a duplicate and changes nothing", async () => {
    const client = await mcpClient(staffA.token);
    const externalId = `hosted-dup-${run}`;
    await call(client, "submit_feedback", { source: "pos", externalId, text: "First" });
    await call(client, "submit_feedback", { source: "pos", externalId, text: "Second" });
    const rows = await query(`SELECT COUNT(*)::int AS n FROM feedback_items WHERE workspace_id = $1 AND external_id = $2;`, [WSA, externalId]);
    expect(rows.rows[0].n).toBe(1);
  });

  it("the paused workspace refuses through the REST rules: the MCP answer carries the same status as REST", async () => {
    const pause = await raw(`/api/workspaces/${WSA}/agents-paused`, { method: "PUT", token: ownerA.token, body: { paused: true } });
    expect(pause.status).toBe(200);
    try {
      const body = { change: { type: "add_item", name: `Paused Soup ${run}`, priceCents: 600 } };
      const rest = await raw(`/api/workspaces/${WSA}/menu-proposals`, { token: staffA.token, body });
      const client = await mcpClient(staffA.token);
      const mcp = await call(client, "propose_menu_change", body);
      expect(mcp.isError).toBe(true);
      expect(mcp.body.error.status).toBe(rest.status);
      expect(mcp.body.error.code ?? null).toBe(rest.json?.code ?? null);
    } finally {
      await raw(`/api/workspaces/${WSA}/agents-paused`, { method: "PUT", token: ownerA.token, body: { paused: false } });
    }
  });

  it("no token gets 401 in the repo's body, and so does a malformed one", async () => {
    const none = await postMcp(null);
    expect(none.status).toBe(401);
    expect(none.json).toMatchObject({ error: "Authentication required" });
    const malformed = await postMcp("bnd_short");
    expect(malformed.status).toBe(401);
    expect(malformed.json).toMatchObject({ error: "Authentication required" });
  });

  it("a revoked staff key gets 401", async () => {
    const revoked = await issueToken(WSA, "staff", `hosted-revoked-${run}`);
    expect((await postMcp(revoked.token)).status).toBe(200);
    await revokeToken(WSA, revoked.id);
    const after = await postMcp(revoked.token);
    expect(after.status).toBe(401);
    expect(after.json).toMatchObject({ error: "Authentication required" });
  });

  it("an owner key gets 403 with the plain message, and so does an account session", async () => {
    const owner = await postMcp(ownerA.token);
    expect(owner.status).toBe(403);
    expect(owner.json).toMatchObject({ error: "Give agents a staff key; owner keys are for people" });

    const session = await postMcp(sessionToken);
    expect(session.status).toBe(403);
    expect(session.json).toMatchObject({ error: "Give agents a staff key; owner keys are for people" });
  });

  it("a staff key of another workspace sees only that workspace, and the REST tenancy refuses this one", async () => {
    const client = await mcpClient(staffB.token);
    const result = await call(client, "get_workspace");
    expect(result.body.workspaceId).toBe(WSB);
    expect(result.body.data.workspace.id).toBe(WSB);
    expect(result.text).not.toContain(WSA);

    const direct = await raw(`/api/workspaces/${WSA}/inventory`, { method: "GET", token: staffB.token });
    expect(direct.status).toBe(404);
  });

  it("two concurrent requests with different keys never mix workspaces", async () => {
    const clientA = await mcpClient(staffA.token);
    const clientB = await mcpClient(staffB.token);
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_v, i) => call(i % 2 === 0 ? clientA : clientB, "get_workspace"))
    );
    answers.forEach((answer, i) => {
      const expected = i % 2 === 0 ? WSA : WSB;
      expect(answer.body.workspaceId).toBe(expected);
      expect(answer.body.data.workspace.id).toBe(expected);
    });
  });

  it("an Origin from another site is refused, and the deployment's own origin is allowed", async () => {
    const foreign = await postMcp(staffA.token, INITIALIZE, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);
    expect(foreign.json).toMatchObject({ error: "Cross-origin requests to the MCP endpoint are refused" });

    const nullOrigin = await postMcp(staffA.token, INITIALIZE, { origin: "null" });
    expect(nullOrigin.status).toBe(403);

    const own = await postMcp(staffA.token, INITIALIZE, { origin: baseUrl });
    expect(own.status).toBe(200);
  });

  it("an oversized body is refused with 413 before any tool runs", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "submit_feedback", arguments: { text: "x".repeat(300_000) } } });
    const res = await raw("/mcp", { token: staffA.token, rawBody: big });
    expect(res.status).toBe(413);
    expect(res.json?.code ?? res.json?.error).toBeTruthy();
    expect(res.text).not.toContain(staffA.token);
  });

  it("a body that is not JSON is refused, and a non-JSON content type is 415", async () => {
    const wrongType = await raw("/mcp", { token: staffA.token, headers: { "content-type": "text/plain" }, rawBody: "hello" });
    expect(wrongType.status).toBe(415);
  });

  it("GET and DELETE answer 405 with the endpoint's own address; without a key they are 401", async () => {
    const get = await raw("/mcp", { method: "GET", token: staffA.token });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(get.json.endpoint).toBe(`${baseUrl}/mcp`);
    expect(get.text).not.toContain(staffA.token);

    const del = await raw("/mcp", { method: "DELETE", token: staffA.token });
    expect(del.status).toBe(405);

    expect((await raw("/mcp", { method: "GET", token: null })).status).toBe(401);
    expect((await raw("/mcp", { method: "DELETE", token: null })).status).toBe(401);
  });

  it("every /mcp answer is no-store", async () => {
    const ok = await postMcp(staffA.token);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const refused = await postMcp(null);
    expect(refused.headers.get("cache-control")).toBe("no-store");
  });

  it("the token never appears in any response body, log line or error", async () => {
    const lines: string[] = [];
    setLogSink((line) => lines.push(line));
    try {
      const client = await mcpClient(staffA.token);
      const bodies: string[] = [];
      bodies.push(JSON.stringify(await client.listTools()));
      bodies.push((await call(client, "get_workspace")).text);
      // An answer that carries an API error (a cancel of an order that does not exist).
      bodies.push((await call(client, "cancel_customer_order", { orderId: `none-${run}` })).text);
      bodies.push((await call(client, "submit_feedback", { source: "BAD SOURCE", text: "x" })).text);
      bodies.push((await postMcp(ownerA.token)).text);
      bodies.push((await postMcp(`bnd_${"Z".repeat(43)}`)).text);
      bodies.push((await raw("/mcp", { method: "GET", token: staffA.token })).text);
      for (const body of bodies) expect(body).not.toContain(staffA.token);
      const logged = lines.join("\n");
      expect(logged.length).toBeGreaterThan(0);
      expect(logged).not.toContain(staffA.token);
      // The tool outcome is logged with ids only.
      expect(logged).toContain("mcp.tool_call");
    } finally {
      setLogSink(null);
    }
  });

  it("a demo workspace's staff key works while the demo lives and stops after it expires", async () => {
    const live = await postMcp(demo.staffToken);
    expect(live.status).toBe(200);
    const client = await mcpClient(demo.staffToken);
    expect((await call(client, "get_workspace")).body.workspaceId).toBe(demo.workspaceId);

    await query(`UPDATE workspaces SET demo_expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1;`, [demo.workspaceId]);
    const expired = await postMcp(demo.staffToken);
    expect(expired.status).toBe(401);
    expect(expired.json).toMatchObject({ error: "Authentication required" });
  });

  it("a deployment without the MCP module answers 503 for /mcp and keeps the API", async () => {
    const unwired = createApp({ rateLimits: { enabled: false }, metrics: { token: null } });
    const started = await listen(unwired);
    try {
      const res = await fetch(`${started.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${staffA.token}` },
        body: JSON.stringify(INITIALIZE),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "The MCP endpoint is not available on this server" });
      const api = await fetch(`${started.url}/api/templates`);
      expect(api.status).toBe(200);
    } finally {
      await unwired.locals.closeHostedMcp();
      await closeServer(started.server);
    }
  });

  it("a failed load answers 503 with no crash, then recovers when the module loads", async () => {
    let attempts = 0;
    const flaky = createApp({
      rateLimits: { enabled: false },
      metrics: { token: null },
      hostedMcp: {
        load: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("module missing");
          return load();
        },
      },
    });
    const started = await listen(flaky);
    try {
      const body = JSON.stringify(INITIALIZE);
      const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${staffA.token}` };
      const first = await fetch(`${started.url}/mcp`, { method: "POST", headers, body });
      expect(first.status).toBe(503);
      const second = await fetch(`${started.url}/mcp`, { method: "POST", headers, body });
      expect(second.status).toBe(200);
    } finally {
      await flaky.locals.closeHostedMcp();
      await closeServer(started.server);
    }
  });

  it("the access table fails closed when the contract file is missing", () => {
    expect(() => loadAccessTable("/nonexistent/docs/openapi.json")).toThrow(/could not be read/);
  });

  it("a public origin must be https (or loopback http) with no path", () => {
    expect(() => createApp({ hostedMcp: { load, publicUrl: "http://bind.example" } })).toThrow(/BIND_PUBLIC_URL/);
    expect(() => createApp({ hostedMcp: { load, publicUrl: "https://bind.example/some/path" } })).toThrow(/BIND_PUBLIC_URL/);
    const configured = createApp({ hostedMcp: { load, publicUrl: "https://bind.example" } });
    void configured.locals.closeHostedMcp();
  });

  // The endpoint shares the API's rate limits (docs/decisions/0033). A separate app with small limits; this file's pool stays open.
  it("a token over its per-token limit gets 429, and a client over the auth-failure limit is refused even with a good key", async () => {
    const limited = createApp({
      rateLimits: {
        enabled: true,
        apiPerToken: { windowMs: 60_000, max: 3 },
        authFailures: { windowMs: 60_000, max: 3 },
      },
      metrics: { token: null },
      hostedMcp: { load },
    });
    const started = await listen(limited);
    const origin = started.url;
    try {
      const probe = await issueToken(WSB, "staff", `hosted-limit-${run}`);
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await fetch(`${origin}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${probe.token}` },
          body: JSON.stringify(INITIALIZE),
        });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
      expect(statuses[3]).toBe(429);

      // Bad keys fill the authentication-failure window from this address; then a good key is refused too.
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${origin}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer bnd_${"Q".repeat(43)}` },
          body: JSON.stringify(INITIALIZE),
        });
        expect(res.status).toBe(401);
      }
      const blocked = await fetch(`${origin}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${staffB.token}` },
        body: JSON.stringify(INITIALIZE),
      });
      expect(blocked.status).toBe(429);
      expect(await blocked.json()).toMatchObject({ error: "Too many requests", code: "RATE_LIMITED" });
    } finally {
      await limited.locals.closeHostedMcp();
      await closeServer(started.server);
    }
  });
});
