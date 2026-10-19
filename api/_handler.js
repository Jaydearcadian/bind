import { createApp } from "../dist/server/app.js";
import { runMigrations } from "../dist/db/migrate.js";
import { provisionDemoWorkspace } from "../dist/server/demo.js";

const app = createApp();

let initPromise = null;

function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      await runMigrations();
      try {
        await provisionDemoWorkspace();
      } catch (err) {
        console.warn("Demo workspace could not be provisioned:", err?.message);
      }
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export default async function handler(req, res) {
  try {
    await ensureInit();
  } catch (err) {
    console.error("Startup initialization failed:", err);
    if (String(req.url || "").startsWith("/api/")) {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          error: "SERVICE_INITIALIZATION_FAILED",
          message: "The database is not reachable or migrations failed.",
        })
      );
      return;
    }
  }
  return app(req, res);
}
