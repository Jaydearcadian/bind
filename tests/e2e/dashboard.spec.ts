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

  test("renders kitchen vertical slice workspace at /app and isolates Workflows, Approvals, and Evidence on their own subpages", async ({ page }) => {
    await page.goto("/app");

    // Verify Title, Demo Workspace badge, and Treasury Balance on /app (Overview subpage)
    await expect(page).toHaveTitle(/Bind Kitchen Operations/i);
    await expect(page.locator("text=Bind — Kitchen Vertical Slice")).toBeVisible();
    await expect(page.locator("#demoWorkspaceBadge")).toContainText("Demo workspace");
    await expect(page.locator("#treasuryBalance")).toBeVisible();

    // Verify Active Agent Roles (all 3 roles from BIND_BUILD_SPEC.md)
    await expect(page.locator("#agentRolesList").locator("text=Kitchen Procurement Agent")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#agentRolesList").locator("text=Customer & Fulfilment Agent")).toBeVisible();
    await expect(page.locator("#agentRolesList").locator("text=Menu & Feedback Agent")).toBeVisible();
    await expect(page.locator("#agentRolesList").locator("text=Enforced").first()).toBeVisible();

    // Verify Kitchen Live Inventory is visible on /app Overview, while other subpages are hidden
    await expect(page.locator("#inventoryTable").locator("text=Organic All-Purpose Flour (50 lb)")).toBeVisible();
    await expect(page.locator("#inventoryTable").locator("text=European Unsalted Butter (36 lb)")).toBeVisible();
    await expect(page.locator("#workflowsPage")).toBeHidden();
    await expect(page.locator("#approvalsPage")).toBeHidden();
    await expect(page.locator("#setupSection")).toBeHidden();

    // Navigate to Workflows subpage (/app/workflows) and verify Overview is hidden
    await page.goto("/app/workflows");
    await expect(page.locator("#workflowsPage")).toBeVisible();
    await expect(page.locator("#overviewPage")).toBeHidden();
    await expect(page.locator("text=Active Workflows & 3-Way Match")).toBeVisible();

    // Navigate to Evidence subpage (/app/evidence)
    await page.goto("/app/evidence");
    await expect(page.locator("#evidencePage")).toBeVisible();
    await expect(page.locator("#workflowsPage")).toBeHidden();
    await expect(page.locator("text=Auditable Event Log & Chain Proofs")).toBeVisible();

    // Open Evidence Drawer and verify truthful separation of states
    await page.locator("#openEvidenceDrawerBtn").click();
    const drawer = page.locator("#evidenceDrawer");
    await expect(drawer).toHaveClass(/open/);
    await expect(drawer.locator("text=0x6FD6323252a3f63A0c93470B6fd14883252F3f02")).toBeVisible();
    await expect(drawer.locator("text=SIMULATED_SUPPLIER_ADAPTER")).toBeVisible();
    await page.locator("#closeEvidenceDrawerBtn").click();
  });

  test("allows owner to trigger restock RFQ on inventory item in /app and routes to /app/workflows/:workflowId with deep-link reload", async ({ page }) => {
    await page.goto("/app");
    await page.waitForLoadState("networkidle");

    const dialogPromise = page.waitForEvent("dialog");
    const rfqButton = page.locator("button:has-text('Trigger RFQ')").first();
    await expect(rfqButton).toBeVisible();
    await rfqButton.click();

    const dialog = await dialogPromise;
    expect(dialog.message()).toMatch(/Replenishment triggered|Error/);
    await dialog.accept();

    // Verify navigation to the dedicated workflow subpage and lifecycle display
    await expect(page).toHaveURL(/\/app\/workflows\/([^/]+)$/);
    const currentUrl = page.url();
    const wfIdFromUrl = decodeURIComponent(currentUrl.split("/app/workflows/")[1] || "");
    expect(wfIdFromUrl.length).toBeGreaterThan(2);

    await expect(page.locator("#workflowsPage")).toBeVisible();
    await expect(page.locator("#overviewPage")).toBeHidden();
    await expect(page.locator("#selectedWorkflowContainer")).toContainText("LOW_STOCK_DETECTED");

    // Deep-link reload check: refresh /app/workflows/:workflowId and verify the requested workflow & separate settlement/fulfilment states load
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#workflowsPage")).toBeVisible();
    await expect(page.locator(".sidebar-link[data-subpage='workflowsPage']")).toHaveClass(/active/);
    await expect(page.locator("#selectedWorkflowContainer")).toContainText("On-Chain Settlement State (Arc Testnet)");
    await expect(page.locator("#selectedWorkflowContainer")).toContainText("Physical Fulfilment & 3-Way Match");
  });

  test("verifies deep-link refresh, browser back/forward history, unsaved draft preservation, and end-to-end 4-flow Studio persistence", async ({ page }) => {
    const blankWsId = `ws-e2e-blank-${Date.now()}`;

    // 1. Deep-link directly to /app/setup/onboarding and refresh
    await page.goto("/app/setup/onboarding");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#setupSection")).toBeVisible();
    await expect(page.locator("#studioFlowA")).toBeVisible();
    await expect(page.locator("#studioFlowB")).toBeHidden();
    await expect(page.locator(".sidebar-link[data-subpage='setupOnboardingPage']")).toHaveClass(/active/);

    // 2. Verify unsaved input preservation across SPA navigation and browser Back/Forward
    await page.locator("#onboardWsName").fill("Unsaved Draft Bakery Name");
    await page.locator("[data-studio-tab='studioFlowB']").click();
    await expect(page).toHaveURL(/\/app\/setup\/agents$/);
    await expect(page.locator("#studioFlowB")).toBeVisible();
    await expect(page.locator("#studioFlowA")).toBeHidden();
    await expect(page.locator(".sidebar-link[data-subpage='setupAgentsPage']")).toHaveClass(/active/);

    // Browser Back -> returns to /app/setup/onboarding with unsaved input intact
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/setup\/onboarding$/);
    await expect(page.locator("#setupSection")).toBeVisible();
    await expect(page.locator("#studioFlowA")).toBeVisible();
    await expect(page.locator(".sidebar-link[data-subpage='setupOnboardingPage']")).toHaveClass(/active/);
    await expect(page.locator("#onboardWsName")).toHaveValue("Unsaved Draft Bakery Name");

    // Browser Forward -> returns to /app/setup/agents, then Back again to /app/setup/onboarding
    await page.goForward();
    await expect(page).toHaveURL(/\/app\/setup\/agents$/);
    await expect(page.locator("#studioFlowB")).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/setup\/onboarding$/);

    // 3. Flow A: Create a genuinely blank workspace ($200 approval gate) and verify 0 SKUs, 0 Orders, 0 Workflows
    await page.locator("#onboardWsId").fill(blankWsId);
    await page.locator("#onboardWsName").fill("E2E Blank Kitchen");
    await page.locator("#onboardGateCents").fill("200");
    await page.locator("#createBlankWsBtn").click();
    await expect(page.locator("#studioWorkspaceSummary")).toContainText(blankWsId);
    await expect(page.locator("#studioWorkspaceSummary")).toContainText("0 SKUs · 0 Orders · 0 Workflows");
    await expect(page.locator("#studioWorkspaceSummary")).toContainText("0 SKUs (genuinely blank)");

    // Add a supply SKU (SKU-YEAST-005, par=6 -> reorder=12 -> $300 > $200 gate) to the blank workspace
    await page.locator("#addInventorySkuBtn").click();
    await expect(page.locator("#studioWorkspaceSummary")).toContainText("1 SKUs · 0 Orders · 0 Workflows");
    await expect(page.locator("#studioWorkspaceSummary")).toContainText("SKU-YEAST-005");

    // 4. Flow B: Navigate to /app/setup/agents, verify forbidden tool block, save agent role, and reload page to verify persistence
    await page.locator("[data-studio-tab='studioFlowB']").click();
    await expect(page).toHaveURL(/\/app\/setup\/agents$/);
    await expect(page.locator("#studioFlowB")).toBeVisible();
    await expect(page.locator("#studioFlowA")).toBeHidden();
    await expect(page.locator(".sidebar-link[data-subpage='setupAgentsPage']")).toHaveClass(/active/);

    await page.locator("#testForbiddenToolBtn").click();
    await expect(page.locator("#agentRoleFeedback")).toContainText("FORBIDDEN_CAPABILITY_VIOLATION");

    await page.locator("#agentRoleDisplay").fill("Custom E2E Match Auditor");
    await page.locator("#saveAgentRoleBtn").click();
    await expect(page.locator("#agentRoleFeedback")).toContainText("AGENTS.md updated");
    await expect(page.locator("#studioConfiguredRolesList")).toContainText("Custom E2E Match Auditor");

    // Reload /app/setup/agents and verify both active workspace and saved agent role persist
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#studioFlowB")).toBeVisible();
    await expect(page.locator("#sidebarWorkspaceId")).toContainText(blankWsId);
    await expect(page.locator("#studioConfiguredRolesList")).toContainText("Custom E2E Match Auditor");

    // 5. Flow C: Navigate to /app/setup/surfaces, bind staff identity, test staff stock report (200), staff approval block (403), and owner approval (200)
    await page.locator("[data-studio-tab='studioFlowC']").click();
    await expect(page).toHaveURL(/\/app\/setup\/surfaces$/);
    await expect(page.locator("#studioFlowC")).toBeVisible();
    await expect(page.locator("#studioFlowB")).toBeHidden();

    await page.locator("#bindSurfaceIdentityBtn").click();
    await expect(page.locator("#surfaceBindingsList")).toContainText("whatsapp:+14155550199");

    // Staff low-stock report triggers replenishment on SKU-YEAST-005 ($300 > $200 gate -> held in awaiting_approval)
    await page.locator("#simStaffStockBtn").click();
    await expect(page.locator("#surfaceSimulatorOutput")).toContainText("HTTP 200");
    await expect(page.locator("#surfaceSimulatorOutput")).toContainText("awaiting_approval");

    // Staff attempting owner approval is rejected with HTTP 403 SURFACE_ROLE_VIOLATION
    await page.locator("#simStaffApproveBlockedBtn").click();
    await expect(page.locator("#surfaceSimulatorOutput")).toContainText("HTTP 403");
    await expect(page.locator("#surfaceSimulatorOutput")).toContainText("SURFACE_ROLE_VIOLATION");

    // Owner Telegram approval succeeds with HTTP 200 and submits order
    await page.locator("#simOwnerApproveBtn").click();
    await expect(page.locator("#surfaceSimulatorOutput")).toContainText("HTTP 200");
    await expect(page.locator("#surfaceSimulatorOutput")).toContainText("confirmed");

    // 6. Flow D: Navigate to /app/setup/documents, verify Stage 1 unconfirmed quote -> Stage 2 confirmation, then test failed & passed 3-way match
    await page.locator("[data-studio-tab='studioFlowD']").click();
    await expect(page).toHaveURL(/\/app\/setup\/documents$/);
    await expect(page.locator("#studioFlowD")).toBeVisible();
    await expect(page.locator("#studioFlowC")).toBeHidden();

    // Stage 1: Extract Quote -> remains unconfirmed until Stage 2 button is clicked
    await page.locator("#docExtractType").selectOption("quote");
    await page.locator("#docRawText").fill(
      "Supplier: Sysco Metro Restock\nSKU: SKU-YEAST-005\nQty: 12\nUnit Price: $24.00\nTotal: $288.00"
    );
    await page.locator("#extractDocStage1Btn").click();
    await expect(page.locator("#stagedDocumentPreviewBox")).toContainText("DOCUMENT_EXTRACTED (Unconfirmed)");
    await page.locator("#stagedDocumentPreviewBox button:has-text('Stage 2: Owner Confirm')").click();
    await expect(page.locator("#stagedDocumentPreviewBox")).toContainText("OWNER_CONFIRMED");

    // Failed 3-Way Match test: extract a Supplier Bill with an overcharged price ($99.00 vs $25.00 PO) and confirm -> PRICE_DISCREPANCY
    await page.locator("#docExtractType").selectOption("supplier_bill");
    await page.locator("#docRawText").fill(
      "Invoice #: INV-DISCREPANCY-99\nSupplier: Sysco Metro Restock\nSKU: SKU-YEAST-005\nQty: 12\nUnit Price: $99.00\nTotal: $1188.00"
    );
    await page.locator("#extractDocStage1Btn").click();
    await expect(page.locator("#stagedDocumentPreviewBox")).toContainText("DOCUMENT_EXTRACTED (Unconfirmed)");
    await page.locator("#stagedDocumentPreviewBox button:has-text('Stage 2: Owner Confirm')").click();
    await expect(page.locator("#stagedDocumentPreviewBox")).toContainText("PRICE_DISCREPANCY");
    await expect(page.locator("#stagedDocumentPreviewBox")).toContainText("Order remains unfulfilled");

    // Passing 3-Way Match test: extract a matching Supplier Bill ($25.00 * 12 = $300.00) and confirm -> MATCHED & journal entry posted
    await page.locator("#docRawText").fill(
      "Invoice #: INV-MATCHED-100\nSupplier: Sysco Metro Restock\nSKU: SKU-YEAST-005\nQty: 12\nUnit Price: $25.00\nTotal: $300.00"
    );
    await page.locator("#extractDocStage1Btn").click();
    await expect(page.locator("#stagedDocumentPreviewBox")).toContainText("DOCUMENT_EXTRACTED (Unconfirmed)");
    await page.locator("#stagedDocumentPreviewBox button:has-text('Stage 2: Owner Confirm')").click();
    await expect(page.locator("#stagedDocumentPreviewBox")).toContainText("MATCHED");
    await expect(page.locator("#accountingLedgerContainer")).toContainText("$300.00 USDC");

    // Reset stored workspace ID for subsequent tests
    await page.evaluate(() => localStorage.removeItem("bind_active_workspace_id"));
  });
});

