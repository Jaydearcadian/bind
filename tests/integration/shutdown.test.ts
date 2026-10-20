import { describe, it, expect, vi } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createShutdown, type ShutdownLog } from "../../src/server/shutdown.js";

/*
 * Graceful shutdown (docs/decisions/0032). Real http servers on port 0, no database. The order is: stop accepting,
 * stop the worker, wait for in-flight requests (bounded), close the pool once.
 */

const silentLog: ShutdownLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

function startServer(handler: http.RequestListener): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}/` });
    });
  });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("graceful shutdown", () => {
  it("an in-flight request finishes during shutdown", async () => {
    const arrived = deferred();
    const { server, url } = await startServer((_req, res) => {
      arrived.resolve();
      setTimeout(() => res.end("finished"), 300);
    });
    const closePool = vi.fn(async () => undefined);
    const shutdown = createShutdown({ server, worker: null, closePool, timeoutMs: 5000, log: silentLog });

    const inFlight = fetch(url).then((r) => r.text());
    await arrived.promise;
    const result = shutdown("SIGTERM");

    expect(await inFlight).toBe("finished");
    expect(await result).toEqual({ forced: false });
    expect(closePool).toHaveBeenCalledTimes(1);
  });

  it("new connections are refused after shutdown starts", async () => {
    const arrived = deferred();
    const { server, url } = await startServer((_req, res) => {
      arrived.resolve();
      setTimeout(() => res.end("still here"), 300);
    });
    const closePool = vi.fn(async () => undefined);
    const shutdown = createShutdown({ server, worker: null, closePool, timeoutMs: 5000, log: silentLog });

    const inFlight = fetch(url).then((r) => r.text());
    await arrived.promise;
    const result = shutdown("SIGINT");

    await expect(fetch(url)).rejects.toThrow();
    expect(await inFlight).toBe("still here");
    expect((await result).forced).toBe(false);
  });

  it("the worker is stopped before the pool is closed and the pool is closed once", async () => {
    const { server } = await startServer((_req, res) => res.end("idle"));
    const events: string[] = [];
    const worker = {
      stop: async () => {
        events.push("worker-stop-start");
        await new Promise((resolve) => setTimeout(resolve, 100));
        events.push("worker-stopped");
      },
    };
    const closePool = vi.fn(async () => {
      events.push("pool-closed");
    });
    const shutdown = createShutdown({ server, worker, closePool, timeoutMs: 5000, log: silentLog });

    await shutdown("SIGTERM");
    await shutdown("SIGTERM");

    expect(events).toEqual(["worker-stop-start", "worker-stopped", "pool-closed"]);
    expect(closePool).toHaveBeenCalledTimes(1);
  });

  it("a stuck request is cut off after the timeout and shutdown reports forced", async () => {
    const arrived = deferred();
    const { server, url } = await startServer(() => {
      // Never answers.
      arrived.resolve();
    });
    const closePool = vi.fn(async () => undefined);
    const shutdown = createShutdown({ server, worker: null, closePool, timeoutMs: 300, log: silentLog });

    const stuck = fetch(url).then(
      () => "answered",
      () => "cut off"
    );
    await arrived.promise;
    const result = await shutdown("SIGTERM");

    expect(result).toEqual({ forced: true });
    expect(await stuck).toBe("cut off");
    expect(closePool).toHaveBeenCalledTimes(1);
  });

  it("a second shutdown call does not close the pool twice", async () => {
    const { server } = await startServer((_req, res) => res.end("idle"));
    const closePool = vi.fn(async () => undefined);
    const shutdown = createShutdown({ server, worker: null, closePool, timeoutMs: 5000, log: silentLog });

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");
    expect(second).toBe(first);
    await first;
    await shutdown("SIGTERM");

    expect(closePool).toHaveBeenCalledTimes(1);
  });
});
