/*
 * The page an invite link opens (ADR 0064). The code travels in the URL fragment, so it never reaches a server log. The page
 * checks its shape, keeps it in this tab only, and takes it out of the address bar. Accepting it needs a signed-in account
 * (POST /api/account/invites/accept): the sign-in page does that after Google or wallet sign-in (ADR 0072). Where sign-in
 * with an account isn't switched on, the page says so plainly.
 */
import { loadPublicConfig } from "/app/account.js";

const INVITE_PATTERN = /^bni_[A-Za-z0-9_-]{43}$/;
const STORE = "bind-invite";

let code = window.location.hash.slice(1);
if (code) {
  // Out of the address bar and history, so a shared screen or a copied URL doesn't carry it on.
  history.replaceState(null, "", window.location.pathname);
} else {
  try {
    code = sessionStorage.getItem(STORE) || "";
  } catch {
    code = "";
  }
}

const ok = INVITE_PATTERN.test(code);
if (ok) {
  try {
    sessionStorage.setItem(STORE, code);
  } catch {
    // Private mode: the link itself still works later.
  }
}
document.getElementById(ok ? "join-ok" : "join-bad").hidden = false;
if (ok) {
  // With account sign-in switched on, the invite carries through sign-in (it waits in this tab); otherwise say so plainly.
  loadPublicConfig().then((appId) => {
    document.getElementById(appId ? "join-signin" : "join-soon").hidden = false;
  });
}
