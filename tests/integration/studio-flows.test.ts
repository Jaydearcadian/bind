import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import type { Server } from "node:http";
import { createApp } from "../../src/server/app.js";
import { query } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";

describe("Business Onboarding & Operations Studio (Flows A, B, C, D)", () => {
  const app = createApp();
  const blankWsId = `ws-blank-${Date.now()}`;
  let server: Server;
  let baseUrl = "";

  async function api(method: string, routePath: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const contentType = res.headers.get("content-type") || "";
    const data = contentType.includes("application/json")
      ? await res.json()
      : await res.text();
    return { status: res.status, body: data, text: typeof data === "string" ? data : JSON.stringify(data) };
  }

  beforeAll(async () => {
    await runMigrations();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (blankWsId.startsWith("ws-blank-")) {
      await fs.rm(path.resolve(process.cwd(), "templates", blankWsId), {
        recursive: true,
        force: true,
      });
    }
  });

  it("Flow A: creates a genuinely blank workspace with 0 orders, 0 workflows, and 0 transactions, blocks overwriting canonical templates, and supports optional blueprint inspection", async () => {
    // 0. Guard against overwriting canonical reference template (kitchen-ops)
    const protectedRes = await api("POST", "/api/workspaces/onboard", {
      workspaceId: "kitchen-ops",
      name: "Attempted Overwrite",
      businessType: "kitchen",
      budgetDailyLimitCents: 150000,
      approvalThresholdCents: 40000,
    });
    expect(protectedRes.status).toBe(400);

    // 1. Inspect optional blueprint without creating records
    const bpRes = await api("GET", "/api/templates/kitchen-ops/blueprint");
    expect(bpRes.status).toBe(200);
    expect(bpRes.body.referenceTemplateId).toBe("kitchen-v1");
    expect(bpRes.body.suggestedSupplies.length).toBeGreaterThan(0);

    // 2. Create a genuinely blank workspace
    const onboardRes = await api("POST", "/api/workspaces/onboard", {
      workspaceId: blankWsId,
      name: "Blank Test Kitchen",
      businessType: "kitchen",
      budgetDailyLimitCents: 150000, // $1,500.00
      approvalThresholdCents: 40000, // $400.00
      supplies: [],
      suppliers: [],
    });

    expect(onboardRes.status).toBe(201);
    expect(onboardRes.body.workspaceId).toBe(blankWsId);
    expect(onboardRes.body.provenance).toBe("OWNER_CONFIRMED");

    // 3. Verify 0 fabricated orders, workflows, inventory, or journal entries
    const [invRes, wfRes, ordRes, ledgerRes] = await Promise.all([
      api("GET", `/api/workspaces/${blankWsId}/inventory`),
      api("GET", `/api/workspaces/${blankWsId}/workflows`),
      api("GET", `/api/workspaces/${blankWsId}/orders`),
      api("GET", `/api/workspaces/${blankWsId}/accounting/ledger`),
    ]);

    expect(invRes.body).toEqual([]);
    expect(wfRes.body).toEqual([]);
    expect(ordRes.body).toEqual([]);
    expect(ledgerRes.body).toEqual([]);

    // 4. Add an owner-configured supplier and supply SKU
    const suppRes = await api("POST", `/api/workspaces/${blankWsId}/suppliers`, {
      id: "supp-sysco",
      name: "Sysco Metro Restock",
      adapterType: "simulated_sysco",
      verified: true,
      isSimulated: true,
    });
    expect(suppRes.status).toBe(201);

    const skuRes = await api("POST", `/api/workspaces/${blankWsId}/inventory`, {
      sku: "SKU-FLOUR-001",
      name: "King Arthur Artisan Bread Flour (50lb)",
      category: "Dry Goods",
      unit: "bag",
      currentQuantity: 2,
      parLevel: 10,
      reorderQuantity: 8,
      unitPriceCents: 4250,
      preferredSupplierId: suppRes.body.id,
    });
    expect(skuRes.status).toBe(201);
    expect(skuRes.body.sku).toBe("SKU-FLOUR-001");
  });

  it("Flow B: configures role-specific agents, generates derived AGENTS.md, and hard-blocks forbidden tools (transfer_usdc)", async () => {
    // 1. Negative test: attempt to grant 'transfer_usdc' to an agent role
    const forbiddenRes = await api("POST", `/api/workspaces/${blankWsId}/agents`, {
      roleName: "rogue_agent",
      displayName: "Rogue Spend Agent",
      description: "Attempts to sign or transfer USDC directly",
      permittedEffects: ["read", "commercial_commitment"],
      spendingLimitCents: 20000,
      allowedTools: ["get_business_context", "transfer_usdc"],
      enabled: true,
    });

    expect(forbiddenRes.status).toBe(400);
    expect(forbiddenRes.body.code).toBe("FORBIDDEN_CAPABILITY");
    expect(forbiddenRes.body.error).toContain("FORBIDDEN_CAPABILITY_VIOLATION");

    // 2. Positive test: create a bounded role with SAFE_AGENT_TOOLS
    const roleRes = await api("POST", `/api/workspaces/${blankWsId}/agents`, {
      roleName: "invoice_auditor",
      displayName: "Invoice & 3-Way Match Auditor",
      description: "Audits packing slips and vendor invoices against POs.",
      permittedEffects: ["read", "external_request"],
      spendingLimitCents: 30000,
      allowedTools: [
        "get_business_context",
        "get_stock_snapshot",
        "get_approved_supplier_quotes",
      ],
      enabled: true,
    });

    expect(roleRes.status).toBe(201);
    expect(roleRes.body.derivedFiles.agentsSpecPath).toBe(
      `templates/${blankWsId}/AGENTS.md`
    );

    // Verify derived AGENTS.md exists on disk and reflects canonical DB state
    const agentsMdPath = path.resolve(
      process.cwd(),
      roleRes.body.derivedFiles.agentsSpecPath
    );
    const agentsMd = await fs.readFile(agentsMdPath, "utf8");
    expect(agentsMd).toContain("Blank Test Kitchen");
    expect(agentsMd).toContain("Invoice & 3-Way Match Auditor");
    expect(agentsMd).toContain("Model confidence never independently authorizes a payment");
  });

  it("Flow C: enforces canonical database role bindings on messaging surfaces and rejects staff spoofing owner approvals", async () => {
    // 1. Bind whatsapp:+14155550199 as 'staff' in PostgreSQL
    const bindStaffRes = await api("POST", `/api/workspaces/${blankWsId}/surfaces`, {
      surface: "whatsapp",
      actorId: "whatsapp:+14155550199",
      actorLabel: "Line Cook Marco",
      actorRole: "staff",
      integrationStatus: "verified", // Should be downgraded to configured_unverified when env secret not present
    });

    expect(bindStaffRes.status).toBe(201);
    expect(bindStaffRes.body.actor_role).toBe("staff");
    expect(bindStaffRes.body.integration_status).toBe("configured_unverified");

    // 2. Negative test: registered 'staff' actor attempts to spoof actorRole: 'owner' in webhook payload to approve spend
    const spoofApproveRes = await api("POST", "/api/webhooks/incoming", {
      eventType: "SURFACE_OWNER_APPROVAL_DECISION",
      eventId: `evt_spoof_${Date.now()}`,
      workspaceId: blankWsId,
      surface: "whatsapp",
      actorId: "whatsapp:+14155550199",
      actorRole: "owner", // Spoofed in payload, but DB says 'staff'!
      approvalId: "appr_fake_123",
      decision: "approve",
    });

    expect(spoofApproveRes.status).toBe(403);
    expect(spoofApproveRes.body.error).toContain("SURFACE_ROLE_VIOLATION");
  });

  it("Flow D: executes two-stage Extract -> Confirm for quotes, feeds procurement, enforces 3-way match on invoices, and exports accounting ledger CSV", async () => {
    // 1. Stage 1 (Extract): parse untrusted Supplier Quote text
    const extractQuoteRes = await api("POST", `/api/workspaces/${blankWsId}/documents/extract`, {
      docType: "quote",
      sourceLabel: "vendor_pdf_upload",
      rawText: `Supplier: Sysco Metro Restock\nSKU: SKU-FLOUR-001\nQty: 8\nUnit Price: $38.00\nTotal: $304.00`,
    });

    expect(extractQuoteRes.status).toBe(201);
    expect(extractQuoteRes.body.status).toBe("staged_unconfirmed");
    expect(extractQuoteRes.body.provenance).toBe("DOCUMENT_EXTRACTED");
    expect(extractQuoteRes.body.extractedFields.unitPriceCents).toBe(3800);

    const quoteDocId = extractQuoteRes.body.docId;

    // Verify unconfirmed quote is NOT in quotes table yet
    const preQuotes = await query(
      `SELECT * FROM quotes WHERE workspace_id = $1 AND provenance = 'OWNER_CONFIRMED';`,
      [blankWsId]
    );
    expect(preQuotes.rows.length).toBe(0);

    // 2. Stage 2 (Confirm): Owner confirms the staged quote
    const confirmQuoteRes = await api(
      "POST",
      `/api/workspaces/${blankWsId}/documents/${quoteDocId}/confirm`,
      { decidedBy: "owner@bind.local" }
    );

    expect(confirmQuoteRes.status).toBe(200);
    expect(confirmQuoteRes.body.status).toBe("owner_confirmed");
    expect(confirmQuoteRes.body.provenance).toBe("OWNER_CONFIRMED");

    // 3. Trigger replenishment in blankWsId -> should use the OWNER_CONFIRMED quote ($38.00/unit * 8 = $304.00 <= $400.00 gate -> auto-authorized & confirmed)
    const repRes = await api("POST", `/api/workspaces/${blankWsId}/replenish`, {
      sku: "SKU-FLOUR-001",
    });

    expect(repRes.status).toBe(200);
    expect(repRes.body.state).toBe("confirmed");
    const orderId = repRes.body.orderId;
    expect(orderId).toBeDefined();

    // Verify order used the $38.00 (3800 cents) owner-confirmed quote
    const ordCheck = await query(`SELECT * FROM orders WHERE id = $1;`, [orderId]);
    expect(Number(ordCheck.rows[0].unit_price_cents)).toBe(3800);
    expect(Number(ordCheck.rows[0].total_price_cents)).toBe(30400);

    // 4. Negative 3-Way Match: Extract & Confirm a Vendor Bill with a price overcharge ($45.00 instead of $38.00)
    const badBillExtract = await api("POST", `/api/workspaces/${blankWsId}/documents/extract`, {
      docType: "supplier_bill",
      rawText: `Invoice #: INV-BAD-99\nSupplier: Sysco Metro Restock\nSKU: SKU-FLOUR-001\nQty: 8\nUnit Price: $45.00\nTotal: $360.00`,
      linkedOrderId: orderId,
    });
    expect(badBillExtract.status).toBe(201);

    const badBillConfirm = await api(
      "POST",
      `/api/workspaces/${blankWsId}/documents/${badBillExtract.body.docId}/confirm`,
      { decidedBy: "owner@bind.local", linkedOrderId: orderId }
    );

    expect(badBillConfirm.status).toBe(200);
    expect(badBillConfirm.body.matchStatus).toBe("PRICE_DISCREPANCY");
    expect(badBillConfirm.body.reconciled).toBe(false);

    // 5. Positive 3-Way Match: Extract & Confirm a matching Vendor Bill ($38.00 * 8 = $304.00)
    const goodBillExtract = await api("POST", `/api/workspaces/${blankWsId}/documents/extract`, {
      docType: "supplier_bill",
      rawText: `Invoice #: INV-GOOD-100\nSupplier: Sysco Metro Restock\nSKU: SKU-FLOUR-001\nQty: 8\nUnit Price: $38.00\nTotal: $304.00`,
      linkedOrderId: orderId,
    });
    expect(goodBillExtract.status).toBe(201);

    const goodBillConfirm = await api(
      "POST",
      `/api/workspaces/${blankWsId}/documents/${goodBillExtract.body.docId}/confirm`,
      { decidedBy: "owner@bind.local", linkedOrderId: orderId }
    );

    expect(goodBillConfirm.status).toBe(200);
    expect(goodBillConfirm.body.matchStatus).toBe("MATCHED");
    expect(goodBillConfirm.body.reconciled).toBe(true);
    expect(goodBillConfirm.body.journalEntry).toBeDefined();

    // 6. Verify accounting journal ledger & CSV export
    const ledgerJsonRes = await api("GET", `/api/workspaces/${blankWsId}/accounting/ledger`);
    expect(ledgerJsonRes.status).toBe(200);
    expect(ledgerJsonRes.body.length).toBe(1);
    expect(Number(ledgerJsonRes.body[0].amount_cents)).toBe(30400);

    const ledgerCsvRes = await api(
      "GET",
      `/api/workspaces/${blankWsId}/accounting/ledger?format=csv`
    );
    expect(ledgerCsvRes.status).toBe(200);
    expect(ledgerCsvRes.text).toContain("1400 · Inventory Asset");
    expect(ledgerCsvRes.text).toContain("304.00");
  });
});
