/**
 * The hosted MCP endpoint (docs/decisions/0075): POST /mcp speaks the MCP Streamable HTTP transport, stateless, with JSON
 * answers. Agents connect to a business's workspace by URL with a staff key; nothing runs on their side.
 *
 * - Auth is the REST API's own (`authenticate`, `tokenRateLimit`): the same hashes, revocation and demo expiry. Only a staff
 *   workspace key is accepted here. An owner key or an account session gets 403.
 * - Each tool call is an HTTP call from the MCP factory to this same app, over a loopback listener created once per process.
 *   The caller's token goes only to 127.0.0.1 and into the same routes, so every role, tenancy, idempotency and audit rule
 *   is the REST code's. The token is never logged, returned or put in an error.
 * - A fresh transport and server per request: nothing about a session is kept in memory, so any serverless instance may
 *   answer any request.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import type { NextFunction, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { authenticate, bearerToken } from "../auth/middleware.js";
import { tokenRateLimit } from "../security/rate-limit-middleware.js";
import { config } from "../config/env.js";
import { log } from "../observability/logger.js";

export const MCP_PATH = "/mcp";
const STAFF_KEY_MESSAGE = "Give agents a staff key; owner keys are for people";

/** The part of the MCP server the route uses. The real one is built by mcp/src/hosted.ts. */
export interface HostedMcpServerLike {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

/** The built hosted module (mcp/dist/mcp/src/hosted.js), as the route uses it. */
export interface HostedMcpModule {
  createHostedMcpServer(options: {
    baseUrl: string;
    token: string;
    workspaceId: string;
    log: (entry: { event: string; level?: string; [field: string]: unknown }) => void;
  }): HostedMcpServerLike;
}

export interface HostedMcpOptions {
  /** Loads the built MCP module. A rejection is a 503 for each request until it succeeds (never a crash). */
  load: () => Promise<HostedMcpModule>;
  /** The public origin agents use (BIND_PUBLIC_URL). Omitted, the environment decides; unset, the request's host is used. */
  publicUrl?: string | null;
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

/** The loopback listener of this app: created on first use, once per process, bound to 127.0.0.1 on an ephemeral port. */
function loopbackListener(app: express.Express) {
  let origin: Promise<string> | undefined;
  let server: http.Server | undefined;
  return {
    origin(): Promise<string> {
      origin ??= new Promise<string>((resolve, reject) => {
        const created = http.createServer(app);
        let listening = false;
        created.on("error", (err) => {
          if (!listening) {
            origin = undefined;
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
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });
      return origin;
    },
    async close(): Promise<void> {
      if (server === undefined) return;
      const target = server;
      server = undefined;
      origin = undefined;
      target.closeAllConnections();
      await new Promise<void>((resolve) => target.close(() => resolve()));
    },
  };
}

/** Mounts POST, GET and DELETE on /mcp. Called once by createApp, before the unknown-path fallbacks. */
export function mountHostedMcp(app: express.Express, options: HostedMcpOptions): { close: () => Promise<void> } {
  const publicFromEnv = options.publicUrl !== undefined ? options.publicUrl : (config.BIND_PUBLIC_URL ?? null);
  let configuredOrigin: string | null = null;
  if (publicFromEnv !== null) {
    configuredOrigin = parsePublicOrigin(publicFromEnv);
    if (configuredOrigin === null) {
      throw new Error("BIND_PUBLIC_URL must be an https origin with no path, query or credentials (http only for 127.0.0.1 or localhost)");
    }
  }
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
    let mod: HostedMcpModule;
    let baseUrl: string;
    try {
      mod = await loadModule();
      baseUrl = await listener.origin();
    } catch (err) {
      log.error("mcp.unavailable", { requestId: req.id, error: err });
      res.status(503).json({ error: "The MCP endpoint is not available on this server" });
      return;
    }

    const toolLog = (entry: { event: string; level?: string; [field: string]: unknown }): void => {
      const { event, level, ...fields } = entry;
      const record = { ...fields, requestId: req.id, tokenId: actor.tokenId };
      if (level === "error") log.error(event, record);
      else log.info(event, record);
    };

    // Each request gets its own server and transport. Stateless transports refuse reuse, so none is kept.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    let server: HostedMcpServerLike;
    try {
      server = mod.createHostedMcpServer({ baseUrl, token, workspaceId: actor.workspaceId, log: toolLog });
    } catch (err) {
      log.error("mcp.unavailable", { requestId: req.id, error: err });
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
      log.error("mcp.request_failed", { requestId: req.id, error: err instanceof Error ? err.name : "unknown" });
      if (!res.headersSent) res.status(500).json({ error: "Request could not be completed" });
    }
  });

  return { close: () => listener.close() };
}

/** The default for createApp: the route exists (so the route table is complete) and answers 503 until it is wired. */
export const UNWIRED_HOSTED_MCP: HostedMcpOptions = { load: unconfigured };
