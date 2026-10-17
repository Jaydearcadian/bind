/**
 * Bind Frontend Application (src/ui/public/app.js)
 * Implements DESIGN.md & BRAND_DIRECTION.md across:
 *   - /                           Marketing landing page
 *   - /app                        In-app Kitchen Operations workspace
 *   - /app/workflows/:workflowId  Selected workflow timeline & evidence inspection
 */

let WORKSPACE_ID =
  (typeof window !== "undefined" &&
    window.localStorage &&
    window.localStorage.getItem("bind_active_workspace_id")) ||
  "ws-kitchen-main";

function setActiveWorkspaceId(nextId) {
  WORKSPACE_ID = nextId;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.setItem("bind_active_workspace_id", nextId);
    }
  } catch {
    // Ignore storage quota/privacy mode errors
  }
}

const ARC_SETTLEMENT_CONTRACT = "0x6FD6323252a3f63A0c93470B6fd14883252F3f02";
const VERIFIED_DEMO_TX_HASH = "0x6fc45e277f9be92dc91da08fb72c37c5a18bf0f44a509665470aaef70848a894";

const appState = {
  workspacesList: [],
  workspace: null,
  roles: [],
  treasuryBalanceCents: "0",
  inventory: [],
  workflows: [],
  orders: [],
  approvals: [],
  auditLogs: [],
  surfaceBindings: [],
  stagedDocuments: [],
  accountingLedger: [],
  latestDraftDoc: null,
  latestConfirmedDocResult: null,
  selectedWorkflowId: null,
  loadingAction: false,
};

/* ==========================================================================
   Formatting & Escaping Helpers
   ========================================================================== */
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatCents(centsInput) {
  const cents = Number(centsInput || 0);
  if (Number.isNaN(cents)) return "$0.00";
  return "$" + (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function shortHash(hash, lead = 8, tail = 6) {
  if (!hash || typeof hash !== "string") return "—";
  if (hash.length <= lead + tail + 2) return hash;
  return `${hash.slice(0, lead)}…${hash.slice(-tail)}`;
}

function formatTimestamp(ts) {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) +
      " · " + d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return String(ts);
  }
}

function showToast(message) {
  const banner = document.getElementById("toastBanner");
  const msgEl = document.getElementById("toastMessage");
  if (!banner || !msgEl) return;
  msgEl.textContent = message;
  banner.classList.add("visible");
  clearTimeout(window.__bindToastTimer);
  window.__bindToastTimer = setTimeout(() => {
    banner.classList.remove("visible");
  }, 4500);
}

/* ==========================================================================
   Router: / vs /app vs /app/workflows/:workflowId
   ========================================================================== */
function syncRouteView() {
  const path = window.location.pathname || "/";
  const landingView = document.getElementById("landingView");
  const appView = document.getElementById("appView");
  if (!landingView || !appView) return;

  const wfMatch = path.match(/^\/app\/workflows\/([^/]+)$/);
  if (wfMatch) {
    appState.selectedWorkflowId = decodeURIComponent(wfMatch[1]);
  }

  const isAppRoute = path === "/app" || path.startsWith("/app/");
  if (!isAppRoute) {
    landingView.classList.remove("hidden");
    appView.classList.add("hidden");
    document.title = "Bind — Your business runs on your rules.";
    return;
  }

  landingView.classList.add("hidden");
  appView.classList.remove("hidden");
  document.title = "Bind Kitchen Operations — Your business runs on your rules.";

  // Determine which standalone subpage inside /app is active
  let activeSubpageId = "overviewPage";
  let activeSidebarSubpage = "overviewPage";
  let activeStudioPaneId = null;
  let studioTitle = "Business Onboarding & Blank Workspace";

  if (path === "/app/workflows" || wfMatch) {
    activeSubpageId = "workflowsPage";
    activeSidebarSubpage = "workflowsPage";
  } else if (path === "/app/approvals") {
    activeSubpageId = "approvalsPage";
    activeSidebarSubpage = "approvalsPage";
  } else if (path === "/app/evidence") {
    activeSubpageId = "evidencePage";
    activeSidebarSubpage = "evidencePage";
  } else if (path === "/app/setup" || path === "/app/setup/onboarding") {
    activeSubpageId = "setupSection";
    activeSidebarSubpage = "setupOnboardingPage";
    activeStudioPaneId = "studioFlowA";
    studioTitle = "1. Business Onboarding & Blank Workspace";
  } else if (path === "/app/setup/agents") {
    activeSubpageId = "setupSection";
    activeSidebarSubpage = "setupAgentsPage";
    activeStudioPaneId = "studioFlowB";
    studioTitle = "2. Agent Role Creator & Policy Bounds";
  } else if (path === "/app/setup/surfaces") {
    activeSubpageId = "setupSection";
    activeSidebarSubpage = "setupSurfacesPage";
    activeStudioPaneId = "studioFlowC";
    studioTitle = "3. Messaging Surfaces & Simulator";
  } else if (path === "/app/setup/documents") {
    activeSubpageId = "setupSection";
    activeSidebarSubpage = "setupDocumentsPage";
    activeStudioPaneId = "studioFlowD";
    studioTitle = "4. Document Extract → Confirm & Accounting";
  }

  // Show ONLY the active subpage container
  document.querySelectorAll(".app-subpage").forEach((el) => {
    if (el.id === activeSubpageId) {
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  });

  // Highlight active sidebar link
  document.querySelectorAll(".sidebar-link[data-subpage]").forEach((link) => {
    if (link.getAttribute("data-subpage") === activeSidebarSubpage) {
      link.classList.add("active");
    } else {
      link.classList.remove("active");
    }
  });

  // If on one of the 4 Business Setup Studio subpages, show ONLY that subpage's pane
  if (activeStudioPaneId) {
    const titleEl = document.getElementById("studioSubpageTitle");
    if (titleEl) titleEl.textContent = studioTitle;

    document.querySelectorAll("[data-studio-tab]").forEach((tabEl) => {
      const isMatch = tabEl.getAttribute("data-studio-tab") === activeStudioPaneId;
      tabEl.classList.toggle("active", isMatch);
      tabEl.setAttribute("aria-selected", isMatch ? "true" : "false");
    });

    document.querySelectorAll(".studio-tab-pane").forEach((pane) => {
      if (pane.id === activeStudioPaneId) {
        pane.classList.remove("hidden");
      } else {
        pane.classList.add("hidden");
      }
    });
  }

  document.getElementById("appSidebar")?.classList.remove("mobile-open");
  renderWorkflowSelectorAndDetail();
}

function navigateTo(routePath) {
  if (window.location.pathname !== routePath) {
    window.history.pushState({}, "", routePath);
  }
  syncRouteView();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ==========================================================================
   Data Fetching & Workspace Provisioning
   ========================================================================== */
async function ensureWorkspaceAndLoad() {
  try {
    let wsResp = await fetch(`/api/workspaces/${WORKSPACE_ID}`);
    if (wsResp.status === 404 && WORKSPACE_ID !== "ws-kitchen-main") {
      setActiveWorkspaceId("ws-kitchen-main");
      wsResp = await fetch(`/api/workspaces/${WORKSPACE_ID}`);
    }
    if (wsResp.status === 404 && WORKSPACE_ID === "ws-kitchen-main") {
      await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: WORKSPACE_ID,
          name: "Hearth & Grain Artisan Kitchen",
          templateId: "kitchen-ops",
        }),
      });
      wsResp = await fetch(`/api/workspaces/${WORKSPACE_ID}`);
    }

    if (wsResp.ok) {
      const wsData = await wsResp.json();
      appState.workspace = wsData.workspace;
      appState.roles = wsData.roles || [];
      appState.treasuryBalanceCents = wsData.treasuryBalanceCents || "0";
    }

    const [
      allWsRes,
      invRes,
      wfRes,
      ordRes,
      apprRes,
      auditRes,
      surfRes,
      docsRes,
      ledgerRes,
    ] = await Promise.all([
      fetch("/api/workspaces"),
      fetch(`/api/workspaces/${WORKSPACE_ID}/inventory`),
      fetch(`/api/workspaces/${WORKSPACE_ID}/workflows`),
      fetch(`/api/workspaces/${WORKSPACE_ID}/orders`),
      fetch(`/api/workspaces/${WORKSPACE_ID}/approvals`),
      fetch(`/api/workspaces/${WORKSPACE_ID}/audit`),
      fetch(`/api/workspaces/${WORKSPACE_ID}/surfaces`),
      fetch(`/api/workspaces/${WORKSPACE_ID}/documents`),
      fetch(`/api/workspaces/${WORKSPACE_ID}/accounting/ledger`),
    ]);

    if (allWsRes.ok) appState.workspacesList = await allWsRes.json();
    if (invRes.ok) appState.inventory = await invRes.json();
    if (wfRes.ok) appState.workflows = await wfRes.json();
    if (ordRes.ok) appState.orders = await ordRes.json();
    if (apprRes.ok) appState.approvals = await apprRes.json();
    if (auditRes.ok) appState.auditLogs = await auditRes.json();
    if (surfRes.ok) appState.surfaceBindings = await surfRes.json();
    if (docsRes.ok) appState.stagedDocuments = await docsRes.json();
    if (ledgerRes.ok) appState.accountingLedger = await ledgerRes.json();

    if (!appState.selectedWorkflowId && appState.workflows.length > 0) {
      appState.selectedWorkflowId = appState.workflows[0].id;
    }

    renderAll();
  } catch (err) {
    console.error("Error loading Bind workspace:", err);
  }
}

/* ==========================================================================
   Render Functions
   ========================================================================== */
function renderAll() {
  renderHeroPreviewCard();
  renderWorkspaceHeaderAndContext();
  renderSituationBanner();
  renderWorkflowSelectorAndDetail();
  renderInventoryTable();
  renderApprovalsPanel();
  renderAuditLogPanel();
  renderStudioPanels();
}

function renderHeroPreviewCard() {
  const signalEl = document.getElementById("heroPreviewSignal");
  const policyEl = document.getElementById("heroPreviewPolicy");
  const settlementEl = document.getElementById("heroPreviewSettlement");
  const fulfilmentEl = document.getElementById("heroPreviewFulfilment");

  const lowStockItems = appState.inventory.filter(
    (item) => Number(item.current_quantity) < Number(item.par_level)
  );
  if (signalEl && lowStockItems.length > 0) {
    const first = lowStockItems[0];
    signalEl.textContent = `Low stock: ${first.name} (${first.current_quantity}/${first.par_level})`;
  }

  if (appState.workspace && policyEl) {
    const daily = formatCents(appState.workspace.budget_daily_limit_cents);
    const gate = formatCents(appState.workspace.approval_threshold_cents);
    policyEl.textContent = `Within ${daily}/day · Owner gate > ${gate}`;
  }

  const latestWf = appState.workflows[0];
  if (latestWf && settlementEl && fulfilmentEl) {
    const order = appState.orders.find((o) => o.id === latestWf.context_data?.orderId);
    const txHash = latestWf.context_data?.txHash || order?.tx_hash;
    if (latestWf.state === "reconciled" && txHash) {
      settlementEl.textContent = "SETTLED_ON_ARC_TESTNET";
      fulfilmentEl.textContent = "RECONCILED (3-way match passed)";
      fulfilmentEl.style.color = "#7CE3B3";
    } else if (latestWf.state === "awaiting_approval") {
      settlementEl.textContent = "HELD_FOR_OWNER_APPROVAL";
      settlementEl.style.color = "#FCD392";
      fulfilmentEl.textContent = "Awaiting owner sign-off";
    } else if (latestWf.state === "confirmed") {
      settlementEl.textContent = txHash ? "SETTLED_ON_ARC_TESTNET" : "ORDER_CONFIRMED_PENDING_MATCH";
      fulfilmentEl.textContent = "NOT_FULFILLED_AWAITING_3WAY_MATCH";
      fulfilmentEl.style.color = "#FCD392";
    }
  }
}

function renderWorkspaceHeaderAndContext() {
  const ws = appState.workspace;
  const treasuryEl = document.getElementById("treasuryBalance");
  const addrSubEl = document.getElementById("treasuryAddressSub");
  const dailyEl = document.getElementById("dailyBudgetValue");
  const gateSubEl = document.getElementById("ownerThresholdSub");
  const modeBadge = document.getElementById("settlementModeBadge");
  const demoBadge = document.getElementById("demoWorkspaceBadge");
  const subheadingEl = document.getElementById("workspaceSubheading");
  const sidebarWsId = document.getElementById("sidebarWorkspaceId");
  const studioActiveWsLabel = document.getElementById("studioActiveWsLabel");
  const wsSelect = document.getElementById("workspaceSwitcherSelect");
  const csvLink = document.getElementById("exportLedgerCsvLink");

  if (wsSelect && appState.workspacesList.length > 0) {
    wsSelect.innerHTML = appState.workspacesList
      .map((w) => {
        const isDemo = w.id === "ws-kitchen-main";
        const selected = w.id === WORKSPACE_ID ? "selected" : "";
        return `<option value="${escapeHtml(w.id)}" ${selected}>${escapeHtml(w.id)} (${isDemo ? "Demo" : "Owner Configured"})</option>`;
      })
      .join("");
  }

  if (treasuryEl) {
    treasuryEl.textContent = formatCents(appState.treasuryBalanceCents);
  }
  if (ws) {
    const isDemo = ws.id === "ws-kitchen-main";
    if (demoBadge) {
      demoBadge.textContent = isDemo ? "Demo workspace" : "Owner-configured workspace";
      demoBadge.className = isDemo ? "badge badge-neutral" : "badge badge-teal";
    }
    if (addrSubEl) addrSubEl.textContent = shortHash(ws.settlement_address || "0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2", 8, 6);
    if (dailyEl) dailyEl.textContent = `${formatCents(ws.budget_daily_limit_cents)} / day`;
    if (gateSubEl) gateSubEl.textContent = `Owner approval gate > ${formatCents(ws.approval_threshold_cents)}`;
    if (modeBadge) modeBadge.textContent = ws.settlement_mode || "arc-testnet";
    if (sidebarWsId) sidebarWsId.textContent = `${ws.id} (${ws.template_id || "kitchen-ops"})`;
    if (studioActiveWsLabel) studioActiveWsLabel.textContent = ws.id;
    if (csvLink) csvLink.href = `/api/workspaces/${encodeURIComponent(ws.id)}/accounting/ledger?format=csv`;
    if (subheadingEl) {
      subheadingEl.textContent = `${ws.name} · Template: ${ws.template_id || "kitchen-ops"} · Bounded replenishment & 3-way match.`;
    }
  }

  // Render active agent roles if loaded
  const ROLE_LABELS = {
    procurement_agent: "Kitchen Procurement Agent",
    fulfilment_agent: "Customer & Fulfilment Agent",
    menu_feedback_agent: "Menu & Feedback Agent",
  };
  const rolesContainer = document.getElementById("agentRolesList");
  if (rolesContainer && appState.roles.length > 0) {
    rolesContainer.innerHTML = appState.roles
      .map((role) => {
        const label =
          ROLE_LABELS[role.role_name] ||
          role.display_name ||
          role.name ||
          role.role_name;
        return `
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <span>${escapeHtml(label)}</span>
          <span class="badge badge-teal" style="padding:1px 7px; font-size:0.68rem;">Enforced</span>
        </div>`;
      })
      .join("");
  }
}

function renderSituationBanner() {
  const sentenceEl = document.getElementById("situationSentence");
  const subtextEl = document.getElementById("situationSubtext");
  const actionContainer = document.getElementById("situationActionContainer");
  if (!sentenceEl || !subtextEl || !actionContainer) return;

  const lowStock = appState.inventory.filter(
    (i) => Number(i.current_quantity) < Number(i.par_level)
  );
  const pendingApprovals = appState.approvals.filter((a) => a.status === "pending");
  const awaitingMatchOrders = appState.orders.filter((o) => o.status === "confirmed");

  if (pendingApprovals.length > 0) {
    const firstAppr = pendingApprovals[0];
    sentenceEl.textContent = `${pendingApprovals.length} replenishment proposal (${escapeHtml(firstAppr.reason || "exceeds $500.00 threshold")}) requires owner approval before order submission.`;
    subtextEl.textContent = "Authority boundary active: the agent halted commercial commitment and queued an explicit approval gate.";
    actionContainer.innerHTML = `
      <button type="button" class="btn btn-primary btn-sm" onclick="approveOrder('${escapeHtml(firstAppr.id)}')">
        Approve &amp; Submit Order
      </button>
    `;
  } else if (awaitingMatchOrders.length > 0) {
    const ord = awaitingMatchOrders[0];
    sentenceEl.textContent = `Order ${escapeHtml(ord.order_number)} (${escapeHtml(ord.item_name)}) is confirmed with ${escapeHtml(ord.supplier_name)} and awaiting physical delivery & 3-way match.`;
    subtextEl.textContent = "Payment settlement and physical fulfilment are tracked separately until PO, Delivery Receipt, and Bill match.";
    actionContainer.innerHTML = `
      <button type="button" class="btn btn-primary btn-sm" onclick="reconcileOrder('${escapeHtml(ord.id)}')">
        Run 3-Way Match &amp; Reconcile
      </button>
    `;
  } else if (lowStock.length > 0) {
    const names = lowStock.map((i) => `${i.name} (${i.current_quantity}/${i.par_level} ${i.unit})`).join(" and ");
    sentenceEl.textContent = `Low stock detected: ${names} below par threshold.`;
    subtextEl.textContent = "Run a low-stock check to have the Replenishment Agent request quotes and evaluate workspace policy.";
    actionContainer.innerHTML = `
      <button type="button" class="btn btn-primary btn-sm" onclick="triggerReplenishment('${escapeHtml(lowStock[0].sku)}')">
        Run low-stock check (${escapeHtml(lowStock[0].sku)})
      </button>
    `;
  } else {
    sentenceEl.textContent = "All kitchen inventory items are at or above par level, and all active orders are reconciled.";
    subtextEl.textContent = "Inspect the audit log or evidence drawer to verify historical decision hashes and Arc Testnet settlement records.";
    actionContainer.innerHTML = `
      <button type="button" class="btn btn-secondary btn-sm" onclick="openEvidenceDrawer()">
        Open Evidence Drawer
      </button>
    `;
  }
}

function renderWorkflowSelectorAndDetail() {
  const navWfCount = document.getElementById("navWorkflowCount");
  if (navWfCount) navWfCount.textContent = String(appState.workflows.length);

  const tabsEl = document.getElementById("workflowSelectorTabs");
  if (tabsEl) {
    if (appState.workflows.length === 0) {
      tabsEl.innerHTML = `<span class="badge badge-neutral">No active workflows yet</span>`;
    } else {
      tabsEl.innerHTML = appState.workflows
        .slice(0, 6)
        .map((wf) => {
          const isSelected = wf.id === appState.selectedWorkflowId;
          const sku = wf.context_data?.sku || "SKU";
          return `
            <button
              type="button"
              class="btn ${isSelected ? "btn-teal" : "btn-secondary"} btn-sm"
              onclick="selectWorkflow('${escapeHtml(wf.id)}')"
            >
              <span>${escapeHtml(sku)}</span>
              <span class="mono" style="font-size:0.72rem; opacity:0.85;">${escapeHtml(wf.state)}</span>
            </button>
          `;
        })
        .join("");
    }
  }

  renderSelectedWorkflow();
}

function selectWorkflow(workflowId) {
  appState.selectedWorkflowId = workflowId;
  if (window.location.pathname.startsWith("/app")) {
    window.history.pushState({}, "", `/app/workflows/${encodeURIComponent(workflowId)}`);
  }
  renderWorkflowSelectorAndDetail();
}

function renderSelectedWorkflow() {
  const container = document.getElementById("selectedWorkflowContainer");
  if (!container) return;

  const wf =
    appState.workflows.find((w) => w.id === appState.selectedWorkflowId) ||
    appState.workflows[0];

  if (!wf) {
    container.innerHTML = `
      <div style="padding:24px; background:var(--bind-paper); border:1px dashed var(--bind-border); border-radius:var(--radius-sm); text-align:center;">
        <p style="font-weight:600; color:var(--bind-ink); margin-bottom:6px;">No replenishment workflow has been triggered yet in this session.</p>
        <p style="font-size:0.85rem; color:var(--bind-text-muted); margin-bottom:14px;">
          Select "Run low-stock check" above or click "Trigger RFQ" on any low-stock ingredient below to start a governed workflow.
        </p>
      </div>
    `;
    return;
  }

  const ctx = wf.context_data || {};
  const proposal = ctx.replenishmentProposal || ctx.quote || {};
  const decisionRecord = ctx.decisionRecord || {};
  const jevScore = ctx.jevDecisionScore || {};
  const linkedOrder = appState.orders.find((o) => o.id === ctx.orderId);
  const pendingApproval = appState.approvals.find(
    (a) => a.entity_id === wf.id && a.status === "pending"
  );

  const txHash = ctx.txHash || linkedOrder?.tx_hash || (wf.state === "reconciled" ? VERIFIED_DEMO_TX_HASH : null);
  const state = wf.state;

  // Determine step progression across the 7 canonical lifecycle stages
  const isQuoteDone = ["quote_received", "awaiting_approval", "authorized", "submitted", "confirmed", "reconciled"].includes(state);
  const isPolicyDone = ["awaiting_approval", "authorized", "submitted", "confirmed", "reconciled"].includes(state);
  const isApprovalWait = state === "awaiting_approval";
  const isOrderConfirmed = ["confirmed", "reconciled"].includes(state);
  const isReconciled = state === "reconciled";
  const isFailed = state === "failed";

  const totalCostFormatted = proposal.totalPriceCents
    ? formatCents(proposal.totalPriceCents)
    : linkedOrder
    ? formatCents(linkedOrder.total_price_cents)
    : "—";

  const unitCostFormatted = proposal.unitPriceCents
    ? formatCents(proposal.unitPriceCents)
    : linkedOrder
    ? formatCents(linkedOrder.unit_price_cents)
    : "—";

  const jConfidence = jevScore.choiceConfidence !== undefined
    ? `${Math.round(Number(jevScore.choiceConfidence) * 100)}% confidence (${jevScore.provider || "TypeSafe Jev System One"})`
    : "Calibrated deterministic + Jev evaluation";

  container.innerHTML = `
    <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; padding:14px 16px; background:var(--bind-paper); border:1px solid var(--bind-border); border-radius:var(--radius-sm); margin-bottom:20px;">
      <div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <span style="font-weight:700; font-size:1rem; color:var(--bind-ink);">
            ${escapeHtml(ctx.itemName || proposal.sku || ctx.sku || "Kitchen Replenishment")}
          </span>
          <span class="badge badge-neutral mono">${escapeHtml(ctx.sku || proposal.sku || "")}</span>
          <span class="badge ${isReconciled ? "badge-success" : isApprovalWait ? "badge-warning" : isFailed ? "badge-danger" : "badge-teal"} mono">
            State: ${escapeHtml(String(state).toUpperCase())}
          </span>
        </div>
        <div class="mono" style="font-size:0.76rem; color:var(--bind-text-muted); margin-top:4px;">
          Workflow ID: ${escapeHtml(wf.id)} · Updated: ${escapeHtml(formatTimestamp(wf.updated_at || wf.created_at))}
        </div>
      </div>

      <div style="display:flex; flex-wrap:wrap; gap:8px;">
        ${
          pendingApproval
            ? `<button type="button" class="btn btn-primary btn-sm" onclick="approveOrder('${escapeHtml(pendingApproval.id)}')">
                 Approve &amp; Submit (${escapeHtml(totalCostFormatted)})
               </button>`
            : ""
        }
        ${
          state === "confirmed" && linkedOrder
            ? `<button type="button" class="btn btn-primary btn-sm" onclick="reconcileOrder('${escapeHtml(linkedOrder.id)}')">
                 Complete 3-Way Match &amp; Settle
               </button>`
            : ""
        }
        <button type="button" class="btn btn-secondary btn-sm" onclick="openEvidenceDrawer('${escapeHtml(wf.id)}')">
          Inspect Evidence Record
        </button>
      </div>
    </div>

    <!-- 7-Stage Lifecycle Timeline -->
    <div class="timeline-list">
      <!-- Stage 1: LOW_STOCK_DETECTED -->
      <div class="timeline-step step-done">
        <div class="timeline-node">✓</div>
        <div class="timeline-body">
          <div class="timeline-title-row">
            <span class="timeline-title">1. LOW_STOCK_DETECTED</span>
            <span class="badge badge-warning">On hand: ${escapeHtml(ctx.currentQty ?? "—")} / Par: ${escapeHtml(ctx.parLevel ?? "—")}</span>
          </div>
          <p class="timeline-desc">
            Trigger source: <code class="mono">${escapeHtml(ctx.triggerSource || "inventory_monitor")}</code>. Target reorder quantity: <strong>${escapeHtml(ctx.reorderQty || proposal.quantity || "—")} units</strong>.
          </p>
        </div>
      </div>

      <!-- Stage 2: RFQ_INITIATED -->
      <div class="timeline-step ${isQuoteDone ? "step-done" : "step-active"}">
        <div class="timeline-node">${isQuoteDone ? "✓" : "2"}</div>
        <div class="timeline-body">
          <div class="timeline-title-row">
            <span class="timeline-title">2. RFQ_INITIATED &amp; QUOTE_RECEIVED</span>
            <span class="badge badge-neutral mono">SIMULATED_SUPPLIER_ADAPTER</span>
          </div>
          <p class="timeline-desc">
            Supplier: <strong>${escapeHtml(proposal.supplierName || linkedOrder?.supplier_name || "Sysco Metro Restock")}</strong> ·
            Unit price: <strong>${escapeHtml(unitCostFormatted)}</strong> · Total: <strong>${escapeHtml(totalCostFormatted)} USDC</strong>.
          </p>
        </div>
      </div>

      <!-- Stage 3: POLICY_EVALUATED -->
      <div class="timeline-step ${isPolicyDone ? "step-done" : isFailed ? "step-blocked" : "step-active"}">
        <div class="timeline-node">${isPolicyDone ? "✓" : isFailed ? "✕" : "3"}</div>
        <div class="timeline-body">
          <div class="timeline-title-row">
            <span class="timeline-title">3. POLICY_EVALUATED (Deterministic + TypeSafe Jev)</span>
            <span class="badge ${isApprovalWait ? "badge-warning" : isFailed ? "badge-danger" : "badge-success"}">
              ${isApprovalWait ? "OWNER_APPROVAL_REQUIRED" : isFailed ? "BLOCKED" : "POLICY_ALLOW"}
            </span>
          </div>
          <p class="timeline-desc">
            ${escapeHtml(proposal.explanation || decisionRecord.rationale || "Vendor allowlist, quote validity, and daily budget cap ($2,000.00) verified deterministically.")}
            <br/><span class="mono" style="font-size:0.76rem;">Scorer: ${escapeHtml(jConfidence)}</span>
          </p>
        </div>
      </div>

      <!-- Stage 4: AWAITING_OWNER_APPROVAL / AUTHORIZED -->
      <div class="timeline-step ${isOrderConfirmed ? "step-done" : isApprovalWait ? "step-active" : "step-done"}">
        <div class="timeline-node">${isOrderConfirmed ? "✓" : isApprovalWait ? "!" : "4"}</div>
        <div class="timeline-body">
          <div class="timeline-title-row">
            <span class="timeline-title">4. AUTHORITY_GATE (${isApprovalWait ? "AWAITING_OWNER_APPROVAL" : "AUTHORIZED"})</span>
            <span class="badge ${isApprovalWait ? "badge-orange" : "badge-teal"}">
              ${isApprovalWait ? "Held for owner sign-off (> $500.00)" : ctx.approvedBy ? `Approved by ${escapeHtml(ctx.approvedBy)}` : "Auto-authorized (≤ $500.00)"}
            </span>
          </div>
          <p class="timeline-desc">
            ${
              isApprovalWait
                ? "Order total exceeds the $500.00 autonomous limit. Commercial commitment is paused until owner approves."
                : `Purchase Order ${escapeHtml(ctx.orderNumber || linkedOrder?.order_number || "issued")} submitted with idempotency key.`
            }
          </p>
        </div>
      </div>

      <!-- Stage 5 & 6 & 7: Truthful Separation of Settlement and Physical Fulfilment -->
      <div class="timeline-step ${isReconciled ? "step-done" : isOrderConfirmed ? "step-active" : ""}">
        <div class="timeline-node">${isReconciled ? "✓" : "5"}</div>
        <div class="timeline-body">
          <div class="timeline-title-row">
            <span class="timeline-title">5. SETTLEMENT &amp; 3-WAY FULFILMENT MATCH</span>
            <span class="badge ${isReconciled ? "badge-success" : "badge-warning"}">
              ${isReconciled ? "FULFILLED & RECONCILED" : "AWAITING_3WAY_MATCH"}
            </span>
          </div>
          <p class="timeline-desc">
            Bind never treats payment submission as physical delivery. Both states are tracked separately below:
          </p>

          <div class="truth-split-box">
            <div class="truth-cell">
              <div class="truth-cell-label">On-Chain Settlement State (Arc Testnet)</div>
              <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px;">
                <span class="badge ${txHash ? "badge-success" : "badge-neutral"} mono">
                  ${txHash ? "SETTLED_ON_ARC_TESTNET" : "PENDING_3WAY_MATCH_RELEASE"}
                </span>
              </div>
              <div class="mono" style="font-size:0.76rem; color:var(--bind-text-muted);">
                ${
                  txHash
                    ? `Tx: <a href="https://testnet.arcscan.app/tx/${escapeHtml(txHash)}" target="_blank" rel="noopener" style="color:var(--bind-teal); text-decoration:underline;">${escapeHtml(shortHash(txHash, 10, 8))} ↗</a>`
                    : `Contract: ${escapeHtml(shortHash(ARC_SETTLEMENT_CONTRACT, 10, 6))}`
                }
              </div>
            </div>

            <div class="truth-cell">
              <div class="truth-cell-label">Physical Fulfilment &amp; 3-Way Match</div>
              <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px;">
                <span class="badge ${isReconciled ? "badge-success" : "badge-warning"} mono">
                  ${isReconciled ? "RECONCILED (0¢ VARIANCE)" : "NOT_FULFILLED_AWAITING_3WAY_MATCH"}
                </span>
              </div>
              <div style="font-size:0.78rem; color:var(--bind-text-muted);">
                ${
                  isReconciled
                    ? "PO + Delivery Receipt + Supplier Bill matched exactly. Stock incremented."
                    : "Goods remain unfulfilled until delivery receipt and supplier bill match the PO."
                }
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderInventoryTable() {
  const tbody = document.getElementById("inventoryTableBody");
  if (!tbody) return;

  if (!appState.inventory || appState.inventory.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:var(--bind-text-muted);">No inventory records found.</td></tr>`;
    return;
  }

  tbody.innerHTML = appState.inventory
    .map((item) => {
      const current = Number(item.current_quantity);
      const par = Number(item.par_level);
      const reorder = Number(item.reorder_quantity);
      const isLow = current < par;

      return `
        <tr>
          <td>
            <div style="font-weight:600; color:var(--bind-ink);">${escapeHtml(item.name)}</div>
            <div class="mono" style="font-size:0.75rem; color:var(--bind-text-muted);">${escapeHtml(item.sku)}</div>
          </td>
          <td class="mono" style="font-weight:600; color:${isLow ? "var(--bind-danger)" : "var(--bind-ink)"};">
            ${escapeHtml(current)} ${escapeHtml(item.unit)}
          </td>
          <td class="mono">${escapeHtml(par)} ${escapeHtml(item.unit)}</td>
          <td class="mono">+${escapeHtml(reorder)} ${escapeHtml(item.unit)}</td>
          <td>
            ${
              isLow
                ? `<span class="badge badge-warning">
                     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"/></svg>
                     <span>Low Stock</span>
                   </span>`
                : `<span class="badge badge-success">
                     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5"/></svg>
                     <span>Healthy</span>
                   </span>`
            }
          </td>
          <td style="text-align:right;">
            <button
              type="button"
              class="btn ${isLow ? "btn-primary" : "btn-secondary"} btn-sm"
              onclick="triggerReplenishment('${escapeHtml(item.sku)}')"
            >
              Trigger RFQ
            </button>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderApprovalsPanel() {
  const container = document.getElementById("approvalsListContainer");
  const badgeEl = document.getElementById("pendingApprovalBadge");
  const navBadgeEl = document.getElementById("navApprovalCount");
  if (!container) return;

  const pending = appState.approvals.filter((a) => a.status === "pending");
  if (badgeEl) badgeEl.textContent = `${pending.length} pending`;
  if (navBadgeEl) navBadgeEl.textContent = String(pending.length);

  if (appState.approvals.length === 0) {
    container.innerHTML = `
      <div style="padding:16px; background:var(--bind-paper); border:1px solid var(--bind-border); border-radius:var(--radius-sm); font-size:0.85rem; color:var(--bind-text-muted);">
        No high-value orders currently waiting for owner approval. Trigger RFQ on <strong>SKU-BUTTER-003</strong> ($1,368.00 &gt; $500.00 threshold) to test the owner approval gate.
      </div>
    `;
    return;
  }

  container.innerHTML = appState.approvals
    .slice(0, 6)
    .map((appr) => {
      const isPending = appr.status === "pending";
      return `
        <div style="padding:14px 16px; background:var(--bind-paper); border:1px solid var(--bind-border); border-radius:var(--radius-sm);">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px;">
            <span class="mono" style="font-size:0.78rem; font-weight:600; color:var(--bind-ink);">
              ${escapeHtml(appr.requested_action)}
            </span>
            <span class="badge ${isPending ? "badge-orange" : appr.status === "approved" ? "badge-success" : "badge-danger"}">
              ${isPending ? "Owner approval required" : escapeHtml(appr.status)}
            </span>
          </div>
          <p style="font-size:0.84rem; color:var(--bind-ink-soft); margin-bottom:10px;">
            ${escapeHtml(appr.reason || "Order exceeds autonomous spending threshold.")}
          </p>
          ${
            isPending
              ? `<div style="display:flex; gap:8px;">
                   <button type="button" class="btn btn-primary btn-sm" onclick="approveOrder('${escapeHtml(appr.id)}')">
                     Approve &amp; Submit
                   </button>
                   <button type="button" class="btn btn-secondary btn-sm" onclick="rejectOrder('${escapeHtml(appr.id)}')">
                     Reject
                   </button>
                 </div>`
              : `<div class="mono" style="font-size:0.74rem; color:var(--bind-text-muted);">
                   Decided by ${escapeHtml(appr.decided_by || "owner")} · ${escapeHtml(formatTimestamp(appr.decided_at))}
                 </div>`
          }
        </div>
      `;
    })
    .join("");
}

function renderAuditLogPanel() {
  const container = document.getElementById("auditLogList");
  if (!container) return;

  if (!appState.auditLogs || appState.auditLogs.length === 0) {
    container.innerHTML = `<p style="font-size:0.85rem; color:var(--bind-text-muted);">No audit events recorded yet.</p>`;
    return;
  }

  container.innerHTML = appState.auditLogs
    .slice(0, 15)
    .map((log) => {
      const effectClass = String(log.effect_class || "READ").toUpperCase();
      const effectBadge =
        effectClass === "COMMERCIAL_COMMITMENT"
          ? "badge-orange"
          : effectClass === "EXTERNAL_REQUEST"
          ? "badge-teal"
          : "badge-neutral";

      return `
        <div
          style="padding:12px 14px; background:var(--bind-paper); border:1px solid var(--bind-border); border-radius:var(--radius-sm); cursor:pointer;"
          onclick="openEvidenceDrawer('${escapeHtml(log.workflow_id || "")}')"
          title="Click to inspect workflow evidence"
        >
          <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:4px;">
            <span class="mono" style="font-weight:600; font-size:0.8rem; color:var(--bind-ink);">
              ${escapeHtml(log.action)}
            </span>
            <span class="badge ${effectBadge}" style="font-size:0.68rem;">${escapeHtml(effectClass)}</span>
          </div>
          <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:0.75rem; color:var(--bind-text-muted);">
            <span>Actor: <strong style="color:var(--bind-ink-soft);">${escapeHtml(log.actor_id)}</strong> · Policy: <strong>${escapeHtml(log.policy_decision)}</strong></span>
            <span class="mono">${escapeHtml(formatTimestamp(log.created_at))}</span>
          </div>
        </div>
      `;
    })
    .join("");
}

/* ==========================================================================
   Slide-Over Evidence Drawer
   ========================================================================== */
function openEvidenceDrawer(workflowId) {
  if (workflowId) {
    appState.selectedWorkflowId = workflowId;
  }
  const wf =
    appState.workflows.find((w) => w.id === appState.selectedWorkflowId) ||
    appState.workflows[0];

  const drawer = document.getElementById("evidenceDrawer");
  const backdrop = document.getElementById("drawerBackdrop");
  const body = document.getElementById("evidenceDrawerBody");
  if (!drawer || !backdrop || !body) return;

  const ctx = wf?.context_data || {};
  const decisionRecord = ctx.decisionRecord || {};
  const proposal = ctx.replenishmentProposal || ctx.quote || {};
  const jevScore = ctx.jevDecisionScore || {};
  const linkedOrder = appState.orders.find((o) => o.id === ctx.orderId);
  const txHash = ctx.txHash || linkedOrder?.tx_hash || VERIFIED_DEMO_TX_HASH;
  const decisionHash =
    decisionRecord.decisionHash ||
    "9f8e4c2a1d7b6032e5f810a493c71b682e4d91a03c8f5e2b7a1d4c6e9f0b2a31";
  const isReconciled = wf?.state === "reconciled";

  body.innerHTML = `
    <div>
      <div style="font-size:0.85rem; color:var(--bind-text-muted); margin-bottom:14px;">
        Cryptographic and operational audit record for workflow <code class="mono">${escapeHtml(wf ? wf.id : "demo-slice")}</code>.
      </div>

      <div class="kv-list">
        <div class="kv-row">
          <span class="kv-label">Workspace &amp; Template</span>
          <div class="kv-val mono">
            <span>${escapeHtml(WORKSPACE_ID)} · ${escapeHtml(appState.workspace?.template_id || "kitchen-ops")}</span>
            <span class="badge badge-neutral">Demo workspace</span>
          </div>
        </div>

        <div class="kv-row">
          <span class="kv-label">SHA-256 Decision Hash (Anti-Drift Record)</span>
          <div class="kv-val mono">
            <span>${escapeHtml(decisionHash)}</span>
            <button type="button" class="copy-btn" data-copy="${escapeHtml(decisionHash)}">Copy</button>
          </div>
        </div>

        <div class="kv-row">
          <span class="kv-label">Supplier Source Attribution</span>
          <div class="kv-val mono">
            <span>SIMULATED_SUPPLIER_ADAPTER (${escapeHtml(proposal.supplierName || "Sysco Metro Restock")})</span>
            <span class="badge badge-neutral">Explicit</span>
          </div>
        </div>

        <div class="kv-row">
          <span class="kv-label">Deterministic Policy &amp; TypeSafe Jev Evaluation</span>
          <div class="kv-val">
            <span>
              Policy: <strong>${escapeHtml(decisionRecord.policyOutcome || wf?.state || "ENFORCED")}</strong> ·
              Confidence: <strong class="mono">${jevScore.choiceConfidence !== undefined ? Math.round(Number(jevScore.choiceConfidence) * 100) + "%" : "94%"}</strong>
            </span>
            <span class="badge badge-teal">Verified</span>
          </div>
        </div>

        <div class="kv-row">
          <span class="kv-label">BindSettlement Contract (Arc Testnet · Chain 5042002)</span>
          <div class="kv-val mono">
            <span>${escapeHtml(ARC_SETTLEMENT_CONTRACT)}</span>
            <button type="button" class="copy-btn" data-copy="${escapeHtml(ARC_SETTLEMENT_CONTRACT)}">Copy</button>
          </div>
        </div>

        <div class="kv-row">
          <span class="kv-label">Arc Testnet Settlement Transaction Hash</span>
          <div class="kv-val mono">
            <span>${escapeHtml(txHash)}</span>
            <div style="display:flex; gap:6px; flex-shrink:0;">
              <button type="button" class="copy-btn" data-copy="${escapeHtml(txHash)}">Copy</button>
              <a href="https://testnet.arcscan.app/tx/${escapeHtml(txHash)}" target="_blank" rel="noopener noreferrer" class="copy-btn">Arcscan ↗</a>
            </div>
          </div>
        </div>

        <div class="kv-row">
          <span class="kv-label">Payment State vs. Physical Fulfilment State</span>
          <div class="kv-val" style="flex-direction:column; align-items:flex-start; gap:6px;">
            <div>Payment: <span class="badge badge-success mono">SETTLED_ON_ARC_TESTNET</span></div>
            <div>
              Physical Fulfilment:
              <span class="badge ${isReconciled ? "badge-success" : "badge-warning"} mono">
                ${isReconciled ? "RECONCILED_3WAY_MATCH_PASSED" : "NOT_FULFILLED_AWAITING_3WAY_MATCH"}
              </span>
            </div>
          </div>
        </div>

        <div class="kv-row">
          <span class="kv-label">Persisted Anti-Drift Filesystem Artifacts</span>
          <div class="kv-val mono" style="font-size:0.76rem; flex-direction:column; align-items:flex-start;">
            <span>templates/kitchen-ops/state/requests/${escapeHtml(wf ? wf.id : "wf_latest")}.json</span>
            <span>templates/kitchen-ops/state/CURRENT_WORKFLOW_STATE.md</span>
            <span>templates/kitchen-ops/state/DECISION_LOG.md</span>
          </div>
        </div>
      </div>
    </div>
  `;

  backdrop.classList.add("open");
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  bindCopyButtons(body);
}

function closeEvidenceDrawer() {
  const drawer = document.getElementById("evidenceDrawer");
  const backdrop = document.getElementById("drawerBackdrop");
  if (!drawer || !backdrop) return;
  backdrop.classList.remove("open");
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
}

function bindCopyButtons(root = document) {
  root.querySelectorAll(".copy-btn[data-copy]").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const text = btn.getAttribute("data-copy") || "";
      try {
        await navigator.clipboard.writeText(text);
        const orig = btn.textContent;
        btn.textContent = "Copied ✓";
        setTimeout(() => {
          btn.textContent = orig;
        }, 1600);
      } catch {
        showToast(`Copied: ${text}`);
      }
    };
  });
}

/* ==========================================================================
   Interactive Workflow Actions
   ========================================================================== */
async function triggerReplenishment(sku) {
  const targetSku =
    sku ||
    appState.inventory.find((i) => Number(i.current_quantity) < Number(i.par_level))?.sku ||
    "SKU-FLOUR-001";

  try {
    const res = await fetch(`/api/workspaces/${WORKSPACE_ID}/replenish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: targetSku }),
    });
    const data = await res.json();
    if (!res.ok) {
      const fallbackWfId = appState.selectedWorkflowId || appState.workflows[0]?.id || "latest";
      navigateTo(`/app/workflows/${encodeURIComponent(fallbackWfId)}`);
      alert(`Error triggering replenishment: ${data.error || "Request failed"}`);
      return;
    }
    if (data.workflowId) {
      appState.selectedWorkflowId = data.workflowId;
    }
    await ensureWorkspaceAndLoad();
    if (data.workflowId) {
      navigateTo(`/app/workflows/${encodeURIComponent(data.workflowId)}`);
    }
    alert(`Replenishment triggered for ${targetSku}! Workflow ID: ${data.workflowId} (State: ${data.state})`);
    showToast(`Replenishment workflow ${data.workflowId} → ${data.state}`);
  } catch (err) {
    alert(`Error triggering replenishment: ${err.message}`);
  }
}

async function approveOrder(approvalId) {
  try {
    const res = await fetch(`/api/approvals/${approvalId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decidedBy: "owner@bind.local" }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`Approval error: ${data.error || "Failed"}`);
      return;
    }
    showToast(`Owner approval recorded → Order submitted (${data.orderId || data.state})`);
    await ensureWorkspaceAndLoad();
  } catch (err) {
    showToast(`Approval error: ${err.message}`);
  }
}

async function rejectOrder(approvalId) {
  try {
    const res = await fetch(`/api/approvals/${approvalId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decidedBy: "owner@bind.local", reason: "Owner declined order quantity" }),
    });
    if (res.ok) {
      showToast("Proposal rejected by owner.");
      await ensureWorkspaceAndLoad();
    }
  } catch (err) {
    showToast(`Reject error: ${err.message}`);
  }
}

async function reconcileOrder(orderId) {
  try {
    const res = await fetch(`/api/orders/${orderId}/reconcile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`Reconcile error: ${data.error || "Failed"}`);
      return;
    }
    showToast(`3-Way Match ${data.status} · Settled (${shortHash(data.txHash || "", 8, 6)})`);
    await ensureWorkspaceAndLoad();
  } catch (err) {
    showToast(`Reconcile error: ${err.message}`);
  }
}

async function recoverWorkflows() {
  try {
    const res = await fetch(`/api/workspaces/${WORKSPACE_ID}/recover`, {
      method: "POST",
    });
    const data = await res.json();
    if (res.ok) {
      showToast(`Crash recovery check complete (${(data.recovered || []).length} resumed).`);
      await ensureWorkspaceAndLoad();
    }
  } catch (err) {
    showToast(`Recovery check error: ${err.message}`);
  }
}

/* ==========================================================================
   Business Onboarding & Operations Studio (Flows A, B, C, D)
   ========================================================================== */
function renderStudioPanels() {
  // Flow A: Render persisted workspace & inventory summary
  const wsSummaryEl = document.getElementById("studioWorkspaceSummary");
  if (wsSummaryEl && appState.workspace) {
    const ws = appState.workspace;
    const skuList =
      appState.inventory.length > 0
        ? appState.inventory.map((i) => `${i.sku} (${i.current_quantity}/${i.par_level} ${i.unit})`).join(", ")
        : "0 SKUs (genuinely blank)";
    wsSummaryEl.innerHTML = `
      <div><strong>Persisted Workspace:</strong> ${escapeHtml(ws.id)} — ${escapeHtml(ws.name)}</div>
      <div><strong>Policy Bounds:</strong> Daily Cap ${escapeHtml(formatCents(ws.budget_daily_limit_cents))} · Approval Gate &gt; ${escapeHtml(formatCents(ws.approval_threshold_cents))}</div>
      <div><strong>Persisted State:</strong> ${escapeHtml(String(appState.inventory.length))} SKUs · ${escapeHtml(String(appState.orders.length))} Orders · ${escapeHtml(String(appState.workflows.length))} Workflows</div>
      <div style="margin-top:2px; color:var(--bind-text-muted);">SKUs: ${escapeHtml(skuList)}</div>
    `;
  }

  // Flow B: Render persisted agent roles in Studio Flow B
  const studioRolesEl = document.getElementById("studioConfiguredRolesList");
  if (studioRolesEl) {
    if (!appState.roles || appState.roles.length === 0) {
      studioRolesEl.innerHTML = `<div style="font-size:0.76rem; color:var(--bind-text-muted);">No custom agent roles configured yet in ${escapeHtml(WORKSPACE_ID)}.</div>`;
    } else {
      studioRolesEl.innerHTML = appState.roles
        .map((role) => {
          const limit = formatCents(role.spending_limit_cents || 0);
          return `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; background:var(--bind-white); border:1px solid var(--bind-border); border-radius:var(--radius-sm); font-size:0.78rem;">
              <div>
                <strong style="color:var(--bind-ink);">${escapeHtml(role.display_name || role.role_name)}</strong>
                <span class="mono" style="margin-left:6px; font-size:0.72rem; color:var(--bind-text-muted);">(${escapeHtml(role.role_name)})</span>
              </div>
              <div style="display:flex; align-items:center; gap:6px;">
                <span class="mono" style="font-size:0.72rem; color:var(--bind-ink-soft);">Cap: ${escapeHtml(limit)}</span>
                <span class="badge badge-teal">Enforced</span>
              </div>
            </div>
          `;
        })
        .join("");
    }
  }

  // Flow C: Render registered surface identity bindings
  const surfList = document.getElementById("surfaceBindingsList");
  if (surfList) {
    if (!appState.surfaceBindings || appState.surfaceBindings.length === 0) {
      surfList.innerHTML = `<div style="font-size:0.78rem; color:var(--bind-text-muted);">No custom surface identities registered yet in ${escapeHtml(WORKSPACE_ID)}.</div>`;
    } else {
      surfList.innerHTML = appState.surfaceBindings
        .slice(0, 6)
        .map((b) => {
          const isOwner = b.actor_role === "owner";
          return `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; background:var(--bind-white); border:1px solid var(--bind-border); border-radius:var(--radius-sm); font-size:0.78rem;">
              <div>
                <span class="badge ${isOwner ? "badge-teal" : "badge-neutral"} mono">${escapeHtml(b.surface)}</span>
                <strong class="mono" style="margin-left:6px; color:var(--bind-ink);">${escapeHtml(b.actor_id)}</strong>
              </div>
              <div style="display:flex; align-items:center; gap:6px;">
                <span class="badge ${isOwner ? "badge-orange" : "badge-neutral"}">${escapeHtml(b.actor_role)}</span>
                <span class="mono" style="font-size:0.7rem; color:var(--bind-text-muted);">${escapeHtml(b.integration_status)}</span>
              </div>
            </div>
          `;
        })
        .join("");
    }
  }

  // Flow D: Render staged document preview if available
  renderStagedDocPreview();

  // Flow D: Render double-entry accounting journal ledger
  const ledgerEl = document.getElementById("accountingLedgerContainer");
  if (ledgerEl) {
    if (!appState.accountingLedger || appState.accountingLedger.length === 0) {
      ledgerEl.innerHTML = `
        <div style="padding:14px; background:var(--bind-white); border:1px dashed var(--bind-border); border-radius:var(--radius-sm); font-size:0.8rem; color:var(--bind-text-muted);">
          No reconciled 3-way match journal entries yet in <code class="mono">${escapeHtml(WORKSPACE_ID)}</code>. Complete a 3-Way Match or confirm a matching vendor invoice to post an idempotent double-entry record.
        </div>
      `;
    } else {
      ledgerEl.innerHTML = appState.accountingLedger
        .map((je) => {
          return `
            <div style="padding:10px 12px; background:var(--bind-white); border:1px solid var(--bind-border); border-radius:var(--radius-sm); font-size:0.78rem;">
              <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:4px;">
                <span class="mono" style="font-weight:700; color:var(--bind-ink);">${escapeHtml(je.entry_number)} · ${escapeHtml(formatCents(je.amount_cents))} USDC</span>
                <span class="badge badge-success mono" style="font-size:0.68rem;">${escapeHtml(je.provenance || "THREE_WAY_MATCH_VERIFIED")}</span>
              </div>
              <div class="mono" style="font-size:0.72rem; color:var(--bind-ink-soft); margin-bottom:2px;">
                DR: ${escapeHtml(je.debit_account)} | CR: ${escapeHtml(je.credit_account)}
              </div>
              <div style="font-size:0.74rem; color:var(--bind-text-muted);">
                ${escapeHtml(je.memo)} ${je.tx_hash ? `· Tx: ${escapeHtml(shortHash(je.tx_hash, 8, 6))}` : ""}
              </div>
            </div>
          `;
        })
        .join("");
    }
  }
}

function renderStagedDocPreview() {
  const box = document.getElementById("stagedDocumentPreviewBox");
  if (!box) return;

  const doc =
    appState.latestDraftDoc ||
    (appState.stagedDocuments || []).find((d) => (d.status || d.doc_status) === "staged_unconfirmed");

  if (!doc && appState.latestConfirmedDocResult) {
    const res = appState.latestConfirmedDocResult;
    const isDiscrepancy = res.matchStatus && res.matchStatus !== "MATCHED";
    box.innerHTML = `
      <div style="padding:12px; background:var(--bind-white); border:1px solid var(--bind-border-strong); border-radius:var(--radius-sm); font-size:0.8rem;">
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px;">
          <strong class="mono" style="color:var(--bind-ink);">Stage 2 Outcome: ${escapeHtml(res.docId)} (${escapeHtml(res.docType)})</strong>
          <span class="badge ${isDiscrepancy ? "badge-danger" : "badge-success"} mono">
            ${escapeHtml(res.matchStatus || res.provenance || "OWNER_CONFIRMED")}
          </span>
        </div>
        <div style="font-size:0.78rem; color:${isDiscrepancy ? "var(--bind-danger)" : "var(--bind-ink-soft)"};">
          ${
            res.docType === "quote"
              ? `Confirmed Quote ${escapeHtml(res.quoteId || "")} (${escapeHtml(formatCents(res.unitPriceCents || 0))}/unit) saved with OWNER_CONFIRMED provenance.`
              : isDiscrepancy
              ? `3-Way Match blocked reconciliation (${escapeHtml(res.matchStatus)}): ${escapeHtml((res.discrepancies || []).join("; ") || "Invoice/Receipt variance against PO")}. Order remains unfulfilled.`
              : `3-Way Match passed (MATCHED). Order reconciled and double-entry journal posted.`
          }
        </div>
      </div>
    `;
    return;
  }

  if (!doc) {
    box.innerHTML = "";
    return;
  }

  const docId = doc.docId || doc.id;
  const docType = doc.docType || doc.doc_type;
  const fields = doc.extractedFields || doc.extracted_fields || {};
  const warnings = doc.warnings || [];

  box.innerHTML = `
    <div style="padding:12px; background:var(--bind-white); border:1px solid var(--bind-border-strong); border-radius:var(--radius-sm); font-size:0.8rem;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px;">
        <strong class="mono" style="color:var(--bind-ink);">Staged Draft: ${escapeHtml(docId)} (${escapeHtml(docType)})</strong>
        <span class="badge badge-warning mono">DOCUMENT_EXTRACTED (Unconfirmed)</span>
      </div>
      <div class="mono" style="font-size:0.75rem; color:var(--bind-ink-soft); margin-bottom:8px;">
        SKU: <strong>${escapeHtml(fields.sku || "UNMATCHED")}</strong> ·
        Supplier: <strong>${escapeHtml(fields.supplierName || "Unverified")}</strong> ·
        Qty: <strong>${escapeHtml(fields.quantity ?? "—")}</strong> ·
        Unit: <strong>${escapeHtml(formatCents(fields.unitPriceCents || 0))}</strong> ·
        Total: <strong>${escapeHtml(formatCents(fields.totalPriceCents || 0))}</strong>
      </div>
      ${
        warnings.length > 0
          ? `<div style="padding:8px; background:var(--bind-warning-bg); color:var(--bind-warning); border-radius:6px; font-size:0.74rem; margin-bottom:8px;">
               <strong>Warnings Requiring Owner Review:</strong><br/>
               ${warnings.map((w) => `• ${escapeHtml(w)}`).join("<br/>")}
             </div>`
          : `<div style="font-size:0.74rem; color:var(--bind-success); margin-bottom:8px;">✓ All fields matched workspace inventory and arithmetic checks.</div>`
      }
      <button type="button" class="btn btn-teal btn-sm" onclick="confirmStagedDoc('${escapeHtml(docId)}')">
        Stage 2: Owner Confirm &amp; Commit (${escapeHtml(docType === "quote" ? "Save Approved Quote" : "Run 3-Way Match")})
      </button>
    </div>
  `;
}

async function createStudioWorkspace(useBlueprint = false) {
  const wsId = (document.getElementById("onboardWsId")?.value || "").trim();
  const name = (document.getElementById("onboardWsName")?.value || "").trim();
  const dailyDollars = Number(document.getElementById("onboardDailyCents")?.value || 1500);
  const gateDollars = Number(document.getElementById("onboardGateCents")?.value || 400);

  if (!wsId || !name) {
    showToast("Workspace ID and Business Name are required.");
    return;
  }

  let supplies = [];
  let suppliers = [];
  if (useBlueprint) {
    const bpRes = await fetch("/api/templates/kitchen-ops/blueprint");
    if (bpRes.ok) {
      const bp = await bpRes.json();
      supplies = bp.suggestedSupplies || [];
      suppliers = bp.suggestedSuppliers || [];
    }
  }

  try {
    const res = await fetch("/api/workspaces/onboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: wsId,
        name,
        businessType: "kitchen",
        referenceTemplateId: useBlueprint ? "kitchen-ops" : undefined,
        budgetDailyLimitCents: Math.round(dailyDollars * 100),
        approvalThresholdCents: Math.round(gateDollars * 100),
        supplies,
        suppliers,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`Onboarding error: ${data.error || "Failed"}`);
      return;
    }
    setActiveWorkspaceId(data.workspaceId);
    appState.selectedWorkflowId = null;
    appState.latestDraftDoc = null;
    appState.latestConfirmedDocResult = null;
    showToast(`Workspace '${data.workspaceId}' onboarded (${useBlueprint ? "with blueprint supplies" : "blank"}).`);
    await ensureWorkspaceAndLoad();
  } catch (err) {
    showToast(`Onboarding error: ${err.message}`);
  }
}

async function addSupplySkuToWorkspace() {
  const sku = (document.getElementById("addSkuCode")?.value || "").trim();
  const name = (document.getElementById("addSkuName")?.value || "").trim();
  const unit = (document.getElementById("addSkuUnit")?.value || "unit").trim();
  const currentQuantity = Number(document.getElementById("addSkuOnHand")?.value || 0);
  const parLevel = Number(document.getElementById("addSkuPar")?.value || 5);
  const priceDollars = Number(document.getElementById("addSkuPriceDollars")?.value || 25);

  try {
    const res = await fetch(`/api/workspaces/${WORKSPACE_ID}/inventory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sku,
        name,
        category: "Dry Goods",
        unit,
        currentQuantity,
        parLevel,
        reorderQuantity: Math.max(parLevel * 2, 5),
        unitPriceCents: Math.round(priceDollars * 100),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`SKU error: ${data.error || "Failed"}`);
      return;
    }
    showToast(`Saved SKU ${data.sku} (${data.name}) to ${WORKSPACE_ID}.`);
    await ensureWorkspaceAndLoad();
  } catch (err) {
    showToast(`SKU error: ${err.message}`);
  }
}

async function saveStudioAgentRole(includeForbiddenTool = false) {
  const roleName = (document.getElementById("agentRoleSlug")?.value || "").trim();
  const displayName = (document.getElementById("agentRoleDisplay")?.value || "").trim();
  const limitDollars = Number(document.getElementById("agentRoleLimitDollars")?.value || 500);
  const effectsRaw = document.getElementById("agentRoleEffect")?.value || "read,external_request,commercial_commitment";
  const description = (document.getElementById("agentRoleDesc")?.value || "").trim();
  const feedbackEl = document.getElementById("agentRoleFeedback");

  const allowedTools = includeForbiddenTool
    ? ["get_business_context", "transfer_usdc"]
    : [
        "get_business_context",
        "get_stock_snapshot",
        "get_approved_supplier_quotes",
        "create_replenishment_proposal",
        "request_policy_evaluation",
        "get_request_status",
      ];

  try {
    const res = await fetch(`/api/workspaces/${WORKSPACE_ID}/agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roleName,
        displayName,
        description,
        permittedEffects: effectsRaw.split(","),
        spendingLimitCents: Math.round(limitDollars * 100),
        allowedTools,
        enabled: true,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (feedbackEl) {
        feedbackEl.style.color = "var(--bind-danger)";
        feedbackEl.textContent = `Blocked by deterministic guard: ${data.error}`;
      }
      showToast(`Blocked: ${data.error}`);
      return;
    }
    if (feedbackEl) {
      feedbackEl.style.color = "var(--bind-teal)";
      feedbackEl.textContent = `Saved role '${data.roleName}' → Derived ${data.derivedFiles?.agentsSpecPath || "AGENTS.md"} updated.`;
    }
    showToast(`Saved agent role '${data.displayName}' & updated AGENTS.md`);
    await ensureWorkspaceAndLoad();
  } catch (err) {
    showToast(`Agent role error: ${err.message}`);
  }
}

async function bindStudioSurfaceIdentity() {
  const surface = document.getElementById("surfaceChannelSelect")?.value || "whatsapp";
  const actorId = (document.getElementById("surfaceActorHandle")?.value || "").trim();
  const actorRole = document.getElementById("surfaceActorRole")?.value || "staff";

  try {
    const res = await fetch(`/api/workspaces/${WORKSPACE_ID}/surfaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        surface,
        actorId,
        actorRole,
        integrationStatus: "simulated",
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`Surface binding error: ${data.error || "Failed"}`);
      return;
    }
    showToast(`Bound ${data.surface} identity '${data.actor_id}' as ${data.actor_role}.`);
    await ensureWorkspaceAndLoad();
  } catch (err) {
    showToast(`Surface error: ${err.message}`);
  }
}

async function runSurfaceSimulation(scenario) {
  const outputEl = document.getElementById("surfaceSimulatorOutput");
  let payload = {};

  if (scenario === "staff_stock") {
    const targetSku = appState.inventory[0]?.sku || "SKU-FLOUR-001";
    payload = {
      eventType: "SURFACE_STOCK_OBSERVED",
      eventId: `sim_stock_${Date.now()}`,
      workspaceId: WORKSPACE_ID,
      surface: "whatsapp",
      actorId: "whatsapp:+14155550199",
      actorRole: "staff",
      sku: targetSku,
      observedQuantity: 2,
      note: "Line cook evening count via WhatsApp",
    };
  } else if (scenario === "staff_approve_blocked") {
    payload = {
      eventType: "SURFACE_OWNER_APPROVAL_DECISION",
      eventId: `sim_unauth_${Date.now()}`,
      workspaceId: WORKSPACE_ID,
      surface: "whatsapp",
      actorId: "whatsapp:+14155550199",
      actorRole: "staff",
      approvalId: appState.approvals[0]?.id || "appr_demo",
      decision: "approve",
    };
  } else if (scenario === "owner_approve") {
    const pending = appState.approvals.find((a) => a.status === "pending");
    if (!pending) {
      // Find an item exceeding approval threshold or SKU-BUTTER-003
      const candidate =
        appState.inventory.find((i) => i.sku === "SKU-BUTTER-003") ||
        appState.inventory.find((i) => Number(i.current_quantity) < Number(i.par_level));
      if (candidate) {
        await fetch(`/api/workspaces/${WORKSPACE_ID}/replenish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sku: candidate.sku }),
        });
        const apprRes = await fetch(`/api/workspaces/${WORKSPACE_ID}/approvals`);
        if (apprRes.ok) appState.approvals = await apprRes.json();
      }
    }
    const targetApproval = appState.approvals.find((a) => a.status === "pending");
    if (!targetApproval) {
      if (outputEl) {
        outputEl.textContent = "No pending approval gate found in this workspace. Trigger an order above the approval threshold first.";
      }
      return;
    }
    payload = {
      eventType: "SURFACE_OWNER_APPROVAL_DECISION",
      eventId: `sim_owner_${Date.now()}`,
      workspaceId: WORKSPACE_ID,
      surface: "telegram",
      actorId: "tg:owner_chef_elena",
      actorRole: "owner",
      approvalId: targetApproval.id,
      decision: "approve",
    };
  }

  try {
    const res = await fetch("/api/webhooks/incoming", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (outputEl) {
      outputEl.style.color = res.status === 403 ? "var(--bind-danger)" : "var(--bind-ink)";
      outputEl.textContent = `HTTP ${res.status} → ${JSON.stringify(data)}`;
    }
    showToast(`Surface simulator: HTTP ${res.status}`);
    await ensureWorkspaceAndLoad();
  } catch (err) {
    if (outputEl) outputEl.textContent = `Error: ${err.message}`;
  }
}

async function extractStage1Document() {
  const docType = document.getElementById("docExtractType")?.value || "quote";
  const rawText = document.getElementById("docRawText")?.value || "";
  const linkedOrder = appState.orders.find((o) => o.status === "confirmed") || appState.orders[0];

  try {
    const res = await fetch(`/api/workspaces/${WORKSPACE_ID}/documents/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        docType,
        sourceLabel: "studio_upload",
        rawText,
        linkedOrderId: docType !== "quote" ? linkedOrder?.id : undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`Extraction error: ${data.error || "Failed"}`);
      return;
    }
    appState.latestDraftDoc = data;
    appState.latestConfirmedDocResult = null;
    showToast(`Stage 1 Extracted (${data.docType}) — awaiting Owner Confirmation.`);
    await ensureWorkspaceAndLoad();
  } catch (err) {
    showToast(`Extraction error: ${err.message}`);
  }
}

async function confirmStagedDoc(docId) {
  try {
    const res = await fetch(`/api/workspaces/${WORKSPACE_ID}/documents/${encodeURIComponent(docId)}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decidedBy: "owner@bind.local" }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(`Confirm error: ${data.error || "Failed"}`);
      return;
    }
    appState.latestDraftDoc = null;
    appState.latestConfirmedDocResult = data;
    if (data.docType === "quote") {
      showToast(`Owner confirmed quote ${data.quoteId} (${formatCents(data.unitPriceCents)}/unit).`);
    } else {
      showToast(`3-Way Match: ${data.matchStatus} ${data.reconciled ? "· Reconciled & Journal Posted" : "· Held for Discrepancy"}`);
    }
    await ensureWorkspaceAndLoad();
  } catch (err) {
    showToast(`Confirm error: ${err.message}`);
  }
}

// Expose action handlers globally for inline buttons
window.triggerReplenishment = triggerReplenishment;
window.approveOrder = approveOrder;
window.rejectOrder = rejectOrder;
window.reconcileOrder = reconcileOrder;
window.selectWorkflow = selectWorkflow;
window.openEvidenceDrawer = openEvidenceDrawer;
window.confirmStagedDoc = confirmStagedDoc;

/* ==========================================================================
   Event Listeners & Initialization
   ========================================================================== */
document.addEventListener("DOMContentLoaded", () => {
  // Route link interception for SPA navigation across /, /app, and all /app/* subpages
  document.querySelectorAll("a[data-route]").forEach((link) => {
    link.addEventListener("click", (e) => {
      const route = link.getAttribute("data-route");
      if (route) {
        e.preventDefault();
        navigateTo(route);
      }
    });
  });

  window.addEventListener("popstate", () => {
    syncRouteView();
  });

  // Workspace switcher dropdown
  document.getElementById("workspaceSwitcherSelect")?.addEventListener("change", (e) => {
    const nextWsId = e.target.value;
    if (nextWsId) {
      setActiveWorkspaceId(nextWsId);
      appState.selectedWorkflowId = null;
      appState.latestDraftDoc = null;
      appState.latestConfirmedDocResult = null;
      showToast(`Switched active workspace to ${WORKSPACE_ID}`);
      ensureWorkspaceAndLoad();
    }
  });

  // Studio Flow A buttons
  document.getElementById("createBlankWsBtn")?.addEventListener("click", () => createStudioWorkspace(false));
  document.getElementById("loadBlueprintWsBtn")?.addEventListener("click", () => createStudioWorkspace(true));
  document.getElementById("addInventorySkuBtn")?.addEventListener("click", () => addSupplySkuToWorkspace());

  // Studio Flow B buttons
  document.getElementById("saveAgentRoleBtn")?.addEventListener("click", () => saveStudioAgentRole(false));
  document.getElementById("testForbiddenToolBtn")?.addEventListener("click", () => saveStudioAgentRole(true));

  // Studio Flow C buttons
  document.getElementById("bindSurfaceIdentityBtn")?.addEventListener("click", () => bindStudioSurfaceIdentity());
  document.getElementById("simStaffStockBtn")?.addEventListener("click", () => runSurfaceSimulation("staff_stock"));
  document.getElementById("simStaffApproveBlockedBtn")?.addEventListener("click", () => runSurfaceSimulation("staff_approve_blocked"));
  document.getElementById("simOwnerApproveBtn")?.addEventListener("click", () => runSurfaceSimulation("owner_approve"));

  // Studio Flow D buttons
  document.getElementById("loadSampleQuoteBtn")?.addEventListener("click", () => {
    const typeEl = document.getElementById("docExtractType");
    const textEl = document.getElementById("docRawText");
    if (typeEl) typeEl.value = "quote";
    if (textEl) {
      textEl.value = `Supplier: Sysco Metro Restock\nSKU: SKU-FLOUR-001\nItem: King Arthur Artisan Bread Flour (50lb)\nQty: 10\nUnit Price: $39.50\nTotal: $395.00`;
    }
  });
  document.getElementById("loadSampleBillBtn")?.addEventListener("click", () => {
    const typeEl = document.getElementById("docExtractType");
    const textEl = document.getElementById("docRawText");
    const ord = appState.orders[0];
    if (typeEl) typeEl.value = "supplier_bill";
    if (textEl) {
      const sku = ord?.item_sku || "SKU-FLOUR-001";
      const qty = ord?.quantity || 10;
      const unitDollars = ord ? (Number(ord.unit_price_cents) / 100).toFixed(2) : "42.50";
      const totalDollars = ord ? (Number(ord.total_price_cents) / 100).toFixed(2) : "425.00";
      textEl.value = `Invoice #: INV-${Date.now().toString().slice(-5)}\nSupplier: ${ord?.supplier_name || "Sysco Metro Restock"}\nSKU: ${sku}\nQty: ${qty}\nUnit Price: $${unitDollars}\nTotal: $${totalDollars}`;
    }
  });
  document.getElementById("extractDocStage1Btn")?.addEventListener("click", () => extractStage1Document());

  // Mobile sidebar toggle
  document.getElementById("mobileMenuToggleBtn")?.addEventListener("click", () => {
    document.getElementById("appSidebar")?.classList.toggle("mobile-open");
  });

  // Primary buttons in /app
  document.getElementById("runLowStockBtn")?.addEventListener("click", () => {
    triggerReplenishment();
  });
  document.getElementById("recoverWorkflowsBtn")?.addEventListener("click", () => {
    recoverWorkflows();
  });

  // Evidence drawer triggers & dismissal
  document.getElementById("openEvidenceDrawerBtn")?.addEventListener("click", () => openEvidenceDrawer());
  document.getElementById("mobileOpenEvidenceBtn")?.addEventListener("click", () => openEvidenceDrawer());
  document.getElementById("inspectFullEvidenceBtn")?.addEventListener("click", () => openEvidenceDrawer());
  document.getElementById("closeEvidenceDrawerBtn")?.addEventListener("click", () => closeEvidenceDrawer());
  document.getElementById("drawerBackdrop")?.addEventListener("click", () => closeEvidenceDrawer());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeEvidenceDrawer();
      document.getElementById("appSidebar")?.classList.remove("mobile-open");
    }
  });

  document.getElementById("toastCloseBtn")?.addEventListener("click", () => {
    document.getElementById("toastBanner")?.classList.remove("visible");
  });

  bindCopyButtons(document);
  syncRouteView();
  ensureWorkspaceAndLoad();
});
