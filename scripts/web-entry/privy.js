/*
 * Privy browser adapter (ADR 0071). scripts/build-web-bundle.mjs bundles this file into web/app/vendor/privy.js, which the
 * site serves from its own origin because the CSP is script-src 'self'. Privy's tokens and its PKCE state live in
 * sessionStorage, so they last for this tab only. A wallet sign-in proves who the person is. It never grants payment
 * authority: spending limits and approvals are enforced by Bind's policy code, not by the login.
 */
import PrivySDK from "@privy-io/js-sdk-core";

const PREFIX = "privy:";

/**
 * Storage in the shape the SDK expects (get, put, del, getKeys). Keys are namespaced so the SDK never reads other keys in
 * the tab, such as Bind's access key. Every write also goes to memory, so a blocked or full sessionStorage still works for
 * this page load.
 */
export function createSessionStorage(getStore = () => globalThis.window.sessionStorage) {
  const memory = new Map();
  const store = () => {
    try {
      return getStore();
    } catch {
      return null;
    }
  };
  // Methods are plain functions, not `this`-based, because the SDK may hold on to them.
  const api = {
    get(key) {
      try {
        const raw = store()?.getItem(PREFIX + key);
        if (raw !== null && raw !== undefined) return JSON.parse(raw);
      } catch {
        // Fall through to memory.
      }
      return memory.get(key);
    },
    put(key, value) {
      if (value === undefined) return api.del(key);
      memory.set(key, value);
      try {
        store()?.setItem(PREFIX + key, JSON.stringify(value));
      } catch {
        // Memory still holds the value for this page load.
      }
    },
    del(key) {
      memory.delete(key);
      try {
        store()?.removeItem(PREFIX + key);
      } catch {
        // Nothing more to clear.
      }
    },
    getKeys() {
      const keys = new Set(memory.keys());
      try {
        const s = store();
        for (let i = 0; s && i < s.length; i++) {
          const k = s.key(i);
          if (k && k.startsWith(PREFIX)) keys.add(k.slice(PREFIX.length));
        }
      } catch {
        // Memory keys only.
      }
      return [...keys];
    },
  };
  return api;
}

const chainIdOf = (hex) => {
  const n = parseInt(String(hex), 16);
  if (!Number.isFinite(n)) throw new Error("The wallet reported a network this page cannot read.");
  return `eip155:${n}`;
};

/**
 * The adapter the sign-in page uses. One Privy client is made on first use and initialized once; a failed start is retried
 * on the next call. `Privy`, `storage` and `location` can be replaced in tests.
 */
export function createPrivyAdapter({
  appId,
  Privy = PrivySDK,
  storage = createSessionStorage(),
  location = globalThis.window.location,
} = {}) {
  let starting = null;
  const client = () => {
    if (!starting) {
      starting = (async () => {
        const privy = new Privy({ appId, storage });
        await privy.initialize();
        return privy;
      })();
      starting.catch(() => {
        starting = null;
      });
    }
    return starting;
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

    /** Sends the browser to Google through Privy. Rejects, without navigating, when Privy returns no https address. */
    async startGoogle(redirectUri) {
      if (typeof redirectUri !== "string" || redirectUri === "") throw new Error("Google sign-in needs a return address.");
      const { url } = await (await client()).auth.oauth.generateURL("google", redirectUri);
      if (typeof url !== "string" || !url.startsWith("https://")) {
        throw new Error("Google sign-in did not return a secure address. Sign-in was not started.");
      }
      location.assign(url);
    },

    /** Completes a Google return. False when the address carries no Privy parameters; throws (never echoing them) on failure. */
    async finishOAuth(search) {
      const params = new URLSearchParams(search);
      const code = params.get("privy_oauth_code");
      const state = params.get("privy_oauth_state");
      if (code === null && state === null) return false;
      if (!code || !state) throw new Error("Google sign-in returned without what Bind needs. Start again.");
      // The SDK compares this state with the one it stored when the flow started, so a forged return fails.
      const provider = params.get("privy_oauth_provider") || "google";
      try {
        await (await client()).auth.oauth.loginWithCode(code, state, provider);
      } catch {
        throw new Error("Google sign-in could not be completed. Start again.");
      }
      return true;
    },

    /** Signs in with an EIP-1193 wallet (for example window.ethereum) by signing a Sign-In With Ethereum message. */
    async connectWallet(ethereumProvider) {
      if (!ethereumProvider || typeof ethereumProvider.request !== "function") {
        throw new Error("No wallet was found in this browser. Install a wallet, then try again.");
      }
      const call = async (method, params) => {
        try {
          return await ethereumProvider.request(params ? { method, params } : { method });
        } catch (err) {
          if (err?.code === 4001) throw new Error("You cancelled the wallet request. Nothing was signed.");
          throw new Error("The wallet did not complete the sign-in request.");
        }
      };
      const [address] = (await call("eth_requestAccounts")) ?? [];
      if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        throw new Error("The wallet did not return an account.");
      }
      const wallet = { address, chainId: chainIdOf(await call("eth_chainId")) };
      const privy = await client().catch(() => null);
      const siwe = await privy?.auth.siwe.init(wallet, location.host, location.origin).catch(() => null);
      if (!siwe) throw new Error("Wallet sign-in could not be started. Try again.");
      const signature = await call("personal_sign", [siwe.message, address]);
      // Identity only: this proves control of the address to Privy. It grants no payment authority (ADR 0071).
      await privy.auth.siwe.loginWithSiwe(signature, wallet, siwe.message).catch(() => {
        throw new Error("Wallet sign-in could not be completed. Try again.");
      });
      return { address };
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
