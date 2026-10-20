import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/*
 * The app (ADR 0059) in a real browser against the real server and database. Each test makes its own workspace through the
 * public API, so tests do not share state. Approvals come from real replenishment workflows against simulated suppliers.
 */

const run = Date.now();
let seq = 0;

async function makeWorkspace(request: APIRequestContext) {
  const id = `ws-web-${run}-${++seq}`;
  const res = await request.post("/api/workspaces", { data: { id, name: `Test Kitchen ${seq}`, templateId: "kitchen-v1" } });
  expect(res.status(), await res.text()).toBe(201);
  const owner = (await res.json()).ownerToken.token as string;
  const staffRes = await request.post(`/api/workspaces/${id}/tokens`, { data: { role: "staff", label: "Sam" }, headers: { Authorization: `Bearer ${owner}` } });
  const staff = (await staffRes.json()).token as string;
  return { id, owner, staff };
}

/** A real pending approval: butter is below par and the order is over the approval threshold. */
async function pendingApproval(request: APIRequestContext, ws: { id: string; owner: string }) {
  const res = await request.post(`/api/workspaces/${ws.id}/replenish`, { data: { sku: "FOOD-BUTTER-36LB" }, headers: { Authorization: `Bearer ${ws.owner}` } });
  const body = await res.json();
  expect(body.state, JSON.stringify(body)).toBe("awaiting_approval");
  return body.approvalId as string;
}

async function signIn(page: Page, key: string, remember = false) {
  await page.goto("/app/sign-in");
  await page.getByLabel("Access key").fill(key);
  if (remember) await page.getByLabel("Remember this device").check();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
}

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(e.message));
  return problems;
}

test.describe("sign in", () => {
  test("refuses a malformed key without asking the server, and a wrong key after asking", async ({ page }) => {
    await page.goto("/app/sign-in");
    let asked = 0;
    page.on("request", (r) => r.url().includes("/api/me") && asked++);
    await page.getByLabel("Access key").fill("not-a-key");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("doesn't look like an access key");
    expect(asked).toBe(0);
    await page.getByLabel("Access key").fill(`bnd_${"Z".repeat(43)}`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("isn't valid");
    await expect(page.getByLabel("Access key")).toHaveAttribute("aria-invalid", "true");
  });

  test("without a key, Today sends you to sign in", async ({ page }) => {
    await page.goto("/app/");
    await expect(page).toHaveURL(/\/app\/sign-in$/);
  });
});

test.describe("Today", () => {
  test("an owner sees what needs them, with the reason, the amount and honest labels", async ({ page, request }) => {
    const problems = watch(page);
    const ws = await makeWorkspace(request);
    await pendingApproval(request, ws);
    await signIn(page, ws.owner);
    await expect(page.locator("#ws-name")).toHaveText(/Test Kitchen/);
    const need = page.locator(".need").first();
    await expect(need).toContainText("Buy 4 × European Unsalted Butter (36 lb)");
    await expect(need).toContainText("Waiting for you · over your $250.00 limit");
    await expect(need).toContainText("$392.00");
    await expect(need).toContainText("Simulated supplier");
    await expect(need).toContainText("Commits the business");
    await expect(page.locator("#needs-count")).toHaveText("1");
    // The feed is built from real events.
    await expect(page.locator(".feed-item").first()).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("the approval panel explains the decision, and holding Approve places the order only after the server confirms", async ({ page, request, isMobile }) => {
    const ws = await makeWorkspace(request);
    const approvalId = await pendingApproval(request, ws);
    await signIn(page, ws.owner);
    await page.locator(".need").first().click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toBeVisible();
    for (const text of ["Against your limits", "If you approve", "If you reject", "Expires", "Simulated supplier", "Commits the business"]) {
      await expect(sheet).toContainText(text);
    }
    await expect(sheet.locator("q.untrusted").first()).toContainText("Sysco");
    const approve = sheet.getByRole("button", { name: "Hold to approve" });
    // A tap does nothing: this amount needs a deliberate hold.
    await approve.click();
    await page.waitForTimeout(300);
    let row = await (await request.get(`/api/workspaces/${ws.id}/approvals/${approvalId}`, { headers: { Authorization: `Bearer ${ws.owner}` } })).json();
    expect(row.status).toBe("pending");
    if (isMobile) {
      await approve.focus();
      await page.keyboard.down("Enter");
      await page.waitForTimeout(1100);
      await page.keyboard.up("Enter");
    } else {
      const box = (await approve.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(1100);
      await page.mouse.up();
    }
    await expect(sheet.locator(".sheet-result")).toContainText(/Done\. The supplier confirmed the order\.|Sent\. Waiting for the supplier to confirm\./);
    row = await (await request.get(`/api/workspaces/${ws.id}/approvals/${approvalId}`, { headers: { Authorization: `Bearer ${ws.owner}` } })).json();
    expect(row.status).toBe("approved");
    await expect(page.locator("#needs-empty")).toBeVisible();
  });

  test("rejecting closes the request and buys nothing", async ({ page, request }) => {
    const ws = await makeWorkspace(request);
    const approvalId = await pendingApproval(request, ws);
    await signIn(page, ws.owner);
    await page.locator(".need").first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
    await expect(page.getByRole("dialog").locator(".sheet-result")).toContainText("Rejected. Nothing was bought.");
    const row = await (await request.get(`/api/workspaces/${ws.id}/approvals/${approvalId}`, { headers: { Authorization: `Bearer ${ws.owner}` } })).json();
    expect(row.status).toBe("rejected");
    const orders = await (await request.get(`/api/workspaces/${ws.id}/orders`, { headers: { Authorization: `Bearer ${ws.owner}` } })).json();
    expect(orders.filter((o: { item_sku: string }) => o.item_sku === "FOOD-BUTTER-36LB")).toHaveLength(0);
  });

  test("staff can follow an approval but not decide it, and cannot pause", async ({ page, request }) => {
    const ws = await makeWorkspace(request);
    await pendingApproval(request, ws);
    await signIn(page, ws.staff);
    await expect(page.locator("#pause-btn")).toBeHidden();
    await page.locator(".need").first().click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText("An owner decides this.");
    await expect(sheet.getByRole("button", { name: /approve/i })).toHaveCount(0);
    await expect(sheet.getByRole("button", { name: "Reject" })).toHaveCount(0);
  });

  test("pausing asks once, shows everywhere, and is what the server stored", async ({ page, request }) => {
    const ws = await makeWorkspace(request);
    await signIn(page, ws.owner);
    await page.locator("#pause-btn").click();
    await page.getByRole("dialog").getByRole("button", { name: "Pause all agents" }).click();
    await expect(page.locator("#paused-banner")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-paused", "");
    const wsRow = await (await request.get(`/api/workspaces/${ws.id}`, { headers: { Authorization: `Bearer ${ws.owner}` } })).json();
    expect(wsRow.workspace.agents_paused).toBe(true);
    await page.locator("#pause-btn").click();
    await expect(page.locator("#paused-banner")).toBeHidden();
  });

  test("when the server can't be reached, Today says so and keeps what it had", async ({ page, request }) => {
    const ws = await makeWorkspace(request);
    await pendingApproval(request, ws);
    await signIn(page, ws.owner);
    await expect(page.locator(".need")).toHaveCount(1);
    await page.route("**/api/**", (r) => r.abort());
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await page.waitForTimeout(300);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator("#stale-banner")).toBeVisible();
    await expect(page.locator(".need")).toHaveCount(1);
    await page.unroute("**/api/**");
    await page.getByRole("button", { name: "Refresh now" }).click();
    await expect(page.locator("#stale-banner")).toBeHidden();
  });

  test("signing out forgets the key", async ({ page, request }) => {
    const ws = await makeWorkspace(request);
    await signIn(page, ws.owner, true);
    await page.locator("#account-btn").click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/app\/sign-in$/);
    await page.goto("/app/");
    await expect(page).toHaveURL(/\/app\/sign-in$/);
  });
});

test.describe("Activity", () => {
  test("a day-by-day timeline from real events, with filters, and Follow this showing a work item's whole story", async ({ page, request }) => {
    const problems = watch(page);
    const ws = await makeWorkspace(request);
    await pendingApproval(request, ws);
    await signIn(page, ws.owner);
    await page.goto("/app/activity");
    await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    const items = page.locator(".timeline-item");
    await expect(items.first()).toBeVisible();
    await expect(page.locator(".feed-day").first()).toHaveText("Today");
    // The access key creation is an access event; the purchase filter hides it and shows the reorder.
    await page.getByRole("button", { name: "Purchases" }).click();
    await expect(page.getByRole("button", { name: "Purchases" })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".timeline-item", { hasText: "access key" })).toHaveCount(0);
    const reorder = page.locator(".timeline-item", { hasText: "proposed a reorder" }).first();
    await expect(reorder).toBeVisible();
    await reorder.getByRole("button", { name: "Follow this" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet).toContainText("Its whole story");
    await expect(sheet.locator(".fact", { hasText: "Now" })).toContainText("awaiting approval");
    await expect(sheet.locator(".thread .feed-item").first()).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("staff do not get the team and access filter", async ({ page, request }) => {
    const ws = await makeWorkspace(request);
    await signIn(page, ws.staff);
    await page.goto("/app/activity");
    await expect(page.getByRole("button", { name: "Purchases" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Team and access" })).toHaveCount(0);
  });
});
