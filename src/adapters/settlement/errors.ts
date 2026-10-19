/**
 * Typed settlement failures. Messages name configuration variables and error codes only.
 * They never include a private key, and they are not built from request payloads.
 */

/** A required setting is missing or invalid. The message names the variables, never their values. */
export class SettlementNotConfiguredError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Arc settlement is not configured. Missing or invalid: ${missing.join(", ")}`);
    this.name = "SettlementNotConfiguredError";
    this.missing = missing;
  }
}

/** The RPC reports a different chain id from the configured one. Nothing is sent. */
export class SettlementChainMismatchError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number) {
    super(`Settlement chain mismatch: configured chain ${expected}, RPC reports ${actual}`);
    this.name = "SettlementChainMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

/** The payer address is not the configured settlement signer. Nothing is sent. */
export class SettlementPayerMismatchError extends Error {
  constructor() {
    super("Payer does not match the configured settlement signer");
    this.name = "SettlementPayerMismatchError";
  }
}

/** The contract or the request refused the settlement. `code` is the revert name or a request code. */
export class SettlementRejectedError extends Error {
  readonly code: string;
  readonly args?: unknown[];

  constructor(code: string, args?: unknown[]) {
    super(`Settlement rejected: ${code}`);
    this.name = "SettlementRejectedError";
    this.code = code;
    this.args = args;
  }
}

/** The operation has no on-chain implementation in this adapter. It is never faked. */
export class SettlementNotSupportedError extends Error {
  constructor(operation?: string) {
    super(`Settlement operation not supported by this adapter${operation ? `: ${operation}` : ""}`);
    this.name = "SettlementNotSupportedError";
  }
}
