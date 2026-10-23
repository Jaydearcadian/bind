import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { MatchStatus } from "../../src/accounting/three-way-match.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { SettlementRejectedError } from "../../src/adapters/settlement/errors.js";
import type {
  SettlementAdapter,
  SettlementStatus,
  TransferRequest,
  TransferResult,
} from "../../src/adapters/settlement/types.js";
import { EffectConflictError, listUnresolvedEffects } from "../../src/effects/ledger.js";
import { setEffectFault } from "../../src/effects/faults.js";

/**
 * The settlement transfer goes through the effects ledger. A spy adapter records every transfer that
 * actually moved money (`moves`), so a test can tell a real double payment from a repeated call.
 * The spy never dedupes on its own: any protection shown by these tests comes from the ledger.
 *
 * Local test keys only. Nothing is signed or broadcast.
 */
const SIGNER = privateKeyToAccount(`0x${"11".repeat(32)}` as Hex).address;
const SUPPLIER = getAddress(privateKeyToAccount(`0x${"22".repeat(32)}` as Hex).address);
const FLOUR = "FOOD-FLOUR-50LB";
const AWAITING = "AWAITING_SETTLEMENT_CONFIRMATION";

type Step = "ok" | "rejected" | "network_after_send";

/**
 * `ok`: the transfer is made and its result returned. `rejected`: SettlementRejectedError, nothing made.
 * `network_after_send`: the transfer is made, then a plain network error is thrown, so the caller cannot
 * tell whether money moved. This is the unknown outcome the ledger must handle.
 */
class SpySettlementAdapter implements SettlementAdapter {
  readonly mode = "local" as const;
  readonly requests: TransferRequest[] = [];
  /** Every transfer that moved money, in order. */
  readonly moves: Array<{ orderId: string; txHash: string }> = [];
  transferCalls = 0;
  confirmCalls = 0;
  lookupCalls = 0;
  confirmStatus: SettlementStatus = "confirmed";
  /** Present only when the adapter can look a transfer up by order id. */
  findTransfer?: (req: { orderId: string }) => Promise<TransferResult | null>;
  private readonly steps: Step[];

  constructor(opts: { lookup: boolean; steps?: Step[] }) {
    this.steps = [...(opts.steps ?? [])];
    if (opts.lookup) {
      this.findTransfer = async ({ orderId }) => {
        this.lookupCalls += 1;
        const move = this.moves.find((m) => m.orderId === orderId);
        return move ? { txHash: move.txHash, status: "confirmed", timestamp: new Date(), mode: "local", simulated: true } : null;
      };
    }
  }

  async getBalance(): Promise<bigint> {
    return 1_000_000n;
  }

  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    this.transferCalls += 1;
    this.requests.push(req);
    const step = this.steps.shift() ?? "ok";
    if (step === "rejected") throw new SettlementRejectedError("DailyLimitExceeded");

    const txHash = `0x${crypto.createHash("sha256").update(`${req.orderId}:${this.moves.length}`).digest("hex")}`;
    this.moves.push({ orderId: req.orderId, txHash });
    if (step === "network_after_send") throw new Error("socket hang up");
    return { txHash, status: "submitted", timestamp: new Date(), mode: "local", simulated: true };
  }

  async confirm(txHash: string): Promise<TransferResult> {
    this.confirmCalls += 1;
    return { txHash, status: this.confirmStatus, timestamp: new Date(), mode: "local", simulated: true };
  }

  async depositEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }

  async releaseEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }
}

describe("Settlement transfer through the effects ledger", () => {
  const wsIds: string[] = [];
  let artifactsDir = "";
  let previousArtifactsDir: string | undefined;

  beforeAll(async () => {
    await runMigrations();
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-settle-effects-"));
    previousArtifactsDir = process.env.WORKFLOW_ARTIFACTS_DIR;
    process.env.WORKFLOW_ARTIFACTS_DIR = artifactsDir;
  });

  afterEach(async () => {
    setEffectFault(null);
    for (const id of wsIds.splice(0)) {
      await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
    }
  });

  afterAll(async () => {
    if (previousArtifactsDir === undefined) delete process.env.WORKFLOW_ARTIFACTS_DIR;
    else process.env.WORKFLOW_ARTIFACTS_DIR = previousArtifactsDir;
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    await closePool();
  });

  async function newWorkspace(): Promise<string> {
    const wsId = `ws-settle-effects-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    wsIds.push(wsId);
    await provisionWorkspace(wsId, "Settlement Effects Kitchen", "kitchen-v1", {
      customDailyLimitCents: 100000n,
      customApprovalThresholdCents: 25000n,
    });
    await query(`UPDATE workspaces SET settlement_address = $2 WHERE id = $1;`, [wsId, SIGNER]);
    return wsId;
  }

  /** Starts a flour replenishment and makes its supplier verified and payable. */
  async function confirmedOrder(runner: ProcurementWorkflowRunner, wsId: string): Promise<{ workflowId: string; orderId: string }> {
    const started = await runner.startReplenishment(wsId, FLOUR);
    expect(started.state).toBe(WorkflowState.CONFIRMED);
    const orderId = started.orderId!;
    const supplierId = (await orderRow(orderId)).supplier_id as string;
    await query(`UPDATE suppliers SET verified = TRUE, payment_address = $2 WHERE id = $1;`, [supplierId, SUPPLIER]);
    return { workflowId: started.workflowId, orderId };
  }

  async function orderRow(orderId: string): Promise<any> {
    return (await query(`SELECT * FROM orders WHERE id = $1;`, [orderId])).rows[0];
  }

  async function auditRows(wsId: string, action: string): Promise<any[]> {
    const res = await query(
      `SELECT actor_type, actor_id, policy_decision, evidence FROM audit_logs
       WHERE workspace_id = $1 AND action = $2 ORDER BY created_at ASC;`,
      [wsId, action]
    );
    return res.rows;
  }

  async function transferEffectRow(wsId: string, orderId: string): Promise<any> {
    const res = await query(`SELECT * FROM effects WHERE idempotency_key = $1;`, [`${wsId}:settle:${orderId}`]);
    return res.rows[0];
  }

  it("the transfer effect key includes the workspace id and the order id", async () => {
    const spy = new SpySettlementAdapter({ lookup: true });
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => spy });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);

    const result = await runner.fulfillAndReconcile(orderId, wsId);
    expect(result).toMatchObject({ status: MatchStatus.MATCHED, reconciled: true });

    const rows = (
      await query(
        `SELECT workspace_id, operation, effect_class, status, external_ref, idempotency_key
         FROM effects WHERE idempotency_key = $1;`,
        [`${wsId}:settle:${orderId}`]
      )
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      workspace_id: wsId,
      operation: "settlement.transfer_usdc",
      effect_class: "commercial_commitment",
      status: "completed",
      external_ref: result.txHash,
    });
    expect(spy.requests[0].idempotencyKey).toBe(`idem_pay_${orderId}`);
    expect(spy.transferCalls).toBe(1);
  });

  it("a retry after an unknown transfer error asks the adapter first and does not pay twice", async () => {
    const spy = new SpySettlementAdapter({ lookup: true, steps: ["network_after_send"] });
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => spy });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);

    await expect(runner.fulfillAndReconcile(orderId, wsId)).rejects.toThrow(/socket hang up/);
    expect((await orderRow(orderId)).status).toBe("confirmed");
    expect(spy.moves).toHaveLength(1);

    const retry = await runner.fulfillAndReconcile(orderId, wsId);
    expect(retry).toMatchObject({ status: MatchStatus.MATCHED, reconciled: true, txHash: spy.moves[0].txHash });
    expect(spy.lookupCalls).toBe(1);
    expect(spy.transferCalls).toBe(1);
    expect(spy.moves).toHaveLength(1);

    const row = await orderRow(orderId);
    expect(row.status).toBe("reconciled");
    expect(row.tx_hash).toBe(spy.moves[0].txHash);
  });

  it("a retry after an unknown transfer error with no lookup holds the order in doubt", async () => {
    const spy = new SpySettlementAdapter({ lookup: false, steps: ["network_after_send"] });
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => spy });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);

    await expect(runner.fulfillAndReconcile(orderId, wsId)).rejects.toThrow(/socket hang up/);

    const retry = await runner.fulfillAndReconcile(orderId, wsId);
    expect(retry).toEqual({ status: MatchStatus.MATCHED, reconciled: false, hold: "SETTLEMENT_OUTCOME_UNKNOWN" });
    expect(spy.transferCalls).toBe(1);

    const row = await orderRow(orderId);
    expect(row.status).toBe("payment_hold");
    expect(row.tx_hash).toBeNull();

    const unresolved = await listUnresolvedEffects(wsId);
    const effect = unresolved.find((e) => e.idempotencyKey === `${wsId}:settle:${orderId}`);
    expect(effect).toMatchObject({ status: "failed", attempts: 1, operation: "settlement.transfer_usdc" });

    const inDoubt = await auditRows(wsId, "settlement.in_doubt");
    expect(inDoubt).toHaveLength(1);
    expect(inDoubt[0]).toMatchObject({ actor_type: "system", actor_id: "settlement_engine", policy_decision: "DENY" });
    expect(inDoubt[0].evidence).toMatchObject({ orderId, hold: "SETTLEMENT_OUTCOME_UNKNOWN", effectId: effect!.id, attempts: 1 });
    expect(JSON.stringify(inDoubt[0].evidence)).not.toContain(spy.moves[0].txHash);

    // Another attempt still does not reach the adapter.
    const again = await runner.fulfillAndReconcile(orderId, wsId);
    expect(again).toMatchObject({ reconciled: false, hold: "SETTLEMENT_OUTCOME_UNKNOWN" });
    expect(spy.transferCalls).toBe(1);
    expect(spy.moves).toHaveLength(1);
  });

  it("a crash after the transfer and before the effect is recorded does not pay twice", async () => {
    for (const lookup of [true, false]) {
      const spy = new SpySettlementAdapter({ lookup });
      const runner = new ProcurementWorkflowRunner({ settlementFor: () => spy });
      const wsId = await newWorkspace();
      const { orderId } = await confirmedOrder(runner, wsId);
      const key = `${wsId}:settle:${orderId}`;

      // The process dies after the transfer was made and before the ledger row is completed.
      setEffectFault({ point: "after_call_before_complete", match: (spec) => spec.idempotencyKey === key });
      await expect(runner.fulfillAndReconcile(orderId, wsId), `lookup=${lookup}`).rejects.toThrow(/injected fault/);
      expect(spy.moves, `lookup=${lookup}`).toHaveLength(1);

      const second = await runner.fulfillAndReconcile(orderId, wsId);
      if (lookup) {
        expect(second, `lookup=${lookup}`).toMatchObject({ reconciled: true, txHash: spy.moves[0].txHash });
      } else {
        expect(second, `lookup=${lookup}`).toEqual({ status: MatchStatus.MATCHED, reconciled: false, hold: "SETTLEMENT_OUTCOME_UNKNOWN" });
      }
      expect(spy.transferCalls, `lookup=${lookup}`).toBe(1);
      expect(spy.moves, `lookup=${lookup}`).toHaveLength(1);
    }
  });

  it("a rejected transfer is held as rejected and a corrected retry can pay", async () => {
    const spy = new SpySettlementAdapter({ lookup: true, steps: ["rejected"] });
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => spy });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);

    const first = await runner.fulfillAndReconcile(orderId, wsId);
    expect(first).toEqual({ status: MatchStatus.MATCHED, reconciled: false, hold: "SETTLEMENT_REJECTED" });
    expect((await orderRow(orderId)).status).toBe("payment_hold");
    expect(spy.moves).toHaveLength(0);

    const rejected = await auditRows(wsId, "settlement.rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].evidence).toEqual({ orderId, code: "DailyLimitExceeded" });

    // Nothing was sent, so the ledger asks the adapter (null) and sends again.
    const retry = await runner.fulfillAndReconcile(orderId, wsId);
    expect(retry).toMatchObject({ status: MatchStatus.MATCHED, reconciled: true, txHash: spy.moves[0].txHash });
    expect(spy.lookupCalls).toBe(1);
    expect(spy.transferCalls).toBe(2);
    expect(spy.moves).toHaveLength(1);

    const effect = await transferEffectRow(wsId, orderId);
    expect(effect).toMatchObject({ status: "completed", attempts: 2 });
  });

  it("a completed transfer is replayed from the ledger without calling the adapter", async () => {
    const spy = new SpySettlementAdapter({ lookup: true });
    spy.confirmStatus = "submitted";
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => spy });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);

    const first = await runner.fulfillAndReconcile(orderId, wsId);
    expect(first.pending).toBe(AWAITING);
    expect((await orderRow(orderId)).status).toBe("settlement_submitted");

    // The ledger has the completed transfer. The order row is put back to a claimable state with no payment
    // record, as if the write that followed the completed effect had been lost. The next settle must replay
    // the stored result and finish the payment, without a second transfer.
    await query(
      `UPDATE orders SET status = 'confirmed', tx_hash = NULL, settled_amount_cents = NULL,
         settled_receipt_id = NULL, settled_bill_id = NULL WHERE id = $1;`,
      [orderId]
    );
    spy.confirmStatus = "confirmed";

    const replay = await runner.fulfillAndReconcile(orderId, wsId);
    expect(replay).toMatchObject({ status: MatchStatus.MATCHED, reconciled: true, txHash: first.txHash });
    expect(spy.transferCalls).toBe(1);
    expect(spy.moves).toHaveLength(1);
    expect(spy.confirmCalls).toBe(2);
    expect((await orderRow(orderId)).status).toBe("reconciled");

    const effect = await transferEffectRow(wsId, orderId);
    expect(effect).toMatchObject({ status: "completed", attempts: 1 });
    expect(effect.result).toMatchObject({ txHash: first.txHash, status: "submitted" });
  });

  it("a transfer of another workspace is never adopted", async () => {
    // Order ids are globally unique, so a second workspace cannot hold the same order. The only way another
    // tenant can present this key is a row written under it for that other workspace. Such a row must refuse
    // the settlement, not be replayed or adopted.
    const spy = new SpySettlementAdapter({ lookup: true });
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => spy });
    const wsA = await newWorkspace();
    const wsB = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsA);
    const foreignHash = `0x${"ab".repeat(32)}`;
    await query(
      `INSERT INTO effects (id, workspace_id, effect_class, operation, idempotency_key, request_hash, status, result, attempts)
       VALUES ($1, $2, 'commercial_commitment', 'settlement.transfer_usdc', $3, 'foreign-hash', 'completed', $4::jsonb, 1);`,
      [`eff_foreign_${Date.now()}`, wsB, `${wsA}:settle:${orderId}`, JSON.stringify({ txHash: foreignHash, status: "confirmed" })]
    );

    const error = await runner.fulfillAndReconcile(orderId, wsA).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EffectConflictError);
    expect((error as Error).message).not.toContain(wsB);
    expect((error as Error).message).not.toContain(foreignHash);
    expect(spy.transferCalls).toBe(0);
    expect(spy.lookupCalls).toBe(0);

    const order = await orderRow(orderId);
    expect(order.status).toBe("confirmed");
    expect(order.tx_hash).toBeNull();
  });
});
