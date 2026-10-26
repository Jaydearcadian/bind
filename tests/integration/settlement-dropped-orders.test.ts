import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { SettlementRejectedError, TRANSFER_FAILED_RECIPIENT } from "../../src/adapters/settlement/errors.js";
import type {
  SettlementAdapter,
  TransferRequest,
  TransferResult,
} from "../../src/adapters/settlement/types.js";

/**
 * A dropped order transfer (docs/decisions/0087, item 5). The node does not know the hash, the age is met and no lookup
 * finds a transfer: the order goes to payment_hold with SETTLEMENT_DROPPED, keeps its hash, and is never sent again. A
 * transfer that later appears is adopted by an operator's settle, which replays the stored effect and sends nothing.
 */

const SIGNER = "0x1111111111111111111111111111111111111111";
const FLOUR = "FOOD-FLOUR-50LB";
const AWAITING = "AWAITING_SETTLEMENT_CONFIRMATION";

/** A settlement adapter that can drop its transfers and can report the node's not-found answer. Nothing is broadcast. */
class DroppingAdapter implements SettlementAdapter {
  readonly mode = "local" as const;
  transferCalls = 0;
  /** The next transfer is recorded as sent and never mined. */
  dropNext = false;
  readonly dropped = new Set<string>();
  /** A transfer the lookup finds, once one exists (set by a test). */
  foundHash: string | null = null;
  lookupDown = false;
  settledValue: boolean | null = null;
  rejectNext: SettlementRejectedError | null = null;

  async getBalance(): Promise<bigint> {
    return 1_000_000n;
  }

  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    this.transferCalls += 1;
    if (this.rejectNext) {
      const err = this.rejectNext;
      this.rejectNext = null;
      throw err;
    }
    const txHash = `0x${crypto.createHash("sha256").update(`${req.idempotencyKey}:${this.transferCalls}`).digest("hex")}`;
    if (this.dropNext) {
      this.dropNext = false;
      this.dropped.add(txHash);
    }
    return this.result(txHash, "submitted");
  }

  async confirm(txHash: string): Promise<TransferResult> {
    if (this.dropped.has(txHash)) return { ...this.result(txHash, "submitted"), notFoundOnNode: true };
    return this.result(txHash, "submitted");
  }

  async findTransfer(): Promise<TransferResult | null> {
    if (this.lookupDown) throw new Error("lookup: rpc unreachable");
    return this.foundHash ? this.result(this.foundHash, "confirmed") : null;
  }

  async isOrderSettled(): Promise<boolean> {
    return this.settledValue ?? false;
  }

  async depositEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }

  async releaseEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }

  private result(txHash: string, status: TransferResult["status"]): TransferResult {
    return { txHash, status, timestamp: new Date(), mode: this.mode, simulated: true };
  }
}

describe("a dropped order transfer is held, not re-sent (docs/decisions/0087, item 5)", () => {
  const wsIds: string[] = [];
  let artifactsDir = "";
  let previousArtifactsDir: string | undefined;

  beforeAll(async () => {
    await runMigrations();
    artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-settle-dropped-"));
    previousArtifactsDir = process.env.WORKFLOW_ARTIFACTS_DIR;
    process.env.WORKFLOW_ARTIFACTS_DIR = artifactsDir;
  });

  afterEach(async () => {
    for (const id of wsIds.splice(0)) await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
  });

  afterAll(async () => {
    if (previousArtifactsDir === undefined) delete process.env.WORKFLOW_ARTIFACTS_DIR;
    else process.env.WORKFLOW_ARTIFACTS_DIR = previousArtifactsDir;
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    await closePool();
  });

  async function newWorkspace(): Promise<string> {
    const wsId = `ws-settle-dropped-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    wsIds.push(wsId);
    await provisionWorkspace(wsId, "Settlement Dropped Kitchen", "kitchen-v1", {
      customDailyLimitCents: 100000n,
      customApprovalThresholdCents: 25000n,
    });
    await query(`UPDATE workspaces SET settlement_address = $2 WHERE id = $1;`, [wsId, SIGNER]);
    return wsId;
  }

  /** A confirmed, payable order for the flour SKU. The supplier is verified and paid to a fixed test address. */
  async function confirmedOrder(runner: ProcurementWorkflowRunner, wsId: string): Promise<{ orderId: string }> {
    const started = await runner.startReplenishment(wsId, FLOUR);
    expect(started.state).toBe(WorkflowState.CONFIRMED);
    const orderId = started.orderId!;
    const supplier = (await orderRow(orderId)).supplier_id as string;
    await query(`UPDATE suppliers SET verified = TRUE, payment_address = $2 WHERE id = $1;`, [
      supplier,
      "0x2222222222222222222222222222222222222222",
    ]);
    return { orderId };
  }

  async function orderRow(orderId: string): Promise<any> {
    return (await query(`SELECT * FROM orders WHERE id = $1;`, [orderId])).rows[0];
  }

  async function stockOf(wsId: string): Promise<number> {
    const res = await query(`SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`, [wsId, FLOUR]);
    return Number(res.rows[0].current_quantity);
  }

  async function auditRows(wsId: string, action: string): Promise<any[]> {
    return (
      await query(`SELECT evidence, tx_hash FROM audit_logs WHERE workspace_id = $1 AND action = $2 ORDER BY created_at, id;`, [
        wsId,
        action,
      ])
    ).rows;
  }

  it("node says not found, the age is met and no lookup finds it: payment_hold SETTLEMENT_DROPPED, one transfer, hash kept", async () => {
    const adapter = new DroppingAdapter();
    adapter.dropNext = true;
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter, droppedAfterMs: 0 });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);
    const stockBefore = await stockOf(wsId);

    const result = await runner.fulfillAndReconcile(orderId, wsId);
    expect(result).toMatchObject({ reconciled: false, hold: "SETTLEMENT_DROPPED" });

    const order = await orderRow(orderId);
    expect(order.status).toBe("payment_hold");
    expect(order.tx_hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(adapter.transferCalls).toBe(1);
    expect(await stockOf(wsId)).toBe(stockBefore);

    const dropped = await auditRows(wsId, "settlement.dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0].evidence).toMatchObject({ orderId, hold: "SETTLEMENT_DROPPED", txHash: order.tx_hash });
  });

  it("a second settle of the dropped order replays the stored effect: it is never sent again", async () => {
    const adapter = new DroppingAdapter();
    adapter.dropNext = true;
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter, droppedAfterMs: 0 });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);
    const first = await runner.fulfillAndReconcile(orderId, wsId);
    const hash = (await orderRow(orderId)).tx_hash;

    const second = await runner.fulfillAndReconcile(orderId, wsId);
    expect(second).toMatchObject({ reconciled: false, hold: "SETTLEMENT_DROPPED" });
    expect(first.hold).toBe("SETTLEMENT_DROPPED");
    expect(adapter.transferCalls, "the second settle sends nothing").toBe(1);
    expect((await orderRow(orderId)).tx_hash).toBe(hash);
  });

  it("is not dropped while younger than the age: it stays settlement_submitted", async () => {
    const adapter = new DroppingAdapter();
    adapter.dropNext = true;
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);
    expect((await runner.fulfillAndReconcile(orderId, wsId)).pending).toBe(AWAITING);
    expect((await orderRow(orderId)).status).toBe("settlement_submitted");
  });

  it("a transfer the lookup finds is adopted and the order is reconciled, not dropped", async () => {
    const adapter = new DroppingAdapter();
    adapter.dropNext = true;
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter, droppedAfterMs: 0 });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);
    adapter.foundHash = `0x${"ab".repeat(32)}`;

    const result = await runner.fulfillAndReconcile(orderId, wsId);
    expect(result).toMatchObject({ reconciled: true, txHash: adapter.foundHash });
    expect((await orderRow(orderId)).status).toBe("reconciled");
    expect(await auditRows(wsId, "settlement.dropped")).toHaveLength(0);
  });

  it("a settled order on the contract is not dropped", async () => {
    const adapter = new DroppingAdapter();
    adapter.dropNext = true;
    adapter.settledValue = true;
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter, droppedAfterMs: 0 });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);
    expect((await runner.fulfillAndReconcile(orderId, wsId)).pending).toBe(AWAITING);
    expect((await orderRow(orderId)).status).toBe("settlement_submitted");
  });

  it("a lookup that throws is not dropped: the order stays settlement_submitted", async () => {
    const adapter = new DroppingAdapter();
    adapter.dropNext = true;
    adapter.lookupDown = true;
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter, droppedAfterMs: 0 });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);
    expect((await runner.fulfillAndReconcile(orderId, wsId)).pending).toBe(AWAITING);
    expect((await orderRow(orderId)).status).toBe("settlement_submitted");
    expect(adapter.transferCalls).toBe(1);
  });

  it("a dropped order is finished by an operator's settle once the transfer appears, and is paid once", async () => {
    const adapter = new DroppingAdapter();
    adapter.dropNext = true;
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter, droppedAfterMs: 0 });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);
    await runner.fulfillAndReconcile(orderId, wsId);
    expect((await orderRow(orderId)).status).toBe("payment_hold");

    const later = `0x${"cd".repeat(32)}`;
    adapter.foundHash = later;
    const stockBefore = await stockOf(wsId);
    const result = await runner.fulfillAndReconcile(orderId, wsId);
    expect(result).toMatchObject({ reconciled: true, txHash: later });
    expect(await stockOf(wsId)).toBeGreaterThan(stockBefore);
    expect(await auditRows(wsId, "settlement.confirmed")).toHaveLength(1);
    expect(adapter.transferCalls, "the adoption sends nothing").toBe(1);
  });

  it("an adapter without the reads is never dropped: the order stays settlement_submitted, with no dropped hold", async () => {
    const adapter = new DroppingAdapter();
    adapter.dropNext = true;
    // The adapter cannot answer findTransfer or isOrderSettled (both are optional on the interface).
    (adapter as { findTransfer?: unknown }).findTransfer = undefined;
    (adapter as { isOrderSettled?: unknown }).isOrderSettled = undefined;
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter, droppedAfterMs: 0 });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);
    expect((await runner.fulfillAndReconcile(orderId, wsId)).pending).toBe(AWAITING);
    expect((await orderRow(orderId)).status).toBe("settlement_submitted");
    expect(await auditRows(wsId, "settlement.dropped")).toHaveLength(0);
    expect(adapter.transferCalls).toBe(1);
  });

  it("a TRANSFER_FAILED_RECIPIENT refusal holds the order as SETTLEMENT_REJECTED with the code in its evidence", async () => {
    const adapter = new DroppingAdapter();
    adapter.rejectNext = new SettlementRejectedError(TRANSFER_FAILED_RECIPIENT, undefined, "the recipient may be blocklisted or invalid");
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => adapter });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);
    const result = await runner.fulfillAndReconcile(orderId, wsId);
    expect(result).toMatchObject({ reconciled: false, hold: "SETTLEMENT_REJECTED" });
    expect((await orderRow(orderId)).status).toBe("payment_hold");
    const rejected = await auditRows(wsId, "settlement.rejected");
    expect(rejected[0].evidence).toMatchObject({ orderId, code: TRANSFER_FAILED_RECIPIENT });
  });
});
