/*
 * Settings (ADR 0067; UX brief: "People, Settings, Help and the shell"). The workspace facts, appearance for this device, the
 * notification channels that exist (in-app) and the ones still coming, how you are signed in, and For builders: access keys
 * (shown once, revoked behind a confirm, the last owner key protected by the server) and the messaging signing secret.
 * Things that don't exist yet say "Coming" instead of offering a switch that does nothing.
 */
import { BindApiError, ago, clearKey, client, h, newKey, pauseControl, shell, showDemo, showPaused, storedKey, toSignIn, toast } from "/app/core.js";

const key = storedKey();
if (!key) toSignIn();
const bind = client(key);
const $ = (id) => document.getElementById(id);

const state = { me: null, tokens: [], confirm: null };

// ---- Appearance -------------------------------------------------------------------------------------------------------

function readTheme() {
  try {
    const t = window.localStorage.getItem("bind-theme");
    return t === "light" || t === "dark" ? t : "device";
  } catch {
    return "device";
  }
}

function applyTheme(value) {
  const root = document.documentElement;
  if (value === "light" || value === "dark") root.setAttribute("data-theme", value);
  else root.removeAttribute("data-theme");
  try {
    if (value === "device") window.localStorage.removeItem("bind-theme");
    else window.localStorage.setItem("bind-theme", value);
  } catch {
    // Private mode: it applies to this page only.
  }
}

function wireTheme() {
  const current = readTheme();
  document.querySelectorAll('input[name="theme"]').forEach((r) => {
    r.checked = r.value === current;
    r.addEventListener("change", () => {
      if (!r.checked) return;
      applyTheme(r.value);
      toast(r.value === "device" ? "Following this device." : `${r.value === "dark" ? "Dark" : "Light"} on this device.`);
    });
  });
}

// ---- Workspace and sign-in --------------------------------------------------------------------------------------------

function renderWorkspace(ws) {
  const fact = (k, v) => h("div", { class: "fact" }, h("dt", {}, k), h("dd", {}, v));
  $("ws-facts").replaceChildren(
    fact("Name", ws.name),
    fact("Team", String(ws.template_id).startsWith("kitchen") ? "Kitchen team" : ws.template_id),
    fact("Started", new Date(ws.created_at).toLocaleDateString(undefined, { dateStyle: "long" })),
    fact("Your role", state.me.role === "owner" ? "Owner" : "Staff"),
    fact("Time zone", Intl.DateTimeFormat().resolvedOptions().timeZone || "Your device's")
  );
  const session = state.me.credential === "account_session";
  $("signin-now").textContent = session ? "Signed in with your account" : "Signed in with an access key";
  $("signin-sub").textContent = session ? `As ${state.me.label}.` : `The key named "${state.me.label}". Signing out of this browser doesn't turn the key off; an owner can remove it below.`;
}

// ---- For builders: keys -----------------------------------------------------------------------------------------------

function keyError(err, fallback) {
  if (err instanceof BindApiError) {
    if (err.code === "LAST_OWNER_TOKEN" || err.status === 409) return "This is the last owner key, so it stays. Make another owner key first, or add an owner in People.";
    if (err.status === 403) return "Only owners can do that.";
    if (err.status === 404) return "That key is already gone. The list is up to date now.";
  }
  return fallback;
}

/** The key this browser uses, when /api/me's label points at exactly one active key (labels need not be unique). */
function ownKey(active) {
  if (state.me.credential === "account_session") return null;
  const same = active.filter((t) => t.label === state.me.label);
  return same.length === 1 ? same[0] : null;
}

function renderKeys() {
  const list = $("keys");
  list.removeAttribute("aria-busy");
  const active = state.tokens.filter((t) => !t.revokedAt);
  const removed = state.tokens.filter((t) => t.revokedAt);
  const mine = ownKey(active);
  list.replaceChildren(
    ...(active.length ? [] : [h("li", { class: "line-empty" }, "No active keys.")]),
    ...active.map((t) =>
      h(
        "li",
        { class: "line" },
        h(
          "div",
          { class: "line-main" },
          h("p", { class: "line-title" }, t.label, t === mine ? h("span", { class: "status status-neutral" }, "This browser") : null),
          h("p", { class: "line-sub" }, `${t.role === "owner" ? "Owner" : "Staff"} · made ${ago(t.createdAt)}`)
        ),
        h("button", { class: "btn-small", type: "button", "aria-label": `Remove the key ${t.label}`, onclick: () => askRemoveKey(t) }, "Remove")
      )
    ),
    ...removed.slice(0, 5).map((t) =>
      h("li", { class: "line is-past" }, h("div", { class: "line-main" }, h("p", { class: "line-title" }, t.label), h("p", { class: "line-sub" }, `Removed ${ago(t.revokedAt)}`)))
    )
  );
}

async function loadKeys() {
  state.tokens = await bind.call("listTokens", { params: { id: state.me.workspaceId } });
  state.tokens.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  renderKeys();
}

function askRemoveKey(t) {
  const self = t === ownKey(state.tokens.filter((x) => !x.revokedAt));
  confirmSheet({
    title: `Remove the key "${t.label}"?`,
    text: self
      ? "This looks like the key this browser is using. Removing it signs you out here, and anything else using it stops at once."
      : "Anything using it stops working at once. What it already did stays in Activity.",
    go: "Remove key",
    run: async () => {
      await bind.call("revokeToken", { params: { id: state.me.workspaceId, tokenId: t.id }, idempotencyKey: newKey() });
      toast(`The key "${t.label}" was removed.`);
      await loadKeys().catch(() => undefined);
    },
    error: (err) => keyError(err, "Couldn't remove the key. Try again."),
  });
}

function wireKeys() {
  const form = $("key-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const label = $("key-label").value.trim();
    const err = $("key-error");
    if (!label) {
      err.textContent = "Say what it's for, so you can tell keys apart later.";
      err.hidden = false;
      $("key-label").focus();
      return;
    }
    err.hidden = true;
    $("key-make").disabled = true;
    try {
      const made = await bind.call("issueToken", { params: { id: state.me.workspaceId }, body: { role: $("key-role").value, label } });
      $("key-for").textContent = made.label;
      $("key-value").value = made.token;
      form.hidden = true;
      $("key-made").hidden = false;
      $("key-value").focus();
      $("key-value").select();
      await loadKeys().catch(() => undefined);
    } catch (e2) {
      err.textContent = keyError(e2, "Couldn't make the key. Try again.");
      err.hidden = false;
    } finally {
      $("key-make").disabled = false;
    }
  });
  $("key-copy").addEventListener("click", () => copy($("key-value"), "Key copied."));
  $("key-done").addEventListener("click", () => {
    // The key leaves the page here.
    $("key-value").value = "";
    $("key-made").hidden = true;
    form.reset();
    form.hidden = false;
    $("key-label").focus();
  });
}

// ---- For builders: signing secret -------------------------------------------------------------------------------------

async function showSecret() {
  $("secret-error").hidden = true;
  try {
    const res = await bind.call("getWebhookSecret", { params: { id: state.me.workspaceId } });
    $("secret-value").value = res.secret;
    $("secret-row").hidden = false;
    $("secret-show").textContent = "Hide secret";
  } catch (err) {
    $("secret-error").textContent =
      err instanceof BindApiError && err.status === 403
        ? "Only owners can see it."
        : err instanceof BindApiError && err.status === 503
          ? "Message signing isn't set up on this Bind server yet. Whoever runs it needs to add a master secret."
          : "Couldn't load it right now.";
    $("secret-error").hidden = false;
  }
}

function hideSecret() {
  $("secret-value").value = "";
  $("secret-row").hidden = true;
  $("secret-show").textContent = "Show secret";
}

function wireSecret() {
  $("secret-show").addEventListener("click", () => ($("secret-row").hidden ? showSecret() : hideSecret()));
  $("secret-copy").addEventListener("click", () => copy($("secret-value"), "Secret copied."));
  $("secret-rotate").addEventListener("click", () =>
    confirmSheet({
      title: "Replace the signing secret?",
      text: "The old secret stops working at once. Every messaging adapter must be given the new one, or Bind will refuse what it sends.",
      go: "Replace secret",
      run: async () => {
        await bind.call("rotateWebhookSecret", { params: { id: state.me.workspaceId }, idempotencyKey: newKey() });
        toast("Replaced. Give the new secret to your messaging adapters.");
        await showSecret();
      },
      error: (err) => (err instanceof BindApiError && err.status === 503 ? "Message signing isn't set up on this Bind server yet." : "Couldn't replace it. Try again."),
    })
  );
}

// ---- Shared -----------------------------------------------------------------------------------------------------------

async function copy(field, done) {
  try {
    await navigator.clipboard.writeText(field.value);
    toast(done);
  } catch {
    field.select();
    toast("Select it and copy.");
  }
}

function confirmSheet(opts) {
  state.confirm = opts;
  $("confirm-title").textContent = opts.title;
  $("confirm-text").textContent = opts.text;
  $("confirm-go").textContent = opts.go;
  $("confirm-error").hidden = true;
  $("confirm-sheet").showModal();
}

function wireConfirm() {
  const sheet = $("confirm-sheet");
  sheet.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => sheet.close()));
  $("confirm-go").addEventListener("click", async () => {
    const opts = state.confirm;
    if (!opts) return;
    $("confirm-go").disabled = true;
    try {
      await opts.run();
      sheet.close();
    } catch (err) {
      if (err instanceof BindApiError && err.status === 401) {
        // The key this browser used is gone.
        clearKey();
        window.location.replace("/app/sign-in");
        return;
      }
      $("confirm-error").textContent = opts.error(err);
      $("confirm-error").hidden = false;
    } finally {
      $("confirm-go").disabled = false;
    }
  });
}

// ---- Page -------------------------------------------------------------------------------------------------------------

async function main() {
  wireTheme();
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
    const ws = (await bind.workspace(state.me.workspaceId)).workspace;
    renderWorkspace(ws);
    showDemo({ bind, me: state.me, ws });
  } catch {
    $("stale-banner").hidden = false;
  }
  if (state.me.role !== "owner") {
    $("builders-staff").hidden = false;
    return;
  }
  $("builders-owner").hidden = false;
  wireConfirm();
  wireKeys();
  wireSecret();
  await loadKeys().catch(() => {
    $("keys").replaceChildren(h("li", { class: "line-empty" }, "Couldn't load keys right now."));
  });
}

main();
