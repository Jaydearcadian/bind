// Types for privy.js, so TypeScript tests can import it. The bundle at web/app/vendor/privy.js is generated from privy.js.

export const PRIVY_PROVIDER: "google";
export const ALLOWED_AUTH_HOSTS: readonly ["auth.privy.io", "accounts.google.com"];

export interface SessionStorageLike {
  get(key: string): unknown;
  put(key: string, value: unknown): void;
  del(key: string): void;
  getKeys(): string[];
}

export interface PrivyAdapterLocation {
  host: string;
  origin: string;
  pathname: string;
  assign(url: string): void;
}

export interface PrivyAdapterHistory {
  replaceState(data: unknown, unused: string, url?: string | null): void;
}

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface PrivyAdapter {
  getAccessToken(): Promise<string | null>;
  startGoogle(redirectUri: string): Promise<void>;
  finishOAuth(search?: string): Promise<boolean>;
  connectWallet(ethereumProvider: Eip1193Provider | undefined | null): Promise<{ address: string }>;
  /** The embedded wallet address, or null when signed out, none exists, or on any error. Reads only. */
  getWalletAddress(): Promise<string | null>;
  /** Null when signed out. Otherwise the embedded wallet, created once if the person has none (ADR 0071). */
  ensureWallet(): Promise<{ address: string; created: boolean } | null>;
  logout(): Promise<void>;
}

/** The minimal document and window surfaces the wallet frame uses. Tests inject fakes; the page uses the globals. */
export interface PrivyAdapterFrameElement {
  src: string;
  title: string;
  style: { display: string };
  isConnected: boolean;
  setAttribute(name: string, value: string): void;
  remove(): void;
  contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null;
}

export interface PrivyAdapterFrameDocument {
  createElement(tag: "iframe"): PrivyAdapterFrameElement;
  getElementById(id: string): PrivyAdapterFrameElement | null;
  body: { appendChild(element: PrivyAdapterFrameElement): unknown };
}

export interface PrivyAdapterFrameWindow {
  addEventListener(type: "message", listener: (event: unknown) => void): void;
  removeEventListener(type: "message", listener: (event: unknown) => void): void;
}

export interface PrivyAdapterOptions {
  appId: string;
  Privy?: new (options: { appId: string; storage: SessionStorageLike }) => any;
  storage?: SessionStorageLike;
  location?: PrivyAdapterLocation;
  history?: PrivyAdapterHistory | null;
  frameDocument?: PrivyAdapterFrameDocument;
  frameWindow?: PrivyAdapterFrameWindow;
}

export function createSessionStorage(getStore?: () => Storage): SessionStorageLike;
export function createPrivyAdapter(options: PrivyAdapterOptions): PrivyAdapter;
