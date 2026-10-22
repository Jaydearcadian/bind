import { redactText, redactUrls } from "../../utils/redact.js";

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

  constructor(code: string, args?: unknown[], detail?: string) {
    super(
      detail
        ? `Settlement rejected: ${code}: ${detail}`
        : `Settlement rejected: ${code}`,
    );
    this.name = "SettlementRejectedError";
    this.code = code;
    this.args = args;
  }
}

/**
 * Request code for an amount that is zero, negative, a JS number, or any other non-bigint value. Bind settles whole
 * cents only (owner decision): nothing is paid below 0.01 USDC. Sub-cent payments need an owner decision first.
 * See docs/CONTRACT_SCOPE.md, "Amount units".
 */
export const SUB_CENT_AMOUNT_NOT_SUPPORTED = "SUB_CENT_AMOUNT_NOT_SUPPORTED";

const SUB_CENT_DETAIL =
  "amounts below one cent (0.01 USDC) are not supported yet, only whole cents are paid";

/**
 * Refuses an amount that is not a positive whole number of cents. It is synchronous and makes no network call, so an
 * adapter runs it before any RPC or chain read. The message never includes the amount.
 */
export function assertPayableCentAmount(
  amountCents: unknown,
): asserts amountCents is bigint {
  if (typeof amountCents !== "bigint" || amountCents <= 0n) {
    throw new SettlementRejectedError(
      SUB_CENT_AMOUNT_NOT_SUPPORTED,
      undefined,
      SUB_CENT_DETAIL,
    );
  }
}

/** The operation has no on-chain implementation in this adapter. It is never faked. */
export class SettlementNotSupportedError extends Error {
  constructor(operation?: string) {
    super(`Settlement operation not supported by this adapter${operation ? `: ${operation}` : ""}`);
    this.name = "SettlementNotSupportedError";
  }
}

/**
 * An RPC or transport call failed for a reason that is not a settlement decision. The message carries only the
 * operation and a redacted reason. It never has a `cause`, because a cause would keep the raw RPC error (and its URL).
 */
export class SettlementTransportError extends Error {
  readonly operation: string;

  constructor(operation: string, reason: string) {
    super(`RPC request failed during ${operation}: ${reason}`);
    this.name = "SettlementTransportError";
    this.operation = operation;
  }
}

/**
 * Removes URLs and known secrets from text. Every URL becomes [redacted-url], then the one redaction module (ADR 0024)
 * replaces every occurrence of each secret in `secrets` and every configured secret.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  return redactText(redactUrls(text), secrets);
}

/** Builds the transport error for a failed viem call, using the error's short message and redacting it. */
export function transportErrorFrom(operation: string, error: unknown, secrets: readonly string[]): SettlementTransportError {
  const details = error as { shortMessage?: unknown; message?: unknown } | null;
  const raw =
    typeof details?.shortMessage === "string"
      ? details.shortMessage
      : typeof details?.message === "string"
        ? details.message
        : "unknown error";
  return new SettlementTransportError(operation, redactSecrets(raw, secrets));
}
