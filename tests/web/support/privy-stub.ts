import { createPrivateKey, sign } from "node:crypto";
import type { Page } from "@playwright/test";
import { PRIVY_TEST_APP_ID, PRIVY_TEST_PRIVATE_KEY } from "./privy-test-key.js";

/*
 * The stand-in for the Privy SDK that the browser tests give the page (window.bindPrivyAdapter), and the real ES256 Privy
 * access tokens it hands over. The server verifies those tokens with the matching test public key, so everything after the
 * adapter is the real server (ADR 0072). Live Privy is NOT_RUN in the browser tests.
 */
export type StubOptions = { walletFails?: boolean };

export const APP_ID = PRIVY_TEST_APP_ID;
const PRIVATE_PEM = PRIVY_TEST_PRIVATE_KEY;
const run = Date.now();
let seq = 0;

export function privyToken(userId: string, overrides: Record<string, unknown> = {}, key = PRIVATE_PEM) {
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const head = b64({ alg: "ES256", typ: "JWT" });
  const body = b64({ sub: userId, aud: APP_ID, iss: "privy.io", exp: Math.floor(Date.now() / 1000) + 3600, ...overrides });
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: createPrivateKey(key), dsaEncoding: "ieee-p1363" });
  return `${head}.${body}.${sig.toString("base64url")}`;
}
/** Flips a real bit of the signature (the last base64 character holds unused bits, so editing it can change nothing). */
export function tamper(token: string) {
  const [h, b, sig] = token.split(".");
  const bytes = Buffer.from(sig, "base64url");
  bytes[10] ^= 0xff;
  return `${h}.${b}.${bytes.toString("base64url")}`;
}
export const newUser = () => `did:privy:acct-${run}-${++seq}`;
export const auth = (t: string) => ({ headers: { Authorization: `Bearer ${t}` } });

/** The stand-in for the Privy SDK. Its "session" lives in sessionStorage like the real SDK's, so it survives page changes in a tab. */
export async function installAdapter(page: Page, token: string | null, walletToken?: string, options: StubOptions = {}) {
  await page.addInitScript(
    ({ t, w, o }) => {
      const KEY = "stub-privy-token";
      // Seed once per tab: the init script runs on every page load, and a later sign-out must stay signed out.
      if (t && !sessionStorage.getItem("stub-privy-seeded")) {
        sessionStorage.setItem("stub-privy-seeded", "1");
        sessionStorage.setItem(KEY, t);
      }
      const w2 = window as unknown as Record<string, unknown>;
      // Calls are kept in the tab's storage, so a test can count them across page changes.
      const rec = (x: string) => {
        const a = JSON.parse(sessionStorage.getItem("stub-calls") || "[]") as string[];
        a.push(x);
        sessionStorage.setItem("stub-calls", JSON.stringify(a));
        w2.__calls = a;
      };
      w2.__calls = JSON.parse(sessionStorage.getItem("stub-calls") || "[]");
      (w2.ethereum as unknown) = w ? {} : undefined;
      w2.bindPrivyAdapter = {
        async getAccessToken() {
          return sessionStorage.getItem(KEY);
        },
        async startGoogle(redirect: string) {
          rec(`google:${redirect}`);
        },
        async finishOAuth(search: string) {
          rec(`finish:${search}`);
          if (!/privy_oauth_code=/.test(search)) return false;
          if (w) sessionStorage.setItem(KEY, w);
          return true;
        },
        async connectWallet() {
          rec("wallet");
          if (w) sessionStorage.setItem(KEY, w);
        },
        // The embedded wallet (ADR 0073): created on request, one per signed-in person, address kept in the tab like the SDK would.
        async ensureWallet() {
          rec("ensureWallet");
          if (!sessionStorage.getItem(KEY)) return null;
          if ((o as { walletFails?: boolean }).walletFails && !(w2 as { __walletWorks?: boolean }).__walletWorks) throw new Error("wallet failed");
          const existing = sessionStorage.getItem("stub-wallet");
          if (existing) return { address: existing, created: false };
          const address = "0x" + Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
          sessionStorage.setItem("stub-wallet", address);
          return { address, created: true };
        },
        async getWalletAddress() {
          if (!sessionStorage.getItem(KEY)) return null;
          return sessionStorage.getItem("stub-wallet");
        },
        async logout() {
          rec("logout");
          sessionStorage.removeItem(KEY);
        },
      };
    },
    { t: token, w: walletToken ?? null, o: options }
  );
}

