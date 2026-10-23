/**
 * The access level of every operation, read from the API contract (docs/decisions/0034, `x-bind-access`). The MCP server
 * does not import server code: the contract file is its only description of the registry. It fails closed: when the file
 * cannot be found or read, the server does not start.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Operation id to access level: public, authenticated, member, owner, owner-any, metrics-token or signed-webhook. */
export type AccessTable = Readonly<Record<string, string>>;

const MAX_LEVELS_UP = 8;

/** Searches upward from this module's folder for docs/openapi.json. Works from mcp/src (tests) and mcp/dist/mcp/src (built). */
function findContractFile(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < MAX_LEVELS_UP; depth += 1) {
    const candidate = join(dir, "docs", "openapi.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("The API contract (docs/openapi.json) was not found. Run the MCP server from a repository checkout.");
}

/** The access table from the contract file. Throws when the file is missing, unreadable, or has no operations. */
export function loadAccessTable(path?: string): AccessTable {
  const file = path ?? findContractFile();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("The API contract (docs/openapi.json) could not be read, so the MCP server cannot check its tools.");
  }
  const paths = (parsed as { paths?: unknown }).paths;
  const table: Record<string, string> = {};
  if (paths !== null && typeof paths === "object") {
    for (const methods of Object.values(paths as Record<string, unknown>)) {
      if (methods === null || typeof methods !== "object") continue;
      for (const operation of Object.values(methods as Record<string, unknown>)) {
        if (operation === null || typeof operation !== "object") continue;
        const { operationId, "x-bind-access": access } = operation as Record<string, unknown>;
        if (typeof operationId === "string" && typeof access === "string") table[operationId] = access;
      }
    }
  }
  if (Object.keys(table).length === 0) {
    throw new Error("The API contract (docs/openapi.json) lists no operations with an access level.");
  }
  return table;
}
