/**
 * The hosted MCP endpoint (docs/decisions/0075): POST /mcp speaks the MCP Streamable HTTP transport, stateless, with JSON
 * answers. Agents connect to a business's workspace by URL with a staff key; nothing runs on their side.
 *
 * - Auth is the REST API's own (`authenticate`, `tokenRateLimit`): the same hashes, revocation and demo expiry. Only a staff
 *   workspace key is accepted here. An owner key or an account session gets 403.
 * - Each tool call is an HTTP call from the MCP factory to this same app, over a loopback listener created once per process.
 *   The caller's token goes only to 127.0.0.1 and into the same routes, so every role, tenancy, idempotency and audit rule
 *   is the REST code's. The token is never logged, returned or put in an error. The loopback calls carry the /mcp request id
 *   and a per-process secret; the secret marks them so the global address limits do not count them (src/server/loopback.ts).
 * - A fresh transport and server per request: nothing about a session is kept in memory, so any serverless instance may
 *   answer any request.
 * - Each tool that is not read-only writes one `agent.tool_called` audit row, when the call finishes, with the same request id
 *   as the API call it made (docs/decisions/0075, point 10).
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type express from "express";
import type { NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { authenticate, bearerToken } from "../auth/middleware.js";
import { tokenRateLimit } from "../security/rate-limit-middleware.js";
import { config } from "../config/env.js";
import { query } from "../db/client.js";
import { log } from "../observability/logger.js";
import { redactText } from "../utils/redact.js";
import { newId } from "../utils/ids.js";
import { LOOPBACK_HEADER, markLoopback } from "./loopback.js";

export const MCP_PATH = "/mcp";
export const AGENT_TOOL_ACTION = "agent.tool_called";
const STAFF_KEY_MESSAGE = "Give agents a staff key; owner keys are for people";
const PUBLIC_ORIGIN_UNSET_WARNING =
  "BIND_PUBLIC_URL is not set in production: the MCP endpoint address and its Origin check use the request's own scheme and host, which behind a proxy may be http. Set BIND_PUBLIC_URL to the https origin.";
/** The label kept on an audit row is cut to this length, as the token label is (docs/decisions/0021). */
const MAX_LABEL_CHARACTERS = 80;

/** The part of the MCP server the route uses. The real one is built by mcp/src/hosted.ts. */
export interface HostedMcpServerLike {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

/** One finished tool call, as the factory reports it. Carries no arguments and no answer. */
export interface ToolCallRecord {
  tool: string;
  readOnly: boolean;
  effect: "read" | "external_request" | "commercial_commitment";
  outcome: "ok" | "error";
  status: number | null;
}

/** The built hosted module (mcp/dist/mcp/src/hosted.js), as the route uses it. */
export interface HostedMcpModule {
  createHostedMcpServer(options: {
    baseUrl: string;
    token: string;
    workspaceId: string;
    log: (entry: { event: string; level?: string; [field: string]: unknown }) => void;
    headers: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    onToolCall?: (call: ToolCallRecord) => Promise<void>;
  }): HostedMcpServerLike;
}

export interface HostedMcpOptions {
  /** Loads the built MCP module. A rejection is a 503 for each request until it succeeds (never a crash). */
  load: () => Promise<HostedMcpModule>;
  /** Overrides BIND_PUBLIC_URL (tests). null means unset. Omitted, the environment decides. */
  publicUrl?: string | null;
  /** Overrides the explicit APP_BASE_URL (tests). null means not explicitly set. Omitted, the environment decides. */
  appBaseUrl?: string | null;
}

/** An origin an agent may use: https, or http for a loopback host only, with no path, query, fragment or credentials. */
export function parsePublicOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback))) return null;
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") return null;
  return url.origin;
}

export interface PublicOriginInput {
  /** BIND_PUBLIC_URL, or null when unset. An invalid value is an error, so startup stops. */
  publicUrl: string | null;
  /** APP_BASE_URL, only when it was set explicitly (not the localhost default). Null otherwise. */
  explicitAppBaseUrl: string | null;
  nodeEnv: string | undefined;
}

export interface PublicOriginResult {
  /** The origin for the endpoint address and the Origin check, or null: the request's own scheme and host is used. */
  origin: string | null;
  /** Set once, at startup, when the configuration is incomplete for production. Names a variable, never a value. */
  warning: string | null;
}

/**
 * The precedence (docs/decisions/0075, point 7): BIND_PUBLIC_URL when set; else an explicitly set APP_BASE_URL, so an owner who
 * sets one public address need not set two; else the request's own host. BIND_PUBLIC_URL that is not a valid origin throws.
 * An APP_BASE_URL that is not a valid origin is ignored with a warning, because it is a link base for email as well.
 */
export function resolvePublicOrigin(input: PublicOriginInput): PublicOriginResult {
  if (input.publicUrl !== null) {
    const origin = parsePublicOrigin(input.publicUrl);
    if (origin === null) {
      throw new Error("BIND_PUBLIC_URL must be an https origin with no path, query or credentials (http only for 127.0.0.1 or localhost)");
    }
    return { origin, warning: null };
  }
  if (input.explicitAppBaseUrl !== null) {
    const origin = parsePublicOrigin(input.explicitAppBaseUrl);
    if (origin !== null && origin.startsWith("https://")) return { origin, warning: null };
    // A loopback address (the .env.local default) names a dev machine's link base, not a port this server is on: use the request's own host.
    if (origin !== null) return { origin: null, warning: null };
    return {
      origin: null,
      warning: "APP_BASE_URL is set but is not an https origin, so it is not used for the MCP endpoint address. Set BIND_PUBLIC_URL.",
    };
  }
  return { origin: null, warning: input.nodeEnv === "production" ? PUBLIC_ORIGIN_UNSET_WARNING : null };
}

/** The origin the endpoint URL is built from: the configured public origin, else this request's own scheme and host. */
function endpointOrigin(req: Request, configured: string | null): string {
  if (configured !== null) return configured;
  return `${req.protocol}://${req.get("host") ?? ""}`;
}

/** Fails closed for every request, with no workspace data, until the module loads. */
const unconfigured: () => Promise<HostedMcpModule> = async () => {
  throw new Error("the hosted MCP module is not configured");
};

/** Refuses any request whose Origin is not this deployment's own origin. Agents are not browsers and send none. */
function originGate(configured: () => string | null) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.headers.origin;
    if (origin === undefined) {
      next();
      return;
    }
    let same = false;
    try {
      same = typeof origin === "string" && new URL(origin).origin === endpointOrigin(req, configured());
    } catch {
      same = false;
    }
    if (!same) {
      res.status(403).json({ error: "Cross-origin requests to the MCP endpoint are refused" });
      return;
    }
    next();
  };
}

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Cache-Control", "no-store");
  next();
}

/** Only a staff workspace key. An owner key and an account session (bns_) are refused with the same plain message. */
function staffKeyOnly(req: Request, res: Response, next: NextFunction): void {
  const actor = req.actor;
  if (actor && actor.role === "staff" && !actor.tokenId.startsWith("ses_")) {
    next();
    return;
  }
  res.status(403).json({ error: STAFF_KEY_MESSAGE });
}

/**
 * The loopback listener of this app: created on first use, once per process, bound to 127.0.0.1 on an ephemeral port. Requests
 * that carry this process's secret header are marked as loopback calls; any other request is an ordinary one.
 */
function loopbackListener(app: express.Express) {
  let start: Promise<{ origin: string; secret: string }> | undefined;
  let server: http.Server | undefined;
  return {
    start(): Promise<{ origin: string; secret: string }> {
      start ??= new Promise((resolve, reject) => {
        const secret = randomBytes(32).toString("hex");
        const created = http.createServer((req, res) => {
          if (req.headers[LOOPBACK_HEADER] === secret) markLoopback(req);
          app(req, res);
        });
        let listening = false;
        created.on("error", (err) => {
          if (!listening) {
            start = undefined;
            reject(err);
            return;
          }
          log.error("mcp.loopback_error", { error: err });
        });
        created.listen(0, "127.0.0.1", () => {
          listening = true;
          // The listener alone does not keep the process alive; requests in flight still do.
          created.unref();
          const address = created.address() as AddressInfo;
          server = created;
          resolve({ origin: `http://127.0.0.1:${address.port}`, secret });
        });
      });
      return start;
    },
    async close(): Promise<void> {
      if (server === undefined) return;
      const target = server;
      server = undefined;
      start = undefined;
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    },
  };
}

/**
 * Writes the agent's row for one finished tool call that is not read-only (docs/decisions/0075, point 10). The row carries the
 * key's id and label, the tool, the outcome and the API status. It never carries the token, the arguments or the answer. Its
 * request id is the /mcp request's, which is also the id of the API call and of the rows that call wrote.
 */
async function recordAgentToolCall(input: {
  workspaceId: string;
  tokenId: string;
  label: string;
  token: string;
  requestId: string;
  call: ToolCallRecord;
}): Promise<void> {
  if (input.call.readOnly) return;
  const label = redactText(input.label, [input.token]).slice(0, MAX_LABEL_CHARACTERS);
  const evidence = { label, tool: input.call.tool, outcome: input.call.outcome, status: input.call.status };
  await query(
    `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at, request_id)
     VALUES ($1, $2, NULL, 'staff_key', $3, $4, $5, $6, $7::jsonb, NOW(), $8);`,
    [
      newId("audit"),
      input.workspaceId,
      input.tokenId,
      input.call.effect,
      AGENT_TOOL_ACTION,
      input.call.outcome === "ok" ? "ALLOW" : "DENY",
      JSON.stringify(evidence),
      input.requestId,
    ]
  );
}

/** Mounts POST, GET and DELETE on /mcp. Called once by createApp, before the unknown-path fallbacks. */
export function mountHostedMcp(app: express.Express, options: HostedMcpOptions): { close: () => Promise<void> } {
  const publicFromEnv = options.publicUrl !== undefined ? options.publicUrl : (config.BIND_PUBLIC_URL ?? null);
  const explicitFromEnv =
    options.appBaseUrl !== undefined ? options.appBaseUrl : (process.env.APP_BASE_URL ? config.APP_BASE_URL : null);
  const resolved = resolvePublicOrigin({
    publicUrl: publicFromEnv === null || publicFromEnv === "" ? null : publicFromEnv,
    explicitAppBaseUrl: explicitFromEnv === null || explicitFromEnv === "" ? null : explicitFromEnv,
    nodeEnv: config.NODE_ENV,
  });
  if (resolved.warning !== null) log.warn("mcp.public_origin", { warning: resolved.warning });
  const configuredOrigin = resolved.origin;
  const configured = (): string | null => configuredOrigin;
  const listener = loopbackListener(app);

  let loaded: Promise<HostedMcpModule> | undefined;
  const loadModule = (): Promise<HostedMcpModule> => {
    loaded ??= options.load().catch((err: unknown) => {
      loaded = undefined;
      throw err;
    });
    return loaded;
  };

  const guard = [originGate(configured), noStore, authenticate, staffKeyOnly, tokenRateLimit];

  // GET and DELETE: no event stream and no session exist here, so the answer is 405 with the endpoint's own address.
  const notAllowed = (req: Request, res: Response): void => {
    res.setHeader("Allow", "POST");
    res.status(405).json({
      error: "Send MCP messages with POST. This endpoint is stateless: it has no event stream and no session to end.",
      code: "METHOD_NOT_ALLOWED",
      endpoint: `${endpointOrigin(req, configured())}${MCP_PATH}`,
      authorization: "Authorization: Bearer <staff key>",
    });
  };
  app.get(MCP_PATH, ...guard, notAllowed);
  app.delete(MCP_PATH, ...guard, notAllowed);

  app.post(MCP_PATH, ...guard, async (req: Request, res: Response) => {
    const actor = req.actor!;
    const token = bearerToken(req);
    if (token === null) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    // One JSON-RPC message per request. A batch would run several tool calls under one request, which the limits and the audit
    // rows are not built for (docs/decisions/0075, point 5).
    if (Array.isArray(req.body)) {
      res.status(400).json({ error: "Batch requests are not supported: send one JSON-RPC message per request" });
      return;
    }
    const requestId = String(req.id ?? "");
    let mod: HostedMcpModule;
    let loopback: { origin: string; secret: string };
    try {
      mod = await loadModule();
      loopback = await listener.start();
    } catch (err) {
      log.error("mcp.unavailable", { requestId, error: err });
      res.status(503).json({ error: "The MCP endpoint is not available on this server" });
      return;
    }

    const toolLog = (entry: { event: string; level?: string; [field: string]: unknown }): void => {
      const { event, level, ...fields } = entry;
      const record = { ...fields, requestId, tokenId: actor.tokenId };
      if (level === "error") log.error(event, record);
      else log.info(event, record);
    };

    // The request is abandoned when the client goes away before its answer is written: its API calls stop with it.
    const abandon = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abandon.abort();
    });

    // Each request gets its own server and transport. Stateless transports refuse reuse, so none is kept.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let server: HostedMcpServerLike;
    try {
      server = mod.createHostedMcpServer({
        baseUrl: loopback.origin,
        token,
        workspaceId: actor.workspaceId,
        log: toolLog,
        headers: { [LOOPBACK_HEADER]: loopback.secret, "x-request-id": requestId },
        signal: abandon.signal,
        onToolCall: (call) =>
          recordAgentToolCall({
            workspaceId: actor.workspaceId,
            tokenId: actor.tokenId,
            label: actor.label,
            token,
            requestId,
            call,
          }),
      });
    } catch (err) {
      log.error("mcp.unavailable", { requestId, error: err });
      res.status(503).json({ error: "The MCP endpoint is not available on this server" });
      return;
    }
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error("mcp.request_failed", { requestId, error: err instanceof Error ? err.name : "unknown" });
      if (!res.headersSent) res.status(500).json({ error: "Request could not be completed" });
    }
  });

  return { close: () => listener.close() };
}

/** The default for createApp: the route exists (so the route table is complete) and answers 503 until it is wired. */
export const UNWIRED_HOSTED_MCP: HostedMcpOptions = { load: unconfigured };
