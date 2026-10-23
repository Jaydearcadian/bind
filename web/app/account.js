/*
 * Signing in with an account (ADR 0072; sessions and accounts are ADR 0052). Privy proves who someone is, with Google or a
 * wallet; Bind then swaps that proof for a short-lived session in one workspace, and Privy grants nothing by itself.
 * The Privy browser SDK is a bundled, self-hosted file loaded only on the pages that sign in (ADR 0071). Tests can supply
 * an adapter with the same shape in `window.bindPrivyAdapter`; whatever it returns is still verified by the server.
 */
import { BindApiError, client, storeKey } from "/app/core.js";

const INVITE_KEY = "bind-invite";
const LAST_WS_KEY = "bind-last-workspace";
const RESUMED_AT_KEY = "bind-resumed-at";
const LOGOUT_KEY = "bind-privy-logout";
const WALLET_FAILED_KEY = "bind-wallet-failed";

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

/** The Privy app id this server is set up for, or null when sign-in with an account isn't switched on. */
export async function loadPublicConfig() {
  try {
    const res = await fetch("/api/public-config", { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.privyAppId === "string" && body.privyAppId ? body.privyAppId : null;
  } catch {
    return null;
  }
}

let adapterPromise = null;
/** The Privy adapter: a test double when one is supplied, otherwise the bundled SDK. */
export function getAdapter(appId) {
  if (!adapterPromise) {
    adapterPromise = (async () => {
      if (window.bindPrivyAdapter) return window.bindPrivyAdapter;
      const mod = await import("/app/vendor/privy.js");
      return mod.createPrivyAdapter({ appId });
    })();
    adapterPromise.catch(() => {
      adapterPromise = null;
    });
  }
  return adapterPromise;
}

// ---- Small remembered facts (none of them is a secret) ---------------------------------------------------------------

export const pendingInvite = () => safe(() => window.sessionStorage.getItem(INVITE_KEY)) || "";
export const clearPendingInvite = () => safe(() => window.sessionStorage.removeItem(INVITE_KEY));
export const lastWorkspace = () => safe(() => window.localStorage.getItem(LAST_WS_KEY)) || "";
export const rememberWorkspace = (id) => safe(() => window.localStorage.setItem(LAST_WS_KEY, id));

/** Setting up the wallet failed at sign-in: sign-in carries on, and Settings offers to try again. */
export const noteWalletFailed = () => safe(() => window.sessionStorage.setItem(WALLET_FAILED_KEY, "1"));
export const walletFailed = () => safe(() => window.sessionStorage.getItem(WALLET_FAILED_KEY)) === "1";
export const clearWalletFailed = () => safe(() => window.sessionStorage.removeItem(WALLET_FAILED_KEY));

/** Sign-out asks the sign-in page to end the Privy session in this tab too (it holds the bundled SDK). */
export function markSignedOut() {
  safe(() => window.sessionStorage.setItem(LOGOUT_KEY, "1"));
  safe(() => window.sessionStorage.removeItem(RESUMED_AT_KEY));
}
export function takeSignedOutMark() {
  const v = safe(() => window.sessionStorage.getItem(LOGOUT_KEY)) === "1";
  safe(() => window.sessionStorage.removeItem(LOGOUT_KEY));
  return v;
}

/** Silent re-sign-in is allowed once per ten seconds, so an app page that refuses a fresh session can't loop. */
export function mayResume() {
  const at = Number(safe(() => window.sessionStorage.getItem(RESUMED_AT_KEY)) || 0);
  return !at || Date.now() - at > 10000;
}
export function noteResume() {
  safe(() => window.sessionStorage.setItem(RESUMED_AT_KEY, String(Date.now())));
}

// ---- Calls with the Privy token ---------------------------------------------------------------------------------------

/** The account's workspaces, with its role in each. */
export async function listWorkspaces(privyToken) {
  return client(privyToken).call("listAccountWorkspaces", {});
}

/** Joins a workspace as staff with an invite code. An account already in it is treated as joined. */
export async function joinWithInvite(privyToken, code) {
  try {
    return await client(privyToken).call("acceptInvite", { body: { code } });
  } catch (err) {
    if (err instanceof BindApiError && err.status === 409) return null;
    throw err;
  }
}

/** A workspace id the server accepts, made from the name plus a short random tail so two "Kitchen"s don't collide. */
export function workspaceIdFor(name) {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  const tail = Array.from(window.crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${base || "workspace"}-${tail}`;
}

export async function createWorkspace(privyToken, name, templateId) {
  const id = workspaceIdFor(name);
  await client(privyToken).call("createAccountWorkspace", { body: { id, name, templateId } });
  return id;
}

/** Swaps the Privy proof for a Bind session in one workspace, keeps it for this tab, and remembers the workspace. */
export async function openWorkspace(privyToken, workspaceId, displayName) {
  const body = { workspaceId };
  if (displayName) body.displayName = displayName;
  const session = await client(privyToken).call("createSession", { body });
  if (!storeKey(session.sessionToken, false)) throw new Error("storage-blocked");
  rememberWorkspace(workspaceId);
  return session;
}

/** Plain words for what went wrong; never the raw server text. */
export function accountError(err, fallback) {
  if (err instanceof BindApiError) {
    if (err.status === 429) return "Too many tries. Wait a minute, then try again.";
    if (err.status === 401) return "Your sign-in didn't check out. Try signing in again.";
    if (err.status === 404) return "That didn't work: the invite may have been used, cancelled or expired. Ask for a new link.";
    if (err.status === 0 || err.status >= 500) return "Can't reach Bind right now. Check your connection and try again.";
  }
  if (err instanceof Error && err.message === "storage-blocked") return "This browser won't keep your session (storage is blocked). Allow site data for this address and try again.";
  return fallback;
}
