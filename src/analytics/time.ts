/**
 * Time helpers for analytics (docs/decisions/0090). Report periods are whole UTC days, stored as DATE. The hour of a post is
 * read in the account's time zone through Intl, so daylight saving changes are the runtime's rule, not ours.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
/** A report period may span at most this many days. */
export const MAX_PERIOD_DAYS = 92;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` string as the UTC midnight it names, or null when it is not a real calendar day. */
export function parseDay(value: unknown): Date | null {
  if (typeof value !== "string" || !DAY_PATTERN.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10) === value ? date : null;
}

/** The `YYYY-MM-DD` of a UTC midnight. */
export function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The UTC midnight at or before the instant. */
export function startOfUtcDay(instant: Date): Date {
  return new Date(Math.floor(instant.getTime() / DAY_MS) * DAY_MS);
}

/** The UTC midnight of the Monday that starts the ISO week containing the instant. */
export function startOfIsoWeek(instant: Date): Date {
  const day = startOfUtcDay(instant);
  const weekday = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - weekday * DAY_MS);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Whether the name is an IANA time zone this runtime knows. */
export function isValidTimeZone(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * The hour of the day (0 to 23) of an instant in a time zone. `h23` is used because some runtimes print midnight as 24 under
 * `hour12: false`. A wall-clock hour that repeats or is skipped at a daylight saving change maps to the hour the zone shows.
 */
export function hourInZone(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).formatToParts(instant);
  const hour = parts.find((part) => part.type === "hour");
  if (!hour) throw new RangeError(`No hour for time zone ${timeZone}`);
  return Number(hour.value);
}

/** A day as the owner reads it in a time zone, for example "12 Mar 2026". */
export function readableDay(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(instant);
}
