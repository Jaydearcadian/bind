import { describe, it, expect } from "vitest";
import { restoreAnswer } from "../../src/tabs/held-responses.js";
import type { RestoreOutcome } from "../../src/tabs/ledger.js";

/** Every restore outcome has one HTTP answer. A row that changed between the proof and the write is 409 SETTLEMENT_BUSY. */
describe("restore outcomes map to HTTP answers (ADR 0081)", () => {
  it("a restore that changed the row between proof and write is a 409 SETTLEMENT_BUSY, not a server error", () => {
    const answer = restoreAnswer({ kind: "changed" });
    expect(answer.status).toBe(409);
    expect(answer.body.code).toBe("SETTLEMENT_BUSY");
    expect(String(answer.body.error)).toContain("Nothing was changed");
  });

  it("a cancelled restore is 200 with the proof and the amount as a string; a repeat is replayed", () => {
    expect(restoreAnswer({ kind: "cancelled", proof: "DEFINITIVE_REVERT", amountCents: 5n, replayed: false })).toEqual({
      status: 200,
      body: { action: "cancel_and_restore", outcome: { kind: "cancelled", proof: "DEFINITIVE_REVERT", amountCents: "5", replayed: false } },
    });
    expect(restoreAnswer({ kind: "already_cancelled", proof: "NO_EFFECT_ROW", amountCents: 5n, replayed: true }).status).toBe(200);
  });

  it("a refusal is 409 NOT_PROVABLY_UNSENT with its reason", () => {
    const outcome: RestoreOutcome = { kind: "refused", code: "NOT_PROVABLY_UNSENT", reason: "the owner has not acknowledged" };
    const answer = restoreAnswer(outcome);
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ code: "NOT_PROVABLY_UNSENT", reason: "the owner has not acknowledged" });
  });

  it("the other outcomes keep their codes: busy, not held, no balance, not found", () => {
    expect(restoreAnswer({ kind: "busy" }).body.code).toBe("SETTLEMENT_BUSY");
    expect(restoreAnswer({ kind: "not_held", status: "confirmed" })).toMatchObject({ status: 409, body: { code: "SETTLEMENT_NOT_HELD", status: "confirmed" } });
    expect(restoreAnswer({ kind: "no_clear" }).body.code).toBe("SETTLEMENT_OWNS_NO_BALANCE");
    expect(restoreAnswer({ kind: "not_found" })).toMatchObject({ status: 404, body: { code: "SETTLEMENT_NOT_FOUND" } });
  });
});
