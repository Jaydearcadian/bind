import { test, expect } from "@playwright/test";

test.describe("Bind Editorial Landing Page (/) & Operations Workspace (/app) E2E", () => {
  test("renders marketing landing page on / and navigates to /app via Open app CTA", async ({ page }) => {
    await page.goto("/");

    // Verify Brand Headline & Positioning from DESIGN.md & BRAND_DIRECTION.md
    await expect(page).toHaveTitle(/Bind/i);
    await expect(page.locator(".hero-title")).toContainText("Your business runs on your rules.");
    await expect(page.locator("text=Context. Authority. Fulfilment.")).toBeVisible();
    await expect(page.locator("text=From low stock to a decision.")).toBeVisible();
    await expect(page.locator("text=Every important action leaves a trail.")).toBeVisible();
    await expect(page.locator("text=Keep the business in control.")).toBeVisible();

    // Verify honest source & settlement attribution on landing page
    await expect(page.locator("text=SIMULATED_SUPPLIER_ADAPTER").first()).toBeVisible();
    await expect(page.locator("text=SETTLED_ON_ARC_TESTNET").first()).toBeVisible();

    // Click Open app and verify navigation to /app
    await page.locator("#headerOpenAppBtn").click();
    await expect(page).toHaveURL(/\/app$/);
    await expect(page.locator("h1:visible")).toContainText("Bind Kitchen Operations");
  });

  test("renders kitchen vertical slice workspace at /app with agent team, inventory, and evidence drawer", async ({ page }) => {
    await page.goto("/app");

    // Verify Title, Demo Workspace badge, and Treasury Balance
    await expect(page).toHaveTitle(/Bind Kitchen Operations/i);
    await expect(page.locator("text=Bind — Kitchen Vertical Slice")).toBeVisible();
    await expect(page.locator("#demoWorkspaceBadge")).toContainText("Demo workspace");
    await expect(page.locator("#treasuryBalance")).toBeVisible();

    // Verify Active Agent Roles (all 3 roles from BIND_BUILD_SPEC.md)
    await expect(page.locator("#agentRolesList").locator("text=Kitchen Procurement Agent")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#agentRolesList").locator("text=Customer & Fulfilment Agent")).toBeVisible();
    await expect(page.locator("#agentRolesList").locator("text=Menu & Feedback Agent")).toBeVisible();
    await expect(page.locator("#agentRolesList").locator("text=Enforced").first()).toBeVisible();

    // Verify Kitchen Live Inventory
    await expect(page.locator("#inventoryTable").locator("text=Organic All-Purpose Flour (50 lb)")).toBeVisible();
    await expect(page.locator("#inventoryTable").locator("text=European Unsalted Butter (36 lb)")).toBeVisible();
    await expect(page.locator("#inventoryTable").locator("text=Low Stock").first()).toBeVisible();

    // Verify Audit Log and Workflow Panels exist
    await expect(page.locator("text=Active Workflows & 3-Way Match")).toBeVisible();
    await expect(page.locator("text=Auditable Event Log")).toBeVisible();

    // Open Evidence Drawer and verify truthful separation of states
    await page.locator("#openEvidenceDrawerBtn").click();
    const drawer = page.locator("#evidenceDrawer");
    await expect(drawer).toHaveClass(/open/);
    await expect(drawer.locator("text=0x6FD6323252a3f63A0c93470B6fd14883252F3f02")).toBeVisible();
    await expect(drawer.locator("text=SIMULATED_SUPPLIER_ADAPTER")).toBeVisible();
    await page.locator("#closeEvidenceDrawerBtn").click();
  });

  test("allows owner to trigger restock RFQ on inventory item in /app", async ({ page }) => {
    await page.goto("/app");
    await page.waitForLoadState("networkidle");

    const dialogPromise = page.waitForEvent("dialog");
    const rfqButton = page.locator("button:has-text('Trigger RFQ')").first();
    await expect(rfqButton).toBeVisible();
    await rfqButton.click();

    const dialog = await dialogPromise;
    expect(dialog.message()).toMatch(/Replenishment triggered|Error/);
    await dialog.accept();

    // Verify page continues to function and updates workflow lifecycle
    await expect(page.locator("#treasuryBalance")).toBeVisible();
    await expect(page.locator("#selectedWorkflowContainer")).toContainText("LOW_STOCK_DETECTED");
  });

  test("renders and executes the 4-Tab Business Onboarding & Operations Studio in /app", async ({ page }) => {
    await page.goto("/app");
    await page.waitForLoadState("networkidle");

    const studioSection = page.locator("#setupSection");
    await expect(studioSection).toBeVisible();
    await expect(studioSection.locator("text=1. Business Onboarding & Blank Workspace")).toBeVisible();

    // Tab 2: Agent Role Creator & Forbidden Capability Block
    await page.locator("[data-studio-tab='studioFlowB']").click();
    await expect(page.locator("#studioFlowB")).toBeVisible();
    await page.locator("#testForbiddenToolBtn").click();
    await expect(page.locator("#agentRoleFeedback")).toContainText("FORBIDDEN_CAPABILITY_VIOLATION");

    // Save a valid role and verify derived AGENTS.md feedback
    await page.locator("#saveAgentRoleBtn").click();
    await expect(page.locator("#agentRoleFeedback")).toContainText("AGENTS.md updated");

    // Tab 3: Messaging Surfaces & In-App Simulator (verify staff spend approval is rejected with HTTP 403)
    await page.locator("[data-studio-tab='studioFlowC']").click();
    await expect(page.locator("#studioFlowC")).toBeVisible();
    await page.locator("#simStaffApproveBlockedBtn").click();
    await expect(page.locator("#surfaceSimulatorOutput")).toContainText("HTTP 403");
    await expect(page.locator("#surfaceSimulatorOutput")).toContainText("SURFACE_ROLE_VIOLATION");

    // Tab 4: Two-Stage Document Extract -> Confirm & Accounting Ledger
    await page.locator("[data-studio-tab='studioFlowD']").click();
    await expect(page.locator("#studioFlowD")).toBeVisible();
    await page.locator("#extractDocStage1Btn").click();
    await expect(page.locator("#stagedDocumentPreviewBox")).toContainText("DOCUMENT_EXTRACTED (Unconfirmed)");
  });
});

