import { describe, it, expect, vi, afterEach } from "vitest";

/** config is parsed when its module loads, so each case sets APP_BASE_URL and loads the module again. */
async function loadCustomerOrderLink(baseUrl: string) {
  vi.stubEnv("APP_BASE_URL", baseUrl);
  vi.resetModules();
  const mod = await import("../../src/notifications/links.js");
  return mod.customerOrderLink;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("customerOrderLink", () => {
  it("builds a plain page link from the base url", async () => {
    const customerOrderLink = await loadCustomerOrderLink("https://bind.example.com");

    expect(customerOrderLink("cord_1")).toBe("https://bind.example.com/app/customer-orders/cord_1");
  });

  it("strips a trailing slash from the base url", async () => {
    const customerOrderLink = await loadCustomerOrderLink("https://bind.example.com///");

    expect(customerOrderLink("cord_1")).toBe("https://bind.example.com/app/customer-orders/cord_1");
  });

  it("encodes the order id and carries no token or query string", async () => {
    const customerOrderLink = await loadCustomerOrderLink("https://bind.example.com");

    const link = customerOrderLink("cord a/b?token=1");

    expect(link).toBe("https://bind.example.com/app/customer-orders/cord%20a%2Fb%3Ftoken%3D1");
    expect(link).not.toContain("?");
  });
});
