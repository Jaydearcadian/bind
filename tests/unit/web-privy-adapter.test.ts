import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALLOWED_AUTH_HOSTS,
  createPrivyAdapter,
  createSessionStorage,
  type SessionStorageLike,
} from "../../scripts/web-entry/privy.js";

// The adapter is tested against a fake Privy client, fake storage, location and history. No network is used.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REDIRECT = "https://bind.example/app/sign-in";
const GOOGLE_URL = "https://auth.privy.io/api/v1/oauth/authorize?state=abc";
const ADDRESS = "0x1111111111111111111111111111111111111111";
const MESSAGE = "bind.example wants you to sign in with your Ethereum account";
const CODE = "SECRET-CODE-VALUE";
const STATE = "STATE-VALUE";

type FakeOptions = {
  token?: string | null;
  tokenError?: boolean;
  initError?: boolean;
  generateError?: boolean;
  url?: unknown;
  generateGate?: Promise<void>;
  loginCodeError?: boolean;
  siweInitError?: boolean;
  siweGate?: Promise<void>;
  loginSiweError?: boolean;
  logoutError?: boolean;
  /** An ordering log shared with other fakes (for example history), so a test can check which ran first. */
  trace?: string[];
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
          if (options.generateGate) await options.generateGate;
          if (options.generateError) throw new Error("generate failed");
          return { url: "url" in options ? options.url : GOOGLE_URL };
        },
        loginWithCode: async (code: string, state: string, provider: string) => {
          log.push(`loginWithCode ${provider} ${code} ${state}`);
          options.trace?.push("loginWithCode");
          if (options.loginCodeError) throw new Error(`rejected code ${code} for state ${state}`);
        },
      },
      siwe: {
        init: async (wallet: { address: string; chainId: string }, domain: string, uri: string) => {
          log.push(`siwe.init ${wallet.address} ${wallet.chainId} ${domain} ${uri}`);
          if (options.siweGate) await options.siweGate;
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
    pathname: "/app/sign-in",
    assigned,
    assign: (url: string) => void assigned.push(url),
  };
}

function fakeHistory(log: string[] = []) {
  const calls: unknown[][] = [];
  return {
    calls,
    replaceState: (...args: unknown[]) => {
      calls.push(args);
      log.push("replaceState");
    },
  };
}

type Request = { method: string; params?: unknown[] };

/** A fake EIP-1193 wallet. Requests are recorded in `log` alongside the SDK calls. */
function fakeWallet(
  log: string[],
  options: { rejectCode?: number | string; noAccounts?: boolean; gate?: Promise<void>; signature?: unknown; pendingCode?: number } = {}
) {
  return {
    request: async ({ method, params }: Request) => {
      log.push(`wallet ${method}`);
      if (options.gate && method === "eth_requestAccounts") await options.gate;
      if (options.rejectCode !== undefined) throw Object.assign(new Error("User rejected"), { code: options.rejectCode });
      if (options.pendingCode !== undefined) throw Object.assign(new Error("pending"), { code: options.pendingCode });
      if (method === "eth_requestAccounts") return options.noAccounts ? [] : [ADDRESS];
      if (method === "eth_chainId") return "0x1";
      if (method === "personal_sign") {
        if (options.signature !== undefined) return options.signature;
        const [message, address] = params as [string, string];
        return message === MESSAGE && address === ADDRESS ? "0xsignature" : "0xwrong";
      }
      throw new Error(`unexpected ${method}`);
    },
  };
}

function adapterFor(sdk: ReturnType<typeof fakeSdk>, extra: Record<string, unknown> = {}) {
  return createPrivyAdapter({
    appId: "app-1",
    Privy: sdk.Privy,
    storage: fakeStorage(),
    location: fakeLocation(),
    history: null,
    ...extra,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Privy adapter: client lifecycle", () => {
  it("constructs one client and initializes it once across several calls", async () => {
    const sdk = fakeSdk({ token: "t" });
    const storage = fakeStorage();
    const adapter = createPrivyAdapter({ appId: "app-1", Privy: sdk.Privy, storage, location: fakeLocation(), history: null });
    await Promise.all([adapter.getAccessToken(), adapter.getAccessToken()]);
    await adapter.getAccessToken();
    await adapter.logout();
    expect(sdk.constructedWith).toHaveLength(1);
    expect(sdk.constructedWith[0]).toEqual({ appId: "app-1", storage });
    expect(sdk.initCalls.count).toBe(1);
  });

  it("retries the start on the next call after initialize fails", async () => {
    const sdk = fakeSdk({ initError: true, token: "t" });
    const adapter = adapterFor(sdk);
    expect(await adapter.getAccessToken()).toBeNull();
    expect(await adapter.getAccessToken()).toBeNull();
    expect(sdk.initCalls.count).toBe(2);
  });

  it("importing the module needs no window", async () => {
    vi.stubGlobal("window", undefined);
    const mod = await import("../../scripts/web-entry/privy.js");
    expect(typeof mod.createPrivyAdapter).toBe("function");
  });
});

describe("Privy adapter: getAccessToken", () => {
  it("passes the token through, null when signed out, null on error", async () => {
    expect(await adapterFor(fakeSdk({ token: "access-token-value" })).getAccessToken()).toBe("access-token-value");
    expect(await adapterFor(fakeSdk({ token: null })).getAccessToken()).toBeNull();
    expect(await adapterFor(fakeSdk({ tokenError: true })).getAccessToken()).toBeNull();
  });
});

describe("Privy adapter: Google sign-in", () => {
  it("asks Privy for the Google URL and navigates to it", async () => {
    const sdk = fakeSdk();
    const location = fakeLocation();
    await createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location, history: null }).startGoogle(REDIRECT);
    expect(sdk.log).toContain(`generateURL google ${REDIRECT}`);
    expect(location.assigned).toEqual([GOOGLE_URL]);
  });

  it("allows exactly the listed Google and Privy hosts", () => {
    expect([...ALLOWED_AUTH_HOSTS].sort()).toEqual(["accounts.google.com", "auth.privy.io"]);
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["http:", "http://auth.privy.io/api/v1/oauth/authorize"],
    ["other host", "https://evil.example/login"],
    ["lookalike suffix", "https://auth.privy.io.evil.example/login"],
    ["userinfo trick", "https://auth.privy.io@evil.example/login"],
    ["missing", undefined],
  ])("refuses a Privy URL that is %s without navigating", async (_name, url) => {
    const sdk = fakeSdk({ url });
    const location = fakeLocation();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location, history: null });
    await expect(adapter.startGoogle(REDIRECT)).rejects.toThrow(/trusted address|secure/);
    expect(location.assigned).toEqual([]);
  });

  it("accepts an https accounts.google.com address", async () => {
    const sdk = fakeSdk({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
    const location = fakeLocation();
    await createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location, history: null }).startGoogle(REDIRECT);
    expect(location.assigned).toHaveLength(1);
  });

  it.each([
    ["another origin", "https://evil.example/app/sign-in"],
    ["a different port", "https://bind.example:8443/app/sign-in"],
    ["http on the same host", "http://bind.example/app/sign-in"],
    ["javascript:", "javascript:alert(1)"],
  ])("refuses a return address on %s before any network call", async (_name, redirect) => {
    const sdk = fakeSdk();
    const location = fakeLocation();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location, history: null });
    await expect(adapter.startGoogle(redirect)).rejects.toThrow(/on this site/);
    expect(sdk.log).toEqual([]);
    expect(location.assigned).toEqual([]);
  });

  it("does not navigate when Privy fails to start the flow", async () => {
    const sdk = fakeSdk({ generateError: true });
    const location = fakeLocation();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location, history: null });
    await expect(adapter.startGoogle(REDIRECT)).rejects.toThrow();
    expect(location.assigned).toEqual([]);
  });

  it("allows one Google start at a time: a second call shares the first", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sdk = fakeSdk({ generateGate: gate });
    const location = fakeLocation();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location, history: null });
    const first = adapter.startGoogle(REDIRECT);
    const second = adapter.startGoogle(REDIRECT);
    release();
    await Promise.all([first, second]);
    expect(sdk.log.filter((line) => line.startsWith("generateURL"))).toHaveLength(1);
    expect(location.assigned).toEqual([GOOGLE_URL]);
  });
});

describe("Privy adapter: finishing Google sign-in", () => {
  it("returns false when the address carries no Privy parameters, and leaves the address alone", async () => {
    const sdk = fakeSdk();
    const history = fakeHistory();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation(), history });
    expect(await adapter.finishOAuth("")).toBe(false);
    expect(await adapter.finishOAuth("?unrelated=1")).toBe(false);
    expect(sdk.log.some((line) => line.startsWith("loginWithCode"))).toBe(false);
    expect(history.calls).toEqual([]);
  });

  it("completes with the parsed code and state, always provider google", async () => {
    const sdk = fakeSdk();
    const adapter = adapterFor(sdk);
    const search = `?privy_oauth_code=${CODE}&privy_oauth_state=${STATE}&privy_oauth_provider=evil`;
    expect(await adapter.finishOAuth(search)).toBe(true);
    expect(sdk.log).toContain(`loginWithCode google ${CODE} ${STATE}`);
  });

  it("removes the codes from the address before loginWithCode, even when the login fails", async () => {
    const trace: string[] = [];
    const history = {
      replaceState: (...args: unknown[]) => {
        trace.push("replaceState");
        history.calls.push(args);
      },
      calls: [] as unknown[][],
    };
    const failing = fakeSdk({ loginCodeError: true, trace });
    const adapter = createPrivyAdapter({ appId: "a", Privy: failing.Privy, storage: fakeStorage(), location: fakeLocation(), history });
    await expect(adapter.finishOAuth(`?privy_oauth_code=${CODE}&privy_oauth_state=${STATE}`)).rejects.toThrow();
    expect(history.calls).toEqual([[null, "", "/app/sign-in"]]);
    expect(trace).toEqual(["replaceState", "loginWithCode"]);
  });

  it("does not throw when history is absent", async () => {
    const sdk = fakeSdk();
    const adapter = createPrivyAdapter({ appId: "a", Privy: sdk.Privy, storage: fakeStorage(), location: fakeLocation(), history: null });
    expect(await adapter.finishOAuth(`?privy_oauth_code=${CODE}&privy_oauth_state=${STATE}`)).toBe(true);
  });

  it("throws when only one of the two parameters is present", async () => {
    const sdk = fakeSdk();
    const adapter = adapterFor(sdk);
    await expect(adapter.finishOAuth(`?privy_oauth_code=${CODE}`)).rejects.toThrow();
    expect(sdk.log.some((line) => line.startsWith("loginWithCode"))).toBe(false);
  });

  it("on success and on failure, logs nothing that contains the code or state, and the error has no cause", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    const search = `?privy_oauth_code=${CODE}&privy_oauth_state=${STATE}`;

    await adapterFor(fakeSdk()).finishOAuth(search);

    const failing = adapterFor(fakeSdk({ loginCodeError: true }));
    const error = await failing.finishOAuth(search).then(
      () => null,
      (err: unknown) => err as Error & { cause?: unknown }
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toContain(CODE);
    expect(error?.message).not.toContain(STATE);
    expect(error && "cause" in error).toBe(false);
    expect(error?.cause).toBeUndefined();

    const printed = spies.flatMap((spy) => spy.mock.calls.flat().map(String)).join("\n");
    expect(printed).not.toContain(CODE);
    expect(printed).not.toContain(STATE);
  });
});

describe("Privy adapter: wallet sign-in", () => {
  it("requests the account, then signs the SIWE message before logging in", async () => {
    const sdk = fakeSdk();
    const adapter = adapterFor(sdk);
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
    await adapterFor(sdk).connectWallet(fakeWallet(sdk.log));
    expect(sdk.log).toContain(`siwe.init ${ADDRESS} eip155:1 bind.example https://bind.example`);
  });

  it("throws a clear error when no wallet provider is present", async () => {
    const sdk = fakeSdk();
    const adapter = adapterFor(sdk);
    await expect(adapter.connectWallet(undefined)).rejects.toThrow(/No wallet/);
    await expect(adapter.connectWallet({} as never)).rejects.toThrow(/No wallet/);
    expect(sdk.log.some((line) => line.startsWith("siwe"))).toBe(false);
  });

  it.each([
    ["code 4001", 4001, /cancelled/],
    ["ACTION_REJECTED", "ACTION_REJECTED", /cancelled/],
    ["-32002 pending", -32002, /already pending/],
  ])("maps %s to a clear message and does not log in", async (_name, code, pattern) => {
    const sdk = fakeSdk();
    await expect(adapterFor(sdk).connectWallet(fakeWallet(sdk.log, { rejectCode: code }))).rejects.toThrow(pattern);
    expect(sdk.log.some((line) => line.startsWith("loginWithSiwe"))).toBe(false);
  });

  it("refuses a signature that is not a string", async () => {
    const sdk = fakeSdk();
    await expect(adapterFor(sdk).connectWallet(fakeWallet(sdk.log, { signature: { bad: true } }))).rejects.toThrow(/signature/);
    expect(sdk.log.some((line) => line.startsWith("loginWithSiwe"))).toBe(false);
  });

  it("throws when the wallet returns no account", async () => {
    const sdk = fakeSdk();
    await expect(adapterFor(sdk).connectWallet(fakeWallet(sdk.log, { noAccounts: true }))).rejects.toThrow(/did not return an account/);
  });

  it("throws before asking the wallet to sign when Privy cannot start SIWE", async () => {
    const sdk = fakeSdk({ siweInitError: true });
    await expect(adapterFor(sdk).connectWallet(fakeWallet(sdk.log))).rejects.toThrow(/could not be started/);
    expect(sdk.log.some((line) => line.startsWith("wallet personal_sign"))).toBe(false);
  });

  it("throws when Privy refuses the SIWE login", async () => {
    const sdk = fakeSdk({ loginSiweError: true });
    await expect(adapterFor(sdk).connectWallet(fakeWallet(sdk.log))).rejects.toThrow(/could not be completed/);
  });

  it("allows one wallet sign-in at a time: eth_requestAccounts and siwe.init run once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const sdk = fakeSdk();
    const adapter = adapterFor(sdk);
    const wallet = fakeWallet(sdk.log, { gate });
    const first = adapter.connectWallet(wallet);
    const second = adapter.connectWallet(wallet);
    release();
    await Promise.all([first, second]);
    expect(sdk.log.filter((line) => line === "wallet eth_requestAccounts")).toHaveLength(1);
    expect(sdk.log.filter((line) => line.startsWith("siwe.init"))).toHaveLength(1);
  });

  it("allows another attempt after one finishes", async () => {
    const sdk = fakeSdk();
    const adapter = adapterFor(sdk);
    await adapter.connectWallet(fakeWallet(sdk.log));
    await adapter.connectWallet(fakeWallet(sdk.log));
    expect(sdk.log.filter((line) => line.startsWith("siwe.init"))).toHaveLength(2);
  });
});

describe("Privy adapter: logout", () => {
  it("signs out when a session exists", async () => {
    const sdk = fakeSdk({ token: "t" });
    await adapterFor(sdk).logout();
    expect(sdk.log).toContain("logout");
  });

  it("does not call Privy's logout when there is no session", async () => {
    const sdk = fakeSdk({ token: null });
    await adapterFor(sdk).logout();
    expect(sdk.log).not.toContain("logout");
  });

  it("swallows errors", async () => {
    await expect(adapterFor(fakeSdk({ token: "t", logoutError: true })).logout()).resolves.toBeUndefined();
    await expect(adapterFor(fakeSdk({ initError: true })).logout()).resolves.toBeUndefined();
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

  it("writes to sessionStorage under privy: keys and never touches localStorage", () => {
    const backing = new Map<string, string>();
    const session = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
      key: (i: number) => [...backing.keys()][i] ?? null,
      get length() {
        return backing.size;
      },
    };
    const touched: string[] = [];
    const local = new Proxy({} as Record<string, unknown>, {
      get: (_t, prop) => {
        touched.push(String(prop));
        return undefined;
      },
      set: (_t, prop) => {
        touched.push(`set ${String(prop)}`);
        return true;
      },
    });
    vi.stubGlobal("window", { sessionStorage: session, localStorage: local });
    const storage = createSessionStorage();
    storage.put("pkce", "verifier-1");
    storage.put("state", { n: 2 });
    expect(backing.get("privy:pkce")).toBe(JSON.stringify("verifier-1"));
    expect(storage.get("state")).toEqual({ n: 2 });
    expect(storage.getKeys().sort()).toEqual(["pkce", "state"]);
    expect(touched).toEqual([]);
  });

  it("never lists or reads keys outside its namespace", () => {
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
    storage.put("state", "s");
    expect(storage.getKeys()).toEqual(["state"]);
    expect(storage.get("bind-access-key")).toBeUndefined();
    expect(backing.get("bind-access-key")).toBe("bnd_secret_key_value");
  });

  it("drops non-JSON garbage in a privy: entry instead of trusting it", () => {
    const backing = new Map<string, string>([["privy:pkce", "not json{"]]);
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
    expect(storage.get("pkce")).toBeUndefined();
    expect(backing.has("privy:pkce")).toBe(false);
  });

  it("prefers the in-memory value over an older one left in sessionStorage", () => {
    const backing = new Map<string, string>();
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
    storage.put("k", "new");
    backing.set("privy:k", JSON.stringify("old"));
    expect(storage.get("k")).toBe("new");
  });

  it("when a sessionStorage write fails, removes the older stored value so it cannot win", () => {
    const backing = new Map<string, string>([["privy:k", JSON.stringify("old")]]);
    const session = {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string) => {
        if (k === "privy:k") throw new Error("quota");
        backing.set(k, "");
      },
      removeItem: (k: string) => void backing.delete(k),
      key: (i: number) => [...backing.keys()][i] ?? null,
      get length() {
        return backing.size;
      },
    };
    const storage = createSessionStorage(() => session as unknown as Storage);
    storage.put("k", "new");
    expect(backing.has("privy:k")).toBe(false);
    expect(storage.get("k")).toBe("new");
  });
});

describe("web bundle", () => {
  it(
    "npm run web:bundle writes a self-contained ES module under 3 MB with no eval or Function constructor",
    () => {
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
      // An ES module, loaded by the page with import().
      expect(text).toMatch(/\bexport\s*\{/);
      expect(text).toContain("eip155:");
    },
    60000
  );

  it("the resolved ox version is the pinned override", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { overrides: Record<string, string> };
    const installed = JSON.parse(readFileSync(path.join(ROOT, "node_modules", "ox", "package.json"), "utf8")) as { version: string };
    expect(pkg.overrides.ox).toBe("0.14.56");
    expect(installed.version).toBe(pkg.overrides.ox);
  });
});
