/**
 * The budget day is the UTC day, everywhere. A session's CURRENT_DATE follows the database session's time zone, so a
 * change of zone would move a day's spend between days. These are the one definition used by the commitment gate and by
 * the tab ledger (docs/decisions/0081).
 */

/** SQL: the instant the current UTC day began, as timestamptz. Constant text only, so it is safe to inline in a query. */
export const UTC_DAY_START_SQL = "(date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')";

/** Start of the UTC day that holds `now`. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** The UTC calendar day of `now` as YYYY-MM-DD. */
export function utcDayKey(now: Date): string {
  return utcDayStart(now).toISOString().slice(0, 10);
}
