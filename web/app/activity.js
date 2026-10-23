/*
 * Activity (ADR 0059; UX brief: "a timeline by day with filters, and Follow this on any item opening its full history").
 * Built from the workspace event stream's poll route. Staff do not receive owner-only events; the server enforces that.
 */
import { BindApiError, ago, clearKey, client, h, mark, pauseControl, shell, showDemo, showPaused, storedKey, toSignIn, signOutNow } from "/app/core.js";
import { sentence, tone } from "/app/words.js";

const PAGE = 200;
const MAX_EVENTS = 2000;
const POLL_MS = 15000;

const key = storedKey();
if (!key) toSignIn();
const bind = client(key);
const $ = (id) => document.getElementById(id);

const state = { me: null, ws: null, roles: new Map(), events: [], cursor: "0.0", truncated: false, filter: "all", problemsOnly: false, fails: 0 };

const GROUPS = {
  purchases: /^(order|replenishment|commitment|approval|settlement|accounting|inventory|supplier|workflow)\./,
  customers: /^customer_order\./,
  menu: /^(menu|feedback|document)\./,
  access: /^(token|member|invite|webhook_secret|connector|surface|agent_role|workspace)\./,
};

function matches(e) {
  if (state.filter !== "all" && !GROUPS[state.filter].test(e.name)) return false;
  if (state.problemsOnly && tone(e) !== "refused" && tone(e) !== "pending") return false;
  return true;
}

/** The thread an event belongs to: its workflow, or the object it is about. */
function threadOf(e) {
  if (e.workflowId) return { key: `wf:${e.workflowId}`, workflowId: e.workflowId };
  if (e.object && e.object.id) return { key: `${e.object.type}:${e.object.id}`, objectType: e.object.type, objectId: e.object.id };
  return null;
}

async function loadHistory() {
  // Read forward from the start in pages; keep the newest MAX_EVENTS.
  const all = [];
  let cursor = "0.0";
  for (;;) {
    const page = await bind.pollEvents(state.me.workspaceId, { after: cursor, limit: PAGE });
    all.push(...(page.events ?? []));
    cursor = page.nextCursor;
    if (!page.hasMore) break;
    if (all.length > MAX_EVENTS * 3) break;
  }
  state.truncated = all.length > MAX_EVENTS;
  state.events = all.slice(-MAX_EVENTS).reverse();
  state.cursor = cursor;
}

async function poll() {
  try {
    const page = await bind.pollEvents(state.me.workspaceId, { after: state.cursor, limit: PAGE });
    state.cursor = page.nextCursor;
    if (page.events?.length) {
      state.events = page.events.slice().reverse().concat(state.events).slice(0, MAX_EVENTS);
      render();
    }
    state.fails = 0;
    $("stale-banner").hidden = true;
  } catch (err) {
    if (err instanceof BindApiError && err.status === 401) {
      clearKey();
      toSignIn();
      return;
    }
    state.fails += 1;
    if (state.fails >= 1) {
      $("stale-banner").hidden = false;
      $("stale-text").textContent = "Can't reach Bind. Showing what we had. Retrying.";
    }
  }
}

function render() {
  const list = $("timeline");
  list.removeAttribute("aria-busy");
  list.textContent = "";
  const shown = state.events.filter(matches);
  let lastDay = "";
  const todayLabel = new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
  for (const e of shown) {
    const day = new Date(e.at).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    if (day !== lastDay) {
      list.append(h("li", { class: "feed-day" }, day === todayLabel ? "Today" : day));
      lastDay = day;
    }
    const thread = threadOf(e);
    list.append(
      h(
        "li",
        { class: "feed-item timeline-item", "data-event": e.id },
        mark(tone(e)),
        h(
          "span",
          { class: "feed-text" },
          sentence(e, state.roles)
        ),
        h(
          "span",
          { class: "timeline-side" },
          h("time", { class: "feed-time", datetime: e.at, title: new Date(e.at).toLocaleString() }, ago(e.at)),
          thread ? h("button", { class: "follow", type: "button", onclick: () => follow(thread, e) }, "Follow this") : null
        )
      )
    );
  }
  $("timeline-count").textContent = shown.length ? String(shown.length) : "";
  $("timeline-empty").hidden = shown.length > 0;
  $("timeline-empty-sub").textContent = state.events.length ? "Nothing matches this filter." : "When your agents and team act, it is recorded here.";
  const note = $("timeline-note");
  note.hidden = !state.truncated;
  note.textContent = state.truncated ? `Showing the newest ${MAX_EVENTS} events.` : "";
}

async function follow(thread, origin) {
  const sheet = $("follow-sheet");
  const body = $("follow-body");
  body.textContent = "";
  const close = h("button", { class: "sheet-close", type: "button", "aria-label": "Close", onclick: () => sheet.close() }, "×");
  const related = state.events.filter((e) => threadOf(e)?.key === thread.key).slice().reverse();
  const detail = h("dl", { class: "facts small" });
  body.append(
    close,
    h("p", { class: "eyebrow" }, "Follow this"),
    h("h2", { class: "sheet-title", id: "follow-title" }, sentence(origin, state.roles)),
    detail,
    h("h3", { class: "thread-head" }, "Its whole story"),
    h(
      "ol",
      { class: "feed thread" },
      related.map((e) =>
        h("li", { class: "feed-item" }, mark(tone(e)), h("span", { class: "feed-text" }, sentence(e, state.roles), e.correlationId ? h("span", { class: "fine ref" }, ` · request ${e.correlationId.slice(0, 8)}`) : null), h("time", { class: "feed-time", datetime: e.at, title: new Date(e.at).toLocaleString() }, new Date(e.at).toLocaleString()))
      )
    )
  );
  sheet.showModal();
  close.focus();
  // The current state, read from the resource itself: an event says what happened, the resource says what is true now.
  if (thread.workflowId) {
    try {
      const wf = await bind.call("getWorkflow", { params: { id: state.me.workspaceId, workflowId: thread.workflowId } });
      const ctx = wf.context_data ?? {};
      detail.append(
        h("div", { class: "fact" }, h("dt", {}, "Now"), h("dd", {}, String(wf.state).replace(/_/g, " "))),
        ctx.itemName ? h("div", { class: "fact" }, h("dt", {}, "Item"), h("dd", {}, ctx.itemName)) : null,
        ctx.quote?.supplierName ? h("div", { class: "fact" }, h("dt", {}, "Supplier"), h("dd", {}, h("q", { class: "untrusted" }, ctx.quote.supplierName))) : null,
        h("div", { class: "fact" }, h("dt", {}, "Started"), h("dd", {}, new Date(wf.created_at).toLocaleString()))
      );
    } catch {
      detail.append(h("div", { class: "fact" }, h("dt", {}, "Now"), h("dd", {}, "Couldn't load the current state.")));
    }
  } else if (thread.objectType) {
    detail.append(h("div", { class: "fact" }, h("dt", {}, "About"), h("dd", {}, `${thread.objectType.replace(/_/g, " ")} ${thread.objectId}`)));
  }
}

function wireFilters() {
  document.querySelectorAll(".chip[data-filter]").forEach((chip) =>
    chip.addEventListener("click", () => {
      state.filter = chip.getAttribute("data-filter");
      document.querySelectorAll(".chip[data-filter]").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
      render();
    })
  );
  $("only-problems").addEventListener("change", (e) => {
    state.problemsOnly = e.target.checked;
    render();
  });
  // Staff never receive access events, so the filter would always be empty for them.
  if (state.me.role !== "owner") document.querySelector('.chip[data-filter="access"]')?.remove();
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
  wireFilters();
  $("refresh-now").addEventListener("click", () => poll());
  try {
    const ws = await bind.workspace(state.me.workspaceId);
    state.roles = new Map((ws.roles ?? []).map((r) => [r.role_name, r.display_name]));
    showDemo({ bind, me: state.me, ws: ws.workspace });
    await loadHistory();
  } catch {
    $("stale-banner").hidden = false;
  }
  render();
  window.setInterval(() => document.visibilityState === "visible" && poll(), POLL_MS);
}

main();
