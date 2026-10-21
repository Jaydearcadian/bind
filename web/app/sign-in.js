/*
 * Sign in (ADR 0059 for access keys, ADR 0072 for Google and wallet). Privy proves who someone is; Bind swaps that proof for
 * a short-lived session in one workspace. A first sign-in with no workspace starts one or joins from an invite link; an
 * account with several chooses. An access key is checked with the server before it is kept, for this tab unless "Remember
 * this device" is ticked. Anything the server says is shown as plain words, never as raw text.
 */
import { BindApiError, KEY_PATTERN, client, storeKey, storedKey } from "/app/core.js";
import {
  accountError,
  clearPendingInvite,
  createWorkspace,
  getAdapter,
  joinWithInvite,
  lastWorkspace,
  listWorkspaces,
  loadPublicConfig,
  mayResume,
  noteResume,
  openWorkspace,
  pendingInvite,
  takeSignedOutMark,
} from "/app/account.js";

const $ = (id) => document.getElementById(id);
const VIEWS = ["providers", "busy", "invite", "start", "choose"];
const HOME = "/app/";

// ---- Access key (builders and early testers) -------------------------------------------------------------------------

const keyForm = $("key-form");
const keyInput = $("key");
const remember = $("remember");
const keyError = $("key-error");
const keySubmit = $("key-submit");

function showKeyError(text) {
  keyError.textContent = text;
  keyError.hidden = false;
  keyInput.setAttribute("aria-invalid", "true");
  keyInput.focus();
}

// Already signed in on this tab or device: go straight to Today.
const existing = storedKey();
if (existing) {
  client(existing)
    .me()
    .then(() => window.location.replace(HOME))
    .catch(() => undefined);
}

keyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  keyError.hidden = true;
  keyInput.removeAttribute("aria-invalid");
  const key = keyInput.value.trim();
  if (!KEY_PATTERN.test(key)) {
    showKeyError("That doesn't look like an access key. It starts with bnd_ and is 47 characters long.");
    return;
  }
  keySubmit.disabled = true;
  keySubmit.textContent = "Checking…";
  try {
    await client(key).me();
    if (!storeKey(key, remember.checked)) {
      showKeyError("This browser won't keep the key (storage is blocked). Allow site data for this address and try again.");
      return;
    }
    window.location.replace(HOME);
  } catch (err) {
    if (err instanceof BindApiError && (err.status === 401 || err.status === 404)) {
      showKeyError("That key isn't valid, or it has been revoked. Ask an owner of the workspace for a new one.");
    } else if (err instanceof BindApiError && err.status === 429) {
      showKeyError("Too many tries. Wait a minute, then try again.");
    } else {
      showKeyError("Can't reach Bind right now. Check your connection and try again.");
    }
  } finally {
    keySubmit.disabled = false;
    keySubmit.textContent = "Sign in";
  }
});

// ---- Google and wallet ------------------------------------------------------------------------------------------------

let adapter = null;

/** Shows one view. The access key form stays under the provider buttons only; it would be noise mid-flow. */
function show(view, busyText) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
  $("soon").hidden = true;
  const door = view === "providers";
  keyForm.hidden = !door;
  $("key-or").hidden = !door;
  if (busyText) $("busy-text").textContent = busyText;
}

function say(id, text) {
  const el = $(id);
  el.textContent = text;
  el.hidden = !text;
}

/** A fresh Privy token for the call about to be made; the SDK refreshes it as needed. */
async function privyToken() {
  const token = await adapter.getAccessToken();
  if (!token) throw new BindApiError({ status: 401, message: "no sign-in", body: null });
  return token;
}

async function enter(workspaceId, displayName) {
  show("busy", "Opening your workspace…");
  await openWorkspace(await privyToken(), workspaceId, displayName);
  window.location.replace(HOME);
}

function showChoose(list) {
  const last = lastWorkspace();
  const ordered = list.slice().sort((a, b) => (a.id === last ? -1 : b.id === last ? 1 : a.name.localeCompare(b.name)));
  const ul = $("choose-list");
  ul.replaceChildren(
    ...ordered.map((w) => {
      const li = document.createElement("li");
      li.className = "line";
      const main = document.createElement("div");
      main.className = "line-main";
      const title = document.createElement("p");
      title.className = "line-title";
      title.textContent = w.name;
      const sub = document.createElement("p");
      sub.className = "line-sub";
      sub.textContent = `${w.role === "owner" ? "Owner" : "Staff"}${w.id === last ? " · last opened" : ""}`;
      main.append(title, sub);
      const open = document.createElement("button");
      open.className = "btn-small";
      open.type = "button";
      open.textContent = "Open";
      open.setAttribute("aria-label", `Open ${w.name}`);
      open.addEventListener("click", async () => {
        say("choose-error", "");
        open.disabled = true;
        try {
          await enter(w.id);
        } catch (err) {
          show("choose");
          say("choose-error", accountError(err, "Couldn't open that workspace. Try again."));
          open.disabled = false;
        }
      });
      li.append(main, open);
      return li;
    })
  );
  show("choose");
}

/** Decides where an identified account goes next. */
async function afterIdentity() {
  show("busy", "Checking your workspaces…");
  const token = await privyToken();
  if (pendingInvite()) {
    show("invite");
    return;
  }
  const list = await listWorkspaces(token);
  if (!list.length) {
    show("start");
    return;
  }
  if (list.length === 1) {
    await enter(list[0].id);
    return;
  }
  showChoose(list);
}

async function run(step, errorId, fallback) {
  try {
    await step();
  } catch (err) {
    show(errorId === "provider-error" ? "providers" : errorId.replace("-error", ""));
    say(errorId, accountError(err, fallback));
  }
}

function wireProviders() {
  $("google-btn").addEventListener("click", () =>
    run(
      async () => {
        say("provider-error", "");
        show("busy", "Taking you to Google…");
        await adapter.startGoogle(`${window.location.origin}/app/sign-in`);
      },
      "provider-error",
      "We couldn't reach Google sign-in. Try again."
    )
  );
  $("wallet-btn").addEventListener("click", () =>
    run(
      async () => {
        say("provider-error", "");
        if (!window.ethereum) {
          say("provider-error", "No wallet found in this browser. Open this page in a wallet app, or use Google.");
          return;
        }
        show("busy", "Waiting for your wallet…");
        await adapter.connectWallet(window.ethereum);
        await afterIdentity();
      },
      "provider-error",
      "Sign-in was cancelled or didn't finish. Try again."
    )
  );

  $("invite-join").addEventListener("click", () =>
    run(
      async () => {
        say("invite-error", "");
        $("invite-join").disabled = true;
        const token = await privyToken();
        const name = $("invite-name").value.trim();
        const joined = await joinWithInvite(token, pendingInvite());
        clearPendingInvite();
        const list = joined ? [joined] : await listWorkspaces(token);
        const target = joined ? joined.id : (list.find((w) => w.id === lastWorkspace()) ?? list[0])?.id;
        if (!target) throw new Error("no workspace");
        await enter(target, name);
      },
      "invite-error",
      "Couldn't join with that link. Ask for a new one."
    ).finally(() => ($("invite-join").disabled = false))
  );
  $("invite-skip").addEventListener("click", () => {
    clearPendingInvite();
    run(afterIdentity, "provider-error", "Something went wrong. Try signing in again.");
  });

  $("start-go").addEventListener("click", () =>
    run(
      async () => {
        const name = $("start-name").value.trim();
        if (name.length < 2) {
          say("start-error", "Give your workspace a name, like the name of your business.");
          $("start-name").focus();
          return;
        }
        say("start-error", "");
        $("start-go").disabled = true;
        show("busy", "Setting up your workspace…");
        const token = await privyToken();
        const template = document.querySelector('input[name="team"]:checked')?.value || "kitchen-v1";
        const id = await createWorkspace(token, name, template);
        await enter(id, $("start-person").value.trim());
      },
      "start-error",
      "Couldn't set up the workspace. Try again."
    ).finally(() => ($("start-go").disabled = false))
  );
}

async function main() {
  const appId = await loadPublicConfig();
  if (!appId) {
    $("soon").hidden = false;
    return;
  }
  wireProviders();
  show("providers");
  try {
    adapter = await getAdapter(appId);
  } catch {
    say("provider-error", "Sign-in with Google or a wallet isn't available right now. You can still use an access key.");
    $("google-btn").disabled = true;
    $("wallet-btn").disabled = true;
    return;
  }

  // Signed out on purpose: end the Privy session in this tab too, then offer the buttons again.
  if (takeSignedOutMark()) {
    await adapter.logout().catch(() => undefined);
    return;
  }

  // Coming back from Google: finish the login, and take the one-time codes out of the address bar either way.
  const returning = /[?&]privy_oauth_code=/.test(window.location.search);
  if (returning) {
    show("busy", "Finishing sign-in…");
    const search = window.location.search;
    window.history.replaceState(null, "", window.location.pathname);
    try {
      if (await adapter.finishOAuth(search)) await afterIdentity();
      else show("providers");
    } catch (err) {
      show("providers");
      say("provider-error", accountError(err, "Google sign-in didn't finish. Try again."));
    }
    return;
  }

  // Still signed in with Privy in this tab: pick up where it left off without asking again.
  if (await adapter.getAccessToken().catch(() => null)) {
    if (!pendingInvite() && lastWorkspace() && mayResume()) {
      noteResume();
      try {
        await enter(lastWorkspace());
        return;
      } catch {
        // The workspace is gone or the session was refused: fall through to choosing.
      }
    }
    await run(afterIdentity, "provider-error", "Something went wrong. Try signing in again.");
  }
}

main();
