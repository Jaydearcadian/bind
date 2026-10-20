/**
 * Writes docs/capabilities.json: the machine-readable capability catalogue (docs/ecosystem/ECOSYSTEM_AUDIT.md).
 * It joins three things and invents nothing:
 *   - the API contract (docs/openapi.json): operation, method, route, summary, access level;
 *   - the reviewed classification (docs/ecosystem/exposure.json): exposure class, effect class, stability, flags;
 *   - the real surfaces: the SDK's handcrafted methods (sdk/src/client.ts) and the MCP tools (mcp/src/tools.ts).
 * A test (tests/unit/capabilities-catalogue.test.ts) fails when the committed file is stale or a rule below is broken.
 *
 * Usage: npm run capabilities:generate
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../mcp/src/tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const EXPOSURES = ["public_api", "internal_service", "protocol_primitive"] as const;
export const EFFECTS = [
  "read",
  "data_entry",
  "external_request",
  "commercial_commitment",
  "owner_decision",
  "owner_configuration",
  "credential",
  "operational",
] as const;

interface ExposureEntry {
  operationId: string;
  exposure: (typeof EXPOSURES)[number];
  effect: (typeof EFFECTS)[number];
  irreversible: boolean;
  economic: boolean;
  stability: "stable" | "preview" | "internal";
  flags: string[];
  note: string;
}

/** What a repeated call does, as far as the code and its tests show. Everything else is "not documented". */
const NATURAL_IDEMPOTENCY: Record<string, string> = {
  createCustomerOrder: "Repeating the same externalRef returns the earlier decision (replayed).",
  ingestFeedback: "A repeat of the same feedback is reported as a duplicate.",
  replenish: "A repeat while the workflow is awaiting approval returned the same workflow (observed in the model-driven MCP check, ADR 0042). Other states are not documented.",
};

export interface Capability {
  id: string;
  method: string;
  route: string;
  summary: string;
  tag: string;
  authorization: string;
  exposure: string;
  effect: string;
  irreversible: boolean;
  economic: boolean;
  stability: string;
  flags: string[];
  note: string;
  idempotency: { clientKey: false; natural: string };
  surfaces: { api: true; sdk: "convenience" | "generic"; mcp: string | null };
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8")) as T;
}

/** The SDK's handcrafted methods are exactly the `this.call("<operationId>"` sites in the client. */
function sdkConvenienceOperations(): Set<string> {
  const text = fs.readFileSync(path.join(root, "sdk", "src", "client.ts"), "utf8");
  return new Set([...text.matchAll(/this\.call\("([A-Za-z]+)"/g)].map((m) => m[1] as string));
}

export function buildCatalogue(): { version: number; source: string; counts: Record<string, number>; capabilities: Capability[] } {
  const spec = readJson<{ paths: Record<string, Record<string, Record<string, unknown>>> }>("docs/openapi.json");
  const exposure = readJson<{ operations: ExposureEntry[] }>("docs/ecosystem/exposure.json");
  const byId = new Map(exposure.operations.map((e) => [e.operationId, e]));
  const convenience = sdkConvenienceOperations();
  const toolByOperation = new Map(TOOLS.map((t) => [t.operationId as string, t.name]));

  const capabilities: Capability[] = [];
  for (const [route, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const id = op.operationId as string | undefined;
      if (id === undefined) continue;
      const e = byId.get(id);
      if (e === undefined) throw new Error(`docs/ecosystem/exposure.json has no entry for ${id}`);
      byId.delete(id);
      capabilities.push({
        id,
        method: method.toUpperCase(),
        route,
        summary: String(op.summary ?? ""),
        tag: String((op.tags as string[] | undefined)?.[0] ?? ""),
        authorization: String(op["x-bind-access"] ?? ""),
        exposure: e.exposure,
        effect: e.effect,
        irreversible: e.irreversible,
        economic: e.economic,
        stability: e.stability,
        flags: e.flags,
        note: e.note,
        idempotency: { clientKey: false, natural: NATURAL_IDEMPOTENCY[id] ?? "not documented" },
        surfaces: { api: true, sdk: convenience.has(id) ? "convenience" : "generic", mcp: toolByOperation.get(id) ?? null },
      });
    }
  }
  if (byId.size > 0) throw new Error(`docs/ecosystem/exposure.json names operations that are not in the API: ${[...byId.keys()].join(", ")}`);
  capabilities.sort((a, b) => a.id.localeCompare(b.id));

  const counts: Record<string, number> = { operations: capabilities.length, mcpTools: capabilities.filter((c) => c.surfaces.mcp).length };
  for (const c of capabilities) counts[`exposure:${c.exposure}`] = (counts[`exposure:${c.exposure}`] ?? 0) + 1;
  for (const c of capabilities) counts[`effect:${c.effect}`] = (counts[`effect:${c.effect}`] ?? 0) + 1;
  return {
    version: 1,
    source: "docs/openapi.json + docs/ecosystem/exposure.json + sdk/src/client.ts + mcp/src/tools.ts. Generated: do not edit by hand.",
    counts,
    capabilities,
  };
}

export function serialiseCatalogue(): string {
  return JSON.stringify(buildCatalogue(), null, 2) + "\n";
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const target = path.join(root, "docs", "capabilities.json");
  fs.writeFileSync(target, serialiseCatalogue());
  console.log(`wrote ${path.relative(root, target)}`);
}
