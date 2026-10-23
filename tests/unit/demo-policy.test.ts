import { describe, it, expect } from "vitest";
import {
  DEMO_ID_PATTERN,
  DEMO_SETTLEMENT_MODE,
  DEMO_TTL_MS,
  DemoSafetyError,
  assertDemoAdapterSimulated,
  demoEnabled,
  effectiveSettlementMode,
  isDemoWorkspaceId,
} from "../../src/demo/policy.js";
import { childOfRoot } from "../../src/demo/purge.js";

/** The pure rules of demo workspaces (docs/decisions/0057). The database and HTTP sides are in tests/integration/demo.test.ts. */
describe("demo policy", () => {
  it("is four hours", () => {
    expect(DEMO_TTL_MS).toBe(4 * 60 * 60 * 1000);
  });

  it("is on outside production and off in production unless the flag says otherwise", () => {
    expect(demoEnabled({ nodeEnv: "development", flag: undefined })).toBe(true);
    expect(demoEnabled({ nodeEnv: "test", flag: undefined })).toBe(true);
    expect(demoEnabled({ nodeEnv: undefined, flag: undefined })).toBe(true);
    expect(demoEnabled({ nodeEnv: "production", flag: undefined })).toBe(false);
    expect(demoEnabled({ nodeEnv: "production", flag: "true" })).toBe(true);
    expect(demoEnabled({ nodeEnv: "development", flag: "false" })).toBe(false);
  });

  it("recognises only the demo id shape: ws-demo- and sixteen lowercase hex characters", () => {
    expect(DEMO_ID_PATTERN.test("ws-demo-0123456789abcdef")).toBe(true);
    expect(isDemoWorkspaceId("ws-demo-0123456789abcdef")).toBe(true);
    expect(isDemoWorkspaceId("ws-demo-0123456789ABCDEF")).toBe(false);
    expect(isDemoWorkspaceId("ws-demo-0123")).toBe(false);
    expect(isDemoWorkspaceId("ws_demo_0123456789abcdef")).toBe(false);
    expect(isDemoWorkspaceId("ws-kitchen-main")).toBe(false);
    expect(isDemoWorkspaceId("../ws-demo-0123456789abcdef")).toBe(false);
  });

  it("a demo always uses local settlement, whatever its row or the environment says", () => {
    expect(DEMO_SETTLEMENT_MODE).toBe("local");
    expect(effectiveSettlementMode({ is_demo: true, settlement_mode: "arc-testnet" })).toBe("local");
    expect(effectiveSettlementMode({ is_demo: true, settlement_mode: "local" })).toBe("local");
    expect(effectiveSettlementMode({ is_demo: true, settlement_mode: null })).toBe("local");
  });

  it("a real workspace keeps the mode it stores", () => {
    expect(effectiveSettlementMode({ is_demo: false, settlement_mode: "arc-testnet" })).toBe("arc-testnet");
    expect(effectiveSettlementMode({ is_demo: false, settlement_mode: "local" })).toBe("local");
    expect(effectiveSettlementMode({ settlement_mode: "arc-testnet" })).toBe("arc-testnet");
    expect(effectiveSettlementMode({})).toBe("");
  });

  it("a demo refuses an adapter that is not simulated, and a real workspace is not checked here", () => {
    expect(() => assertDemoAdapterSimulated({ isDemo: true, adapter: { isSimulated: false } })).toThrow(DemoSafetyError);
    expect(() => assertDemoAdapterSimulated({ isDemo: true, adapter: { isSimulated: true } })).not.toThrow();
    expect(() => assertDemoAdapterSimulated({ isDemo: false, adapter: { isSimulated: false } })).not.toThrow();
  });

  it("the path guard accepts a plain name under the root and refuses anything that could leave it", () => {
    const root = "/srv/artifacts/templates";
    expect(childOfRoot(root, "ws-demo-0123456789abcdef")).toBe("/srv/artifacts/templates/ws-demo-0123456789abcdef");
    expect(() => childOfRoot(root, "..")).toThrow();
    expect(() => childOfRoot(root, "../escape")).toThrow();
    expect(() => childOfRoot(root, "a/b")).toThrow();
    expect(() => childOfRoot(root, "a.b")).toThrow();
    expect(() => childOfRoot(root, "")).toThrow();
    expect(() => childOfRoot(root, "x".repeat(129))).toThrow();
  });
});
