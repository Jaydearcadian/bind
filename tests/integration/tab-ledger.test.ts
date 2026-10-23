import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { TabLedger } from "../../src/tabs/ledger.js";
import { TabError } from "../../src/tabs/errors.js";
import { MAX_CHARGE_MICRO } from "../../src/tabs/units.js";
import { SettlementRejectedError } from "../../src/adapters/settlement/errors.js";
import {
  PAYEE,
  TabSpy,
  auditCount,
  newCounterparty,
  newTabWorkspace,
  removeWorkspaces,
  settlementsOf,
  tabSums,
} from "../helpers/tab-spy.js";

/**
 * The tab ledger (docs/decisions/0081), against PostgreSQL with a spy adapter. Nothing is broadcast and no network is used.
 * Each test makes its own workspaces, which are deleted afterwards (their rows go with them).
 */

const created: string[] = [];

afterAll(async () => {
  await closePool();
});

async function ws(label: string, opts?: Parameters<typeof newTabWorkspace>[1]): Promise<string> {
  const id = await newTabWorkspace(label, opts);
  created.push(id);
  return id;
}

function ledgerWith(spy: TabSpy): TabLedger {
  return new TabLedger({ settlementFor: () => spy });
}

async function charge(ledger: TabLedger, workspaceId: string, counterpartyId: string, amountMicro: bigint, key: string, description = "Agent charge") {
  return ledger.accrueCharge({ workspaceId, counterpartyId, amountMicro, idempotencyKey: key, description });
}

/** Rejects with the TabError the call throws, or fails the test. */
async function tabErrorOf(promise: Promise<unknown>): Promise<TabError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(TabError);
    return err as TabError;
  }
  throw new Error("expected a TabError, but the call succeeded");
}

describe("tab ledger: charges accrue per counterparty in micro-USDC (PostgreSQL)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    await removeWorkspaces(created.splice(0));
  });

  it("a sub-cent charge is recorded in micro-USDC and reads back with no settleable cents", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("sub");
    const cp = await newCounterparty(w);

    const result = await charge(ledger, w, cp, 3_000n, "c-1");

    expect(result.created).toBe(true);
    expect(result.entry).toMatchObject({ kind: "charge", amountMicro: 3_000n, counterpartyId: cp, settlementId: null });
    const balance = await ledger.tabBalance(w, cp);
    expect(balance).toMatchObject({ balanceMicro: 3_000n, settleableCents: 0n });
    expect(spy.calls).toHaveLength(0);
  });

  it("the same key with the same data adds nothing and returns the entry that exists", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("idem");
    const cp = await newCounterparty(w);

    const first = await charge(ledger, w, cp, 25_000n, "same-key", "Dish for table 4");
    const second = await charge(ledger, w, cp, 25_000n, "same-key", "Dish for table 4");

    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(25_000n);
    expect(await auditCount(w, "tab.charge_accrued")).toBe(1);
  });

  it("the same key with different data is a conflict and changes nothing", async () => {
    const ledger = ledgerWith(new TabSpy());
    const w = await ws("conflict");
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 10_000n, "k-1", "Original");

    const amount = await tabErrorOf(charge(ledger, w, cp, 20_000n, "k-1", "Original"));
    expect(amount.code).toBe("IDEMPOTENCY_CONFLICT");
    expect(amount.httpStatus).toBe(409);
    const description = await tabErrorOf(charge(ledger, w, cp, 10_000n, "k-1", "Changed"));
    expect(description.code).toBe("IDEMPOTENCY_CONFLICT");
    const other = await newCounterparty(w);
    const counterparty = await tabErrorOf(charge(ledger, w, other, 10_000n, "k-1", "Original"));
    expect(counterparty.code).toBe("IDEMPOTENCY_CONFLICT");

    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(10_000n);
    expect((await ledger.tabBalance(w, other)).balanceMicro).toBe(0n);
  });

  it("concurrent charges with one key and the same data record one entry", async () => {
    const ledger = ledgerWith(new TabSpy());
    const w = await ws("race");
    const cp = await newCounterparty(w);

    const results = await Promise.all(Array.from({ length: 6 }, () => charge(ledger, w, cp, 7_000n, "race-key")));

    expect(new Set(results.map((r) => r.entry.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(7_000n);
  });

  it("concurrent charges with one key and different data: exactly one is recorded, the rest conflict", async () => {
    const ledger = ledgerWith(new TabSpy());
    const w = await ws("race2");
    const cp = await newCounterparty(w);

    const settled = await Promise.allSettled([
      charge(ledger, w, cp, 1_000n, "race2-key"),
      charge(ledger, w, cp, 2_000n, "race2-key"),
      charge(ledger, w, cp, 3_000n, "race2-key"),
    ]);

    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    for (const r of rejected) expect((r.reason as TabError).code).toBe("IDEMPOTENCY_CONFLICT");
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ entry: { amountMicro: bigint } }>).value.entry.amountMicro;
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(winner);
  });

  it("refuses every bad amount with INVALID_CHARGE_AMOUNT and records nothing", async () => {
    const ledger = ledgerWith(new TabSpy());
    const w = await ws("badamt");
    const cp = await newCounterparty(w);

    const bad: unknown[] = [0n, -1n, MAX_CHARGE_MICRO + 1n, 1.5, 10_000];
    for (const amount of bad) {
      const err = await tabErrorOf(ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: amount as bigint, idempotencyKey: "bad", description: "x" }));
      expect(err.code).toBe("INVALID_CHARGE_AMOUNT");
      expect(err.httpStatus).toBe(400);
    }
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
  });

  it("accepts the largest single charge and a whole-cent charge (both accrue)", async () => {
    const ledger = ledgerWith(new TabSpy());
    const w = await ws("limits");
    const cp = await newCounterparty(w);

    await charge(ledger, w, cp, MAX_CHARGE_MICRO, "max");
    await charge(ledger, w, cp, 10_000n, "one-cent");

    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(MAX_CHARGE_MICRO + 10_000n);
  });

  it("refuses a malformed key, description or counterparty id with INVALID_CHARGE", async () => {
    const ledger = ledgerWith(new TabSpy());
    const w = await ws("badshape");
    const cp = await newCounterparty(w);

    const cases: Array<[string, string, unknown]> = [
      ["", "ok", "key"],
      ["has space", "ok", "key"],
      ["a".repeat(129), "ok", "key"],
      ["k", "", "description"],
      ["k", "   ", "description"],
      ["k", "x".repeat(201), "description"],
      ["k", 42 as unknown as string, "description"],
    ];
    for (const [key, description] of cases) {
      const err = await tabErrorOf(ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 1_000n, idempotencyKey: key, description }));
      expect(err.code, `${key}|${description}`).toBe("INVALID_CHARGE");
    }
    const badId = await tabErrorOf(ledger.accrueCharge({ workspaceId: w, counterpartyId: "no spaces allowed", amountMicro: 1_000n, idempotencyKey: "k", description: "x" }));
    expect(badId.code).toBe("INVALID_CHARGE");
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
  });

  it("an unknown counterparty is not found, and an unverified one is refused, with nothing recorded", async () => {
    const ledger = ledgerWith(new TabSpy());
    const w = await ws("gate-cp");
    const unverified = await newCounterparty(w, { verified: false });

    const missing = await tabErrorOf(charge(ledger, w, "cp-does-not-exist", 1_000n, "k"));
    expect(missing.code).toBe("COUNTERPARTY_NOT_FOUND");
    expect(missing.httpStatus).toBe(404);
    const notVerified = await tabErrorOf(charge(ledger, w, unverified, 1_000n, "k"));
    expect(notVerified.code).toBe("COUNTERPARTY_NOT_VERIFIED");
    expect(notVerified.httpStatus).toBe(409);
    expect((await query(`SELECT COUNT(*)::int AS n FROM tab_entries WHERE workspace_id = $1;`, [w])).rows[0].n).toBe(0);
  });

  it("a paused workspace still records charges: they are obligations, and settlement is what the pause stops", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("paused-charge", { paused: true });
    const cp = await newCounterparty(w);

    const result = await charge(ledger, w, cp, 40_000n, "paused-key");

    expect(result.created).toBe(true);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(40_000n);
    expect(spy.calls).toHaveLength(0);
  });
});

describe("tab ledger: settlement clears whole cents, and gates leave the balance untouched (PostgreSQL)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    await removeWorkspaces(created.splice(0));
  });

  it("a balance under one cent is a no-op that carries over: no row, no transfer, no change", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("below");
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 9_999n, "below-1");

    const result = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(result).toEqual({ outcome: "below_threshold", balanceMicro: 9_999n });
    expect(spy.calls).toHaveLength(0);
    expect(await settlementsOf(w, cp)).toHaveLength(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(9_999n);
  });

  it("floor and remainder: 1.5 cents pays 1 cent and 0.5 carries; the carry is paid with the next charge", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("floor");
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 15_000n, "f-1");

    const first = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    expect(first).toMatchObject({ outcome: "settlement", status: "confirmed", amountCents: 1n });
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(5_000n);

    await charge(ledger, w, cp, 5_000n, "f-2");
    const second = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    expect(second).toMatchObject({ outcome: "settlement", status: "confirmed", amountCents: 1n });
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
    expect(spy.calls.map((c) => c.amountCents)).toEqual([1n, 1n]);
  });

  it("two concurrent settle calls clear the balance once and pay it once", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("concurrent");
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 20_000n, "cc-1");

    const results = await Promise.all([
      ledger.settleTab({ workspaceId: w, counterpartyId: cp }),
      ledger.settleTab({ workspaceId: w, counterpartyId: cp }),
    ]);

    const settlements = results.filter((r) => r.outcome === "settlement");
    expect(settlements).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "below_threshold")).toHaveLength(1);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0].amountCents).toBe(2n);
    expect((await tabSums(w, cp)).clears).toBe(20_000n);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
  });

  it("the adapter only ever sees a whole, positive number of cents, and the submitted record exists before confirm", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("milestones");
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 123_456n, "m-1");

    const result = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(result).toMatchObject({ outcome: "settlement", status: "confirmed", amountCents: 12n });
    expect(spy.subCentAttempts).toEqual([]);
    for (const call of spy.calls) {
      expect(typeof call.amountCents).toBe("bigint");
      expect(call.amountCents > 0n).toBe(true);
    }
    // Confirm was asked once, and at that moment the settlement was already submitted with its audit row.
    expect(spy.confirmSnapshots).toHaveLength(1);
    expect(spy.confirmSnapshots[0]).toMatchObject({ settlementStatus: "submitted", submittedAuditRows: 1 });
    const [row] = await settlementsOf(w, cp);
    expect(row).toMatchObject({ status: "confirmed", amount_cents: "12" });
    const stored = (await query(`SELECT confirmed_block::text AS b, tx_hash FROM tab_settlements WHERE id = $1;`, [row.id])).rows[0];
    expect(stored.b).toBe("4242");
    expect(stored.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await auditCount(w, "tab.settlement_submitted")).toBe(1);
    expect(await auditCount(w, "tab.settlement_confirmed")).toBe(1);
  });

  it("the clear and the settlement row commit together, and the settlement owns the cleared amount", async () => {
    const ledger = ledgerWith(new TabSpy());
    const w = await ws("owns");
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 30_000n, "o-1");

    const reserved = await ledger.reserveSettlement({ workspaceId: w, counterpartyId: cp });

    expect(reserved.kind).toBe("reserved");
    const [row] = await settlementsOf(w, cp);
    expect(row.status).toBe("pending");
    const clear = await query(`SELECT amount_micro::text AS a, settlement_id FROM tab_entries WHERE workspace_id = $1 AND kind = 'clear';`, [w]);
    expect(clear.rows).toEqual([{ a: "30000", settlement_id: row.id }]);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
  });

  it("a paused workspace refuses to settle: nothing is cleared, nothing is sent", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("pause", { paused: true });
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 50_000n, "p-1");

    const result = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(result).toEqual({ outcome: "refused", reason: "AGENTS_PAUSED", balanceMicro: 50_000n });
    expect(spy.calls).toHaveLength(0);
    expect(await settlementsOf(w, cp)).toHaveLength(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(50_000n);
    expect(await auditCount(w, "tab.settlement_paused_hold")).toBe(1);
  });

  it("an unverified counterparty is held with SUPPLIER_NOT_VERIFIED and owns no balance", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("unver");
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 20_000n, "u-1");
    await query(`UPDATE suppliers SET verified = FALSE WHERE id = $1;`, [cp]);

    const result = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(result).toMatchObject({ outcome: "settlement", status: "held", holdReason: "SUPPLIER_NOT_VERIFIED", amountCents: 2n });
    expect(spy.calls).toHaveLength(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(20_000n);
    const clears = (await query(`SELECT COUNT(*)::int AS n FROM tab_entries WHERE workspace_id = $1 AND kind = 'clear';`, [w])).rows[0].n;
    expect(clears).toBe(0);
  });

  it("a counterparty with no payment address and a workspace with no settlement address are held, not paid", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);

    const noPayee = await ws("nopay");
    const cpNoAddress = await newCounterparty(noPayee, { paymentAddress: null });
    await charge(ledger, noPayee, cpNoAddress, 20_000n, "np-1");
    const a = await ledger.settleTab({ workspaceId: noPayee, counterpartyId: cpNoAddress });
    expect(a).toMatchObject({ outcome: "settlement", status: "held", holdReason: "SUPPLIER_PAYMENT_ADDRESS_MISSING" });

    const noPayer = await ws("nosettle", { settlementAddress: null });
    const cpOk = await newCounterparty(noPayer);
    await charge(ledger, noPayer, cpOk, 20_000n, "ns-1");
    const b = await ledger.settleTab({ workspaceId: noPayer, counterpartyId: cpOk });
    expect(b).toMatchObject({ outcome: "settlement", status: "held", holdReason: "WORKSPACE_SETTLEMENT_ADDRESS_MISSING" });

    expect(spy.calls).toHaveLength(0);
    expect((await ledger.tabBalance(noPayee, cpNoAddress)).balanceMicro).toBe(20_000n);
    expect((await ledger.tabBalance(noPayer, cpOk)).balanceMicro).toBe(20_000n);
  });

  it("an amount above the approval threshold needs approval: not paid, balance untouched", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("threshold", { thresholdCents: 500 });
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 501n * 10_000n, "t-1");

    const result = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(result).toEqual({ outcome: "needs_approval", amountCents: 501n, thresholdCents: 500n });
    expect(spy.calls).toHaveLength(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(501n * 10_000n);
    expect(await auditCount(w, "tab.settlement_needs_approval")).toBe(1);
  });

  it("an amount at the threshold is paid (the rule is 'above', as the commitment gate reads it)", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("at-threshold", { thresholdCents: 5 });
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 5n * 10_000n, "at-1");

    const result = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(result).toMatchObject({ outcome: "settlement", status: "confirmed", amountCents: 5n });
  });

  it("over the daily budget is refused with DAILY_LIMIT_EXCEEDED and the balance is kept", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("budget", { budgetCents: 10 });
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 11n * 10_000n, "b-1");

    const result = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(result).toEqual({ outcome: "refused", reason: "DAILY_LIMIT_EXCEEDED", balanceMicro: 110_000n });
    expect(spy.calls).toHaveLength(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(110_000n);
  });

  it("tab settlements count toward the same daily limit as settled orders", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("shared-budget", { budgetCents: 10 });
    const cpA = await newCounterparty(w);
    const cpB = await newCounterparty(w);
    await charge(ledger, w, cpA, 6n * 10_000n, "sa-1");
    expect(await ledger.settleTab({ workspaceId: w, counterpartyId: cpA })).toMatchObject({ status: "confirmed" });

    await charge(ledger, w, cpB, 5n * 10_000n, "sb-1");
    const second = await ledger.settleTab({ workspaceId: w, counterpartyId: cpB });

    expect(second).toEqual({ outcome: "refused", reason: "DAILY_LIMIT_EXCEEDED", balanceMicro: 50_000n });
    expect(spy.calls).toHaveLength(1);
  });

  it("an order already committed today counts toward the same daily limit as a tab", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("order-budget", { budgetCents: 10 });
    const cp = await newCounterparty(w);
    await query(
      `INSERT INTO orders (id, workspace_id, order_number, supplier_id, supplier_name, item_sku, item_name, quantity, unit_price_cents, total_price_cents, currency, status, idempotency_key, created_at, updated_at)
       VALUES ($1, $2, 'PO-1', $3, 'Counterparty', 'FOOD-FLOUR-50LB', 'Flour', 1, 800, 800, 'USDC', 'confirmed', $4, NOW(), NOW());`,
      [`ord_tabbudget_${w}`, w, cp, `ord-idem-${w}`]
    );
    await charge(ledger, w, cp, 3n * 10_000n, "ob-1");

    const result = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(result).toEqual({ outcome: "refused", reason: "DAILY_LIMIT_EXCEEDED", balanceMicro: 30_000n });
    expect(spy.calls).toHaveLength(0);
  });
});

describe("tab ledger: transfer outcomes (PostgreSQL)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    await removeWorkspaces(created.splice(0));
  });

  it("a transfer rejected before anything was sent cancels the settlement with exactly one reversal", async () => {
    const spy = new TabSpy();
    spy.rejectNext = new SettlementRejectedError("INVALID_REQUEST");
    const ledger = ledgerWith(spy);
    const w = await ws("reject");
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 40_000n, "r-1");

    const result = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(result).toMatchObject({ outcome: "settlement", status: "cancelled", holdReason: "INVALID_REQUEST" });
    expect(spy.moved.size).toBe(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(40_000n);
    const reversals = await query(`SELECT COUNT(*)::int AS n FROM tab_entries WHERE workspace_id = $1 AND kind = 'reversal';`, [w]);
    expect(reversals.rows[0].n).toBe(1);
    // Asking again does not reverse twice: the balance is 40_000 and the settlement is no longer pending.
    const again = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
    expect(again.outcome).toBe("settlement");
    expect((await query(`SELECT COUNT(*)::int AS n FROM tab_entries WHERE workspace_id = $1 AND kind = 'reversal';`, [w])).rows[0].n).toBe(1);
  });

  it("a failed confirmation holds the settlement with SETTLEMENT_FAILED and does not reverse the clear", async () => {
    const spy = new TabSpy();
    spy.confirmMode = "failed";
    spy.lookupAvailable = false;
    const ledger = ledgerWith(spy);
    const w = await ws("failconfirm");
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 20_000n, "fc-1");

    const result = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(result).toMatchObject({ outcome: "settlement", status: "held", holdReason: "SETTLEMENT_FAILED" });
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
    expect((await query(`SELECT COUNT(*)::int AS n FROM tab_entries WHERE workspace_id = $1 AND kind = 'reversal';`, [w])).rows[0].n).toBe(0);
    expect(spy.calls).toHaveLength(1);
  });

  it("a transfer the adapter reports as failed outright is held with SETTLEMENT_FAILED, with its hash kept", async () => {
    const spy = new TabSpy();
    spy.transferStatus = "failed";
    const ledger = ledgerWith(spy);
    const w = await ws("failsend");
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 20_000n, "fs-1");

    const result = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(result).toMatchObject({ outcome: "settlement", status: "held", holdReason: "SETTLEMENT_FAILED" });
    expect(result.outcome === "settlement" && result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(spy.confirmCalls).toHaveLength(0);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
  });

  it("a duplicate reverted confirmation adopts the other confirmed transfer, once (ADR 0079's rule for tabs)", async () => {
    const spy = new TabSpy();
    spy.confirmMode = "failed";
    const adopted = `0x${"ab".repeat(32)}`;
    const ledger = ledgerWith(spy);
    const w = await ws("adopt");
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 20_000n, "ad-1");
    spy.adoptHash = adopted;

    const result = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(result).toMatchObject({ outcome: "settlement", status: "confirmed", txHash: adopted });
    expect(await auditCount(w, "tab.settlement_reverted_duplicate_adopted")).toBe(1);
  });

  it("an unresolved confirmation leaves the settlement submitted, and the balance stays cleared", async () => {
    const spy = new TabSpy();
    spy.confirmMode = "throws";
    const ledger = ledgerWith(spy);
    const w = await ws("unresolved");
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 20_000n, "un-1");

    const result = await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(result).toMatchObject({ outcome: "settlement", status: "submitted" });
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(0n);
    expect(spy.calls).toHaveLength(1);
  });

  it("an error from the adapter after the transfer leaves the settlement pending and throws; it is never sent again by the call", async () => {
    const spy = new TabSpy();
    spy.throwAfterSendNext = true;
    spy.lookupAvailable = false;
    const ledger = ledgerWith(spy);
    const w = await ws("throwsend");
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 20_000n, "ts-1");

    await expect(ledger.settleTab({ workspaceId: w, counterpartyId: cp })).rejects.toThrow(/transport lost/);

    const [row] = await settlementsOf(w, cp);
    expect(row.status).toBe("pending");
    expect(spy.moved.size).toBe(1);
  });

  it("nothing is ever cross-tenant: charges, balances, lists and settles stay inside their workspace", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const wsA = await ws("tenant-a");
    const wsB = await ws("tenant-b");
    const cpA = await newCounterparty(wsA);
    const cpB = await newCounterparty(wsB);

    // A charge against another workspace's counterparty is not found, and nothing is written in either workspace.
    const cross = await tabErrorOf(charge(ledger, wsA, cpB, 1_000n, "x-1"));
    expect(cross.code).toBe("COUNTERPARTY_NOT_FOUND");
    expect(cross.httpStatus).toBe(404);
    // The same error as a counterparty that does not exist at all.
    const missing = await tabErrorOf(charge(ledger, wsA, "cp-nope", 1_000n, "x-1"));
    expect(missing.message).toBe(cross.message);

    // Reads of another workspace's tab are not found, and the list never shows it.
    await charge(ledger, wsB, cpB, 9_000n, "x-2");
    expect((await tabErrorOf(ledger.tabBalance(wsA, cpB))).code).toBe("COUNTERPARTY_NOT_FOUND");
    expect((await tabErrorOf(ledger.tabDetail(wsA, cpB))).code).toBe("COUNTERPARTY_NOT_FOUND");
    expect((await ledger.listTabs(wsA)).map((t) => t.counterpartyId)).not.toContain(cpB);
    expect((await ledger.listTabs(wsB)).map((t) => t.counterpartyId)).toEqual([cpB]);

    // A settle naming the other workspace's counterparty moves nothing.
    const settle = await tabErrorOf(ledger.settleTab({ workspaceId: wsA, counterpartyId: cpB }));
    expect(settle.code).toBe("COUNTERPARTY_NOT_FOUND");
    expect(spy.calls).toHaveLength(0);
    expect((await ledger.tabBalance(wsB, cpB)).balanceMicro).toBe(9_000n);

    // The same idempotency key in two workspaces is two independent charges, not a conflict and not a leak.
    await charge(ledger, wsA, cpA, 4_000n, "shared-key");
    await charge(ledger, wsB, cpB, 4_000n, "shared-key");
    expect((await ledger.tabBalance(wsA, cpA)).balanceMicro).toBe(4_000n);
    expect((await ledger.tabBalance(wsB, cpB)).balanceMicro).toBe(13_000n);
  });

  it("the database refuses a ledger row whose counterparty belongs to another workspace", async () => {
    const wsA = await ws("fk-a");
    const wsB = await ws("fk-b");
    const cpB = await newCounterparty(wsB);
    await expect(
      query(
        `INSERT INTO tab_entries (id, workspace_id, counterparty_id, kind, amount_micro, idempotency_key, settlement_id, description, created_at)
         VALUES ('tabent_fk_probe', $1, $2, 'charge', 1000, 'charge:fk-probe', NULL, 'probe', NOW());`,
        [wsA, cpB]
      )
    ).rejects.toThrow(/foreign key|violates/);
  });

  it("the database refuses a non-positive entry and a charge that is linked to a settlement", async () => {
    const w = await ws("checks");
    const cp = await newCounterparty(w);
    await expect(
      query(
        `INSERT INTO tab_entries (id, workspace_id, counterparty_id, kind, amount_micro, idempotency_key, settlement_id, description, created_at)
         VALUES ('tabent_zero', $1, $2, 'charge', 0, 'charge:zero', NULL, 'zero', NOW());`,
        [w, cp]
      )
    ).rejects.toThrow(/check constraint/);
    await expect(
      query(
        `INSERT INTO tab_entries (id, workspace_id, counterparty_id, kind, amount_micro, idempotency_key, settlement_id, description, created_at)
         VALUES ('tabent_link', $1, $2, 'charge', 1000, 'charge:link', 'tabset_nope', 'link', NOW());`,
        [w, cp]
      )
    ).rejects.toThrow(/check constraint|foreign key/);
  });

  it("the payee is the counterparty's payment address, and a payer is the workspace's settlement address", async () => {
    const spy = new TabSpy();
    const ledger = ledgerWith(spy);
    const w = await ws("payee");
    const cp = await newCounterparty(w);
    await charge(ledger, w, cp, 10_000n, "pe-1");

    await ledger.settleTab({ workspaceId: w, counterpartyId: cp });

    expect(spy.calls[0].toAddress).toBe(PAYEE);
    expect(spy.calls[0].orderId.startsWith("tab_tabset_")).toBe(true);
    expect(spy.calls[0].matchHash).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
