import { test, expect } from "@playwright/test";

/*
 * The Privy bundle (ADR 0071) against the real server, which sends the real CSP (helmet: script-src 'self', no unsafe-eval).
 * The page loads the bundle with import(), the way the sign-in page will. Outbound requests to any other host are aborted;
 * the SDK's own calls may then fail, and that is expected. What this proves is that the bundle is served, loads under the
 * policy, and runs without a ReferenceError or a script CSP violation.
 */

// Same-origin module that imports the bundle. Injected with addScriptTag so the policy applies to the page, not to inline code.
const CHECK_MODULE = `
import { createPrivyAdapter } from "/app/vendor/privy.js";
const out = {};
try {
  const adapter = createPrivyAdapter({ appId: "cmtest000000000000000000" });
  out.methods = Object.keys(adapter).sort();
  out.token = await Promise.race([
    adapter.getAccessToken(),
    new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), 20000)),
  ]);
  out.absent = await adapter.finishOAuth("");
  out.refusal = await adapter.startGoogle("https://evil.example/return").then(() => "navigated", (e) => e.message);
  out.noWallet = await adapter.connectWallet(undefined).then(() => "signed in", (e) => e.message);
} catch (e) {
  out.error = String((e && e.message) || e);
}
window.__privyCheck = out;
`;

test("GET /app/vendor/privy.js is served as JavaScript", async ({ request }) => {
  const res = await request.get("/app/vendor/privy.js");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/javascript/);
});

test("the bundle loads and runs under the real CSP without a ReferenceError or script violation", async ({ page }) => {
  test.setTimeout(90000);
  const base = new URL(test.info().project.use.baseURL ?? "http://127.0.0.1:3210");
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));

  await page.addInitScript(() => {
    (window as unknown as { __csp: unknown[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: unknown[] }).__csp.push({ directive: e.effectiveDirective, blocked: e.blockedURI });
    });
  });
  // Only the server under test may answer. Anything else is aborted so no test reaches Privy's service.
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.origin === base.origin ? route.continue() : route.abort("blockedbyclient");
  });
  await page.route("**/app/__privy-check.js", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: CHECK_MODULE })
  );

  await page.goto("/app/sign-in");
  // Not addScriptTag: that awaits the script's load and would surface the connect-src refusal of the SDK's own call as an error.
  await page.evaluate(() => {
    const s = document.createElement("script");
    s.type = "module";
    s.src = "/app/__privy-check.js";
    document.head.append(s);
  });
  await page.waitForFunction(() => (window as unknown as { __privyCheck?: unknown }).__privyCheck !== undefined, undefined, {
    timeout: 60000,
  });

  const result = await page.evaluate(() => (window as unknown as { __privyCheck: Record<string, unknown> }).__privyCheck);
  const violations = await page.evaluate(() => (window as unknown as { __csp: { directive: string; blocked: string }[] }).__csp);

  expect(result.error, JSON.stringify(result)).toBeUndefined();
  expect(result.methods).toEqual(["connectWallet", "finishOAuth", "getAccessToken", "logout", "startGoogle"]);
  expect(result.absent).toBe(false);
  expect(result.refusal).toMatch(/on this site/);
  expect(result.noWallet).toMatch(/No wallet/);

  // No uncaught exception of any kind, and no ReferenceError among the logged errors.
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((t) => /ReferenceError|is not defined/.test(t))).toEqual([]);

  // Script policy: nothing refused for script-src, and no eval. (connect-src refusals for Privy's own calls are reported
  // below; they are the connect-src entry that ADR 0070 adds, and are not a script problem.)
  const scriptViolations = violations.filter((v) => /script-src|unsafe-eval/.test(v.directive));
  expect(scriptViolations).toEqual([]);
  const connectViolations = violations.filter((v) => /connect-src/.test(v.directive));
  // Evidence for the run log: what the SDK's own calls did in this browser.
  console.log(`privy-bundle: token=${String(result.token)} connect-src refusals=${connectViolations.length}`);
});
