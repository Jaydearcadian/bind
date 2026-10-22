import { describe, it, expect } from "vitest";
import { parsePublicOrigin, resolvePublicOrigin } from "../../src/server/mcp-route.js";
import { isVisibleToRole } from "../../src/api/events.js";

/** The public origin the hosted MCP endpoint uses (docs/decisions/0075, point 7): the precedence and the warnings. */
describe("the hosted endpoint's public origin", () => {
  it("accepts an https origin, or http for a loopback host only, and nothing with a path, query or credentials", () => {
    expect(parsePublicOrigin("https://bind.example")).toBe("https://bind.example");
    expect(parsePublicOrigin("https://bind.example/")).toBe("https://bind.example");
    expect(parsePublicOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(parsePublicOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(parsePublicOrigin("http://bind.example")).toBeNull();
    expect(parsePublicOrigin("https://bind.example/app")).toBeNull();
    expect(parsePublicOrigin("https://bind.example?x=1")).toBeNull();
    expect(parsePublicOrigin("https://user:pw@bind.example")).toBeNull();
    expect(parsePublicOrigin("not a url")).toBeNull();
  });

  it("BIND_PUBLIC_URL wins over APP_BASE_URL, and is an error when it is not an origin", () => {
    const both = resolvePublicOrigin({ publicUrl: "https://bind.example", explicitAppBaseUrl: "https://app.example", nodeEnv: "production" });
    expect(both).toEqual({ origin: "https://bind.example", warning: null });
    expect(() => resolvePublicOrigin({ publicUrl: "http://bind.example", explicitAppBaseUrl: null, nodeEnv: "production" })).toThrow(
      /BIND_PUBLIC_URL/
    );
  });

  it("an explicitly set APP_BASE_URL is used when BIND_PUBLIC_URL is unset, so one setting is enough", () => {
    expect(resolvePublicOrigin({ publicUrl: null, explicitAppBaseUrl: "https://app.example/", nodeEnv: "production" })).toEqual({
      origin: "https://app.example",
      warning: null,
    });
  });

  it("an APP_BASE_URL that is not an https origin is not used, and the warning names APP_BASE_URL and BIND_PUBLIC_URL", () => {
    const result = resolvePublicOrigin({ publicUrl: null, explicitAppBaseUrl: "http://app.example", nodeEnv: "production" });
    expect(result.origin).toBeNull();
    expect(result.warning).toMatch(/APP_BASE_URL/);
    expect(result.warning).toMatch(/BIND_PUBLIC_URL/);
  });

  it("with neither set, production gets one warning naming BIND_PUBLIC_URL, and other environments get none", () => {
    const production = resolvePublicOrigin({ publicUrl: null, explicitAppBaseUrl: null, nodeEnv: "production" });
    expect(production.origin).toBeNull();
    expect(production.warning).toMatch(/BIND_PUBLIC_URL/);
    expect(resolvePublicOrigin({ publicUrl: null, explicitAppBaseUrl: null, nodeEnv: "development" })).toEqual({ origin: null, warning: null });
    expect(resolvePublicOrigin({ publicUrl: null, explicitAppBaseUrl: null, nodeEnv: "test" })).toEqual({ origin: null, warning: null });
  });

  it("agent.tool_called is staff-visible, as notification events are: only auth., connector. and kitchen_capacity. are owner-only", () => {
    expect(isVisibleToRole("staff", "agent.tool_called")).toBe(true);
    expect(isVisibleToRole("owner", "agent.tool_called")).toBe(true);
    expect(isVisibleToRole("staff", "auth.token_issued")).toBe(false);
  });
});
