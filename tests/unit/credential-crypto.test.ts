import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import {
  CredentialDecryptError,
  credentialKeyFromBase64,
  decryptSecret,
  encryptSecret,
  type Keyring,
} from "../../src/credentials/crypto.js";

/*
 * AES-256-GCM for connector credentials (ADR 0024). The keys are passed in explicitly here, so the tests never depend on
 * the environment. Titles are fixed by the brief.
 */

const WORKSPACE = "ws-crypto-a";
const CONNECTOR = "supplier.metro";
const CTX = { workspaceId: WORKSPACE, connectorId: CONNECTOR };
const SECRET = "sk-SUPPLIER-SECRET-0123456789abcdef";

function randomKey(): string {
  return randomBytes(32).toString("base64");
}

function keyring(current: string, previous?: string): Keyring {
  return {
    current: credentialKeyFromBase64(current),
    ...(previous ? { previous: credentialKeyFromBase64(previous) } : {}),
  };
}

describe("connector credential crypto", () => {
  it("round-trips a secret", () => {
    const ring = keyring(randomKey());
    const encrypted = encryptSecret(SECRET, CTX, ring);
    expect(decryptSecret(encrypted, CTX, ring)).toBe(SECRET);
  });

  it("uses a different nonce every time", () => {
    const ring = keyring(randomKey());
    const first = encryptSecret(SECRET, CTX, ring);
    const second = encryptSecret(SECRET, CTX, ring);
    expect(first.nonce).toHaveLength(12);
    expect(second.nonce).toHaveLength(12);
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
    expect(first.authTag).toHaveLength(16);
  });

  it("a wrong key cannot decrypt", () => {
    const ring = keyring(randomKey());
    const other = keyring(randomKey());
    const encrypted = encryptSecret(SECRET, CTX, ring);
    expect(() => decryptSecret(encrypted, CTX, other)).toThrow(CredentialDecryptError);

    // Same key id, different key bytes: only the authentication tag can refuse this.
    const forged = { ...encrypted, keyId: createHash("sha256").update(other.current.key).digest("hex").slice(0, 8) };
    expect(() => decryptSecret(forged, CTX, other)).toThrow(CredentialDecryptError);
  });

  it("a tampered ciphertext is rejected", () => {
    const ring = keyring(randomKey());
    const encrypted = encryptSecret(SECRET, CTX, ring);

    const flipped = Buffer.from(encrypted.ciphertext);
    flipped[0] ^= 0x01;
    expect(() => decryptSecret({ ...encrypted, ciphertext: flipped }, CTX, ring)).toThrow(CredentialDecryptError);

    const tag = Buffer.from(encrypted.authTag);
    tag[tag.length - 1] ^= 0x80;
    expect(() => decryptSecret({ ...encrypted, authTag: tag }, CTX, ring)).toThrow(CredentialDecryptError);
  });

  it("a ciphertext moved to another workspace or connector is rejected", () => {
    const ring = keyring(randomKey());
    const encrypted = encryptSecret(SECRET, CTX, ring);
    expect(() => decryptSecret(encrypted, { workspaceId: "ws-crypto-b", connectorId: CONNECTOR }, ring)).toThrow(
      CredentialDecryptError
    );
    expect(() => decryptSecret(encrypted, { workspaceId: WORKSPACE, connectorId: "supplier.other" }, ring)).toThrow(
      CredentialDecryptError
    );
  });

  it("the previous key still decrypts and the current key encrypts", () => {
    const oldKey = randomKey();
    const newKey = randomKey();
    const oldRing = keyring(oldKey);
    const rotatingRing = keyring(newKey, oldKey);

    const encryptedUnderOld = encryptSecret(SECRET, CTX, oldRing);
    expect(decryptSecret(encryptedUnderOld, CTX, rotatingRing)).toBe(SECRET);

    const encryptedUnderNew = encryptSecret(SECRET, CTX, rotatingRing);
    const newKeyId = createHash("sha256").update(Buffer.from(newKey, "base64")).digest("hex").slice(0, 8);
    expect(encryptedUnderNew.keyId).toBe(newKeyId);
    expect(decryptSecret(encryptedUnderNew, CTX, rotatingRing)).toBe(SECRET);
    // Once the old key is removed, the new ciphertext still decrypts.
    expect(decryptSecret(encryptedUnderNew, CTX, keyring(newKey))).toBe(SECRET);
    // An unknown key id is refused without touching the ciphertext.
    expect(() => decryptSecret({ ...encryptedUnderOld, keyId: "00000000" }, CTX, rotatingRing)).toThrow(
      CredentialDecryptError
    );
  });

  it("the fingerprint is stable per secret and does not contain it", () => {
    const ring = keyring(randomKey());
    const first = encryptSecret(SECRET, CTX, ring);
    const second = encryptSecret(SECRET, CTX, ring);
    const other = encryptSecret(`${SECRET}-different`, CTX, ring);

    expect(first.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(other.fingerprint).not.toBe(first.fingerprint);
    expect(first.fingerprint).not.toContain(SECRET);
    expect(first.keyId).toMatch(/^[0-9a-f]{8}$/);
  });
});
