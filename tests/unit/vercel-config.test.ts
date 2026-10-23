import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Vercel routing of the hosted MCP endpoint (docs/decisions/0075, point 1). /mcp must reach the API function, and no earlier
 * rewrite or static file may serve it instead.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8")) as {
  rewrites: Array<{ source: string; destination: string }>;
  outputDirectory: string;
  cleanUrls: boolean;
  functions: Record<string, { includeFiles?: string }>;
};

/** Vercel matches a rewrite source as an anchored pattern. Each source here is a path pattern. */
function matches(source: string, pathname: string): boolean {
  return new RegExp(`^${source}$`).test(pathname);
}

describe("vercel.json routes /mcp to the API function", () => {
  it("has a rewrite from /mcp to /api/index", () => {
    const rewrite = config.rewrites.find((r) => r.source === "/mcp");
    expect(rewrite).toEqual({ source: "/mcp", destination: "/api/index" });
  });

  it("no rewrite before it shadows /mcp, and no other rewrite sends /mcp elsewhere", () => {
    const index = config.rewrites.findIndex((r) => r.source === "/mcp");
    const earlier = config.rewrites.slice(0, index);
    expect(earlier.filter((r) => matches(r.source, "/mcp"))).toEqual([]);
    const others = config.rewrites.filter((r) => r.source !== "/mcp" && matches(r.source, "/mcp"));
    expect(others).toEqual([]);
  });

  it("no static file under the output directory is named mcp, so cleanUrls cannot serve /mcp", () => {
    expect(config.cleanUrls).toBe(true);
    const candidates = [
      path.join(ROOT, "web", "mcp.html"),
      path.join(ROOT, "web", "mcp"),
      path.join(ROOT, "web", "mcp", "index.html"),
    ];
    for (const candidate of candidates) expect(fs.existsSync(candidate), candidate).toBe(false);
    expect(config.outputDirectory).toBe("public");
  });

  it("the function includes the built MCP module and the contract file it reads", () => {
    const include = config.functions["api/index.js"]?.includeFiles ?? "";
    expect(include).toContain("mcp/dist/**");
    expect(include).toContain("docs/openapi.json");
  });
});
