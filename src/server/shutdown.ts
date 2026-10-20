import type { Server } from "node:http";
import { log as defaultLog } from "../observability/logger.js";

/**
 * Graceful shutdown (docs/decisions/0032). The order is fixed:
 *   1. stop accepting connections (server.close), at once and synchronously;
 *   2. stop the background worker, which waits for a tick in progress;
 *   3. wait for in-flight requests to finish, up to timeoutMs; after that, close every connection (forced);
 *   4. wait for the worker to finish, then close the database pool, once.
 * A second call returns the first call's promise, so the pool is never closed twice.
 */

export interface ShutdownLog {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface ShutdownOptions {
  server: Pick<Server, "close" | "closeAllConnections">;
  /** The background worker, or null when none runs. Its stop resolves when a tick in progress has finished. */
  worker: { stop(): Promise<void> } | null;
  closePool: () => Promise<void>;
  /** How long in-flight requests may run before their connections are closed. Default 20 seconds. */
  timeoutMs?: number;
  log?: ShutdownLog;
}

export interface ShutdownResult {
  /** True when the requests did not finish in time and their connections were closed. */
  forced: boolean;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<ShutdownResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const logger: ShutdownLog = options.log ?? defaultLog;
  let pending: Promise<ShutdownResult> | null = null;

  async function run(signal: string): Promise<ShutdownResult> {
    logger.info("shutdown.started", { signal });

    // 1. Stop accepting. The callback runs when the last connection has closed.
    const drained = new Promise<void>((resolve) => {
      options.server.close(() => resolve());
    });

    // 2. Stop the worker. Its stop waits for a tick in progress.
    const workerStopped: Promise<void> = options.worker
      ? options.worker.stop().catch((err: unknown) => {
          logger.error("shutdown.worker_stop_failed", { error: err });
        })
      : Promise.resolve();

    // 3. In-flight requests get timeoutMs. The timer is cleared when they finish first.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cutoff = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const finished = Promise.all([drained, workerStopped]).then(() => true as const);
    const clean = await Promise.race([finished, cutoff]);
    clearTimeout(timer);

    let forced = false;
    if (!clean) {
      forced = true;
      logger.warn("shutdown.requests_cut_off", { timeoutMs });
      options.server.closeAllConnections();
    }

    // 4. The worker is stopped before the pool closes. After a forced cut-off the connections are gone, so this is brief.
    await drained;
    await workerStopped;
    try {
      await options.closePool();
    } catch (err) {
      forced = true;
      logger.error("shutdown.pool_close_failed", { error: err });
    }
    logger.info("shutdown.completed", { forced });
    return { forced };
  }

  return (signal: string): Promise<ShutdownResult> => {
    if (pending === null) pending = run(signal);
    return pending;
  };
}
