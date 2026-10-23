/**
 * Demo workspace rules (docs/decisions/0057). Pure: no database, no HTTP, so every rule is unit-testable.
 *
 * A demo is a throwaway sandbox for a visitor: four hours, a fixed kitchen template, and only simulated behaviour. It is a
 * real workspace row with is_demo set and an expiry. The rules here are the ones code enforces for it, whatever the
 * environment asks for: SETTLEMENT_MODE, SUPPLIER_ADAPTER_MODE and the owner's own settings cannot make a demo use live
 * settlement or a live supplier.
 */

/** How long a demo lives after it is created or reset. */
export const DEMO_TTL_MS = 4 * 60 * 60 * 1000;

/** The default cap on demo workspaces that are active at once. Overridden by BIND_DEMO_MAX_ACTIVE or createApp. */
export const DEFAULT_DEMO_MAX_ACTIVE = 200;

/** The template every demo starts from. */
export const DEMO_TEMPLATE_ID = "kitchen-v1";
export const DEMO_WORKSPACE_NAME = "Demo kitchen (simulated)";
/** The label on a demo's owner token, so the token list says what it is. */
export const DEMO_OWNER_LABEL = "demo-owner";
/** The item the seed replenishment starts for: below par, and its order is above the owner approval threshold. */
export const DEMO_SEED_SKU = "FOOD-BUTTER-36LB";
/** The one settlement mode a demo ever uses. */
export const DEMO_SETTLEMENT_MODE = "local";

/** A demo id is `ws-demo-` and 16 lowercase hex characters. No underscore, so supplier ids can still be split on one. */
export const DEMO_ID_PATTERN = /^ws-demo-[0-9a-f]{16}$/;

/**
 * Whether the demo feature is on. An explicit BIND_DEMO_ENABLED decides. Unset, it is on outside production and off in
 * production (docs/decisions/0057).
 */
export function demoEnabled(input: { nodeEnv: string | undefined; flag: "true" | "false" | undefined }): boolean {
  if (input.flag === "true") return true;
  if (input.flag === "false") return false;
  return input.nodeEnv !== "production";
}

export function isDemoWorkspaceId(id: string): boolean {
  return DEMO_ID_PATTERN.test(id);
}

/** The settlement mode a workspace really uses. A demo is always local, whatever it stores. */
export function effectiveSettlementMode(workspace: { settlement_mode?: unknown; is_demo?: unknown }): string {
  if (workspace.is_demo === true) return DEMO_SETTLEMENT_MODE;
  return String(workspace.settlement_mode ?? "");
}

/** Raised when a demo would use something that is not simulated. The message names the rule, never a value. */
export class DemoSafetyError extends Error {
  readonly code = "DEMO_SUPPLIER_NOT_SIMULATED" as const;

  constructor(message = "Demo workspaces use simulated suppliers only.") {
    super(message);
    this.name = "DemoSafetyError";
  }
}

/** A demo workspace refuses a supplier adapter that is not simulated. A real workspace is not checked here. */
export function assertDemoAdapterSimulated(input: { isDemo: boolean; adapter: { isSimulated: boolean } }): void {
  if (input.isDemo && input.adapter.isSimulated !== true) throw new DemoSafetyError();
}
