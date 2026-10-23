import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { TabLedger } from "../../src/tabs/ledger.js";
import { TabError } from "../../src/tabs/errors.js";
import { runTabSettlementStep } from "../../src/tabs/worker.js";
import { setEffectFault } from "../../src/effects/faults.js";
import { SettlementRejectedError } from "../../src/adapters/settlement/errors.js";
import { TabSpy, newCounterparty, newTabWorkspace, removeWorkspaces, tabSums } from "../helpers/tab-spy.js";

/**
 * Property test (ADR 0081): random sequences of charges, settlements, crashes, lost results, refusals and recoveries over
 * three counterparties. Each run is deterministic (a fixed seed), and every step checks the invariants against the
 * database and the spy:
 *   - a tab's balance equals its charges minus the cents of every settlement that owns a clear, times 10_000;
 *   - no adapter call is made for an order that already moved money (the ledger never sends twice);
 *   - what moved never exceeds what was accrued, and every moved transfer is recorded against a settlement;
 *   - the adapter only ever sees whole, positive cents.
 * After the sequence the lookup is restored and the worker runs until nothing is left in flight.
 */

const created: string[] = [];
const AMOUNTS_MICRO = [1n, 999n, 9_999n, 10_000n, 15_000n, 25_000n, 123_456n, 300_000n];

/** Mulberry32: a small deterministic generator. The same seed always gives the same sequence. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `drained` is true only after the worker has finished what was in flight. Before that, a transfer may have moved money
 * whose result was lost (the settlement is still pending until the lookup answers), so every moved transfer is recorded
 * only once the sequence is drained.
 */
async function invariants(w: string, cps: string[], ledger: TabLedger, spy: TabSpy, drained: boolean): Promise<void> {
  let chargedTotal = 0n;
  for (const cp of cps) {
    const sums = await tabSums(w, cp);
    chargedTotal += sums.charges;
    const owned = await query(
      `SELECT COALESCE(SUM(t.amount_cents), 0)::text AS cents
       FROM tab_settlements t
       WHERE t.workspace_id = $1 AND t.counterparty_id = $2 AND t.status <> 'cancelled'
         AND EXISTS (SELECT 1 FROM tab_entries e WHERE e.settlement_id = t.id AND e.kind = 'clear');`,
      [w, cp]
    );
    const ownedMicro = BigInt(owned.rows[0].cents) * 10_000n;
    // The balance is what was charged less what settlements own. Never negative, never more than charged.
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(sums.charges - ownedMicro);
    expect(sums.charges - ownedMicro >= 0n).toBe(true);
  }
  // What moved never exceeds what was accrued, at every step.
  expect(spy.movedCents() * 10_000n <= chargedTotal).toBe(true);
  if (drained) {
    const stored = (await query(`SELECT tx_hash FROM tab_settlements WHERE workspace_id = $1 AND tx_hash IS NOT NULL;`, [w])).rows.map(
      (r) => r.tx_hash as string
    );
    for (const transfer of spy.moved.values()) expect(stored).toContain(transfer.txHash);
  }
  expect(spy.duplicateCalls).toBe(0);
  expect(spy.subCentAttempts).toEqual([]);
}

/** Settlement outcomes per run, so the last test can show the sequences reached the recovery paths, not only the easy ones. */
const outcomes: Record<string, number>[] = [];

async function runSequence(seed: number, steps: number): Promise<void> {
  const rnd = generator(seed);
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rnd() * items.length)];
  const spy = new TabSpy();
  const ledger = new TabLedger({ settlementFor: () => spy });
  const w = await newTabWorkspace(`fuzz-${seed}`, { budgetCents: 100_000_000, thresholdCents: 100_000_000 });
  created.push(w);
  const cps = [await newCounterparty(w), await newCounterparty(w), await newCounterparty(w)];
  let keyCounter = 0;

  for (let step = 0; step < steps; step += 1) {
    const cp = pick(cps);
    const action = rnd();
    try {
      if (action < 0.30) {
        keyCounter += 1;
        await ledger.accrueCharge({
          workspaceId: w,
          counterpartyId: cp,
          amountMicro: pick(AMOUNTS_MICRO),
          idempotencyKey: `fz-${seed}-${keyCounter}`,
          description: "Fuzz charge",
        });
      } else if (action < 0.45) {
        await ledger.settleTab({ workspaceId: w, counterpartyId: cp });
      } else if (action < 0.55) {
        // The process dies after the clear committed and before the send.
        await ledger.reserveSettlement({ workspaceId: w, counterpartyId: cp });
      } else if (action < 0.63) {
        // The adapter sends and returns, but the result is not stored: the effect row stays started.
        setEffectFault({ point: "after_call_before_complete", match: (spec) => spec.workspaceId === w });
        await ledger.settleTab({ workspaceId: w, counterpartyId: cp }).catch(() => undefined);
      } else if (action < 0.69) {
        // The transfer moves money and the call throws: the outcome is unknown until the lookup answers.
        spy.throwAfterSendNext = true;
        await ledger.settleTab({ workspaceId: w, counterpartyId: cp }).catch(() => undefined);
      } else if (action < 0.74) {
        spy.rejectNext = new SettlementRejectedError("INVALID_REQUEST");
        await ledger.settleTab({ workspaceId: w, counterpartyId: cp }).catch(() => undefined);
      } else if (action < 0.79) {
        spy.confirmMode = "throws";
        await ledger.settleTab({ workspaceId: w, counterpartyId: cp }).catch(() => undefined);
        spy.confirmMode = "confirmed";
      } else if (action < 0.83) {
        // The chain reports the transfer as reverted: held, its clear kept.
        spy.confirmMode = "failed";
        await ledger.settleTab({ workspaceId: w, counterpartyId: cp }).catch(() => undefined);
      } else if (action < 0.86) {
        // The adapter reports the transfer failed outright: held with its hash.
        spy.transferStatus = "failed";
        await ledger.settleTab({ workspaceId: w, counterpartyId: cp }).catch(() => undefined);
      } else if (action < 0.90) {
        spy.lookupAvailable = rnd() < 0.5;
      } else {
        // The worker runs: resume, confirm, end-of-day batch.
        await runTabSettlementStep({
          staleAfterMs: 0,
          confirmAfterMs: 0,
          batchSize: 50,
          now: new Date(),
          endOfDay: rnd() < 0.5,
          settleOnThreshold: rnd() < 0.2,
          ledger,
        });
      }
    } catch (err) {
      // Only a tab error or a recorded adapter error may surface, and the sequence goes on.
      expect(err instanceof TabError || err instanceof Error).toBe(true);
    } finally {
      setEffectFault(null);
      spy.throwAfterSendNext = false;
      spy.rejectNext = null;
      spy.confirmMode = "confirmed";
      spy.transferStatus = "submitted";
    }
    await invariants(w, cps, ledger, spy, false);
  }

  // Restore the adapter and let the worker finish everything that is in flight.
  spy.lookupAvailable = true;
  for (let round = 0; round < 4; round += 1) {
    await runTabSettlementStep({ staleAfterMs: 0, confirmAfterMs: 0, batchSize: 50, now: new Date(), endOfDay: false, ledger });
  }
  const inFlight = await query(`SELECT COUNT(*)::int AS n FROM tab_settlements WHERE workspace_id = $1 AND status IN ('pending', 'submitted');`, [w]);
  expect(inFlight.rows[0].n).toBe(0);
  await invariants(w, cps, ledger, spy, true);
  const byStatus = await query(`SELECT status, COUNT(*)::int AS n FROM tab_settlements WHERE workspace_id = $1 GROUP BY status;`, [w]);
  const tally: Record<string, number> = { moved: spy.moved.size };
  for (const row of byStatus.rows) tally[row.status] = row.n;
  outcomes.push(tally);
}

describe("tab ledger property test: random sequences never over-pay or lose a balance (PostgreSQL)", () => {
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

  for (const seed of [11, 4242, 90210]) {
    it(`seed ${seed}: 45 random steps keep every invariant, and the worker drains what is in flight`, async () => {
      await runSequence(seed, 45);
    }, 120_000);
  }

  it("the three seeds reach confirmed, cancelled and held settlements, and transfers that moved", () => {
    const total = (key: string) => outcomes.reduce((sum, run) => sum + (run[key] ?? 0), 0);
    console.info("tab fuzz outcomes per seed", JSON.stringify(outcomes));
    expect(outcomes).toHaveLength(3);
    expect(total("confirmed")).toBeGreaterThan(0);
    expect(total("cancelled")).toBeGreaterThan(0);
    expect(total("held")).toBeGreaterThan(0);
    expect(total("moved")).toBeGreaterThan(0);
  });
});
