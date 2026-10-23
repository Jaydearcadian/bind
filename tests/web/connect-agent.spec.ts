import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/*
 * Connect an agent (ADR 0076) in a real browser against the real server, including the hosted MCP endpoint (ADR 0075): the
 * key the page makes really connects, can look and ask but not approve or pay, shows up under the agent's name, and stops
 * working when removed.
 */

const run = Date.now();
let seq = 0;

async function makeWorkspace(request: APIRequestContext) {
  const id = `ws-agent-${run}-${++seq}`;
  const res = await request.post("/api/workspaces", { data: { id, name: `Agent Kitchen ${seq}`, templateId: "kitchen-v1" } });
  expect(res.status(), await res.text()).toBe(201);
  const owner = (await res.json()).ownerToken.token as string;
  const staffRes = await request.post(`/api/workspaces/${id}/tokens`, { data: { role: "staff", label: "Sam" }, headers: { Authorization: `Bearer ${owner}` } });
  return { id, owner, staff: (await staffRes.json()).token as string };
}

async function open(page: Page, key: string, path = "/app/connect-agent") {
  await page.goto("/app/sign-in");
  await page.getByLabel("Access key").fill(key);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await page.goto(path);
  await expect(page.getByRole("heading", { level: 1, name: "Connect an agent" })).toBeVisible();
}

const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });
const mcp = (request: APIRequestContext, token: string, body: object) =>
  request.post("/mcp", { data: body, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" } });

test("an owner makes an agent's key, sees the setup text, tests it for real, and removes it; the key stops working", async ({ page, request }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  const ws = await makeWorkspace(request);
  await page.goto("/app/sign-in");
  await page.getByLabel("Access key").fill(ws.owner);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await page.goto("/app/team");
  await page.getByRole("link", { name: "Bring your own agent" }).click();
  await expect(page).toHaveURL(/\/app\/connect-agent$/);

  await page.getByRole("button", { name: "Make its key" }).click();
  await expect(page.locator("#agent-error")).toContainText("Give it a name");
  await page.getByLabel("What will it do?").fill("Stock checker");
  await page.getByLabel("Cursor").check();
  await page.getByRole("button", { name: "Make its key" }).click();

  const snippet = page.locator("#snippet");
  await expect(snippet).toContainText("/mcp");
  await expect(snippet).toContainText("Bearer bnd_");
  const text = (await snippet.textContent())!;
  const agentKey = text.match(/bnd_[A-Za-z0-9_-]{43}/)![0];

  // The key is a real staff key named for the agent.
  const tokens = await (await request.get(`/api/workspaces/${ws.id}/tokens`, auth(ws.owner))).json();
  expect(tokens.find((t: { label: string }) => t.label === "agent: Stock checker")).toMatchObject({ role: "staff", revokedAt: null });
  await expect(page.locator("#agents")).toContainText("Stock checker");

  // Another tool, another text.
  await page.getByLabel("Claude Code").check();
  await expect(snippet).toContainText("claude mcp add --transport http bind-stock-checker");
  await page.getByLabel("My own code").check();
  await expect(snippet).toContainText("curl");

  // The page's test goes through the hosted endpoint with the agent's own key.
  await page.getByRole("button", { name: "Test the connection" }).click();
  await expect(page.locator("#test-result")).toContainText("Connected. This agent can use");
  await expect(page.locator("#test-result")).toContainText("Look at stock levels");
  await expect(page.locator("#test-result")).toContainText("Ask for a reorder (an owner still approves it)");
  await expect(page.locator("#test-result")).toContainText("It can't approve or reject a purchase, make a payment, or see keys");

  // What the endpoint really offers: no approval, payment, credential or key tools.
  const listed = await (await mcp(request, agentKey, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })).json();
  const names: string[] = listed.result.tools.map((t: { name: string }) => t.name);
  expect(names.length).toBeGreaterThan(10);
  // Reading what waits for approval is fine (list_approvals); nothing that approves, rejects, pays or touches keys.
  expect(names.filter((n) => /approv|reject|pay|settle|credential|token|secret|connector/i.test(n) && !/^(list|get)_/.test(n))).toEqual([]);
  expect(names).toContain("list_approvals");

  // Done hides the key from the page and from storage.
  await page.getByRole("button", { name: "Done: hide the key" }).click();
  await expect(page.locator("#setup")).toBeHidden();
  expect(await page.content()).not.toContain(agentKey);
  expect(await page.evaluate((k) => JSON.stringify([sessionStorage, localStorage]).includes(k), agentKey)).toBe(false);

  // Remove: asks first, then the key stops working.
  await page.getByRole("button", { name: "Remove the key for Stock checker" }).click();
  await page.getByRole("button", { name: "Keep it" }).click().catch(() => page.locator("#confirm-sheet [data-close]").first().click());
  expect((await request.get("/api/me", auth(agentKey))).status()).toBe(200);
  await page.getByRole("button", { name: "Remove the key for Stock checker" }).click();
  await page.locator("#confirm-go").click();
  await expect(page.locator("#toast")).toContainText("The key was removed");
  expect((await request.get("/api/me", auth(agentKey))).status()).toBe(401);
  expect((await mcp(request, agentKey, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).status()).toBe(401);
  await expect(page.locator("#agents")).toContainText("No agents have a key yet.");
  expect(problems).toEqual([]);
});

test("the test says plainly when Bind refuses the key", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await open(page, ws.owner);
  await page.getByLabel("What will it do?").fill("Short lived");
  await page.getByRole("button", { name: "Make its key" }).click();
  await expect(page.locator("#snippet")).toContainText("Bearer bnd_");
  const tokens = await (await request.get(`/api/workspaces/${ws.id}/tokens`, auth(ws.owner))).json();
  const mine = tokens.find((t: { label: string }) => t.label === "agent: Short lived");
  expect((await request.delete(`/api/workspaces/${ws.id}/tokens/${mine.id}`, auth(ws.owner))).status()).toBe(200);
  await page.getByRole("button", { name: "Test the connection" }).click();
  await expect(page.locator("#test-result")).toContainText("Bind refused the key");
});

test("staff see a note, not the form, and the API refuses them a key", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await open(page, ws.staff);
  await expect(page.locator("#staff-note")).toBeVisible();
  await expect(page.locator("#owner-area")).toBeHidden();
  expect((await request.post(`/api/workspaces/${ws.id}/tokens`, { data: { role: "staff", label: "agent: sneaky" }, ...auth(ws.staff) })).status()).toBe(403);
});

test("an owner or account key is not accepted by the agent endpoint, with a plain reason", async ({ request }) => {
  const ws = await makeWorkspace(request);
  const res = await mcp(request, ws.owner, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  expect(res.status()).toBe(403);
  expect(await res.text()).toContain("staff key");
});
