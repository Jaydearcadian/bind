import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/* Settings (ADR 0067) in a real browser against the real server; every key and secret change is checked on the server too. */

const run = Date.now();
let seq = 0;

async function makeWorkspace(request: APIRequestContext) {
  const id = `ws-set-${run}-${++seq}`;
  const res = await request.post("/api/workspaces", { data: { id, name: `Settings Kitchen ${seq}`, templateId: "kitchen-v1" } });
  expect(res.status(), await res.text()).toBe(201);
  const owner = (await res.json()).ownerToken.token as string;
  const staffRes = await request.post(`/api/workspaces/${id}/tokens`, { data: { role: "staff", label: "Sam" }, headers: { Authorization: `Bearer ${owner}` } });
  return { id, owner, staff: (await staffRes.json()).token as string };
}

async function open(page: Page, key: string) {
  await page.goto("/app/sign-in");
  await page.getByLabel("Access key").fill(key);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await page.goto("/app/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
}

const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

test("appearance is kept on this device, applies before paint on other pages, and can follow the device again", async ({ page, request }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  const ws = await makeWorkspace(request);
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, ws.owner);
  await expect(page.getByLabel(/Follow this device/)).toBeChecked();
  await expect(page.locator("#ws-facts")).toContainText(`Settings Kitchen ${seq}`);
  await expect(page.locator("#ws-facts")).toContainText("Owner");
  const bgLight = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await page.getByLabel("Dark", { exact: true }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(bgLight);
  await page.goto("/app/activity");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.goto("/app/settings");
  await page.getByLabel(/Follow this device/).check();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  expect(await page.evaluate(() => localStorage.getItem("bind-theme"))).toBeNull();
  expect(problems).toEqual([]);
});

test("an owner makes a key shown once that really works, removes it, and the last owner key is protected", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await open(page, ws.owner);
  await expect(page.locator("#keys")).toContainText("Sam");
  await page.getByRole("button", { name: "Make a key" }).click();
  await expect(page.locator("#key-error")).toContainText("Say what it's for");
  await page.getByLabel("What is this key for?").fill("Inventory sync");
  await page.getByRole("button", { name: "Make a key" }).click();
  const field = page.getByLabel("New access key");
  await expect(field).toHaveValue(/^bnd_[A-Za-z0-9_-]{43}$/);
  const made = await field.inputValue();
  // The key works, as staff (the default), and the list never carries it.
  const me = await (await request.get("/api/me", auth(made))).json();
  expect(me).toMatchObject({ workspaceId: ws.id, role: "staff", label: "Inventory sync" });
  const tokens = await (await request.get(`/api/workspaces/${ws.id}/tokens`, auth(ws.owner))).json();
  expect(JSON.stringify(tokens)).not.toContain(made);
  await page.getByRole("button", { name: "Done" }).click();
  expect(await page.locator("#key-value").inputValue()).toBe("");
  await expect(page.locator("#keys")).toContainText("Inventory sync");

  await page.getByRole("button", { name: "Remove the key Inventory sync" }).click();
  await page.getByRole("button", { name: "Keep it" }).click();
  expect((await request.get("/api/me", auth(made))).status()).toBe(200);
  await page.getByRole("button", { name: "Remove the key Inventory sync" }).click();
  await page.locator("#confirm-go").click();
  await expect(page.locator("#toast")).toContainText('The key "Inventory sync" was removed.');
  expect((await request.get("/api/me", auth(made))).status()).toBe(401);

  // This browser's key is the only owner key: the server refuses, and the page says why in plain words.
  const ownerTok = tokens.find((t: { role: string }) => t.role === "owner");
  await expect(page.locator("#keys li", { hasText: ownerTok.label }).locator(".status")).toHaveText("This browser");
  await page.getByRole("button", { name: `Remove the key ${ownerTok.label}` }).click();
  await expect(page.locator("#confirm-text")).toContainText("signs you out here");
  await page.locator("#confirm-go").click();
  await expect(page.locator("#confirm-error")).toContainText("last owner key");
  expect((await request.get("/api/me", auth(ws.owner))).status()).toBe(200);
});

test("the signing secret is shown on request, hidden again, and replacing it changes it on the server", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await open(page, ws.owner);
  await expect(page.locator("#secret-row")).toBeHidden();
  await page.getByRole("button", { name: "Show secret" }).click();
  const before = (await (await request.get(`/api/workspaces/${ws.id}/webhook-secret`, auth(ws.owner))).json()).secret;
  await expect(page.getByLabel("Signing secret", { exact: true })).toHaveValue(before);
  await page.getByRole("button", { name: "Hide secret" }).click();
  await expect(page.locator("#secret-row")).toBeHidden();
  expect(await page.locator("#secret-value").inputValue()).toBe("");

  await page.getByRole("button", { name: "Replace secret" }).click();
  await page.locator("#confirm-go").click();
  await expect(page.locator("#toast")).toContainText("Replaced.");
  const after = (await (await request.get(`/api/workspaces/${ws.id}/webhook-secret`, auth(ws.owner))).json()).secret;
  expect(after).not.toBe(before);
  await expect(page.getByLabel("Signing secret", { exact: true })).toHaveValue(after);
});

test("staff see their settings but not keys or secrets, and coming features say so instead of offering switches", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await open(page, ws.staff);
  await expect(page.locator("#builders-staff")).toBeVisible();
  await expect(page.locator("#builders-owner")).toBeHidden();
  await expect(page.locator("#signin-now")).toHaveText("Signed in with an access key");
  await expect(page.locator(".danger .status")).toHaveText(["Coming", "Coming", "Coming"]);
  await expect(page.locator("main input[type=checkbox]")).toHaveCount(0);
  expect((await request.get(`/api/workspaces/${ws.id}/tokens`, auth(ws.staff))).status()).toBe(403);
  expect((await request.get(`/api/workspaces/${ws.id}/webhook-secret`, auth(ws.staff))).status()).toBe(403);
});

test("email notices: off says so plainly where the server has no email; owners only", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await open(page, ws.owner);
  await expect(page.locator("#email-sub")).toContainText("Not switched on");
  await expect(page.locator("#email-box")).toBeHidden();
  const staffPage = await (await page.context().browser()!.newContext()).newPage();
  await open(staffPage, ws.staff);
  await expect(staffPage.locator("#email-sub")).toContainText("Owners get an email");
  await expect(staffPage.locator("#email-box")).toBeHidden();
});

test("email notices: add an address, a wrong code is explained, the right code verifies, removing it stops notices", async ({ page, request }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && !/status of 400/.test(m.text()) && problems.push(m.text()));
  const ws = await makeWorkspace(request);
  // The test server has no email provider, so the page is told delivery is on and the four email routes are a small fake.
  let emails: Array<Record<string, unknown>> = [];
  await page.route(`**/api/workspaces/${ws.id}/notifications**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "GET") return route.fulfill({ json: { emailDelivery: "on", emails } });
    if (req.method() === "POST" && url.pathname.endsWith("/email")) {
      emails = [{ id: "oe_1", email: "m***@kitchen.test", status: "pending", expiresAt: new Date(Date.now() + 600000).toISOString(), verifiedAt: null, attemptsRemaining: 5, createdAt: new Date().toISOString() }];
      return route.fulfill({ status: 201, json: emails[0] });
    }
    if (req.method() === "POST" && url.pathname.endsWith("/verify")) {
      const body = req.postDataJSON();
      if (body.code !== "123456") return route.fulfill({ status: 400, json: { error: "That code is wrong. 4 attempts left.", code: "EMAIL_CODE_INVALID" } });
      emails = [{ ...emails[0], status: "verified", verifiedAt: new Date().toISOString() }];
      return route.fulfill({ json: emails[0] });
    }
    if (req.method() === "DELETE") {
      emails = [];
      return route.fulfill({ json: { removed: true } });
    }
    return route.continue();
  });
  await open(page, ws.owner);
  await expect(page.locator("#email-status")).toHaveText("Off");
  await page.getByRole("button", { name: "Add an address" }).click();
  await page.getByRole("button", { name: "Send the code" }).click();
  await expect(page.locator("#email-error")).toContainText("Type your email address");
  await page.getByLabel("Where should we email you?").fill("owner@kitchen.test");
  await page.getByRole("button", { name: "Send the code" }).click();
  await expect(page.getByText("Waiting for the code")).toBeVisible();

  await page.getByLabel(/Code sent to/).fill("12");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("Type the 6 digits")).toBeVisible();
  await page.getByLabel(/Code sent to/).fill("000000");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.getByText("That code is wrong. 4 attempts left.")).toBeVisible();
  await page.getByLabel(/Code sent to/).fill("123456");
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page.locator("#email-status")).toHaveText("On");
  await expect(page.locator("#email-list")).toContainText("Verified");

  await page.getByRole("button", { name: /^Remove m\*\*\*@kitchen.test/ }).click();
  await expect(page.locator("#email-status")).toHaveText("Off");
  expect(problems).toEqual([]);
});
