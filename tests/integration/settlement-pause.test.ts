import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import crypto from "crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { MatchStatus } from "../../src/accounting/three-way-match.js";
import { setAgentsPaused } from "../../src/studio/workspaceControls.js";
import type {
  SettlementAdapter,
  SettlementStatus,
  TransferRequest,
  TransferResult,
} from "../../src/adapters/settlement/types.js";

/*
 * A paused workspace pays nothing (ADR 0023). The spy adapter records every transfer that actually moved money, so a
 * test can tell a payment from a repeated call. Local test keys only. Nothing is signed or broadcast.
 */
const SIGNER = privateKeyToAccount(`0x${"33".repeat(32)}` as Hex).address;
const SUPPLIER = getAddress(privateKeyToAccount(`0x${"44".repeat(32)}` as Hex).address);
const FLOUR = "FOOD-FLOUR-50LB";
const AWAITING = "AWAITING_SETTLEMENT_CONFIRMATION";
const OWNER_ACTOR = { type: "owner" as const, id: "pause-test-owner" };

class SpySettlementAdapter implements SettlementAdapter {
  readonly mode = "local" as const;
  /** Every transfer that moved money, in order. */
  readonly moves: Array<{ orderId: string; txHash: string }> = [];
  transferCalls = 0;
  confirmStatus: SettlementStatus = "confirmed";

  async getBalance(): Promise<bigint> {
    return 1_000_000n;
  }

  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    this.transferCalls += 1;
    const txHash = `0x${crypto.createHash("sha256").update(`${req.orderId}:${this.moves.length}`).digest("hex")}`;
    this.moves.push({ orderId: req.orderId, txHash });
    return { txHash, status: this.confirmStatus === "confirmed" ? "confirmed" : "submitted", timestamp: new Date(), mode: "local", simulated: true };
  }

  async confirm(txHash: string): Promise<TransferResult> {
    return { txHash, status: this.confirmStatus, timestamp: new Date(), mode: "local", simulated: true };
  }

  async depositEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }

  async releaseEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }
}

describe("A paused workspace pays nothing, and resuming settles the same order once", () => {
  const run = Date.now();
  const wsIds: string[] = [];
  let counter = 0;
  const app = createApp();
  let server: Server;
  let baseUrl = "";

  async function newWorkspace(): Promise<string> {
    counter += 1;
    const wsId = `ws-pause-settle-${run}-${counter}`;
    wsIds.push(wsId);
    await provisionWorkspace(wsId, "Settlement Pause Kitchen", "kitchen-v1", {
      customDailyLimitCents: 100000n,
      customApprovalThresholdCents: 25000n,
    });
    await query(`UPDATE workspaces SET settlement_address = $2 WHERE id = $1;`, [wsId, SIGNER]);
    return wsId;
  }

  /** Starts a flour replenishment (confirmed, not yet paid) and makes its supplier verified and payable. */
  async function confirmedOrder(runner: ProcurementWorkflowRunner, wsId: string): Promise<{ workflowId: string; orderId: string }> {
    const started = await runner.startReplenishment(wsId, FLOUR);
    expect(started.state).toBe(WorkflowState.CONFIRMED);
    const orderId = started.orderId!;
    const supplierId = (await orderRow(orderId)).supplier_id as string;
    await query(`UPDATE suppliers SET verified = TRUE, payment_address = $2 WHERE id = $1;`, [supplierId, SUPPLIER]);
    return { workflowId: started.workflowId, orderId };
  }

  async function supplierIdOf(orderId: string): Promise<string> {
    return (await orderRow(orderId)).supplier_id as string;
  }

  async function orderRow(orderId: string): Promise<any> {
    return (await query(`SELECT * FROM orders WHERE id = $1;`, [orderId])).rows[0];
  }

  async function inventoryOf(wsId: string): Promise<number> {
    return Number((await query(`SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`, [wsId, FLOUR])).rows[0].current_quantity);
  }

  async function journalCount(orderId: string): Promise<number> {
    return (await query(`SELECT COUNT(*)::int AS n FROM accounting_journal_entries WHERE order_id = $1;`, [orderId])).rows[0].n as number;
  }

  async function transferEffectCount(wsId: string, orderId: string): Promise<number> {
    return (await query(`SELECT COUNT(*)::int AS n FROM effects WHERE idempotency_key = $1;`, [`${wsId}:settle:${orderId}`])).rows[0].n as number;
  }

  async function auditRows(wsId: string, action: string): Promise<any[]> {
    return (
      await query(
        `SELECT actor_type, actor_id, policy_decision, evidence FROM audit_logs
         WHERE workspace_id = $1 AND action = $2 ORDER BY created_at ASC;`,
        [wsId, action]
      )
    ).rows;
  }

  type Sent = { status: number; body: any };
  async function call(method: string, routePath: string, opts: { token?: string; body?: unknown } = {}): Promise<Sent> {
    const headers: Record<string, string> = {};
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${baseUrl}${routePath}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  }

  beforeAll(async () => {
    await runMigrations();
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const id of wsIds) {
      await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
      await fs.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    }
    await closePool();
  });

  it("a paused workspace does not pay a confirmed order", async () => {
    const spy = new SpySettlementAdapter();
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => spy });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);

    await setAgentsPaused(wsId, true, OWNER_ACTOR, "owner_api");
    const result = await runner.fulfillAndReconcile(orderId, wsId);

    expect(result).toEqual({ status: MatchStatus.MATCHED, reconciled: false, hold: "AGENTS_PAUSED" });
    expect(spy.transferCalls).toBe(0);
    expect(spy.moves).toHaveLength(0);
    expect((await orderRow(orderId)).tx_hash).toBeNull();
  });

  it("the order keeps its status and nothing is restocked or journaled while paused", async () => {
    const spy = new SpySettlementAdapter();
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => spy });
    const wsId = await newWorkspace();
    const { workflowId, orderId } = await confirmedOrder(runner, wsId);
    const stockBefore = await inventoryOf(wsId);

    await setAgentsPaused(wsId, true, OWNER_ACTOR, "owner_api");
    await runner.fulfillAndReconcile(orderId, wsId);
    await runner.fulfillAndReconcile(orderId, wsId);

    const order = await orderRow(orderId);
    expect(order.status).toBe("confirmed");
    expect(order.tx_hash).toBeNull();
    expect(await inventoryOf(wsId)).toBe(stockBefore);
    expect(await journalCount(orderId)).toBe(0);
    expect(await transferEffectCount(wsId, orderId)).toBe(0);
    expect((await new WorkflowEngine().getWorkflow(workflowId))!.state).toBe(WorkflowState.CONFIRMED);
    expect(await auditRows(wsId, "settlement.reconcile_and_pay")).toHaveLength(0);

    const held = await auditRows(wsId, "settlement.paused_hold");
    expect(held).toHaveLength(2);
    expect(held[0]).toMatchObject({ actor_type: "system", policy_decision: "DENY" });
    expect(held[0].evidence).toMatchObject({ orderId });
  });

  it("an order held for a payment problem is released to that same hold while paused", async () => {
    const spy = new SpySettlementAdapter();
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => spy });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);
    await query(`UPDATE suppliers SET verified = FALSE WHERE id = $1;`, [await supplierIdOf(orderId)]);

    const held = await runner.fulfillAndReconcile(orderId, wsId);
    expect(held).toEqual({ status: MatchStatus.MATCHED, reconciled: false, hold: "SUPPLIER_NOT_VERIFIED" });
    expect((await orderRow(orderId)).status).toBe("payment_hold");

    await setAgentsPaused(wsId, true, OWNER_ACTOR, "owner_api");
    await query(`UPDATE suppliers SET verified = TRUE, payment_address = $2 WHERE id = $1;`, [await supplierIdOf(orderId), SUPPLIER]);
    const paused = await runner.fulfillAndReconcile(orderId, wsId);
    expect(paused).toEqual({ status: MatchStatus.MATCHED, reconciled: false, hold: "AGENTS_PAUSED" });
    expect((await orderRow(orderId)).status).toBe("payment_hold");
    expect(spy.transferCalls).toBe(0);
  });

  it("the same order is paid once after the workspace is resumed", async () => {
    const spy = new SpySettlementAdapter();
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => spy });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);
    const stockBefore = await inventoryOf(wsId);

    await setAgentsPaused(wsId, true, OWNER_ACTOR, "owner_api");
    expect(await runner.fulfillAndReconcile(orderId, wsId)).toMatchObject({ hold: "AGENTS_PAUSED" });

    await setAgentsPaused(wsId, false, OWNER_ACTOR, "owner_api");
    const paid = await runner.fulfillAndReconcile(orderId, wsId);
    expect(paid).toMatchObject({ status: MatchStatus.MATCHED, reconciled: true, txHash: spy.moves[0].txHash });
    expect(spy.transferCalls).toBe(1);
    expect(spy.moves).toHaveLength(1);
    const stockAfterPayment = await inventoryOf(wsId);
    expect(stockAfterPayment).toBeGreaterThan(stockBefore);
    expect(await journalCount(orderId)).toBe(1);

    const again = await runner.fulfillAndReconcile(orderId, wsId);
    expect(again).toMatchObject({ reconciled: true, alreadyReconciled: true, txHash: spy.moves[0].txHash });
    expect(spy.transferCalls).toBe(1);
    expect(await inventoryOf(wsId)).toBe(stockAfterPayment);
    expect((await orderRow(orderId)).status).toBe("reconciled");
  });

  it("confirming a payment that was already sent still works while paused", async () => {
    const spy = new SpySettlementAdapter();
    spy.confirmStatus = "submitted";
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => spy });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);

    const sent = await runner.fulfillAndReconcile(orderId, wsId);
    expect(sent.pending).toBe(AWAITING);
    expect((await orderRow(orderId)).status).toBe("settlement_submitted");

    await setAgentsPaused(wsId, true, OWNER_ACTOR, "owner_api");
    spy.confirmStatus = "confirmed";
    const done = await runner.confirmSettlement(orderId, wsId);

    expect(done).toMatchObject({ status: MatchStatus.MATCHED, reconciled: true, txHash: spy.moves[0].txHash });
    expect(done.hold).toBeUndefined();
    expect(spy.transferCalls).toBe(1);
    expect(spy.moves).toHaveLength(1);
    expect((await orderRow(orderId)).status).toBe("reconciled");
  });

  it("a reconciled order still returns its stored result while paused", async () => {
    const spy = new SpySettlementAdapter();
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => spy });
    const wsId = await newWorkspace();
    const { orderId } = await confirmedOrder(runner, wsId);
    const first = await runner.fulfillAndReconcile(orderId, wsId);
    expect(first.reconciled).toBe(true);

    await setAgentsPaused(wsId, true, OWNER_ACTOR, "owner_api");
    const again = await runner.fulfillAndReconcile(orderId, wsId);

    expect(again).toEqual({ status: MatchStatus.MATCHED, reconciled: true, txHash: first.txHash, alreadyReconciled: true });
    expect(spy.transferCalls).toBe(1);
  });

  it("the reconcile route answers with the AGENTS_PAUSED hold, not an error", async () => {
    const spy = new SpySettlementAdapter();
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => spy });
    const wsId = await newWorkspace();
    const owner = await issueToken(wsId, "owner", "route-pause-owner");
    const { orderId } = await confirmedOrder(runner, wsId);

    const paused = await call("PUT", `/api/workspaces/${wsId}/agents-paused`, { token: owner.token, body: { paused: true } });
    expect(paused.status).toBe(200);

    const reconciled = await call("POST", `/api/orders/${orderId}/reconcile`, { token: owner.token });
    expect(reconciled.status).toBe(200);
    expect(reconciled.body).toEqual({ status: MatchStatus.MATCHED, reconciled: false, hold: "AGENTS_PAUSED" });
    expect(await transferEffectCount(wsId, orderId)).toBe(0);
    expect((await orderRow(orderId)).status).toBe("confirmed");
  });
});
