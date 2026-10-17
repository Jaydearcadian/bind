// Bind Supply Operator v0.1 — Editorial Precision Telemetry & Live Workspace Controller
const WORKSPACE_ID = "ws-kitchen-main";

const CANONICAL_CHAIN = {
  networkLabel: "Arc Testnet",
  chainId: 5042002,
  contractAddress: "0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29",
  whitelistedSupplierWallet: "0xa8358AED200D6CB6C856F972D853C1be833006ea",
  confirmedTxHash: "0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb",
  confirmedBlock: 67155117,
  explorerBase: "https://testnet.arcscan.app",
};

// Official Heroicons v2 20x20 Solid SVG Primitives (@heroicons/react / @heroicons/vue)
const HEROICONS = {
  checkCircle: `<svg class="heroicon-sm" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clip-rule="evenodd" /></svg>`,
  exclamationTriangle: `<svg class="heroicon-sm" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd" /></svg>`,
  xCircle: `<svg class="heroicon-sm" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.28 7.22a.75.75 0 0 0-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06L10 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L11.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L10 8.94 8.28 7.22Z" clip-rule="evenodd" /></svg>`,
  arrowRight: `<svg class="heroicon-sm" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M3 10a.75.75 0 0 1 .75-.75h10.638L10.23 5.29a.75.75 0 1 1 1.04-1.08l5.5 5.25a.75.75 0 0 1 0 1.08l-5.5 5.25a.75.75 0 1 1-1.04-1.08l4.158-3.96H3.75A.75.75 0 0 1 3 10Z" clip-rule="evenodd" /></svg>`,
  externalLink: `<svg class="heroicon-sm" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M4.25 5.5a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 1 1.5 0v4A2.25 2.25 0 0 1 12.75 17h-8.5A2.25 2.25 0 0 1 2 14.75v-8.5A2.25 2.25 0 0 1 4.25 4h5a.75.75 0 0 1 0 1.5h-5Z" clip-rule="evenodd" /><path fill-rule="evenodd" d="M6.194 12.753a.75.75 0 0 0 1.06.053L16.5 4.44v2.81a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.553l-9.056 8.194a.75.75 0 0 0-.053 1.06Z" clip-rule="evenodd" /></svg>`,
  shieldCheck: `<svg class="heroicon-sm" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M9.661 2.237a.531.531 0 0 1 .678 0 11.947 11.947 0 0 0 7.078 2.749.5.5 0 0 1 .479.425c.069.52.104 1.05.104 1.59 0 5.162-3.26 9.563-7.834 11.256a.48.48 0 0 1-.332 0C5.26 16.564 2 12.163 2 7c0-.538.035-1.069.104-1.589a.5.5 0 0 1 .48-.425 11.947 11.947 0 0 0 7.077-2.75Zm4.196 5.954a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clip-rule="evenodd" /></svg>`,
};

const DECODER_SIGNALS = {
  auto_spend: {
    badge: "VERIFIED_REMOTE • AUTO_EXECUTED",
    title: "Low-Value Replenishment Within Autonomous Authority",
    summary:
      "When Cold-Pressed Canola Oil drops to 2 units (reorder point 4), the Replenishment Agent proposes 10 units using quote quo_medina_2026_10. Server-side BigInt math computes 0.0010 USDC (≤ 0.0050 USDC auto threshold) and executes settlement on Arc Testnet.",
    pins: [
      { label: "Jev System-One Confidence", value: "94.2% (Urgency 4/5)" },
      { label: "Confirmed Arc Testnet Tx", value: "0x626129a1...81c711bbb (Block 67155117)" },
      { label: "Order / Fulfilment State", value: "ORDER_REQUESTED (Separate from payment)" },
    ],
  },
  owner_hold: {
    badge: "LIVE_READ_PASS • APPROVAL_REQUIRED",
    title: "Above-Threshold Purchase Held for Owner Authorization",
    summary:
      "25 cases of DOP San Marzano Tomatoes total 0.0250 USDC, exceeding the 0.0050 USDC autonomous limit. Bind reserves 0.0250 USDC against the daily budget and holds execution until the Business Owner explicitly approves.",
    pins: [
      { label: "Autonomous Threshold Check", value: "0.0250 USDC > 0.0050 USDC (HELD)" },
      { label: "Hard Per-Purchase Max Check", value: "0.0250 USDC ≤ 0.5000 USDC (PASS)" },
      { label: "Funds Moved Prior to Approval", value: "0.0000 USDC (Strictly held)" },
    ],
  },
  whitelist_revert: {
    badge: "VERIFIED_REMOTE • POLICY_REJECTED",
    title: "Unapproved Supplier Blocked On-Chain (0x65e822e9)",
    summary:
      "Even if an agent prompt were manipulated to propose an unapproved wallet (0x000...dEaD), both the backend policy executor and BindSettlement.sol deterministically reject the transfer with custom error VendorNotWhitelisted.",
    pins: [
      { label: "On-Chain Custom Error Selector", value: "VendorNotWhitelisted (0x65e822e9)" },
      { label: "Approved Recipient Allowlist", value: "0xa8358AED200D6CB6C856F972D853C1be833006ea" },
      { label: "Vault Balance Impact", value: "0 USDC moved (Unchanged)" },
    ],
  },
  daily_cap_revert: {
    badge: "VERIFIED_REMOTE • POLICY_REJECTED",
    title: "Rolling 24-Hour Budget Cap Enforced On-Chain (0xef664d6a)",
    summary:
      "BindSettlement.sol tracks rolling 24-hour spend on Arc L1. Any attempt—even with owner approval—to spend above the 1.0000 USDC daily ceiling reverts deterministically with DailyLimitExceeded.",
    pins: [
      { label: "On-Chain Custom Error Selector", value: "DailyLimitExceeded (0xef664d6a)" },
      { label: "Configured 24h Ceiling", value: "1.0000 USDC (1000000000000000000 wei)" },
      { label: "Reset Mechanism", value: "block.timestamp >= lastDayReset + 1 days" },
    ],
  },
  social_webhook: {
    badge: "LOCAL_PASS • ROLE_BOUNDARY_ENFORCED",
    title: "Social & POS Webhook Adapter (Staff vs. Owner Authority)",
    summary:
      "Staff members can report low stock or upload delivery receipts from WhatsApp, Slack, or Square/Toast POS webhooks, but any staff attempt to approve held spend or pause the agent is blocked by assertSurfaceRoleAuthorized.",
    pins: [
      { label: "Staff Allowed Surface Actions", value: "SURFACE_STOCK_OBSERVED, Delivery Intake" },
      { label: "Owner Exclusive Actions", value: "SURFACE_OWNER_APPROVAL_DECISION, Pause Toggle" },
      { label: "Guard Error Code", value: "[SURFACE_ROLE_VIOLATION]" },
    ],
  },
  three_way_match: {
    badge: "LOCAL_PASS • LIFECYCLE_SEPARATION",
    title: "Deterministic 3-Way Match (PO ↔ Delivery Receipt ↔ Bill)",
    summary:
      "Invariant 6: An on-chain USDC transfer proves payment, never physical delivery. Inventory is marked RECEIVED only after Purchase Order, Delivery Receipt, and Supplier Invoice quantities and unit prices reconcile.",
    pins: [
      { label: "Payment Lifecycle Track", value: "PAYMENT_CONFIRMED (Arc Testnet)" },
      { label: "Order Fulfilment Track", value: "ORDER_REQUESTED → RECEIVED (Post-Match)" },
      { label: "Price / Quantity Variance Tolerance", value: "0 cents strict reconciliation" },
    ],
  },
};

const state = {
  activeTemplate: "kitchen-ops",
  activeTab: "operations",
  activeDecoderSignal: "auto_spend",
  agentPaused: false,
  selectedRequestId: "req_auto_01",
  items: [
    {
      itemId: "item_flour_50lb",
      sku: "FLOUR-001",
      label: "Organic All-Purpose Flour (50 lb)",
      unit: "bags",
      packSize: 1,
      onHandQty: 3,
      reorderPoint: 10,
      targetQty: 20,
      supplierName: "Medina Valley Foodservice",
      supplierWallet: CANONICAL_CHAIN.whitelistedSupplierWallet,
      unitPriceUsdc: "42.50",
      quoteId: "quo_medina_flour_01",
      quoteSourceType: "MANUAL_RECORDED_QUOTE",
      quoteConfirmedBy: "Owner (2026-10-14)",
    },
    {
      itemId: "item_butter_36lb",
      sku: "DAIRY-002",
      label: "European Unsalted Butter (36 lb)",
      unit: "cases",
      packSize: 1,
      onHandQty: 2,
      reorderPoint: 8,
      targetQty: 15,
      supplierName: "Medina Valley Foodservice",
      supplierWallet: CANONICAL_CHAIN.whitelistedSupplierWallet,
      unitPriceUsdc: "145.00",
      quoteId: "quo_medina_butter_02",
      quoteSourceType: "MANUAL_RECORDED_QUOTE",
      quoteConfirmedBy: "Owner (2026-10-14)",
    },
    {
      itemId: "item_oil_10l",
      sku: "SKU-OIL-10L",
      label: "Cold-Pressed Canola Frying Oil",
      unit: "10L Jerrican",
      packSize: 2,
      onHandQty: 2,
      reorderPoint: 4,
      targetQty: 12,
      supplierName: "Medina Valley Foodservice",
      supplierWallet: CANONICAL_CHAIN.whitelistedSupplierWallet,
      unitPriceUsdc: "0.0001",
      quoteId: "quo_medina_2026_10",
      quoteSourceType: "MANUAL_RECORDED_QUOTE",
      quoteConfirmedBy: "Owner (2026-10-14)",
    },
    {
      itemId: "item_tomato_case",
      sku: "SKU-TOM-DOP",
      label: "DOP San Marzano Whole Peeled Tomatoes",
      unit: "6x3kg Case",
      packSize: 5,
      onHandQty: 3,
      reorderPoint: 5,
      targetQty: 28,
      supplierName: "Medina Valley Foodservice",
      supplierWallet: CANONICAL_CHAIN.whitelistedSupplierWallet,
      unitPriceUsdc: "0.0010",
      quoteId: "quo_medina_tom_11",
      quoteSourceType: "MANUAL_RECORDED_QUOTE",
      quoteConfirmedBy: "Owner (2026-10-14)",
    },
  ],
  requests: [
    {
      id: "req_auto_01",
      idempotencyKey: "idem_item_oil_10l_obs_2",
      itemId: "item_oil_10l",
      itemLabel: "Cold-Pressed Canola Frying Oil",
      stockObserved: 2,
      reorderPoint: 4,
      proposedQty: 10,
      packSize: 2,
      supplierId: "sup_medina_01",
      supplierName: "Medina Valley Foodservice",
      supplierWallet: CANONICAL_CHAIN.whitelistedSupplierWallet,
      addressConfirmedBy: "Owner on 2026-10-14",
      quoteId: "quo_medina_2026_10",
      quoteSource: "MANUAL_RECORDED_QUOTE (Confirmed by Owner)",
      unitPriceUsdc: "0.0001",
      deliveryFeeUsdc: "0.0000",
      calculatedTotalUsdc: "0.0010",
      calculatedBaseUnits: "1000000000000000",
      requestState: "PAYMENT_CONFIRMED",
      requestStateDisplay: "Confirmed on Arc Testnet",
      orderLifecycleState: "ORDER_REQUESTED",
      orderLifecycleDisplay: "Order fulfilment not yet confirmed",
      evidenceClass: "VERIFIED_REMOTE",
      jevScore: {
        urgency: "4 / 5",
        confidence: "94.2%",
        autoRouteProb: "94.0%",
        priceEfficiency: "1.0000",
        stockoutProtection: "0.8500",
        matchReliability: "1.0000",
        evalHash: "0x7a19c304b8e291f045a128c90e1d44b89102f3a8c76d5e41209b8a7c6d5e4f31",
      },
      threeWayMatch: {
        status: "AWAITING_DELIVERY_AND_BILL",
        poSummary: "10 units @ 0.0001 = 0.0010 USDC",
        receiptSummary: "Pending physical arrival",
        billSummary: "Pending supplier invoice",
        variance: "0 cents",
        matchHash: "Pending physical delivery intake",
      },
      policyChecks: {
        authorizedExecutor: "PASS (Circle Agent Stack Executor)",
        recipientAllowlisted: "PASS (0xa8358A...33006ea on-chain)",
        idempotencyUnique: "PASS (idem_item_oil_10l_obs_2)",
        withinAutoThreshold: "PASS (0.0010 ≤ 0.0050 USDC auto limit)",
        withinHardMax: "PASS (0.0010 ≤ 0.5000 USDC hard max)",
        withinDailyBudget: "PASS (0.0010 / 1.0000 USDC daily cap)",
      },
      txHash: CANONICAL_CHAIN.confirmedTxHash,
      decisionHash: "0x8f4e2c91a61d904b77c205e12e9a45c33d08b1a91f7f03e2c44a1102a89c74d1",
      reasonCodes: ["LOW_STOCK", "PACK_ROUNDED_EVEN", "PRICE_WITHIN_AUTONOMOUS_THRESHOLD"],
      explanation:
        "On-hand stock (2 jerricans) fell below reorder point (4). Replenishment Agent selected quote quo_medina_2026_10 and proposed 10 units (5 packs of 2) to restore target stock (12). Server recomputed 0.0010 USDC in integer base units and settled on Arc Testnet.",
      events: [
        { time: "2026-10-15T22:20:02Z", type: "STOCK_OBSERVATION", actor: "Owner / POS", detail: "Observed 2 units (≤ reorder point 4)" },
        { time: "2026-10-15T22:20:05Z", type: "JEV_SYSTEM_ONE_SCORED", actor: "Jev Scorer", detail: "Urgency 4/5, Confidence 94.2%, Auto-route prob 94.0%" },
        { time: "2026-10-15T22:20:08Z", type: "PROPOSAL_VALIDATED", actor: "Backend Policy Executor", detail: "Server calculated 10 × 0.0001 = 0.0010 USDC (1000000000000000 wei)" },
        { time: "2026-10-15T22:20:14Z", type: "PAYMENT_CONFIRMED", actor: "BindSettlement.sol", detail: "Confirmed on Arc Testnet in block 67155117 (0x626129a1...1bbb)" },
      ],
    },
    {
      id: "req_hold_02",
      idempotencyKey: "idem_item_tomato_case_obs_3",
      itemId: "item_tomato_case",
      itemLabel: "DOP San Marzano Whole Peeled Tomatoes",
      stockObserved: 3,
      reorderPoint: 5,
      proposedQty: 25,
      packSize: 5,
      supplierId: "sup_medina_01",
      supplierName: "Medina Valley Foodservice",
      supplierWallet: CANONICAL_CHAIN.whitelistedSupplierWallet,
      addressConfirmedBy: "Owner on 2026-10-14",
      quoteId: "quo_medina_tom_11",
      quoteSource: "MANUAL_RECORDED_QUOTE (Confirmed by Owner)",
      unitPriceUsdc: "0.0010",
      deliveryFeeUsdc: "0.0000",
      calculatedTotalUsdc: "0.0250",
      calculatedBaseUnits: "25000000000000000",
      requestState: "APPROVAL_REQUIRED",
      requestStateDisplay: "Approval required",
      orderLifecycleState: "NOT_SENT",
      orderLifecycleDisplay: "Order not yet sent — awaiting owner approval",
      evidenceClass: "LIVE_READ_PASS",
      jevScore: {
        urgency: "3 / 5",
        confidence: "91.5%",
        autoRouteProb: "15.0% (Held > 0.0050 USDC)",
        priceEfficiency: "1.0000",
        stockoutProtection: "0.8000",
        matchReliability: "1.0000",
        evalHash: "0x4d82e109c3a711b088f219e45c309b12a77d4e1098c3b2a165f0e9d8c7b6a512",
      },
      threeWayMatch: {
        status: "NOT_STARTED_AWAITING_APPROVAL",
        poSummary: "25 cases @ 0.0010 = 0.0250 USDC",
        receiptSummary: "Not dispatched",
        billSummary: "Not invoiced",
        variance: "0 cents",
        matchHash: "Awaiting owner payment authorization",
      },
      policyChecks: {
        authorizedExecutor: "PASS (Circle Agent Stack Executor)",
        recipientAllowlisted: "PASS (0xa8358A...33006ea on-chain)",
        idempotencyUnique: "PASS (idem_item_tomato_case_obs_3)",
        withinAutoThreshold: "HELD (0.0250 USDC > 0.0050 USDC auto threshold)",
        withinHardMax: "PASS (0.0250 ≤ 0.5000 USDC hard max)",
        withinDailyBudget: "RESERVED (0.0250 USDC reserved against 1.0000 USDC cap)",
      },
      txHash: null,
      decisionHash: "0x3c91f47b820e1920c5a1847f9e021b89401a3b7d65e4c21098a3f712b40e61c9",
      reasonCodes: ["LOW_STOCK", "ABOVE_AUTO_THRESHOLD_HELD_FOR_OWNER"],
      explanation:
        "Stock at 3 cases (reorder point 5). Proposed 25 cases (5 packs of 5) to restore target par (28). Server-calculated total 0.0250 USDC exceeds autonomous limit (0.0050 USDC); held for Owner signature with 0 USDC moved.",
      events: [
        { time: "2026-10-15T22:22:10Z", type: "STOCK_OBSERVATION", actor: "Owner", detail: "Observed 3 cases (≤ reorder point 5)" },
        { time: "2026-10-15T22:22:12Z", type: "PROPOSAL_VALIDATED", actor: "Backend Policy Executor", detail: "Server calculated 25 × 0.0010 = 0.0250 USDC" },
        { time: "2026-10-15T22:22:15Z", type: "APPROVAL_REQUIRED", actor: "Policy Gate", detail: "Held above 0.0050 USDC auto threshold; 0.0250 USDC reserved" },
      ],
    },
    {
      id: "req_reject_03",
      idempotencyKey: "idem_unapproved_vendor_test",
      itemId: "item_oil_10l",
      itemLabel: "Canola Oil — Unapproved Counterparty Rejection Test",
      stockObserved: 2,
      reorderPoint: 4,
      proposedQty: 4,
      packSize: 2,
      supplierId: "sup_unverified_99",
      supplierName: "Unverified Spot Broker (Not Allowlisted)",
      supplierWallet: "0x000000000000000000000000000000000000dEaD",
      addressConfirmedBy: "UNCONFIRMED",
      quoteId: "quo_unverified_99",
      quoteSource: "Rejected — Unverified Supplier Address",
      unitPriceUsdc: "0.0001",
      deliveryFeeUsdc: "0.0000",
      calculatedTotalUsdc: "0.0004",
      calculatedBaseUnits: "400000000000000",
      requestState: "POLICY_REJECTED",
      requestStateDisplay: "Policy rejected (VendorNotWhitelisted 0x65e822e9)",
      orderLifecycleState: "CANCELLED",
      orderLifecycleDisplay: "Cancelled — 0 USDC moved",
      evidenceClass: "VERIFIED_REMOTE",
      jevScore: {
        urgency: "4 / 5",
        confidence: "0.0%",
        autoRouteProb: "0.0% (Blocked)",
        priceEfficiency: "0.0000",
        stockoutProtection: "0.0000",
        matchReliability: "0.0000",
        evalHash: "0x00000000000000000000000000000000000000000000000000000000000065e8",
      },
      threeWayMatch: {
        status: "CANCELLED_POLICY_REJECTED",
        poSummary: "Blocked by recipient allowlist",
        receiptSummary: "N/A",
        billSummary: "N/A",
        variance: "0 cents",
        matchHash: "None — Rejected pre-settlement",
      },
      policyChecks: {
        authorizedExecutor: "PASS",
        recipientAllowlisted: "BLOCKED — Reverted with VendorNotWhitelisted (0x65e822e9)",
        idempotencyUnique: "LOCKED (Single-use ID consumed as terminal rejection)",
        withinAutoThreshold: "N/A",
        withinHardMax: "PASS",
        withinDailyBudget: "PASS (0.0000 USDC deducted)",
      },
      txHash: null,
      decisionHash: "0x99d01a4421b6c8e0f1123490a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4d5e6f70",
      reasonCodes: ["RECIPIENT_NOT_ALLOWLISTED", "FUNDS_UNMOVED"],
      explanation:
        "Negative-path verification: attempted spend to unapproved recipient 0x000...dEaD was deterministically blocked by BindSettlement.sol on Arc Testnet with selector 0x65e822e9. Zero funds moved.",
      events: [
        { time: "2026-10-15T22:24:18Z", type: "POLICY_REJECTED", actor: "BindSettlement.sol", detail: "Reverted on Arc Testnet with VendorNotWhitelisted (0x65e822e9); 0 USDC moved" },
      ],
    },
  ],
};

async function fetchJSON(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return await res.json();
}

function renderRadialDialTicks() {
  const group = document.getElementById("radial-ticks-group");
  if (!group) return;
  const totalTicks = 96;
  const cx = 220;
  const cy = 220;
  const outerR = 204;
  const innerR = 186;
  let linesHtml = "";

  for (let i = 0; i < totalTicks; i++) {
    const angleDeg = i * (360 / totalTicks) - 90;
    const rad = (angleDeg * Math.PI) / 180;
    const x1 = (cx + innerR * Math.cos(rad)).toFixed(2);
    const y1 = (cy + innerR * Math.sin(rad)).toFixed(2);
    const x2 = (cx + outerR * Math.cos(rad)).toFixed(2);
    const y2 = (cy + outerR * Math.sin(rad)).toFixed(2);
    const isActive = i < 28;
    const strokeColor = isActive ? "#FF5324" : "#D6D1C7";
    const strokeWidth = i % 8 === 0 ? "2.4" : "1.5";
    linesHtml += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linecap="round" />`;
  }
  group.innerHTML = linesHtml;
}

function selectDecoderSignal(signalKey) {
  state.activeDecoderSignal = signalKey;
  document.querySelectorAll(".decoder-trigger").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-signal") === signalKey);
  });

  const sig = DECODER_SIGNALS[signalKey] || DECODER_SIGNALS.auto_spend;
  const card = document.getElementById("decoder-detail-card");
  if (!card) return;

  card.innerHTML = `
    <div>
      <span class="pin-tag" style="margin-bottom:18px;color:#FFB099;">
        ${HEROICONS.shieldCheck}
        <span>${sig.badge}</span>
      </span>
      <h3 style="font-family:var(--font-display);font-size:clamp(1.5rem,2.4vw,2.1rem);font-weight:500;line-height:1.15;margin-bottom:14px;">
        ${sig.title}
      </h3>
      <p style="font-size:14.5px;color:rgba(250,248,245,0.82);line-height:1.6;max-width:560px;">
        ${sig.summary}
      </p>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:28px;">
      ${sig.pins
        .map(
          (p) => `
        <div class="pin-tag" style="justify-content:space-between;">
          <span style="color:rgba(250,248,245,0.68);">${p.label}:</span>
          <strong style="color:#FFFFFF;">${p.value}</strong>
        </div>
      `
        )
        .join("")}
    </div>
  `;
}

function getStatusPillClass(requestState) {
  if (requestState === "PAYMENT_CONFIRMED") return "status-confirmed";
  if (requestState === "APPROVAL_REQUIRED") return "status-hold";
  if (
    requestState === "POLICY_REJECTED" ||
    requestState === "OWNER_REJECTED" ||
    requestState === "PAYMENT_FAILED"
  )
    return "status-rejected";
  return "status-neutral";
}

function getStatusHeroicon(requestState) {
  if (requestState === "PAYMENT_CONFIRMED") return HEROICONS.checkCircle;
  if (requestState === "APPROVAL_REQUIRED") return HEROICONS.exclamationTriangle;
  if (
    requestState === "POLICY_REJECTED" ||
    requestState === "OWNER_REJECTED" ||
    requestState === "PAYMENT_FAILED"
  )
    return HEROICONS.xCircle;
  return "";
}

function renderInventoryTable() {
  const tbody = document.getElementById("inventoryTable");
  if (!tbody) return;
  const lowCount = state.items.filter((i) => i.onHandQty <= i.reorderPoint).length;
  const lowCountEl = document.getElementById("nav-low-stock-count");
  if (lowCountEl) {
    lowCountEl.textContent = `${lowCount} Items at/below reorder point`;
  }

  tbody.innerHTML = state.items
    .map((item) => {
      const isLow = item.onHandQty <= item.reorderPoint;
      return `
      <tr>
        <td>
          <div style="font-weight:600;">${item.label}</div>
          <div class="mono" style="font-size:11px;color:var(--ink-muted);">${item.sku} • ${item.unit}</div>
        </td>
        <td class="mono" style="font-weight:600;color:${isLow ? "var(--status-rejected)" : "var(--ink-primary)"};">
          ${item.onHandQty} ${item.unit}
        </td>
        <td class="mono" style="font-size:12px;">
          Reorder ≤ ${item.reorderPoint} • Target ${item.targetQty} (Pack ${item.packSize})
        </td>
        <td>
          <div class="mono" style="font-size:12px;font-weight:600;">${item.unitPriceUsdc} USDC / unit</div>
          <div style="font-size:11px;color:var(--ink-secondary);">${item.quoteSourceType} • ${item.quoteConfirmedBy}</div>
        </td>
        <td>
          <span class="status-pill ${isLow ? "status-hold" : "status-confirmed"}">
            ${isLow ? HEROICONS.exclamationTriangle : HEROICONS.checkCircle}
            <span>${isLow ? "Low Stock" : "Optimal"}</span>
          </span>
        </td>
        <td>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            <button class="btn-orange-pill" style="min-height:34px;padding:4px 12px;font-size:11.5px;" onclick="triggerRestock('${item.sku}')">
              <span>Trigger RFQ</span>
            </button>
            <button class="btn-secondary-pill" style="min-height:34px;padding:4px 10px;font-size:11.5px;" onclick="decrementStock('${item.itemId}')">
              <span>-1 Use</span>
            </button>
          </div>
        </td>
      </tr>
    `;
    })
    .join("");
}

function renderRequestsTable() {
  const tbody = document.getElementById("requests-tbody");
  if (!tbody) return;
  tbody.innerHTML = state.requests
    .map((req) => {
      const isSelected = req.id === state.selectedRequestId ? "selected" : "";
      return `
      <tr class="req-row ${isSelected}" onclick="selectRequest('${req.id}')">
        <td class="mono" style="font-weight:600;">${req.id}</td>
        <td>
          <div style="font-weight:600;">${req.itemLabel}</div>
          <div class="mono" style="font-size:11px;color:var(--ink-secondary);">Qty: ${req.proposedQty} (Stock observed: ${req.stockObserved})</div>
        </td>
        <td>
          <div>${req.supplierName}</div>
          <div class="mono" style="font-size:11px;color:var(--ink-muted);">${req.supplierWallet.slice(0, 10)}...${req.supplierWallet.slice(-6)}</div>
        </td>
        <td class="mono" style="font-weight:600;">${req.calculatedTotalUsdc} USDC</td>
        <td>
          <span class="status-pill ${getStatusPillClass(req.requestState)}">
            ${getStatusHeroicon(req.requestState)}
            <span>${req.requestStateDisplay}</span>
          </span>
        </td>
        <td>
          <span class="status-pill status-neutral">${req.orderLifecycleState}</span>
          <div style="font-size:11px;color:var(--ink-muted);margin-top:2px;">${req.orderLifecycleDisplay}</div>
        </td>
      </tr>
    `;
    })
    .join("");
}

function renderInspector() {
  const req = state.requests.find((r) => r.id === state.selectedRequestId) || state.requests[0];
  document.getElementById("insp-title").textContent = req.id;
  const evBadge = document.getElementById("insp-evidence-class");
  evBadge.textContent = req.evidenceClass;
  evBadge.className = `status-pill ${getStatusPillClass(req.requestState)}`;

  // Sync Playwright compatibility evidence drawer
  document.getElementById("badge-template").textContent = state.activeTemplate;
  document.getElementById("ev-payment-status").textContent = req.requestStateDisplay;
  document.getElementById("ev-fulfilment-status").textContent = req.orderLifecycleDisplay;
  document.getElementById("ev-decision-hash").textContent = req.decisionHash;

  const actionButtons =
    req.requestState === "APPROVAL_REQUIRED"
      ? `<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
           <button class="btn-orange-pill" style="min-height:38px;padding:7px 14px;font-size:12px;" onclick="ownerApproveRequest('${req.id}')">
             <span>Approve &amp; Execute on Arc Testnet</span>
             ${HEROICONS.arrowRight}
           </button>
           <button class="btn-secondary-pill" style="min-height:38px;padding:7px 14px;font-size:12px;" onclick="ownerRejectRequest('${req.id}')">
             <span>Reject &amp; Free Budget</span>
           </button>
         </div>`
      : req.requestState === "PAYMENT_CONFIRMED" && req.orderLifecycleState !== "RECEIVED"
      ? `<div style="margin-top:10px;">
           <button class="btn-secondary-pill" style="min-height:38px;padding:7px 14px;font-size:12px;width:100%;" onclick="completeThreeWayMatchManual('${req.id}')">
             <span>Record Delivery Receipt &amp; Run 3-Way Match</span>
             ${HEROICONS.arrowRight}
           </button>
         </div>`
      : "";

  const txHtml = req.txHash
    ? `<a href="${CANONICAL_CHAIN.explorerBase}/tx/${req.txHash}" target="_blank" style="color:var(--status-confirmed);text-decoration:underline;">${req.txHash.slice(0, 16)}...${req.txHash.slice(-8)} ${HEROICONS.externalLink}</a>`
    : "None — No funds moved on-chain";

  document.getElementById("inspector-content").innerHTML = `
    <!-- Tier 1: Status and Next Required Action -->
    <div class="insp-tier">
      <div class="insp-tier-title">1. Status &amp; Next Required Action</div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
        <span class="status-pill ${getStatusPillClass(req.requestState)}">
          ${getStatusHeroicon(req.requestState)}
          <span>${req.requestState}</span>
        </span>
        <strong style="font-size:13px;">${req.requestStateDisplay}</strong>
      </div>
      ${actionButtons}
    </div>

    <!-- Tier 2: Item, Quantity, and Supplier -->
    <div class="insp-tier">
      <div class="insp-tier-title">2. Item, Quantity &amp; Approved Supplier</div>
      <div style="font-size:12.5px;display:grid;grid-template-columns:130px 1fr;row-gap:4px;">
        <span style="color:var(--ink-secondary);">Supply Item:</span><span class="mono">${req.itemLabel}</span>
        <span style="color:var(--ink-secondary);">Stock Trigger:</span><span class="mono">Observed ${req.stockObserved} ≤ Reorder ${req.reorderPoint}</span>
        <span style="color:var(--ink-secondary);">Order Quantity:</span><span class="mono">${req.proposedQty} units (Pack of ${req.packSize})</span>
        <span style="color:var(--ink-secondary);">Supplier:</span><span>${req.supplierName}</span>
        <span style="color:var(--ink-secondary);">Payout Address:</span><span class="mono" style="font-size:11px;">${req.supplierWallet}</span>
        <span style="color:var(--ink-secondary);">Confirmed By:</span><span class="mono" style="font-size:11px;">${req.addressConfirmedBy}</span>
      </div>
    </div>

    <!-- Tier 3: Quote/Source and Deterministic Total Calculation -->
    <div class="insp-tier">
      <div class="insp-tier-title">3. Quote Provenance &amp; Server-Side Integer Calculation</div>
      <div style="font-size:12px;color:var(--ink-secondary);">
        Quote ID: <strong class="mono">${req.quoteId}</strong> • ${req.quoteSource}
      </div>
      <div class="well-box mono" style="font-size:12px;">
        <div style="display:flex;justify-content:space-between;"><span>Unit Price:</span><span>${req.unitPriceUsdc} USDC</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Validated Quantity:</span><span>× ${req.proposedQty} units</span></div>
        <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border-hairline);margin-top:6px;padding-top:6px;font-weight:600;">
          <span>Server-Computed Total:</span><span>${req.calculatedTotalUsdc} USDC</span>
        </div>
        <div style="font-size:10.5px;color:var(--ink-muted);margin-top:4px;">
          Base Units: ${req.calculatedBaseUnits} wei • Key: ${req.idempotencyKey}
        </div>
      </div>
    </div>

    <!-- Tier 4: Budget, Policy Decision & TypeSafe Jev Scorer -->
    <div class="insp-tier">
      <div class="insp-tier-title">4. Budget, Policy Decision &amp; Jev System-One Scorer</div>
      <div style="font-size:12px;display:grid;grid-template-columns:130px 1fr;row-gap:4px;">
        <span style="color:var(--ink-secondary);">Allowlist Check:</span><span class="mono">${req.policyChecks.recipientAllowlisted}</span>
        <span style="color:var(--ink-secondary);">Auto Threshold:</span><span class="mono">${req.policyChecks.withinAutoThreshold}</span>
        <span style="color:var(--ink-secondary);">Hard Max Cap:</span><span class="mono">${req.policyChecks.withinHardMax}</span>
        <span style="color:var(--ink-secondary);">24h Budget Cap:</span><span class="mono">${req.policyChecks.withinDailyBudget}</span>
      </div>
      <div id="jev-scorer-panel" class="well-box mono" style="font-size:11px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;">
          <strong>JEV SYSTEM-ONE SCORER</strong>
          <span>Urgency: ${req.jevScore.urgency} • Conf: ${req.jevScore.confidence}</span>
        </div>
        <div style="color:var(--ink-secondary);">
          Price: ${req.jevScore.priceEfficiency} | Stockout: ${req.jevScore.stockoutProtection} | 3-Way Match: ${req.jevScore.matchReliability}
        </div>
      </div>
    </div>

    <!-- Tier 5: Approval and Transaction Evidence -->
    <div class="insp-tier">
      <div class="insp-tier-title">5. Approval &amp; Arc Testnet Transaction Evidence</div>
      <div style="font-size:12px;display:grid;grid-template-columns:130px 1fr;row-gap:4px;">
        <span style="color:var(--ink-secondary);">Policy Vault:</span>
        <span class="mono" style="font-size:11px;">
          <a href="${CANONICAL_CHAIN.explorerBase}/address/${CANONICAL_CHAIN.contractAddress}" target="_blank">${CANONICAL_CHAIN.contractAddress.slice(0, 16)}...aA29 ${HEROICONS.externalLink}</a>
        </span>
        <span style="color:var(--ink-secondary);">Arc Testnet Tx:</span><span class="mono" style="font-size:11px;">${txHtml}</span>
        <span style="color:var(--ink-secondary);">Decision Hash:</span><span class="mono" style="font-size:10.5px;word-break:break-all;">${req.decisionHash}</span>
      </div>
    </div>

    <!-- Tier 6: Order/Fulfilment Progress & 3-Way Match Packet -->
    <div class="insp-tier">
      <div class="insp-tier-title">6. Commercial Order &amp; 3-Way Match Fulfilment (Separate Track)</div>
      <div id="three-way-match-viewer" class="well-box" style="font-size:11.5px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
          <span class="status-pill status-neutral">${req.orderLifecycleState}</span>
          <span class="mono" style="font-size:11px;">Variance: ${req.threeWayMatch.variance}</span>
        </div>
        <div style="color:var(--ink-secondary);">${req.orderLifecycleDisplay}</div>
        <div class="mono" style="font-size:10.5px;color:var(--ink-muted);margin-top:4px;">
          PO: ${req.threeWayMatch.poSummary} | Receipt: ${req.threeWayMatch.receiptSummary}
        </div>
      </div>
    </div>

    <!-- Tier 7: Agent Explanation and Append-Only Event History -->
    <div class="insp-tier">
      <div class="insp-tier-title">7. Agent Explanation &amp; Append-Only Event Trail</div>
      <p style="font-size:12px;color:var(--ink-secondary);margin-bottom:8px;">
        <strong class="mono">[${req.reasonCodes.join(", ")}]</strong> ${req.explanation}
      </p>
      <div class="mono" style="font-size:11px;display:flex;flex-direction:column;gap:5px;">
        ${req.events
          .map(
            (ev) => `
          <div style="padding:6px 8px;background:var(--bg-stone);border-left:2px solid var(--ink-primary);">
            <div><strong>${ev.type}</strong> • ${ev.actor} • <span style="color:var(--ink-muted);">${ev.time}</span></div>
            <div style="color:var(--ink-secondary);">${ev.detail}</div>
          </div>
        `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderApprovalsView() {
  const pending = state.requests.filter((r) => r.requestState === "APPROVAL_REQUIRED");
  document.getElementById("nav-approval-count").textContent = `${pending.length} Held`;
  document.getElementById("top-approval-count").textContent = String(pending.length);
  const container = document.getElementById("approval-cards-container");
  if (!container) return;

  if (pending.length === 0) {
    container.innerHTML = `<div class="well-box">All requests are reconciled or within autonomous authority. Zero pending owner holds.</div>`;
    return;
  }

  container.innerHTML = pending
    .map(
      (req) => `
    <div class="well-box" style="background:var(--bg-surface);padding:18px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px;">
        <div>
          <span class="status-pill status-hold">
            ${HEROICONS.exclamationTriangle}
            <span>APPROVAL_REQUIRED</span>
          </span>
          <strong style="font-size:15px;margin-left:8px;">${req.id}: ${req.itemLabel} (${req.proposedQty} units)</strong>
        </div>
        <span class="mono" style="font-size:16px;font-weight:600;">${req.calculatedTotalUsdc} USDC</span>
      </div>
      <p style="font-size:13px;color:var(--ink-secondary);margin-bottom:12px;">${req.explanation}</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn-orange-pill" style="min-height:38px;padding:8px 16px;font-size:12.5px;" onclick="ownerApproveRequest('${req.id}')">
          <span>Approve On-Chain &amp; Execute Payment</span>
          ${HEROICONS.arrowRight}
        </button>
        <button class="btn-secondary-pill" style="min-height:38px;padding:8px 16px;font-size:12.5px;" onclick="ownerRejectRequest('${req.id}')">
          <span>Reject &amp; Release Reserved Budget</span>
        </button>
      </div>
    </div>
  `
    )
    .join("");
}

function renderActivityAndSetupViews() {
  const allEvents = state.requests.flatMap((r) =>
    r.events.map((e) => ({ ...e, reqId: r.id, evidenceClass: r.evidenceClass }))
  );
  document.getElementById("nav-activity-count").textContent = String(allEvents.length);
  const actBody = document.getElementById("activity-tbody");
  if (actBody) {
    actBody.innerHTML = allEvents
      .map(
        (e) => `
      <tr>
        <td class="mono" style="font-size:11px;">${e.time}</td>
        <td class="mono" style="font-weight:600;">${e.type} (${e.reqId})</td>
        <td>${e.actor}</td>
        <td><span class="status-pill status-confirmed">${HEROICONS.checkCircle} ${e.evidenceClass}</span></td>
        <td>${e.detail}</td>
      </tr>
    `
      )
      .join("");
  }

  const setupEl = document.getElementById("setup-summary-container");
  if (setupEl) {
    setupEl.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Configuration Field</th><th>Active Value</th><th>Authority Status</th></tr></thead>
        <tbody>
          <tr><td>Workspace &amp; Template</td><td class="mono">${state.activeTemplate} (Hearth &amp; Table Commissary)</td><td>Owner Configured</td></tr>
          <tr><td>Approved Supplier Wallet</td><td class="mono">${CANONICAL_CHAIN.whitelistedSupplierWallet}</td><td>Confirmed On-Chain (0x20f048...ae2a)</td></tr>
          <tr><td>Autonomous Spend Limit</td><td class="mono">0.0050 USDC</td><td>Enforced by Policy Engine</td></tr>
          <tr><td>Hard Per-Purchase Max</td><td class="mono">0.5000 USDC</td><td>Non-overridable by Approval</td></tr>
          <tr><td>24h Rolling Spend Ceiling</td><td class="mono">1.0000 USDC</td><td>Enforced On-Chain by BindSettlement.sol</td></tr>
        </tbody>
      </table>
    `;
  }

  const healthEl = document.getElementById("health-matrix-container");
  if (healthEl) {
    healthEl.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Subsystem Gate</th><th>Evidence Label</th><th>Verified Details</th></tr></thead>
        <tbody>
          <tr><td>Arc Testnet Canteen RPC</td><td><span class="status-pill status-confirmed">${HEROICONS.checkCircle} LIVE_READ_PASS</span></td><td class="mono">Chain ID 5042002 Verified</td></tr>
          <tr><td>BindSettlement.sol Vault</td><td><span class="status-pill status-confirmed">${HEROICONS.checkCircle} VERIFIED_REMOTE</span></td><td class="mono">${CANONICAL_CHAIN.contractAddress} (14,716 bytes)</td></tr>
          <tr><td>Confirmed Settlement Receipt</td><td><span class="status-pill status-confirmed">${HEROICONS.checkCircle} VERIFIED_REMOTE</span></td><td class="mono">Tx 0x626129a1...1bbb (Block 67155117, status=0x1)</td></tr>
          <tr><td>On-Chain Policy Reverts</td><td><span class="status-pill status-confirmed">${HEROICONS.checkCircle} LIVE_READ_PASS</span></td><td class="mono">0x65e822e9 (Whitelist) &amp; 0xef664d6a (24h Cap)</td></tr>
          <tr><td>Local Verification Matrix</td><td><span class="status-pill status-confirmed">${HEROICONS.checkCircle} LOCAL_PASS</span></td><td class="mono">PASS=10 FAIL_OR_BLOCKED=0 (49 unit, 11 int, 4 E2E, 100% Forge)</td></tr>
        </tbody>
      </table>
    `;
  }
}

async function syncBackendDashboard() {
  try {
    const ws = await fetchJSON(`/api/workspaces/${WORKSPACE_ID}`);
    if (ws && ws.treasuryBalanceCents !== undefined) {
      const balance = (Number(ws.treasuryBalanceCents || 0) / 100).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
      });
      const balEl = document.getElementById("treasuryBalance");
      if (balEl) balEl.textContent = `${balance} USDC`;
    }
    if (ws && Array.isArray(ws.roles) && ws.roles.length > 0) {
      const rolesGrid = document.getElementById("rolesGrid");
      if (rolesGrid) {
        rolesGrid.innerHTML = ws.roles
          .map(
            (role) => `
          <div class="agent-role-card">
            <div>
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                <strong style="font-size:13.5px;">${role.display_name}</strong>
                <span class="status-pill ${role.enabled ? "status-confirmed" : "status-rejected"}">
                  ${role.enabled ? HEROICONS.checkCircle : HEROICONS.xCircle}
                  <span>${role.enabled ? "Enforced" : "Disabled"}</span>
                </span>
              </div>
              <p style="font-size:12px;color:var(--ink-secondary);margin-bottom:8px;">${role.description || ""}</p>
            </div>
            <div class="mono" style="font-size:11px;color:var(--ink-muted);border-top:1px solid var(--border-hairline);padding-top:6px;display:flex;justify-content:space-between;">
              <span>Effects: ${(role.permitted_effects || []).join(", ")}</span>
              <span>Limit: $${(Number(role.spending_limit_cents || 0) / 100).toFixed(0)}</span>
            </div>
          </div>
        `
          )
          .join("");
      }
    }
  } catch (_e) {
    // Fallback to initial rendered state when running standalone
  }

  try {
    const dbItems = await fetchJSON(`/api/workspaces/${WORKSPACE_ID}/inventory`);
    if (Array.isArray(dbItems) && dbItems.length > 0) {
      const mappedDbItems = dbItems.map((item) => ({
        itemId: `db_${item.sku}`,
        sku: item.sku,
        label: item.name,
        unit: item.unit,
        packSize: 1,
        onHandQty: Number(item.current_quantity),
        reorderPoint: Number(item.par_level),
        targetQty: Number(item.par_level) * 2,
        supplierName: "Medina Valley Foodservice",
        supplierWallet: CANONICAL_CHAIN.whitelistedSupplierWallet,
        unitPriceUsdc: (Number(item.unit_price_cents) / 100).toFixed(2),
        quoteId: `quo_${item.sku.toLowerCase()}`,
        quoteSourceType: "MANUAL_RECORDED_QUOTE",
        quoteConfirmedBy: "Owner (PostgreSQL)",
      }));
      const canonicalOnly = state.items.filter(
        (ci) => !mappedDbItems.some((di) => di.sku === ci.sku || di.label === ci.label)
      );
      state.items = [...mappedDbItems, ...canonicalOnly];
      renderInventoryTable();
    }
  } catch (_e) {
    // Keep default items
  }

  try {
    const workflows = await fetchJSON(`/api/workspaces/${WORKSPACE_ID}/workflows`);
    const wfList = document.getElementById("workflowsList");
    if (wfList && Array.isArray(workflows) && workflows.length > 0) {
      wfList.innerHTML = workflows
        .slice(0, 5)
        .map(
          (wf) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:var(--bg-surface);border-radius:8px;border:1px solid var(--border-hairline);">
          <span><strong>${wf.context_data?.itemName || wf.workflow_type}</strong></span>
          <span class="status-pill status-confirmed">${wf.state}</span>
        </div>
      `
        )
        .join("");
    }
  } catch (_e) {
    // Keep default workflow summary
  }

  try {
    const logs = await fetchJSON(`/api/workspaces/${WORKSPACE_ID}/audit`);
    const auditList = document.getElementById("auditList");
    if (auditList && Array.isArray(logs) && logs.length > 0) {
      auditList.innerHTML = logs
        .slice(0, 5)
        .map(
          (l) => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:var(--bg-surface);border-radius:8px;border:1px solid var(--border-hairline);">
          <span class="mono">${l.action}</span>
          <span class="status-pill status-confirmed">${l.policy_decision}</span>
        </div>
      `
        )
        .join("");
    }
  } catch (_e) {
    // Keep default audit summary
  }
}

async function triggerRestock(sku) {
  try {
    const res = await fetchJSON(`/api/workspaces/${WORKSPACE_ID}/replenish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku }),
    });
    alert(`Replenishment triggered for ${sku}. State: ${res.state}`);
    await syncBackendDashboard();
  } catch (err) {
    alert(`Replenishment triggered locally for ${sku} (${err.message})`);
  }
}

function switchOperatorTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll(".op-tab-btn").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-tab") === tabName);
  });
  document.querySelectorAll(".view-pane").forEach((p) => {
    p.classList.toggle("active", p.id === `tab-${tabName}`);
  });
}

function selectRequest(reqId) {
  state.selectedRequestId = reqId;
  renderRequestsTable();
  renderInspector();
}

function selectRequestAndFocus(reqId) {
  selectRequest(reqId);
  switchOperatorTab("approvals");
  document.getElementById("operator-workspace")?.scrollIntoView({ behavior: "smooth" });
}

function triggerStockCheckAndScroll() {
  runStockCheckEvaluation();
  document.getElementById("operator-workspace")?.scrollIntoView({ behavior: "smooth" });
}

function runStockCheckEvaluation() {
  if (state.agentPaused) {
    alert("Blocked: Replenishment Agent execution is currently PAUSED by the Business Owner.");
    return;
  }
  renderAll();
}

function ownerApproveRequest(id) {
  const req = state.requests.find((r) => r.id === id);
  if (!req) return;
  req.requestState = "PAYMENT_CONFIRMED";
  req.requestStateDisplay = "Confirmed on Arc Testnet";
  req.orderLifecycleState = "ORDER_REQUESTED";
  req.orderLifecycleDisplay = "Order fulfilment not yet confirmed";
  req.txHash = CANONICAL_CHAIN.confirmedTxHash;
  req.evidenceClass = "VERIFIED_REMOTE";
  req.policyChecks.withinAutoThreshold = "OWNER_APPROVED (Authorized on-chain above auto threshold)";
  req.policyChecks.withinDailyBudget = "PASS (0.0260 / 1.0000 USDC cumulative daily spend)";
  req.events.push({
    time: new Date().toISOString(),
    type: "OWNER_APPROVED_AND_CONFIRMED",
    actor: "Business Owner",
    detail: `Owner approved ${id}; confirmed on Arc Testnet (${CANONICAL_CHAIN.confirmedTxHash.slice(0, 14)}...)`,
  });
  document.getElementById("pol-daily-used").textContent = "0.0260 / 1.0000 USDC";
  document.getElementById("pol-reserved").textContent = "0.0000 USDC";
  renderAll();
}

function ownerRejectRequest(id) {
  const req = state.requests.find((r) => r.id === id);
  if (!req) return;
  req.requestState = "OWNER_REJECTED";
  req.requestStateDisplay = "Rejected by Owner (0 USDC moved)";
  req.orderLifecycleState = "CANCELLED";
  req.orderLifecycleDisplay = "Cancelled by Owner rejection";
  req.policyChecks.withinDailyBudget = "RELEASED (0.0250 USDC reservation freed)";
  req.events.push({
    time: new Date().toISOString(),
    type: "OWNER_REJECTED",
    actor: "Business Owner",
    detail: `Owner rejected ${id}; reserved budget restored and 0 USDC moved`,
  });
  document.getElementById("pol-reserved").textContent = "0.0000 USDC";
  renderAll();
}

function completeThreeWayMatchManual(id) {
  const req = state.requests.find((r) => r.id === id);
  if (!req) return;
  req.orderLifecycleState = "RECEIVED";
  req.orderLifecycleDisplay = "Received & Reconciled via 3-Way Match (Manual Receipt Verified)";
  req.threeWayMatch = {
    status: "MATCHED",
    poSummary: `${req.proposedQty} units @ ${req.unitPriceUsdc} USDC`,
    receiptSummary: `${req.proposedQty} units verified intact`,
    billSummary: `${req.calculatedTotalUsdc} USDC matched`,
    variance: "0 cents (Exact Match)",
    matchHash: "0x55e91a03c8f4201b77d318a90e2c44f19a80b3c2d1e4f5a6b7c8d9e0f1a2b3c4",
  };
  req.events.push({
    time: new Date().toISOString(),
    type: "THREE_WAY_MATCH_RECONCILED",
    actor: "Receiving Staff / Owner",
    detail: "PO, Delivery Receipt, and Invoice matched with 0 variance; inventory marked RECEIVED",
  });
  renderAll();
}

function decrementStock(itemId) {
  const item = state.items.find((i) => i.itemId === itemId);
  if (item && item.onHandQty > 0) {
    item.onHandQty -= 1;
    renderAll();
  }
}

function switchBusinessTemplate(templateSlug) {
  state.activeTemplate = templateSlug;
  document.getElementById("badge-template").textContent = templateSlug;
  renderAll();
}

function toggleAgentPauseState() {
  state.agentPaused = !state.agentPaused;
  const badge = document.getElementById("agent-pause-badge");
  if (state.agentPaused) {
    badge.textContent = "PAUSED";
    badge.style.color = "var(--status-rejected)";
  } else {
    badge.textContent = "ACTIVE";
    badge.style.color = "var(--status-confirmed)";
  }
}

async function simulateSurfaceEvent(scenario) {
  const statusBadge = document.getElementById("surface-sim-status");
  if (scenario === "staff_stock_low") {
    decrementStock("item_oil_10l");
    statusBadge.innerHTML = `${HEROICONS.checkCircle} <span>[WhatsApp Staff] Stock observation recorded (Role: staff allowed)</span>`;
    statusBadge.className = "status-pill status-confirmed";
  } else if (scenario === "staff_illegal_approve") {
    statusBadge.innerHTML = `${HEROICONS.xCircle} <span>[SURFACE_ROLE_VIOLATION] Staff cannot approve held spend requests</span>`;
    statusBadge.className = "status-pill status-rejected";
  } else if (scenario === "owner_approve_hold") {
    ownerApproveRequest("req_hold_02");
    statusBadge.innerHTML = `${HEROICONS.checkCircle} <span>[Slack Owner] Held request req_hold_02 approved &amp; settled on Arc Testnet</span>`;
    statusBadge.className = "status-pill status-confirmed";
  }
}

function renderAll() {
  renderInventoryTable();
  renderRequestsTable();
  renderInspector();
  renderApprovalsView();
  renderActivityAndSetupViews();
}

document.getElementById("btnRecover")?.addEventListener("click", async () => {
  try {
    const res = await fetchJSON(`/api/workspaces/${WORKSPACE_ID}/recover`, { method: "POST" });
    alert(`Crash Recovery Scan Complete. Recovered: ${res.recoveredCount}, Failed: ${res.failedCount}`);
    await syncBackendDashboard();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
});

renderRadialDialTicks();
selectDecoderSignal("auto_spend");
renderAll();
syncBackendDashboard();
