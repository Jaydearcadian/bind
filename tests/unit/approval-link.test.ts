import { describe, it, expect, vi, afterEach } from "vitest";

/** config is parsed when its module loads, so each case sets APP_BASE_URL and loads the module again. */
async function loadApprovalLink(baseUrl: string) {
  vi.stubEnv("APP_BASE_URL", baseUrl);
  vi.resetModules();
  const mod = await import("../../src/notifications/links.js");
  return mod.approvalLink;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("approvalLink", () => {
  it("builds a plain page link from the base url", async () => {
    const approvalLink = await loadApprovalLink("https://bind.example.com");

    expect(approvalLink("appr_wf_1")).toBe("https://bind.example.com/app/approvals/appr_wf_1");
  });

  it("strips a trailing slash from the base url", async () => {
    const approvalLink = await loadApprovalLink("https://bind.example.com///");

    expect(approvalLink("appr_wf_1")).toBe("https://bind.example.com/app/approvals/appr_wf_1");
  });

  it("encodes the approval id", async () => {
    const approvalLink = await loadApprovalLink("https://bind.example.com");

    expect(approvalLink("appr a/b?c=1")).toBe("https://bind.example.com/app/approvals/appr%20a%2Fb%3Fc%3D1");
  });
});
