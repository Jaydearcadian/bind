import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { createPrivateKey, sign } from "node:crypto";
import { PRIVY_TEST_APP_ID, PRIVY_TEST_PRIVATE_KEY } from "./support/privy-test-key.js";

/*
 * Signing in with an account (ADR 0072) in a real browser against the real server. The Privy SDK needs the live Privy
 * service, so the page is given a stand-in adapter with the same shape (window.bindPrivyAdapter); the Privy access tokens
 * it hands over are real ES256 JWTs signed with a throwaway key whose public half the test server trusts, so everything
 * after the adapter (verification, accounts, memberships, sessions) is the real server. Live Google and wallet login against
 * Privy itself is NOT_RUN here: a person completes it on the deployed site.
 */

const APP_ID = PRIVY_TEST_APP_ID;
const PRIVATE_PEM = PRIVY_TEST_PRIVATE_KEY;
const run = Date.now();
let seq = 0;

function privyToken(userId: string, overrides: Record<string, unknown> = {}, key = PRIVATE_PEM) {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const head = b64({ alg: "ES256", typ: "JWT" });
  const body = b64({ sub: userId, aud: APP_ID, iss: "privy.io", exp: Math.floor(Date.now() / 1000) + 3600, ...overrides });
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: createPrivateKey(key), dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${sig.toString("base64url")}`;
}
/** Flips a real bit of the signature (the last base64 character holds unused bits, so editing it can change nothing). */
function tamper(token: string) {
  const [h, b, sig] = token.split(".");
  const bytes = Buffer.from(sig, "base64url");
  bytes[10] ^= 0xff;
  return `${h}.${b}.${bytes.toString("base64url")}`;
}
const newUser = () => `did:privy:acct-${run}-${++seq}`;
const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

/** The stand-in for the Privy SDK. Its "session" lives in sessionStorage like the real SDK's, so it survives page changes in a tab. */
async function installAdapter(page: Page, token: string | null, walletToken?: string) {
  await page.addInitScript(
    ({ t, w }) => {
      const KEY = "stub-privy-token";
      // Seed once per tab: the init script runs on every page load, and a later sign-out must stay signed out.
      if (t && !sessionStorage.getItem("stub-privy-seeded")) {
        sessionStorage.setItem("stub-privy-seeded", "1");
        sessionStorage.setItem(KEY, t);
      }
      const w2 = window as unknown as Record<string, unknown>;
      w2.__calls = [];
      (w2.ethereum as unknown) = w ? {} : undefined;
      w2.bindPrivyAdapter = {
        async getAccessToken() {
          return sessionStorage.getItem(KEY);
        },
        async startGoogle(redirect: string) {
          (w2.__calls as string[]).push(`google:${redirect}`);
        },
        async finishOAuth(search: string) {
          (w2.__calls as string[]).push(`finish:${search}`);
          if (!/privy_oauth_code=/.test(search)) return false;
          if (w) sessionStorage.setItem(KEY, w);
          return true;
        },
        async connectWallet() {
          (w2.__calls as string[]).push("wallet");
          if (w) sessionStorage.setItem(KEY, w);
        },
        async logout() {
          (w2.__calls as string[]).push("logout");
          sessionStorage.removeItem(KEY);
        },
      };
    },
    { t: token, w: walletToken ?? null }
  );
}

async function makeOwnerWorkspace(request: APIRequestContext) {
  const id = `ws-acct-${run}-${++seq}`;
  const res = await request.post("/api/workspaces", { data: { id, name: `Acct Kitchen ${seq}`, templateId: "kitchen-v1" } });
  expect(res.status(), await res.text()).toBe(201);
  return { id, owner: (await res.json()).ownerToken.token as string };
}

const sessionKey = (page: Page) => page.evaluate(() => sessionStorage.getItem("bind-access-key"));

test("a first sign-in with a wallet starts a workspace, signs in as its owner with a real session, and keeps no key but the session", async ({ page, request }) => {
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  const user = newUser();
  await installAdapter(page, null, privyToken(user));
  await page.goto("/app/sign-in");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByText("never lets anyone spend")).toBeVisible();
  await page.getByRole("button", { name: "Continue with a wallet" }).click();
  await expect(page.getByText("not in a workspace yet")).toBeVisible();

  await page.getByRole("button", { name: "Start my workspace" }).click();
  await expect(page.locator("#start-error")).toContainText("Give your workspace a name");
  await page.locator("#start-person").fill("Priya Raman");
  await page.getByLabel("Name your workspace").fill("Harbor Kitchen");
  await page.getByRole("button", { name: "Start my workspace" }).click();
  await expect(page).toHaveURL(/\/app\/$/);

  const key = await sessionKey(page);
  expect(key).toMatch(/^bns_[A-Za-z0-9_-]{43}$/);
  const me = await (await request.get("/api/me", auth(key!))).json();
  expect(me).toMatchObject({ role: "owner", credential: "account_session", workspaceName: "Harbor Kitchen" });
  expect(me.label).toBe("Priya Raman");
  // Nothing long-lived is kept: the key is only in this tab's storage, and the Privy token is not stored by Bind at all.
  expect(await page.evaluate(() => localStorage.getItem("bind-access-key"))).toBeNull();
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("a second sign-in goes straight to the one workspace; with two it asks, and puts the last one first", async ({ page, request, browser }) => {
  const user = newUser();
  const token = privyToken(user);
  const first = await request.post("/api/account/workspaces", { data: { id: `ws-one-${run}-${++seq}`, name: "Alpha Kitchen", templateId: "kitchen-v1" }, ...auth(token) });
  expect(first.status(), await first.text()).toBe(201);

  await installAdapter(page, token);
  await page.goto("/app/sign-in");
  await expect(page).toHaveURL(/\/app\/$/);
  expect((await (await request.get("/api/me", auth((await sessionKey(page))!))).json()).workspaceName).toBe("Alpha Kitchen");

  const second = await request.post("/api/account/workspaces", { data: { id: `ws-two-${run}-${++seq}`, name: "Beta Kitchen", templateId: "kitchen-v1" }, ...auth(token) });
  expect(second.status()).toBe(201);
  const ctx = await browser.newContext();
  const page2 = await ctx.newPage();
  await installAdapter(page2, token);
  await page2.goto("/app/sign-in");
  await expect(page2.getByText("Which workspace do you want to open?")).toBeVisible();
  await expect(page2.locator("#choose-list .line")).toHaveCount(2);
  await page2.getByRole("button", { name: "Open Beta Kitchen" }).click();
  await expect(page2).toHaveURL(/\/app\/$/);
  expect((await (await request.get("/api/me", auth((await sessionKey(page2))!))).json()).workspaceName).toBe("Beta Kitchen");
  await ctx.close();
});

test("an invite link carries through sign-in: the person joins as staff, the invite is used up, and reusing it fails in plain words", async ({ page, request }) => {
  const ws = await makeOwnerWorkspace(request);
  const invite = await (await request.post(`/api/workspaces/${ws.id}/invites`, { data: { label: "Lee" }, ...auth(ws.owner) })).json();
  const user = newUser();
  await installAdapter(page, null, privyToken(user));
  await page.goto(`/app/join#${invite.code}`);
  await expect(page.getByRole("heading", { name: "You're invited" })).toBeVisible();
  await page.getByRole("link", { name: "Sign in to join" }).click();
  await expect(page).toHaveURL(/\/app\/sign-in$/);
  await page.getByRole("button", { name: "Continue with a wallet" }).click();
  await expect(page.getByText("You opened an invite link")).toBeVisible();
  await page.locator("#invite-name").fill("Lee Okafor");
  await page.getByRole("button", { name: "Join the workspace" }).click();
  await expect(page).toHaveURL(/\/app\/$/);

  const me = await (await request.get("/api/me", auth((await sessionKey(page))!))).json();
  expect(me).toMatchObject({ workspaceId: ws.id, role: "staff", label: "Lee Okafor" });
  const invites = await (await request.get(`/api/workspaces/${ws.id}/invites`, auth(ws.owner))).json();
  expect(invites[0].usedAt).not.toBeNull();

  // A second person with the same (used) link is refused plainly, and can go on without it.
  const page2 = await (await page.context().browser()!.newContext()).newPage();
  await installAdapter(page2, null, privyToken(newUser()));
  await page2.goto(`/app/join#${invite.code}`);
  await page2.getByRole("link", { name: "Sign in to join" }).click();
  await page2.getByRole("button", { name: "Continue with a wallet" }).click();
  await page2.getByRole("button", { name: "Join the workspace" }).click();
  await expect(page2.locator("#invite-error")).toContainText("used, cancelled or expired");
  await page2.getByRole("button", { name: "Not now" }).click();
  await expect(page2.getByText("not in a workspace yet")).toBeVisible();
});

test("when a session ends, the next app page signs back in quietly instead of looping; signing out ends everything", async ({ page, request }) => {
  const user = newUser();
  const token = privyToken(user);
  await request.post("/api/account/workspaces", { data: { id: `ws-res-${run}-${++seq}`, name: "Resume Kitchen", templateId: "kitchen-v1" }, ...auth(token) });
  await installAdapter(page, token);
  await page.goto("/app/sign-in");
  await expect(page).toHaveURL(/\/app\/$/);
  const before = (await sessionKey(page))!;

  // The session ends on the server (as it would on expiry); the app sends the person to sign-in, which quietly re-enters.
  expect((await request.post("/api/auth/sign-out", auth(before))).status()).toBe(200);
  await page.goto("/app/team");
  await expect(page).toHaveURL(/\/app\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
  const after = (await sessionKey(page))!;
  expect(after).not.toBe(before);
  expect((await request.get("/api/me", auth(after))).status()).toBe(200);

  // Signing out ends the session, forgets the key, and ends the Privy session in this tab: no quiet re-entry afterwards.
  await page.locator("#account-btn").click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/app\/sign-in$/);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  expect((await request.get("/api/me", auth(after))).status()).toBe(401);
  expect(await sessionKey(page)).toBeNull();
  expect(await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)).toContain("logout");
  await page.goto("/app/");
  await expect(page).toHaveURL(/\/app\/sign-in$/);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
});

test("coming back from Google finishes the login and takes the one-time codes out of the address bar", async ({ page, request }) => {
  const user = newUser();
  await request.post("/api/account/workspaces", { data: { id: `ws-goo-${run}-${++seq}`, name: "Google Kitchen", templateId: "kitchen-v1" }, ...auth(privyToken(user)) });
  await installAdapter(page, null, privyToken(user));
  await page.goto("/app/sign-in");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  expect(await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)).toContain(`google:${new URL(page.url()).origin}/app/sign-in`);

  await page.goto("/app/sign-in?privy_oauth_code=abc123&privy_oauth_state=state456&privy_oauth_provider=google");
  await expect(page).toHaveURL(/\/app\/$/);
  expect(page.url()).not.toContain("abc123");
  expect((await (await request.get("/api/me", auth((await sessionKey(page))!))).json()).workspaceName).toBe("Google Kitchen");
});

test("a forged, expired or other-app Privy token is refused in plain words and never gets a session", async ({ page }) => {
  const cases: Array<[string, string]> = [
    ["expired", privyToken(newUser(), { exp: Math.floor(Date.now() / 1000) - 3600 })],
    ["another app", privyToken(newUser(), { aud: "some-other-app" })],
    ["tampered", tamper(privyToken(newUser()))],
  ];
  for (const [, token] of cases) {
    const ctxPage = await (await page.context().browser()!.newContext()).newPage();
    await installAdapter(ctxPage, null, token);
    await ctxPage.goto("/app/sign-in");
    await ctxPage.getByRole("button", { name: "Continue with a wallet" }).click();
    await expect(ctxPage.locator("#provider-error")).toContainText("didn't check out");
    expect(await sessionKey(ctxPage)).toBeNull();
  }
});

test("where account sign-in isn't switched on, the page says so and the access key still works; the invite page says the same", async ({ page }) => {
  await page.route("**/api/public-config", (route) => route.fulfill({ json: { privyAppId: null } }));
  await page.goto("/app/sign-in");
  await expect(page.locator("#soon")).toContainText("aren't switched on");
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeHidden();
  await expect(page.getByLabel("Access key")).toBeVisible();
  const code = "bni_" + "A".repeat(43);
  await page.goto(`/app/join#${code}`);
  await expect(page.getByRole("button", { name: "Sign in to join" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Sign in to join" })).toBeHidden();
});
