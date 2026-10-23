import { encodePacked, keccak256 } from "viem";
import { TabError } from "./errors.js";

/**
 * Units of the tab ledger (docs/decisions/0081). A charge is an integer number of micro-USDC (1e-6 USDC, bigint). The
 * settlement adapters and every existing type stay in whole cents (docs/decisions/0078), so the tab layer converts:
 * a settlement is always a whole number of cents, the floor of the tab balance, and no sub-cent amount is ever sent.
 *
 * Everything here is pure: no I/O, no clock, no database.
 */

/** Micro-USDC in one cent: 1 USDC = 1_000_000 micro, 1 cent = 0.01 USDC. */
export const MICRO_PER_CENT = 10_000n;

/** The largest single charge: 100 USDC. A larger obligation is recorded as several charges, each reviewable. */
export const MAX_CHARGE_MICRO = 100_000_000n;

/** The longest description a charge or a ledger entry may carry. */
export const DESCRIPTION_MAX_LENGTH = 200;

/** Client idempotency keys: 1 to 128 characters of letters, digits, '_', '.', ':' and '-'. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Counterparty ids are supplier ids: the same shape the suppliers table allows (VARCHAR(64)). */
export const COUNTERPARTY_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A decimal string of micro-USDC with no sign, no leading zero, no fraction and no exponent. */
const DECIMAL_MICRO_PATTERN = /^(0|[1-9][0-9]{0,19})$/;

/**
 * Parses an amount of micro-USDC as the API sends it: a decimal string, never a JSON number (a JS number cannot carry
 * every integer and invites rounding). Rejects a non-string, a fraction, a sign, an exponent, zero, and any amount over
 * MAX_CHARGE_MICRO. Every refusal is INVALID_CHARGE_AMOUNT; the message never echoes the input.
 */
export function parseChargeAmountMicro(value: unknown): bigint {
  if (typeof value !== "string" || !DECIMAL_MICRO_PATTERN.test(value)) {
    throw invalidAmount("amountMicro must be a decimal string of whole micro-USDC");
  }
  const amount = BigInt(value);
  if (amount <= 0n) throw invalidAmount("amountMicro must be greater than zero");
  if (amount > MAX_CHARGE_MICRO) throw invalidAmount("amountMicro is above the 100 USDC limit for one charge");
  return amount;
}

/** Checks a bigint that is already typed (service callers). The same rules as parseChargeAmountMicro. */
export function assertChargeAmountMicro(value: unknown): asserts value is bigint {
  if (typeof value !== "bigint") throw invalidAmount("amountMicro must be a bigint of whole micro-USDC");
  if (value <= 0n) throw invalidAmount("amountMicro must be greater than zero");
  if (value > MAX_CHARGE_MICRO) throw invalidAmount("amountMicro is above the 100 USDC limit for one charge");
}

function invalidAmount(message: string): TabError {
  return new TabError("INVALID_CHARGE_AMOUNT", message);
}

/**
 * The whole cents a balance can settle now: floor(balance / 10_000). A balance under one cent settles nothing and carries
 * over. A negative balance cannot come from the ledger (every clear and reversal is matched), so it is reported as an error.
 */
export function settleableCents(balanceMicro: bigint): bigint {
  if (balanceMicro < 0n) throw new Error("A tab balance is negative; the ledger is inconsistent");
  return balanceMicro / MICRO_PER_CENT;
}

/** The micro-USDC a whole number of cents occupies in the ledger. Only positive whole cents convert. */
export function centsToMicro(cents: bigint): bigint {
  if (cents <= 0n) throw new TypeError("Only a positive whole number of cents converts to micro-USDC");
  return cents * MICRO_PER_CENT;
}

/**
 * The match hash for a tab settlement. It binds the transfer to this settlement and is deterministic, so a retry carries
 * the same hash. The 'tab' tag keeps it apart from an order's match hash, which covers order, receipt and bill.
 */
export function tabMatchHash(settlementId: string): `0x${string}` {
  return keccak256(encodePacked(["string", "string"], [settlementId, "tab"]));
}

/**
 * The order id the settlement adapter sees for a tab settlement. The `tab_` prefix keeps it from ever equal to an order
 * id, so an adapter's per-order lookup (findTransfer) cannot confuse a tab payment with an order payment.
 */
export function tabAdapterOrderId(settlementId: string): string {
  return `tab_${settlementId}`;
}

/** Ledger keys, namespaced so the three kinds of entry cannot collide with each other or with a client key. */
export const ledgerKeys = {
  charge: (clientKey: string) => `charge:${clientKey}`,
  clear: (settlementId: string) => `clear:${settlementId}`,
  reversal: (settlementId: string) => `reversal:${settlementId}`,
  /** The effects-ledger key for the transfer of one tab settlement (ADR 0019 pattern, tab-specific). */
  effect: (workspaceId: string, settlementId: string) => `${workspaceId}:tab_settle:${settlementId}`,
  /** The adapter's own transfer idempotency key. */
  adapterIdempotency: (settlementId: string) => `idem_pay_tab_${settlementId}`,
};
