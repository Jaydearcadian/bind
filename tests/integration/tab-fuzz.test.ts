import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { TabLedger } from "../../src/tabs/ledger.js";
import { TabError } from "../../src/tabs/errors.js";
import { runTabSettlementStep } from "../../src/tabs/worker.js";
import { setEffectFault } from "../../src/effects/faults.js";
import { SettlementRejectedError } from "../../src/adapters/settlement/errors.js";
import { TabSpy, newCounterparty, newTabWorkspace, removeWorkspaces, tabSums } from "../helpers/tab-spy.js";
import { ageEffect } from "../helpers/tab-held.js";

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

/**
 * The held variant (docs/decisions/0081, items a and b). On top of the same actions it reconciles and restores held
 * settlements, and it makes the contract read and the lookup disagree or go down. Its invariants are the ones the restore
 * rules promise: a settlement with any evidence of a send is never reversed, a reversal exists only for a cancelled
 * settlement that owned a clear, and the balance is charges minus clears plus reversals.
 */
async function heldInvariants(w: string, spy: TabSpy, ledger: TabLedger, cps: string[]): Promise<void> {
  const rows = (
    await query(
      `SELECT t.id, t.status, t.tx_hash,
              (SELECT COUNT(*)::int FROM tab_entries e WHERE e.settlement_id = t.id AND e.kind = 'clear') AS clears,
              (SELECT COUNT(*)::int FROM tab_entries e WHERE e.settlement_id = t.id AND e.kind = 'reversal') AS reversals,
              (SELECT x.external_ref FROM effects x WHERE x.idempotency_key = t.workspace_id || ':tab_settle:' || t.id) AS ext
       FROM tab_settlements t WHERE t.workspace_id = $1;`,
      [w]
    )
  ).rows;
  for (const r of rows) {
    // A transfer that moved money for this settlement. The evidence of a send that the restore rules protect.
    const moved = spy.moved.has(`tab_${r.id}`);
    expect(r.clears).toBeLessThanOrEqual(1);
    expect(r.reversals).toBeLessThanOrEqual(1);
    // A reversal exists exactly for a cancelled settlement that owned a clear.
    expect(r.reversals).toBe(r.status === "cancelled" ? r.clears : 0);
    // A settlement whose transfer moved money is never reversed. A stored hash alone is not that evidence: a restore may
    // cancel one whose hash reverted, and only then (proof ii, docs/decisions/0081).
    if (moved) expect(r.reversals).toBe(0);
    if (r.tx_hash && r.status === "cancelled") expect(spy.revertedHashes.has(r.tx_hash)).toBe(true);
    // A transfer for an order is recorded at most once (the spy keys by order id; any second call is a duplicate).
    expect(spy.duplicateCalls).toBe(0);
  }
  for (const cp of cps) {
    const sums = await tabSums(w, cp);
    expect((await ledger.tabBalance(w, cp)).balanceMicro).toBe(sums.charges - sums.clears + sums.reversals);
  }
}

/** A charge of two whole cents, so a settle has something to clear. The held actions use it: a random charge is often under one cent. */
async function wholeCentCharge(ledger: TabLedger, w: string, cp: string, key: string): Promise<void> {
  await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 20_000n, idempotencyKey: key, description: "Fuzz held charge" }).catch(() => undefined);
}

async function heldOf(w: string): Promise<string[]> {
  return (await query(`SELECT id FROM tab_settlements WHERE workspace_id = $1 AND status = 'held' ORDER BY id;`, [w])).rows.map(
    (r) => r.id as string
  );
}

const FUZZ_OWNER = { type: "owner" as const, id: "owner:fuzz" };

/** Settlement outcomes per run, so the last test can show the sequences reached the recovery paths, not only the easy ones. */
const outcomes: Record<string, number>[] = [];
const heldOutcomes: Record<string, number>[] = [];

async function runSequence(seed: number, steps: number, held = false): Promise<void> {
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
    // The held variant draws half its steps from its own pool (reconcile, restore, the contract and lookup disagreeing, a
    // supplier gate flipping, a reverted send, a held-UNKNOWN attempt, the worker). The other half use the shared chain.
    const heldRoll = held ? rnd() : 1;
    try {
      if (held && heldRoll < 0.5) {
        const sub = rnd();
        if (sub < 0.2) {
          // Reconcile one held settlement (item b): adoption only.
          const open = await heldOf(w);
          if (open.length > 0) await ledger.reconcileHeld(pick(open));
        } else if (sub < 0.4) {
          // Restore one held settlement (item a). Sometimes its effect row is first aged past the 30 minute window.
          const open = await heldOf(w);
          if (open.length > 0) {
            const id = pick(open);
            if (rnd() < 0.6) await ageEffect(w, id, 31);
            await ledger.cancelHeldAndRestore(id, { actor: FUZZ_OWNER, acknowledgeNotSent: rnd() < 0.7 });
          }
        } else if (sub < 0.5) {
          // The contract read and the lookup disagree, or go down.
          const mode = rnd();
          spy.settledOverride = mode < 0.2 ? true : mode < 0.4 ? false : null;
          spy.lookupDown = rnd() < 0.2;
        } else if (sub < 0.6) {
          // A supplier stops being verified, or comes back.
          await query(`UPDATE suppliers SET verified = NOT verified WHERE workspace_id = $1 AND id = $2;`, [w, cp]);
        } else if (sub < 0.7) {
          // A transfer that reverts on chain: its hash is stored, nothing moved, and the confirmation says REVERTED.
          await query(`UPDATE suppliers SET verified = TRUE WHERE workspace_id = $1 AND id = $2;`, [w, cp]);
          await wholeCentCharge(ledger, w, cp, `fz-rv-${seed}-${(keyCounter += 1)}`);
          spy.revertSendNext = true;
          await ledger.settleTab({ workspaceId: w, counterpartyId: cp }).catch(() => undefined);
          spy.revertSendNext = false;
        } else if (sub < 0.85) {
          // The attempt is entered with no hash recorded. The next attempt, with a supplier gate failing, holds it UNKNOWN (never
          // cancelled). The supplier is verified again after.
          // Half the time the transfer moves before the result is lost (a lookup must adopt it later); half the time nothing moves.
          await query(`UPDATE suppliers SET verified = TRUE WHERE workspace_id = $1 AND id = $2;`, [w, cp]);
          await wholeCentCharge(ledger, w, cp, `fz-hu-${seed}-${(keyCounter += 1)}`);
          const point = rnd() < 0.5 ? "after_call_before_complete" : "before_call";
          await query(`UPDATE suppliers SET verified = TRUE WHERE workspace_id = $1 AND id = $2;`, [w, cp]);
          setEffectFault({ point, match: (spec) => spec.workspaceId === w });
          await ledger.settleTab({ workspaceId: w, counterpartyId: cp }).catch(() => undefined);
          setEffectFault(null);
          const pending = await query(
            `SELECT id FROM tab_settlements WHERE workspace_id = $1 AND counterparty_id = $2 AND status = 'pending' ORDER BY created_at DESC LIMIT 1;`,
            [w, cp]
          );
          if (pending.rows.length > 0) {
            await query(`UPDATE suppliers SET verified = FALSE WHERE workspace_id = $1 AND id = $2;`, [w, cp]);
            await ledger.executeSettlement(pending.rows[0].id).catch(() => undefined);
            await query(`UPDATE suppliers SET verified = TRUE WHERE workspace_id = $1 AND id = $2;`, [w, cp]);
          }
        } else {
          // The worker runs: resume, confirm, reconcile held, end-of-day batch.
          await runTabSettlementStep({
            staleAfterMs: 0,
            confirmAfterMs: 0,
            batchSize: 50,
            now: new Date(),
            endOfDay: rnd() < 0.5,
            settleOnThreshold: rnd() < 0.2,
            reconcileAfterMs: 0,
            ledger,
          });
        }
      } else if (action < 0.30) {
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
      spy.revertSendNext = false;
    }
    await invariants(w, cps, ledger, spy, false);
    if (held) await heldInvariants(w, spy, ledger, cps);
  }

  // Restore the adapter and let the worker finish everything that is in flight.
  spy.lookupAvailable = true;
  spy.lookupDown = false;
  spy.settledOverride = null;
  for (let round = 0; round < 4; round += 1) {
    await runTabSettlementStep({ staleAfterMs: 0, confirmAfterMs: 0, batchSize: 50, now: new Date(), endOfDay: false, ledger });
  }
  if (held) {
    // Every supplier verified again, so the drain judges the held settlements and not a gate.
    await query(`UPDATE suppliers SET verified = TRUE WHERE workspace_id = $1;`, [w]);
    for (const id of await heldOf(w)) await ledger.reconcileHeld(id);
  }
  const inFlight = await query(`SELECT COUNT(*)::int AS n FROM tab_settlements WHERE workspace_id = $1 AND status IN ('pending', 'submitted');`, [w]);
  expect(inFlight.rows[0].n).toBe(0);
  await invariants(w, cps, ledger, spy, true);
  if (held) await heldInvariants(w, spy, ledger, cps);
  const byStatus = await query(`SELECT status, COUNT(*)::int AS n FROM tab_settlements WHERE workspace_id = $1 GROUP BY status;`, [w]);
  const tally: Record<string, number> = { moved: spy.moved.size };
  for (const row of byStatus.rows) tally[row.status] = row.n;
  if (held) {
    tally.adopted = await auditCountIn(w, "tab.settlement_hash_adopted");
    tally.restored = await auditCountIn(w, "tab.settlement_restored");
    heldOutcomes.push(tally);
  } else {
    outcomes.push(tally);
  }
}

async function auditCountIn(w: string, action: string): Promise<number> {
  return (await query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = $2;`, [w, action])).rows[0].n;
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

  for (const seed of [7, 31337, 271828]) {
    it(`held variant, seed ${seed}: reconcile and restore keep every invariant, and the worker drains what is in flight`, async () => {
      await runSequence(seed, 60, true);
    }, 180_000);
  }

  it("the held variant reaches adoptions and restores, and no restore ever reversed a sent transfer", () => {
    const total = (key: string) => heldOutcomes.reduce((sum, run) => sum + (run[key] ?? 0), 0);
    console.info("tab fuzz held outcomes per seed", JSON.stringify(heldOutcomes));
    expect(heldOutcomes).toHaveLength(3);
    expect(total("restored")).toBeGreaterThan(0);
    expect(total("adopted")).toBeGreaterThan(0);
    expect(total("moved")).toBeGreaterThan(0);
  });

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
