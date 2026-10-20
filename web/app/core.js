/*
 * Shared pieces of the app (ADR 0059): the stored key, the API client, formatting, and the shell (header, account menu).
 * The client is the typed SDK served by the API server at /sdk/index.js (ADR 0056). Everything shown comes from the API;
 * nothing here invents a record. Text from the API is always set as text, never as markup.
 */
import { BindClient, BindApiError } from "/sdk/index.js";

const KEY = "bind-access-key";

/** The key for this tab (sessionStorage) or this device (localStorage), or null. Storage can be unavailable. */
export function storedKey() {
  for (const store of [safe(() => window.sessionStorage), safe(() => window.localStorage)]) {
    const v = store && safe(() => store.getItem(KEY));
    if (v) return v;
  }
  return null;
}
export function storeKey(key, remember) {
  clearKey();
  const store = remember ? safe(() => window.localStorage) : safe(() => window.sessionStorage);
  if (!store || safe(() => (store.setItem(KEY, key), true)) !== true) return false;
  return true;
}
export function clearKey() {
  for (const store of [safe(() => window.sessionStorage), safe(() => window.localStorage)]) {
    if (store) safe(() => store.removeItem(KEY));
  }
}
function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

export const KEY_PATTERN = /^(bnd|bns)_[A-Za-z0-9_-]{43}$/;

export function client(key) {
  return new BindClient({ baseUrl: window.location.origin, token: key, timeoutMs: 15000 });
}
export { BindApiError };

/** Goes to sign-in, coming back here afterwards. */
export function toSignIn() {
  window.location.replace("/app/sign-in");
}

// ---- Formatting -------------------------------------------------------------------------------------------------------

export function money(cents, currency = "USD") {
  const n = Number(cents) / 100;
  if (!Number.isFinite(n)) return "";
  const cur = currency === "USDC" ? "USD" : currency;
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: cur, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.round((now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function until(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const m = Math.round((t - now) / 60000);
  if (m <= 0) return "expired";
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h} h`;
  return `on ${new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/** Builds an element. Children may be strings (set as text) or nodes. */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** The bead mark in a state, with no label (callers always add one). */
export function mark(state) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "bind-mark mini");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("data-state", state);
  const ring = document.createElementNS("http://www.w3.org/2000/svg", "path");
  ring.setAttribute("class", "ring");
  ring.setAttribute("d", "M32 12A20 20 0 1 1 32 52A20 20 0 1 1 32 12");
  const bead = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  bead.setAttribute("class", "clasp");
  bead.setAttribute("cx", "42");
  bead.setAttribute("cy", "14.68");
  bead.setAttribute("r", "6.4");
  svg.append(ring, bead);
  return svg;
}

let toastTimer = 0;
export function toast(text) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  el.classList.remove("is-out");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.classList.add("is-out");
    window.setTimeout(() => (el.hidden = true), 260);
  }, 3600);
}

/** A fresh idempotency key for one logical command (ADR 0049). */
export function newKey() {
  return window.crypto && "randomUUID" in window.crypto ? window.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---- Shell ------------------------------------------------------------------------------------------------------------

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

export function shell({ me, onSignOut }) {
  const header = document.querySelector(".site-header");
  const orbit = [...document.querySelectorAll(".site-header .orbit")];
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      header?.classList.toggle("is-compact", window.scrollY > 12);
      if (!reduce.matches) {
        const max = Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
        const angle = (Math.min(1, window.scrollY / max) * 360).toFixed(1);
        orbit.forEach((el) => el.setAttribute("transform", `rotate(${angle} 32 32)`));
      }
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const name = document.getElementById("ws-name");
  if (name) name.textContent = me.workspaceName;
  const label = document.getElementById("account-label");
  if (label) label.textContent = me.label;
  const role = document.getElementById("account-role");
  if (role) role.textContent = me.role === "owner" ? "Owner" : "Staff";
  const avatar = document.getElementById("avatar");
  if (avatar) avatar.textContent = (me.label || "?").trim().charAt(0).toUpperCase();

  const btn = document.getElementById("account-btn");
  const menu = document.getElementById("account-menu");
  if (btn && menu) {
    const close = () => {
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
    };
    btn.addEventListener("click", () => {
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) close();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !menu.hidden) {
        close();
        btn.focus();
      }
    });
  }
  document.getElementById("sign-out")?.addEventListener("click", onSignOut);
}
