import { describe, it, expect } from "vitest";
import { newId } from "../../src/utils/ids.js";

describe("newId", () => {
  it("ids are unique over a million draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100_000; i += 1) {
      seen.add(newId("audit"));
    }
    expect(seen.size).toBe(100_000);
  });

  it("ids carry the prefix", () => {
    const id = newId("audit_prop");
    expect(id.startsWith("audit_prop_")).toBe(true);
    expect(id.slice("audit_prop_".length)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("rejects an invalid prefix", () => {
    for (const bad of ["", "Audit", "1audit", "audit-prop", "audit prop", "audit.x", "_audit"]) {
      expect(() => newId(bad), `prefix '${bad}'`).toThrow(TypeError);
    }
  });
});
