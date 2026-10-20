import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * Verifies a Privy access token (ADR 0051). A Privy access token is an ES256 JWT: `sub` is the user's Privy id (a DID),
 * `aud` is the Privy app id, `iss` is "privy.io", and `exp` is a short lifetime. The check is done here with the app's
 * public verification key (PEM) and no network call. Privy proves who someone is; it grants nothing in Bind.
 *
 * Strict by construction: only ES256 is accepted (never "none" or HS256), the header must be a JWT, the signature is
 * checked before any claim is trusted, and the audience, expiry and subject are required.
 */
export interface PrivyIdentity {
  /** The Privy user id, such as did:privy:abc123. */
  userId: string;
  /** The Privy session id, when the token carries one. */
  sessionId?: string;
}

export interface PrivyVerifier {
  /** Resolves to the identity, or null for any token that is not valid. Never throws for a bad token. */
  verify(token: string): Promise<PrivyIdentity | null>;
}

const MAX_TOKEN_LENGTH = 8192;
const CLOCK_SKEW_SECONDS = 30;

function b64urlToBuffer(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  return Buffer.from(value, "base64url");
}

function parseJson(buffer: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(buffer.toString("utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The verifier for one app. Throws at construction when the key is not a P-256 public key, so a bad config fails at startup. */
export function createPrivyVerifier(options: { appId: string; verificationKeyPem: string; now?: () => number }): PrivyVerifier {
  const key: KeyObject = createPublicKey(options.verificationKeyPem.replace(/\\n/g, "\n"));
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("The Privy verification key must be an ECDSA P-256 public key.");
  }
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  return {
    async verify(token: string): Promise<PrivyIdentity | null> {
      if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      const [headerPart, payloadPart, signaturePart] = parts;
      const headerBytes = b64urlToBuffer(headerPart);
      const payloadBytes = b64urlToBuffer(payloadPart);
      const signature = b64urlToBuffer(signaturePart);
      if (!headerBytes || !payloadBytes || !signature) return null;
      const header = parseJson(headerBytes);
      if (!header || header.alg !== "ES256" || (header.typ !== undefined && header.typ !== "JWT")) return null;
      if (signature.length !== 64) return null;
      let valid = false;
      try {
        valid = verify("sha256", Buffer.from(`${headerPart}.${payloadPart}`), { key, dsaEncoding: "ieee-p1363" }, signature);
      } catch {
        return null;
      }
      if (!valid) return null;

      const claims = parseJson(payloadBytes);
      if (!claims) return null;
      const aud = claims.aud;
      const audOk = typeof aud === "string" ? aud === options.appId : Array.isArray(aud) && aud.includes(options.appId);
      if (!audOk) return null;
      if (claims.iss !== undefined && claims.iss !== "privy.io") return null;
      const exp = claims.exp;
      if (typeof exp !== "number" || exp + CLOCK_SKEW_SECONDS < now()) return null;
      if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > now()) return null;
      const sub = claims.sub;
      if (typeof sub !== "string" || sub.length === 0 || sub.length > 200) return null;
      return { userId: sub, ...(typeof claims.sid === "string" ? { sessionId: claims.sid } : {}) };
    },
  };
}
