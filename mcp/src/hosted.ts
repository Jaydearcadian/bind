/**
 * The hosted MCP factory (docs/decisions/0075). The API server (src/server/mcp-route.ts) calls this once per HTTP request:
 * it builds a fresh BindClient for the caller's own staff token and the loopback origin of the same app, then the MCP server
 * over the shared tool table (createBindMcpServer). Nothing here is kept between requests except the parsed access table.
 *
 * It lives in mcp/ because the tool table and the SDK error classes are compiled by the mcp build (rootDir is the repository),
 * while the API build is rooted at src/. The API reaches it through a dynamic import of the built file, so a missing build is
 * a 503 and not a crash.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BindClient } from "../../sdk/src/index.js";
import { loadAccessTable, type AccessTable } from "./access.js";
import type { LogEntry } from "./logger.js";
import { createBindMcpServer, SERVER_VERSION, type ToolCallRecord } from "./server.js";

export interface HostedMcpOptions {
  /** The origin the SDK calls: the API app's own loopback listener (docs/decisions/0075). Never a public URL. */
  baseUrl: string;
  /** The caller's staff workspace token. Used only for calls to baseUrl. */
  token: string;
  /** The workspace the token belongs to (from the verified actor). Fixed for this server. */
  workspaceId: string;
  /** Receives one entry per tool call. The API forwards it to its structured logger. */
  log: (entry: LogEntry) => void;
  /**
   * Headers added to every API call. The API passes the /mcp request id (so the call's audit rows join the request) and the
   * loopback secret (so the call is recognised as this process's own). They are set here, never taken from a caller.
   */
  headers: Readonly<Record<string, string>>;
  /** Aborted when the MCP request is abandoned. The API calls made for it stop with it. */
  signal?: AbortSignal;
  /** Awaited once per finished tool call (the API writes the agent's audit row here). */
  onToolCall?: (call: ToolCallRecord) => Promise<void>;
}

/** The contract file is read once per process. A failed read is not cached, so the next request tries again. */
let cachedAccess: AccessTable | undefined;
function accessTable(): AccessTable {
  cachedAccess ??= loadAccessTable();
  return cachedAccess;
}

/** A fetch that adds the given headers to each request and sends nothing else differently. */
function fetchWithHeaders(extra: Readonly<Record<string, string>>): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    return globalThis.fetch(input, { ...init, headers });
  };
}

/** The MCP server for one request. Throws, before anything is registered, when the contract or the tool table fails its check. */
export function createHostedMcpServer(options: HostedMcpOptions): McpServer {
  const client = new BindClient({
    baseUrl: options.baseUrl,
    token: options.token,
    userAgent: `bind-hosted-mcp/${SERVER_VERSION}`,
    fetch: fetchWithHeaders(options.headers),
  });
  return createBindMcpServer({
    client,
    workspaceId: options.workspaceId,
    log: options.log,
    secrets: [options.token],
    access: accessTable(),
    signal: options.signal,
    onToolCall: options.onToolCall,
  });
}
