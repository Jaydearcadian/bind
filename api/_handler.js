import { createApp } from "../dist/server/app.js";
import { runMigrations } from "../dist/db/migrate.js";
import { provisionDemoWorkspace } from "../dist/server/demo.js";
import { log } from "../dist/observability/logger.js";

// The hosted MCP module is built by `npm run mcp:build` (docs/decisions/0075). The import is literal, so the bundler traces it;
// if it is missing, /mcp answers 503 and the rest of the API is unaffected.
const app = createApp({ hostedMcp: { load: () => import("../mcp/dist/mcp/src/hosted.js") } });

let initPromise = null;

function ensureInit() {
  if (!initPromise) {
    initPromise = (async () => {
      await runMigrations();
      try {
        await provisionDemoWorkspace();
      } catch (err) {
        log.warn("demo.not_provisioned", { error: err });
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
    // The error is logged through the redacting logger: a driver message can carry a connection string (docs/decisions/0032).
    log.error("startup.initialization_failed", { error: err });
    // /mcp gets the same clear 503 as /api/ when initialisation fails (docs/decisions/0075, point 1), never a request served
    // against an unmigrated database.
    if (/^\/(api\/|mcp(\?|$))/.test(String(req.url || ""))) {
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
