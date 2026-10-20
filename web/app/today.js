/*
 * Today (ADR 0059; docs/ux/UX_BRIEF.md, "Today and approvals"). What needs you, what is happening, and the approval panel
 * ("open, read, confirm"). Every item comes from the API. Nothing is shown as done before the server says so.
 */
import { BindApiError, ago, clearKey, client, h, mark, money, newKey, pauseControl, shell, showPaused, storedKey, toSignIn, toast, until } from "/app/core.js";
import { sentence as say, tone } from "/app/words.js";

const POLL_MS = 15000;
const STALE_AFTER_FAILS = 2;
const TERMINAL = new Set(["reconciled", "failed", "cancelled", "confirmed"]);

const key = storedKey();
if (!key) toSignIn();
const bind = client(key);

const state = {
  me: null,
  ws: null,
  approvals: [],
  workflows: new Map(),
  attention: [],
  events: [],
  cursor: null,
  fails: 0,
  lastOk: 0,
  roles: new Map(),
};

const $ = (id) => document.getElementById(id);

// ---- Loading -------------------------------------------------------------------------------------------------------

async function loadAll() {
  const id = state.me.workspaceId;
  const [ws, approvals, workflows, attention] = await Promise.all([
    bind.workspace(id),
    bind.listApprovals(id),
    bind.listWorkflows(id),
    bind.needsAttention(id).catch(() => ({ items: [] })),
  ]);
  state.ws = ws.workspace;
  state.roles = new Map((ws.roles ?? []).map((r) => [r.role_name, r.display_name]));
  state.approvals = approvals.filter((a) => a.status === "pending" && Date.parse(a.expires_at) > Date.now());
  state.workflows = new Map(workflows.map((w) => [w.id, w]));
  state.attention = (attention.items ?? []).filter((i) => i.kind !== "approval");
}

async function loadEvents(initial) {
  const id = state.me.workspaceId;
  const page = await bind.pollEvents(id, initial || !state.cursor ? { limit: 40 } : { after: state.cursor, limit: 100 });
  state.cursor = page.nextCursor;
  const fresh = page.events ?? [];
  if (initial) state.events = fresh.slice().reverse();
  else if (fresh.length) state.events = fresh.slice().reverse().concat(state.events).slice(0, 80);
  return fresh.length;
}

// ---- Rendering ------------------------------------------------------------------------------------------------------

function approvalView(a) {
  const wf = state.workflows.get(a.entity_id);
  const ctx = wf?.context_data ?? {};
  const quote = ctx.quote ?? {};
  const qty = quote.quantity ?? ctx.reorderQty;
  const item = ctx.itemName ?? ctx.sku ?? "an item";
  const headline = qty ? `Buy ${qty} × ${item}` : a.action_requested;
  return { wf, ctx, quote, item, qty, headline, simulated: quote.isSimulated === true };
}

function renderNeeds() {
  const list = $("needs-list");
  list.removeAttribute("aria-busy");
  list.textContent = "";
  const threshold = Number(state.ws?.approval_threshold_cents ?? 0);
  const rows = [];
  for (const a of state.approvals) {
    const v = approvalView(a);
    const over = Number(a.amount_cents) > threshold ? `over your ${money(threshold, a.currency)} limit` : "needs your approval";
    rows.push(
      h(
        "li",
        {},
        h(
          "button",
          { class: "need", type: "button", "data-approval": a.id, onclick: () => openApproval(a.id) },
          mark("pending"),
          h(
            "span",
            { class: "need-text" },
            h("span", { class: "need-head" }, v.headline),
            h("span", { class: "need-sub" }, `Waiting for you · ${over}`),
            h("span", { class: "need-meta" }, `${state.roles.get(a.requester_role) ?? "An agent"} · ${ago(a.created_at)} · expires ${until(a.expires_at)}`),
            h(
              "span",
              { class: "tags" },
              v.simulated ? h("span", { class: "tag tag-sim" }, "Simulated supplier") : null,
              h("span", { class: "tag tag-commit" }, "Commits the business")
            )
          ),
          h("span", { class: "need-amount num" }, money(a.amount_cents, a.currency))
        )
      )
    );
  }
  for (const item of state.attention) {
    rows.push(
      h(
        "li",
        {},
        h(
          "div",
          { class: "need need-static" },
          mark("refused"),
          h(
            "span",
            { class: "need-text" },
            h("span", { class: "need-head" }, `${item.kind.replace(/_/g, " ")} needs a look`),
            h("span", { class: "need-sub" }, `Failed · ${(item.codes ?? []).join(", ").replace(/_/g, " ").toLowerCase() || "see details"}`),
            h("span", { class: "need-meta" }, `Next: ${String(item.nextAction).replace(/_/g, " ")} · since ${ago(item.since)}`)
          )
        )
      )
    );
  }
  list.append(...rows);
  $("needs-empty").hidden = rows.length > 0;
  $("needs-count").textContent = rows.length ? String(rows.length) : "";
}

function renderFeed() {
  const feed = $("feed");
  feed.removeAttribute("aria-busy");
  feed.textContent = "";
  let lastDay = "";
  for (const e of state.events.slice(0, 40)) {
    const day = new Date(e.at).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    if (day !== lastDay) {
      feed.append(h("li", { class: "feed-day" }, day === new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" }) ? "Today" : day));
      lastDay = day;
    }
    feed.append(
      h(
        "li",
        { class: "feed-item", "data-event": e.id },
        mark(tone(e)),
        h("span", { class: "feed-text" }, say(e, state.roles)),
        h("time", { class: "feed-time", datetime: e.at }, ago(e.at))
      )
    );
  }
  $("feed-empty").hidden = state.events.length > 0;

  const running = [...state.workflows.values()].filter((w) => !TERMINAL.has(w.state) && w.state !== "awaiting_approval");
  const strip = $("running");
  strip.textContent = "";
  strip.hidden = running.length === 0;
  for (const w of running.slice(0, 3)) {
    const item = w.context_data?.itemName ?? w.context_data?.sku ?? "an item";
    strip.append(h("p", { class: "running-item" }, mark("held"), h("span", {}, `Working on a reorder of ${item}`), h("span", { class: "muted" }, ` · ${w.state.replace(/_/g, " ")}`)));
  }
}

function renderPause() {
  showPaused(!!state.ws?.agents_paused, state.me.role);
}

function renderStale() {
  const stale = state.fails >= STALE_AFTER_FAILS;
  $("stale-banner").hidden = !stale;
  if (stale) $("stale-text").textContent = state.lastOk ? `Can't reach Bind. Last updated ${ago(new Date(state.lastOk).toISOString())}. Retrying.` : "Can't reach Bind right now. Retrying.";
  document.querySelectorAll("[data-needs-server]").forEach((b) => (b.disabled = stale));
  $("live-dot").classList.toggle("is-off", stale);
}

function renderAll() {
  renderPause();
  renderNeeds();
  renderFeed();
  renderStale();
}

// ---- The approval panel ---------------------------------------------------------------------------------------------

function row(label, value) {
  return h("div", { class: "fact" }, h("dt", {}, label), h("dd", {}, value));
}

function openApproval(id) {
  const a = state.approvals.find((x) => x.id === id);
  if (!a) return;
  const v = approvalView(a);
  const ws = state.ws ?? {};
  const threshold = Number(ws.approval_threshold_cents ?? 0);
  const daily = Number(ws.budget_daily_limit_cents ?? 0);
  const amount = Number(a.amount_cents);
  const isOwner = state.me.role === "owner";
  // Tiered confirm (UX brief): one tap for small items, press and hold over the threshold, type the amount for the largest.
  const tier = daily && amount > daily / 2 ? "type" : amount > threshold ? "hold" : "tap";
  const idem = newKey();
  const body = $("sheet-body");
  body.textContent = "";

  const scores = v.ctx.jevEvaluation?.scoreBreakdown ? Object.keys(v.ctx.jevEvaluation.scoreBreakdown).length : v.quote.quoteId ? 1 : 0;
  const result = h("div", { class: "sheet-result", role: "status", "aria-live": "polite" });

  const close = h("button", { class: "sheet-close", type: "button", "aria-label": "Close", onclick: () => $("approval-sheet").close() }, "×");
  body.append(
    close,
    h("p", { class: "eyebrow" }, "Waiting for you"),
    h("h2", { class: "sheet-title", id: "sheet-title" }, v.headline),
    h("p", { class: "sheet-amount num" }, money(a.amount_cents, a.currency)),
    h(
      "div",
      { class: "tags" },
      h("span", { class: v.simulated ? "tag tag-sim" : "tag tag-live" }, v.simulated ? "Simulated supplier" : "Live supplier"),
      h("span", { class: "tag tag-commit" }, "Commits the business: approving places a real order")
    ),
    h(
      "dl",
      { class: "facts" },
      row("Against your limits", `${money(amount, a.currency)} is over your ${money(threshold, a.currency)} approval threshold. Daily limit ${money(daily, a.currency)}.`),
      v.quote.supplierName ? row("Supplier", h("q", { class: "untrusted" }, v.quote.supplierName)) : null,
      v.quote.unitPriceCents ? row("Price", `${money(v.quote.unitPriceCents, a.currency)} each × ${v.qty}`) : null,
      row("Why now", v.ctx.currentQty !== undefined ? `Stock is ${v.ctx.currentQty} against a par level of ${v.ctx.parLevel}.` : "An agent asked for this."),
      row("What was compared", scores > 1 ? `${scores} quotes. This one scored best on price and reliability.` : scores === 1 ? "One quote was available, from the supplier above." : "No comparison was recorded."),
      row("If you approve", "The order goes to the supplier. Delivery and payment are reported separately, in What is happening."),
      row("If you reject", "Nothing is bought, and the request is closed."),
      row("Expires", `This request expires ${until(a.expires_at)}. After that it can't be approved.`)
    ),
    h(
      "details",
      { class: "sheet-details" },
      h("summary", {}, "Show details"),
      h(
        "dl",
        { class: "facts small" },
        row("Asked by", `${state.roles.get(a.requester_role) ?? a.requester_role} · ${new Date(a.created_at).toLocaleString()}`),
        v.wf ? row("Work item", `${v.wf.id} · ${v.wf.state.replace(/_/g, " ")}`) : null,
        row("Request", h("q", { class: "untrusted" }, a.action_requested)),
        row("Approval id", a.id)
      )
    ),
    result
  );

  if (!isOwner) {
    body.append(h("p", { class: "sheet-note" }, mark("held"), "An owner decides this. You can follow it here."));
  } else {
    const reject = h("button", { class: "btn btn-quiet", type: "button", "data-needs-server": "" }, "Reject");
    const approve = h("button", { class: "btn btn-primary approve", type: "button", "data-needs-server": "" }, tier === "hold" ? "Hold to approve" : "Approve");
    const typed = tier === "type" ? h("input", { class: "type-amount", id: "type-amount", inputmode: "decimal", autocomplete: "off", "aria-describedby": "type-help" }) : null;
    const actions = h("div", { class: "sheet-actions" }, reject, approve);
    if (typed) {
      body.append(
        h("label", { class: "type-label", for: "type-amount" }, `Type ${money(amount, a.currency)} to approve`),
        typed,
        h("p", { class: "help", id: "type-help" }, "A large purchase. Typing the amount makes sure it's the one you mean.")
      );
      approve.disabled = true;
      typed.addEventListener("input", () => {
        const n = Math.round(Number(typed.value.replace(/[^0-9.]/g, "")) * 100);
        approve.disabled = n !== amount;
      });
    }
    body.append(actions);

    const decide = async (kind) => {
      reject.disabled = true;
      approve.disabled = true;
      result.textContent = "";
      result.append(mark("pending"), h("span", {}, "Confirming with Bind…"));
      try {
        const op = kind === "approve" ? "approveApproval" : "rejectApproval";
        const res = await bind.call(op, { params: { id: a.id }, ...(kind === "reject" ? { body: {} } : {}), idempotencyKey: idem });
        const status = res?._meta?.status;
        result.textContent = "";
        if (kind === "reject") {
          result.append(mark("held"), h("span", {}, "Rejected. Nothing was bought."));
        } else if (status === "completed") {
          result.append(mark("approved"), h("span", {}, "Done. The supplier confirmed the order."));
        } else if (res?.inDoubt) {
          result.append(mark("refused"), h("span", {}, "Sent, but the supplier's answer is unclear. It will not be sent twice; check What is happening."));
        } else {
          result.append(mark("pending"), h("span", {}, "Sent. Waiting for the supplier to confirm."));
        }
        toast(kind === "reject" ? "Rejected" : status === "completed" ? "Approved and confirmed" : "Approved. Waiting for the supplier");
        await refresh(true);
        setTimeout(() => $("approval-sheet").open && $("approval-sheet").close(), 1600);
      } catch (err) {
        result.textContent = "";
        const msg = err instanceof BindApiError ? err.message : "Can't reach Bind. Nothing was changed. Try again.";
        result.append(mark("refused"), h("span", {}, msg));
        reject.disabled = false;
        approve.disabled = tier === "type";
      }
    };
    reject.addEventListener("click", () => decide("reject"));
    if (tier === "hold") holdToConfirm(approve, () => decide("approve"));
    else approve.addEventListener("click", () => decide("approve"));
  }

  const sheet = $("approval-sheet");
  sheet.showModal();
  close.focus();
}

/** Press and hold for 900 ms to confirm. Keyboard: hold Enter or Space. Releasing early cancels. */
function holdToConfirm(btn, onConfirm) {
  const HOLD_MS = 900;
  let timer = 0;
  const start = (e) => {
    if (btn.disabled) return;
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    if (e.type === "keydown" && e.repeat) return;
    e.preventDefault();
    btn.classList.add("is-holding");
    timer = window.setTimeout(() => {
      btn.classList.remove("is-holding");
      onConfirm();
    }, HOLD_MS);
  };
  const stop = () => {
    window.clearTimeout(timer);
    btn.classList.remove("is-holding");
  };
  btn.addEventListener("pointerdown", start);
  btn.addEventListener("keydown", start);
  ["pointerup", "pointerleave", "pointercancel", "keyup", "blur"].forEach((t) => btn.addEventListener(t, stop));
  btn.addEventListener("click", (e) => e.preventDefault());
}

// ---- Refresh loop ---------------------------------------------------------------------------------------------------

let inflight = null;
async function refresh(full) {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const fresh = await loadEvents(false);
      if (full || fresh > 0) await loadAll();
      state.fails = 0;
      state.lastOk = Date.now();
      renderAll();
    } catch (err) {
      if (err instanceof BindApiError && err.status === 401) {
        clearKey();
        toSignIn();
        return;
      }
      state.fails += 1;
      renderStale();
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function main() {
  $("today-date").textContent = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  try {
    state.me = await bind.me();
  } catch (err) {
    if (err instanceof BindApiError && (err.status === 401 || err.status === 404)) {
      clearKey();
      toSignIn();
      return;
    }
    state.fails = STALE_AFTER_FAILS;
    $("stale-banner").hidden = false;
    $("refresh-now").addEventListener("click", () => window.location.reload());
    return;
  }
  shell({
    me: state.me,
    onSignOut: async () => {
      if (state.me.credential === "account_session") await bind.call("signOut", {}).catch(() => undefined);
      clearKey();
      window.location.replace("/app/sign-in");
    },
  });
  pauseControl({ bind, me: state.me, isPaused: () => !!state.ws?.agents_paused, onChange: (p) => { state.ws.agents_paused = p; renderPause(); } });
  $("refresh-now").addEventListener("click", () => refresh(true));
  try {
    await Promise.all([loadAll(), loadEvents(true)]);
    state.lastOk = Date.now();
  } catch (err) {
    state.fails = STALE_AFTER_FAILS;
  }
  if (state.ws) renderAll();
  else renderStale();
  window.setInterval(() => {
    if (document.visibilityState === "visible") refresh(false);
  }, POLL_MS);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refresh(false));
  window.addEventListener("online", () => refresh(true));
}

main();
