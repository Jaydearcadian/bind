import { test, expect, type Page } from "@playwright/test";
import { auth, installAdapter, newUser, privyToken } from "./support/privy-stub.js";

/*
 * The Privy embedded wallet (ADR 0073) in a real browser against the real server: created automatically at a first Google
 * sign-in, one per person, never blocking sign-in, shown in Settings. The Privy SDK is a stand-in (see privy-stub.ts); live
 * wallet creation through Privy is NOT_RUN here.
 */

const run = Date.now();
let seq = 0;
const calls = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("stub-calls") || "[]") as string[]);
const googleReturn = "/app/sign-in?privy_oauth_code=abc123&privy_oauth_state=state456&privy_oauth_provider=google";

async function makeWorkspaceFor(request: import("@playwright/test").APIRequestContext, token: string, name: string) {
  const res = await request.post("/api/account/workspaces", { data: { id: `ws-wal-${run}-${++seq}`, name, templateId: "kitchen-v1" }, ...auth(token) });
  expect(res.status(), await res.text()).toBe(201);
}

test("a first Google sign-in creates the wallet once, sign-in carries on, and Settings shows the address", async ({ page, request }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  const token = privyToken(newUser());
  await makeWorkspaceFor(request, token, "Wallet Kitchen");
  await installAdapter(page, null, token);
  await page.goto(googleReturn);
  await expect(page).toHaveURL(/\/app\/$/);
  expect((await calls(page)).filter((c) => c === "ensureWallet")).toHaveLength(1);

  await page.goto("/app/settings");
  const address = page.getByLabel("Your wallet address");
  await expect(address).toHaveValue(/^0x[0-9a-f]{40}$/);
  await expect(page.getByText("Bind never sees its key and never sends anything from it")).toBeVisible();
  await expect(page.getByRole("button", { name: "Set up my wallet" })).toHaveCount(0);
  // Signing in again later finds the wallet and does not make a second one.
  const first = await address.inputValue();
  await page.goto("/app/settings");
  await expect(address).toHaveValue(first);
  expect((await calls(page)).filter((c) => c === "ensureWallet")).toHaveLength(1);
  expect(problems).toEqual([]);
});

test("if the wallet can't be set up, sign-in still works and Settings offers to try again", async ({ page, request }) => {
  const token = privyToken(newUser());
  await makeWorkspaceFor(request, token, "Retry Kitchen");
  await installAdapter(page, null, token, { walletFails: true });
  await page.goto(googleReturn);
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();

  await page.goto("/app/settings");
  await expect(page.getByText("Setting up your wallet didn't finish when you signed in.")).toBeVisible();
  await page.evaluate(() => ((window as unknown as { __walletWorks: boolean }).__walletWorks = true));
  await page.getByRole("button", { name: "Set up my wallet" }).click();
  await expect(page.getByLabel("Your wallet address")).toHaveValue(/^0x[0-9a-f]{40}$/);
  await expect(page.locator("#toast")).toContainText("Your wallet is ready.");
  await page.goto("/app/settings");
  await expect(page.getByLabel("Your wallet address")).toBeVisible();
  await expect(page.getByText("didn't finish")).toHaveCount(0);
});

test("signing in with your own wallet does not create another one, and quiet re-entry never creates one", async ({ page, request }) => {
  const token = privyToken(newUser());
  await makeWorkspaceFor(request, token, "Own Wallet Kitchen");
  await installAdapter(page, null, token);
  await page.goto("/app/sign-in");
  await page.getByRole("button", { name: "Continue with a wallet" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  expect((await calls(page)).filter((c) => c === "ensureWallet")).toHaveLength(0);

  // The session ends; the next page signs back in quietly: still no wallet is created.
  const key = (await page.evaluate(() => sessionStorage.getItem("bind-access-key")))!;
  expect((await request.post("/api/auth/sign-out", auth(key))).status()).toBe(200);
  await page.goto("/app/team");
  await expect(page).toHaveURL(/\/app\/$/);
  expect((await calls(page)).filter((c) => c === "ensureWallet")).toHaveLength(0);
});

test("with an access key there's no wallet, and Settings says why", async ({ page, request }) => {
  const id = `ws-walkey-${run}-${++seq}`;
  const res = await request.post("/api/workspaces", { data: { id, name: "Key Kitchen", templateId: "kitchen-v1" } });
  const owner = (await res.json()).ownerToken.token as string;
  await page.goto("/app/sign-in");
  await page.getByLabel("Access key").fill(owner);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/app\/$/);
  await page.goto("/app/settings");
  await expect(page.locator("#wallet-body")).toContainText("signed in with an access key");
  await expect(page.getByRole("button", { name: "Set up my wallet" })).toHaveCount(0);
});
