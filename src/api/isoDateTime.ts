import { z } from "zod";

/**
 * The ISO 8601 date-time with an offset that the API accepts. It is zod 3's rule, written out so that moving to zod 4 keeps
 * every accepted and refused value. zod 4's own datetime check refuses a time with no seconds ("2026-01-01T10:00Z") and an
 * offset with no colon ("+0530"), which zod 3 accepted. The date must exist (a leap day only in a leap year). The seconds are
 * optional, a fraction needs seconds, and the zone is Z or a +hh:mm / +hhmm / +hh offset (the colon is optional in the zone).
 */
const DATE_SOURCE =
  "((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29" +
  "|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))";
const TIME_SOURCE = "([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?";
const ZONE_SOURCE = "(Z|[+-]\\d{2}:?\\d{2})";

/** The pattern itself. Exported so the OpenAPI document can name its format (date-time), not this long expression. */
export const ISO_DATE_TIME_WITH_OFFSET = new RegExp(`^${DATE_SOURCE}T${TIME_SOURCE}${ZONE_SOURCE}$`);

/** A string that must be an ISO 8601 date-time with an offset. `message` is the text for a refused value. */
export function isoDateTimeWithOffset(message?: string): z.ZodString {
  return z.string().regex(ISO_DATE_TIME_WITH_OFFSET, message).meta({ format: "date-time" });
}
