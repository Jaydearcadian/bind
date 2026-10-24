import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { TabLedger } from "../../src/tabs/ledger.js";
import { setEffectFault } from "../../src/effects/faults.js";
import { TabSpy, newCounterparty, newTabWorkspace, removeWorkspaces, settlementsOf, tabSums } from "../helpers/tab-spy.js";
import { ageEffect, drainHeldWorkspaces, heldUnknown } from "../helpers/tab-held.js";

/**
 * Restoring a held tab settlement (docs/decisions/0081, item a). cancel_and_restore cancels the settlement and writes exactly
 * one reversal, and only when the cancel is provably safe. Three proofs exist: (i) no effect row, so nothing was entered;
 * (ii) a stored hash whose confirmation reverted, with no settled transfer and an unsettled order; (iii) an unknown outcome
 * with no hash, an effect row at least 30 minutes old, an empty lookup, an unsettled order, and the owner's acknowledgement.
 * Every other case is refused with NOT_PROVABLY_UNSENT and changes nothing.
 */

const created: string[] = [];
const ACTOR = { type: "owner" as const, id: "owner:test" };
const CHARGE_MICRO = 50_000n;

afterAll(async () => {
  await closePool();
});

afterEach(async () => {
  setEffectFault(null);
  await removeWorkspaces([...created.splice(0), ...drainHeldWorkspaces()]);
});

async function reversalCount(workspaceId: string, settlementId: string): Promise<number> {
  return (
    await query(`SELECT COUNT(*)::int AS n FROM tab_entries WHERE workspace_id = $1 AND kind = 'reversal' AND settlement_id = $2;`, [
      workspaceId,
      settlementId,
    ])
  ).rows[0].n;
}

function refused(outcome: unknown): boolean {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    (outcome as { kind?: unknown }).kind === "refused" &&
    (outcome as { code?: unknown }).code === "NOT_PROVABLY_UNSENT" &&
    typeof (outcome as { reason?: unknown }).reason === "string"
  );
}

/** Asserts a refusal changed nothing: the settlement is still held with its clear, no reversal, no sent transfer added. */
async function expectUnchanged(ledger: TabLedger, w: string, cp: string, settlementId: string, movedBefore: number, callsBefore: number, spy: TabSpy) {
  const [row] = (await settlementsOf(w, cp)).filter((r) => r.id === settlementId);
  expect(row.status).toBe("held");
  expect(await reversalCount(w, settlementId)).toBe(0);
  expect(spy.moved.size).toBe(movedBefore);
  expect(spy.calls.length).toBe(callsBefore);
  expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
}

describe("restore refusals: a settlement is restored only when it is provably unsent (regression)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("(iii) an effect whose transfer the lookup can find is never cancelled, even with the acknowledgement", async () => {
    const { spy, ledger, w, cp, settlementId } = await heldUnknown({ fault: "after_call_before_complete", label: "r-found" });
    await ageEffect(w, settlementId, 60);
    const movedBefore = spy.moved.size;
    const callsBefore = spy.calls.length;
    expect(movedBefore).toBe(1);

    const outcome = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(refused(outcome)).toBe(true);
    await expectUnchanged(ledger, w, cp, settlementId, movedBefore, callsBefore, spy);
  });

  it("(iii) a lookup null is not enough when the order is settled on the contract", async () => {
    const spy = new TabSpy();
    spy.settledOverride = true;
    const { ledger, w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "r-settled", spy });
    await ageEffect(w, settlementId, 60);
    expect(spy.moved.size).toBe(0);

    const outcome = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(refused(outcome)).toBe(true);
    expect(spy.settledCalls).toContain(`tab_${settlementId}`);
    await expectUnchanged(ledger, w, cp, settlementId, 0, 0, spy);
  });

  it("(iii) a lookup that throws refuses, and the contract is not asked as a substitute", async () => {
    const spy = new TabSpy();
    spy.lookupDown = true;
    const { ledger, w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "r-lookup", spy });
    await ageEffect(w, settlementId, 60);

    const outcome = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(refused(outcome)).toBe(true);
    await expectUnchanged(ledger, w, cp, settlementId, 0, 0, spy);
  });

  it("(iii) an adapter without isOrderSettled refuses when an effect row exists", async () => {
    const spy = new TabSpy({ settledRead: "absent" });
    expect(spy.isOrderSettled).toBeUndefined();
    const { ledger, w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "r-absent", spy });
    await ageEffect(w, settlementId, 60);

    const outcome = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(refused(outcome)).toBe(true);
    await expectUnchanged(ledger, w, cp, settlementId, 0, 0, spy);
  });

  it("(iii) an effect row updated less than 30 minutes ago refuses, even with the acknowledgement", async () => {
    const { ledger, spy, w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "r-fresh" });
    await ageEffect(w, settlementId, 29);

    const outcome = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(refused(outcome)).toBe(true);
    await expectUnchanged(ledger, w, cp, settlementId, 0, 0, spy);
  });

  it("(iii) without acknowledgeNotSent the unknown outcome is refused, however old the effect row", async () => {
    const { ledger, spy, w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "r-noack" });
    await ageEffect(w, settlementId, 60);

    const outcome = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: false });
    expect(refused(outcome)).toBe(true);
    await expectUnchanged(ledger, w, cp, settlementId, 0, 0, spy);
  });

  it("(iii) an effect that already records a transaction hash is a known send, and is refused", async () => {
    const { ledger, spy, w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "r-known" });
    await ageEffect(w, settlementId, 60);
    await query(`UPDATE effects SET external_ref = $2 WHERE idempotency_key = $1;`, [`${w}:tab_settle:${settlementId}`, `0x${"ef".repeat(32)}`]);

    const outcome = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(refused(outcome)).toBe(true);
    await expectUnchanged(ledger, w, cp, settlementId, 0, 0, spy);
  });

  it("(ii) a stored hash that reverted is not restored when the order is settled on the contract", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await newTabWorkspace("r-ii-settled");
    created.push(w);
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: CHARGE_MICRO, idempotencyKey: "r-ii-s-c", description: "Dish" });
    spy.revertSendNext = true;
    const settled = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    if (settled.outcome !== "settlement") throw new Error("expected a settlement");
    expect(settled).toMatchObject({ status: "held", holdReason: "SETTLEMENT_FAILED" });
    spy.settledOverride = true;

    const outcome = await ledger.cancelHeldAndRestore(settled.settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(refused(outcome)).toBe(true);
    expect(await reversalCount(w, settled.settlementId)).toBe(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
  });

  it("(ii) a stored hash that failed with anything other than a revert is not restored", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await newTabWorkspace("r-ii-event");
    created.push(w);
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: CHARGE_MICRO, idempotencyKey: "r-ii-e-c", description: "Dish" });
    // The stored hash was sent but its confirmation found no SettlementExecuted event, and nothing moved (the send reverted
    // on chain without a revert reason the contract recognises). Not a REVERTED outcome, so it is not provably unsent.
    spy.revertSendNext = true;
    spy.confirmFailureCode = "EVENT_MISSING";
    const held = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    if (held.outcome !== "settlement") throw new Error("expected a settlement");
    expect(held).toMatchObject({ status: "held", holdReason: "SETTLEMENT_FAILED" });

    const outcome = await ledger.cancelHeldAndRestore(held.settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(refused(outcome)).toBe(true);
    expect(await reversalCount(w, held.settlementId)).toBe(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
  });

  it("(iii) a transfer that moved is never restored while its lookup is down, however old and acknowledged (regression)", async () => {
    const { spy, ledger, w, cp, settlementId } = await heldUnknown({ fault: "after_call_before_complete", label: "r-moved-down" });
    await ageEffect(w, settlementId, 240);
    spy.lookupDown = true;
    expect(spy.moved.size).toBe(1);

    const outcome = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(refused(outcome)).toBe(true);
    expect(await reversalCount(w, settlementId)).toBe(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
    expect(spy.moved.size).toBe(1);
  });

  it("(ii) a stored hash whose lookup finds a transfer, or throws, is refused", async () => {
    for (const mode of ["found", "throws"] as const) {
      const spy = new TabSpy();
      const ledger = new TabLedger({ settlementFor: () => spy });
      const w = await newTabWorkspace(`r-ii-${mode}`);
      created.push(w);
      const cp = await newCounterparty(w);
      await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: CHARGE_MICRO, idempotencyKey: `r-ii-${mode}-c`, description: "Dish" });
      spy.revertSendNext = true;
      const settled = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
      if (settled.outcome !== "settlement") throw new Error("expected a settlement");
      if (mode === "found") spy.adoptHash = `0x${"ad".repeat(32)}`;
      else spy.lookupDown = true;

      const outcome = await ledger.cancelHeldAndRestore(settled.settlementId, { actor: ACTOR, acknowledgeNotSent: true });
      expect(refused(outcome)).toBe(true);
      expect(await reversalCount(w, settled.settlementId)).toBe(0);
    }
  });

  it("a held settlement that owns no clear (a gate hold) has nothing to restore: no reversal is written", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await newTabWorkspace("r-noclear");
    created.push(w);
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: CHARGE_MICRO, idempotencyKey: "r-nc-c", description: "Dish" });
    await query(`UPDATE suppliers SET verified = FALSE WHERE workspace_id = $1 AND id = $2;`, [w, cp]);
    const held = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    if (held.outcome !== "settlement") throw new Error("expected a settlement");

    expect(await ledger.cancelHeldAndRestore(held.settlementId, { actor: ACTOR, acknowledgeNotSent: true })).toEqual({ kind: "no_clear" });
    expect(await reversalCount(w, held.settlementId)).toBe(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(CHARGE_MICRO);
  });

  it("a settlement that is not held (confirmed) is never restored", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await newTabWorkspace("r-confirmed");
    created.push(w);
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: CHARGE_MICRO, idempotencyKey: "r-cf-c", description: "Dish" });
    const done = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    if (done.outcome !== "settlement") throw new Error("expected a settlement");
    expect(done.status).toBe("confirmed");

    expect(await ledger.cancelHeldAndRestore(done.settlementId, { actor: ACTOR, acknowledgeNotSent: true })).toEqual({
      kind: "not_held",
      status: "confirmed",
    });
    expect(await reversalCount(w, done.settlementId)).toBe(0);
  });
});

describe("restore allowed cases: one reversal, the balance restored, and a later settle pays it once (regression)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("(i) no effect row: cancelled with one reversal, and the restored amount is paid once by a later settle", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await newTabWorkspace("a-i");
    created.push(w);
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: CHARGE_MICRO, idempotencyKey: "a-i-c", description: "Dish" });
    const reserved = await ledger.reserveSettlement({ workspaceId: w, counterpartyId: cp });
    if (reserved.kind !== "reserved") throw new Error("expected a reservation");
    // The state a process can leave only by hand: a pending settlement held, with no effect row ever entered.
    await query(`UPDATE tab_settlements SET status = 'held', hold_reason = 'SETTLEMENT_OUTCOME_UNKNOWN' WHERE id = $1;`, [
      reserved.settlement.settlementId,
    ]);

    const outcome = await ledger.cancelHeldAndRestore(reserved.settlement.settlementId, { actor: ACTOR, acknowledgeNotSent: false });
    expect(outcome).toMatchObject({ kind: "cancelled", proof: "NO_EFFECT_ROW", amountCents: 5n, replayed: false });
    expect(await reversalCount(w, reserved.settlement.settlementId)).toBe(1);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(CHARGE_MICRO);

    const paid = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    expect(paid).toMatchObject({ outcome: "settlement", status: "confirmed" });
    expect(spy.calls).toHaveLength(1);
    expect(spy.moved.size).toBe(1);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
    expect((await tabSums(w, cp)).reversals).toBe(CHARGE_MICRO);
  });

  it("(ii) a stored hash that reverted, nothing moved, order unsettled: restored, and the next settle pays it once", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await newTabWorkspace("a-ii");
    created.push(w);
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: CHARGE_MICRO, idempotencyKey: "a-ii-c", description: "Dish" });
    spy.revertSendNext = true;
    const first = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    if (first.outcome !== "settlement") throw new Error("expected a settlement");
    expect(first).toMatchObject({ status: "held", holdReason: "SETTLEMENT_FAILED", txHash: expect.any(String) });

    const outcome = await ledger.cancelHeldAndRestore(first.settlementId, { actor: ACTOR, acknowledgeNotSent: false });
    expect(outcome).toMatchObject({ kind: "cancelled", proof: "DEFINITIVE_REVERT", replayed: false });
    expect(await reversalCount(w, first.settlementId)).toBe(1);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(CHARGE_MICRO);
    // A cancelled settlement is closed: neither the worker's reconcile nor the executor can send for it.
    expect(await ledger.reconcileHeld(first.settlementId)).toEqual({ kind: "current", status: "cancelled" });
    expect(await ledger.executeSettlement(first.settlementId)).toEqual({ kind: "not_pending", status: "cancelled" });

    const paid = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    expect(paid).toMatchObject({ outcome: "settlement", status: "confirmed" });
    // The reverted transfer never moved money; the new settlement is the only transfer that did.
    expect(spy.moved.size).toBe(1);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
  });

  it("(iii) unknown outcome, effect at least 30 minutes old, empty lookup, unsettled order, acknowledged: restored once", async () => {
    const { ledger, spy, w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "a-iii" });
    await ageEffect(w, settlementId, 31);

    const outcome = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(outcome).toMatchObject({ kind: "cancelled", proof: "UNKNOWN_NOT_SETTLED_ACKNOWLEDGED", amountCents: 5n, replayed: false });
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(CHARGE_MICRO);

    const paid = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    expect(paid).toMatchObject({ outcome: "settlement", status: "confirmed" });
    expect(spy.calls).toHaveLength(1);
    expect(spy.moved.size).toBe(1);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
    expect(spy.duplicateCalls).toBe(0);
  });

  it("repeating the restore is a no-op that returns the stored result: still one reversal", async () => {
    const { ledger, w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "a-repeat" });
    await ageEffect(w, settlementId, 31);
    const first = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(first).toMatchObject({ kind: "cancelled", replayed: false });

    for (let i = 0; i < 3; i += 1) {
      const again = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true });
      expect(again).toMatchObject({ kind: "already_cancelled", replayed: true, proof: "UNKNOWN_NOT_SETTLED_ACKNOWLEDGED" });
    }
    expect(await reversalCount(w, settlementId)).toBe(1);
    expect((await tabSums(w, cp)).reversals).toBe(CHARGE_MICRO);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(CHARGE_MICRO);
  });

  it("two restores at once: exactly one cancels and writes the reversal; the other waits for nothing and changes nothing", async () => {
    const { ledger, w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "a-race" });
    await ageEffect(w, settlementId, 31);

    const results = await Promise.all([
      ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true }),
      ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true }),
    ]);
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds.filter((k) => k === "cancelled")).toHaveLength(1);
    for (const r of results) expect(["cancelled", "already_cancelled", "busy"]).toContain(r.kind);
    expect(await reversalCount(w, settlementId)).toBe(1);
    expect((await tabSums(w, cp)).reversals).toBe(CHARGE_MICRO);
  });
});
