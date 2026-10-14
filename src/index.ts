import { createApp } from "./server/app.js";
import { config } from "./config/env.js";
import { runMigrations } from "./db/migrate.js";
import { provisionWorkspace } from "./templates/registry.js";

async function main() {
  console.log("Starting Bind Business Agent Engine...");

  // Run database migrations on start
  await runMigrations();

  // Ensure default demo kitchen workspace exists
  try {
    await provisionWorkspace("ws-kitchen-main", "Chez Bind Kitchen & Bakery", "kitchen-v1");
    console.log("Demo Kitchen workspace 'ws-kitchen-main' ready.");
  } catch {
    console.warn("Notice: demo workspace already provisioned or skipped.");
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
