import crypto from "node:crypto";
import { config, credentialKeyBytes } from "../config/env.js";

/**
 * AES-256-GCM for connector credentials (ADR 0024). Pure over its inputs: the keys are passed in, and only
 * keyringFromConfig reads configuration. No error message here ever contains a key, a secret or a ciphertext.
 *
 * The additional authenticated data is `${workspaceId}:${connectorId}`, so a ciphertext copied to another workspace or
 * another connector fails authentication. The key id is the first 8 hex characters of SHA-256 of the key bytes. The
 * fingerprint is an HMAC of the secret under a key derived from the credential key, first 12 hex characters: it names a
 * secret without revealing it and without matching it across databases that lack the key.
 */

/** Thrown by every credential store function when no BIND_CREDENTIAL_KEY is configured. The API answers 503. */
export class CredentialStoreDisabledError extends Error {
  constructor() {
    super("Credential store is not configured");
    this.name = "CredentialStoreDisabledError";
  }
}

/** A stored ciphertext cannot be decrypted: unknown key id, failed authentication, or a malformed record. */
export class CredentialDecryptError extends Error {
  constructor(reason: string) {
    super(`Credential could not be decrypted: ${reason}`);
    this.name = "CredentialDecryptError";
  }
}

export interface CredentialKey {
  keyId: string;
  key: Buffer;
}

export interface Keyring {
  current: CredentialKey;
  previous?: CredentialKey;
}

export interface CredentialContext {
  workspaceId: string;
  connectorId: string;
}

export interface EncryptedSecret {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyId: string;
  fingerprint: string;
}

/** The stored parts needed to decrypt. The fingerprint is not needed to decrypt. */
export interface StoredCiphertext {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyId: string | null;
}

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function keyIdOf(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** Builds a key from its base64 form. Refuses a value that is not base64 of exactly 32 bytes, without echoing it. */
export function credentialKeyFromBase64(value: string): CredentialKey {
  const key = credentialKeyBytes(value);
  if (!key) throw new TypeError("A credential key must be base64 of exactly 32 bytes");
  return { keyId: keyIdOf(key), key };
}

/**
 * The keyring from configuration, read at call time (not cached at import), so a key change or a test takes effect on
 * the next call. Throws CredentialStoreDisabledError when BIND_CREDENTIAL_KEY is unset.
 */
export function keyringFromConfig(): Keyring {
  const current = config.BIND_CREDENTIAL_KEY;
  if (!current) throw new CredentialStoreDisabledError();
  const previous = config.BIND_CREDENTIAL_KEY_PREVIOUS;
  return {
    current: credentialKeyFromBase64(current),
    ...(previous ? { previous: credentialKeyFromBase64(previous) } : {}),
  };
}

function aadOf(ctx: CredentialContext): Buffer {
  return Buffer.from(`${ctx.workspaceId}:${ctx.connectorId}`, "utf8");
}

function fingerprintOf(key: Buffer, secret: string): string {
  const fingerprintKey = crypto.createHmac("sha256", key).update("bind-credential-fingerprint-v1").digest();
  return crypto.createHmac("sha256", fingerprintKey).update(secret, "utf8").digest("hex").slice(0, 12);
}

/** Encrypts under the current key with a fresh random nonce. */
export function encryptSecret(plaintext: string, ctx: CredentialContext, keyring: Keyring = keyringFromConfig()): EncryptedSecret {
  const { key, keyId } = keyring.current;
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadOf(ctx));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext,
    nonce,
    authTag: cipher.getAuthTag(),
    keyId,
    fingerprint: fingerprintOf(key, plaintext),
  };
}

/** Decrypts with the key whose id the record names (current or previous). */
export function decryptSecret(record: StoredCiphertext, ctx: CredentialContext, keyring: Keyring = keyringFromConfig()): string {
  const candidate = [keyring.current, keyring.previous].find((k): k is CredentialKey => k !== undefined && k.keyId === record.keyId);
  if (!candidate) throw new CredentialDecryptError("no configured key has the stored key id");
  if (record.nonce.length !== NONCE_BYTES || record.authTag.length !== TAG_BYTES) {
    throw new CredentialDecryptError("the stored record is malformed");
  }
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, candidate.key, record.nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadOf(ctx));
    decipher.setAuthTag(record.authTag);
    return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new CredentialDecryptError("authentication failed");
  }
}
