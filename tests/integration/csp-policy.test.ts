import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { createApp } from "../../src/server/app.js";

/**
 * The Content-Security-Policy is defined twice: helmet in src/server/app.ts (for the API and the pages it serves) and the
 * headers block in vercel.json (for the Vercel edge). They must say the same thing (ADR 0054, ADR 0070). This test reads the
 * header the running app really sends and the header vercel.json declares, and fails if either drifts from the other or from
 * the policy in ADR 0070.
 */

/** The policy as ADR 0070 states it. Only connect-src differs from ADR 0054: it gains https://auth.privy.io. */
const EXPECTED_POLICY: Record<string, string[]> = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "style-src": ["'self'"],
  "img-src": ["'self'", "data:"],
  "font-src": ["'self'"],
  "connect-src": ["'self'", "https://auth.privy.io"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
};

/** Parses a CSP header into directive name to source list. Throws on a duplicate directive, which is never valid. */
function parsePolicy(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(";")) {
    const tokens = part.trim().split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) continue;
    const [name, ...sources] = tokens;
    if (name in out) throw new Error(`duplicate CSP directive ${name}`);
    out[name] = sources;
  }
  return out;
}

describe("Content-Security-Policy: helmet and vercel.json agree (ADR 0070)", () => {
  const app = createApp({ rateLimits: { enabled: false }, publicConfig: { privyAppId: null } });
  let server: Server;
  let baseUrl = "";
  let livePolicy = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        baseUrl = addr && typeof addr === "object" ? `http://127.0.0.1:${addr.port}` : "";
        resolve();
      });
    });
    // The API route needs no database, so this runs without PostgreSQL.
    const res = await fetch(`${baseUrl}/api/public-config`);
    livePolicy = res.headers.get("content-security-policy") ?? "";
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("the running app sends the policy ADR 0070 states, exactly", () => {
    expect(livePolicy).not.toBe("");
    expect(parsePolicy(livePolicy)).toEqual(EXPECTED_POLICY);
    expect(parsePolicy(livePolicy)["connect-src"]).toEqual(["'self'", "https://auth.privy.io"]);
  });

  it("vercel.json declares the same policy as the running app, directive for directive", async () => {
    const vercel = JSON.parse(await fs.readFile(path.resolve(process.cwd(), "vercel.json"), "utf8")) as {
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    const values = vercel.headers
      .filter((h) => h.source === "/(.*)")
      .flatMap((h) => h.headers)
      .filter((h) => h.key.toLowerCase() === "content-security-policy")
      .map((h) => h.value);
    expect(values, "vercel.json must declare exactly one CSP for /(.*)").toHaveLength(1);
    expect(parsePolicy(values[0])).toEqual(parsePolicy(livePolicy));
    expect(parsePolicy(values[0])).toEqual(EXPECTED_POLICY);
  });
});
