import { describe, it, expect } from "vitest";
import { classifyOperation, EffectClass } from "../../src/policy/effect-classifier.js";

/**
 * The classifier fails closed. Only the operations declared in the map classify. Property names that every
 * object inherits (constructor, toString, __proto__ and the rest) must throw, not return an inherited value.
 */
describe("effect classifier fails closed", () => {
  it("rejects prototype property names", () => {
    const names = ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf", "__defineGetter__"];
    for (const name of names) {
      expect(() => classifyOperation(name), name).toThrow(/Unrecognized operation/);
    }
  });

  it("still classifies every declared operation", () => {
    const declared: Record<string, EffectClass> = {
      "inventory.read_stock": EffectClass.READ,
      "suppliers.list": EffectClass.READ,
      "quotes.view": EffectClass.READ,
      "orders.get_status": EffectClass.READ,
      "audit.query": EffectClass.READ,
      "treasury.get_balance": EffectClass.READ,
      "workflows.get_state": EffectClass.READ,
      "suppliers.request_quote": EffectClass.EXTERNAL_REQUEST,
      "notifications.send_summary": EffectClass.EXTERNAL_REQUEST,
      "notifications.send_approval_request": EffectClass.EXTERNAL_REQUEST,
      "webhooks.ping": EffectClass.EXTERNAL_REQUEST,
      "suppliers.inquire_availability": EffectClass.EXTERNAL_REQUEST,
      "client.send_invoice_draft": EffectClass.EXTERNAL_REQUEST,
      "orders.submit": EffectClass.COMMERCIAL_COMMITMENT,
      "quotes.accept": EffectClass.COMMERCIAL_COMMITMENT,
      "settlement.transfer_usdc": EffectClass.COMMERCIAL_COMMITMENT,
      "escrow.deposit": EffectClass.COMMERCIAL_COMMITMENT,
      "escrow.release_milestone": EffectClass.COMMERCIAL_COMMITMENT,
      "contractors.payout": EffectClass.COMMERCIAL_COMMITMENT,
      "invoices.issue_and_settle": EffectClass.COMMERCIAL_COMMITMENT,
    };
    for (const [name, expected] of Object.entries(declared)) {
      expect(classifyOperation(name), name).toBe(expected);
    }
  });

  it("rejects an empty string", () => {
    expect(() => classifyOperation("")).toThrow(/Unrecognized operation/);
  });
});
