import { test, expect } from "@playwright/test";

/* The demo workspace (ADR 0057 backend, ADR 0063 UI) in a real browser against the real server. */

test("starting a demo opens the app with a banner on every page; Reset gives a fresh demo and the old key stops working", async ({ page, request }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start the demo" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  const banner = page.locator("#demo-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("This is a demo.");
  await expect(banner).toContainText(/Ends in [34] h/);
  // The demo was seeded by real workflows: Today shows the pending purchase.
  await expect(page.locator(".need").first()).toContainText("Simulated supplier");
  await page.goto("/app/activity");
  await expect(page.locator("#demo-banner")).toBeVisible();
  await page.goto("/app/team");
  await expect(page.locator("#demo-banner")).toBeVisible();

  const oldKey = await page.evaluate(() => sessionStorage.getItem("bind-access-key"));
  const oldMe = await request.get("/api/me", { headers: { Authorization: `Bearer ${oldKey}` } });
  const oldWs = (await oldMe.json()).workspaceId;
  await page.getByRole("button", { name: "Reset demo" }).click();
  await expect(page.locator("#demo-banner")).toBeVisible();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("bind-access-key"))).not.toBe(oldKey);
  expect((await request.get("/api/me", { headers: { Authorization: `Bearer ${oldKey}` } })).status()).toBe(401);
  const newKey = await page.evaluate(() => sessionStorage.getItem("bind-access-key"));
  const newMe = await (await request.get("/api/me", { headers: { Authorization: `Bearer ${newKey}` } })).json();
  expect(newMe.workspaceId).not.toBe(oldWs);
  await expect(page.getByRole("link", { name: "Make this yours" })).toHaveAttribute("href", "/start");
  expect(problems).toEqual([]);
});

test("a real workspace shows no demo banner", async ({ page, request }) => {
  const id = `ws-nodemo-${Date.now()}`;
  const res = await request.post("/api/workspaces", { data: { id, name: "Real Place", templateId: "kitchen-v1" } });
  const owner = (await res.json()).ownerToken.token as string;
  await page.goto("/app/sign-in");
  await page.getByLabel("Access key").fill(owner);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.locator(".panel").first()).toBeVisible();
  await expect(page.locator("#demo-banner")).toHaveCount(0);
});
