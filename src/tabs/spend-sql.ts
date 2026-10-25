import { UTC_DAY_START_SQL } from "../utils/utc-day.js";

/**
 * SQL for the tab settlements that count toward a workspace's daily budget (ADR 0081): those that own a clear (pending,
 * submitted, confirmed or held) and are not cancelled. A gate hold has no clear and counts for nothing. The tab reserve and
 * the order commitment gate both use this one fragment, so each side counts the other's same-day spend. Uses $1 as the
 * workspace id; it is constant text, safe to inline.
 */
export const TAB_SPEND_TODAY_CENTS_SQL = `COALESCE((
  SELECT SUM(t.amount_cents) FROM tab_settlements t
  WHERE t.workspace_id = $1
    AND t.created_at >= ${UTC_DAY_START_SQL}
    AND t.status IN ('pending', 'submitted', 'confirmed', 'held')
    AND EXISTS (SELECT 1 FROM tab_entries e WHERE e.settlement_id = t.id AND e.kind = 'clear')
), 0)`;
