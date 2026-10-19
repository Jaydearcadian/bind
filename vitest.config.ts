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
    // Test-only webhook secrets (ADR 0022). Not used outside tests. Fixed values, so tests can derive signatures.
    env: {
      SESSION_SECRET: "test-only-session-secret-0123456789abcdef",
      BIND_MASTER_SECRET: "test-only-master-secret-0123456789abcdef0123456789",
      BIND_WEBHOOK_SECRET: "test-only-webhook-secret-0123456789abcdef0123456789",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
