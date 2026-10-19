import { describe, it, expect } from "vitest";
import { orderNumberFor } from "../../src/orders/reservation.js";

describe("orderNumberFor", () => {
  it("is stable for an order id", () => {
    expect(orderNumberFor("ord_wf_proc_1700000000000_abcde")).toBe(orderNumberFor("ord_wf_proc_1700000000000_abcde"));
  });

  it("differs for different order ids", () => {
    expect(orderNumberFor("ord_wf_proc_1700000000000_abcde")).not.toBe(orderNumberFor("ord_wf_proc_1700000000000_fghij"));
  });

  it("matches /^PO-[0-9A-F]{8}$/", () => {
    expect(orderNumberFor("ord_wf_proc_1700000000000_abcde")).toMatch(/^PO-[0-9A-F]{8}$/);
  });
});
