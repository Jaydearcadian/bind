/*
 * Sign in with an access key (ADR 0059). Google and wallet sign-in come with Privy (ADR 0051). The key is checked with the
 * server before it is kept; it is kept for this tab unless "Remember this device" is ticked.
 */
import { BindApiError, KEY_PATTERN, client, storeKey, storedKey } from "/app/core.js";

const form = document.getElementById("key-form");
const input = document.getElementById("key");
const remember = document.getElementById("remember");
const error = document.getElementById("key-error");
const submit = document.getElementById("key-submit");

function showError(text) {
  error.textContent = text;
  error.hidden = false;
  input.setAttribute("aria-invalid", "true");
  input.focus();
}

// Already signed in on this tab or device: go straight to Today.
const existing = storedKey();
if (existing) {
  client(existing)
    .me()
    .then(() => window.location.replace("/app/"))
    .catch(() => undefined);
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  error.hidden = true;
  input.removeAttribute("aria-invalid");
  const key = input.value.trim();
  if (!KEY_PATTERN.test(key)) {
    showError("That doesn't look like an access key. It starts with bnd_ and is 47 characters long.");
    return;
  }
  submit.disabled = true;
  submit.textContent = "Checking…";
  try {
    await client(key).me();
    if (!storeKey(key, remember.checked)) {
      showError("This browser won't keep the key (storage is blocked). Allow site data for this address and try again.");
      return;
    }
    window.location.replace("/app/");
  } catch (err) {
    if (err instanceof BindApiError && (err.status === 401 || err.status === 404)) {
      showError("That key isn't valid, or it has been revoked. Ask an owner of the workspace for a new one.");
    } else if (err instanceof BindApiError && err.status === 429) {
      showError("Too many tries. Wait a minute, then try again.");
    } else {
      showError("Can't reach Bind right now. Check your connection and try again.");
    }
  } finally {
    submit.disabled = false;
    submit.textContent = "Sign in";
  }
});
