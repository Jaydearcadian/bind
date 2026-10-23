import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { createApp } from "../../src/server/app.js";
import { config } from "../../src/config/env.js";
import { createPrivyVerifier } from "../../src/accounts/privy.js";
import { PublicConfigSchema } from "../../src/api/schemas.js";
import { ROUTES } from "../../src/api/registry.js";

/**
 * GET /api/public-config (ADR 0070): the browser's sign-in configuration. Public, unauthenticated, never cached, and it
 * carries exactly one key. Built over real HTTP; the Privy app id and verifier are passed as createApp options, so no test
 * depends on or mutates the process environment.
 */

const APP_ID = "clpublicconfigtestappid0001";
const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
// The base64 body of the key, without its header and footer lines: the part that must never reach a browser.
const KEY_BODY_LINES = PEM.split("\n").filter((line) => line.length > 0 && !line.startsWith("-----"));

async function get(baseUrl: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/api/public-config`, { headers });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: JSON.parse(text) as unknown };
}

function listen(app: ReturnType<typeof createApp>): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

describe("GET /api/public-config", () => {
  const unset = createApp({ rateLimits: { enabled: false }, publicConfig: { privyAppId: null } });
  const set = createApp({
    rateLimits: { enabled: false },
    publicConfig: { privyAppId: APP_ID },
    accounts: { verifier: createPrivyVerifier({ appId: APP_ID, verificationKeyPem: PEM }) },
  });
  let unsetServer: Server;
  let setServer: Server;
  let unsetUrl = "";
  let setUrl = "";

  beforeAll(async () => {
    const a = await listen(unset);
    const b = await listen(set);
    unsetServer = a.server;
    unsetUrl = a.url;
    setServer = b.server;
    setUrl = b.url;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => unsetServer.close(() => resolve()));
    await new Promise<void>((resolve) => setServer.close(() => resolve()));
  });

  it("answers null when no Privy app id is configured", async () => {
    const res = await get(unsetUrl);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ privyAppId: null });
  });

  it("answers the app id when one is configured", async () => {
    const res = await get(setUrl);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ privyAppId: APP_ID });
  });

  it("the body has exactly one key, privyAppId, and matches its schema", async () => {
    for (const url of [unsetUrl, setUrl]) {
      const res = await get(url);
      expect(Object.keys(res.body as object)).toEqual(["privyAppId"]);
      expect(PublicConfigSchema.safeParse(res.body).success).toBe(true);
    }
  });

  it("is sent with Cache-Control: no-store and a JSON content type", async () => {
    const res = await get(setUrl);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("needs no authentication: no token, and a bogus token, both get the same answer", async () => {
    const none = await get(setUrl);
    const bogus = await get(setUrl, { Authorization: "Bearer bnd_notarealtokenvaluenotarealtokenvalue0" });
    expect(none.status).toBe(200);
    expect(bogus.status).toBe(200);
    expect(bogus.body).toEqual(none.body);
  });

  it("never returns the verification key or any key material", async () => {
    const res = await get(setUrl);
    expect(res.text).not.toContain("PUBLIC KEY");
    expect(res.text).not.toContain("BEGIN");
    for (const line of KEY_BODY_LINES) {
      expect(res.text).not.toContain(line.slice(0, 40));
    }
  });

  it("is in the route registry as a public, contract-tested read", () => {
    const spec = ROUTES.find((r) => r.operationId === "getPublicConfig");
    expect(spec).toMatchObject({ method: "get", path: "/api/public-config", access: "public", contractTested: true });
  });

  it("with no option given, reads PRIVY_APP_ID from the environment", async () => {
    const defaulted = createApp({ rateLimits: { enabled: false } });
    const { server, url } = await listen(defaulted);
    try {
      const res = await get(url);
      expect(res.body).toEqual({ privyAppId: config.PRIVY_APP_ID ?? null });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
