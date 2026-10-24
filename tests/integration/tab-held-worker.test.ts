import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { runTabSettlementStep } from "../../src/tabs/worker.js";
import { runTick } from "../../src/workers/runner.js";
import { TabLedger, type TabLedger as TabLedgerType } from "../../src/tabs/ledger.js";
import { setEffectFault } from "../../src/effects/faults.js";
import { TabSpy, newCounterparty, newTabWorkspace, removeWorkspaces, settlementsOf, tabSums } from "../helpers/tab-spy.js";
import { ageEffect, drainHeldWorkspaces, heldUnknown } from "../helpers/tab-held.js";

/**
 * The worker's held-settlement step (docs/decisions/0081, item a). It adopts a hash it can show and confirms it, once. It
 * never cancels and never reverses, whatever the lookup answers. A paused workspace is reconciled but never paid.
 */

const created: string[] = [];

afterAll(async () => {
  await closePool();
});

afterEach(async () => {
  setEffectFault(null);
  await removeWorkspaces([...created.splice(0), ...drainHeldWorkspaces()]);
});

/** Ticks now: nothing is stale, every held row is due, and the batch is large. The end-of-day batch is off. */
function due(ledger: TabLedgerType, extra: { reconcileAfterMs?: number; reconcileBatchSize?: number } = {}) {
  return {
    staleAfterMs: 0,
    confirmAfterMs: 0,
    batchSize: 50,
    now: new Date(),
    endOfDay: false,
    settleOnThreshold: false,
    reconcileAfterMs: extra.reconcileAfterMs ?? 0,
    // Large, so this test's rows are never crowded out by held rows left in the shared database by other tests.
    reconcileBatchSize: extra.reconcileBatchSize ?? 1000,
    ledger,
  };
}

async function reversalsIn(workspaceId: string): Promise<number> {
  return (await query(`SELECT COUNT(*)::int AS n FROM tab_entries WHERE workspace_id = $1 AND kind = 'reversal';`, [workspaceId])).rows[0].n;
}

describe("the worker adopts a lost hash on its own, and never cancels (regression)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("a held settlement whose transfer moved is adopted and confirmed by the worker, once, with no operator", async () => {
    const { spy, ledger, w, cp, settlementId } = await heldUnknown({ fault: "after_call_before_complete", label: "w-adopt" });
    const hash = [...spy.moved.values()][0].txHash;

    const counts = await runTabSettlementStep(due(ledger));
    expect(counts).toMatchObject({ reconciled: 1, confirmed: 1, cancelled: 0, failed: 0 });
    expect(spy.calls).toHaveLength(1);
    const [row] = await settlementsOf(w, cp);
    expect(row).toMatchObject({ id: settlementId, status: "confirmed", tx_hash: hash });

    // A second tick finds nothing to do.
    const again = await runTabSettlementStep(due(ledger));
    expect(again).toMatchObject({ reconciled: 0, confirmed: 0 });
    expect(spy.calls).toHaveLength(1);
    expect((await tabSums(w, cp)).reversals).toBe(0n);
  });

  it("a held settlement the lookup cannot resolve is never cancelled, however many ticks run", async () => {
    const { ledger, w, cp, settlementId } = await heldUnknown({ fault: "before_call", label: "w-never" });
    // The effect row is well past the 30 minute window: an operator could restore it, the worker must not.
    await ageEffect(w, settlementId, 240);
    for (let tick = 0; tick < 4; tick += 1) {
      const counts = await runTabSettlementStep(due(ledger));
      expect(counts).toMatchObject({ cancelled: 0, failed: 0, reconciled: 0 });
    }
    const [row] = await settlementsOf(w, cp);
    expect(row.status).toBe("held");
    expect(await reversalsIn(w)).toBe(0);
    expect((await tabSums(w, cp)).reversals).toBe(0n);
  });

  it("the backoff: an unresolved hold is touched and not looked at again until its interval has passed", async () => {
    const { ledger, settlementId } = await heldUnknown({ fault: "before_call", label: "w-backoff" });
    const updatedAt = async () => (await query(`SELECT updated_at FROM tab_settlements WHERE id = $1;`, [settlementId])).rows[0].updated_at;

    await runTabSettlementStep(due(ledger));
    const touched = await updatedAt();
    // With a one hour backoff, the row was touched a moment ago and is not due: the next tick leaves it alone.
    await runTabSettlementStep(due(ledger, { reconcileAfterMs: 60 * 60 * 1000 }));
    expect((await updatedAt()).getTime()).toBe(touched.getTime());
  });

  it("one settlement whose reconcile throws does not stop the others in the batch", async () => {
    const spy = new TabSpy();
    const real = new TabLedger({ settlementFor: () => spy });
    const w = await newTabWorkspace("w-isolate");
    created.push(w);
    const cpA = await newCounterparty(w);
    const cpB = await newCounterparty(w);
    await real.accrueCharge({ workspaceId: w, counterpartyId: cpA, amountMicro: 30_000n, idempotencyKey: "w-iso-a", description: "Dish" });
    await real.accrueCharge({ workspaceId: w, counterpartyId: cpB, amountMicro: 30_000n, idempotencyKey: "w-iso-b", description: "Dish" });
    const a = await real.reserveSettlement({ workspaceId: w, counterpartyId: cpA });
    const b = await real.reserveSettlement({ workspaceId: w, counterpartyId: cpB });
    if (a.kind !== "reserved" || b.kind !== "reserved") throw new Error("expected two reservations");
    // Both transfers moved; both results are lost; both settlements end held UNKNOWN.
    setEffectFault({ point: "after_call_before_complete", match: (spec) => spec.workspaceId === w });
    await real.executeSettlement(a.settlement.settlementId).catch(() => undefined);
    await real.executeSettlement(b.settlement.settlementId).catch(() => undefined);
    setEffectFault(null);
    await query(`UPDATE tab_settlements SET status = 'held', hold_reason = 'SETTLEMENT_OUTCOME_UNKNOWN' WHERE id = ANY($1::text[]);`, [
      [a.settlement.settlementId, b.settlement.settlementId],
    ]);

    // The first settlement's reconcile throws; the second must still be adopted and confirmed.
    // A pass-through of the real ledger whose reconcile throws for one settlement only.
    const failingFirst = new Proxy(real, {
      get(target, prop) {
        if (prop === "reconcileHeld") {
          return (id: string) => {
            if (id === a.settlement.settlementId) throw new Error("reconcile boom");
            return target.reconcileHeld(id);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as TabLedgerType;
    const counts = await runTabSettlementStep(due(failingFirst));
    expect(counts.failed).toBe(1);
    expect(counts.errors).toEqual(["reconcile boom"]);
    expect(counts.reconciled).toBe(1);
    const [rowA, rowB] = await Promise.all([settlementsOf(w, cpA), settlementsOf(w, cpB)]);
    expect(rowA[0].status).toBe("held");
    expect(rowB[0].status).toBe("confirmed");
  });

  it("a paused workspace is reconciled and confirmed, but nothing is paid: the transfer count does not move", async () => {
    const { spy, ledger, w, settlementId } = await heldUnknown({ fault: "after_call_before_complete", label: "w-paused" });
    await query(`UPDATE workspaces SET agents_paused = TRUE WHERE id = $1;`, [w]);
    const callsBefore = spy.calls.length;

    const counts = await runTabSettlementStep(due(ledger));
    expect(counts).toMatchObject({ reconciled: 1, confirmed: 1 });
    expect(spy.calls).toHaveLength(callsBefore);
    expect(spy.moved.size).toBe(1);
    expect((await query(`SELECT status FROM tab_settlements WHERE id = $1;`, [settlementId])).rows[0].status).toBe("confirmed");
  });

  it("a settlement held after a reverted confirmation is asked again, stays held, and is never cancelled", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await newTabWorkspace("w-reverted");
    created.push(w);
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 40_000n, idempotencyKey: "w-rv-c", description: "Dish" });
    spy.confirmMode = "failed";
    const first = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    expect(first).toMatchObject({ outcome: "settlement", status: "held", holdReason: "SETTLEMENT_FAILED" });

    const counts = await runTabSettlementStep(due(ledger));
    expect(counts).toMatchObject({ reconciled: 1, confirmed: 0, held: 1, cancelled: 0 });
    expect(spy.confirmCalls.length).toBeGreaterThanOrEqual(2);
    expect(spy.calls).toHaveLength(1);
    expect(await reversalsIn(w)).toBe(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
  });

  it("the runner reports the step's adoptions in its tick report", async () => {
    const { spy, ledger, settlementId } = await heldUnknown({ fault: "after_call_before_complete", label: "w-tick" });
    const report = await runTick({
      stuckSettlingAfterMs: 0,
      confirmAfterMs: 0,
      tabs: { ledger, endOfDay: false, reconcileAfterMs: 0, reconcileBatchSize: 1000 },
    });
    expect(report.tabSettlements.reconciled).toBeGreaterThanOrEqual(1);
    expect(report.errors.filter((e) => e.step === "tab_settlements")).toEqual([]);
    expect(spy.moved.size).toBe(1);
    expect((await query(`SELECT status FROM tab_settlements WHERE id = $1;`, [settlementId])).rows[0].status).toBe("confirmed");
  });
});

async function attemptsOf(settlementId: string): Promise<number> {
  return (await query(`SELECT reconcile_attempts FROM tab_settlements WHERE id = $1;`, [settlementId])).rows[0].reconcile_attempts;
}

/** Audit rows about one settlement that a reopen or a re-hold writes. */
async function reopenAuditRows(workspaceId: string, settlementId: string): Promise<number> {
  return (
    await query(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action IN ('tab.settlement_reopened', 'tab.settlement_held')
         AND evidence->>'settlementId' = $2;`,
      [workspaceId, settlementId]
    )
  ).rows[0].n;
}

/**
 * The database clock is real and the worker's `now` is simulated, so the test puts the row's last change where the simulated
 * clock says it was. The worker's own touch (NOW()) is replaced by the simulated time after each attempt.
 */
async function setUpdatedAt(settlementId: string, at: Date): Promise<void> {
  await query(`UPDATE tab_settlements SET updated_at = $2 WHERE id = $1;`, [settlementId, at]);
}

function simulatedTick(ledger: TabLedgerType, now: Date) {
  return runTabSettlementStep({
    staleAfterMs: 0,
    confirmAfterMs: 0,
    batchSize: 50,
    now,
    endOfDay: false,
    settleOnThreshold: false,
    reconcileAfterMs: 5 * 60 * 1000,
    reconcileBatchSize: 1000,
    ledger,
  });
}

describe("the held backoff: a failed hold is attempted on a schedule, and its audit is bounded (regression)", () => {
  it("a SETTLEMENT_FAILED hold that never resolves is attempted at 5m, 15m, 1h, 6h, then daily, not every tick", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await newTabWorkspace("w-backoff-failed");
    created.push(w);
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 40_000n, idempotencyKey: "w-bf-c", description: "Dish" });
    // The send reverted with nothing moved, and its confirmation never finds the event: held FAILED, and it stays so.
    spy.revertSendNext = true;
    spy.confirmFailureCode = "EVENT_MISSING";
    const held = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    if (held.outcome !== "settlement") throw new Error("expected a held settlement");
    const id = held.settlementId;

    const t0 = Date.now();
    await setUpdatedAt(id, new Date(t0));
    const confirmsBefore = spy.confirmCalls.length;
    const auditBefore = await reopenAuditRows(w, id);
    const attemptsAt: number[] = [];
    // Ten-minute ticks over three simulated days: 432 ticks.
    for (let minute = 10; minute <= 3 * 24 * 60; minute += 10) {
      const sim = new Date(t0 + minute * 60_000);
      const before = await attemptsOf(id);
      await simulatedTick(ledger, sim);
      if ((await attemptsOf(id)) > before) {
        attemptsAt.push(minute);
        await setUpdatedAt(id, sim);
      }
    }

    // Each step is the last times three, twelve, seventy-two and two hundred eighty-eight: 5m, 15m, 1h, 6h, then a day.
    expect(attemptsAt).toEqual([10, 30, 90, 450, 1890, 3330]);
    expect(spy.confirmCalls.length - confirmsBefore).toBe(attemptsAt.length);
    // One reopen and one re-hold audit per attempt, so the audit grows with the steps, not with the ticks.
    expect((await reopenAuditRows(w, id)) - auditBefore).toBe(2 * attemptsAt.length);
    expect(spy.calls).toHaveLength(1);
    const [row] = await settlementsOf(w, cp);
    expect(row).toMatchObject({ status: "held", hold_reason: "SETTLEMENT_FAILED" });
    expect((await tabSums(w, cp)).reversals).toBe(0n);
  }, 180_000);

  it("an UNKNOWN hold keeps the base cadence: it is looked at again every base step", async () => {
    const { ledger, settlementId } = await heldUnknown({ fault: "before_call", label: "w-unknown-cadence" });
    const t0 = Date.now();
    await setUpdatedAt(settlementId, new Date(t0));
    const attemptsAt: number[] = [];
    for (const minute of [10, 20, 30]) {
      const sim = new Date(t0 + minute * 60_000);
      const before = await attemptsOf(settlementId);
      await simulatedTick(ledger, sim);
      if ((await attemptsOf(settlementId)) > before) {
        attemptsAt.push(minute);
        await setUpdatedAt(settlementId, sim);
      }
    }
    expect(attemptsAt).toEqual([10, 20, 30]);
  });
});
