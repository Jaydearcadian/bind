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
  logout(): Promise<void>;
}

export interface PrivyAdapterOptions {
  appId: string;
  Privy?: new (options: { appId: string; storage: SessionStorageLike }) => any;
  storage?: SessionStorageLike;
  location?: PrivyAdapterLocation;
  history?: PrivyAdapterHistory | null;
}

export function createSessionStorage(getStore?: () => Storage): SessionStorageLike;
export function createPrivyAdapter(options: PrivyAdapterOptions): PrivyAdapter;
