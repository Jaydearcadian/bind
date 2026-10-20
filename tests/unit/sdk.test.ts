import { describe, it, expect } from "vitest";
import util from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BindClient } from "../../sdk/src/index.js";
import { BindApiError, BindNetworkError, BindTimeoutError, BindError } from "../../sdk/src/index.js";
import { OPERATIONS } from "../../sdk/src/generated/operations.js";
import { generateSdkFiles, writeSdkFiles } from "../../scripts/generate-sdk.js";

/*
 * The typed client (docs/decisions/0036). Every request goes through a mock fetch here, so each assertion is about what the
 * SDK sends and what it does with the answer. The server is not involved; tests/integration/sdk.test.ts runs against it.
 */

const ROOT = path.resolve(import.meta.dirname, "../..");
const BASE = "https://bind.example";
const TOKEN = "bnd_" + "Sx9".repeat(14) + "Q";
const WS = "ws-sdk-unit";
/** A complete inventory body, as the contract requires one. */
const ITEM = {
  sku: "FOOD-SDK-1",
  name: "SDK Test Item",
  category: "General",
  unit: "unit",
  currentQuantity: 3,
  parLevel: 5,
  reorderQuantity: 10,
  unitPriceCents: 100,
};

type Seen = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } };

/** A fetch that answers from a handler and records every call. */
function mockFetch(handler: (url: string, init: Seen["init"], index: number) => Response | Promise<Response>) {
  const calls: Seen[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const seen: Seen = { url, init: (init ?? {}) as Seen["init"] };
    calls.push(seen);
    return handler(url, seen.init, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Records every requested wait, so retry delays are asserted without real time passing. */
function recordingSleep() {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  return { waits, sleep };
}

describe("typed client: configuration and secrecy", () => {
  it("the token is never in JSON, string or inspect output", () => {
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: mockFetch(() => json(200, [])).fetch });
    expect(JSON.stringify(client)).not.toContain(TOKEN);
    expect(JSON.stringify({ wrapped: client })).not.toContain(TOKEN);
    expect(String(client)).not.toContain(TOKEN);
    expect(`${client}`).not.toContain(TOKEN);
    expect(util.inspect(client)).not.toContain(TOKEN);
    expect(util.inspect(client, { depth: 6, showHidden: true })).not.toContain(TOKEN);
    expect(util.format("%o", client)).not.toContain(TOKEN);
  });

  it("a base url with credentials or a non-http scheme is refused", () => {
    const fetch = mockFetch(() => json(200, [])).fetch;
    for (const baseUrl of [
      "https://user:secret@bind.example",
      "https://user@bind.example",
      "ftp://bind.example",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
      "https://bind.example/?token=x",
      "https://bind.example/#token",
    ]) {
      expect(() => new BindClient({ baseUrl, token: TOKEN, fetch }), baseUrl).toThrow(TypeError);
    }
    expect(() => new BindClient({ baseUrl: BASE, token: "" , fetch })).toThrow(TypeError);
    expect(() => new BindClient({ baseUrl: BASE, token: "has a space", fetch })).toThrow(TypeError);
    expect(() => new BindClient({ baseUrl: BASE, token: "tab\there", fetch })).toThrow(TypeError);
    expect(() => new BindClient({ baseUrl: "http://localhost:3000/", token: TOKEN, fetch })).not.toThrow();
    expect(() => new BindClient({ baseUrl: "https://bind.example/prefix///", token: TOKEN, fetch })).not.toThrow();
  });

  it("the generated operations table covers every operation in docs/openapi.json", async () => {
    const doc = JSON.parse(await fs.readFile(path.join(ROOT, "docs/openapi.json"), "utf8")) as {
      paths: Record<string, Record<string, { operationId: string }>>;
    };
    const expected = new Map<string, { method: string; path: string }>();
    for (const [p, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!["get", "post", "put", "delete", "patch"].includes(method)) continue;
        expected.set(op.operationId, { method: method.toUpperCase(), path: p });
      }
    }
    expect(expected.size).toBeGreaterThan(40);
    expect(Object.keys(OPERATIONS).sort()).toEqual([...expected.keys()].sort());
    for (const [id, want] of expected) {
      expect(OPERATIONS[id as keyof typeof OPERATIONS], id).toEqual(want);
    }
  });

  it("the generated types are current", async () => {
    const doc = JSON.parse(await fs.readFile(path.join(ROOT, "docs/openapi.json"), "utf8"));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bind-sdk-gen-"));
    try {
      await writeSdkFiles(dir, await generateSdkFiles(doc));
      for (const name of ["api.d.ts", "operations.ts"]) {
        const fresh = await fs.readFile(path.join(dir, name), "utf8");
        const committed = await fs.readFile(path.join(ROOT, "sdk/src/generated", name), "utf8");
        expect(fresh, `sdk/src/generated/${name} is stale: run npm run sdk:generate`).toBe(committed);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe("typed client: requests", () => {
  it("path parameters are encoded and an absolute url as a path is refused", async () => {
    const mock = mockFetch(() => json(200, { id: WS }));
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: mock.fetch });
    await client.workspace("a/b?c=d#e");
    expect(mock.calls[0].url).toBe(`${BASE}/api/workspaces/a%2Fb%3Fc%3Dd%23e`);

    await expect(client.workspace("https://evil.example/x")).rejects.toBeInstanceOf(TypeError);
    await expect(client.workspace("//evil.example")).rejects.toBeInstanceOf(TypeError);
    await expect(client.workspace("..")).rejects.toBeInstanceOf(TypeError);
    await expect(client.workspace("")).rejects.toBeInstanceOf(TypeError);
    await expect(client.call("getWorkspace", { params: {} as never })).rejects.toBeInstanceOf(TypeError);
    // Refused before any request leaves: only the first call reached the mock.
    expect(mock.calls.length).toBe(1);
  });

  it("query values that are undefined are dropped", async () => {
    const mock = mockFetch(() => json(200, { events: [], nextCursor: "0.0", hasMore: false }));
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: mock.fetch });
    await client.pollEvents(WS, { after: undefined, limit: undefined });
    await client.pollEvents(WS, { limit: 5 });
    await client.feedbackSummary(WS, undefined);
    expect(mock.calls[0].url).toBe(`${BASE}/api/workspaces/${WS}/events/poll`);
    expect(mock.calls[1].url).toBe(`${BASE}/api/workspaces/${WS}/events/poll?limit=5`);
    expect(mock.calls[2].url).toBe(`${BASE}/api/workspaces/${WS}/feedback/summary`);
  });

  it("every request carries a fresh safe request id and the bearer token", async () => {
    const mock = mockFetch(() => json(200, []));
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: mock.fetch });
    await client.listAudit(WS);
    await client.listAudit(WS);
    const ids = mock.calls.map((c) => c.init.headers?.["x-request-id"]);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(new Set(ids).size).toBe(2);
    for (const call of mock.calls) {
      expect(call.init.headers?.authorization).toBe(`Bearer ${TOKEN}`);
      expect(call.init.headers?.accept).toBe("application/json");
      expect(call.url).not.toContain(TOKEN);
    }
  });

  it("a non-2xx response becomes a BindApiError with code, request id, reason codes and retry-after", async () => {
    const mock = mockFetch(() =>
      json(
        409,
        { error: "Workspace is busy", code: "BUSY", reasonCodes: ["ORDER_OPEN", "APPROVAL_PENDING"] },
        { "x-request-id": "srv-req-1234", "retry-after": "7" }
      )
    );
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: mock.fetch });
    const error = await client.upsertInventory(WS, ITEM).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BindApiError);
    expect(error).toBeInstanceOf(BindError);
    expect(error).toBeInstanceOf(Error);
    const api = error as BindApiError;
    expect(api.name).toBe("BindApiError");
    expect(api.status).toBe(409);
    expect(api.message).toBe("Workspace is busy");
    expect(api.code).toBe("BUSY");
    expect(api.requestId).toBe("srv-req-1234");
    expect(api.reasonCodes).toEqual(["ORDER_OPEN", "APPROVAL_PENDING"]);
    expect(api.retryAfterSeconds).toBe(7);
    expect(api.body).toMatchObject({ error: "Workspace is busy", code: "BUSY", reasonCodes: ["ORDER_OPEN", "APPROVAL_PENDING"] });
  });

  it("an error never contains the token or the authorization header", async () => {
    const mock = mockFetch(() => json(400, { error: `bad value near ${TOKEN}`, detail: { echo: `Bearer ${TOKEN}` } }));
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: mock.fetch });
    const error = (await client.upsertInventory(WS, ITEM).catch((e: unknown) => e)) as BindApiError;
    expect(error).toBeInstanceOf(BindApiError);
    expect(error.message).not.toContain(TOKEN);
    expect(JSON.stringify(error.body)).not.toContain(TOKEN);
    expect(String(error.stack)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toContain(TOKEN);
    expect(JSON.stringify(error)).not.toMatch(/authorization/i);
    expect(Object.keys(error)).not.toContain("headers");

    const network = mockFetch(() => {
      throw new TypeError(`connect failed for Bearer ${TOKEN}`);
    });
    const down = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: network.fetch, maxRetries: 0 });
    const failure = (await down.upsertInventory(WS, ITEM).catch((e: unknown) => e)) as BindNetworkError;
    expect(failure).toBeInstanceOf(BindNetworkError);
    expect(failure.message).not.toContain(TOKEN);
    expect(JSON.stringify(failure)).not.toContain(TOKEN);
  });

  it("GET is retried on 503 with backoff and POST is not", async () => {
    const get = mockFetch((_url, _init, index) => (index < 2 ? json(503, { error: "busy" }) : json(200, [])));
    const { waits, sleep } = recordingSleep();
    const reader = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: get.fetch, sleep, random: () => 0.5 });
    await expect(reader.listAudit(WS)).resolves.toEqual([]);
    expect(get.calls.length).toBe(3);
    expect(waits).toEqual([200, 400]);

    const post = mockFetch(() => json(503, { error: "busy" }));
    const writer = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: post.fetch, sleep: recordingSleep().sleep });
    const error = await writer.upsertInventory(WS, ITEM).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BindApiError);
    expect((error as BindApiError).status).toBe(503);
    expect(post.calls.length).toBe(1);
  });

  it("a 429 on GET is retried once after retry-after", async () => {
    const mock = mockFetch((_url, _init, index) =>
      index === 0 ? json(429, { error: "slow down" }, { "retry-after": "2" }) : json(200, [])
    );
    const { waits, sleep } = recordingSleep();
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: mock.fetch, sleep });
    await expect(client.listAudit(WS)).resolves.toEqual([]);
    expect(mock.calls.length).toBe(2);
    expect(waits).toEqual([2000]);

    const again = mockFetch(() => json(429, { error: "slow down" }, { "retry-after": "2" }));
    const twice = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: again.fetch, sleep: recordingSleep().sleep });
    const error = (await twice.listAudit(WS).catch((e: unknown) => e)) as BindApiError;
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(2);
    expect(again.calls.length).toBe(2);

    const long = mockFetch(() => json(429, { error: "later" }, { "retry-after": "60" }));
    const waiting = recordingSleep();
    const far = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: long.fetch, sleep: waiting.sleep });
    await expect(far.listAudit(WS)).rejects.toBeInstanceOf(BindApiError);
    expect(long.calls.length).toBe(1);
    expect(waiting.waits).toEqual([]);
  });

  it("a timeout throws BindTimeoutError and aborts the request", async () => {
    const signals: AbortSignal[] = [];
    const hangs = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const signal = init!.signal!;
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as unknown as typeof fetch;
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: hangs, timeoutMs: 20, sleep: recordingSleep().sleep });
    const error = await client.listAudit(WS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BindTimeoutError);
    expect((error as BindTimeoutError).message).not.toContain(BASE);
    expect(signals.length).toBe(1);
    expect(signals[0].aborted).toBe(true);
  });

  it("a network failure on POST is not retried", async () => {
    const mock = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: mock.fetch, sleep: recordingSleep().sleep });
    const error = await client.replenish(WS, "FOOD-FLOUR-50LB").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BindNetworkError);
    expect(mock.calls.length).toBe(1);
  });
});

// Extra checks (not in the brief's list): the SDK source stays dependency-free and browser-safe, and it reports the API version.
describe("typed client: packaging boundary", () => {
  async function sdkSources(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await sdkSources(full)));
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
    }
    return out;
  }

  it("the SDK imports only its own files: no package, no node builtin, no server code", async () => {
    const sdkSrc = path.join(ROOT, "sdk/src");
    const files = await sdkSources(sdkSrc);
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const file of files) {
      const text = await fs.readFile(file, "utf8");
      for (const match of text.matchAll(/(?:^|\s)(?:import|export)\s[^"'`;]*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)) {
        const specifier = match[1] ?? match[2];
        expect(specifier.startsWith("."), `${path.relative(ROOT, file)} imports ${specifier}`).toBe(true);
        const resolved = path.resolve(path.dirname(file), specifier);
        expect(resolved.startsWith(sdkSrc + path.sep), `${path.relative(ROOT, file)} imports ${specifier} outside sdk/src`).toBe(true);
      }
    }
  });

  it("the SDK package is private, has no dependencies and carries the API version", async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "sdk/package.json"), "utf8"));
    const doc = JSON.parse(await fs.readFile(path.join(ROOT, "docs/openapi.json"), "utf8"));
    expect(pkg.name).toBe("@bind/sdk");
    expect(pkg.version).toBe(doc.info.version);
    expect(pkg.type).toBe("module");
    expect(pkg.private).toBe(true);
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.exports["."]).toBeDefined();
  });

  it("a call to an unknown operation id is a compile error", () => {
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: mockFetch(() => json(200, [])).fetch });
    const neverCalled = () => {
      // @ts-expect-error: there is no operation with this id (only the registry's operation ids are accepted)
      void client.call("noSuchOperation");
    };
    expect(typeof neverCalled).toBe("function");
  });
});

describe("typed client: idempotency key", () => {
  it("sends the key as a header, refuses a malformed one, and repeats a keyed command after a network failure", async () => {
    const { waits, sleep } = recordingSleep();
    const m = mockFetch((_url, _init, index) => {
      if (index === 0) throw new TypeError("fetch failed");
      return json(200, { paused: true });
    });
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: m.fetch, sleep, maxRetries: 2 } as ConstructorParameters<typeof BindClient>[0]);
    await client.call("setAgentsPaused", { params: { id: WS }, body: { paused: true }, idempotencyKey: "k-1" });
    expect(m.calls.length).toBe(2);
    for (const c of m.calls) expect(c.init.headers?.["idempotency-key"]).toBe("k-1");
    expect(waits.length).toBe(1);
    await expect(client.call("setAgentsPaused", { params: { id: WS }, body: { paused: true }, idempotencyKey: "bad key" })).rejects.toThrow(TypeError);
  });

  it("does not repeat a command without a key after a network failure", async () => {
    const m = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const client = new BindClient({ baseUrl: BASE, token: TOKEN, fetch: m.fetch, maxRetries: 2 });
    await expect(client.call("setAgentsPaused", { params: { id: WS }, body: { paused: true } })).rejects.toBeInstanceOf(BindNetworkError);
    expect(m.calls.length).toBe(1);
  });
});
