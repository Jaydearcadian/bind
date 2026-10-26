/*
 * Privy browser adapter (ADR 0071). scripts/build-web-bundle.mjs bundles this file into web/app/vendor/privy.js, an ES module
 * the sign-in page loads with import(). The site serves it from its own origin because the CSP is script-src 'self'.
 * Privy's tokens and its PKCE state live in sessionStorage, so they last for this tab only. A wallet sign-in proves who the
 * person is. It never grants payment authority: spending limits and approvals are enforced by Bind's policy code.
 */
import "./zod-config.js"; // First: it must run before the SDK builds any zod schema (ADR 0089).
import PrivySDK from "@privy-io/js-sdk-core";

/** The only provider this adapter starts. Fixed here, never read from the address bar. */
export const PRIVY_PROVIDER = "google";

/** Hosts a Google sign-in URL may send the browser to. Exact names only: no suffix or wildcard matching. */
export const ALLOWED_AUTH_HOSTS = Object.freeze(["auth.privy.io", "accounts.google.com"]);

/** The one host the embedded wallet frame may load from. Exact name, https, default port (ADR 0071). */
const WALLET_FRAME_HOST = "auth.privy.io";

/** The fixed id of the one wallet frame on a page. A frame with this id is reused, never duplicated (ADR 0071). */
const WALLET_FRAME_ID = "bind-privy-wallet-frame";

const PREFIX = "privy:";
const CANCELLED = "You cancelled the wallet request. Nothing was signed.";
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** An error with a stable code and a plain message. It never carries a cause, a wallet's text or a token. */
function walletError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Privy's own embedded Ethereum wallet on a user, or null. An external wallet (injected, WalletConnect, ...) never matches:
 * it has a different connector_type and wallet_client_type.
 */
function findEmbeddedEthereumWallet(user) {
  const accounts = Array.isArray(user?.linked_accounts) ? user.linked_accounts : [];
  return (
    accounts.find(
      (a) =>
        a &&
        a.type === "wallet" &&
        a.chain_type === "ethereum" &&
        a.connector_type === "embedded" &&
        a.wallet_client_type === "privy" &&
        typeof a.address === "string" &&
        ADDRESS_PATTERN.test(a.address)
    ) ?? null
  );
}

const parseUrl = (text) => {
  try {
    return new URL(text);
  } catch {
    return null;
  }
};

/**
 * Storage in the shape the SDK expects (get, put, del, getKeys). Keys are namespaced so the SDK never reads other keys in
 * the tab, such as Bind's access key. Writes always go to memory first, and memory is preferred on reads.
 */
export function createSessionStorage(getStore = () => globalThis.window.sessionStorage) {
  const memory = new Map();
  // Any failure (blocked storage, quota, a missing store) yields undefined, so callers fall back to memory.
  const attempt = (fn) => {
    try {
      return fn(getStore());
    } catch {
      return undefined;
    }
  };
  const api = {
    get(key) {
      if (memory.has(key)) return memory.get(key);
      const raw = attempt((s) => s.getItem(PREFIX + key));
      if (typeof raw !== "string") return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        // Garbage in our own namespace is dropped, not parsed or trusted.
        attempt((s) => s.removeItem(PREFIX + key));
        return undefined;
      }
    },
    put(key, value) {
      if (value === undefined) return api.del(key);
      memory.set(key, value);
      let encoded;
      try {
        encoded = JSON.stringify(value);
      } catch {
        encoded = undefined;
      }
      const wrote = encoded !== undefined && attempt((s) => (s.setItem(PREFIX + key, encoded), true));
      // If the write failed, remove the older stored value so it can never be read back in place of this one.
      if (!wrote) attempt((s) => s.removeItem(PREFIX + key));
    },
    del(key) {
      memory.delete(key);
      attempt((s) => s.removeItem(PREFIX + key));
    },
    getKeys() {
      const keys = new Set(memory.keys());
      const count = attempt((s) => s.length) ?? 0;
      for (let i = 0; i < count; i++) {
        const k = attempt((s) => s.key(i));
        if (typeof k === "string" && k.startsWith(PREFIX)) keys.add(k.slice(PREFIX.length));
      }
      return [...keys];
    },
  };
  return api;
}

/** A user-facing message for a wallet error. Never includes the wallet's own text. */
function walletErrorMessage(err) {
  const code = err?.code;
  if (code === 4001 || code === "ACTION_REJECTED") return CANCELLED;
  if (code === -32002) return "A request is already pending in your wallet. Open the wallet and answer it first.";
  return "The wallet did not complete the sign-in request.";
}

const chainIdOf = (hex) => {
  const n = parseInt(String(hex), 16);
  if (!Number.isFinite(n)) throw new Error("The wallet reported a network this page cannot read.");
  return `eip155:${n}`;
};

/**
 * The adapter the sign-in page uses. One Privy client is made on first use and initialized once; a failed start is retried
 * on the next call. Google and wallet sign-in each allow one attempt at a time. Every browser global is read lazily, so
 * importing this module never needs a window. `Privy`, `storage`, `location` and `history` can be replaced in tests.
 */
export function createPrivyAdapter({
  appId,
  Privy = PrivySDK,
  storage = createSessionStorage(),
  location,
  history = globalThis.history,
  frameDocument,
  frameWindow,
} = {}) {
  const here = () => {
    const l = location ?? globalThis.window?.location;
    if (!l) throw new Error("This page has no address to return to.");
    return l;
  };

  let starting = null;
  let googleStart = null;
  let walletSignIn = null;

  const client = () => {
    if (!starting) {
      const p = (async () => {
        const privy = new Privy({ appId, storage });
        await privy.initialize();
        return privy;
      })();
      starting = p;
      // Clear only if this attempt is still the current one, so a newer attempt is never dropped.
      p.catch(() => {
        if (starting === p) starting = null;
      });
    }
    return starting;
  };

  // Removes the Privy parameters from the address bar, so codes never stay in history even if the login fails.
  const scrubAddress = () => {
    try {
      history?.replaceState(null, "", here().pathname);
    } catch {
      // The address bar is cosmetic here; the login still runs.
    }
  };

  const beginGoogle = async (redirectUri) => {
    const back = parseUrl(redirectUri);
    if (!back || back.origin !== here().origin) throw new Error("The return address must be on this site.");
    const { url } = await (await client()).auth.oauth.generateURL(PRIVY_PROVIDER, redirectUri);
    const target = parseUrl(url);
    if (!target || target.protocol !== "https:" || !ALLOWED_AUTH_HOSTS.includes(target.hostname)) {
      throw new Error("Google sign-in did not return a trusted address. Sign-in was not started.");
    }
    here().assign(target.href);
  };

  const signInWithWallet = async (ethereumProvider) => {
    if (!ethereumProvider || typeof ethereumProvider.request !== "function") {
      throw new Error("No wallet was found in this browser. Install a wallet, then try again.");
    }
    const call = async (method, params) => {
      try {
        return await ethereumProvider.request(params ? { method, params } : { method });
      } catch (err) {
        throw new Error(walletErrorMessage(err));
      }
    };
    const [address] = (await call("eth_requestAccounts")) ?? [];
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new Error("The wallet did not return an account.");
    }
    const wallet = { address, chainId: chainIdOf(await call("eth_chainId")) };
    const privy = await client().catch(() => null);
    const siwe = await privy?.auth.siwe.init(wallet, here().host, here().origin).catch(() => null);
    if (!siwe) throw new Error("Wallet sign-in could not be started. Try again.");
    const signature = await call("personal_sign", [siwe.message, address]);
    if (typeof signature !== "string" || signature === "") throw new Error("The wallet did not return a signature.");
    // Identity only: this proves control of the address to Privy. It grants no payment authority (ADR 0071).
    await privy.auth.siwe.loginWithSiwe(signature, wallet, siwe.message).catch(() => {
      throw new Error("Wallet sign-in could not be completed. Try again.");
    });
    return { address };
  };

  // --- Embedded wallet (ADR 0071). Reads and creation only: no signing and no sending is exposed or performed here.
  // The wallet frame is created lazily, on the first wallet creation, and never more than once per adapter.
  let frame = null; // { iframe, origin, url, privy, win }: privy is set once the poster is installed
  let walletEnsure = null;

  const documentRef = () => {
    const d = frameDocument ?? globalThis.document;
    if (!d?.body) throw walletError("WALLET_FRAME_REFUSED", "This page cannot host the wallet frame.");
    return d;
  };
  const windowRef = () => {
    const w = frameWindow ?? globalThis.window;
    if (!w) throw walletError("WALLET_FRAME_REFUSED", "This page cannot host the wallet frame.");
    return w;
  };

  // Forwards a frame message only when it comes from the frame's origin and from the frame's own window. Anything else is
  // dropped silently: no log, no reply.
  const onFrameMessage = (event) => {
    const f = frame;
    if (!f?.privy || event.origin !== f.origin) return;
    const source = f.iframe.contentWindow;
    if (!source || event.source !== source) return;
    let message = event.data;
    if (typeof message === "string") {
      try {
        message = JSON.parse(message);
      } catch {
        return;
      }
    }
    if (!message || typeof message !== "object" || typeof message.event !== "string") return;
    try {
      f.privy.embeddedWallet.onMessage(message);
    } catch {
      // The SDK refuses a message it cannot match. Nothing is logged.
    }
  };

  // The SDK posts with the target origin '*'. This poster sends only to the frame's validated origin.
  const poster = {
    postMessage(message) {
      const f = frame;
      f?.iframe.contentWindow?.postMessage(message, f.origin);
    },
    reload() {
      if (frame) frame.iframe.src = frame.url;
    },
  };

  // Removes this adapter's listener and its frame, and forgets the frame. Used by logout, and when the page removed the frame.
  // Note: the frame element is shared by id, so disposing it affects any other adapter on the same page.
  const disposeWalletFrame = () => {
    const f = frame;
    frame = null;
    if (!f) return;
    try {
      f.win.removeEventListener("message", onFrameMessage);
    } catch {
      // Nothing to undo.
    }
    try {
      f.iframe.remove();
    } catch {
      // Already gone.
    }
  };

  const ensureWalletFrame = (privy) => {
    try {
      // A frame the page has removed is forgotten, with its listener, so a new one can be made. Still one live frame.
      if (frame && !frame.iframe.isConnected) disposeWalletFrame();
      if (!frame) {
        let raw;
        try {
          raw = privy.embeddedWallet.getURL();
        } catch {
          raw = "";
        }
        const url = parseUrl(typeof raw === "string" ? raw : "");
        if (
          !url ||
          url.protocol !== "https:" ||
          url.hostname !== WALLET_FRAME_HOST ||
          url.port !== "" ||
          url.username !== "" ||
          url.password !== ""
        ) {
          throw new Error("untrusted wallet frame address");
        }
        const d = documentRef();
        const w = windowRef();
        // One frame per page. An existing element with the fixed id is reused only if it is this same Privy frame.
        let iframe = d.getElementById(WALLET_FRAME_ID);
        if (iframe && iframe.src !== url.href) throw new Error("another wallet frame is on this page");
        w.addEventListener("message", onFrameMessage);
        if (!iframe) {
          iframe = d.createElement("iframe");
          iframe.setAttribute("id", WALLET_FRAME_ID);
          iframe.src = url.href;
          iframe.title = "Privy wallet";
          iframe.setAttribute("aria-hidden", "true");
          iframe.setAttribute("tabindex", "-1");
          // The SDK's own page needs script and its origin's storage. The sandbox is not a boundary against this page:
          // allow-scripts with allow-same-origin lets the page lift its own sandbox. The origin check above is the boundary.
          iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");
          iframe.setAttribute("allow", "");
          iframe.style.display = "none";
          d.body.appendChild(iframe);
        }
        frame = { iframe, origin: url.origin, url: url.href, privy: null, win: w };
      }
      if (frame.privy !== privy) {
        privy.setMessagePoster(poster);
        frame.privy = privy;
      }
    } catch {
      throw walletError("WALLET_FRAME_REFUSED", "The wallet frame could not be started. Wallet setup was not started.");
    }
  };

  const readEmbeddedWallet = async (privy) => {
    let res;
    try {
      res = await privy.user.get();
    } catch {
      throw walletError("PRIVY_UNAVAILABLE", "Bind could not read your account from Privy. Try again.");
    }
    return findEmbeddedEthereumWallet(res?.user);
  };

  const createWallet = async () => {
    const privy = await client().catch(() => {
      throw walletError("PRIVY_UNAVAILABLE", "Bind could not reach Privy. Try again.");
    });
    let token;
    try {
      token = await privy.getAccessToken();
    } catch {
      throw walletError("PRIVY_UNAVAILABLE", "Bind could not reach Privy. Try again.");
    }
    if (!token) return null;

    const existing = await readEmbeddedWallet(privy);
    if (existing) return { address: existing.address, created: false };

    ensureWalletFrame(privy);
    let result;
    try {
      // No password and no recovery method: the SDK then uses Privy's own recovery ('privy'), which asks the person for no
      // passcode. If the app requires a passcode on create, the SDK throws and this returns PASSCODE_REQUIRED instead.
      result = await privy.embeddedWallet.create({});
    } catch (err) {
      if (/Password not provided/.test(String(err?.message ?? ""))) {
        throw walletError(
          "PASSCODE_REQUIRED",
          "This Privy app asks for a recovery passcode on new wallets. Bind does not create one for you, so no wallet was made."
        );
      }
      // The call can fail after the wallet exists (in the server-wallet mode, if the refresh after creation fails). Read once,
      // and report what is true: a wallet that exists is returned as not created by this call.
      const after = await readEmbeddedWallet(privy).catch(() => null);
      if (after) return { address: after.address, created: false };
      throw walletError("WALLET_CREATE_FAILED", "The embedded wallet could not be created. Try again.");
    }
    const made = findEmbeddedEthereumWallet(result?.user) ?? (await readEmbeddedWallet(privy));
    if (!made) throw walletError("WALLET_NOT_FOUND", "Privy did not return the new wallet. Try again.");
    return { address: made.address, created: true };
  };

  return {
    /** The access token for this tab's session, or null when signed out or on any error. */
    async getAccessToken() {
      try {
        return (await (await client()).getAccessToken()) ?? null;
      } catch {
        return null;
      }
    },

    /** Sends the browser to Google through Privy. Refuses, without navigating, any return address or Privy URL outside the rules. */
    startGoogle(redirectUri) {
      if (!googleStart) {
        googleStart = beginGoogle(redirectUri).finally(() => {
          googleStart = null;
        });
      }
      return googleStart;
    },

    /** Completes a Google return. False when the address carries no Privy parameters; throws (never echoing them) on failure. */
    async finishOAuth(search = "") {
      const params = new URLSearchParams(search);
      const code = params.get("privy_oauth_code");
      const state = params.get("privy_oauth_state");
      if (code === null && state === null) return false;
      scrubAddress();
      if (!code || !state) throw new Error("Google sign-in returned without what Bind needs. Start again.");
      try {
        await (await client()).auth.oauth.loginWithCode(code, state, PRIVY_PROVIDER);
      } catch {
        // Deliberately no cause and no echo of the code or state.
        throw new Error("Google sign-in could not be completed. Start again.");
      }
      return true;
    },

    /** Signs in with an EIP-1193 wallet (for example window.ethereum) by signing a Sign-In With Ethereum message. */
    connectWallet(ethereumProvider) {
      if (!walletSignIn) {
        walletSignIn = signInWithWallet(ethereumProvider).finally(() => {
          walletSignIn = null;
        });
      }
      return walletSignIn;
    },

    /**
     * The person's Privy embedded Ethereum wallet address, or null when signed out, when none exists, or on any error.
     * Reads only. It never creates a wallet and never loads the wallet frame.
     */
    async getWalletAddress() {
      try {
        const privy = await client();
        if (!(await privy.getAccessToken())) return null;
        return (await readEmbeddedWallet(privy))?.address ?? null;
      } catch {
        return null;
      }
    },

    /**
     * Returns the embedded wallet, creating it once if the signed-in person has none. Null when signed out. Creation uses
     * Privy's default recovery: no password or passcode is invented. One attempt at a time; a second call shares the first.
     *
     * Bind never signs or sends from this wallet. Payments need an owner's approval (AGENTS.md). This wallet is identity and
     * custody on Privy's side only; Bind's server never sees or stores its key.
     *
     * This method does not check how the person signed in. The caller decides: the sign-in page calls it only after a Google
     * return (ADR 0071), never after a wallet login or a quiet re-entry.
     */
    ensureWallet() {
      if (!walletEnsure) {
        walletEnsure = createWallet().finally(() => {
          walletEnsure = null;
        });
      }
      return walletEnsure;
    },

    /** Signs out of Privy. Best effort: the page clears its own state either way. */
    async logout() {
      try {
        const privy = await client();
        if (await privy.getAccessToken()) await privy.auth.logout();
      } catch {
        // Nothing to undo if Privy never started.
      } finally {
        disposeWalletFrame();
      }
    },
  };
}
