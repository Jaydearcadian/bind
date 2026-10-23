/*
 * Team and limits (ADR 0062; UX brief: "Team, Connections and Business data"). The workspace's two limits as plain sentences
 * with sliders and presets, and a card per agent: what it can do, its tools as switches, on or off, and a name the owner can
 * change. Staff see everything read-only. Every change is a server call; the page shows what the server stored.
 */
import { BindApiError, clearKey, client, h, money, newKey, pauseControl, shell, showDemo, showPaused, storedKey, toSignIn, toast, signOutNow } from "/app/core.js";

const key = storedKey();
if (!key) toSignIn();
const bind = client(key);
const $ = (id) => document.getElementById(id);

const PRESETS = {
  cautious: { threshold: 5000, daily: 25000 },
  balanced: { threshold: 25000, daily: 100000 },
  trusting: { threshold: 100000, daily: 500000 },
};

const TOOL_WORDS = {
  get_business_context: "Read your business settings",
  get_stock_snapshot: "Read stock levels",
  get_approved_supplier_quotes: "Read supplier quotes",
  create_replenishment_proposal: "Propose reorders",
  request_policy_evaluation: "Check a purchase against your limits",
  get_request_status: "Check how its requests are going",
};
const EFFECT_WORDS = {
  read: "Can look",
  external_request: "Can ask suppliers and services",
  commercial_commitment: "Can commit the business, inside your limits and approvals",
};

const state = { me: null, ws: null, roles: [], safeTools: [], saved: { threshold: 0, daily: 0 } };

// ---- Limits -----------------------------------------------------------------------------------------------------------

function cents(dollarsText) {
  const n = Number(String(dollarsText).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

function setLimitInputs(threshold, daily) {
  const t = $("threshold");
  const d = $("daily");
  d.max = String(Math.max(1000000, daily));
  d.value = String(daily);
  t.max = String(Number(d.value));
  t.value = String(Math.min(threshold, Number(d.value)));
  $("threshold-num").value = (threshold / 100).toFixed(0);
  $("daily-num").value = (daily / 100).toFixed(0);
  renderLimitText();
}

function currentLimits() {
  return { threshold: cents($("threshold-num").value), daily: cents($("daily-num").value) };
}

function renderLimitText() {
  const { threshold, daily } = currentLimits();
  $("threshold-out").textContent = Number.isFinite(threshold) ? money(threshold) : "?";
  $("daily-out").textContent = Number.isFinite(daily) ? money(daily) : "?";
  const err = $("limits-error");
  let problem = "";
  if (!Number.isFinite(daily) || daily <= 0) problem = "The daily limit must be more than $0.";
  else if (!Number.isFinite(threshold) || threshold < 0) problem = "The approval amount can't be below $0.";
  else if (threshold > daily) problem = "The approval amount can't be more than the daily limit.";
  err.hidden = !problem;
  err.textContent = problem;
  const changed = threshold !== state.saved.threshold || daily !== state.saved.daily;
  $("limits-save").disabled = !!problem || !changed || state.me?.role !== "owner";
  $("limits-reset").hidden = !changed;
  $("limits-summary").textContent = problem
    ? ""
    : `Agents will ask you before anything over ${money(threshold)}, and never spend more than ${money(daily)} in a day.${changed ? " Not saved yet." : ""}`;
  document.querySelectorAll("[data-preset]").forEach((b) => {
    const p = PRESETS[b.getAttribute("data-preset")];
    b.setAttribute("aria-pressed", String(p.threshold === threshold && p.daily === daily));
  });
}

function wireLimits() {
  const isOwner = state.me.role === "owner";
  $("limits-note").textContent = isOwner ? "" : "Only an owner can change these.";
  const inputs = ["threshold", "daily", "threshold-num", "daily-num"].map($);
  inputs.forEach((el) => (el.disabled = !isOwner));
  document.querySelectorAll("[data-preset]").forEach((b) => (b.disabled = !isOwner));
  $("threshold").addEventListener("input", (e) => {
    $("threshold-num").value = (Number(e.target.value) / 100).toFixed(0);
    renderLimitText();
  });
  $("daily").addEventListener("input", (e) => {
    $("daily-num").value = (Number(e.target.value) / 100).toFixed(0);
    $("threshold").max = e.target.value;
    renderLimitText();
  });
  $("threshold-num").addEventListener("input", () => {
    const c = cents($("threshold-num").value);
    if (Number.isFinite(c)) $("threshold").value = String(c);
    renderLimitText();
  });
  $("daily-num").addEventListener("input", () => {
    const c = cents($("daily-num").value);
    if (Number.isFinite(c)) {
      $("daily").max = String(Math.max(1000000, c));
      $("daily").value = String(c);
      $("threshold").max = String(c);
    }
    renderLimitText();
  });
  document.querySelectorAll("[data-preset]").forEach((b) =>
    b.addEventListener("click", () => {
      const p = PRESETS[b.getAttribute("data-preset")];
      setLimitInputs(p.threshold, p.daily);
    })
  );
  $("limits-reset").addEventListener("click", () => setLimitInputs(state.saved.threshold, state.saved.daily));
  $("limits-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { threshold, daily } = currentLimits();
    const save = $("limits-save");
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      const res = await bind.call("updatePolicy", {
        params: { id: state.me.workspaceId },
        body: { budgetDailyLimitCents: daily, approvalThresholdCents: threshold },
        idempotencyKey: newKey(),
      });
      // Show what the server stored, not what was sent.
      state.saved = { threshold: Number(res.workspace.approval_threshold_cents), daily: Number(res.workspace.budget_daily_limit_cents) };
      setLimitInputs(state.saved.threshold, state.saved.daily);
      toast("Limits saved");
    } catch (err) {
      $("limits-error").hidden = false;
      $("limits-error").textContent = err instanceof BindApiError ? err.message : "Can't reach Bind. Nothing was changed.";
    } finally {
      save.textContent = "Save limits";
      renderLimitText();
    }
  });
}

// ---- Agents -----------------------------------------------------------------------------------------------------------

function switchEl(id, label, checked, disabled, onChange) {
  const input = h("input", { type: "checkbox", role: "switch", id, class: "switch-input" });
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener("change", () => onChange(input));
  return h("label", { class: "switch", for: id }, input, h("span", { class: "switch-track", "aria-hidden": "true" }), h("span", { class: "switch-label" }, label));
}

// Saves run one at a time, and each applies its change to the latest known copy of the role, so a quick second change can
// never overwrite the first with stale fields.
let saving = Promise.resolve();
function saveRole(role, patch, revert) {
  saving = saving.then(() => saveRoleNow(role.role_name, patch, revert));
  return saving;
}

async function saveRoleNow(roleName, patch, revert) {
  const role = state.roles.find((r) => r.role_name === roleName);
  if (!role) return;
  // A patch may be a function of the latest role (a tool switch adds or removes one tool from whatever is current).
  if (typeof patch === "function") patch = patch(role);
  if (!patch) return revert?.();
  const body = {
    roleName: role.role_name,
    displayName: patch.displayName ?? role.display_name,
    description: role.description && role.description.length >= 5 ? role.description : `${role.display_name} for this workspace.`,
    permittedEffects: role.permitted_effects,
    spendingLimitCents: Number(role.spending_limit_cents),
    allowedTools: patch.allowedTools ?? role.allowed_tools,
    enabled: patch.enabled ?? role.enabled,
  };
  try {
    await bind.call("upsertAgentRole", { params: { id: state.me.workspaceId }, body, idempotencyKey: newKey() });
    // Keep the local copy current at once, then read back what the server stored.
    Object.assign(role, { display_name: body.displayName, allowed_tools: body.allowedTools, enabled: body.enabled });
    await loadAgents();
    renderAgents();
    toast("Saved");
  } catch (err) {
    revert?.();
    toast(err instanceof BindApiError ? err.message : "Can't reach Bind. Nothing was changed.");
  }
}

function agentCard(role) {
  const isOwner = state.me.role === "owner";
  const id = role.role_name;
  const nameEl = h("h3", { class: "agent-name" }, role.display_name);
  const rename = isOwner
    ? h("button", { class: "link-btn", type: "button", onclick: () => startRename() }, "Rename")
    : null;
  function startRename() {
    const input = h("input", { class: "rename-input", value: role.display_name, maxlength: "120", "aria-label": "Agent name" });
    const save = h("button", { class: "btn-small", type: "button" }, "Save");
    const cancel = h("button", { class: "link-btn", type: "button" }, "Cancel");
    const form = h("div", { class: "rename" }, input, save, cancel);
    nameEl.replaceWith(form);
    rename.hidden = true;
    input.focus();
    input.select();
    const done = () => {
      form.replaceWith(nameEl);
      rename.hidden = false;
    };
    cancel.addEventListener("click", done);
    const commit = () => {
      const v = input.value.trim();
      if (v.length < 2) {
        input.setAttribute("aria-invalid", "true");
        return;
      }
      if (v === role.display_name) return done();
      saveRole(role, { displayName: v });
    };
    save.addEventListener("click", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") done();
    });
  }

  const tools = state.safeTools.map((t) => {
    const on = role.allowed_tools.includes(t);
    return h(
      "li",
      {},
      switchEl(`tool-${id}-${t}`, TOOL_WORDS[t] ?? t.replace(/_/g, " "), on, !isOwner, (input) => {
        const want = input.checked;
        saveRole(
          role,
          (latest) => {
            const next = want ? [...new Set([...latest.allowed_tools, t])] : latest.allowed_tools.filter((x) => x !== t);
            if (next.length === 0) {
              toast("An agent needs at least one tool. Turn the agent off instead.");
              return null;
            }
            return { allowedTools: next };
          },
          () => (input.checked = !want)
        );
      })
    );
  });

  return h(
    "article",
    { class: `agent ${role.enabled ? "" : "is-off"}`, "data-role": id },
    h(
      "header",
      { class: "agent-head" },
      h("div", { class: "agent-title" }, nameEl, rename),
      switchEl(`enabled-${id}`, role.enabled ? "On" : "Off", role.enabled, !isOwner, (input) =>
        saveRole(role, { enabled: input.checked }, () => (input.checked = !input.checked))
      )
    ),
    role.description ? h("p", { class: "agent-desc" }, role.description) : null,
    h("ul", { class: "effects" }, role.permitted_effects.map((e) => h("li", { class: `effect effect-${e}` }, EFFECT_WORDS[e] ?? e))),
    h("h4", { class: "tools-head" }, "What it may use"),
    h("ul", { class: "tools" }, tools),
    h(
      "details",
      { class: "see-all" },
      h("summary", {}, "See everything"),
      h(
        "dl",
        { class: "facts small" },
        h("div", { class: "fact" }, h("dt", {}, "Role"), h("dd", {}, role.role_name)),
        h("div", { class: "fact" }, h("dt", {}, "Allowed effects"), h("dd", {}, role.permitted_effects.join(", "))),
        h("div", { class: "fact" }, h("dt", {}, "Tools"), h("dd", {}, role.allowed_tools.join(", "))),
        h("div", { class: "fact" }, h("dt", {}, "Configured spend limit for this role"), h("dd", {}, money(role.spending_limit_cents))),
        h("div", { class: "fact" }, h("dt", {}, "Never allowed"), h("dd", {}, "Moving money directly, signing with raw keys, approving its own orders, or going past your limits."))
      )
    )
  );
}

function renderAgents() {
  // Redrawing must not lose the keyboard: put focus back on the same control afterwards.
  const focusedId = document.activeElement && document.activeElement.id;
  const wrap = $("agents");
  wrap.removeAttribute("aria-busy");
  wrap.textContent = "";
  if (!state.roles.length) {
    wrap.append(h("div", { class: "empty" }, h("p", { class: "empty-title" }, "No agents yet."), h("p", { class: "empty-sub" }, "A ready-made team adds them for you.")));
    return;
  }
  wrap.append(...state.roles.map(agentCard));
  if (focusedId) document.getElementById(focusedId)?.focus();
}

async function loadAgents() {
  const res = await bind.call("getAgents", { params: { id: state.me.workspaceId } });
  // Keep cards where they were: saving a role can change its position in the server's order.
  if (!state.order) state.order = res.roles.map((r) => r.role_name);
  const rank = (r) => {
    const i = state.order.indexOf(r.role_name);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  state.roles = res.roles.slice().sort((a, b) => rank(a) - rank(b));
  state.safeTools = res.safeAgentTools;
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
  try {
    const [ws] = await Promise.all([bind.workspace(state.me.workspaceId), loadAgents()]);
    state.ws = ws.workspace;
    showDemo({ bind, me: state.me, ws: state.ws });
    state.saved = { threshold: Number(state.ws.approval_threshold_cents), daily: Number(state.ws.budget_daily_limit_cents) };
    wireLimits();
    setLimitInputs(state.saved.threshold, state.saved.daily);
    renderAgents();
  } catch {
    $("stale-banner").hidden = false;
  }
}

main();
