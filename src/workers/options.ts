import type { WorkerOptions } from "./runner.js";

/**
 * The worker's options from the environment (src/index.ts calls this, and tests call it too). The weekly analytics reports (ADR 0090)
 * run only when BIND_ANALYTICS_REPORTS is exactly "true"; the restock sweep (ADR 0030) only when BIND_RESTOCK_SWEEP is exactly "true".
 * Every other value, and an unset variable, leaves the job off.
 */
export function workerOptionsFromEnv(env: { BIND_RESTOCK_SWEEP?: string; BIND_ANALYTICS_REPORTS?: string }): WorkerOptions {
  return {
    restockSweep: env.BIND_RESTOCK_SWEEP === "true",
    analyticsReports: env.BIND_ANALYTICS_REPORTS === "true",
  };
}
