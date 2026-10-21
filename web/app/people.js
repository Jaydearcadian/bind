/*
 * People and access (ADR 0064; UX brief: "People, Settings, Help and the shell"). Owners make single-use staff invite links,
 * see who is still to join, and change or remove the people who belong. Staff see a short note instead. Every change is a server
 * call and the lists show what the server returned. An invite code is shown once and never kept by the page.
 */
import { BindApiError, ago, clearKey, client, h, pauseControl, shell, showDemo, showPaused, storedKey, toSignIn, toast, until } from "/app/core.js";

const key = storedKey();
if (!key) toSignIn();
const bind = client(key);
const $ = (id) => document.getElementById(id);

const state = { me: null, invites: [], members: [], removing: null };

function inviteState(inv, now = Date.now()) {
  if (inv.usedAt) return "used";
  if (inv.revokedAt) return "cancelled";
  if (Date.parse(inv.expiresAt) <= now) return "expired";
  return "waiting";
}

const PAST_WORDS = { used: "Joined", cancelled: "Cancelled", expired: "Expired" };

function errorText(err, fallback) {
  if (err instanceof BindApiError) {
    if (err.code === "LAST_OWNER") return "A workspace always keeps at least one owner. Make someone else an owner first.";
    if (err.status === 403) return "Only owners can do that.";
    if (err.status === 0 || err.status >= 500) return "Can't reach Bind right now. Try again in a moment.";
    if (err.status === 404) return "That's already gone. The list is up to date now.";
  }
  return fallback;
}

// ---- Invites ----------------------------------------------------------------------------------------------------------

function renderInvites() {
  const now = Date.now();
  const waiting = state.invites.filter((i) => inviteState(i, now) === "waiting");
  const past = state.invites.filter((i) => inviteState(i, now) !== "waiting");
  const list = $("invites");
  list.removeAttribute("aria-busy");
  list.textContent = "";
  if (!waiting.length) list.append(h("li", { class: "line-empty" }, "No one is waiting to join."));
  for (const inv of waiting) {
    list.append(
      h(
        "li",
        { class: "line" },
        h("div", { class: "line-main" }, h("p", { class: "line-title" }, inv.label), h("p", { class: "line-sub" }, `Staff · link works ${until(inv.expiresAt, now)} · made by ${inv.createdBy}`)),
        h("button", { class: "btn-small", type: "button", "aria-label": `Cancel the invite for ${inv.label}`, onclick: (e) => cancelInvite(inv, e.currentTarget) }, "Cancel")
      )
    );
  }
  $("past-wrap").hidden = !past.length;
  $("past-invites").replaceChildren(
    ...past.map((inv) => {
      const s = inviteState(inv, now);
      const when = s === "used" ? inv.usedAt : s === "cancelled" ? inv.revokedAt : inv.expiresAt;
      return h("li", { class: "line is-past" }, h("div", { class: "line-main" }, h("p", { class: "line-title" }, inv.label), h("p", { class: "line-sub" }, `${PAST_WORDS[s]} ${ago(when, now)}`)));
    })
  );
}

async function loadInvites() {
  state.invites = await bind.call("listInvites", { params: { id: state.me.workspaceId } });
  renderInvites();
}

async function cancelInvite(inv, btn) {
  btn.disabled = true;
  try {
    await bind.call("revokeInvite", { params: { id: state.me.workspaceId, inviteId: inv.id } });
    toast(`Cancelled the invite for ${inv.label}. The link no longer works.`);
  } catch (err) {
    toast(errorText(err, "Couldn't cancel that invite. Try again."));
  }
  await loadInvites().catch(() => undefined);
}

async function showQr(link) {
  const box = $("invite-qr");
  box.hidden = true;
  box.textContent = "";
  try {
    const { qrSvgPath } = await import("/app/qr.js");
    const { size, d } = qrSvgPath(link);
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "QR code for the invite link");
    svg.setAttribute("shape-rendering", "crispEdges");
    const bg = document.createElementNS(ns, "rect");
    bg.setAttribute("width", String(size));
    bg.setAttribute("height", String(size));
    bg.setAttribute("fill", "#fff");
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "#14110E");
    svg.append(bg, path);
    box.append(svg, h("p", { class: "help" }, "Or let them scan this with their phone camera."));
    box.hidden = false;
  } catch {
    // No QR on this build: the link alone is enough.
  }
}

function wireInviteForm() {
  const form = $("invite-form");
  const label = $("invite-label");
  const err = $("invite-error");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = label.value.trim();
    if (!text) {
      err.textContent = "Add a name so you can tell invites apart.";
      err.hidden = false;
      label.setAttribute("aria-invalid", "true");
      label.focus();
      return;
    }
    err.hidden = true;
    label.removeAttribute("aria-invalid");
    const submit = $("invite-submit");
    submit.disabled = true;
    try {
      const made = await bind.call("createInvite", {
        params: { id: state.me.workspaceId },
        body: { label: text, expiresInHours: Number($("invite-expiry").value) },
      });
      // The code goes in the fragment, so it never reaches a server log when the link is opened.
      const link = `${window.location.origin}/app/join#${made.code}`;
      $("invite-for").textContent = made.label;
      $("invite-link").value = link;
      $("invite-until").textContent = new Date(made.expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
      form.hidden = true;
      $("invite-made").hidden = false;
      $("invite-link").focus();
      $("invite-link").select();
      showQr(link);
      await loadInvites().catch(() => undefined);
    } catch (e2) {
      err.textContent = errorText(e2, "Couldn't make the invite. Try again.");
      err.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
  $("invite-copy").addEventListener("click", async () => {
    const field = $("invite-link");
    try {
      await navigator.clipboard.writeText(field.value);
      toast("Link copied.");
    } catch {
      field.select();
      toast("Select the link and copy it.");
    }
  });
  $("invite-another").addEventListener("click", () => {
    $("invite-made").hidden = true;
    $("invite-link").value = "";
    $("invite-qr").textContent = "";
    $("invite-qr").hidden = true;
    form.hidden = false;
    label.value = "";
    label.focus();
  });
}

// ---- Members ----------------------------------------------------------------------------------------------------------

const nameOf = (m) => m.displayName || "Someone without a name yet";

function renderMembers() {
  const list = $("members");
  list.removeAttribute("aria-busy");
  list.textContent = "";
  if (!state.members.length) {
    list.append(h("li", { class: "line-empty" }, "No one has joined with Google or a wallet yet."));
    return;
  }
  for (const m of state.members) {
    const id = `role-${m.accountId}`;
    const select = h(
      "select",
      { id, class: "text-input role-select", "aria-label": `Role for ${nameOf(m)}`, onchange: (e) => changeRole(m, e.currentTarget) },
      h("option", { value: "owner", selected: m.role === "owner" }, "Owner"),
      h("option", { value: "staff", selected: m.role === "staff" }, "Staff")
    );
    list.append(
      h(
        "li",
        { class: "line" },
        h("div", { class: "line-main" }, h("p", { class: "line-title" }, nameOf(m)), h("p", { class: "line-sub" }, `Joined ${ago(m.joinedAt)}`)),
        h("div", { class: "line-actions" }, select, h("button", { class: "btn-small", type: "button", "aria-label": `Remove ${nameOf(m)}`, onclick: () => askRemove(m) }, "Remove"))
      )
    );
  }
}

async function loadMembers() {
  state.members = await bind.call("listMembers", { params: { id: state.me.workspaceId } });
  renderMembers();
}

async function changeRole(m, select) {
  const role = select.value;
  select.disabled = true;
  try {
    await bind.call("setMemberRole", { params: { id: state.me.workspaceId, accountId: m.accountId }, body: { role } });
    toast(role === "owner" ? `${nameOf(m)} is now an owner. They can approve spending and change limits.` : `${nameOf(m)} is now staff.`);
  } catch (err) {
    toast(errorText(err, "Couldn't change that role. Try again."));
  }
  await loadMembers().catch(() => undefined);
  document.getElementById(`role-${m.accountId}`)?.focus();
}

function askRemove(m) {
  state.removing = m;
  $("remove-name").textContent = nameOf(m);
  $("remove-error").hidden = true;
  $("remove-sheet").showModal();
}

function wireRemove() {
  const sheet = $("remove-sheet");
  sheet.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => sheet.close()));
  $("remove-confirm").addEventListener("click", async () => {
    const m = state.removing;
    if (!m) return;
    const btn = $("remove-confirm");
    btn.disabled = true;
    try {
      await bind.call("removeMember", { params: { id: state.me.workspaceId, accountId: m.accountId } });
      sheet.close();
      toast(`${nameOf(m)} was removed and signed out.`);
      await loadMembers().catch(() => undefined);
    } catch (err) {
      $("remove-error").textContent = errorText(err, "Couldn't remove them. Try again.");
      $("remove-error").hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
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

  bind.workspace(state.me.workspaceId).then((ws) => showDemo({ bind, me: state.me, ws: ws.workspace }), () => undefined);
  if (state.me.role !== "owner") {
    $("staff-note").hidden = false;
    return;
  }
  $("owner-area").hidden = false;
  wireInviteForm();
  wireRemove();
  try {
    await Promise.all([loadInvites(), loadMembers()]);
  } catch {
    $("stale-banner").hidden = false;
  }
}

main();
