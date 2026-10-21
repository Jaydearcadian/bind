/*
 * Connections (ADR 0065; UX brief: "Team, Connections and Business data"). Grouped by kind with a health strip on top. Status
 * words are honest: "Verified live" only after a verifier passed; a supplier you vouch for is "Approved by you", which is not a
 * live check; a simulated one says so. Keys go to the server once and never come back. Staff see suppliers and messaging apps.
 */
import { BindApiError, ago, clearKey, client, h, newKey, pauseControl, shell, showDemo, showPaused, storedKey, toSignIn, toast } from "/app/core.js";

const key = storedKey();
if (!key) toSignIn();
const bind = client(key);
const $ = (id) => document.getElementById(id);

const KIND_WORDS = { accounting: "Accounting", messaging: "Messaging", supplier: "Supplier system", llm: "AI model provider", other: "Other" };
const SURFACE_WORDS = { whatsapp: "WhatsApp", telegram: "Telegram", instagram: "Instagram", slack: "Slack", email: "Email", email_magic_link: "Email link", pos_webhook: "Till system", web_ui: "Web" };
const STATUS = {
  simulated: { word: "Simulated", tone: "neutral" },
  unverified: { word: "Added, not verified", tone: "outline" },
  verified: { word: "Verified live", tone: "ok" },
  attention: { word: "Needs attention", tone: "pending" },
  revoked: { word: "Revoked", tone: "muted" },
};

const state = { me: null, ws: null, tools: null, toolsProblem: "", suppliers: [], surfaces: [], revoking: null };

function badge(kind, text) {
  const s = STATUS[kind];
  return h("span", { class: `status status-${s.tone}` }, text ?? s.word);
}

function errorText(err, fallback) {
  if (err instanceof BindApiError) {
    if (err.status === 503) return "This Bind server isn't set up to store keys yet. Whoever runs it needs to add an encryption key.";
    if (err.status === 403) return "Only owners can do that.";
    if (err.status === 404) return "That's already gone. The list is up to date now.";
    if (err.status === 400 && /Demo workspaces/.test(err.message)) return "A demo uses simulated suppliers only. Start your own workspace to add real ones.";
    if (err.status === 400) return "Bind couldn't accept that. Check the fields and try again.";
  }
  return fallback;
}

/** "Harbor Produce" -> "harbor-produce": an id the server accepts, made from the name. */
function slug(text) {
  const s = text.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56);
  return /^[a-z]/.test(s) ? s : `c-${s}`.slice(0, 56);
}

// ---- Health -----------------------------------------------------------------------------------------------------------

function supplierStatus(s) {
  if (s.is_simulated) return "simulated";
  return s.verified ? "unverified" : "attention";
}

function renderHealth() {
  const counts = { verified: 0, unverified: 0, simulated: 0, attention: 0 };
  for (const t of state.tools ?? []) if (t.status !== "revoked") counts[t.status === "verified" ? "verified" : "unverified"]++;
  for (const s of state.suppliers) counts[supplierStatus(s)]++;
  for (const b of state.surfaces) counts[b.integration_status === "simulated" ? "simulated" : "unverified"]++;
  const box = $("health");
  box.removeAttribute("aria-busy");
  const parts = [];
  if (counts.attention) parts.push(h("span", { class: "health-item is-attention" }, `${counts.attention} ${counts.attention === 1 ? "needs" : "need"} you`));
  if (counts.verified) parts.push(h("span", { class: "health-item" }, `${counts.verified} verified live`));
  if (counts.unverified) parts.push(h("span", { class: "health-item" }, `${counts.unverified} added, not verified`));
  if (counts.simulated) parts.push(h("span", { class: "health-item" }, `${counts.simulated} simulated`));
  const total = counts.verified + counts.unverified + counts.simulated + counts.attention;
  box.replaceChildren(
    h("p", { class: "health-lead" }, total ? (counts.attention ? "Something here needs you." : "Everything here is in order.") : "Nothing is connected yet."),
    h("div", { class: "health-items" }, parts)
  );
}

// ---- Tools and services -----------------------------------------------------------------------------------------------

function renderTools() {
  const list = $("tools");
  list.removeAttribute("aria-busy");
  list.textContent = "";
  if (state.toolsProblem) {
    list.append(h("li", { class: "line-empty" }, state.toolsProblem));
    return;
  }
  if (!state.tools.length) {
    list.append(h("li", { class: "line-empty" }, "No tools connected yet."));
    return;
  }
  const owner = state.me.role === "owner";
  for (const t of state.tools) {
    const revoked = t.status === "revoked";
    const when = revoked ? `removed ${ago(t.updatedAt)}` : t.lastVerifiedAt ? `last checked ${ago(t.lastVerifiedAt)}` : `added ${ago(t.updatedAt)}`;
    list.append(
      h(
        "li",
        { class: `line${revoked ? " is-past" : ""}` },
        h(
          "div",
          { class: "line-main" },
          h("p", { class: "line-title" }, t.connectorId, " ", badge(revoked ? "revoked" : t.status === "verified" ? "verified" : "unverified")),
          h("p", { class: "line-sub" }, `${KIND_WORDS[t.kind] ?? t.kind} · ${when}`, t.fingerprint ? h("span", { class: "mono" }, ` · fingerprint ${t.fingerprint.slice(-6)}`) : null)
        ),
        owner && !revoked
          ? h(
              "div",
              { class: "line-actions" },
              h("button", { class: "btn-small", type: "button", "aria-label": `Test ${t.connectorId}`, onclick: (e) => testTool(t, e.currentTarget) }, "Test"),
              h("button", { class: "btn-small", type: "button", "aria-label": `Remove ${t.connectorId}`, onclick: () => askRevoke(t) }, "Remove")
            )
          : null
      )
    );
  }
}

async function loadTools() {
  if (state.me.role !== "owner") {
    state.tools = [];
    state.toolsProblem = "Only owners can see tools and their keys.";
    return;
  }
  try {
    state.tools = await bind.call("listConnectors", { params: { id: state.me.workspaceId } });
    state.toolsProblem = "";
  } catch (err) {
    state.tools = [];
    state.toolsProblem = errorText(err, "Couldn't load tools right now.");
    if (err instanceof BindApiError && err.status === 503) $("add-tool-btn").hidden = true;
  }
}

async function testTool(t, btn) {
  btn.disabled = true;
  try {
    const res = await bind.call("verifyConnector", { params: { id: state.me.workspaceId, connectorId: t.connectorId } });
    if (res.verification === "VERIFIED") toast(`${t.connectorId} works. It's verified live.`);
    else if (res.verification === "FAILED") toast(`${t.connectorId} didn't pass the test. Check the key, or add a new one.`);
    else toast(`There's no automatic test for this kind yet, so ${t.connectorId} stays "Added, not verified".`);
  } catch (err) {
    toast(errorText(err, "Couldn't run the test. Try again."));
  }
  await loadTools();
  renderTools();
  renderHealth();
}

function askRevoke(t) {
  state.revoking = t;
  $("revoke-name").textContent = t.connectorId;
  $("revoke-error").hidden = true;
  $("revoke-sheet").showModal();
}

function wireTools() {
  const form = $("tool-form");
  const open = $("add-tool-btn");
  open.hidden = state.me.role !== "owner" || !!state.toolsProblem;
  const close = () => {
    form.hidden = true;
    form.reset();
    $("tool-error").hidden = true;
    open.hidden = false;
    open.focus();
  };
  open.addEventListener("click", () => {
    form.hidden = false;
    open.hidden = true;
    $("tool-name").focus();
  });
  $("tool-cancel").addEventListener("click", close);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("tool-name").value.trim();
    const secret = $("tool-secret").value;
    const err = $("tool-error");
    const problem = !name ? "Give it a name you'll recognise." : !secret.trim() ? "Paste the key or token." : "";
    if (problem) {
      err.textContent = problem;
      err.hidden = false;
      return;
    }
    const save = $("tool-save");
    save.disabled = true;
    try {
      const id = slug(name);
      await bind.call("setConnector", { params: { id: state.me.workspaceId, connectorId: id }, body: { kind: $("tool-kind").value, secret } });
      // The key leaves the page with the form.
      close();
      toast(`${id} is added. Use Test to check it works.`);
      await loadTools();
      renderTools();
      renderHealth();
    } catch (e2) {
      err.textContent = errorText(e2, "Couldn't save it. Try again.");
      err.hidden = false;
    } finally {
      save.disabled = false;
    }
  });

  const sheet = $("revoke-sheet");
  sheet.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => sheet.close()));
  $("revoke-confirm").addEventListener("click", async () => {
    const t = state.revoking;
    if (!t) return;
    const btn = $("revoke-confirm");
    btn.disabled = true;
    try {
      await bind.call("revokeConnector", { params: { id: state.me.workspaceId, connectorId: t.connectorId }, idempotencyKey: newKey() });
      sheet.close();
      toast(`${t.connectorId} was removed and its key destroyed.`);
      await loadTools();
      renderTools();
      renderHealth();
    } catch (err) {
      $("revoke-error").textContent = errorText(err, "Couldn't remove it. Try again.");
      $("revoke-error").hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
}

// ---- Suppliers --------------------------------------------------------------------------------------------------------

function renderSuppliers() {
  const list = $("suppliers");
  list.removeAttribute("aria-busy");
  list.textContent = "";
  if (!state.suppliers.length) {
    list.append(h("li", { class: "line-empty" }, "No suppliers yet."));
    return;
  }
  const owner = state.me.role === "owner";
  for (const s of state.suppliers) {
    const st = supplierStatus(s);
    const sub = s.is_simulated
      ? "Practice supplier: quotes are made up and nothing is really ordered."
      : s.verified
        ? `Approved by you · quotes by email or phone${s.contact_email ? ` · ${s.contact_email}` : ""}`
        : "Not approved: agents can ask for quotes, but nothing can be bought until you approve.";
    list.append(
      h(
        "li",
        { class: "line" },
        h("div", { class: "line-main" }, h("p", { class: "line-title" }, s.name, " ", badge(st)), h("p", { class: "line-sub" }, sub)),
        owner && !s.is_simulated
          ? h(
              "div",
              { class: "line-actions" },
              h(
                "button",
                { class: "btn-small", type: "button", "aria-label": `${s.verified ? "Stop buying from" : "Approve"} ${s.name}`, onclick: (e) => setApproved(s, !s.verified, e.currentTarget) },
                s.verified ? "Stop buying" : "Approve"
              )
            )
          : null
      )
    );
  }
}

async function loadSuppliers() {
  state.suppliers = await bind.call("listSuppliers", { params: { id: state.me.workspaceId } });
}

function supplierBody(s, verified) {
  const body = { id: s.id, name: s.name, adapterType: s.adapter_type, verified, isSimulated: s.is_simulated };
  if (s.contact_email) body.contactEmail = s.contact_email;
  if (s.endpoint_url) body.endpointUrl = s.endpoint_url;
  return body;
}

async function setApproved(s, verified, btn) {
  btn.disabled = true;
  try {
    await bind.call("upsertSupplier", { params: { id: state.me.workspaceId }, body: supplierBody(s, verified), idempotencyKey: newKey() });
    toast(verified ? `${s.name} is approved. Agents may buy from them, inside your limits.` : `Agents won't buy from ${s.name} any more.`);
  } catch (err) {
    toast(errorText(err, "Couldn't change that. Try again."));
  }
  await loadSuppliers().catch(() => undefined);
  renderSuppliers();
  renderHealth();
}

function wireSuppliers() {
  const form = $("supplier-form");
  const open = $("add-supplier-btn");
  open.hidden = state.me.role !== "owner";
  const close = () => {
    form.hidden = true;
    form.reset();
    $("supplier-error").hidden = true;
    open.hidden = false;
    open.focus();
  };
  open.addEventListener("click", () => {
    form.hidden = false;
    open.hidden = true;
    $("supplier-name").focus();
  });
  $("supplier-cancel").addEventListener("click", close);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("supplier-error");
    const name = $("supplier-name").value.trim();
    const email = $("supplier-email").value.trim();
    const problem = name.length < 2 ? "Add the supplier's name." : email && !$("supplier-email").checkValidity() ? "That email doesn't look right." : "";
    if (problem) {
      err.textContent = problem;
      err.hidden = false;
      return;
    }
    const save = $("supplier-save");
    save.disabled = true;
    try {
      const body = { id: slug(name), name, adapterType: "manual_quote", verified: $("supplier-approve").checked, isSimulated: false };
      if (email) body.contactEmail = email;
      const made = await bind.call("upsertSupplier", { params: { id: state.me.workspaceId }, body, idempotencyKey: newKey() });
      close();
      toast(made.verified ? `${made.name} is added and approved.` : `${made.name} is added. Approve them when you're ready to buy.`);
      await loadSuppliers();
      renderSuppliers();
      renderHealth();
    } catch (e2) {
      err.textContent = e2 instanceof BindApiError && e2.status === 409 ? "That name is taken by another supplier. Try a slightly different one." : errorText(e2, "Couldn't add the supplier. Try again.");
      err.hidden = false;
    } finally {
      save.disabled = false;
    }
  });
}

// ---- Messaging apps ---------------------------------------------------------------------------------------------------

function renderSurfaces() {
  const list = $("surfaces");
  list.removeAttribute("aria-busy");
  list.textContent = "";
  if (!state.surfaces.length) {
    list.append(h("li", { class: "line-empty" }, "No one is connected through a messaging app yet."));
    return;
  }
  for (const b of state.surfaces) {
    // A binding's status is set by an owner, not by a live check, so "verified" here is never shown as "Verified live".
    const st = b.integration_status === "simulated" ? badge("simulated") : b.integration_status === "verified" ? badge("unverified", "Marked verified by an owner") : badge("unverified");
    list.append(
      h(
        "li",
        { class: "line" },
        h(
          "div",
          { class: "line-main" },
          h("p", { class: "line-title" }, b.actor_label || b.actor_id, " ", st),
          h("p", { class: "line-sub" }, `${SURFACE_WORDS[b.surface] ?? b.surface} · ${b.actor_role === "owner" ? "Owner" : "Staff"}`)
        )
      )
    );
  }
}

// ---- Page -------------------------------------------------------------------------------------------------------------

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
    onSignOut: async () => {
      if (state.me.credential === "account_session") await bind.call("signOut", {}).catch(() => undefined);
      clearKey();
      window.location.replace("/app/sign-in");
    },
  });
  showPaused(state.me.agentsPaused, state.me.role);
  pauseControl({ bind, me: state.me, isPaused: () => state.me.agentsPaused, onChange: (p) => { state.me.agentsPaused = p; showPaused(p, state.me.role); } });
  $("refresh-now").addEventListener("click", () => window.location.reload());
  try {
    const [ws, , , surfaces] = await Promise.all([
      bind.workspace(state.me.workspaceId),
      loadTools(),
      loadSuppliers(),
      bind.call("listSurfaces", { params: { id: state.me.workspaceId } }),
    ]);
    state.surfaces = surfaces;
    showDemo({ bind, me: state.me, ws: ws.workspace });
    wireTools();
    wireSuppliers();
    renderTools();
    renderSuppliers();
    renderSurfaces();
    renderHealth();
  } catch {
    $("stale-banner").hidden = false;
  }
}

main();
