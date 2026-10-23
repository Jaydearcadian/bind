import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import crypto from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { WorkflowCrashRecoveryRunner } from "../../src/workflows/recovery.js";
import { SimulatedSupplierAdapter } from "../../src/adapters/suppliers/simulated.js";
import type { SupplierAdapter, OrderRequest } from "../../src/adapters/suppliers/types.js";
import type {
  SettlementAdapter,
  SettlementStatus,
  TransferRequest,
  TransferResult,
} from "../../src/adapters/settlement/types.js";
import { acquireAdvisoryLock } from "../../src/db/advisory-lock.js";
import { setEffectFault } from "../../src/effects/faults.js";
import { runTick, startWorker, type TickOptions } from "../../src/workers/runner.js";

/**
 * The background worker (ADR 0029). Each test drives `runTick` (or `startWorker`) directly with injected deps:
 * a supplier spy records every order submission, and a settlement spy records every transfer and every confirm.
 * The worker is global (it scans every workspace), so each test asserts on its own rows and on the spy calls for
 * its own orders, never on a global count. Ages are set with SQL, not with sleeps.
 *
 * Local test keys and addresses only. Nothing is signed or broadcast.
 */

const run = Date.now();
const FLOUR = "FOOD-FLOUR-50LB"; // par 6, on hand 3, reorder 10 x $24.50 = $245.00
const FLOUR_TOTAL = 24500n;
const PAYER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;

const engine = new WorkflowEngine();
const created: string[] = [];
let counter = 0;

function nextLabel(label: string): string {
  counter += 1;
  return `${label}${counter}`;
}

async function newWorkspace(label: string): Promise<string> {
  const id = `wkr-${nextLabel(label)}-${run}`;
  await provisionWorkspace(id, `Worker ${label}`, "kitchen-v1", {
    customDailyLimitCents: 10_000_000n,
    customApprovalThresholdCents: 10_000_000n,
  });
  await query(`UPDATE workspaces SET settlement_address = $2 WHERE id = $1;`, [id, PAYER]);
  created.push(id);
  return id;
}

/** Records every order submission. `lookup` decides whether the adapter can look an order up after a crash. */
function supplierSpy(options: { lookup: boolean }) {
  const base = new SimulatedSupplierAdapter("supp-sysco-metro", "Spy Supplier", 1.0);
  const submits: OrderRequest[] = [];
  const adapter: SupplierAdapter = {
    supplierId: base.supplierId,
    supplierName: base.supplierName,
    isSimulated: true,
    requestQuote: (req) => base.requestQuote(req),
    submitOrder: async (req) => {
      submits.push(req);
      return base.submitOrder(req);
    },
    generateDeliveryReceipt: (orderId, sku, quantity) => base.generateDeliveryReceipt(orderId, sku, quantity),
    generateBill: (orderId, sku, quantity, unitPriceCents, vendorId) =>
      base.generateBill(orderId, sku, quantity, unitPriceCents, vendorId),
    ...(options.lookup ? { lookupOrder: (req) => base.lookupOrder(req) } : {}),
  };
  return { adapter, submits };
}

/**
 * Records every transfer and every confirm. `transferStatus` and `confirmStatus` script the outcome. When
 * `confirmGate` is set, each confirm waits for it, which holds a tick open.
 */
class WorkerSettlementSpy implements SettlementAdapter {
  readonly mode = "local" as const;
  transferStatus: SettlementStatus = "submitted";
  confirmStatus: SettlementStatus = "submitted";
  confirmGate: Promise<void> | null = null;
  /** Every transfer that was made, in order (money moved). */
  readonly transfers: TransferRequest[] = [];
  /** Every transaction hash the worker asked about. */
  readonly confirmCalls: string[] = [];
  private seq = 0;

  async getBalance(): Promise<bigint> {
    return 1_000_000n;
  }

  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    this.transfers.push(req);
    this.seq += 1;
    const txHash = `0x${crypto.createHash("sha256").update(`${req.idempotencyKey}:${this.seq}`).digest("hex")}`;
    return this.result(txHash, this.transferStatus);
  }

  async confirm(txHash: string): Promise<TransferResult> {
    this.confirmCalls.push(txHash);
    if (this.confirmGate) await this.confirmGate;
    return this.result(txHash, this.confirmStatus);
  }

  async depositEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }

  async releaseEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }

  private result(txHash: string, status: SettlementStatus): TransferResult {
    return { txHash, status, timestamp: new Date(), mode: "local", simulated: true };
  }
}

function harness(options: { lookup?: boolean } = {}) {
  const supplier = supplierSpy({ lookup: options.lookup ?? true });
  const settle = new WorkerSettlementSpy();
  const deps = { supplierFor: () => supplier.adapter, settlementFor: () => settle };
  return {
    supplier,
    settle,
    deps,
    opts: (extra: TickOptions = {}): TickOptions => ({ deps, ...extra }),
  };
}

type Harness = ReturnType<typeof harness>;

async function seedQuote(input: {
  workspaceId: string;
  quoteId: string;
  supplierId: string;
  validUntilSql: string;
}): Promise<void> {
  await query(
    `INSERT INTO quotes (id, workspace_id, rfq_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, currency, valid_until, created_at)
     VALUES ($1, $2, $3, $4, 'Sysco Metro Distribution', $5, 10, 2450, $6, 'USDC', NOW() + $7::interval, NOW());`,
    [input.quoteId, input.workspaceId, `rfq_${input.quoteId}`, input.supplierId, FLOUR, FLOUR_TOTAL, input.validUntilSql]
  );
}

/** A workflow AUTHORIZED against a stored quote, as a crash between authorization and submission leaves it. */
async function seedAuthorized(workspaceId: string, label: string): Promise<string> {
  const name = nextLabel(label);
  const quoteId = `quote_${name}_${run}`;
  const workflowId = `wf_${name}_${run}`;
  await seedQuote({ workspaceId, quoteId, supplierId: `${workspaceId}_supp-sysco-metro`, validUntilSql: "1 day" });
  await engine.createWorkflow(workflowId, workspaceId, "kitchen_replenishment", `idem_${workflowId}`, {
    itemName: "Organic All-Purpose Flour",
    quote: {
      quoteId,
      rfqId: `rfq_${quoteId}`,
      supplierId: `${workspaceId}_supp-sysco-metro`,
      supplierName: "Sysco Metro Distribution",
      sku: FLOUR,
      quantity: 10,
      unitPriceCents: "2450",
      totalPriceCents: FLOUR_TOTAL.toString(),
    },
  });
  await engine.transition(workflowId, { fromState: WorkflowState.DRAFT, toState: WorkflowState.AUTHORIZED });
  return workflowId;
}

/** A workflow waiting for an owner approval whose window ends `expiredBy` ago (an SQL interval, e.g. '1 minute'). */
async function seedApproval(workspaceId: string, label: string, expiredBy: string): Promise<{ workflowId: string; approvalId: string }> {
  const name = nextLabel(label);
  const workflowId = `wf_${name}_${run}`;
  const approvalId = `appr_${name}_${run}`;
  await engine.createWorkflow(workflowId, workspaceId, "kitchen_replenishment", `idem_${workflowId}`, {
    itemName: "Organic All-Purpose Flour",
    quote: { quoteId: `quote_${name}`, supplierId: `${workspaceId}_supp-sysco-metro`, sku: FLOUR, quantity: 10, totalPriceCents: FLOUR_TOTAL.toString() },
  });
  await engine.transition(workflowId, { fromState: WorkflowState.DRAFT, toState: WorkflowState.AWAITING_APPROVAL });
  await engine.createApproval(approvalId, workspaceId, "order", workflowId, "submit_order", FLOUR_TOTAL, "procurement");
  await query(`UPDATE approvals SET expires_at = NOW() - $2::interval WHERE id = $1;`, [approvalId, expiredBy]);
  return { workflowId, approvalId };
}

/** Starts a flour replenishment, verifies its supplier and submits it to the settlement adapter, which reports `submitted`. */
async function settledOrder(h: Harness, workspaceId: string): Promise<{ orderId: string; workflowId: string; txHash: string }> {
  const runner = new ProcurementWorkflowRunner({ supplierFor: () => h.supplier.adapter, settlementFor: () => h.settle });
  const started = await runner.startReplenishment(workspaceId, FLOUR);
  expect(started.state).toBe(WorkflowState.CONFIRMED);
  const orderId = started.orderId!;
  const supplierId = (await orderRow(orderId)).supplier_id as string;
  await query(`UPDATE suppliers SET verified = TRUE, payment_address = $2 WHERE id = $1;`, [supplierId, PAYEE]);
  h.settle.transferStatus = "submitted";
  h.settle.confirmStatus = "submitted";
  const result = await runner.fulfillAndReconcile(orderId, workspaceId);
  expect(result.pending).toBe("AWAITING_SETTLEMENT_CONFIRMATION");
  // settle asks the adapter once after a submitted transfer. Only the worker's own confirm calls are counted.
  h.settle.confirmCalls.splice(0);
  return { orderId, workflowId: started.workflowId, txHash: result.txHash! };
}

async function orderRow(orderId: string): Promise<any> {
  return (await query(`SELECT * FROM orders WHERE id = $1;`, [orderId])).rows[0];
}

async function orderStatus(orderId: string): Promise<string> {
  return (await orderRow(orderId)).status;
}

async function workflowState(workflowId: string): Promise<WorkflowState> {
  return (await engine.getWorkflow(workflowId))!.state;
}

async function approvalStatus(approvalId: string): Promise<string> {
  return (await query(`SELECT status FROM approvals WHERE id = $1;`, [approvalId])).rows[0].status;
}

async function ageWorkflow(workflowId: string, interval: string): Promise<void> {
  await query(`UPDATE workflows SET updated_at = NOW() - $2::interval WHERE id = $1;`, [workflowId, interval]);
}

async function ageOrder(orderId: string, interval: string): Promise<void> {
  await query(`UPDATE orders SET updated_at = NOW() - $2::interval WHERE id = $1;`, [orderId, interval]);
}

/** Puts an order in `settling` as a process that died while holding the claim would leave it. */
async function strandSettling(orderId: string, interval: string): Promise<void> {
  await query(`UPDATE orders SET status = 'settling', updated_at = NOW() - $2::interval WHERE id = $1;`, [orderId, interval]);
}

function submitsFor(h: Harness, workflowId: string): number {
  return h.supplier.submits.filter((r) => r.orderId === `ord_${workflowId}`).length;
}

function confirmsFor(h: Harness, txHash: string): number {
  return h.settle.confirmCalls.filter((hash) => hash === txHash).length;
}

function transfersFor(h: Harness, orderId: string): number {
  return h.settle.transfers.filter((req) => req.orderId === orderId).length;
}

async function auditCount(workspaceId: string, action: string, workflowId?: string): Promise<number> {
  const res = await query(
    `SELECT COUNT(*)::int AS n FROM audit_logs
     WHERE workspace_id = $1 AND action = $2 AND ($3::text IS NULL OR workflow_id = $3);`,
    [workspaceId, action, workflowId ?? null]
  );
  return res.rows[0].n;
}

async function stockOf(workspaceId: string, sku: string): Promise<number> {
  const res = await query(`SELECT current_quantity FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`, [workspaceId, sku]);
  return Number(res.rows[0].current_quantity);
}

async function journalCount(orderId: string): Promise<number> {
  const res = await query(`SELECT COUNT(*)::int AS n FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
  return res.rows[0].n;
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("the background worker (PostgreSQL)", () => {
  const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-worker-"));
  let previousArtifactsDir: string | undefined;

  beforeAll(async () => {
    await runMigrations();
    previousArtifactsDir = process.env.WORKFLOW_ARTIFACTS_DIR;
    process.env.WORKFLOW_ARTIFACTS_DIR = artifactsDir;
  });

  afterEach(async () => {
    setEffectFault(null);
    vi.restoreAllMocks();
    for (const id of created.splice(0)) {
      await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
    }
  });

  afterAll(async () => {
    if (previousArtifactsDir === undefined) delete process.env.WORKFLOW_ARTIFACTS_DIR;
    else process.env.WORKFLOW_ARTIFACTS_DIR = previousArtifactsDir;
    fs.rmSync(artifactsDir, { recursive: true, force: true });
    await closePool();
  });

  it("an untouched approval expires without anyone reading the list", async () => {
    const ws = await newWorkspace("expiry");
    const h = harness();
    const { workflowId, approvalId } = await seedApproval(ws, "untouched", "1 minute");
    expect(await approvalStatus(approvalId)).toBe("pending");

    const report = await runTick(h.opts());

    expect(await approvalStatus(approvalId)).toBe("expired");
    expect(await workflowState(workflowId)).toBe(WorkflowState.CANCELLED);
    expect(report.expiry.expired).toBeGreaterThanOrEqual(1);
    expect(report.errors.filter((e) => e.step === "expiry")).toEqual([]);
  });

  it("the worker resumes an interrupted workflow once", async () => {
    const ws = await newWorkspace("resume");
    const h = harness();
    const workflowId = await seedAuthorized(ws, "resume");
    await ageWorkflow(workflowId, "1 hour");

    await runTick(h.opts());

    expect(await workflowState(workflowId)).toBe(WorkflowState.CONFIRMED);
    expect(submitsFor(h, workflowId)).toBe(1);
    expect(await auditCount(ws, "orders.submit", workflowId)).toBe(1);

    await runTick(h.opts());

    expect(submitsFor(h, workflowId)).toBe(1);
    expect(await auditCount(ws, "orders.submit", workflowId)).toBe(1);
    expect(await workflowState(workflowId)).toBe(WorkflowState.CONFIRMED);
  });

  it("a workflow a live request is still handling is left alone", async () => {
    const ws = await newWorkspace("live");
    const h = harness();
    // Fresh: updated_at is now, as it is while a request is still in progress.
    const workflowId = await seedAuthorized(ws, "live");

    await runTick(h.opts());

    expect(submitsFor(h, workflowId)).toBe(0);
    expect(await workflowState(workflowId)).toBe(WorkflowState.AUTHORIZED);
  });

  it("two workers running together do not duplicate effects", async () => {
    const ws = await newWorkspace("twoworkers");
    const h = harness();
    const workflowId = await seedAuthorized(ws, "two");
    await ageWorkflow(workflowId, "1 hour");
    const { approvalId } = await seedApproval(ws, "two", "1 minute");
    const { orderId, txHash } = await settledOrder(h, ws);
    await ageOrder(orderId, "1 hour");
    h.settle.confirmStatus = "confirmed";

    await Promise.all([runTick(h.opts()), runTick(h.opts())]);

    expect(submitsFor(h, workflowId)).toBe(1);
    expect(await auditCount(ws, "orders.submit", workflowId)).toBe(1);
    expect(await approvalStatus(approvalId)).toBe("expired");
    expect(confirmsFor(h, txHash)).toBe(1);
    expect(await orderStatus(orderId)).toBe("reconciled");
    expect(await auditCount(ws, "settlement.reconcile_and_pay")).toBe(1);
  });

  it("stop() waits for the current tick and rejects new work", async () => {
    const ws = await newWorkspace("stop");
    const h = harness();
    const { orderId, txHash } = await settledOrder(h, ws);
    await ageOrder(orderId, "1 hour");
    let release!: () => void;
    h.settle.confirmGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const worker = startWorker({ intervalMs: 60_000, ...h.opts() });
    const ticking = worker.tickNow();
    await waitFor(() => confirmsFor(h, txHash) === 1);

    // A second tick requested while one is in progress joins it. It does not start another.
    const joined = worker.tickNow();
    await sleep(20);
    expect(confirmsFor(h, txHash)).toBe(1);

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await sleep(50);
    expect(stopped).toBe(false);

    release();
    await ticking;
    await joined;
    await stopping;
    expect(stopped).toBe(true);
    await expect(worker.tickNow()).rejects.toThrow(/stopped/i);
  });

  it("a tick is bounded by batch size", async () => {
    const ws = await newWorkspace("batchexp");
    const h = harness();
    // Ten approvals, all older than any other pending one, so they are the oldest first.
    for (let i = 0; i < 10; i += 1) {
      await seedApproval(ws, "batchexp", `${30 * 24 * 60 - i} minutes`);
    }
    const countExpired = async () =>
      (await query(`SELECT COUNT(*)::int AS n FROM approvals WHERE workspace_id = $1 AND status = 'expired';`, [ws])).rows[0].n;

    await runTick(h.opts({ batchSize: 3 }));
    expect(await countExpired()).toBe(3);
    await runTick(h.opts({ batchSize: 3 }));
    expect(await countExpired()).toBe(6);
  });

  it("a tick is bounded by batch size for settlement confirmations", async () => {
    const h = harness();
    const orders: Array<{ orderId: string; txHash: string }> = [];
    for (let i = 0; i < 10; i += 1) {
      const ws = await newWorkspace("batchset");
      const order = await settledOrder(h, ws);
      // Oldest first: the first order was touched longest ago.
      await ageOrder(order.orderId, `${2 * 60 * 60 - i} seconds`);
      orders.push({ orderId: order.orderId, txHash: order.txHash });
    }
    const confirmedSoFar = () => orders.filter((o) => confirmsFor(h, o.txHash) > 0).length;

    await runTick(h.opts({ batchSize: 3 }));
    expect(confirmedSoFar()).toBe(3);
    await runTick(h.opts({ batchSize: 3 }));
    expect(confirmedSoFar()).toBe(6);
  });

  it("settlement confirmation finishes a submitted payment once", async () => {
    const ws = await newWorkspace("finish");
    const h = harness();
    const { orderId, workflowId, txHash } = await settledOrder(h, ws);
    await ageOrder(orderId, "1 hour");
    const stockBefore = await stockOf(ws, FLOUR);
    h.settle.confirmStatus = "confirmed";

    await runTick(h.opts());

    const order = await orderRow(orderId);
    expect(order.status).toBe("reconciled");
    expect(order.tx_hash).toBe(txHash);
    expect(await workflowState(workflowId)).toBe(WorkflowState.RECONCILED);
    expect(await stockOf(ws, FLOUR)).toBe(stockBefore + Number(order.quantity));
    expect(await journalCount(orderId)).toBe(1);
    expect(await auditCount(ws, "settlement.reconcile_and_pay", workflowId)).toBe(1);

    await runTick(h.opts());

    expect(confirmsFor(h, txHash)).toBe(1);
    expect(await stockOf(ws, FLOUR)).toBe(stockBefore + Number(order.quantity));
    expect(await journalCount(orderId)).toBe(1);
    expect(await auditCount(ws, "settlement.reconcile_and_pay", workflowId)).toBe(1);
  });

  it("a settlement that is still unconfirmed is polled again only after the wait", async () => {
    const ws = await newWorkspace("wait");
    const h = harness();
    const { orderId, txHash } = await settledOrder(h, ws);
    await ageOrder(orderId, "1 hour");
    const opts = h.opts({ confirmAfterMs: 60_000 });

    await runTick(opts);
    expect(confirmsFor(h, txHash)).toBe(1);
    expect(await orderStatus(orderId)).toBe("settlement_submitted");

    // The pending answer refreshed updated_at, so an immediate tick does not ask again.
    await runTick(opts);
    expect(confirmsFor(h, txHash)).toBe(1);

    await ageOrder(orderId, "61 seconds");
    await runTick(opts);
    expect(confirmsFor(h, txHash)).toBe(2);
    expect(await orderStatus(orderId)).toBe("settlement_submitted");
  });

  it("an order older than the poll window is not polled again", async () => {
    const ws = await newWorkspace("window");
    const h = harness();
    const { orderId, txHash } = await settledOrder(h, ws);
    await ageOrder(orderId, "1 hour");
    // The payment was sent 25 hours ago. The window is measured from the transfer, not from the last poll.
    await query(
      `UPDATE effects SET created_at = NOW() - INTERVAL '25 hours'
       WHERE idempotency_key = $1 AND operation = 'settlement.transfer_usdc';`,
      [`${ws}:settle:${orderId}`]
    );

    await runTick(h.opts({ maxPollAgeMs: 24 * 60 * 60 * 1000 }));

    expect(confirmsFor(h, txHash)).toBe(0);
    expect(await orderStatus(orderId)).toBe("settlement_submitted");
  });

  it("a stuck settling order with a transaction hash becomes settlement_submitted and is then confirmed", async () => {
    const ws = await newWorkspace("stuckhash");
    const h = harness();
    const { orderId, workflowId, txHash } = await settledOrder(h, ws);
    // The transfer was recorded, then the process died while the order was claimed for confirmation.
    await strandSettling(orderId, "1 hour");

    await runTick(h.opts());

    expect(await orderStatus(orderId)).toBe("settlement_submitted");
    expect((await orderRow(orderId)).tx_hash).toBe(txHash);
    expect(await auditCount(ws, "settlement.recovered_to_submitted")).toBe(1);
    expect(transfersFor(h, orderId)).toBe(1);

    // Step 3 runs before step 4, so the recovered order is confirmed on the next tick, once its wait has passed.
    await ageOrder(orderId, "1 hour");
    h.settle.confirmStatus = "confirmed";
    await runTick(h.opts());

    expect(await orderStatus(orderId)).toBe("reconciled");
    expect(await workflowState(workflowId)).toBe(WorkflowState.RECONCILED);
    expect(transfersFor(h, orderId)).toBe(1);
    expect(await journalCount(orderId)).toBe(1);
  });

  it("a stuck settling order without a hash becomes payment_hold and is never resent by the worker", async () => {
    const ws = await newWorkspace("stuckhold");
    const h = harness();
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => h.supplier.adapter, settlementFor: () => h.settle });
    const started = await runner.startReplenishment(ws, FLOUR);
    const orderId = started.orderId!;
    await query(`UPDATE suppliers SET verified = TRUE, payment_address = $2 WHERE id = $1;`, [
      (await orderRow(orderId)).supplier_id,
      PAYEE,
    ]);
    await strandSettling(orderId, "1 hour");

    await runTick(h.opts());

    expect(await orderStatus(orderId)).toBe("payment_hold");
    expect((await orderRow(orderId)).tx_hash).toBeNull();
    const holds = await query(
      `SELECT evidence FROM audit_logs WHERE workspace_id = $1 AND action = 'settlement.recovered_to_hold';`,
      [ws]
    );
    expect(holds.rows).toHaveLength(1);
    expect(holds.rows[0].evidence).toEqual({ orderId, hold: "SETTLEMENT_OUTCOME_UNKNOWN" });

    await runTick(h.opts());
    await ageOrder(orderId, "1 hour");
    await runTick(h.opts());

    expect(transfersFor(h, orderId)).toBe(0);
    expect(await orderStatus(orderId)).toBe("payment_hold");
  });

  it("a settling order that is still fresh is left alone", async () => {
    const ws = await newWorkspace("fresh");
    const h = harness();
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => h.supplier.adapter, settlementFor: () => h.settle });
    const started = await runner.startReplenishment(ws, FLOUR);
    const orderId = started.orderId!;
    await query(`UPDATE orders SET status = 'settling' WHERE id = $1;`, [orderId]);

    await runTick(h.opts());

    expect(await orderStatus(orderId)).toBe("settling");
    expect(await auditCount(ws, "settlement.recovered_to_hold")).toBe(0);
  });

  it("a failing step is reported and the other steps still run", async () => {
    const ws = await newWorkspace("failstep");
    const h = harness();
    const workflowId = await seedAuthorized(ws, "failstep");
    await ageWorkflow(workflowId, "1 hour");
    vi.spyOn(WorkflowEngine.prototype, "expireApprovals").mockRejectedValueOnce(new Error("expiry step failed for test"));

    const report = await runTick(h.opts());

    expect(report.errors).toContainEqual({ step: "expiry", error: "expiry step failed for test" });
    expect(report.expiry.skipped).toBe(false);
    expect(submitsFor(h, workflowId)).toBe(1);
    expect(await workflowState(workflowId)).toBe(WorkflowState.CONFIRMED);
  });

  it("an error message in the tick report is redacted and bounded", async () => {
    const h = harness();
    const token = `bnd_${"A".repeat(43)}`;
    const secretUrl = "postgres://bind_local:bind_local_only@127.0.0.1:5432/bind_local";
    vi.spyOn(WorkflowEngine.prototype, "expireApprovals").mockRejectedValueOnce(
      new Error(`connect failed at ${secretUrl} with ${token} ${"x".repeat(600)}`)
    );

    const report = await runTick(h.opts());

    const entry = report.errors.find((e) => e.step === "expiry");
    expect(entry).toBeDefined();
    expect(entry!.error).not.toContain("bind_local_only");
    expect(entry!.error).not.toContain(token);
    expect(entry!.error.length).toBeLessThanOrEqual(200);
  });

  it("the explicit recover route behaviour is unchanged", async () => {
    const ws = await newWorkspace("explicit");
    const h = harness();
    // Fresh on purpose: the explicit route scans everything, as it always has.
    const workflowId = await seedAuthorized(ws, "explicit");

    const report = await new WorkflowCrashRecoveryRunner(h.deps).recoverInterruptedWorkflows();

    expect(report.recoveredCount).toBeGreaterThanOrEqual(1);
    expect(submitsFor(h, workflowId)).toBe(1);
    expect(await workflowState(workflowId)).toBe(WorkflowState.CONFIRMED);
  });

  it("the worker does not touch another step's lock", async () => {
    const ws = await newWorkspace("heldlock");
    const h = harness();
    const workflowId = await seedAuthorized(ws, "heldlock");
    await ageWorkflow(workflowId, "1 hour");
    const { approvalId } = await seedApproval(ws, "heldlock", "1 minute");
    const held = await acquireAdvisoryLock("worker:expiry", 0);
    expect(held).not.toBeNull();

    try {
      const report = await runTick(h.opts());

      expect(report.expiry.skipped).toBe(true);
      expect(await approvalStatus(approvalId)).toBe("pending");
      expect(report.recovery.skipped).toBe(false);
      expect(await workflowState(workflowId)).toBe(WorkflowState.CONFIRMED);
    } finally {
      await held!.release();
    }
  });

  it("an in-doubt workflow does not starve the rest of the batch", async () => {
    const ws = await newWorkspace("indoubt");
    // The first submission reaches the supplier, and the ledger row is left started (a crash, ADR 0018).
    const crashed = harness({ lookup: true });
    setEffectFault({
      point: "after_call_before_complete",
      match: (spec) => spec.operation === "orders.submit" && spec.workspaceId === ws,
    });
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => crashed.supplier.adapter, settlementFor: () => crashed.settle });
    await expect(runner.startReplenishment(ws, FLOUR)).rejects.toThrow("injected fault");
    const inDoubtWorkflow = (await query(`SELECT id FROM workflows WHERE workspace_id = $1;`, [ws])).rows[0].id as string;
    await ageWorkflow(inDoubtWorkflow, "2 hours");
    const h = harness({ lookup: false });
    const waiting = await seedAuthorized(ws, "waiting");
    await ageWorkflow(waiting, "1 hour");

    const first = await runTick(h.opts({ batchSize: 1 }));
    expect(first.recovery.inDoubt).toBeGreaterThanOrEqual(1);
    expect(await workflowState(waiting)).toBe(WorkflowState.AUTHORIZED);

    await runTick(h.opts({ batchSize: 1 }));

    expect(await workflowState(waiting)).toBe(WorkflowState.CONFIRMED);
    expect(submitsFor(h, inDoubtWorkflow)).toBe(0);
    expect(await workflowState(inDoubtWorkflow)).toBe(WorkflowState.SUBMITTED);
  });

  it("one failing order does not stop the settlement poll", async () => {
    const h = harness();
    const broken = await newWorkspace("broken");
    const healthy = await newWorkspace("healthy");
    const brokenOrder = await settledOrder(h, broken);
    const healthyOrder = await settledOrder(h, healthy);
    await ageOrder(brokenOrder.orderId, "2 hours");
    await ageOrder(healthyOrder.orderId, "1 hour");
    // The payment record is missing, so confirmation throws before the adapter is asked.
    await query(`UPDATE orders SET settled_receipt_id = NULL WHERE id = $1;`, [brokenOrder.orderId]);
    h.settle.confirmStatus = "confirmed";

    const report = await runTick(h.opts({ batchSize: 2 }));

    expect(report.settlementPoll.failed).toBeGreaterThanOrEqual(1);
    expect(await orderStatus(brokenOrder.orderId)).toBe("settlement_submitted");
    expect(await orderStatus(healthyOrder.orderId)).toBe("reconciled");
  });
});
