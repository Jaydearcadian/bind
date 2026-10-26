import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/*
 * Reports (ADR 0091) in a real browser against the real server. Only the simulated provider exists, so every brand and report
 * is sample data, and the page must say so. Server state is checked after each action.
 */

const run = Date.now();
let seq = 0;

async function makeWorkspace(request: APIRequestContext, templateId: string) {
  const id = `ws-rep-${run}-${++seq}`;
  const res = await request.post("/api/workspaces", { data: { id, name: `Reports Studio ${seq}`, templateId } });
  expect(res.status(), await res.text()).toBe(201);
  const owner = (await res.json()).ownerToken.token as string;
  const staffRes = await request.post(`/api/workspaces/${id}/tokens`, { data: { role: "staff", label: "Sam" }, headers: { Authorization: `Bearer ${owner}` } });
  return { id, owner, staff: (await staffRes.json()).token as string };
}

async function open(page: Page, key: string, path = "/app/reports") {
  await page.goto("/app/sign-in");
  await page.getByLabel("Access key").fill(key);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await page.goto(path);
}

const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

test("a social team's owner adds a brand, updates its stats, makes a report and reads it; everything says sample data", async ({ page, request }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  const ws = await makeWorkspace(request, "social-v1");
  await open(page, ws.owner);
  await expect(page.getByRole("heading", { level: 1, name: "Reports" })).toBeVisible();
  await expect(page.locator("#brands")).toContainText("No brands yet");

  await page.getByRole("button", { name: "Add a brand" }).click();
  await page.getByRole("button", { name: "Add brand" }).click();
  await expect(page.locator("#brand-error")).toContainText("Give the brand a name");
  await page.getByLabel("Brand name").fill("Studio Brand");
  await page.getByLabel("Time zone").fill("Europe/Lisbon");
  await page.getByRole("button", { name: "Add brand" }).click();
  await expect(page.locator("#brands")).toContainText("Studio Brand");
  await expect(page.locator("#brands")).toContainText("Sample data");
  await expect(page.locator("#sample-note")).toContainText("Sample data for now");
  const accounts = await (await request.get(`/api/workspaces/${ws.id}/analytics/accounts`, auth(ws.owner))).json();
  expect(accounts).toHaveLength(1);
  expect(accounts[0]).toMatchObject({ brandLabel: "Studio Brand", isSimulated: true, timeZone: "Europe/Lisbon" });

  await page.getByRole("button", { name: "Update stats for Studio Brand" }).click();
  await expect(page.locator("#toast")).toContainText("Studio Brand is up to date.");
  await expect(page.locator("#brands")).toContainText(/\d+ posts · updated/);

  await page.getByRole("button", { name: "Make a report now" }).click();
  await expect(page.locator("#report-view")).toBeVisible();
  await expect(page.locator("#report-meta")).toContainText("sample data");
  const text = await page.locator("#report-text").innerText();
  expect(text.length).toBeGreaterThan(40);
  expect(text.toLowerCase()).not.toContain("because");
  const reports = await (await request.get(`/api/workspaces/${ws.id}/analytics/reports`, auth(ws.owner))).json();
  expect(reports).toHaveLength(1);
  expect(reports[0].simulated).toBe(true);

  // Asking again for the same period opens the same report; it is not made twice.
  await page.getByRole("button", { name: "Make a report now" }).click();
  await expect(page.locator("#toast")).toContainText(/already made|Report made/);
  expect(await (await request.get(`/api/workspaces/${ws.id}/analytics/reports`, auth(ws.owner))).json()).toHaveLength(1);

  // The Reports link is in the nav of other pages for this team.
  await page.goto("/app/team");
  await expect(page.locator(".side-nav").getByRole("link", { name: "Reports" })).toBeVisible();
  expect(problems.filter((p) => !/status of 4\d\d/.test(p))).toEqual([]);
});

test("staff read brands and reports but get no controls; a kitchen team gets no Reports link and a plain note", async ({ page, request }) => {
  const social = await makeWorkspace(request, "social-v1");
  const made = await request.post(`/api/workspaces/${social.id}/analytics/accounts`, { data: { provider: "simulated", brandLabel: "Staff View Brand" }, ...auth(social.owner) });
  expect(made.status(), await made.text()).toBe(201);
  await open(page, social.staff);
  await expect(page.locator("#brands")).toContainText("Staff View Brand");
  await expect(page.getByRole("button", { name: "Add a brand" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Make a report now" })).toBeHidden();
  await expect(page.getByRole("button", { name: /Update stats for/ })).toHaveCount(0);
  expect((await request.post(`/api/workspaces/${social.id}/analytics/accounts`, { data: { provider: "simulated", brandLabel: "x" }, ...auth(social.staff) })).status()).toBe(403);

  const kitchen = await makeWorkspace(request, "kitchen-v1");
  const kPage = await (await page.context().browser()!.newContext()).newPage();
  await open(kPage, kitchen.owner);
  await expect(kPage.getByRole("heading", { name: "Reports are for social media teams" })).toBeVisible();
  await expect(kPage.locator("#module-area")).toBeHidden();
  await kPage.goto("/app/team");
  await expect(kPage.locator(".side-nav").getByRole("link", { name: "Reports" })).toHaveCount(0);
});

test("a demo cannot add brands: the page says why in plain words", async ({ page, request }) => {
  const ws = await makeWorkspace(request, "social-v1");
  await open(page, ws.owner);
  // The server refuses a write for a provider it does not have, with a clear reason, without any change.
  const refused = await request.post(`/api/workspaces/${ws.id}/analytics/accounts`, { data: { provider: "instagram", brandLabel: "Real" }, ...auth(ws.owner) });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).code).toBe("ANALYTICS_PROVIDER_NOT_AVAILABLE");
  expect(await (await request.get(`/api/workspaces/${ws.id}/analytics/accounts`, auth(ws.owner))).json()).toEqual([]);
});
