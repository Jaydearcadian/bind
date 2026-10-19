import { provisionWorkspace } from "../templates/registry.js";
import { ensureSecretOwnerToken } from "../auth/tokens.js";
import { config } from "../config/env.js";

export const DEMO_WORKSPACE_ID = "ws-kitchen-main";

/**
 * Ensures the demo kitchen exists. An existing demo workspace is left untouched, so an owner's policy survives a
 * restart. When BIND_DEMO_OWNER_TOKEN is set, its hash is stored as an owner token of the demo workspace (ADR 0021).
 */
export async function provisionDemoWorkspace(): Promise<void> {
  await provisionWorkspace(DEMO_WORKSPACE_ID, "Chez Bind Kitchen & Bakery", "kitchen-v1", { ifAbsent: true });
  if (config.BIND_DEMO_OWNER_TOKEN) {
    await ensureSecretOwnerToken(DEMO_WORKSPACE_ID, config.BIND_DEMO_OWNER_TOKEN, "demo");
  }
}
