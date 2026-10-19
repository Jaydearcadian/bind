/**
 * Order statuses that count toward the workspace daily spend limit. An order counts from the moment
 * its payment is committed, not only once it is confirmed: `settlement_submitted` (a transfer was
 * sent but its outcome is not yet confirmed) and `payment_hold` (a held or failed payment attempt)
 * both still hold budget.
 */
export const SPEND_COUNTING_ORDER_STATUSES = [
  "submitted",
  "confirmed",
  "settling",
  "payment_hold",
  "settlement_submitted",
  "reconciled",
] as const;

/**
 * The statuses as an SQL list for an `IN (...)` clause: each name single-quoted, comma-separated, in the
 * order of the constant. The values are the constants above, never request input, so the list is safe to inline.
 */
export function spendStatusesSql(): string {
  return SPEND_COUNTING_ORDER_STATUSES.map((status) => `'${status}'`).join(",");
}
