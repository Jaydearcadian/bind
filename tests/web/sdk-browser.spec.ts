import { test, expect, type Page } from "@playwright/test";

/*
 * The typed SDK imported by a page in a real browser, under the website's strict policy (ADR 0056). The page is the real
 * website served by the real server; the module is the real compiled SDK at /sdk/index.js; the call goes over the network.
 * Console errors, failed requests, HTTP errors and Content Security Policy violations fail the test.
 */

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("requestfailed", (r) => problems.push(`request failed: ${r.url()}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  return problems;
}

test.describe("the SDK in the browser (ADR 0056)", () => {
  test("a page imports /sdk/index.js, makes a real call, and reports no errors or policy violations", async ({ page }) => {
    const problems = watch(page);
    // Recorded before any page script runs, so a violation during the import is not missed.
    await page.addInitScript(() => {
      const violations: string[] = [];
      Object.defineProperty(window, "__cspViolations", { value: violations });
      document.addEventListener("securitypolicyviolation", (e) => violations.push(`${e.violatedDirective}: ${e.blockedURI}`));
    });

    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    expect(res?.headers()["content-security-policy"]).toContain("script-src 'self'");

    const outcome = await page.evaluate(async () => {
      // A variable, not a literal: the browser resolves the URL at run time and TypeScript has no module to check.
      const moduleUrl = "/sdk/index.js";
      const sdk = await import(moduleUrl);
      const client = new sdk.BindClient({ baseUrl: location.origin, token: "bnd_" + "A".repeat(43) });
      const templates: unknown = await client.call("listTemplates");
      return {
        exports: Object.keys(sdk).sort(),
        isClient: client instanceof sdk.BindClient,
        templates,
        violations: (window as unknown as { __cspViolations: string[] }).__cspViolations,
      };
    });

    expect(outcome.exports).toEqual(expect.arrayContaining(["BindClient", "BindApiError", "BindNetworkError", "OPERATIONS"]));
    expect(outcome.isClient).toBe(true);
    expect(Array.isArray(outcome.templates)).toBe(true);
    expect((outcome.templates as Array<{ id?: unknown }>).length).toBeGreaterThan(0);
    expect(typeof (outcome.templates as Array<{ templateId?: unknown }>)[0].templateId).toBe("string");
    expect(outcome.violations).toEqual([]);
    expect(problems).toEqual([]);
  });

  test("the SDK's JavaScript is served as JavaScript, cached like the other assets", async ({ page }) => {
    const res = await page.request.get("/sdk/index.js");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^(text|application)\/javascript/);
    expect(res.headers()["cache-control"]).toBe("public, max-age=300");
    expect(await res.text()).toContain("BindClient");
  });
});
