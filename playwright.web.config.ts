import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * The website's browser suite (ADR 0054): `npm run test:e2e`. It starts the real server on its own port against the local
 * database and drives the pages in Chromium at desktop and phone sizes. The legacy suite for the orphaned UI keeps
 * playwright.config.ts and `npm run test:e2e:legacy`.
 */
const PORT = Number(process.env.BIND_WEB_TEST_PORT ?? 3210);
// A preinstalled Chromium is used when present (some sandboxes ship one and forbid downloads); otherwise Playwright's own.
const PREINSTALLED = "/opt/pw-browsers/chromium";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? (existsSync(PREINSTALLED) ? PREINSTALLED : undefined);

export default defineConfig({
  testDir: "./tests/web",
  timeout: 30000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 860 } } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npx tsx src/index.ts",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 60000,
    env: { PORT: String(PORT), BIND_WORKER_ENABLED: "false", BIND_RATE_LIMITS: "off", LOG_LEVEL: "warn" },
  },
});
