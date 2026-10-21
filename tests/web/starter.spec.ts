import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/* "Getting started" on Today (ADR 0069): steps ticked from server state, the owner's own tick for limits, hide, staff and demo. */

const run = Date.now();
let seq = 0;

async function makeWorkspace(request: APIRequestContext) {
  const id = `ws-start-${run}-${++seq}`;
  const res = await request.post("/api/workspaces", { data: { id, name: `Starter Kitchen ${seq}`, templateId: "kitchen-v1" } });
  expect(res.status(), await res.text()).toBe(201);
  const owner = (await res.json()).ownerToken.token as string;
  const staffRes = await request.post(`/api/workspaces/${id}/tokens`, { data: { role: "staff", label: "Sam" }, headers: { Authorization: `Bearer ${owner}` } });
  return { id, owner, staff: (await staffRes.json()).token as string };
}

async function signIn(page: Page, key: string) {
  await page.goto("/app/sign-in");
  await page.getByLabel("Access key").fill(key);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
}

const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

test("steps tick from what the server holds, limits take the owner's own tick, and the list goes when all are done", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await signIn(page, ws.owner);
  const starter = page.locator("#starter");
  await expect(starter).toBeVisible();
  await expect(starter).toContainText("0 of 4 done");

  await request.post(`/api/workspaces/${ws.id}/invites`, { data: { label: "Priya" }, ...auth(ws.owner) });
  await request.post(`/api/workspaces/${ws.id}/suppliers`, { data: { id: "harbor", name: "Harbor Produce", adapterType: "manual_quote", verified: true, isSimulated: false }, ...auth(ws.owner) });
  await page.reload();
  await expect(starter).toContainText("2 of 4 done");
  await expect(starter.locator(".starter-step.is-done")).toHaveCount(2);

  await page.getByRole("button", { name: 'Mark "Look over your limits" as done' }).click();
  await expect(starter).toContainText("3 of 4 done");
  await page.reload();
  await expect(starter).toContainText("3 of 4 done");

  const put = await request.put(`/api/workspaces/${ws.id}/connectors/accounting`, { data: { kind: "accounting", secret: "abc123456789" }, ...auth(ws.owner) });
  expect(put.status(), await put.text()).toBe(200);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  await expect(page.locator(".need, .empty").first()).toBeVisible();
  await expect(starter).toBeHidden();
});

test("an owner can hide the list; staff and demos never see it", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await signIn(page, ws.owner);
  await expect(page.locator("#starter")).toBeVisible();
  await page.getByRole("button", { name: "Hide this list" }).click();
  await expect(page.locator("#starter")).toBeHidden();
  await page.reload();
  await expect(page.locator(".need, .empty").first()).toBeVisible();
  await expect(page.locator("#starter")).toBeHidden();

  await page.evaluate(() => sessionStorage.clear());
  await signIn(page, ws.staff);
  await expect(page.locator(".need, .empty").first()).toBeVisible();
  await expect(page.locator("#starter")).toBeHidden();

  await page.goto("/demo");
  await page.getByRole("button", { name: "Start the demo" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.locator("#demo-banner")).toBeVisible();
  await expect(page.locator("#starter")).toBeHidden();
});
