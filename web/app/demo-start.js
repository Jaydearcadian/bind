/*
 * Starts a demo workspace (ADR 0057, 0063): one call, then the app opens with the demo's owner key kept for this tab only.
 */
import { storeKey } from "/app/core.js";

const btn = document.getElementById("demo-start");
const error = document.getElementById("demo-error");

function show(text) {
  error.textContent = text;
  error.hidden = false;
}

btn.addEventListener("click", async () => {
  error.hidden = true;
  btn.disabled = true;
  btn.textContent = "Setting up your demo…";
  try {
    // The route is public and no key exists yet, so this is a plain request rather than an SDK call (the SDK needs a key).
    const r = await fetch("/api/demo", { method: "POST", headers: { accept: "application/json" } });
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(res.error || "failed"), { status: r.status });
    if (!storeKey(res.token, false)) {
      show("This browser won't keep the demo key (storage is blocked). Allow site data for this address and try again.");
      return;
    }
    window.location.assign("/app/");
  } catch (err) {
    if (err.status === 404) show("The demo is switched off on this server.");
    else if (err.status === 429) show("You've started several demos recently. Wait a while, then try again.");
    else if (err.status === 503) show("The demo is busy right now. Try again in a minute.");
    else show("Can't reach Bind right now. Check your connection and try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Start the demo";
  }
});
