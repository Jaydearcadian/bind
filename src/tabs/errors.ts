/**
 * Typed failures of the tab ledger. A code names the rule that refused; the message is plain and never echoes an amount,
 * an address or a key from the request.
 */
export type TabErrorCode =
  | "INVALID_CHARGE_AMOUNT"
  | "INVALID_CHARGE"
  | "COUNTERPARTY_NOT_FOUND"
  | "COUNTERPARTY_NOT_VERIFIED"
  | "IDEMPOTENCY_CONFLICT";

const HTTP_STATUS: Record<TabErrorCode, number> = {
  INVALID_CHARGE_AMOUNT: 400,
  INVALID_CHARGE: 400,
  COUNTERPARTY_NOT_FOUND: 404,
  COUNTERPARTY_NOT_VERIFIED: 409,
  IDEMPOTENCY_CONFLICT: 409,
};

export class TabError extends Error {
  readonly code: TabErrorCode;
  readonly httpStatus: number;

  constructor(code: TabErrorCode, message: string) {
    super(message);
    this.name = "TabError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }
}

/** The same key was used for a different charge (ADR 0081). Carries no data about the stored charge. */
export class TabIdempotencyConflictError extends TabError {
  constructor() {
    super("IDEMPOTENCY_CONFLICT", "The idempotency key is already used for a different charge.");
    this.name = "TabIdempotencyConflictError";
  }
}
