import { describe, it, expect } from "vitest";
import { SPEND_COUNTING_ORDER_STATUSES, spendStatusesSql } from "../../src/orders/statuses.js";

describe("Order statuses that count toward the daily spend", () => {
  it("counts settlement_submitted, payment_hold, settling, reconciled, confirmed and submitted", () => {
    for (const status of ["settlement_submitted", "payment_hold", "settling", "reconciled", "confirmed", "submitted"]) {
      expect(SPEND_COUNTING_ORDER_STATUSES).toContain(status);
    }
  });

  it("spendStatusesSql returns single-quoted status names separated by commas and nothing else", () => {
    const sql = spendStatusesSql();
    expect(sql).toMatch(/^'[a-z_]+'(,'[a-z_]+')*$/);
    expect(sql.split(",")).toEqual(SPEND_COUNTING_ORDER_STATUSES.map((status) => `'${status}'`));
    expect(sql).toContain("'settlement_submitted'");
  });
});
