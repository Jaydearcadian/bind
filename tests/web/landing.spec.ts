import { test, expect, type Page } from "@playwright/test";

/*
 * The website in a real browser against the real server (ADR 0054). Each test asserts what a visitor sees and, where it matters,
 * what the server answered. Console errors, failed requests and Content Security Policy violations fail the test.
 */

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("requestfailed", (r) => problems.push(`request failed: ${r.url()}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().endsWith("/favicon.ico")) problems.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  return problems;
}

test.describe("landing page", () => {
  test("loads with its headline, a strict policy, no errors and no sideways scroll", async ({ page }) => {
    const problems = watch(page);
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    expect(res?.headers()["content-security-policy"]).toContain("script-src 'self'");
    await expect(page).toHaveTitle(/Bind/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Connect once\.\s*Get back to work\./);
    await expect(page.locator("h1")).toHaveCount(1);
    for (const name of ["Agents are ready. Most businesses aren't wired for them.", "Three steps, and you can see all of it.", "You stay in charge.", "Free while we build."]) {
      await expect(page.getByRole("heading", { name })).toBeVisible();
    }
    const [scrollWidth, width] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(scrollWidth).toBeLessThanOrEqual(width);
    // The display face loaded from our own server, not a fallback.
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('500 40px "Newsreader"'))).toBe(true);
    expect(problems).toEqual([]);
  });

  test("the main buttons lead to honest pages that say what is not open yet", async ({ page }) => {
    await page.goto("/");
    await page.locator(".hero").getByRole("link", { name: "Try a demo workspace" }).click();
    await expect(page).toHaveURL(/\/demo$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Try a demo workspace.");
    await expect(page.getByText("Opening with the next release")).toBeVisible();
    await expect(page.getByText("Simulated suppliers only. Nothing real is ordered or paid.")).toBeVisible();
    await page.goto("/");
    await page.locator(".hero").getByRole("link", { name: "Start your own workspace" }).click();
    await expect(page).toHaveURL(/\/start$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Start your own workspace.");
    // The builder link it offers is real.
    const spec = await page.request.get("/api/openapi.json");
    expect(spec.status()).toBe(200);
  });

  test("the who-it-is-for switcher works by click and by keyboard, and every day is labelled an example", async ({ page }) => {
    await page.goto("/");
    const day = page.locator("#day");
    await expect(day.locator(".example-tag")).toHaveText("An example day");
    await page.getByRole("tab", { name: "Clinic" }).click();
    await expect(page.getByRole("tab", { name: "Clinic" })).toHaveAttribute("aria-selected", "true");
    await expect(day.getByRole("heading")).toHaveText("A clinic, at the start of the day");
    await expect(day).toHaveAttribute("aria-labelledby", "tab-clinic");
    await page.getByRole("tab", { name: "Clinic" }).press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Shop" })).toBeFocused();
    await expect(day.getByRole("heading")).toHaveText("A shop, mid-morning");
    await page.getByRole("tab", { name: "Shop" }).press("End");
    await expect(day.getByRole("heading")).toHaveText("A social media manager, between clients");
    await expect(day.locator(".row")).toHaveCount(3);
    // Each row's bead settles into the state its label names.
    await expect(day.locator(".row").first().locator(".bind-mark")).toHaveAttribute("data-state", "held");
    await expect(day.locator(".row").first()).toContainText("Held for your review");
  });

  test("questions open and close", async ({ page }) => {
    await page.goto("/");
    const q = page.locator(".faq-list details").filter({ hasText: "Can the agents spend my money?" });
    await expect(q.locator("p")).toBeHidden();
    await q.locator("summary").click();
    await expect(q.locator("p")).toContainText("Only inside the limits you set.");
  });

  test("an unknown address gets the not-found page with a 404, and only the brand files the site uses are public", async ({ page, request }) => {
    const res = await page.goto("/no-such-page");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("There is nothing at this address.");
    expect((await request.get("/brand/tokens.css")).status()).toBe(200);
    expect((await request.get("/brand/BRAND.md")).status()).toBe(404);
    expect((await request.get("/brand/build_assets.py")).status()).toBe(404);
    expect((await request.get("/brand/archive/compare.html")).status()).toBe(404);
  });

  test("with reduced motion the page is complete at once", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/");
    // No waiting: the lede is fully visible straight away.
    expect(await page.locator(".hero .lede").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await ctx.close();
  });

  test("dark mode uses the dark tokens", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.goto("/");
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe("rgb(20, 17, 14)");
    await ctx.close();
  });
});

test.describe("motion and the intro (ADR 0055)", () => {
  test("the first visit of a session plays the intro once, then the page appears; a second visit skips it", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".intro")).toBeAttached();
    await expect(page.locator(".intro svg .ring")).toBeAttached();
    await expect(page.locator(".intro")).toHaveCount(0, { timeout: 4000 });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.reload();
    await expect(page.locator(".intro")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.classList.contains("is-intro"))).toBe(false);
  });

  test("with reduced motion there is no intro, no reveal hiding and the logo stays put", async ({ browser }) => {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.locator(".intro")).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(200);
    expect(await page.locator(".site-header .logo-bead").getAttribute("transform")).toBeNull();
    expect(await page.locator(".promise").first().evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
    await ctx.close();
  });

  test("the header tightens on scroll and the logo's bead travels with the page", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".intro")).toHaveCount(0, { timeout: 4000 });
    const header = page.locator(".site-header");
    await expect(header).not.toHaveClass(/is-compact/);
    const before = await header.locator(".header-row").boundingBox();
    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect(header).toHaveClass(/is-compact/);
    await expect.poll(async () => (await header.locator(".header-row").boundingBox())!.height).toBeLessThan(before!.height);
    const t1 = await header.locator(".logo-bead").getAttribute("transform");
    await page.evaluate(() => window.scrollTo(0, 3200));
    await expect.poll(() => header.locator(".logo-bead").getAttribute("transform")).not.toBe(t1);
    // The ring's gap travels with the bead, so the mark stays whole.
    // (Scrolling is smooth, so read both in one frame.)
    await expect
      .poll(() => header.evaluate((h) => [h.querySelector("mask .orbit")!.getAttribute("transform"), h.querySelector(".logo-bead")!.getAttribute("transform")]))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^rotate\(/)]));
    const [gap, bead] = await header.evaluate((h) => [h.querySelector("mask .orbit")!.getAttribute("transform"), h.querySelector(".logo-bead")!.getAttribute("transform")]);
    expect(gap).toBe(bead);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(header).not.toHaveClass(/is-compact/);
  });

  test("sections ease in when they come into view", async ({ page }) => {
    await page.goto("/");
    const promise = page.locator(".promise").first();
    await expect(promise).toHaveClass(/reveal/);
    await expect(promise).not.toHaveClass(/is-in/);
    await promise.scrollIntoViewIfNeeded();
    await expect(promise).toHaveClass(/is-in/);
    await expect.poll(() => promise.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  });
});

test.describe("landing page, desktop", () => {
  test.skip(({ isMobile }) => isMobile, "the pinned picture is a wide-screen layout");

  test("the how-it-works picture follows the step in view", async ({ page }) => {
    await page.goto("/");
    const stage = page.locator(".stage-col .stage");
    for (const n of ["1", "2", "3"]) {
      await page.evaluate((step) => {
        const el = document.querySelector(`.steps .step[data-step="${step}"]`) as HTMLElement;
        window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - window.innerHeight / 2 + el.offsetHeight / 2);
      }, n);
      await expect(stage).toHaveAttribute("data-step", n);
    }
    await expect(stage.locator(".layer-3")).toBeVisible();
    await expect(stage.locator(".layer-1")).toBeHidden();
  });

  test("the navigation jumps to its sections", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Pricing" }).click();
    await expect(page).toHaveURL(/#pricing$/);
    await expect(page.getByRole("heading", { name: "Free while we build." })).toBeInViewport();
  });
});

test.describe("landing page, phone", () => {
  test.skip(({ isMobile }) => !isMobile, "the menu button exists only on narrow screens");

  test("the menu opens, leads to a section, and closes with Escape", async ({ page }) => {
    await page.goto("/");
    const toggle = page.getByRole("button", { name: "Menu" });
    await expect(page.locator("#nav-list").getByRole("link", { name: "How it works" })).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "How it works" }).click();
    await expect(page).toHaveURL(/#how$/);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
  });

  test("each step shows its own picture on a phone", async ({ page }) => {
    await page.goto("/");
    for (const n of ["1", "2", "3"]) {
      await expect(page.locator(`.step[data-step="${n}"] .stage-clone .layer-${n}`)).toBeVisible();
    }
  });
});
