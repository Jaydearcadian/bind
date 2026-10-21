import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/*
 * Business data (ADR 0066) in a real browser against the real server. The rows come from the kitchen template and from real
 * workflows (a replenishment approved through the API, a customer order taken through the API); the page must show what the
 * server holds and keep "sent" apart from "confirmed" and "paid".
 */

const run = Date.now();
let seq = 0;

async function makeWorkspace(request: APIRequestContext, templateId = "kitchen-v1") {
  const id = `ws-data-${run}-${++seq}`;
  const res = await request.post("/api/workspaces", { data: { id, name: `Data Kitchen ${seq}`, templateId } });
  expect(res.status(), await res.text()).toBe(201);
  return { id, owner: (await res.json()).ownerToken.token as string };
}

const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

async function open(page: Page, key: string, hash = "") {
  await page.goto("/app/sign-in");
  await page.getByLabel("Access key").fill(key);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await page.goto(`/app/data${hash}`);
  await expect(page.getByRole("heading", { level: 1, name: "Business data" })).toBeVisible();
}

test("stock shows the server's rows with low items first; tabs work by click and keyboard and remember the tab", async ({ page, request }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  const ws = await makeWorkspace(request);
  const stock = await (await request.get(`/api/workspaces/${ws.id}/inventory`, auth(ws.owner))).json();
  await open(page, ws.owner);
  await expect(page.getByRole("tab", { name: "Stock" })).toHaveAttribute("aria-selected", "true");
  const rows = page.locator("#data-panel tbody tr");
  await expect(rows).toHaveCount(stock.length);
  const low = stock.filter((s: { current_quantity: string; par_level: string }) => Number(s.current_quantity) < Number(s.par_level));
  expect(low.length).toBeGreaterThan(0);
  await expect(rows.first().locator(".status")).toHaveText("Low");
  await expect(page.locator("#data-panel .status", { hasText: "Low" })).toHaveCount(low.length);

  await page.getByRole("tab", { name: "Stock" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Purchases" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Purchases" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/#purchases$/);
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Menu" })).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(page.getByRole("tab", { name: "Menu" })).toHaveAttribute("aria-selected", "true");
  expect(problems).toEqual([]);
});

test("an approved purchase reads as confirmed, never paid; a customer order shows its lines and state", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  const rep = await (await request.post(`/api/workspaces/${ws.id}/replenish`, { data: { sku: "FOOD-BUTTER-36LB" }, ...auth(ws.owner) })).json();
  expect(rep.state, JSON.stringify(rep)).toBe("awaiting_approval");
  expect((await request.post(`/api/approvals/${rep.approvalId}/approve`, { data: {}, ...auth(ws.owner) })).status()).toBe(200);
  const orders = await (await request.get(`/api/workspaces/${ws.id}/orders`, auth(ws.owner))).json();
  expect(orders.length).toBe(1);

  const inv = await (await request.get(`/api/workspaces/${ws.id}/inventory`, auth(ws.owner))).json();
  const co = await request.post(`/api/workspaces/${ws.id}/customer-orders`, { data: { externalRef: "TABLE-12", lines: [{ sku: inv[0].sku, quantity: 1 }] }, ...auth(ws.owner) });
  expect(co.status(), await co.text()).toBeLessThan(300);
  const coBody = await co.json();

  await open(page, ws.owner, "#purchases");
  const row = page.locator("#data-panel tbody tr").first();
  await expect(row).toContainText(orders[0].order_number);
  await expect(row).toContainText(orders[0].supplier_name);
  // The simulated supplier confirms at once; nothing is paid, so the page must not say so.
  expect(orders[0].status).toBe("confirmed");
  await expect(row.locator(".status")).toHaveText("Confirmed by supplier");
  await expect(row).not.toContainText("Paid");

  await page.getByRole("tab", { name: "Customer orders" }).click();
  const cRow = page.locator("#data-panel tbody tr").first();
  await expect(cRow).toContainText("TABLE-12");
  await expect(cRow).toContainText(`1 × ${inv[0].sku}`);
  expect(coBody.status).toBe("needs_owner");
  await expect(cRow.locator(".status")).toHaveText("Needs you");
});

test("search looks across every tab, says where it found things, and says so when nothing matches", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  const stock = await (await request.get(`/api/workspaces/${ws.id}/inventory`, auth(ws.owner))).json();
  const target = stock[stock.length - 1];
  await open(page, ws.owner, "#menu");
  await page.getByLabel("Search all business data").fill(target.name.slice(0, 6));
  await expect(page.locator("#search-hits")).toContainText("Stock");
  await expect(page.getByRole("tab", { name: /Stock/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#data-panel")).toContainText(target.name);
  await page.getByLabel("Search all business data").fill("zzzz-nothing-here");
  await expect(page.locator("#search-hits")).toContainText('Nothing matches "zzzz-nothing-here"');
  await expect(page.locator("#data-panel")).toContainText("Nothing in");
});

test("on a phone each row is a readable card with labels and no sideways scroll", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ws = await makeWorkspace(request);
  await open(page, ws.owner);
  await expect(page.locator("#data-panel tbody tr").first()).toBeVisible();
  const label = await page.locator("#data-panel tbody tr").first().locator("td").nth(1).evaluate((td) => getComputedStyle(td, "::before").content);
  expect(label).toContain("On hand");
  // The tabs stay on one line (they scroll sideways inside their bar if they ever don't fit).
  expect((await page.getByRole("tablist").boundingBox())!.height).toBeLessThan(60);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
