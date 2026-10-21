/*
 * Privy browser adapter (ADR 0071). scripts/build-web-bundle.mjs bundles this file into web/app/vendor/privy.js, an ES module
 * the sign-in page loads with import(). The site serves it from its own origin because the CSP is script-src 'self'.
 * Privy's tokens and its PKCE state live in sessionStorage, so they last for this tab only. A wallet sign-in proves who the
 * person is. It never grants payment authority: spending limits and approvals are enforced by Bind's policy code.
 */
import PrivySDK from "@privy-io/js-sdk-core";

/** The only provider this adapter starts. Fixed here, never read from the address bar. */
export const PRIVY_PROVIDER = "google";

/** Hosts a Google sign-in URL may send the browser to. Exact names only: no suffix or wildcard matching. */
export const ALLOWED_AUTH_HOSTS = Object.freeze(["auth.privy.io", "accounts.google.com"]);

const PREFIX = "privy:";
const CANCELLED = "You cancelled the wallet request. Nothing was signed.";

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

    /** Signs out of Privy. Best effort: the page clears its own state either way. */
    async logout() {
      try {
        const privy = await client();
        if (await privy.getAccessToken()) await privy.auth.logout();
      } catch {
        // Nothing to undo if Privy never started.
      }
    },
  };
}
