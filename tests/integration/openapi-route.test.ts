import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";

// The builder is wrapped (not replaced), so the route calls the real function and the test counts the calls.
vi.mock("../../src/api/openapi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/api/openapi.js")>();
  return { ...actual, buildOpenApiDocument: vi.fn(actual.buildOpenApiDocument) };
});

import { createApp } from "../../src/server/app.js";
import { buildOpenApiDocument } from "../../src/api/openapi.js";
import { closePool } from "../../src/db/client.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const COMMITTED = path.join(ROOT, "docs/openapi.json");

describe("GET /api/openapi.json is built once and served from memory (ADR 0034, ADR 0040)", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  let committed: Buffer;

  beforeAll(async () => {
    committed = fs.readFileSync(COMMITTED);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  });

  it("the openapi route does not re-read the file per request", async () => {
    const readSpy = vi.spyOn(fs, "readFileSync");
    const builder = vi.mocked(buildOpenApiDocument);
    builder.mockClear();
    try {
      const bodies: Buffer[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`${baseUrl}/api/openapi.json`);
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("no-store");
        bodies.push(Buffer.from(await res.arrayBuffer()));
      }

      // No request reads the committed document from disk, and the document is built once, on first use.
      const openapiReads = readSpy.mock.calls.filter(([file]) => String(file).includes("openapi"));
      expect(openapiReads).toEqual([]);
      expect(builder.mock.calls.length).toBe(1);

      // Every answer is the committed document, byte for byte.
      for (const body of bodies) expect(body.equals(committed)).toBe(true);
    } finally {
      readSpy.mockRestore();
    }
  });
});
