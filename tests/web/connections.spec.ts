import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/* Connections (ADR 0065) in a real browser against the real server; every change is checked on the server too. */

const run = Date.now();
let seq = 0;

async function makeWorkspace(request: APIRequestContext) {
  const id = `ws-conn-${run}-${++seq}`;
  const res = await request.post("/api/workspaces", { data: { id, name: `Connections Kitchen ${seq}`, templateId: "kitchen-v1" } });
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
  await page.goto("/app/connections");
  await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
}

const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

test("the kitchen's simulated suppliers say so, and nothing claims to be verified live", async ({ page, request }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  const ws = await makeWorkspace(request);
  await open(page, ws.owner);
  const suppliers = await (await request.get(`/api/workspaces/${ws.id}/suppliers`, auth(ws.owner))).json();
  expect(suppliers.length).toBeGreaterThan(0);
  for (const s of suppliers) await expect(page.locator("#suppliers")).toContainText(s.name);
  await expect(page.locator("#suppliers .status").first()).toHaveText("Simulated");
  await expect(page.locator("#suppliers")).toContainText("Practice supplier");
  await expect(page.locator("main")).not.toContainText("Verified live");
  await expect(page.locator("#tools")).toContainText("No tools connected yet.");
  await expect(page.locator("#health")).toContainText(`${suppliers.length} simulated`);
  expect(problems).toEqual([]);
});

test("an owner adds a key once, tests it honestly, and removes it; the key never comes back", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await open(page, ws.owner);
  await page.getByRole("button", { name: "Add" }).first().click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#tool-error")).toContainText("Give it a name");
  const secret = "sk_test_" + "x".repeat(40);
  await page.getByLabel("Name", { exact: true }).fill("Accounting");
  await page.getByLabel("What it is").selectOption("accounting");
  await page.getByLabel("Key or token").fill(secret);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("#toast")).toContainText("accounting is added.");
  await expect(page.locator("#tool-form")).toBeHidden();
  await expect(page.locator("#tools")).toContainText("accounting");
  await expect(page.locator("#tools .status")).toHaveText("Added, not verified");
  expect(await page.content()).not.toContain(secret);

  const listed = await (await request.get(`/api/workspaces/${ws.id}/connectors`, auth(ws.owner))).json();
  expect(listed).toEqual([expect.objectContaining({ connectorId: "accounting", kind: "accounting", status: "configured_unverified" })]);
  expect(JSON.stringify(listed)).not.toContain(secret);

  // No verifier exists for this kind, and the page says so instead of pretending.
  await page.getByRole("button", { name: "Test accounting" }).click();
  await expect(page.locator("#toast")).toContainText("no automatic test for this kind yet");
  await expect(page.locator("#tools .status")).toHaveText("Added, not verified");

  await page.getByRole("button", { name: "Remove accounting" }).click();
  await page.getByRole("button", { name: "Keep it" }).click();
  await expect(page.getByRole("button", { name: "Remove accounting" })).toBeVisible();
  await page.getByRole("button", { name: "Remove accounting" }).click();
  await page.locator("#revoke-confirm").click();
  await expect(page.locator("#toast")).toContainText("removed and its key destroyed");
  await expect(page.locator("#tools .status")).toHaveText("Revoked");
  await expect(page.getByRole("button", { name: "Test accounting" })).toHaveCount(0);
  const after = await (await request.get(`/api/workspaces/${ws.id}/connectors`, auth(ws.owner))).json();
  expect(after[0].status).toBe("revoked");
});

test("an owner adds a real supplier unapproved, sees it needs them, approves it, and the server agrees", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await open(page, ws.owner);
  await page.getByRole("button", { name: "Add" }).nth(1).click();
  await page.getByLabel("Supplier name").fill("Harbor Produce");
  await page.getByLabel("Contact email").fill("not-an-email");
  await page.getByRole("button", { name: "Add supplier" }).click();
  await expect(page.locator("#supplier-error")).toContainText("email doesn't look right");
  await page.getByLabel("Contact email").fill("orders@harbor.example");
  await page.getByRole("button", { name: "Add supplier" }).click();
  await expect(page.locator("#toast")).toContainText("Approve them when you're ready");
  await expect(page.locator("#suppliers")).toContainText("Not approved");
  await expect(page.locator("#health")).toContainText("1 needs you");

  let row = (await (await request.get(`/api/workspaces/${ws.id}/suppliers`, auth(ws.owner))).json()).find((s: { name: string }) => s.name === "Harbor Produce");
  expect(row).toMatchObject({ verified: false, is_simulated: false, adapter_type: "manual_quote", contact_email: "orders@harbor.example" });

  await page.getByRole("button", { name: "Approve Harbor Produce" }).click();
  await expect(page.locator("#toast")).toContainText("Harbor Produce is approved.");
  await expect(page.locator("#suppliers")).toContainText("Approved by you");
  await expect(page.locator("#health")).not.toContainText("needs you");
  // Approval is the owner vouching, not a live check: the word stays "Added, not verified".
  await expect(page.locator("#suppliers li", { hasText: "Harbor Produce" }).locator(".status")).toHaveText("Added, not verified");
  row = (await (await request.get(`/api/workspaces/${ws.id}/suppliers`, auth(ws.owner))).json()).find((s: { name: string }) => s.name === "Harbor Produce");
  expect(row.verified).toBe(true);
  expect(row.contact_email).toBe("orders@harbor.example");

  await page.getByRole("button", { name: "Stop buying from Harbor Produce" }).click();
  await expect(page.locator("#toast")).toContainText("won't buy from Harbor Produce");
  row = (await (await request.get(`/api/workspaces/${ws.id}/suppliers`, auth(ws.owner))).json()).find((s: { name: string }) => s.name === "Harbor Produce");
  expect(row.verified).toBe(false);
});

test("staff see suppliers and messaging apps, not tools or keys, and can't add anything", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await open(page, ws.staff);
  await expect(page.locator("#tools")).toContainText("Only owners can see tools");
  await expect(page.getByRole("button", { name: "Add" })).toHaveCount(0);
  await expect(page.locator("#suppliers .line").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Approve|Stop buying/ })).toHaveCount(0);
  expect((await request.get(`/api/workspaces/${ws.id}/connectors`, auth(ws.staff))).status()).toBe(403);
});

test("a demo refuses a real supplier and the page explains why", async ({ page }) => {
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start the demo" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await page.goto("/app/connections");
  await page.getByRole("button", { name: "Add" }).nth(1).click();
  await page.getByLabel("Supplier name").fill("Harbor Produce");
  await page.getByRole("button", { name: "Add supplier" }).click();
  await expect(page.locator("#supplier-error")).toContainText("A demo uses simulated suppliers only.");
});
