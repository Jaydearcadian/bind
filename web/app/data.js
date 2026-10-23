/*
 * Business data (ADR 0066; UX brief: "Team, Connections and Business data"). Tabs named by the workspace's template, one shared
 * table design (a stacked card per row on phones), and a search across every tab. Read-only: agents and workflows change this
 * data, and the page shows what the server holds. Status words keep "sent" apart from "confirmed" and "paid".
 */
import { BindApiError, ago, clearKey, client, h, money, pauseControl, shell, showDemo, showPaused, storedKey, toSignIn, signOutNow } from "/app/core.js";

const key = storedKey();
if (!key) toSignIn();
const bind = client(key);
const $ = (id) => document.getElementById(id);

const num = (v) => Number(v);
const qty = (v) => {
  const n = num(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
};

const PURCHASE_WORDS = {
  submitted: ["Sent, not confirmed", "pending"],
  confirmed: ["Confirmed by supplier", "ok"],
  settling: ["Payment in progress", "pending"],
  payment_hold: ["Payment held", "pending"],
  settlement_submitted: ["Payment sent, outcome not confirmed", "pending"],
  reconciled: ["Paid and matched", "ok"],
  cancelled: ["Cancelled", "muted"],
};
const CUSTOMER_WORDS = {
  accepted: ["Accepted", "ok"],
  partially_available: ["Partly available", "pending"],
  declined: ["Declined", "muted"],
  needs_owner: ["Needs you", "pending"],
  cancelled: ["Cancelled", "muted"],
  fulfilled: ["Done", "ok"],
};

function status([word, tone]) {
  return h("span", { class: `status status-${tone}` }, word);
}

/** The kitchen's tabs. Each has a loader, columns, the text search looks at, and an empty state. */
const KITCHEN_TABS = [
  {
    id: "stock",
    label: "Stock",
    load: (ws) => bind.call("listInventory", { params: { id: ws } }),
    sort: (a, b) => num(a.current_quantity) / Math.max(1, num(a.par_level)) - num(b.current_quantity) / Math.max(1, num(b.par_level)),
    text: (r) => `${r.name} ${r.sku} ${r.category}`,
    empty: "No stock items yet.",
    columns: [
      { label: "Item", cell: (r) => h("span", {}, h("b", {}, r.name), h("small", {}, r.category)) },
      { label: "On hand", cell: (r) => `${qty(r.current_quantity)} ${r.unit}`, num: true },
      { label: "Reorder below", cell: (r) => `${qty(r.par_level)} ${r.unit}`, num: true },
      { label: "Unit price", cell: (r) => money(num(r.unit_price_cents)), num: true },
      { label: "State", cell: (r) => (num(r.current_quantity) < num(r.par_level) ? status(["Low", "pending"]) : status(["OK", "neutral"])) },
    ],
  },
  {
    id: "purchases",
    label: "Purchases",
    load: (ws) => bind.call("listOrders", { params: { id: ws } }),
    sort: (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    text: (r) => `${r.order_number} ${r.supplier_name} ${r.item_name} ${r.item_sku} ${r.status}`,
    empty: "No purchases yet. When an agent's order is approved, it shows here.",
    columns: [
      { label: "Order", cell: (r) => h("span", {}, h("b", {}, r.item_name), h("small", { class: "mono" }, r.order_number)) },
      { label: "Supplier", cell: (r) => r.supplier_name },
      { label: "Amount", cell: (r) => `${qty(r.quantity)} for ${money(num(r.total_price_cents), r.currency || "USD")}`, num: true },
      { label: "State", cell: (r) => status(PURCHASE_WORDS[r.status] ?? [r.status, "neutral"]) },
      { label: "When", cell: (r) => ago(r.created_at) },
    ],
  },
  {
    id: "customer-orders",
    label: "Customer orders",
    load: (ws) => bind.call("listCustomerOrders", { params: { id: ws } }),
    sort: (a, b) => Date.parse(b.createdAt ?? 0) - Date.parse(a.createdAt ?? 0),
    text: (r) => `${r.externalRef} ${r.status} ${r.lines.map((l) => l.sku).join(" ")} ${r.note ?? ""}`,
    empty: "No customer orders yet.",
    columns: [
      { label: "Order", cell: (r) => h("span", {}, h("b", {}, r.externalRef), h("small", {}, r.lines.map((l) => `${l.quantity} × ${l.sku}`).join(", "))) },
      { label: "For", cell: (r) => (r.promisedFor || r.requestedFor ? new Date(r.promisedFor || r.requestedFor).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "As soon as possible") },
      { label: "State", cell: (r) => status(CUSTOMER_WORDS[r.status] ?? [r.status, "neutral"]) },
    ],
  },
  {
    id: "menu",
    label: "Menu",
    load: (ws) => bind.call("listMenu", { params: { id: ws } }),
    sort: (a, b) => a.name.localeCompare(b.name),
    text: (r) => `${r.name} ${r.description ?? ""}`,
    empty: "The menu is empty.",
    columns: [
      { label: "Dish", cell: (r) => h("span", {}, h("b", {}, r.name), r.description ? h("small", {}, r.description) : null) },
      { label: "Price", cell: (r) => money(r.priceCents), num: true },
      { label: "State", cell: (r) => (r.available ? status(["On the menu", "ok"]) : status(["Off the menu", "muted"])) },
    ],
  },
];

const TABS_BY_TEMPLATE = { kitchen: KITCHEN_TABS };
const templateTabs = (templateId) => (String(templateId).startsWith("kitchen") ? TABS_BY_TEMPLATE.kitchen : null);

const state = { me: null, tabs: [], rows: {}, failed: {}, current: null, query: "" };

function matches(tab, row) {
  return !state.query || tab.text(row).toLowerCase().includes(state.query);
}

function renderTabs() {
  const bar = $("tabs");
  bar.replaceChildren(
    ...state.tabs.map((t) => {
      const count = state.query && state.rows[t.id] ? state.rows[t.id].filter((r) => matches(t, r)).length : null;
      return h(
        "button",
        {
          class: "dtab",
          type: "button",
          role: "tab",
          id: `tab-${t.id}`,
          "aria-selected": String(t.id === state.current),
          "aria-controls": "data-panel",
          tabindex: t.id === state.current ? "0" : "-1",
          onclick: () => select(t.id),
        },
        t.label,
        count !== null ? h("span", { class: "dtab-count" }, String(count)) : null
      );
    })
  );
}

function renderPanel() {
  const panel = $("data-panel");
  const tab = state.tabs.find((t) => t.id === state.current);
  panel.setAttribute("aria-labelledby", `tab-${tab.id}`);
  panel.removeAttribute("aria-busy");
  if (state.failed[tab.id]) {
    panel.replaceChildren(h("p", { class: "line-empty" }, "Couldn't load this right now. Try again in a moment."));
    return;
  }
  const rows = (state.rows[tab.id] ?? []).filter((r) => matches(tab, r)).sort(tab.sort);
  if (!rows.length) {
    panel.replaceChildren(h("p", { class: "line-empty" }, state.query ? `Nothing in ${tab.label} matches "${state.query}".` : tab.empty));
    return;
  }
  panel.replaceChildren(
    h(
      "table",
      { class: "data-table" },
      h("thead", {}, h("tr", {}, tab.columns.map((c) => h("th", { scope: "col", class: c.num ? "is-num" : null }, c.label)))),
      h(
        "tbody",
        {},
        rows.map((r) => h("tr", {}, tab.columns.map((c) => h("td", { "data-label": c.label, class: c.num ? "is-num" : null }, c.cell(r)))))
      )
    )
  );
}

function renderHits() {
  const box = $("search-hits");
  if (!state.query) {
    box.hidden = true;
    return;
  }
  const parts = state.tabs.map((t) => [t, (state.rows[t.id] ?? []).filter((r) => matches(t, r)).length]).filter(([, n]) => n > 0);
  box.hidden = false;
  box.textContent = parts.length ? `Found in ${parts.map(([t, n]) => `${t.label} (${n})`).join(", ")}.` : `Nothing matches "${state.query}".`;
}

function select(id, focus = false) {
  state.current = id;
  try {
    history.replaceState(null, "", `#${id}`);
  } catch {
    // Some embedded views refuse it; the tab still changes.
  }
  renderTabs();
  renderPanel();
  if (focus) document.getElementById(`tab-${id}`)?.focus();
}

function wire() {
  $("tabs").addEventListener("keydown", (e) => {
    const i = state.tabs.findIndex((t) => t.id === state.current);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % state.tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + state.tabs.length) % state.tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = state.tabs.length - 1;
    if (next >= 0) {
      e.preventDefault();
      select(state.tabs[next].id, true);
    }
  });
  let timer = 0;
  $("search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      state.query = e.target.value.trim().toLowerCase();
      // Jump to the first tab with a match when the current one has none.
      const cur = state.tabs.find((t) => t.id === state.current);
      if (state.query && !(state.rows[cur.id] ?? []).some((r) => matches(cur, r))) {
        const other = state.tabs.find((t) => (state.rows[t.id] ?? []).some((r) => matches(t, r)));
        if (other) state.current = other.id;
      }
      renderTabs();
      renderPanel();
      renderHits();
    }, 120);
  });
}

async function main() {
  try {
    state.me = await bind.me();
  } catch (err) {
    if (err instanceof BindApiError && (err.status === 401 || err.status === 404)) {
      clearKey();
      toSignIn();
      return;
    }
    $("stale-banner").hidden = false;
    return;
  }
  shell({
    me: state.me,
    onSignOut: () => signOutNow(bind, state.me),
  });
  showPaused(state.me.agentsPaused, state.me.role);
  pauseControl({ bind, me: state.me, isPaused: () => state.me.agentsPaused, onChange: (p) => { state.me.agentsPaused = p; showPaused(p, state.me.role); } });
  $("refresh-now").addEventListener("click", () => window.location.reload());
  let ws;
  try {
    ws = (await bind.workspace(state.me.workspaceId)).workspace;
  } catch {
    $("stale-banner").hidden = false;
    return;
  }
  showDemo({ bind, me: state.me, ws });
  const tabs = templateTabs(ws.template_id);
  if (!tabs) {
    $("data-panel").removeAttribute("aria-busy");
    $("data-panel").replaceChildren(
      h("div", { class: "empty" }, h("p", { class: "empty-title" }, "No data views for this team yet."), h("p", { class: "empty-sub" }, "They arrive with the team's ready-made views. Your agents' work still shows in Activity."))
    );
    document.querySelector(".data-bar").hidden = true;
    return;
  }
  state.tabs = tabs;
  const wanted = window.location.hash.slice(1);
  state.current = tabs.some((t) => t.id === wanted) ? wanted : tabs[0].id;
  wire();
  renderTabs();
  await Promise.all(
    tabs.map(async (t) => {
      try {
        state.rows[t.id] = await t.load(state.me.workspaceId);
      } catch {
        state.failed[t.id] = true;
      }
      if (t.id === state.current) renderPanel();
    })
  );
  renderTabs();
  if (Object.keys(state.failed).length === tabs.length) $("stale-banner").hidden = false;
}

main();
