import { createApp } from "./server/app.js";
import { config } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { provisionDemoWorkspace } from "./server/demo.js";

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

  app.listen(port, () => {
    console.log(`Bind Server listening on http://127.0.0.1:${port}`);
    console.log(`Web Dashboard available at http://127.0.0.1:${port}`);
  });
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
