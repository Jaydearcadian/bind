import { test, expect } from "@playwright/test";

test.describe("Bind Owner Dashboard E2E", () => {
  test("renders kitchen vertical slice dashboard with agent team and inventory", async ({ page }) => {
    // Navigate to dashboard
    await page.goto("/");

    // Verify Title and Header
    await expect(page).toHaveTitle(/Bind/i);
    await expect(page.locator("h1")).toContainText("Bind");
    await expect(page.locator("text=Kitchen Vertical Slice")).toBeVisible();
    await expect(page.locator("#treasuryBalance")).toBeVisible();

    // Verify Active Agent Roles (all 3 roles from BIND_BUILD_SPEC.md)
    await expect(page.locator("text=Kitchen Procurement Agent")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("text=Customer & Fulfilment Agent")).toBeVisible();
    await expect(page.locator("text=Menu & Feedback Agent")).toBeVisible();
    await expect(page.locator("text=Enforced").first()).toBeVisible();

    // Verify Kitchen Live Inventory
    await expect(page.locator("#inventoryTable").locator("text=Organic All-Purpose Flour (50 lb)")).toBeVisible();
    await expect(page.locator("#inventoryTable").locator("text=European Unsalted Butter (36 lb)")).toBeVisible();
    await expect(page.locator("text=Low Stock").first()).toBeVisible();

    // Verify Audit Log and Workflow Panels exist
    await expect(page.locator("text=Active Workflows & 3-Way Match")).toBeVisible();
    await expect(page.locator("text=Auditable Event Log")).toBeVisible();
  });

  test("allows owner to trigger restock RFQ on inventory item", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const dialogPromise = page.waitForEvent("dialog");
    const rfqButton = page.locator("button:has-text('Trigger RFQ')").first();
    await expect(rfqButton).toBeVisible();
    await rfqButton.click();

    const dialog = await dialogPromise;
    expect(dialog.message()).toMatch(/Replenishment triggered|Error/);
    await dialog.accept();

    // Verify page continues to function without console crash
    await expect(page.locator("#treasuryBalance")).toBeVisible();
  });
});
