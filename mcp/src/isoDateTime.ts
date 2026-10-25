/**
 * The ISO 8601 date-time with an offset that the MCP tools accept. This is the same expression as src/api/isoDateTime.ts (the
 * HTTP API's rule, zod 3's semantics). The MCP source may not import server code, so the expression is written out here, and
 * tests/unit/mcp.test.ts checks that the two sources are identical.
 */
const DATE_SOURCE =
  "((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29" +
  "|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))";
const TIME_SOURCE = "([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?";
const ZONE_SOURCE = "(Z|[+-]\\d{2}:?\\d{2})";

export const ISO_DATE_TIME_WITH_OFFSET = new RegExp(`^${DATE_SOURCE}T${TIME_SOURCE}${ZONE_SOURCE}$`);
