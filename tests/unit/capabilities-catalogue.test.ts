import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogue, serialiseCatalogue, EFFECTS, EXPOSURES } from "../../scripts/generate-capabilities.js";

/**
 * The capability catalogue (docs/capabilities.json) joins the API contract, the reviewed exposure map and the real SDK and MCP
 * surfaces. These tests keep it honest: it is current, every operation is classified, and the rules about what an agent surface
 * may reach hold. They do not prove the classification is right; a reviewer did that (docs/ecosystem/ECOSYSTEM_AUDIT.md).
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const catalogue = buildCatalogue();
const caps = catalogue.capabilities;

describe("capability catalogue", () => {
  it("the committed docs/capabilities.json is current (run npm run capabilities:generate)", () => {
    expect(fs.readFileSync(path.join(ROOT, "docs", "capabilities.json"), "utf8")).toBe(serialiseCatalogue());
  });

  it("classifies every API operation exactly once, with known exposure and effect classes", () => {
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "openapi.json"), "utf8")) as { paths: Record<string, Record<string, { operationId?: string }>> };
    const ids = Object.values(spec.paths).flatMap((m) => Object.values(m).map((o) => o.operationId)).filter((x): x is string => typeof x === "string");
    expect(caps.map((c) => c.id).sort()).toEqual([...ids].sort());
    expect(new Set(caps.map((c) => c.id)).size).toBe(caps.length);
    for (const c of caps) {
      expect(EXPOSURES as readonly string[]).toContain(c.exposure);
      expect(EFFECTS as readonly string[]).toContain(c.effect);
    }
  });

  it("an MCP tool is a member route and never an owner decision, configuration, credential or operational action", () => {
    const tools = caps.filter((c) => c.surfaces.mcp !== null);
    expect(tools.length).toBe(catalogue.counts.mcpTools);
    for (const t of tools) {
      expect(t.authorization, t.id).toBe("member");
      expect(["read", "external_request", "commercial_commitment"], t.id).toContain(t.effect);
      expect(t.exposure, t.id).not.toBe("internal_service");
      expect(t.flags.join(","), t.id).not.toMatch(/secret|credential/);
    }
  });

  it("the only commercial commitments an agent tool can start are the three that pass the policy gate", () => {
    const committing = caps.filter((c) => c.surfaces.mcp !== null && c.effect === "commercial_commitment").map((c) => c.id).sort();
    expect(committing).toEqual(["cancelCustomerOrder", "createCustomerOrder", "replenish"]);
  });

  it("owner decisions, credentials and internal operations are never reachable from an agent or a convenience method", () => {
    for (const c of caps) {
      if (["owner_decision", "credential", "owner_configuration", "operational"].includes(c.effect) || c.exposure === "internal_service") {
        expect(c.surfaces.mcp, c.id).toBeNull();
        if (c.exposure === "internal_service") expect(c.surfaces.sdk, c.id).toBe("generic");
      }
    }
  });

  it("every operation that accepts or returns a secret is flagged, owner-or-public only, and has no agent surface", () => {
    for (const c of caps.filter((x) => x.flags.some((f) => /secret|returns_secret|accepts_secret/.test(f)))) {
      expect(c.surfaces.mcp, c.id).toBeNull();
      expect(["owner", "public"], c.id).toContain(c.authorization);
    }
  });

  it("no capability claims a client idempotency key, because the contract has none", () => {
    for (const c of caps) expect(c.idempotency.clientKey).toBe(false);
    const spec = fs.readFileSync(path.join(ROOT, "docs", "openapi.json"), "utf8");
    expect(spec.toLowerCase()).not.toContain("idempotency-key");
  });

  it("every irreversible or economic operation says what it is in a note", () => {
    for (const c of caps.filter((x) => x.irreversible || x.economic)) {
      const flagged = c.note.trim().length > 0 || c.effect === "read";
      expect(flagged, c.id).toBe(true);
    }
  });
});
