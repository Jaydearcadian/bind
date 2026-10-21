import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/* Team and limits (ADR 0062) in a real browser against the real server; every change is checked on the server too. */

const run = Date.now();
let seq = 0;

async function makeWorkspace(request: APIRequestContext) {
  const id = `ws-team-${run}-${++seq}`;
  const res = await request.post("/api/workspaces", { data: { id, name: `Team Kitchen ${seq}`, templateId: "kitchen-v1" } });
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
  await page.goto("/app/team");
  await expect(page.getByRole("heading", { level: 1, name: "Team and limits" })).toBeVisible();
}

const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

test("limits read from the server, change with a preset, refuse an impossible pair, and save what the server stored", async ({ page, request }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  const ws = await makeWorkspace(request);
  await open(page, ws.owner);
  await expect(page.locator("#threshold-out")).toHaveText("$250.00");
  await expect(page.locator("#daily-out")).toHaveText("$1,000.00");
  await expect(page.getByRole("button", { name: "Balanced" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Save limits" })).toBeDisabled();

  await page.getByLabel("Approval threshold in dollars").fill("2000");
  await expect(page.locator("#limits-error")).toContainText("can't be more than the daily limit");
  await expect(page.getByRole("button", { name: "Save limits" })).toBeDisabled();

  await page.getByRole("button", { name: "Cautious" }).click();
  await expect(page.locator("#limits-summary")).toContainText("over $50.00");
  await expect(page.locator("#limits-summary")).toContainText("Not saved yet");
  await page.getByRole("button", { name: "Save limits" }).click();
  await expect(page.locator("#toast")).toHaveText("Limits saved");
  const row = await (await request.get(`/api/workspaces/${ws.id}`, auth(ws.owner))).json();
  expect(Number(row.workspace.approval_threshold_cents)).toBe(5000);
  expect(Number(row.workspace.budget_daily_limit_cents)).toBe(25000);
  await expect(page.locator("#limits-summary")).not.toContainText("Not saved yet");
  expect(problems).toEqual([]);
});

test("an owner can switch a tool off, rename an agent and turn it off, and each change is stored", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await open(page, ws.owner);
  const agent = page.locator(".agent").first();
  await expect(agent).toBeVisible();
  const roleName = await agent.getAttribute("data-role");
  const tool = agent.getByRole("switch", { name: "Read supplier quotes" });
  if (await tool.isChecked()) {
    await tool.uncheck({ force: true });
    await expect.poll(async () => {
      const r = await (await request.get(`/api/workspaces/${ws.id}/agents`, auth(ws.owner))).json();
      return r.roles.find((x: { role_name: string }) => x.role_name === roleName).allowed_tools.includes("get_approved_supplier_quotes");
    }).toBe(false);
  }
  await agent.getByRole("button", { name: "Rename" }).click();
  await page.getByLabel("Agent name").fill("Buying assistant");
  await page.getByLabel("Agent name").press("Enter");
  await expect(page.locator(".agent").first().locator(".agent-name")).toHaveText("Buying assistant");
  await page.locator(".agent").first().getByRole("switch", { name: "On" }).uncheck({ force: true });
  await expect(page.locator(".agent").first()).toHaveClass(/is-off/);
  const r = await (await request.get(`/api/workspaces/${ws.id}/agents`, auth(ws.owner))).json();
  const stored = r.roles.find((x: { role_name: string }) => x.role_name === roleName);
  expect(stored.display_name).toBe("Buying assistant");
  expect(stored.enabled).toBe(false);
});

test("staff see the team and limits but cannot change them", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await open(page, ws.staff);
  await expect(page.locator("#limits-note")).toHaveText("Only an owner can change these.");
  await expect(page.getByLabel("Approval threshold in dollars")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cautious" })).toBeDisabled();
  await expect(page.locator(".agent").first().getByRole("switch").first()).toBeDisabled();
  await expect(page.getByRole("button", { name: "Rename" })).toHaveCount(0);
});
