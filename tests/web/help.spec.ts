import { test, expect, type APIRequestContext } from "@playwright/test";

/* Help (ADR 0068) and the finished app navigation in a real browser. */

const run = Date.now();
let seq = 0;

async function signIn(page: import("@playwright/test").Page, request: APIRequestContext) {
  const id = `ws-help-${run}-${++seq}`;
  const res = await request.post("/api/workspaces", { data: { id, name: `Help Kitchen ${seq}`, templateId: "kitchen-v1" } });
  const owner = (await res.json()).ownerToken.token as string;
  await page.goto("/app/sign-in");
  await page.getByLabel("Access key").fill(owner);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
}

test("help is searchable, opens a single match, says when nothing matches, and deep links open an answer", async ({ page, request }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  await signIn(page, request);
  await page.goto("/app/help");
  await expect(page.getByRole("heading", { level: 1, name: "Help" })).toBeVisible();
  const items = page.locator(".help-item");
  expect(await items.count()).toBeGreaterThan(8);
  await page.getByLabel("Search help").fill("pause");
  await expect(page.locator("#help-hits")).toContainText("answer");
  await page.getByLabel("Search help").fill("stop everything");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toHaveAttribute("open", "");
  await page.getByLabel("Search help").fill("qqqqzz");
  await expect(items).toHaveCount(0);
  await expect(page.locator("#help-hits")).toContainText('No answers mention "qqqqzz"');

  await page.goto("/app/help#verified");
  await expect(page.locator("#verified")).toHaveAttribute("open", "");
  await expect(page.locator("#verified")).toContainText("not a live test");
  await page.locator("#verified").getByRole("link", { name: "Open Connections" }).click();
  await expect(page).toHaveURL(/\/app\/connections$/);
  expect(problems).toEqual([]);
});

test("every app area is a working link now, on desktop and in the phone menu", async ({ page, request }) => {
  await signIn(page, request);
  const areas: Array<[string, RegExp, string]> = [
    ["Activity", /\/app\/activity$/, "Activity"],
    ["Team and limits", /\/app\/team$/, "Team and limits"],
    ["Connections", /\/app\/connections$/, "Connections"],
    ["Business data", /\/app\/data/, "Business data"],
    ["People", /\/app\/people$/, "People and access"],
    ["Settings", /\/app\/settings$/, "Settings"],
    ["Help", /\/app\/help$/, "Help"],
  ];
  const phone = (page.viewportSize()?.width ?? 1280) < 861;
  for (const [name, url, heading] of areas) {
    if (phone) {
      const tab = page.locator(".tab-bar").getByRole("link", { name: name === "Team and limits" ? "Team" : name, exact: true });
      if (await tab.count()) await tab.click();
      else {
        await page.getByRole("button", { name: "More" }).click();
        await page.locator("#more-menu").getByRole("link", { name: name === "People" ? "People and access" : name }).click();
      }
    } else {
      await page.locator(".side-nav").getByRole("link", { name, exact: true }).click();
    }
    await expect(page).toHaveURL(url);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }
  await expect(page.locator(".is-soon")).toHaveCount(0);
});
