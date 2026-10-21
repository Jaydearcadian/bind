import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import pg from "pg";
import { createHash, randomBytes } from "node:crypto";

/*
 * People and access, and the invite link page (ADR 0064), in a real browser against the real server. Members can only join with
 * a Google or wallet account, which needs Privy; so the test writes two account memberships straight into the local database,
 * the same rows acceptInvite writes, and everything after that goes through the page and the API.
 */

const run = Date.now();
let seq = 0;
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? "postgres://bind_local:bind_local_only@127.0.0.1:5432/bind_local" });
test.afterAll(async () => {
  await db.query(`DELETE FROM accounts WHERE privy_user_id LIKE $1;`, [`did:privy:people-${run}-%`]);
  await db.end();
});

async function makeWorkspace(request: APIRequestContext) {
  const id = `ws-people-${run}-${++seq}`;
  const res = await request.post("/api/workspaces", { data: { id, name: `People Kitchen ${seq}`, templateId: "kitchen-v1" } });
  expect(res.status(), await res.text()).toBe(201);
  const owner = (await res.json()).ownerToken.token as string;
  const staffRes = await request.post(`/api/workspaces/${id}/tokens`, { data: { role: "staff", label: "Sam" }, headers: { Authorization: `Bearer ${owner}` } });
  return { id, owner, staff: (await staffRes.json()).token as string };
}

async function addMember(workspaceId: string, name: string, role: "owner" | "staff") {
  const accountId = `acct_people_${run}_${++seq}`;
  await db.query(`INSERT INTO accounts (id, privy_user_id, display_name) VALUES ($1, $2, $3);`, [accountId, `did:privy:people-${run}-${seq}`, name]);
  await db.query(`INSERT INTO workspace_memberships (account_id, workspace_id, role) VALUES ($1, $2, $3);`, [accountId, workspaceId, role]);
  return accountId;
}

async function open(page: Page, key: string) {
  await page.goto("/app/sign-in");
  await page.getByLabel("Access key").fill(key);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await page.goto("/app/people");
  await expect(page.getByRole("heading", { level: 1, name: "People and access" })).toBeVisible();
}

const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

test("an owner makes an invite link shown once, sees it waiting, and cancels it; the server agrees at each step", async ({ page, request }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  const ws = await makeWorkspace(request);
  await open(page, ws.owner);
  await expect(page.locator("#invites")).toContainText("No one is waiting to join.");

  await page.getByRole("button", { name: "Make invite link" }).click();
  await expect(page.locator("#invite-error")).toContainText("Add a name");

  await page.getByLabel("Who is it for?").fill("Priya, mornings");
  await page.getByLabel("The link works for").selectOption("24");
  await page.getByRole("button", { name: "Make invite link" }).click();
  const link = page.getByLabel("Invite link", { exact: true });
  await expect(link).toHaveValue(/\/app\/join#bni_[A-Za-z0-9_-]{43}$/);
  await expect(page.locator("#invite-for")).toHaveText("Priya, mornings");
  // The QR code encodes the same link (drawn by web/app/qr.js, decoded in tests/unit/web-qr.test.ts).
  await expect(page.getByRole("img", { name: "QR code for the invite link" })).toBeVisible();
  expect(await page.locator("#invite-qr path").getAttribute("d")).toMatch(/^M\d+ \d+h1v1h-1z/);
  await expect(page.locator("#invites")).toContainText("Priya, mornings");
  await expect(page.locator("#invites")).toContainText(/link works in (23|24) h/);

  const listed = await (await request.get(`/api/workspaces/${ws.id}/invites`, auth(ws.owner))).json();
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({ label: "Priya, mornings", role: "staff", usedAt: null, revokedAt: null });
  expect(JSON.stringify(listed)).not.toContain((await link.inputValue()).split("#")[1]);

  // "Invite someone else" clears the code from the page.
  await page.getByRole("button", { name: "Invite someone else" }).click();
  await expect(page.locator("#invite-made")).toBeHidden();
  expect(await page.locator("#invite-link").inputValue()).toBe("");

  await page.getByRole("button", { name: "Cancel the invite for Priya, mornings" }).click();
  await expect(page.locator("#toast")).toContainText("The link no longer works.");
  await expect(page.locator("#invites")).toContainText("No one is waiting to join.");
  await page.locator("#past-wrap summary").click();
  await expect(page.locator("#past-invites")).toContainText("Cancelled");
  const after = await (await request.get(`/api/workspaces/${ws.id}/invites`, auth(ws.owner))).json();
  expect(after[0].revokedAt).not.toBeNull();
  expect(problems).toEqual([]);
});

test("an owner changes a member's role and removes a member; the last owner can't be removed or demoted", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  const lee = await addMember(ws.id, "Lee Okafor", "staff");
  await addMember(ws.id, "Ana Ruiz", "staff");
  await open(page, ws.owner);
  await expect(page.locator("#members")).toContainText("Lee Okafor");
  await expect(page.locator("#members")).toContainText("Ana Ruiz");

  await page.getByLabel("Role for Lee Okafor").selectOption("owner");
  await expect(page.locator("#toast")).toContainText("Lee Okafor is now an owner.");
  let members = await (await request.get(`/api/workspaces/${ws.id}/members`, auth(ws.owner))).json();
  expect(members.find((m: { accountId: string }) => m.accountId === lee).role).toBe("owner");

  await page.getByRole("button", { name: "Remove Ana Ruiz" }).click();
  await expect(page.getByRole("dialog", { name: /Remove Ana Ruiz/ })).toBeVisible();
  await page.getByRole("button", { name: "Keep them" }).click();
  await expect(page.locator("#members")).toContainText("Ana Ruiz");
  await page.getByRole("button", { name: "Remove Ana Ruiz" }).click();
  await page.locator("#remove-confirm").click();
  await expect(page.locator("#toast")).toContainText("Ana Ruiz was removed and signed out.");
  await expect(page.locator("#members")).not.toContainText("Ana Ruiz");
  members = await (await request.get(`/api/workspaces/${ws.id}/members`, auth(ws.owner))).json();
  expect(members.map((m: { displayName: string }) => m.displayName)).toEqual(["Lee Okafor"]);

});

test("the last owner can't demote or remove themself, and the page says why in plain words", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  const lee = await addMember(ws.id, "Lee Okafor", "owner");
  // A real session for Lee, stored as the server stores one: only the SHA-256 hash.
  const session = "bns_" + randomBytes(32).toString("base64url");
  await db.query(`INSERT INTO account_sessions (id, account_id, workspace_id, token_hash, expires_at) VALUES ($1, $2, $3, $4, NOW() + interval '1 hour');`, [
    `ses_people_${run}_${++seq}`,
    lee,
    ws.id,
    createHash("sha256").update(session).digest("hex"),
  ]);
  // Revoke every owner token, so Lee's membership is the last owner credential.
  const tokens = await (await request.get(`/api/workspaces/${ws.id}/tokens`, auth(ws.owner))).json();
  const ownerToken = tokens.find((t: { role: string }) => t.role === "owner");
  expect((await request.delete(`/api/workspaces/${ws.id}/tokens/${ownerToken.id}`, auth(session))).status()).toBe(200);

  await open(page, session);
  await page.getByLabel("Role for Lee Okafor").selectOption("staff");
  await expect(page.locator("#toast")).toContainText("always keeps at least one owner");
  await expect(page.getByLabel("Role for Lee Okafor")).toHaveValue("owner");
  await page.getByRole("button", { name: "Remove Lee Okafor" }).click();
  await page.locator("#remove-confirm").click();
  await expect(page.locator("#remove-error")).toContainText("always keeps at least one owner");
  const members = await (await request.get(`/api/workspaces/${ws.id}/members`, auth(session))).json();
  expect(members).toEqual([expect.objectContaining({ accountId: lee, role: "owner" })]);
});

test("staff see a short note, not the invite or member controls; the API refuses them too", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await open(page, ws.staff);
  await expect(page.getByRole("heading", { name: "Only owners manage people" })).toBeVisible();
  await expect(page.locator("#owner-area")).toBeHidden();
  expect((await request.get(`/api/workspaces/${ws.id}/members`, auth(ws.staff))).status()).toBe(403);
  expect((await request.post(`/api/workspaces/${ws.id}/invites`, { data: { label: "x" }, ...auth(ws.staff) })).status()).toBe(403);
});

test("the invite link page takes the code out of the address bar and says what joining needs; a broken link says so", async ({ page }) => {
  const code = "bni_" + "A".repeat(43);
  await page.goto(`/app/join#${code}`);
  await expect(page.getByRole("heading", { name: "You're invited" })).toBeVisible();
  expect(page.url()).not.toContain(code);
  await expect(page.getByRole("button", { name: "Sign in to join" })).toBeDisabled();
  await page.reload();
  await expect(page.getByRole("heading", { name: "You're invited" })).toBeVisible();

  const fresh = await page.context().newPage();
  await fresh.goto("/app/join#bni_short");
  await expect(fresh.getByRole("heading", { name: "This invite link doesn't look right" })).toBeVisible();
});

test("on a phone, More opens People from any page", async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ws = await makeWorkspace(request);
  await page.goto("/app/sign-in");
  await page.getByLabel("Access key").fill(ws.owner);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  const more = page.getByRole("button", { name: "More" });
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(page.locator("#more-menu")).toBeHidden();
  await more.click();
  await page.getByRole("link", { name: "People and access" }).click();
  await expect(page).toHaveURL(/\/app\/people$/);
  await expect(page.getByRole("heading", { level: 1, name: "People and access" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("on a page barely taller than the window, the header settles instead of flickering between sizes", async ({ page, request }) => {
  const ws = await makeWorkspace(request);
  await open(page, ws.staff);
  // Make the page 18px taller than the window: past the old 12px threshold, but less than that plus the 10px the header loses.
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "2000px";
    document.body.append(spacer);
    spacer.style.height = `${2000 - (document.documentElement.scrollHeight - window.innerHeight - 18)}px`;
  });
  const flips = await page.evaluate(async () => {
    const header = document.querySelector(".site-header")!;
    let n = 0;
    new MutationObserver(() => n++).observe(header, { attributes: true, attributeFilter: ["class"] });
    for (let y = 0; y <= 60; y += 3) {
      window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    await new Promise((r) => setTimeout(r, 800));
    return n;
  });
  expect(flips).toBeLessThanOrEqual(1);
});
