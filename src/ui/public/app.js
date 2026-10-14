// Bind Web Dashboard Client Application
const WORKSPACE_ID = "ws-kitchen-main";

async function fetchJSON(url, options) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return await res.json();
  } catch (err) {
    console.error(`Fetch error on ${url}:`, err);
    throw err;
  }
}

async function loadDashboard() {
  await Promise.all([
    loadWorkspace(),
    loadInventory(),
    loadApprovals(),
    loadWorkflows(),
    loadAudit(),
  ]);
}

async function loadWorkspace() {
  try {
    const data = await fetchJSON(`/api/workspaces/${WORKSPACE_ID}`);
    const balance = (Number(data.treasuryBalanceCents || 0) / 100).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
    });
    document.getElementById("treasuryBalance").textContent = `${balance} USDC`;

    const rolesContainer = document.getElementById("rolesGrid");
    rolesContainer.innerHTML = data.roles
      .map(
        (role) => `
      <div class="p-5 rounded-xl border border-slate-800 bg-slate-900/80 hover:border-slate-700 transition flex flex-col justify-between">
        <div>
          <div class="flex items-center justify-between mb-2">
            <h3 class="font-bold text-sm text-white">${role.display_name}</h3>
            <span class="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded ${
              role.enabled ? "bg-emerald-500/20 text-emerald-400" : "bg-red-500/20 text-red-400"
            }">
              ${role.enabled ? "Enforced" : "Disabled"}
            </span>
          </div>
          <p class="text-xs text-slate-400 mb-3">${role.description || ""}</p>
        </div>
        <div class="pt-3 border-t border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <div>
            Effects: <span class="font-mono text-slate-300">${(role.permitted_effects || []).join(", ")}</span>
          </div>
          <div>
            Limit: <span class="text-amber-400 font-semibold">$${(Number(role.spending_limit_cents) / 100).toFixed(0)}</span>
          </div>
        </div>
      </div>
    `
      )
      .join("");
  } catch (err) {
    console.error("Failed to load workspace:", err);
  }
}

async function loadInventory() {
  try {
    const items = await fetchJSON(`/api/workspaces/${WORKSPACE_ID}/inventory`);
    const table = document.getElementById("inventoryTable");

    if (!items || items.length === 0) {
      table.innerHTML = `<tr><td colspan="7" class="px-5 py-8 text-center text-slate-500">No inventory items registered.</td></tr>`;
      return;
    }

    table.innerHTML = items
      .map((item) => {
        const current = Number(item.current_quantity);
        const par = Number(item.par_level);
        const isLow = current < par;

        return `
        <tr class="hover:bg-slate-800/30 transition">
          <td class="px-5 py-4">
            <div class="font-semibold text-white">${item.name}</div>
            <div class="text-xs font-mono text-slate-500">${item.sku}</div>
          </td>
          <td class="px-5 py-4 text-xs text-slate-300">${item.category}</td>
          <td class="px-5 py-4 font-bold ${isLow ? "text-amber-400" : "text-emerald-400"}">
            ${current} ${item.unit}
          </td>
          <td class="px-5 py-4 text-xs text-slate-400">${par} ${item.unit}</td>
          <td class="px-5 py-4 text-xs text-slate-300">$${(Number(item.unit_price_cents) / 100).toFixed(2)}</td>
          <td class="px-5 py-4">
            <span class="text-xs px-2.5 py-1 rounded-full font-medium ${
              isLow
                ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
                : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
            }">
              ${isLow ? "Low Stock" : "Optimal"}
            </span>
          </td>
          <td class="px-5 py-4 text-right">
            <button onclick="triggerRestock('${item.sku}')" class="px-3 py-1.5 rounded-lg text-xs font-semibold ${
              isLow
                ? "bg-amber-600 hover:bg-amber-500 text-white shadow-md shadow-amber-600/20"
                : "bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700"
            } transition">
              Trigger RFQ
            </button>
          </td>
        </tr>
      `;
      })
      .join("");
  } catch (err) {
    console.error("Failed to load inventory:", err);
  }
}

async function loadApprovals() {
  try {
    const approvals = await fetchJSON(`/api/workspaces/${WORKSPACE_ID}/approvals`);
    const pending = (approvals || []).filter((a) => a.status === "pending");
    const section = document.getElementById("approvalsSection");
    const list = document.getElementById("approvalsList");

    if (pending.length === 0) {
      section.classList.add("hidden");
      return;
    }

    section.classList.remove("hidden");
    list.innerHTML = pending
      .map(
        (appr) => `
      <div class="p-4 rounded-lg bg-slate-900 border border-amber-500/30 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div class="font-bold text-sm text-white">${appr.action_requested}</div>
          <div class="text-xs text-slate-400 mt-0.5">
            Amount: <span class="text-amber-400 font-semibold">$${(Number(appr.amount_cents) / 100).toFixed(2)} USDC</span> ·
            Requester: <span class="font-mono text-slate-300">${appr.requester_role}</span>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <button onclick="resolveApproval('${appr.id}', 'approve')" class="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-md shadow-emerald-600/20">
            <i class="fa-solid fa-check"></i>
            <span>Approve & Submit</span>
          </button>
          <button onclick="resolveApproval('${appr.id}', 'reject')" class="px-4 py-2 bg-red-600/80 hover:bg-red-600 text-white rounded-lg text-xs font-bold transition flex items-center gap-1.5">
            <i class="fa-solid fa-xmark"></i>
            <span>Reject</span>
          </button>
        </div>
      </div>
    `
      )
      .join("");
  } catch (err) {
    console.error("Failed to load approvals:", err);
  }
}

async function loadWorkflows() {
  try {
    const workflows = await fetchJSON(`/api/workspaces/${WORKSPACE_ID}/workflows`);
    const list = document.getElementById("workflowsList");

    if (!workflows || workflows.length === 0) {
      list.innerHTML = `<div class="text-slate-500 text-xs text-center py-8">No active workflows</div>`;
      return;
    }

    list.innerHTML = workflows
      .map((wf) => {
        const orderId = wf.context_data?.orderId;
        const canReconcile = wf.state === "confirmed" && orderId;

        return `
        <div class="p-3.5 rounded-lg border border-slate-800 bg-slate-800/40 hover:bg-slate-800/60 transition">
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-xs font-bold text-slate-200 capitalize">${wf.workflow_type.replace(/_/g, " ")}</span>
            <span class="text-[10px] font-mono uppercase px-2 py-0.5 rounded font-bold ${
              wf.state === "reconciled"
                ? "bg-emerald-500/20 text-emerald-400"
                : wf.state === "confirmed"
                ? "bg-blue-500/20 text-blue-400"
                : wf.state === "awaiting_approval"
                ? "bg-amber-500/20 text-amber-400"
                : "bg-slate-700 text-slate-300"
            }">
              ${wf.state}
            </span>
          </div>
          <div class="text-xs text-slate-400 flex items-center justify-between">
            <span class="truncate max-w-[200px]">${wf.context_data?.itemName || "Replenishment Item"}</span>
            <span class="font-mono text-[10px] text-slate-500">${new Date(wf.created_at).toLocaleTimeString()}</span>
          </div>
          ${
            canReconcile
              ? `
            <div class="mt-2 pt-2 border-t border-slate-700/50 flex justify-end">
              <button onclick="reconcileOrder('${orderId}')" class="px-2.5 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-[11px] font-semibold transition">
                3-Way Match & Settle
              </button>
            </div>
          `
              : ""
          }
        </div>
      `;
      })
      .join("");
  } catch (err) {
    console.error("Failed to load workflows:", err);
  }
}

async function loadAudit() {
  try {
    const logs = await fetchJSON(`/api/workspaces/${WORKSPACE_ID}/audit`);
    const list = document.getElementById("auditList");

    if (!logs || logs.length === 0) {
      list.innerHTML = `<div class="text-slate-500 text-xs text-center py-8">No audit logs recorded</div>`;
      return;
    }

    list.innerHTML = logs
      .slice(0, 15)
      .map(
        (log) => `
      <div class="p-3 rounded-lg border border-slate-800/80 bg-slate-800/30 text-xs">
        <div class="flex items-center justify-between mb-1">
          <span class="font-mono text-slate-300 font-semibold">${log.action}</span>
          <span class="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${
            log.policy_decision === "ALLOW"
              ? "bg-emerald-500/10 text-emerald-400"
              : log.policy_decision === "REQUIRE_APPROVAL"
              ? "bg-amber-500/10 text-amber-400"
              : "bg-red-500/10 text-red-400"
          }">
            ${log.policy_decision}
          </span>
        </div>
        <div class="text-[11px] text-slate-400 flex items-center justify-between">
          <span>Actor: <span class="font-mono text-slate-300">${log.actor_id}</span></span>
          <span class="text-slate-500">${new Date(log.created_at).toLocaleTimeString()}</span>
        </div>
        ${
          log.tx_hash
            ? `
          <div class="mt-1 font-mono text-[10px] text-blue-400 truncate">
            Tx: <a href="https://testnet.arcscan.io/tx/${log.tx_hash}" target="_blank" class="hover:underline">${log.tx_hash}</a>
          </div>
        `
            : ""
        }
      </div>
    `
      )
      .join("");
  } catch (err) {
    console.error("Failed to load audit:", err);
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
    await loadDashboard();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function resolveApproval(approvalId, decision) {
  try {
    const endpoint = `/api/approvals/${approvalId}/${decision}`;
    await fetchJSON(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decidedBy: "owner@lebistro.example.com" }),
    });
    await loadDashboard();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function reconcileOrder(orderId) {
  try {
    const res = await fetchJSON(`/api/orders/${orderId}/reconcile`, {
      method: "POST",
    });
    alert(`Reconciliation complete! 3-Way Match: ${res.status}. Settled on Arc: ${res.txHash || "local"}`);
    await loadDashboard();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

document.getElementById("btnRecover").addEventListener("click", async () => {
  try {
    const res = await fetchJSON(`/api/workspaces/${WORKSPACE_ID}/recover`, { method: "POST" });
    alert(`Crash Recovery Scan Complete. Recovered: ${res.recoveredCount}, Failed: ${res.failedCount}`);
    await loadDashboard();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
});

// Initial load & 10s auto-refresh
window.addEventListener("DOMContentLoaded", () => {
  loadDashboard();
  setInterval(loadDashboard, 10000);
});
