import { describe, it, expect } from "vitest";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { createPrivyVerifier } from "../../src/accounts/privy.js";

/**
 * The Privy access token check (ADR 0051), with real ES256 signatures from a generated key. What this does not prove is that
 * Privy's own tokens verify: that needs the owner's Privy app and is NOT_RUN until then.
 */
const APP = "app_test_123";
const NOW = 1_800_000_000;
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const other = generateKeyPairSync("ec", { namedCurve: "P-256" });

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function mint(claims: Record<string, unknown>, opts: { key?: typeof privateKey; header?: Record<string, unknown> } = {}): string {
  const head = b64(opts.header ?? { alg: "ES256", typ: "JWT" });
  const body = b64({ sub: "did:privy:abc", aud: APP, iss: "privy.io", sid: "s1", iat: NOW - 5, exp: NOW + 3600, ...claims });
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: opts.key ?? privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `${head}.${body}.${sig}`;
}
const verifier = createPrivyVerifier({ appId: APP, verificationKeyPem: pem, now: () => NOW });

describe("Privy access token verification", () => {
  it("accepts a valid token and returns the user id and session id", async () => {
    expect(await verifier.verify(mint({}))).toEqual({ userId: "did:privy:abc", sessionId: "s1" });
  });

  it("accepts an audience list that contains the app id, and a token with no issuer claim", async () => {
    expect((await verifier.verify(mint({ aud: ["x", APP] })))?.userId).toBe("did:privy:abc");
    const body = { sub: "did:privy:z", aud: APP, exp: NOW + 60 };
    const head = b64({ alg: "ES256", typ: "JWT" });
    const payload = b64(body);
    const sig = sign("sha256", Buffer.from(`${head}.${payload}`), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    expect((await verifier.verify(`${head}.${payload}.${sig}`))?.userId).toBe("did:privy:z");
  });

  it("refuses a token signed by another key, and a token whose payload was changed after signing", async () => {
    expect(await verifier.verify(mint({}, { key: other.privateKey }))).toBeNull();
    const [h, , s] = mint({}).split(".");
    expect(await verifier.verify(`${h}.${b64({ sub: "did:privy:evil", aud: APP, exp: NOW + 3600 })}.${s}`)).toBeNull();
  });

  it("refuses the wrong audience, the wrong issuer, an expired token and a token not yet valid", async () => {
    expect(await verifier.verify(mint({ aud: "another_app" }))).toBeNull();
    expect(await verifier.verify(mint({ aud: undefined }))).toBeNull();
    expect(await verifier.verify(mint({ iss: "evil.example" }))).toBeNull();
    expect(await verifier.verify(mint({ exp: NOW - 120 }))).toBeNull();
    expect(await verifier.verify(mint({ nbf: NOW + 600 }))).toBeNull();
    expect(await verifier.verify(mint({ exp: undefined }))).toBeNull();
  });

  it("refuses a missing or odd subject", async () => {
    expect(await verifier.verify(mint({ sub: undefined }))).toBeNull();
    expect(await verifier.verify(mint({ sub: "" }))).toBeNull();
    expect(await verifier.verify(mint({ sub: 7 }))).toBeNull();
    expect(await verifier.verify(mint({ sub: "x".repeat(201) }))).toBeNull();
  });

  it("refuses algorithm tricks: none, HS256 keyed with the public key, and an unknown algorithm", async () => {
    const body = b64({ sub: "did:privy:abc", aud: APP, exp: NOW + 3600 });
    expect(await verifier.verify(`${b64({ alg: "none", typ: "JWT" })}.${body}.`)).toBeNull();
    const hsHead = b64({ alg: "HS256", typ: "JWT" });
    const mac = createHmac("sha256", pem).update(`${hsHead}.${body}`).digest("base64url");
    expect(await verifier.verify(`${hsHead}.${body}.${mac}`)).toBeNull();
    expect(await verifier.verify(mint({}, { header: { alg: "ES384", typ: "JWT" } }))).toBeNull();
    expect(await verifier.verify(mint({}, { header: { alg: "ES256", typ: "JWE" } }))).toBeNull();
  });

  it("refuses malformed input without throwing", async () => {
    for (const t of ["", "a.b", "a.b.c.d", "...", "!!.!!.!!", "x".repeat(9000), mint({}).slice(0, -4), `${mint({}).split(".").slice(0, 2).join(".")}.${"A".repeat(86)}`]) {
      expect(await verifier.verify(t), t.slice(0, 20)).toBeNull();
    }
    expect(await verifier.verify(undefined as unknown as string)).toBeNull();
  });

  it("refuses to be built with a key that is not a P-256 public key", () => {
    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey.export({ type: "spki", format: "pem" }).toString();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(() => createPrivyVerifier({ appId: APP, verificationKeyPem: p384 })).toThrow(/P-256/);
    expect(() => createPrivyVerifier({ appId: APP, verificationKeyPem: rsa })).toThrow(/P-256/);
    expect(() => createPrivyVerifier({ appId: APP, verificationKeyPem: "not a key" })).toThrow();
  });

  it("accepts the key with escaped newlines, as an environment variable carries it", async () => {
    const v = createPrivyVerifier({ appId: APP, verificationKeyPem: pem.replace(/\n/g, "\\n"), now: () => NOW });
    expect((await v.verify(mint({})))?.userId).toBe("did:privy:abc");
  });

  describe("several keys at once (Privy rotates two signing keys)", () => {
    const second = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const pem2 = second.publicKey.export({ type: "spki", format: "pem" }).toString();
    const bundle = `${pem}${pem2}`;
    const rotating = createPrivyVerifier({ appId: APP, verificationKeyPem: bundle, now: () => NOW });

    it("still accepts a single key exactly as before", async () => {
      const single = createPrivyVerifier({ appId: APP, verificationKeyPem: pem, now: () => NOW });
      expect((await single.verify(mint({})))?.userId).toBe("did:privy:abc");
      expect(await single.verify(mint({}, { key: second.privateKey }))).toBeNull();
    });

    it("accepts a token signed by either key of a two-key bundle", async () => {
      expect(await rotating.verify(mint({}, { key: privateKey }))).toEqual({ userId: "did:privy:abc", sessionId: "s1" });
      expect((await rotating.verify(mint({ sub: "did:privy:second" }, { key: second.privateKey })))?.userId).toBe("did:privy:second");
    });

    it("refuses a token signed by a third key that is not in the bundle", async () => {
      expect(await rotating.verify(mint({}, { key: other.privateKey }))).toBeNull();
    });

    it("still applies every claim check to a token from the second key", async () => {
      expect(await rotating.verify(mint({ aud: "another_app" }, { key: second.privateKey }))).toBeNull();
      expect(await rotating.verify(mint({ exp: NOW - 120 }, { key: second.privateKey }))).toBeNull();
      expect(await rotating.verify(mint({ iss: "evil.example" }, { key: second.privateKey }))).toBeNull();
    });

    it("refuses algorithm tricks with a two-key bundle: none, HS256 keyed with a public key, and ES384", async () => {
      const body = b64({ sub: "did:privy:abc", aud: APP, exp: NOW + 3600 });
      expect(await rotating.verify(`${b64({ alg: "none", typ: "JWT" })}.${body}.`)).toBeNull();
      for (const k of [pem, pem2]) {
        const hsHead = b64({ alg: "HS256", typ: "JWT" });
        const mac = createHmac("sha256", k).update(`${hsHead}.${body}`).digest("base64url");
        expect(await rotating.verify(`${hsHead}.${body}.${mac}`)).toBeNull();
      }
      expect(await rotating.verify(mint({}, { key: second.privateKey, header: { alg: "ES384", typ: "JWT" } }))).toBeNull();
    });

    it("accepts the two-key bundle in the single-line escaped form an environment variable carries", async () => {
      const escaped = bundle.replace(/\n/g, "\\n");
      const v = createPrivyVerifier({ appId: APP, verificationKeyPem: escaped, now: () => NOW });
      expect((await v.verify(mint({}, { key: second.privateKey })))?.userId).toBe("did:privy:abc");
      expect((await v.verify(mint({}, { key: privateKey })))?.userId).toBe("did:privy:abc");
      expect(await v.verify(mint({}, { key: other.privateKey }))).toBeNull();
    });

    it("refuses a bundle that mixes a P-256 key with an RSA, secp256k1 or P-384 key", () => {
      const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
      const k1 = generateKeyPairSync("ec", { namedCurve: "secp256k1" }).publicKey.export({ type: "spki", format: "pem" }).toString();
      const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" }).publicKey.export({ type: "spki", format: "pem" }).toString();
      for (const bad of [pem + rsa, rsa + pem, pem + k1, pem + p384]) {
        expect(() => createPrivyVerifier({ appId: APP, verificationKeyPem: bad })).toThrow(/P-256/);
      }
    });

    it("refuses an empty value, a value with no key, stray text beside a key, and more than four keys", () => {
      expect(() => createPrivyVerifier({ appId: APP, verificationKeyPem: "" })).toThrow();
      expect(() => createPrivyVerifier({ appId: APP, verificationKeyPem: "   " })).toThrow();
      expect(() => createPrivyVerifier({ appId: APP, verificationKeyPem: `${pem}\nnot a key` })).toThrow();
      expect(() => createPrivyVerifier({ appId: APP, verificationKeyPem: `${pem}${pem2}${pem}${pem2}${pem}` })).toThrow(/at most 4/);
    });

    it("refuses a single PEM block that holds two DER keys, since the second would be silently dropped", () => {
      const der1 = publicKey.export({ type: "spki", format: "der" });
      const der2 = second.publicKey.export({ type: "spki", format: "der" });
      const b64Body = Buffer.concat([der1, der2]).toString("base64").match(/.{1,64}/g)!.join("\n");
      const oneBlock = `-----BEGIN PUBLIC KEY-----\n${b64Body}\n-----END PUBLIC KEY-----\n`;
      expect(() => createPrivyVerifier({ appId: APP, verificationKeyPem: oneBlock })).toThrow();
      expect(() => createPrivyVerifier({ appId: APP, verificationKeyPem: oneBlock.replace(/\n/g, "\\n") })).toThrow();
    });

    it("accepts up to four distinct keys and refuses a fifth one", async () => {
      const pairs = Array.from({ length: 5 }, () => generateKeyPairSync("ec", { namedCurve: "P-256" }));
      const pemOf = (i: number) => pairs[i].publicKey.export({ type: "spki", format: "pem" }).toString();
      const four = [0, 1, 2, 3].map(pemOf).join("");
      const v = createPrivyVerifier({ appId: APP, verificationKeyPem: four, now: () => NOW });
      expect((await v.verify(mint({}, { key: pairs[3].privateKey })))?.userId).toBe("did:privy:abc");
      expect(await v.verify(mint({}, { key: pairs[4].privateKey }))).toBeNull();
      expect(() => createPrivyVerifier({ appId: APP, verificationKeyPem: [0, 1, 2, 3, 4].map(pemOf).join("") })).toThrow(/at most 4/);
    });
  });
});
