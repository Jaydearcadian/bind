#!/usr/bin/env node
/**
 * The stdio entry point (docs/decisions/0037). Configuration comes from two variables: BIND_API_URL and BIND_API_TOKEN. The
 * workspace is not configured: GET /api/workspaces answers with the caller's own workspace only, and that one is used.
 *
 * Stdout is the protocol and is never written here. Every log line is one JSON object on stderr, redacted. Errors name a
 * variable, never its value. Only the stdio transport is provided: a network transport would need its own authentication.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BindApiError, BindClient, BindNetworkError, BindTimeoutError } from "../../sdk/src/index.js";
import { createLogger, type LogEntry } from "./logger.js";
import { createBindMcpServer, SERVER_VERSION } from "./server.js";
import { TOOLS } from "./tools.js";

const TOKEN_SHAPE = /^bnd_[A-Za-z0-9_-]{43}$/;

export interface Config {
  baseUrl: string;
  token: string;
}

/** Raised when the token is valid but does not name exactly one workspace. */
export class StartupError extends Error {}

/** Whether a value is an absolute http or https URL with no credentials, query or fragment. */
function isApiUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === ""
  );
}

/** The configuration from the environment, or the problems found. Each problem names a variable and never repeats its value. */
export function readConfig(env: NodeJS.ProcessEnv): Config | string[] {
  const problems: string[] = [];
  const url = env.BIND_API_URL;
  const token = env.BIND_API_TOKEN;
  if (url === undefined || url.length === 0) {
    problems.push("BIND_API_URL is not set. Set it to the Bind API origin, for example https://bind.example.");
  } else if (!isApiUrl(url)) {
    problems.push("BIND_API_URL is not an http or https URL without credentials, a query or a fragment.");
  }
  if (token === undefined || token.length === 0) {
    problems.push("BIND_API_TOKEN is not set. Give the agent a staff workspace token, never an owner token.");
  } else if (!TOKEN_SHAPE.test(token)) {
    problems.push("BIND_API_TOKEN is not a Bind workspace token (bnd_ followed by 43 characters).");
  }
  if (problems.length > 0 || url === undefined || token === undefined) return problems;
  return { baseUrl: url, token };
}

/** The one workspace the token may see. Zero, or more than one, is refused. */
export async function discoverWorkspace(client: BindClient): Promise<string> {
  const rows: unknown = await client.call("listWorkspaces");
  const count = Array.isArray(rows) ? rows.length : 0;
  if (!Array.isArray(rows) || count !== 1) {
    throw new StartupError(`The token must see exactly one workspace, but it sees ${count}. Use a token issued for one workspace.`);
  }
  const id = (rows[0] as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || id.length === 0) throw new StartupError("The workspace in the API answer has no id.");
  return id;
}

function writeStderr(line: string): void {
  process.stderr.write(line);
}

/** A startup failure, logged without any value that came from the environment. */
function logStartupFailure(log: (entry: LogEntry) => void, err: unknown): void {
  if (err instanceof BindApiError) {
    log({
      event: "startup.refused",
      level: "error",
      status: err.status,
      requestId: err.requestId ?? null,
      message: "The Bind API refused BIND_API_TOKEN at startup. Check that the token is current.",
    });
  } else if (err instanceof BindNetworkError || err instanceof BindTimeoutError) {
    log({ event: "startup.unreachable", level: "error", message: "The Bind API could not be reached at startup. Check BIND_API_URL." });
  } else if (err instanceof StartupError) {
    log({ event: "startup.workspace", level: "error", message: err.message });
  } else {
    log({ event: "startup.failed", level: "error", message: "The MCP server could not start." });
  }
}

/** Starts the server on stdio. Resolves true when it is connected, false after a startup failure has been logged. */
async function serve(config: Config): Promise<boolean> {
  const log = createLogger({ secrets: [config.token], write: writeStderr });
  const client = new BindClient({ baseUrl: config.baseUrl, token: config.token, userAgent: `bind-mcp/${SERVER_VERSION}` });

  let workspaceId: string;
  try {
    workspaceId = await discoverWorkspace(client);
  } catch (err) {
    logStartupFailure(log, err);
    return false;
  }

  let server: ReturnType<typeof createBindMcpServer>;
  try {
    server = createBindMcpServer({ client, workspaceId, log, secrets: [config.token] });
  } catch (err) {
    log({ event: "startup.refused", level: "error", message: err instanceof Error ? err.message : "The tool table failed its check." });
    return false;
  }

  const shutdown = (signal: string): void => {
    log({ event: "mcp.stopping", level: "info", signal });
    void server.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    log({ event: "mcp.crashed", level: "error", error: err.name });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log({ event: "mcp.crashed", level: "error", error: reason instanceof Error ? reason.name : "unknown" });
    process.exit(1);
  });

  await server.connect(new StdioServerTransport());
  log({ event: "mcp.started", level: "info", workspaceId, tools: TOOLS.length });
  return true;
}

async function main(): Promise<void> {
  const config = readConfig(process.env);
  if (Array.isArray(config)) {
    const log = createLogger({ secrets: [], write: writeStderr });
    for (const problem of config) log({ event: "config.invalid", level: "error", problem });
    process.exitCode = 1;
    return;
  }
  if (!(await serve(config))) process.exitCode = 1;
}

void main();
