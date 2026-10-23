/*
 * Settings (ADR 0067; UX brief: "People, Settings, Help and the shell"). The workspace facts, appearance for this device, the
 * notification channels that exist (in-app) and the ones still coming, how you are signed in, and For builders: access keys
 * (shown once, revoked behind a confirm, the last owner key protected by the server) and the messaging signing secret.
 * Things that don't exist yet say "Coming" instead of offering a switch that does nothing.
 */
import { clearWalletFailed, getAdapter, loadPublicConfig, walletFailed } from "/app/account.js";
import { BindApiError, ago, clearKey, client, h, newKey, pauseControl, shell, showDemo, showPaused, storedKey, toSignIn, toast, signOutNow } from "/app/core.js";

const key = storedKey();
if (!key) toSignIn();
const bind = client(key);
const $ = (id) => document.getElementById(id);

const state = { me: null, ws: null, tokens: [], confirm: null, notify: null, rowError: null };

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
  state.ws = ws;
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
  loadPublicConfig().then((appId) => {
    if (!appId) return;
    $("signin-methods-sub").textContent = "Sign in with either one. Linking both to a single account comes later.";
    const st = $("signin-methods-status");
    st.textContent = "On";
    st.className = "status status-ok";
  });
  $("signin-sub").textContent = session ? `As ${state.me.label}.` : `The key named "${state.me.label}". Signing out of this browser doesn't turn the key off; an owner can remove it below.`;
}

// ---- Email notices (ADR 0074) -----------------------------------------------------------------------------------------

function setEmailLine(sub, status, tone = "outline") {
  $("email-sub").textContent = sub;
  const st = $("email-status");
  st.textContent = status;
  st.className = `status status-${tone}`;
}

function emailError(err, fallback) {
  const code = err instanceof BindApiError ? err.code : "";
  if (code === "EMAIL_CODE_INVALID") return err.message || "That code is wrong. Check it and try again.";
  if (code === "EMAIL_CODE_EXPIRED") return "That code has expired. Send a new one.";
  if (code === "EMAIL_ATTEMPTS_EXCEEDED") return "Too many wrong codes for this address. Try again tomorrow, or use a different address.";
  if (code === "EMAIL_SEND_LIMITED" || (err instanceof BindApiError && err.status === 429)) return "That's enough codes for now. Wait a while before asking for another.";
  if (code === "EMAIL_NOT_CONFIGURED") return "Email isn't switched on for this Bind server yet.";
  if (code === "EMAIL_DEMO_REFUSED") return "Demos don't send email. Start your own workspace to get notices.";
  if (code === "EMAIL_SEND_FAILED" || (err instanceof BindApiError && err.status === 502)) return "We couldn't send the email just now. Try again in a moment.";
  if (err instanceof BindApiError && err.status === 400) return "That doesn't look like a valid email address.";
  return fallback;
}

function renderEmail() {
  const box = $("email-box");
  if (state.me.role !== "owner") {
    setEmailLine("Owners get an email when something is waiting for them.", "Owners only");
    return;
  }
  if (state.ws?.is_demo) {
    setEmailLine("A demo doesn't send email. Your own workspace does.", "Not in a demo");
    return;
  }
  if (!state.notify) {
    setEmailLine("Couldn't load this right now.", "…");
    return;
  }
  if (state.notify.emailDelivery !== "on") {
    setEmailLine("Not switched on for this Bind server yet. Approvals still show here in Bind.", "Coming");
    return;
  }
  box.hidden = false;
  const verified = state.notify.emails.filter((e) => e.status === "verified");
  setEmailLine(
    verified.length ? "You get an email when an approval or an order is waiting for you." : "Add an address to get an email when something is waiting for you.",
    verified.length ? "On" : "Off",
    verified.length ? "ok" : "outline"
  );
  $("email-list").replaceChildren(
    ...state.notify.emails.map((e) =>
      e.status === "verified"
        ? h(
            "li",
            { class: "line" },
            h("div", { class: "line-main" }, h("p", { class: "line-title" }, e.email), h("p", { class: "line-sub" }, `Verified ${ago(e.verifiedAt)}`)),
            h("button", { class: "btn-small", type: "button", "aria-label": `Remove ${e.email}`, onclick: () => removeEmail(e) }, "Remove")
          )
        : pendingRow(e)
    )
  );
  $("email-add").hidden = !$("email-form").hidden;
}

function pendingRow(e) {
  const input = h("input", { class: "text-input code-input", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", "aria-label": `Code sent to ${e.email}`, placeholder: "6 digits" });
  const error = h("p", { class: "error", role: "alert", hidden: !state.rowError || state.rowError.id !== e.id }, state.rowError?.id === e.id ? state.rowError.text : "");
  const verify = h("button", { class: "btn btn-primary", type: "button" }, "Verify");
  verify.addEventListener("click", async () => {
    error.hidden = true;
    state.rowError = null;
    const code = input.value.trim();
    if (!/^\d{6}$/.test(code)) {
      error.textContent = "Type the 6 digits from the email.";
      error.hidden = false;
      return;
    }
    verify.disabled = true;
    try {
      await bind.call("verifyOwnerEmail", { params: { id: state.me.workspaceId }, body: { id: e.id, code } });
      toast(`${e.email} is verified. You'll get notices there.`);
      await loadNotify();
    } catch (err) {
      // The list is rebuilt from the server (attempts may have run out), so the message is kept across the rebuild.
      state.rowError = { id: e.id, text: emailError(err, "Couldn't check the code. Try again.") };
      await loadNotify().catch(() => undefined);
      return;
    }
    renderEmail();
  });
  return h(
    "li",
    { class: "line pending-email" },
    h(
      "div",
      { class: "line-main" },
      h("p", { class: "line-title" }, e.email, h("span", { class: "status status-pending" }, "Waiting for the code")),
      h("p", { class: "line-sub" }, "We emailed a 6-digit code. It works for 10 minutes."),
      h("div", { class: "code-row" }, input, verify, h("button", { class: "btn-small", type: "button", onclick: () => sendCode(e.email) }, "Send a new code"), h("button", { class: "btn-small", type: "button", "aria-label": `Cancel ${e.email}`, onclick: () => removeEmail(e) }, "Cancel")),
      error
    )
  );
}

async function loadNotify() {
  try {
    state.notify = await bind.call("getNotificationChannels", { params: { id: state.me.workspaceId } });
  } catch {
    state.notify = null;
  }
  renderEmail();
}

async function sendCode(email) {
  const err = $("email-error");
  err.hidden = true;
  $("email-send").disabled = true;
  try {
    const res = await bind.call("requestOwnerEmailVerification", { params: { id: state.me.workspaceId }, body: { email } });
    $("email-form").hidden = true;
    $("email-address").value = "";
    toast(res.status === "verified" ? "That address is already verified." : "We sent a code. Check your email.");
    await loadNotify();
  } catch (e2) {
    const msg = emailError(e2, "Couldn't send the code. Try again.");
    if ($("email-form").hidden) toast(msg);
    else {
      err.textContent = msg;
      err.hidden = false;
    }
  } finally {
    $("email-send").disabled = false;
  }
}

async function removeEmail(e) {
  try {
    await bind.call("removeOwnerEmail", { params: { id: state.me.workspaceId, emailId: e.id } });
    toast(`${e.email} was removed. No more notices there.`);
  } catch {
    toast("Couldn't remove it. Try again.");
  }
  await loadNotify();
}

function wireEmail() {
  const form = $("email-form");
  $("email-add").addEventListener("click", () => {
    form.hidden = false;
    $("email-add").hidden = true;
    $("email-address").focus();
  });
  $("email-cancel").addEventListener("click", () => {
    form.hidden = true;
    $("email-error").hidden = true;
    renderEmail();
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = $("email-address").value.trim();
    if (!email) {
      $("email-error").textContent = "Type your email address.";
      $("email-error").hidden = false;
      return;
    }
    sendCode(email);
  });
}

// ---- Your wallet ------------------------------------------------------------------------------------------------------

function walletRow(text) {
  $("wallet-body").replaceChildren(h("p", { class: "line-empty" }, text));
}

function showAddress(address) {
  const input = h("input", { id: "wallet-address", class: "text-input mono", readonly: true, "aria-label": "Your wallet address", value: address });
  $("wallet-body").replaceChildren(
    h("div", { class: "link-row" }, input, h("button", { class: "btn-small", type: "button", onclick: () => copy(input, "Address copied.") }, "Copy")),
    h("p", { class: "help" }, "This is a public address: anyone can send to it. Funds sent here are yours alone; Bind can't move them.")
  );
}

async function renderWallet() {
  if (state.me.credential !== "account_session") {
    walletRow("You're signed in with an access key, so there's no wallet here. Wallets belong to people who sign in with Google.");
    return;
  }
  const appId = await loadPublicConfig();
  let adapter = null;
  try {
    adapter = appId ? await getAdapter(appId) : null;
  } catch {
    adapter = null;
  }
  if (!adapter || typeof adapter.getWalletAddress !== "function") {
    walletRow("Wallets aren't available on this server right now.");
    return;
  }
  const token = await adapter.getAccessToken().catch(() => null);
  if (!token) {
    walletRow("Your wallet shows here while you're signed in with Google in this tab. Sign out and back in to see it.");
    return;
  }
  let address = null;
  try {
    address = await adapter.getWalletAddress();
  } catch {
    walletRow("Couldn't load your wallet right now. Try again in a moment.");
    return;
  }
  if (address) {
    clearWalletFailed();
    showAddress(address);
    return;
  }
  const make = h("button", { class: "btn btn-primary", type: "button", id: "wallet-make" }, "Set up my wallet");
  make.addEventListener("click", async () => {
    make.disabled = true;
    make.textContent = "Setting up…";
    try {
      const wallet = await adapter.ensureWallet();
      if (!wallet) throw new Error("none");
      clearWalletFailed();
      showAddress(wallet.address);
      toast("Your wallet is ready.");
    } catch {
      make.disabled = false;
      make.textContent = "Set up my wallet";
      walletRow("Couldn't set up your wallet. Try again in a moment.");
      $("wallet-body").append(make);
    }
  });
  $("wallet-body").replaceChildren(
    h("p", { class: "line-empty" }, walletFailed() ? "Setting up your wallet didn't finish when you signed in." : "You don't have a wallet yet."),
    make
  );
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
    onSignOut: () => signOutNow(bind, state.me),
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
  renderWallet().catch(() => walletRow("Couldn't load your wallet right now. Try again in a moment."));
  wireEmail();
  if (state.me.role === "owner" && !state.ws?.is_demo) await loadNotify();
  else renderEmail();
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
