/**
 * The registry of credential verifiers (ADR 0024). A verifier is in-process code that checks a secret against its
 * connector, for example with one read-only call. It receives the decrypted secret, so it runs only on the server, never
 * from a route body. The registry starts empty: no live connector exists yet, so nothing is verified.
 *
 * A verifier is keyed by connector id, or by connector kind when no connector id matches.
 */

export type VerifierResult = { ok: true } | { ok: false; code: string };

export interface VerifierContext {
  workspaceId: string;
  connectorId: string;
  kind: string;
}

export type CredentialVerifier = (secret: string, ctx: VerifierContext) => Promise<VerifierResult> | VerifierResult;

const verifiers = new Map<string, CredentialVerifier>();

/** Registers (or replaces) the verifier for a connector id or a connector kind. */
export function registerVerifier(key: string, verifier: CredentialVerifier): void {
  if (typeof key !== "string" || key.length === 0) throw new TypeError("A verifier needs a connector id or kind");
  if (typeof verifier !== "function") throw new TypeError("A verifier must be a function");
  verifiers.set(key, verifier);
}

/** The verifier for a connector: its id first, then its kind. Undefined when none is registered. */
export function findVerifier(connectorId: string, kind: string): CredentialVerifier | undefined {
  return verifiers.get(connectorId) ?? verifiers.get(kind);
}

/** Removes every registered verifier. Tests use it; production code registers verifiers at start-up and never clears them. */
export function clearVerifiers(): void {
  verifiers.clear();
}
