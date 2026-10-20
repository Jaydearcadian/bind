import { createApp } from "./server/app.js";
import { config } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { provisionDemoWorkspace } from "./server/demo.js";
import { startWorker, type Worker } from "./workers/runner.js";

async function main() {
  console.log("Starting Bind Business Agent Engine...");

  // Run database migrations on start
  await runMigrations();

  // Ensure default demo kitchen workspace exists. An existing one is not reset on boot.
  try {
    await provisionDemoWorkspace();
    console.log("Demo Kitchen workspace 'ws-kitchen-main' ready.");
  } catch (err: any) {
    console.warn("Notice: demo workspace could not be provisioned:", err?.message);
  }

  const app = createApp();
  const port = config.PORT;

  let worker: Worker | null = null;
  const server = app.listen(port, () => {
    console.log(`Bind Server listening on http://127.0.0.1:${port}`);
    console.log(`Web Dashboard available at http://127.0.0.1:${port}`);

    // The worker expires approvals, resumes interrupted workflows and polls settlements without anyone opening a
    // page (ADR 0029). BIND_WORKER_ENABLED=false turns it off. Serverless deployments run no worker.
    // The restock sweep (ADR 0030) runs unless BIND_RESTOCK_SWEEP=false.
    if (config.BIND_WORKER_ENABLED !== "false") {
      worker = startWorker({ restockSweep: config.BIND_RESTOCK_SWEEP !== "false" });
      console.log("Background worker started.");
    }
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received: stopping the background worker.`);
    const stopped = worker ? worker.stop() : Promise.resolve();
    stopped
      .catch((err) => console.error("Worker did not stop cleanly:", err?.message ?? err))
      .finally(() => {
        server.close();
        process.exit(0);
      });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
