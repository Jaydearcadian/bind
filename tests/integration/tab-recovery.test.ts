import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { runTick } from "../../src/workers/runner.js";
import { runTabSettlementStep } from "../../src/tabs/worker.js";
import { TabLedger } from "../../src/tabs/ledger.js";
import { setEffectFault } from "../../src/effects/faults.js";
import {
  TabSpy,
  auditCount,
  newCounterparty,
  newTabWorkspace,
  removeWorkspaces,
  settlementsOf,
} from "../helpers/tab-spy.js";

/**
 * Recovery of tab settlements (docs/decisions/0081). Each test simulates a process that died at one point, then runs the
 * worker step (or a whole tick) and checks that the money moved exactly once and the records say what happened.
 * The effect fault hook is test-only (NODE_ENV must be test); it is disarmed after each test.
 */

const created: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;

async function ws(label: string, opts?: Parameters<typeof newTabWorkspace>[1]): Promise<string> {
  const id = await newTabWorkspace(label, opts);
  created.push(id);
  return id;
}

/** Stale and confirm windows of zero: anything cleared or submitted is due now. The end-of-day batch is off unless a test turns it on. */
function due(ledger: TabLedger, extra: { endOfDay?: boolean; settleOnThreshold?: boolean; now?: Date } = {}) {
  return {
    staleAfterMs: 0,
    confirmAfterMs: 0,
    batchSize: 50,
    now: extra.now ?? new Date(),
    endOfDay: extra.endOfDay ?? false,
    settleOnThreshold: extra.settleOnThreshold ?? false,
    ledger,
  };
}

describe("tab settlements recover after a crash, and never pay twice (PostgreSQL)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    setEffectFault(null);
    await removeWorkspaces(created.splice(0));
  });

  afterAll(async () => {
    await closePool();
  });

  it("a crash after the clear committed and before the send: recovery pays exactly once", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("crash-clear");
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 50_000n, idempotencyKey: "cc-1", description: "Dish" });
    // The process dies here: the clear and the pending settlement are committed, nothing was sent.
    expect((await ledger.reserveSettlement({ workspaceId: w, counterpartyId: cp })).kind).toBe("reserved");
    expect(spy.calls).toHaveLength(0);

    const first = await runTabSettlementStep(due(ledger));
    const second = await runTabSettlementStep(due(ledger));

    expect(first).toMatchObject({ resumed: 1, confirmed: 1, failed: 0 });
    expect(second).toMatchObject({ resumed: 0, confirmed: 0 });
    expect(spy.calls).toHaveLength(1);
    expect(spy.moved.size).toBe(1);
    expect(spy.calls[0].amountCents).toBe(5n);
    const [row] = await settlementsOf(w, cp);
    expect(row.status).toBe("confirmed");
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
  });

  it("a crash after the adapter returned and before submitted was recorded: recovery adopts the transfer and pays once", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("crash-sent");
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 20_000n, idempotencyKey: "cs-1", description: "Dish" });
    // The adapter sends, returns, and the process dies before the result is stored: the effect row stays `started`.
    setEffectFault({
      point: "after_call_before_complete",
      match: (spec) => spec.operation === "settlement.transfer_usdc" && spec.workspaceId === w,
    });
    await expect(ledger.settleTab({ workspaceId: w, counterpartyId: cp })).rejects.toThrow(/injected fault/);
    const [stuck] = await settlementsOf(w, cp);
    expect(stuck.status).toBe("pending");
    expect(spy.moved.size).toBe(1);

    const tick = await runTabSettlementStep(due(ledger));

    expect(tick).toMatchObject({ resumed: 1, confirmed: 1, failed: 0 });
    // The ledger found the transfer through findTransfer. The adapter was not asked to send again.
    expect(spy.calls).toHaveLength(1);
    expect(spy.duplicateCalls).toBe(0);
    const [row] = await settlementsOf(w, cp);
    expect(row.status).toBe("confirmed");
    expect(row.tx_hash).toBe([...spy.moved.values()][0].txHash);
  });

  it("a crash between submitted and confirmed: the confirmation finishes it once", async () => {
    const spy = new TabSpy();
    spy.confirmMode = "throws";
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("crash-confirm");
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 30_000n, idempotencyKey: "cf-1", description: "Dish" });

    const result = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    expect(result).toMatchObject({ outcome: "settlement", status: "submitted" });
    expect(spy.calls).toHaveLength(1);

    spy.confirmMode = "confirmed";
    const tick = await runTabSettlementStep(due(ledger));

    expect(tick).toMatchObject({ confirmed: 1, failed: 0 });
    expect(spy.calls).toHaveLength(1);
    expect(spy.moved.size).toBe(1);
    expect(spy.confirmCalls).toHaveLength(2);
    expect((await settlementsOf(w, cp))[0].status).toBe("confirmed");
    expect(await auditCount(w, "tab.settlement_confirmed")).toBe(1);
  });

  it("a settlement held after a failed confirmation is not resumed or reversed by the worker", async () => {
    const spy = new TabSpy();
    spy.confirmMode = "failed";
    spy.lookupAvailable = false;
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("held-stays");
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 20_000n, idempotencyKey: "hs-1", description: "Dish" });
    await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    const tick = await runTabSettlementStep(due(ledger));
    await runTabSettlementStep(due(ledger));

    expect(tick).toMatchObject({ resumed: 0, confirmed: 0, held: 0, failed: 0 });
    expect(spy.calls).toHaveLength(1);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
    expect((await query(`SELECT COUNT(*)::int AS n FROM tab_entries WHERE workspace_id = $1 AND kind = 'reversal';`, [w])).rows[0].n).toBe(0);
  });

  it("a rejected transfer found pending by the worker is cancelled once, with one reversal, across ticks", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("rejected-tick");
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 20_000n, idempotencyKey: "rt-1", description: "Dish" });
    await ledger.reserveSettlement({ workspaceId: w, counterpartyId: cp });
    const { SettlementRejectedError } = await import("../../src/adapters/settlement/errors.js");
    spy.rejectNext = new SettlementRejectedError("INVALID_REQUEST");

    const first = await runTabSettlementStep(due(ledger));
    const second = await runTabSettlementStep(due(ledger));

    expect(first).toMatchObject({ cancelled: 1, failed: 0 });
    expect(second).toMatchObject({ cancelled: 0 });
    expect(spy.moved.size).toBe(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(20_000n);
    expect((await query(`SELECT COUNT(*)::int AS n FROM tab_entries WHERE workspace_id = $1 AND kind = 'reversal';`, [w])).rows[0].n).toBe(1);
  });

  it("a paused workspace is never sent to by the worker, even for a pending settlement", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("paused-tick");
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 20_000n, idempotencyKey: "pt-1", description: "Dish" });
    await ledger.reserveSettlement({ workspaceId: w, counterpartyId: cp });
    await query(`UPDATE workspaces SET agents_paused = TRUE WHERE id = $1;`, [w]);

    const tick = await runTabSettlementStep(due(ledger, { endOfDay: true }));

    expect(tick).toMatchObject({ resumed: 0, endOfDay: 0, failed: 0 });
    expect(spy.calls).toHaveLength(0);
    const [row] = await settlementsOf(w, cp);
    expect(row.status).toBe("pending");

    // Resuming the workspace lets the pending settlement go out, once.
    await query(`UPDATE workspaces SET agents_paused = FALSE WHERE id = $1;`, [w]);
    await runTabSettlementStep(due(ledger));
    expect(spy.calls).toHaveLength(1);
    expect((await settlementsOf(w, cp))[0].status).toBe("confirmed");
  });

  it("the end-of-day batch settles each tab with a cent at most once per UTC day, and again the next day", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("eod");
    const cp = await newCounterparty(w);
    const dust = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 25_000n, idempotencyKey: "e-1", description: "Dish" });
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: dust, amountMicro: 4_000n, idempotencyKey: "e-2", description: "Dish" });

    const morning = await runTabSettlementStep(due(ledger, { endOfDay: true }));
    const again = await runTabSettlementStep(due(ledger, { endOfDay: true }));
    expect(morning).toMatchObject({ endOfDay: 1, failed: 0 });
    expect(again).toMatchObject({ endOfDay: 0 });
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].amountCents).toBe(2n);
    expect((await ledger.tabBalance(w, dust)).balanceMicro).toBe(4_000n);

    // A cent accrued and the next UTC day: the batch settles it.
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 10_000n, idempotencyKey: "e-3", description: "Dish" });
    const tomorrow = new Date(Date.now() + DAY_MS);
    const nextDay = await runTabSettlementStep(due(ledger, { endOfDay: true, now: tomorrow }));
    expect(nextDay).toMatchObject({ endOfDay: 1 });
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls[1].amountCents).toBe(1n);
  });

  it("with the end-of-day batch off, the worker settles nothing that is not pending or submitted", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("eod-off");
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 25_000n, idempotencyKey: "eo-1", description: "Dish" });

    const tick = await runTabSettlementStep(due(ledger, { endOfDay: false }));

    expect(tick).toMatchObject({ endOfDay: 0 });
    expect(spy.calls).toHaveLength(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(25_000n);
  });

  it("the settle-on-threshold option settles a tab with a cent on every tick, without the day rule", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("threshold-tick");
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 10_000n, idempotencyKey: "th-1", description: "Dish" });

    const first = await runTabSettlementStep(due(ledger, { endOfDay: false, settleOnThreshold: true }));
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 10_000n, idempotencyKey: "th-2", description: "Dish" });
    const second = await runTabSettlementStep(due(ledger, { endOfDay: false, settleOnThreshold: true }));

    expect(first).toMatchObject({ endOfDay: 1 });
    expect(second).toMatchObject({ endOfDay: 1 });
    expect(spy.calls.map((c) => c.amountCents)).toEqual([1n, 1n]);
  });

  it("runTick runs the tab step with the others, and reports it", async () => {
    const spy = new TabSpy();
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await ws("tick-report");
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 20_000n, idempotencyKey: "tr-1", description: "Dish" });
    await ledger.reserveSettlement({ workspaceId: w, counterpartyId: cp });

    const report = await runTick({ stuckSettlingAfterMs: 0, confirmAfterMs: 0, tabs: { ledger, endOfDay: false } });

    expect(report.tabSettlements).toMatchObject({ skipped: false });
    expect(report.tabSettlements.resumed).toBeGreaterThanOrEqual(1);
    expect(report.errors.filter((e) => e.step === "tab_settlements")).toEqual([]);
    expect(spy.moved.size).toBe(1);
    expect((await settlementsOf(w, cp))[0].status).toBe("confirmed");
  });
});
