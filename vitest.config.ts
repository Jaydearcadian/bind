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
    // Test-only value. The redaction tests need a configured secret to prove it never reaches stored text,
    // and a clean checkout has no .env.local. It is not used outside tests.
    env: { SESSION_SECRET: "test-only-session-secret-0123456789abcdef" },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
