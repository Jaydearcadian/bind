import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { Server } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createApp } from "../../src/server/app.js";
import { closePool } from "../../src/db/client.js";

/*
 * What the server serves under /sdk/ (ADR 0056): the compiled browser modules and nothing else. Requests go over raw
 * node:http, so a path such as /sdk/../package.json reaches Express unchanged (a fetch client would normalise it first).
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const SDK_DIST = path.join(ROOT, "sdk", "dist");

interface Answer {
  status: number;
  type: string;
  cache: string;
  body: string;
}

function rawRequest(port: number, method: string, rawPath: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: rawPath, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          type: String(res.headers["content-type"] ?? ""),
          cache: String(res.headers["cache-control"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        })
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

/** The newest modification time of any file under a folder. */
function newestMtime(dir: string): number {
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((newest, entry) => {
    const full = path.join(dir, entry.name);
    const at = entry.isDirectory() ? newestMtime(full) : fs.statSync(full).mtimeMs;
    return Math.max(newest, at);
  }, 0);
}

/** True when sdk/dist/index.js exists and is newer than every file in sdk/src, so a rebuild would change nothing. */
function sdkBuildIsCurrent(): boolean {
  const built = path.join(SDK_DIST, "index.js");
  if (!fs.existsSync(built)) return false;
  return fs.statSync(built).mtimeMs > newestMtime(path.join(ROOT, "sdk", "src"));
}

/** Every compiled .js file under sdk/dist, as paths relative to it (for example "generated/operations.js"). */
function compiledJs(dir: string, prefix = ""): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) return compiledJs(path.join(dir, entry.name), `${rel}/`);
    return entry.name.endsWith(".js") ? [rel] : [];
  });
}

describe("/sdk/ serves the compiled browser SDK only (ADR 0056)", () => {
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    // The served files are the build output. Rebuild only when sdk/src is newer than sdk/dist, because a rebuild rewrites
    // sdk/dist in place and must not race another run's server. A failure here fails the suite.
    if (!sdkBuildIsCurrent()) execSync("npm run sdk:build", { cwd: ROOT, stdio: "pipe" });
    const app = createApp({ rateLimits: { enabled: false }, metrics: { token: null } });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  }, 60_000);

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  });

  it("serves /sdk/index.js as JavaScript, with the file's exact bytes and the asset cache policy", async () => {
    const answer = await rawRequest(port, "GET", "/sdk/index.js");
    expect(answer.status).toBe(200);
    expect(answer.type).toMatch(/^(text|application)\/javascript/);
    expect(answer.cache).toBe("public, max-age=300");
    expect(answer.body).toBe(fs.readFileSync(path.join(SDK_DIST, "index.js"), "utf8"));
  });

  it("serves every compiled .js file in the SDK output, including the nested generated folder", async () => {
    const files = compiledJs(SDK_DIST);
    expect(files).toEqual(expect.arrayContaining(["index.js", "client.js", "generated/operations.js"]));
    for (const rel of files) {
      const answer = await rawRequest(port, "GET", `/sdk/${rel}`);
      expect(answer.status, rel).toBe(200);
      expect(answer.type, rel).toMatch(/javascript/);
    }
  });

  it("answers HEAD like GET for a module", async () => {
    const answer = await rawRequest(port, "HEAD", "/sdk/index.js");
    expect(answer.status).toBe(200);
    expect(answer.type).toMatch(/javascript/);
  });

  it("does not serve declaration files, source maps or the generated type file", async () => {
    for (const rel of ["index.d.ts", "client.d.ts", "generated/api.d.ts", "generated/operations.d.ts", "index.js.map"]) {
      const answer = await rawRequest(port, "GET", `/sdk/${rel}`);
      expect(answer.status, rel).toBe(404);
      expect(answer.type, rel).not.toMatch(/javascript/);
      expect(answer.body, rel).not.toBe(fs.readFileSync(path.join(SDK_DIST, rel), "utf8"));
    }
  });

  it("does not serve anything outside the SDK output, even with path tricks", async () => {
    const secretNeedles = ['"name": "bind"', "createApp", "DATABASE_URL"];
    const attempts = [
      "/sdk/../package.json",
      "/sdk/../../package.json",
      "/sdk/..%2fpackage.json",
      "/sdk/%2e%2e/package.json",
      "/sdk/%2e%2e%2fpackage.json",
      "/sdk/generated/../../../package.json",
      "/sdk/..%2fsrc%2fserver%2fapp.ts",
      "/sdk/../src/server/app.ts",
      "/sdk/src/index.ts",
      "/sdk/../.env",
      "/sdk/index.js/../../package.json",
      "/sdk/%00index.js",
      "/sdk/",
      "/sdk",
    ];
    for (const attempt of attempts) {
      const answer = await rawRequest(port, "GET", attempt);
      expect(answer.status, attempt).not.toBe(200);
      expect(answer.type, attempt).not.toMatch(/javascript/);
      for (const needle of secretNeedles) expect(answer.body, attempt).not.toContain(needle);
    }
  });

  it("answers 404 for a missing module or a non-GET method, and keeps serving afterwards", async () => {
    const missing = await rawRequest(port, "GET", "/sdk/does-not-exist.js");
    expect(missing.status).toBe(404);
    const posted = await rawRequest(port, "POST", "/sdk/index.js");
    expect(posted.status).toBe(404);
    const again = await rawRequest(port, "GET", "/sdk/index.js");
    expect(again.status).toBe(200);
  });
});
