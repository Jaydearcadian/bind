import { describe, it, expect } from "vitest";
import { workerOptionsFromEnv } from "../../src/workers/options.js";

/**
 * The entry point starts the worker with these options (src/index.ts). The weekly analytics reports (docs/decisions/0090) run only
 * when BIND_ANALYTICS_REPORTS is exactly "true". Anything else, and an unset variable, leaves them off.
 */
describe("the worker's options from the environment", () => {
  it("turns the analytics reports on only for the exact value true", () => {
    expect(workerOptionsFromEnv({ BIND_ANALYTICS_REPORTS: "true" }).analyticsReports).toBe(true);
    for (const value of ["TRUE", "True", "1", "yes", "", " true", "false", "on"]) {
      expect(workerOptionsFromEnv({ BIND_ANALYTICS_REPORTS: value }).analyticsReports, JSON.stringify(value)).toBe(false);
    }
    expect(workerOptionsFromEnv({}).analyticsReports).toBe(false);
  });

  it("leaves the restock sweep as it was: on only for the exact value true", () => {
    expect(workerOptionsFromEnv({ BIND_RESTOCK_SWEEP: "true" }).restockSweep).toBe(true);
    expect(workerOptionsFromEnv({ BIND_RESTOCK_SWEEP: "1" }).restockSweep).toBe(false);
    expect(workerOptionsFromEnv({}).restockSweep).toBe(false);
  });

  it("the two switches are independent", () => {
    const only = workerOptionsFromEnv({ BIND_ANALYTICS_REPORTS: "true" });
    expect(only).toMatchObject({ restockSweep: false, analyticsReports: true });
  });
});
