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
import { TOOLS, assertToolTable, type EffectClass, type ToolSpec } from "./tools.js";

export const SERVER_NAME = "bind";
export const SERVER_VERSION = "0.1.0";

/** The one SDK method the server uses. A BindClient satisfies it; tests pass a fake. */
export type BindCaller = Pick<BindClient, "call">;

/**
 * One finished tool call, for a caller that keeps its own record (docs/decisions/0075). `status` is the API's HTTP status when
 * the API refused the call; it is null for a success, because the SDK answers with the body only. Carries no arguments and no
 * answer: only what the tool is and how it ended.
 */
export interface ToolCallRecord {
  tool: string;
  readOnly: boolean;
  effect: EffectClass;
  outcome: "ok" | "error";
  status: number | null;
}

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
  /** Passed to every API call. Aborted when the caller goes away, so an answer nobody reads is not still being made. */
  signal?: AbortSignal;
  /**
   * Awaited once per finished tool call, before its answer is returned. A throw is logged and the answer is still returned: the
   * API call has already happened, so the answer must say what the API said.
   */
  onToolCall?: (call: ToolCallRecord) => Promise<void>;
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
      async (input: unknown): Promise<CallToolResult> =>
        runTool(spec, input, {
          client: options.client,
          workspaceId: options.workspaceId,
          secrets,
          log,
          signal: options.signal,
          onToolCall: options.onToolCall,
        })
    );
  }
  return server;
}

interface RunContext {
  client: BindCaller;
  workspaceId: string;
  secrets: readonly string[];
  log: (entry: LogEntry) => void;
  signal: AbortSignal | undefined;
  onToolCall: ((call: ToolCallRecord) => Promise<void>) | undefined;
}

async function runTool(spec: ToolSpec, input: unknown, ctx: RunContext): Promise<CallToolResult> {
  const started = Date.now();
  let outcome: "ok" | "error" = "error";
  let status: number | null = null;
  const record = (state: string, fields: Record<string, unknown> = {}): void => {
    ctx.log({
      event: "mcp.tool_call",
      level: state === "ok" ? "info" : "error",
      tool: spec.name,
      outcome: state,
      durationMs: Date.now() - started,
      ...fields,
    });
  };

  let result: CallToolResult;
  try {
    const args = spec.buildCall(input, ctx.workspaceId);
    // A keyed command always carries a key, so the SDK may repeat it after a network failure without running it twice.
    if (spec.keyed && args.idempotencyKey === undefined) args.idempotencyKey = randomUUID();
    // The operation is one of the allowlisted ids (assertToolTable). The argument shape is the SDK's, checked by the API.
    const data: unknown = await ctx.client.call(spec.operationId, { ...args, signal: ctx.signal } as never);
    record("ok");
    outcome = "ok";
    result = successResult({ workspaceId: ctx.workspaceId, untrustedTextFields: spec.untrustedTextFields, data, secrets: ctx.secrets });
  } catch (err) {
    if (err instanceof BindApiError) {
      status = err.status;
      record("api_error", { status: err.status, code: err.code ?? null, requestId: err.requestId ?? null });
      result = apiErrorResult(err, ctx.secrets);
    } else if (err instanceof BindNetworkError || err instanceof BindTimeoutError) {
      record("unreachable");
      result = unreachableResult(ctx.secrets);
    } else {
      record("failed");
      result = genericFailureResult(ctx.secrets);
    }
  }

  if (ctx.onToolCall !== undefined) {
    try {
      await ctx.onToolCall({ tool: spec.name, readOnly: spec.readOnly, effect: spec.effect, outcome, status });
    } catch (err) {
      ctx.log({ event: "mcp.tool_record_failed", level: "error", tool: spec.name, error: err instanceof Error ? err.name : "unknown" });
    }
  }
  return result;
}
