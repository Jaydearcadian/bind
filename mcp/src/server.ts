/**
 * The MCP server (docs/decisions/0037): a thin layer over the Bind SDK. Each tool makes one API call with the configured
 * token, so the server's authentication, tenancy, roles, policy gate and rate limits all apply. It holds no authority of its own.
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BindApiError, BindNetworkError, BindTimeoutError, type BindClient } from "../../sdk/src/index.js";
import { loadAccessTable, type AccessTable } from "./access.js";
import { apiErrorResult, genericFailureResult, successResult, unreachableResult } from "./format.js";
import type { LogEntry } from "./logger.js";
import { TOOLS, assertToolTable, type ToolSpec } from "./tools.js";

export const SERVER_NAME = "bind";
export const SERVER_VERSION = "0.1.0";

/** The one SDK method the server uses. A BindClient satisfies it; tests pass a fake. */
export type BindCaller = Pick<BindClient, "call">;

export interface BindMcpServerOptions {
  client: BindCaller;
  /** The only workspace the tools can reach. It is fixed at startup; no tool takes a workspace id. */
  workspaceId: string;
  /** Receives one entry per tool call: the tool name, outcome, duration and, for an API answer, status, code and request id. */
  log?: (entry: LogEntry) => void;
  /** Values that must never appear in a result or a log line (the token). */
  secrets?: readonly string[];
  /** The tool table. Defaults to the built-in table; tests pass another to prove the startup guard. */
  tools?: readonly ToolSpec[];
  /** The access table. Defaults to the one in docs/openapi.json. */
  access?: AccessTable;
}

/** The MCP server for one workspace. It throws, before anything is registered, when the tool table fails the guard. */
export function createBindMcpServer(options: BindMcpServerOptions): McpServer {
  const tools = options.tools ?? TOOLS;
  const access = options.access ?? loadAccessTable();
  assertToolTable(tools, access);

  const secrets = options.secrets ?? [];
  const log = options.log ?? (() => undefined);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { maxToolInputElements: 1000 });

  for (const spec of tools) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: spec.inputSchema,
        annotations: {
          title: spec.title,
          readOnlyHint: spec.readOnly,
          destructiveHint: false,
          idempotentHint: spec.idempotent,
          openWorldHint: false,
        },
      },
      async (input: unknown): Promise<CallToolResult> => runTool(spec, input, options.client, options.workspaceId, secrets, log)
    );
  }
  return server;
}

async function runTool(
  spec: ToolSpec,
  input: unknown,
  client: BindCaller,
  workspaceId: string,
  secrets: readonly string[],
  log: (entry: LogEntry) => void
): Promise<CallToolResult> {
  const started = Date.now();
  const record = (outcome: string, fields: Record<string, unknown> = {}): void => {
    log({ event: "mcp.tool_call", level: outcome === "ok" ? "info" : "error", tool: spec.name, outcome, durationMs: Date.now() - started, ...fields });
  };
  try {
    const args = spec.buildCall(input, workspaceId);
    // A keyed command always carries a key, so the SDK may repeat it after a network failure without running it twice.
    if (spec.keyed && args.idempotencyKey === undefined) args.idempotencyKey = randomUUID();
    // The operation is one of the allowlisted ids (assertToolTable). The argument shape is the SDK's, checked by the API.
    const data: unknown = await client.call(spec.operationId, args as never);
    record("ok");
    return successResult({ workspaceId, untrustedTextFields: spec.untrustedTextFields, data, secrets });
  } catch (err) {
    if (err instanceof BindApiError) {
      record("api_error", { status: err.status, code: err.code ?? null, requestId: err.requestId ?? null });
      return apiErrorResult(err, secrets);
    }
    if (err instanceof BindNetworkError || err instanceof BindTimeoutError) {
      record("unreachable");
      return unreachableResult(secrets);
    }
    record("failed");
    return genericFailureResult(secrets);
  }
}
