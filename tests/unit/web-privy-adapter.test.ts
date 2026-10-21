import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivyAdapter, createSessionStorage, type SessionStorageLike } from "../../scripts/web-entry/privy.js";

// The adapter is tested against a fake Privy client, fake storage and a fake location. No network is used.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REDIRECT = "https://bind.example/app/sign-in";
const GOOGLE_URL = "https://auth.privy.io/api/v1/oauth/authorize?state=abc";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const MESSAGE = "bind.example wants you to sign in with your Ethereum account";

type FakeOptions = {
  token?: string | null;
  tokenError?: boolean;
  initError?: boolean;
  generateError?: boolean;
  url?: unknown;
  loginCodeError?: boolean;
  siweInitError?: boolean;
  loginSiweError?: boolean;
  logoutError?: boolean;
};

/** A fake Privy SDK class. It records every call in `log`, in order, so tests can check ordering. */
function fakeSdk(options: FakeOptions = {}) {
  const log: string[] = [];
  const constructedWith: { appId: string; storage: SessionStorageLike }[] = [];
  const initCalls = { count: 0 };
  class FakePrivy {
    auth = {
      oauth: {
        generateURL: async (provider: string, redirectUri: string) => {
          log.push(`generateURL ${provider} ${redirectUri}`);
          if (options.generateError) throw new Error("generate failed");
          return { url: "url" in options ? options.url : GOOGLE_URL };
        },
        loginWithCode: async (code: string, state: string, provider: string) => {
          log.push(`loginWithCode ${provider}`);
          if (options.loginCodeError) throw new Error(`rejected code ${code} for state ${state}`);
        },
      },
      siwe: {
        init: async (wallet: { address: string; chainId: string }, domain: string, uri: string) => {
          log.push(`siwe.init ${wallet.address} ${wallet.chainId} ${domain} ${uri}`);
          if (options.siweInitError) throw new Error("init failed");
          return { nonce: "nonce-1", message: MESSAGE };
        },
        loginWithSiwe: async (signature: string, wallet: { address: string }, message: string) => {
          log.push(`loginWithSiwe ${signature} ${wallet.address} ${message === MESSAGE}`);
          if (options.loginSiweError) throw new Error("login failed");
        },
      },
      logout: async () => {
        log.push("logout");
        if (options.logoutError) throw new Error("logout failed");
      },
    };
    constructor(opts: { appId: string; storage: SessionStorageLike }) {
      constructedWith.push(opts);
    }
    async initialize() {
      initCalls.count += 1;
      log.push("initialize");
      if (options.initError) throw new Error("init failed");
    }
    async getAccessToken() {
      log.push("getAccessToken");
      if (options.tokenError) throw new Error("token failed");
      return options.token ?? null;
    }
  }
  return { Privy: FakePrivy, log, constructedWith, initCalls };
}

function fakeStorage(): SessionStorageLike {
  const data = new Map<string, unknown>();
  return {
    get: (key) => data.get(key),
    put: (key, value) => void data.set(key, value),
    del: (key) => void data.delete(key),
    getKeys: () => [...data.keys()],
  };
}

function fakeLocation() {
  const assigned: string[] = [];
  return {
    host: "bind.example",
    origin: "https://bind.example",
    assigned,
    assign: (url: string) => void assigned.push(url),
  };
}

type Request = { method: string; params?: unknown[] };

/** A fake EIP-1193 wallet. Requests are recorded in `log` alongside the SDK calls. */
function fakeWallet(log: string[], options: { reject?: boolean; noAccounts?: boolean } = {}) {
  return {
    request: async ({ method, params }: Request) => {
      log.push(`wallet ${method}`);
      if (options.reject) throw Object.assign(new Error("User rejected"), { code: 4001 });
      if (method === "eth_requestAccounts") return options.noAccounts ? [] : [ADDRESS];
      if (method === "eth_chainId") return "0x1";
      if (method === "personal_sign") {
        const [message, address] = params as [string, string];
        return message === MESSAGE && address === ADDRESS ? "0xsignature" : "0xwrong";
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Privy adapter: client lifecycle", () => {
  it("constructs one client and initializes it once across several calls", async () => {
    const sdk = fakeSdk({ token: "t" });
    const storage = fakeStorage();
    const adapter = createPrivyAdapter({ appId: "app-1", Privy: sdk.Privy, storage, location: fakeLocation() });
    await Promise.all([adapter.getAccessToken(), adapter.getAccessToken()]);
    await adapter.getAccessToken();
    await adapter.logout();
    expect(sdk.constructedWith).toHaveLength(1);
    expect(sdk.constructedWith[0]).toEqual({ appId: "app-1", storage });
    expect(sdk.initCalls.count).toBe(1);
  });

  it("retries the start on the next call after initialize fails", async () => {
    const sdk = fakeSdk({ initError: true, token: "t" });
    const adapter = createPrivyAdapter({ appId: "app-1", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    expect(await adapter.getAccessToken()).toBeNull();
    expect(await adapter.getAccessToken()).toBeNull();
    expect(sdk.initCalls.count).toBe(2);
  });
});

describe("Privy adapter: getAccessToken", () => {
  it("passes the token through", async () => {
    const sdk = fakeSdk({ token: "access-token-value" });
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    expect(await adapter.getAccessToken()).toBe("access-token-value");
  });

  it("returns null when signed out", async () => {
    const sdk = fakeSdk({ token: null });
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    expect(await adapter.getAccessToken()).toBeNull();
  });

  it("returns null on error", async () => {
    const sdk = fakeSdk({ tokenError: true });
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    expect(await adapter.getAccessToken()).toBeNull();
  });
});

describe("Privy adapter: Google sign-in", () => {
  it("asks Privy for the Google URL and navigates to it", async () => {
    const sdk = fakeSdk();
    const location = fakeLocation();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location });
    await adapter.startGoogle(REDIRECT);
    expect(sdk.log).toContain(`generateURL google ${REDIRECT}`);
    expect(location.assigned).toEqual([GOOGLE_URL]);
  });

  it("rejects a non-https URL from Privy without navigating", async () => {
    const sdk = fakeSdk({ url: "http://auth.privy.io/evil" });
    const location = fakeLocation();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location });
    await expect(adapter.startGoogle(REDIRECT)).rejects.toThrow(/secure address/);
    expect(location.assigned).toEqual([]);
  });

  it("rejects a missing URL without navigating", async () => {
    const sdk = fakeSdk({ url: undefined });
    const location = fakeLocation();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location });
    await expect(adapter.startGoogle(REDIRECT)).rejects.toThrow();
    expect(location.assigned).toEqual([]);
  });

  it("does not navigate when Privy fails to start the flow", async () => {
    const sdk = fakeSdk({ generateError: true });
    const location = fakeLocation();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location });
    await expect(adapter.startGoogle(REDIRECT)).rejects.toThrow();
    expect(location.assigned).toEqual([]);
  });
});

describe("Privy adapter: finishing Google sign-in", () => {
  it("returns false when the address carries no Privy parameters", async () => {
    const sdk = fakeSdk();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    expect(await adapter.finishOAuth("")).toBe(false);
    expect(await adapter.finishOAuth("?unrelated=1")).toBe(false);
    expect(sdk.log.some((line) => line.startsWith("loginWithCode"))).toBe(false);
  });

  it("completes with the parsed code, state and provider", async () => {
    const sdk = fakeSdk();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    const search = "?privy_oauth_code=code-123&privy_oauth_state=state-456&privy_oauth_provider=google";
    expect(await adapter.finishOAuth(search)).toBe(true);
    expect(sdk.log).toContain("loginWithCode google");
  });

  it("defaults the provider to google when the address does not name one", async () => {
    const sdk = fakeSdk();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    expect(await adapter.finishOAuth("?privy_oauth_code=c&privy_oauth_state=s")).toBe(true);
    expect(sdk.log).toContain("loginWithCode google");
  });

  it("throws when only one of the two parameters is present", async () => {
    const sdk = fakeSdk();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    await expect(adapter.finishOAuth("?privy_oauth_code=only-code")).rejects.toThrow();
    expect(sdk.log.some((line) => line.startsWith("loginWithCode"))).toBe(false);
  });

  it("throws on failure without echoing the code or state", async () => {
    const sdk = fakeSdk({ loginCodeError: true });
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    const error = await adapter
      .finishOAuth("?privy_oauth_code=SECRET-CODE-VALUE&privy_oauth_state=STATE-VALUE")
      .then(() => null, (err: unknown) => err as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain("SECRET-CODE-VALUE");
    expect(error?.message).not.toContain("STATE-VALUE");
  });
});

describe("Privy adapter: wallet sign-in", () => {
  it("requests the account, then signs the SIWE message before logging in", async () => {
    const sdk = fakeSdk();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    const result = await adapter.connectWallet(fakeWallet(sdk.log));
    expect(result).toEqual({ address: ADDRESS });
    const order = sdk.log.filter((line) => !line.startsWith("initialize"));
    const at = (prefix: string) => order.findIndex((line) => line.startsWith(prefix));
    expect(at("wallet eth_requestAccounts")).toBeLessThan(at("siwe.init"));
    expect(at("siwe.init")).toBeLessThan(at("wallet personal_sign"));
    expect(at("wallet personal_sign")).toBeLessThan(at("loginWithSiwe"));
    expect(order[at("loginWithSiwe")]).toBe(`loginWithSiwe 0xsignature ${ADDRESS} true`);
  });

  it("initializes SIWE with the domain and origin from the page location and the CAIP-2 chain", async () => {
    const sdk = fakeSdk();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    await adapter.connectWallet(fakeWallet(sdk.log));
    expect(sdk.log).toContain(`siwe.init ${ADDRESS} eip155:1 bind.example https://bind.example`);
  });

  it("throws a clear error when no wallet provider is present", async () => {
    const sdk = fakeSdk();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    await expect(adapter.connectWallet(undefined)).rejects.toThrow(/No wallet/);
    await expect(adapter.connectWallet({} as never)).rejects.toThrow(/No wallet/);
    expect(sdk.log.some((line) => line.startsWith("siwe"))).toBe(false);
  });

  it("throws a clear error when the user rejects the request and does not log in", async () => {
    const sdk = fakeSdk();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    await expect(adapter.connectWallet(fakeWallet(sdk.log, { reject: true }))).rejects.toThrow(/cancelled/);
    expect(sdk.log.some((line) => line.startsWith("loginWithSiwe"))).toBe(false);
  });

  it("throws when the wallet returns no account", async () => {
    const sdk = fakeSdk();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    await expect(adapter.connectWallet(fakeWallet(sdk.log, { noAccounts: true }))).rejects.toThrow(/did not return an account/);
  });

  it("throws before asking the wallet to sign when Privy cannot start SIWE", async () => {
    const sdk = fakeSdk({ siweInitError: true });
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    await expect(adapter.connectWallet(fakeWallet(sdk.log))).rejects.toThrow(/could not be started/);
    expect(sdk.log.some((line) => line.startsWith("wallet personal_sign"))).toBe(false);
  });

  it("throws when Privy refuses the SIWE login", async () => {
    const sdk = fakeSdk({ loginSiweError: true });
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    await expect(adapter.connectWallet(fakeWallet(sdk.log))).rejects.toThrow(/could not be completed/);
  });
});

describe("Privy adapter: logout", () => {
  it("signs out when a session exists", async () => {
    const sdk = fakeSdk({ token: "t" });
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    await adapter.logout();
    expect(sdk.log).toContain("logout");
  });

  it("does not call Privy's logout when there is no session", async () => {
    const sdk = fakeSdk({ token: null });
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    await adapter.logout();
    expect(sdk.log).not.toContain("logout");
  });

  it("swallows errors", async () => {
    const sdk = fakeSdk({ token: "t", logoutError: true });
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation() });
    await expect(adapter.logout()).resolves.toBeUndefined();
    const broken = fakeSdk({ initError: true });
    const other = createPrivyAdapter({ appId: "a", Privy: broken.Privy, storage: fakeStorage(), location: fakeLocation() });
    await expect(other.logout()).resolves.toBeUndefined();
  });
});

describe("Privy adapter: default storage", () => {
  it("falls back to memory when sessionStorage throws", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("storage blocked");
      },
    });
    const storage = createSessionStorage();
    expect(() => storage.put("token", { value: "x" })).not.toThrow();
    expect(storage.get("token")).toEqual({ value: "x" });
    expect(storage.getKeys()).toContain("token");
    storage.del("token");
    expect(storage.get("token")).toBeUndefined();
  });

  it("keeps values in sessionStorage under a namespace and never lists other keys", () => {
    const backing = new Map<string, string>([["bind-access-key", "bnd_secret_key_value"]]);
    const session = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
      key: (i: number) => [...backing.keys()][i] ?? null,
      get length() {
        return backing.size;
      },
    };
    const storage = createSessionStorage(() => session as unknown as Storage);
    storage.put("pkce", "verifier-1");
    storage.put("state", { n: 2 });
    expect(backing.get("privy:pkce")).toBe(JSON.stringify("verifier-1"));
    expect(storage.get("state")).toEqual({ n: 2 });
    expect(storage.getKeys().sort()).toEqual(["pkce", "state"]);
    expect(backing.get("bind-access-key")).toBe("bnd_secret_key_value");
  });
});

describe("web bundle", () => {
  it("npm run web:bundle writes a self-contained bundle under 3 MB with no eval or Function constructor", () => {
    execFileSync("npm", ["run", "web:bundle", "--silent"], { cwd: ROOT, stdio: "pipe", timeout: 120000 });
    const bundle = path.join(ROOT, "web", "app", "vendor", "privy.js");
    const text = readFileSync(bundle, "utf8");
    expect(statSync(bundle).size).toBeLessThan(3 * 1024 * 1024);
    // The CSP is script-src 'self' with no 'unsafe-eval'. Any of these would be blocked in the browser.
    expect(text).not.toMatch(/\beval\s*\(/);
    expect(text).not.toMatch(/\bnew\s+Function\s*\(/);
    expect(text).not.toMatch(/\bFunction\s*\(/);
    // Everything is bundled: no bare module specifiers remain for the browser to resolve.
    expect(text).not.toMatch(/\bfrom\s*["']@/);
    expect(text).toContain("eip155:");
  });
});
