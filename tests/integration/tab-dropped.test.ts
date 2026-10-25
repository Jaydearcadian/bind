import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { runTabSettlementStep } from "../../src/tabs/worker.js";
import { PRE_SEND_REJECTION_CODES, TabLedger } from "../../src/tabs/ledger.js";
import { setEffectFault } from "../../src/effects/faults.js";
import { DROPPED_AFTER_MS } from "../../src/adapters/settlement/dropped.js";
import { SettlementRejectedError, TRANSFER_FAILED_RECIPIENT, ZERO_ADDRESS_RECIPIENT } from "../../src/adapters/settlement/errors.js";
import {
  TabSpy,
  auditCount,
  newCounterparty,
  newTabWorkspace,
  removeWorkspaces,
  tabSums,
} from "../helpers/tab-spy.js";
import { ageEffect, drainHeldWorkspaces } from "../helpers/tab-held.js";

/**
 * A `submitted` tab transfer the node does not know (a dropped transfer, docs/decisions/0087, item 5). The ledger holds it as
 * SETTLEMENT_DROPPED, keeps its clear, never sends it again, adopts it if a transfer for the order appears, and restores it
 * only under the same proof (iii) rules as an unknown outcome. Also the two refusal codes of item 4 and their pre-send status.
 */

const created: string[] = [];

afterAll(async () => {
  await closePool();
});

afterEach(async () => {
  setEffectFault(null);
  await removeWorkspaces([...created.splice(0), ...drainHeldWorkspaces()]);
});

const ACTOR = { type: "owner" as const, id: "owner-test" };

/** Ticks now, with every held row due and a large batch, as the held-worker tests do. */
function due(ledger: TabLedger) {
  return {
    staleAfterMs: 0,
    confirmAfterMs: 0,
    batchSize: 50,
    now: new Date(),
    endOfDay: false,
    settleOnThreshold: false,
    reconcileAfterMs: 0,
    reconcileBatchSize: 1000,
    ledger,
  };
}

interface Dropped {
  spy: TabSpy;
  ledger: TabLedger;
  w: string;
  cp: string;
  settlementId: string;
  hash: string;
}

/**
 * A settlement sent as a dropped transfer: reserved, executed (submitted with a hash the node never sees), and not yet
 * confirmed. `droppedAfterMs` is the ledger's age rule (0 in most tests, so the node's answer counts at once).
 */
async function sentAndDropped(label: string, opts: { droppedAfterMs?: number } = {}): Promise<Dropped> {
  const spy = new TabSpy();
  spy.confirmMode = "submitted";
  spy.notFoundOnNode = true;
  spy.dropNextSend = true;
  const ledger = new TabLedger({ settlementFor: () => spy, droppedAfterMs: opts.droppedAfterMs ?? 0 });
  const w = await newTabWorkspace(label);
  created.push(w);
  const cp = await newCounterparty(w);
  await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 50_000n, idempotencyKey: `${label}-c`, description: "Dish" });
  const reserved = await ledger.reserveSettlement({ workspaceId: w, counterpartyId: cp });
  if (reserved.kind !== "reserved") throw new Error("expected a reservation");
  const settlementId = reserved.settlement.settlementId;
  const executed = await ledger.executeSettlement(settlementId);
  if (executed.kind !== "submitted") throw new Error(`expected a submitted transfer, got ${JSON.stringify(executed)}`);
  return { spy, ledger, w, cp, settlementId, hash: executed.txHash };
}

async function row(settlementId: string) {
  return (
    await query(
      `SELECT status, hold_reason, tx_hash, reconcile_attempts FROM tab_settlements WHERE id = $1;`,
      [settlementId]
    )
  ).rows[0];
}

async function holdAuditWith(workspaceId: string, hold: string): Promise<number> {
  return (
    await query(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'tab.settlement_held' AND evidence->>'hold' = $2;`,
      [workspaceId, hold]
    )
  ).rows[0].n;
}

describe("a dropped tab transfer is held, not re-sent, and keeps its clear (docs/decisions/0087, item 5)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("node says not found, the age is met and both lookups are empty: held SETTLEMENT_DROPPED, one transfer in total, clear kept", async () => {
    const { spy, ledger, w, cp, settlementId, hash } = await sentAndDropped("drop-held");

    expect(await ledger.confirmSettlement(settlementId)).toEqual({ kind: "held", hold: "SETTLEMENT_DROPPED" });

    const held = await row(settlementId);
    expect(held).toMatchObject({ status: "held", hold_reason: "SETTLEMENT_DROPPED", tx_hash: hash });
    expect(spy.calls, "the transfer was entered once").toHaveLength(1);
    expect(spy.moved.size, "the spy moved nothing: the transfer was dropped").toBe(0);
    expect(await tabSums(w, cp)).toMatchObject({ clears: 50_000n, reversals: 0n });
    expect(await holdAuditWith(w, "SETTLEMENT_DROPPED")).toBe(1);

    // A held settlement is not pending: the send path refuses it, so nothing is sent again.
    expect(await ledger.executeSettlement(settlementId)).toEqual({ kind: "not_pending", status: "held" });
    expect(spy.calls).toHaveLength(1);
  });

  it("is not dropped while it is younger than the age, even when every lookup is empty", async () => {
    const { spy, ledger, settlementId } = await sentAndDropped("drop-young", { droppedAfterMs: DROPPED_AFTER_MS });
    expect(await ledger.confirmSettlement(settlementId)).toEqual({ kind: "awaiting", txHash: expect.any(String) });
    expect((await row(settlementId)).status).toBe("submitted");
    expect(spy.calls).toHaveLength(1);
  });

  it("the node does not answer not found: it stays submitted, and no hold is written", async () => {
    const { spy, ledger, settlementId } = await sentAndDropped("drop-node-has-it");
    spy.notFoundOnNode = false;
    spy.droppedHashes.clear();
    expect((await ledger.confirmSettlement(settlementId)).kind).toBe("awaiting");
    expect((await row(settlementId)).status).toBe("submitted");
  });

  it("a transfer the lookup finds is adopted and confirmed, not dropped", async () => {
    const { spy, ledger, w, cp, settlementId } = await sentAndDropped("drop-found");
    const found = `0x${"ce".repeat(32)}`;
    spy.adoptHash = found;

    expect(await ledger.confirmSettlement(settlementId)).toEqual({ kind: "confirmed", txHash: found });
    expect(await row(settlementId)).toMatchObject({ status: "confirmed", tx_hash: found });
    expect(await holdAuditWith(w, "SETTLEMENT_DROPPED")).toBe(0);
    expect(spy.calls).toHaveLength(1);
    expect(await tabSums(w, cp)).toMatchObject({ clears: 50_000n, reversals: 0n });
  });

  it("a settled order on the contract is not dropped, whatever the node says", async () => {
    const { spy, ledger, settlementId } = await sentAndDropped("drop-settled");
    spy.settledOverride = true;
    expect((await ledger.confirmSettlement(settlementId)).kind).toBe("awaiting");
    expect((await row(settlementId)).status).toBe("submitted");
  });

  it("a lookup that throws is not dropped: the settlement stays submitted", async () => {
    const { spy, ledger, settlementId } = await sentAndDropped("drop-lookup-down");
    spy.lookupDown = true;
    expect((await ledger.confirmSettlement(settlementId)).kind).toBe("awaiting");
    expect((await row(settlementId)).status).toBe("submitted");
    expect(spy.calls).toHaveLength(1);
  });

  it("a contract read that throws is not dropped: the settlement stays submitted", async () => {
    const { spy, ledger, settlementId } = await sentAndDropped("drop-read-down");
    spy.settledReadDown = true;
    expect((await ledger.confirmSettlement(settlementId)).kind).toBe("awaiting");
    expect((await row(settlementId)).status).toBe("submitted");
  });

  it("a dropped tab is adopted by reconcileHeld when the transfer later appears, and nothing is sent", async () => {
    const { spy, ledger, settlementId } = await sentAndDropped("drop-later-adopt");
    expect((await ledger.confirmSettlement(settlementId)).kind).toBe("held");

    const later = `0x${"df".repeat(32)}`;
    spy.adoptHash = later;
    const outcome = await ledger.reconcileHeld(settlementId);
    expect(outcome).toMatchObject({ kind: "adopted", source: "stored", status: "confirmed", confirm: "confirmed" });
    expect(await row(settlementId)).toMatchObject({ status: "confirmed", tx_hash: later });
    expect(spy.calls, "the adoption sends nothing").toHaveLength(1);
  });

  it("the worker re-asks a dropped tab on its backoff, counts the attempt, and never sends", async () => {
    const { spy, ledger, settlementId } = await sentAndDropped("drop-worker");
    expect((await ledger.confirmSettlement(settlementId)).kind).toBe("held");

    const counts = await runTabSettlementStep(due(ledger));
    expect(counts.failed).toBe(0);
    const after = await row(settlementId);
    expect(after).toMatchObject({ status: "held", hold_reason: "SETTLEMENT_DROPPED" });
    expect(after.reconcile_attempts, "the unresolved attempt is counted, so the next one waits longer").toBeGreaterThanOrEqual(1);
    expect(spy.calls).toHaveLength(1);
  });
});

describe("restoring a dropped tab uses the same proof (iii) as an unknown outcome (docs/decisions/0087, item 5)", () => {
  it("refused while the effect is younger than 30 minutes", async () => {
    const { ledger, w, settlementId } = await sentAndDropped("drop-restore-young");
    await ledger.confirmSettlement(settlementId);
    const out = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(out).toMatchObject({ kind: "refused", code: "NOT_PROVABLY_UNSENT" });
    expect((out as { reason: string }).reason).toContain("30 minutes");
    expect((await row(settlementId)).status).toBe("held");
    expect(await auditCount(w, "tab.settlement_restore_refused")).toBeGreaterThanOrEqual(1);
  });

  it("refused without the owner's acknowledgement, even when old enough", async () => {
    const { ledger, settlementId, w } = await sentAndDropped("drop-restore-noack");
    await ledger.confirmSettlement(settlementId);
    await ageEffect(w, settlementId, 60);
    const out = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: false });
    expect(out).toMatchObject({ kind: "refused", code: "NOT_PROVABLY_UNSENT" });
    expect((await row(settlementId)).status).toBe("held");
  });

  it("refused when the node now has the transaction", async () => {
    const { spy, ledger, settlementId, w } = await sentAndDropped("drop-restore-has-it");
    await ledger.confirmSettlement(settlementId);
    await ageEffect(w, settlementId, 60);
    spy.notFoundOnNode = false;
    spy.droppedHashes.clear();
    const out = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(out).toMatchObject({ kind: "refused", code: "NOT_PROVABLY_UNSENT" });
    expect((await row(settlementId)).status).toBe("held");
  });

  it("refused when a transfer for the order is found", async () => {
    const { spy, ledger, settlementId, w } = await sentAndDropped("drop-restore-found");
    await ledger.confirmSettlement(settlementId);
    await ageEffect(w, settlementId, 60);
    spy.adoptHash = `0x${"fe".repeat(32)}`;
    const out = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(out).toMatchObject({ kind: "refused", code: "NOT_PROVABLY_UNSENT" });
    expect((await row(settlementId)).status).toBe("held");
  });

  it("restored once old, acknowledged, not on the node and not settled: cancelled with exactly one reversal", async () => {
    const { ledger, w, cp, settlementId } = await sentAndDropped("drop-restore-ok");
    await ledger.confirmSettlement(settlementId);
    await ageEffect(w, settlementId, 60);
    const out = await ledger.cancelHeldAndRestore(settlementId, { actor: ACTOR, acknowledgeNotSent: true });
    expect(out).toMatchObject({ kind: "cancelled", proof: "UNKNOWN_NOT_SETTLED_ACKNOWLEDGED", replayed: false });
    expect(await row(settlementId)).toMatchObject({ status: "cancelled" });
    expect(await tabSums(w, cp)).toMatchObject({ clears: 50_000n, reversals: 50_000n });
  });
});

describe("the two refusal codes of item 4 and the pre-send list", () => {
  it("PRE_SEND_REJECTION_CODES holds ZERO_ADDRESS_RECIPIENT and not TRANSFER_FAILED_RECIPIENT", () => {
    expect(PRE_SEND_REJECTION_CODES.has(ZERO_ADDRESS_RECIPIENT)).toBe(true);
    expect(PRE_SEND_REJECTION_CODES.has(TRANSFER_FAILED_RECIPIENT)).toBe(false);
  });

  it("a zero-address refusal on the first attempt cancels the settlement and writes one reversal", async () => {
    const spy = new TabSpy();
    spy.rejectNext = new SettlementRejectedError(ZERO_ADDRESS_RECIPIENT);
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await newTabWorkspace("zero-recipient");
    created.push(w);
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 50_000n, idempotencyKey: "zr-c", description: "Dish" });
    const reserved = await ledger.reserveSettlement({ workspaceId: w, counterpartyId: cp });
    if (reserved.kind !== "reserved") throw new Error("expected a reservation");

    expect(await ledger.executeSettlement(reserved.settlement.settlementId)).toEqual({
      kind: "cancelled",
      code: ZERO_ADDRESS_RECIPIENT,
    });
    expect(await tabSums(w, cp)).toMatchObject({ clears: 50_000n, reversals: 50_000n });
  });

  it("a TRANSFER_FAILED_RECIPIENT refusal is a hold with its clear kept, never a cancel", async () => {
    const spy = new TabSpy();
    spy.rejectNext = new SettlementRejectedError(TRANSFER_FAILED_RECIPIENT, undefined, "the recipient may be blocklisted or invalid");
    const ledger = new TabLedger({ settlementFor: () => spy });
    const w = await newTabWorkspace("tfr-recipient");
    created.push(w);
    const cp = await newCounterparty(w);
    await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 50_000n, idempotencyKey: "tfr-c", description: "Dish" });
    const reserved = await ledger.reserveSettlement({ workspaceId: w, counterpartyId: cp });
    if (reserved.kind !== "reserved") throw new Error("expected a reservation");

    expect(await ledger.executeSettlement(reserved.settlement.settlementId)).toEqual({
      kind: "held",
      hold: "SETTLEMENT_REJECTED",
    });
    expect(await tabSums(w, cp)).toMatchObject({ clears: 50_000n, reversals: 0n });
    expect(spy.calls).toHaveLength(1);
  });
});
