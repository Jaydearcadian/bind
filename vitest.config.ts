import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 15000,
    // Integration files share one PostgreSQL database and some change shared schema state
    // (tests/integration/three-way-match-migration.test.ts drops and recreates a unique index).
    // Running files one at a time keeps those tests from interfering with each other. See docs/decisions/0010.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
