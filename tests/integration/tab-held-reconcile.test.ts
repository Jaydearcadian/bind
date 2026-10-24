import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { TabLedger } from "../../src/tabs/ledger.js";
import { setEffectFault } from "../../src/effects/faults.js";
import { TabSpy, auditCount, newCounterparty, newTabWorkspace, removeWorkspaces, settlementsOf, tabSums } from "../helpers/tab-spy.js";
import { auditRowsWithHash, drainHeldWorkspaces, effectOf, heldUnknown, waitFor } from "../helpers/tab-held.js";

/**
 * Lost-hash adoption and the reconcile of held tab settlements (docs/decisions/0081, items a and b). A held settlement keeps
 * its clear. reconcileHeld adopts the transaction hash the ledger or the adapter can show, then confirms it. It never sends
 * and never reverses. Each test names the case it pins.
 */

const created: string[] = [];

afterAll(async () => {
  await closePool();
});

afterEach(async () => {
  setEffectFault(null);
  await removeWorkspaces([...created.splice(0), ...drainHeldWorkspaces()]);
});

async function ws(label: string): Promise<string> {
  const id = await newTabWorkspace(label);
  created.push(id);
  return id;
}

describe("a lost hash is adopted, not held (busy lock, regression)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("the original caller loses its record: the hash is kept, reconcile adopts it and confirms it once", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("busy-lock");
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 50_000n, idempotencyKey: "bl-1", description: "Dish" });
    const reserved = await ledger.reserveSettlement({ workspaceId: w, counterpartyId: cp });
    if (reserved.kind !== "reserved") throw new Error("expected a reservation");
    const settlementId = reserved.settlement.settlementId;

    // The winner holds its send open: its execution lock and its effect lock are both taken.
    let release!: () => void;
    spy.holdSendNext = new Promise<void>((resolve) => {
      release = resolve;
    });
    const winner = ledger.executeSettlement(settlementId);
    await waitFor(() => spy.calls.length === 1, "the winner's send");

    // A second caller reaches the effect ledger without the execution lock (as after its connection dropped). It waits
    // for the effect lock, then reports the row in doubt and holds the settlement UNKNOWN. It never sends.
    const loser = await (ledger as unknown as { executeLocked(id: string): Promise<unknown> }).executeLocked(settlementId);
    expect(loser).toEqual({ kind: "held", hold: "SETTLEMENT_OUTCOME_UNKNOWN" });

    release();
    // The winner's transfer moved money, but its record lost the race. It says so and does not throw.
    const winnerOutcome = await winner;
    expect(winnerOutcome).toEqual({ kind: "held", hold: "SETTLEMENT_OUTCOME_UNKNOWN" });
    const hash = [...spy.moved.values()][0].txHash;
    expect(spy.moved.size).toBe(1);

    const [row] = await settlementsOf(w, cp);
    expect(row.status).toBe("held");
    expect(row.tx_hash).toBeNull();
    // The hash is recoverable from two places: the effect row and an audit row that names it.
    expect((await effectOf(w, settlementId)).external_ref).toBe(hash);
    expect(await auditRowsWithHash(w, "tab.settlement_hash_unrecorded", hash)).toHaveLength(1);

    const outcome = await ledger.reconcileHeld(settlementId);
    expect(outcome).toMatchObject({ kind: "adopted", source: "effect", txHash: hash, status: "confirmed" });
    expect(spy.calls).toHaveLength(1);
    expect(spy.moved.size).toBe(1);
    // The adopted hash went through the adapter's confirm(): confirmed is only ever set from it (ADR 0079).
    expect(spy.confirmCalls).toContain(hash);
    const [done] = await settlementsOf(w, cp);
    expect(done.status).toBe("confirmed");
    expect(done.tx_hash).toBe(hash);
    expect(await auditCount(w, "tab.settlement_hash_adopted")).toBe(1);
    expect((await tabSums(w, cp)).reversals).toBe(0n);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);

    // Running it again after confirmation is a no-op.
    expect(await ledger.reconcileHeld(settlementId)).toEqual({ kind: "current", status: "confirmed" });
    expect(spy.calls).toHaveLength(1);
  }, 30_000);
});

describe("reconcile of a held settlement: where the hash comes from (regression)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("the effect row has no hash and the adapter's lookup finds the transfer: adopted by lookup, confirmed once", async () => {
    const { spy, ledger, w, cp, settlementId } = await heldUnknown({ fault: "after_call_before_complete", label: "lookup-adopt" });
    expect((await effectOf(w, settlementId)).external_ref).toBeNull();
    const hash = [...spy.moved.values()][0].txHash;

    const outcome = await ledger.reconcileHeld(settlementId);
    expect(outcome).toMatchObject({ kind: "adopted", source: "lookup", txHash: hash, status: "confirmed" });
    expect(spy.calls).toHaveLength(1);
    expect(spy.duplicateCalls).toBe(0);
    const [row] = await settlementsOf(w, cp);
    expect(row).toMatchObject({ status: "confirmed", tx_hash: hash });
    expect(await auditRowsWithHash(w, "tab.settlement_hash_adopted", hash)).toHaveLength(1);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
  });

  it("the lookup throws: the settlement stays held and nothing changes (fail closed)", async () => {
    const { spy, ledger, w, cp, settlementId } = await heldUnknown({ fault: "after_call_before_complete", label: "lookup-down" });
    const before = await settlementsOf(w, cp);
    spy.lookupDown = true;

    const outcome = await ledger.reconcileHeld(settlementId);
    expect(outcome).toEqual({ kind: "lookup_unavailable", holdReason: "SETTLEMENT_OUTCOME_UNKNOWN" });
    expect(await settlementsOf(w, cp)).toEqual(before);
    expect(spy.calls).toHaveLength(1);
    expect(await auditCount(w, "tab.settlement_hash_adopted")).toBe(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
  });

  it("the lookup answers null and the effect has no hash: nothing found, still held, nothing sent", async () => {
    // The transfer never moved (the fault fires before the call), so the lookup is honestly empty.
    const { spy, ledger, w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "nothing" });
    expect(spy.moved.size).toBe(0);

    const outcome = await ledger.reconcileHeld(settlementId);
    expect(outcome).toEqual({ kind: "nothing_found", holdReason: "SETTLEMENT_OUTCOME_UNKNOWN" });
    const after = await settlementsOf(w, cp);
    expect(after[0]).toMatchObject({ status: "held", tx_hash: null, hold_reason: "SETTLEMENT_OUTCOME_UNKNOWN" });
    expect(spy.calls).toHaveLength(0);
    expect(spy.moved.size).toBe(0);
  });

  it("a settlement that owns no clear (a gate hold) is never adopted or touched", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("no-clear");
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 50_000n, idempotencyKey: "nc-1", description: "Dish" });
    // Unverified after the charge: the gate holds the settlement, and the hold owns no clear.
    await query(`UPDATE suppliers SET verified = FALSE WHERE workspace_id = $1 AND id = $2;`, [w, cp]);
    const held = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    if (held.outcome !== "settlement") throw new Error("expected a held settlement");
    expect(await ledger.reconcileHeld(held.settlementId)).toEqual({ kind: "no_clear" });
    expect(spy.calls).toHaveLength(0);
  });

  it("a hold with a hash and an effect hash that disagree is refused with a conflict, not guessed", async () => {
    const { spy, ledger, w, settlementId } = await heldUnknown({ fault: "after_call_before_complete", label: "conflict" });
    await query(`UPDATE effects SET external_ref = $2 WHERE idempotency_key = $1;`, [
      `${w}:tab_settle:${settlementId}`,
      `0x${"ab".repeat(32)}`,
    ]);
    await query(`UPDATE tab_settlements SET tx_hash = $2 WHERE id = $1;`, [settlementId, `0x${"cd".repeat(32)}`]);
    const outcome = await ledger.reconcileHeld(settlementId);
    expect(outcome).toEqual({ kind: "hash_conflict", holdReason: "SETTLEMENT_OUTCOME_UNKNOWN" });
    expect(spy.calls).toHaveLength(1);
  });
});
