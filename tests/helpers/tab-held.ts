import { query } from "../../src/db/client.js";
import { TabLedger } from "../../src/tabs/ledger.js";
import { setEffectFault } from "../../src/effects/faults.js";
import { TabSpy, newCounterparty, newTabWorkspace } from "./tab-spy.js";

/**
 * Shared set-up for the tests of held tab settlements (docs/decisions/0081, items a and b). Each helper leaves the database
 * in the state a real failure leaves it in, using the same code path, so the tests exercise that path and not a fixture.
 */

/** Polls until the condition holds, so a test can wait for another caller to reach a known point. */
export async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The effect row of one tab settlement, by its key (`<workspace>:tab_settle:<settlement>`). */
export async function effectOf(workspaceId: string, settlementId: string) {
  const res = await query(`SELECT status, external_ref, updated_at FROM effects WHERE idempotency_key = $1;`, [
    `${workspaceId}:tab_settle:${settlementId}`,
  ]);
  return res.rows[0] ?? null;
}

/** Moves an effect row's last update back in time, so the 30-minute window of a restore has passed (a test clock only). */
export async function ageEffect(workspaceId: string, settlementId: string, minutes: number): Promise<void> {
  await query(`UPDATE effects SET updated_at = NOW() - ($2::int * INTERVAL '1 minute') WHERE idempotency_key = $1;`, [
    `${workspaceId}:tab_settle:${settlementId}`,
    minutes,
  ]);
}

export async function auditRowsWithHash(workspaceId: string, action: string, txHash: string) {
  return (
    await query(`SELECT evidence FROM audit_logs WHERE workspace_id = $1 AND action = $2 AND tx_hash = $3;`, [workspaceId, action, txHash])
  ).rows;
}

/** Workspaces made by heldUnknown. The worker's held step is global, so every test must remove these as well. */
const heldWorkspaces: string[] = [];

/** Returns and forgets the workspaces heldUnknown made. Call it in afterEach next to the test's own cleanup. */
export function drainHeldWorkspaces(): string[] {
  return heldWorkspaces.splice(0);
}

export interface HeldSetup {
  spy: TabSpy;
  ledger: TabLedger;
  w: string;
  cp: string;
  settlementId: string;
}

/**
 * A settlement held UNKNOWN with an effect row that has no hash. The gate path of executeLocked produces it: an earlier
 * attempt entered the effect row, then a supplier gate failed, so the next attempt holds the clear instead of cancelling it.
 * `fault` decides whether the transfer moved: `after_call_before_complete` moves it and loses the result, `before_call`
 * never calls the adapter.
 */
export async function heldUnknown(opts: {
  fault: "after_call_before_complete" | "before_call";
  label: string;
  spy?: TabSpy;
}): Promise<HeldSetup> {
  const spy = opts.spy ?? new TabSpy();
  const ledger = new TabLedger({ settlementFor: () => spy });
  const w = await newTabWorkspace(opts.label);
  heldWorkspaces.push(w);
  const cp = await newCounterparty(w);
  await ledger.accrueCharge({ workspaceId: w, counterpartyId: cp, amountMicro: 50_000n, idempotencyKey: `${opts.label}-c`, description: "Dish" });
  const reserved = await ledger.reserveSettlement({ workspaceId: w, counterpartyId: cp });
  if (reserved.kind !== "reserved") throw new Error("expected a reservation");
  const settlementId = reserved.settlement.settlementId;
  setEffectFault({ point: opts.fault, match: (spec) => spec.workspaceId === w });
  await ledger.executeSettlement(settlementId).catch(() => undefined);
  setEffectFault(null);
  // The supplier stops being verified before the next attempt: the gate fails with an effect row already entered.
  await query(`UPDATE suppliers SET verified = FALSE WHERE workspace_id = $1 AND id = $2;`, [w, cp]);
  const held = await ledger.executeSettlement(settlementId);
  await query(`UPDATE suppliers SET verified = TRUE WHERE workspace_id = $1 AND id = $2;`, [w, cp]);
  if (JSON.stringify(held) !== JSON.stringify({ kind: "held", hold: "SETTLEMENT_OUTCOME_UNKNOWN" })) {
    throw new Error(`expected the settlement to be held UNKNOWN, got ${JSON.stringify(held)}`);
  }
  return { spy, ledger, w, cp, settlementId };
}
