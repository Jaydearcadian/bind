import { createApp } from "./server/app.js";
import { config } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { closePool } from "./db/client.js";
import { provisionDemoWorkspace } from "./server/demo.js";
import { createShutdown } from "./server/shutdown.js";
import { startWorker, type Worker } from "./workers/runner.js";
import { log } from "./observability/logger.js";
import { closeAllEventStreams } from "./api/event-streams.js";

/** In-flight requests and the worker get this long to finish on shutdown (docs/decisions/0032). */
const SHUTDOWN_TIMEOUT_MS = 20_000;
/** A hard exit if shutdown itself hangs, a little after its own deadline. */
const HARD_EXIT_GRACE_MS = 5_000;

type Shutdown = (signal: string) => Promise<{ forced: boolean }>;
let shutdown: Shutdown | null = null;

/** Runs the shared shutdown, then exits: 0 when clean, 1 when forced or when the process failed. */
function stopAndExit(signal: string, failed: boolean): void {
  if (shutdown === null) {
    process.exit(1);
    return;
  }
  const hardExit = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS + HARD_EXIT_GRACE_MS);
  hardExit.unref();
  shutdown(signal).then(
    ({ forced }) => process.exit(failed || forced ? 1 : 0),
    () => process.exit(1)
  );
}

async function main() {
  log.info("server.starting");

  // Run database migrations on start (under the migration lock, docs/decisions/0032)
  await runMigrations();

  // Ensure default demo kitchen workspace exists. An existing one is not reset on boot.
  try {
    await provisionDemoWorkspace();
    log.info("demo.ready", { workspaceId: "ws-kitchen-main" });
  } catch (err) {
    log.warn("demo.not_provisioned", { error: err });
  }

  // The hosted MCP module (docs/decisions/0075) is built by `npm run mcp:build`. Without it, /mcp answers 503.
  const app = createApp({ hostedMcp: { load: () => import(new URL("../mcp/dist/mcp/src/hosted.js", import.meta.url).href) } });
  const port = config.PORT;

  let worker: Worker | null = null;
  const server = app.listen(port, () => {
    log.info("server.listening", { port });

    // The worker expires approvals, resumes interrupted workflows and polls settlements without anyone opening a
    // page (ADR 0029). BIND_WORKER_ENABLED=false turns it off. Serverless deployments run no worker.
    // The restock sweep (ADR 0030) is OFF unless BIND_RESTOCK_SWEEP=true: it can place orders within policy without a
    // human, so the owner opts in (ADR 0030, "Default").
    if (config.BIND_WORKER_ENABLED !== "false") {
      // The weekly analytics reports (docs/decisions/0090) are OFF unless BIND_ANALYTICS_REPORTS=true.
      const analyticsReports = config.BIND_ANALYTICS_REPORTS === "true";
      worker = startWorker({ restockSweep: config.BIND_RESTOCK_SWEEP === "true", analyticsReports });
      log.info("worker.started", { restockSweep: config.BIND_RESTOCK_SWEEP === "true", analyticsReports });
    }
  });

  shutdown = createShutdown({
    server,
    worker: { stop: () => (worker ? worker.stop() : Promise.resolve()) },
    closePool,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    log,
    // Open event streams end first, with a shutdown event, so they do not hold the shutdown (docs/decisions/0035).
    beforeClose: () => {
      closeAllEventStreams("shutdown");
    },
  });

  process.on("SIGTERM", () => stopAndExit("SIGTERM", false));
  process.on("SIGINT", () => stopAndExit("SIGINT", false));
  process.on("unhandledRejection", (reason) => {
    log.error("process.unhandled_rejection", { error: reason });
    stopAndExit("unhandledRejection", true);
  });
  process.on("uncaughtException", (err) => {
    log.error("process.uncaught_exception", { error: err });
    stopAndExit("uncaughtException", true);
  });
}

main().catch((err) => {
  log.error("server.start_failed", { error: err });
  process.exit(1);
});
