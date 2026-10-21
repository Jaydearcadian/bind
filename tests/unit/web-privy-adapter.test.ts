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
  /** The person's linked accounts. Creating a wallet pushes onto this array, as Privy would. */
  linkedAccounts?: unknown[];
  /** What embeddedWallet.getURL() returns. */
  frameUrl?: unknown;
  frameUrlThrows?: boolean;
  userGetError?: boolean;
  /** Set to a message to make embeddedWallet.create throw an Error with it. */
  createError?: string;
  /** Makes create succeed without adding a wallet to the user. */
  createAddsNothing?: boolean;
};

const FRAME_URL = "https://auth.privy.io/apps/app-1/embedded-wallets?client_id=client-1";
const NEW_ADDRESS = "0x2222222222222222222222222222222222222222";
const OTHER_ADDRESS = "0x3333333333333333333333333333333333333333";

/** A linked account for Privy's own embedded Ethereum wallet. */
const embeddedAccount = (address: string) => ({
  type: "wallet",
  chain_type: "ethereum",
  connector_type: "embedded",
  wallet_client_type: "privy",
  wallet_client: "privy",
  address,
  wallet_index: 0,
  recovery_method: "privy",
});

/** A linked account for an external wallet the person brought (not embedded). */
const externalWallet = (address: string) => ({
  type: "wallet",
  chain_type: "ethereum",
  connector_type: "injected",
  wallet_client_type: "metamask",
  wallet_client: "metamask",
  address,
});

/** A fake Privy SDK class. It records every call in `log`, in order, so tests can check ordering. */
function fakeSdk(options: FakeOptions = {}) {
  const log: string[] = [];
  const constructedWith: { appId: string; storage: SessionStorageLike }[] = [];
  const initCalls = { count: 0 };
  const accounts: unknown[] = options.linkedAccounts ?? [];
  const onMessages: unknown[] = [];
  const posters: { postMessage: (message: unknown, targetOrigin: string) => void; reload: () => void }[] = [];
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
    user = {
      get: async () => {
        log.push("user.get");
        if (options.userGetError) throw new Error(`user lookup failed for ${ADDRESS}`);
        return { user: { id: "did:privy:test-user", linked_accounts: accounts } };
      },
    };
    embeddedWallet = {
      getURL: () => {
        log.push("getURL");
        if (options.frameUrlThrows) throw new Error("getURL failed");
        return "frameUrl" in options ? options.frameUrl : FRAME_URL;
      },
      create: async (input: unknown) => {
        log.push(`embeddedWallet.create ${JSON.stringify(input)}`);
        if (options.createError !== undefined) {
          throw Object.assign(new Error(options.createError), { cause: new Error("inner cause") });
        }
        if (!options.createAddsNothing) accounts.push(embeddedAccount(NEW_ADDRESS));
        return { token: "t", user: { id: "did:privy:test-user", linked_accounts: accounts } };
      },
      onMessage: (message: unknown) => {
        log.push("onMessage");
        onMessages.push(message);
      },
    };
    /** On the client, as in the SDK (Privy.setMessagePoster). */
    setMessagePoster(poster: (typeof posters)[number]) {
      log.push("setMessagePoster");
      posters.push(poster);
    }
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
  return { Privy: FakePrivy, log, constructedWith, initCalls, options, accounts, onMessages, posters };
}

type FakeFrame = {
  tag: string;
  src: string;
  title: string;
  attributes: Record<string, string>;
  style: Record<string, string>;
  setAttribute: (name: string, value: string) => void;
  contentWindow: { posted: Array<[unknown, string]>; postMessage: (message: unknown, targetOrigin: string) => void };
};

/** A fake iframe element. Its contentWindow records every postMessage it receives, with the target origin. */
function fakeFrame(tag: string): FakeFrame {
  const posted: Array<[unknown, string]> = [];
  return {
    tag,
    src: "",
    title: "",
    attributes: {},
    style: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    contentWindow: {
      posted,
      postMessage(message, targetOrigin) {
        posted.push([message, targetOrigin]);
      },
    },
  };
}

/** A fake document with only what the adapter touches: createElement and body.appendChild. */
function fakeFrameDocument() {
  const created: FakeFrame[] = [];
  const appended: FakeFrame[] = [];
  return {
    created,
    appended,
    doc: {
      body: {
        appendChild: (el: FakeFrame) => {
          appended.push(el);
          return el;
        },
      },
      createElement: (tag: string) => {
        const el = fakeFrame(tag);
        created.push(el);
        return el;
      },
    },
  };
}

type MessageListener = (event: unknown) => void;

/** A fake window that keeps its message listeners and can deliver a message event to them. */
function fakeFrameWindow() {
  const listeners: MessageListener[] = [];
  return {
    listeners,
    addEventListener: (type: string, listener: MessageListener) => {
      if (type === "message") listeners.push(listener);
    },
    dispatch: (event: unknown) => {
      for (const listener of listeners) listener(event);
    },
  };
}

/** The error a rejected promise gives, with its code. Fails the test if the promise resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error & { code?: string }> {
  try {
    await promise;
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error("expected the promise to reject");
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

describe("Privy adapter: embedded wallet (ADR 0071)", () => {
  const walletAdapter = (sdk: ReturnType<typeof fakeSdk>) => {
    const frames = fakeFrameDocument();
    const win = fakeFrameWindow();
    const adapter = adapterFor(sdk, { frameDocument: frames.doc, frameWindow: win });
    return { adapter, frames, win };
  };
  const creates = (log: string[]) => log.filter((line) => line.startsWith("embeddedWallet.create"));

  it("returns null from ensureWallet when signed out, and never creates", async () => {
    const sdk = fakeSdk({ token: null, linkedAccounts: [] });
    const { adapter, frames } = walletAdapter(sdk);
    expect(await adapter.ensureWallet()).toBeNull();
    expect(await adapter.getWalletAddress()).toBeNull();
    expect(creates(sdk.log)).toEqual([]);
    expect(frames.created).toHaveLength(0);
  });

  it("finds an existing embedded Ethereum wallet and does not call create", async () => {
    const sdk = fakeSdk({ token: "tok", linkedAccounts: [embeddedAccount(ADDRESS)] });
    const { adapter, frames } = walletAdapter(sdk);
    expect(await adapter.ensureWallet()).toEqual({ address: ADDRESS, created: false });
    expect(creates(sdk.log)).toEqual([]);
    expect(frames.created).toHaveLength(0);
  });

  it("creates one when none exists, with no password or recovery method, and returns created=true", async () => {
    const sdk = fakeSdk({ token: "tok", linkedAccounts: [] });
    const { adapter, frames } = walletAdapter(sdk);
    expect(await adapter.ensureWallet()).toEqual({ address: NEW_ADDRESS, created: true });
    // Exactly {}: Bind never invents a passcode, so the SDK uses Privy's default recovery.
    expect(creates(sdk.log)).toEqual(["embeddedWallet.create {}"]);
    expect(frames.created).toHaveLength(1);
    // The next call sees the wallet that now exists.
    expect(await adapter.ensureWallet()).toEqual({ address: NEW_ADDRESS, created: false });
    expect(creates(sdk.log)).toHaveLength(1);
  });

  it("concurrent ensureWallet calls share one promise and create once", async () => {
    const sdk = fakeSdk({ token: "tok", linkedAccounts: [] });
    const { adapter } = walletAdapter(sdk);
    const first = adapter.ensureWallet();
    const second = adapter.ensureWallet();
    expect(second).toBe(first);
    expect(await Promise.all([first, second])).toEqual([
      { address: NEW_ADDRESS, created: true },
      { address: NEW_ADDRESS, created: true },
    ]);
    expect(creates(sdk.log)).toHaveLength(1);
  });

  it("does not mistake an external wallet for the embedded one", async () => {
    const sdk = fakeSdk({ token: "tok", linkedAccounts: [externalWallet(OTHER_ADDRESS)] });
    const { adapter } = walletAdapter(sdk);
    expect(await adapter.getWalletAddress()).toBeNull();
    // The external wallet is ignored, so an embedded wallet is created and only its address is returned.
    expect(await adapter.ensureWallet()).toEqual({ address: NEW_ADDRESS, created: true });
    expect(creates(sdk.log)).toHaveLength(1);
  });

  it("getWalletAddress returns the embedded address and never creates a wallet", async () => {
    const withWallet = fakeSdk({ token: "tok", linkedAccounts: [externalWallet(OTHER_ADDRESS), embeddedAccount(ADDRESS)] });
    expect(await walletAdapter(withWallet).adapter.getWalletAddress()).toBe(ADDRESS);
    const without = fakeSdk({ token: "tok", linkedAccounts: [] });
    const frames = walletAdapter(without);
    expect(await frames.adapter.getWalletAddress()).toBeNull();
    expect(creates(without.log)).toEqual([]);
    expect(frames.frames.created).toHaveLength(0);
  });

  it("getWalletAddress and ensureWallet touch no frame when only reading", async () => {
    const sdk = fakeSdk({ token: "tok", linkedAccounts: [embeddedAccount(ADDRESS)] });
    const { adapter, frames } = walletAdapter(sdk);
    await adapter.getAccessToken();
    await adapter.getWalletAddress();
    await adapter.ensureWallet();
    expect(frames.created).toHaveLength(0);
    expect(frames.appended).toHaveLength(0);
    expect(sdk.posters).toHaveLength(0);
  });

  it("creates the frame lazily, once, hidden, with the exact Privy URL and title", async () => {
    const sdk = fakeSdk({ token: "tok", linkedAccounts: [] });
    const { adapter, frames, win } = walletAdapter(sdk);
    expect(frames.created).toHaveLength(0);
    await adapter.ensureWallet();
    expect(frames.created).toHaveLength(1);
    expect(frames.appended).toHaveLength(1);
    const frame = frames.appended[0];
    expect(frame.tag).toBe("iframe");
    expect(frame.src).toBe(FRAME_URL);
    expect(frame.title).toBe("Privy wallet");
    expect(frame.attributes["aria-hidden"]).toBe("true");
    expect(frame.style.display).toBe("none");
    expect(win.listeners).toHaveLength(1);
    expect(sdk.log.filter((line) => line === "setMessagePoster")).toHaveLength(1);
  });

  it("never keeps a second iframe, even after a failed create", async () => {
    const sdk = fakeSdk({ token: "tok", linkedAccounts: [], createError: "boom" });
    const { adapter, frames, win } = walletAdapter(sdk);
    expect((await rejectionOf(adapter.ensureWallet())).code).toBe("WALLET_CREATE_FAILED");
    delete sdk.options.createError;
    expect(await adapter.ensureWallet()).toEqual({ address: NEW_ADDRESS, created: true });
    expect(frames.created).toHaveLength(1);
    expect(frames.appended).toHaveLength(1);
    expect(win.listeners).toHaveLength(1);
    expect(sdk.log.filter((line) => line === "setMessagePoster")).toHaveLength(1);
  });

  it.each([
    ["an https host that only starts with auth.privy.io", "https://auth.privy.io.evil.example/embedded-wallets"],
    ["a different host", "https://evil.example/embedded-wallets"],
    ["plain http on the right host", "http://auth.privy.io/embedded-wallets"],
    ["a non-default port", "https://auth.privy.io:8443/embedded-wallets"],
    ["credentials in the URL", "https://user:pw@auth.privy.io/embedded-wallets"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["an unparseable value", "not a url"],
    ["a non-string value", 42],
  ])("refuses a frame URL with %s before appending anything", async (_label, frameUrl) => {
    const sdk = fakeSdk({ token: "tok", linkedAccounts: [], frameUrl });
    const { adapter, frames, win } = walletAdapter(sdk);
    const err = await rejectionOf(adapter.ensureWallet());
    expect(err.code).toBe("WALLET_FRAME_REFUSED");
    expect(frames.created).toHaveLength(0);
    expect(frames.appended).toHaveLength(0);
    expect(win.listeners).toHaveLength(0);
    expect(creates(sdk.log)).toEqual([]);
  });

  it("refuses when getURL throws", async () => {
    const sdk = fakeSdk({ token: "tok", linkedAccounts: [], frameUrlThrows: true });
    const { adapter, frames } = walletAdapter(sdk);
    expect((await rejectionOf(adapter.ensureWallet())).code).toBe("WALLET_FRAME_REFUSED");
    expect(frames.appended).toHaveLength(0);
  });

  it("forwards only messages from the frame's origin and window, after parsing", async () => {
    const sdk = fakeSdk({ token: "tok", linkedAccounts: [] });
    const { adapter, frames, win } = walletAdapter(sdk);
    await adapter.ensureWallet();
    const source = frames.appended[0].contentWindow;
    const ready = { event: "privy:iframe:ready", id: "1", data: {} };

    // Wrong origin, right window: ignored.
    win.dispatch({ origin: "https://evil.example", source, data: JSON.stringify(ready) });
    // Right origin, wrong window (another frame or the page itself): ignored.
    win.dispatch({ origin: "https://auth.privy.io", source: { posted: [] }, data: JSON.stringify(ready) });
    win.dispatch({ origin: "https://auth.privy.io", source: null, data: JSON.stringify(ready) });
    // Right origin and window, but not a Privy message: ignored.
    win.dispatch({ origin: "https://auth.privy.io", source, data: "not json" });
    win.dispatch({ origin: "https://auth.privy.io", source, data: 7 });
    win.dispatch({ origin: "https://auth.privy.io", source, data: { id: "2" } });
    expect(sdk.onMessages).toEqual([]);

    // Right origin and window: forwarded, as a JSON string or as an object.
    win.dispatch({ origin: "https://auth.privy.io", source, data: JSON.stringify(ready) });
    win.dispatch({ origin: "https://auth.privy.io", source, data: ready });
    expect(sdk.onMessages).toEqual([ready, ready]);
  });

  it("posts to the frame's validated origin, never to '*'", async () => {
    const sdk = fakeSdk({ token: "tok", linkedAccounts: [] });
    const { adapter, frames } = walletAdapter(sdk);
    await adapter.ensureWallet();
    sdk.posters[0].postMessage('{"event":"privy:wallets:create"}', "*");
    expect(frames.appended[0].contentWindow.posted).toEqual([['{"event":"privy:wallets:create"}', "https://auth.privy.io"]]);
  });

  it("errors carry a code, no cause, and no SDK or wallet text", async () => {
    const secret = "SECRET-TOKEN-VALUE";
    const failing = fakeSdk({ token: "tok", linkedAccounts: [], createError: `${secret} for ${OTHER_ADDRESS}` });
    const { adapter } = walletAdapter(failing);
    const err = await rejectionOf(adapter.ensureWallet());
    expect(err.code).toBe("WALLET_CREATE_FAILED");
    expect(err.message).not.toMatch(/SECRET|inner cause|0x3333/);
    expect(Object.prototype.hasOwnProperty.call(err, "cause")).toBe(false);
    expect(err.message.length).toBeGreaterThan(0);

    const lookup = fakeSdk({ token: "tok", linkedAccounts: [], userGetError: true });
    const lookupErr = await rejectionOf(walletAdapter(lookup).adapter.ensureWallet());
    expect(lookupErr.code).toBe("PRIVY_UNAVAILABLE");
    expect(lookupErr.message).not.toMatch(/user lookup|0x1111/);
    expect(Object.prototype.hasOwnProperty.call(lookupErr, "cause")).toBe(false);

    // getWalletAddress reports nothing on error: null, no throw.
    expect(await walletAdapter(lookup).adapter.getWalletAddress()).toBeNull();
  });

  it("reports PASSCODE_REQUIRED when the app demands a passcode, and invents none", async () => {
    const sdk = fakeSdk({
      token: "tok",
      linkedAccounts: [],
      createError: "Password not provided yet is required by App configuration",
    });
    const { adapter } = walletAdapter(sdk);
    const err = await rejectionOf(adapter.ensureWallet());
    expect(err.code).toBe("PASSCODE_REQUIRED");
    expect(creates(sdk.log)).toEqual(["embeddedWallet.create {}"]);
    expect(sdk.accounts).toEqual([]);
  });

  it("reports WALLET_NOT_FOUND when create succeeds but the user shows no embedded wallet", async () => {
    const sdk = fakeSdk({ token: "tok", linkedAccounts: [], createAddsNothing: true });
    const { adapter } = walletAdapter(sdk);
    expect((await rejectionOf(adapter.ensureWallet())).code).toBe("WALLET_NOT_FOUND");
  });

  it("exposes exactly the read and create methods, and no signing or sending method", () => {
    const { adapter } = walletAdapter(fakeSdk());
    expect(Object.keys(adapter).sort()).toEqual([
      "connectWallet",
      "ensureWallet",
      "finishOAuth",
      "getAccessToken",
      "getWalletAddress",
      "logout",
      "startGoogle",
    ]);
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
