import { createHash } from "node:crypto";
import { getAddress, isAddress } from "viem";

function md5Hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

/**
 * Deterministic payee address for a simulated id (a simulated supplier id, or
 * "workspace:<id>" for a local workspace wallet). It is not a real wallet and is
 * never funded by anyone. The SQL backfill in src/db/schema.sql uses the same
 * algorithm; tests/integration/payee-from-record.test.ts pins the two together.
 */
export function simulatedPaymentAddress(supplierId: string): string {
  return "0x" + (md5Hex(supplierId) + md5Hex(supplierId + "x")).slice(0, 40);
}

/**
 * Accepts a 0x EVM address in any letter case and returns the checksummed form.
 * Anything else (including non-strings) is rejected with null.
 */
export function normalizePaymentAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (!isAddress(raw, { strict: false })) return null;
  return getAddress(raw);
}
