import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { WorkflowCrashRecoveryRunner } from "../../src/workflows/recovery.js";
import { SimulatedSupplierAdapter } from "../../src/adapters/suppliers/simulated.js";
import type {
  SupplierAdapter,
  OrderRequest,
  OrderResponse,
  QuoteRequest,
} from "../../src/adapters/suppliers/types.js";
import { listUnresolvedEffects } from "../../src/effects/ledger.js";
import { setEffectFault } from "../../src/effects/faults.js";
import { orderNumberFor } from "../../src/orders/reservation.js";
import { SPEND_COUNTING_ORDER_STATUSES } from "../../src/orders/statuses.js";

const run = Date.now();
const FLOUR = "FOOD-FLOUR-50LB"; // par 6, on hand 3, reorder 10 x $24.50 = $245.00 (24500 cents)
const BUTTER = "FOOD-BUTTER-36LB"; // par 4, on hand 2, reorder 4 x $98.00 = $392.00 (39200 cents)
const FLOUR_TOTAL = 24500n;
const BUTTER_TOTAL = 39200n;

const engine = new WorkflowEngine();
const created: string[] = [];
let counter = 0;

/** Each test gets its own workspace, deleted in afterEach, so the global recovery sweep never sees another test's work. */
async function newWorkspace(label: string, dailyLimitCents: bigint = 10_000_000n): Promise<string> {
  counter += 1;
  const id = `wsosr-${label}-${run}-${counter}`;
  await provisionWorkspace(id, `Order Submission ${label}`, "kitchen-v1", {
    customDailyLimitCents: dailyLimitCents,
    customApprovalThresholdCents: 10_000_000n,
  });
  created.push(id);
  return id;
}

interface SpyControl {
  /** The next submitOrder call returns status 'rejected' and does not reach the simulation. */
  rejectNext: boolean;
  /** The next submitOrder call throws this error before the supplier accepts anything. */
  failNext: Error | null;
  /** Runs inside submitOrder, before the supplier decides. */
  beforeSubmit: ((req: OrderRequest) => Promise<void>) | null;
}

interface SpySupplier {
  adapter: SupplierAdapter;
  control: SpyControl;
  submits: OrderRequest[];
  responses: OrderResponse[];
  quotes: QuoteRequest[];
}

/**
 * A supplier that records every call. It delegates to a simulated supplier, so the accepted orders behave like
 * the real simulation. `lookup` decides whether the adapter exposes lookupOrder at all.
 */
function spySupplier(options: { lookup: boolean }): SpySupplier {
  const base = new SimulatedSupplierAdapter("supp-sysco-metro", "Spy Supplier", 1.0);
  const control: SpyControl = { rejectNext: false, failNext: null, beforeSubmit: null };
  const submits: OrderRequest[] = [];
  const responses: OrderResponse[] = [];
  const quotes: QuoteRequest[] = [];

  const adapter: SupplierAdapter = {
    supplierId: base.supplierId,
    supplierName: base.supplierName,
    isSimulated: true,
    requestQuote: async (req) => {
      quotes.push(req);
      return base.requestQuote(req);
    },
    submitOrder: async (req) => {
      submits.push(req);
      if (control.beforeSubmit) await control.beforeSubmit(req);
      if (control.failNext) {
        const err = control.failNext;
        control.failNext = null;
        throw err;
      }
      if (control.rejectNext) {
        control.rejectNext = false;
        const rejected: OrderResponse = {
          orderNumber: req.orderNumber,
          externalOrderRef: `REJ-${req.idempotencyKey.slice(-8)}`,
          status: "rejected",
          confirmedAt: new Date(),
          isSimulated: true,
        };
        responses.push(rejected);
        return rejected;
      }
      const accepted = await base.submitOrder(req);
      responses.push(accepted);
      return accepted;
    },
    generateDeliveryReceipt: (orderId, sku, quantity) => base.generateDeliveryReceipt(orderId, sku, quantity),
    generateBill: (orderId, sku, quantity, unitPriceCents, vendorId) =>
      base.generateBill(orderId, sku, quantity, unitPriceCents, vendorId),
    ...(options.lookup ? { lookupOrder: (req) => base.lookupOrder(req) } : {}),
  };

  return { adapter, control, submits, responses, quotes };
}

function runnerWith(spy: SpySupplier): ProcurementWorkflowRunner {
  return new ProcurementWorkflowRunner({ supplierFor: () => spy.adapter });
}

function recoveryWith(spy: SpySupplier): WorkflowCrashRecoveryRunner {
  return new WorkflowCrashRecoveryRunner({ supplierFor: () => spy.adapter });
}

/** Arms a one-shot fault for the order effect of one workspace. Only runEffect reads it. */
function armOrderFault(point: "before_call" | "after_call_before_complete", workspaceId: string): void {
  setEffectFault({
    point,
    match: (spec) => spec.operation === "orders.submit" && spec.workspaceId === workspaceId,
  });
}

async function workflowsOf(workspaceId: string): Promise<any[]> {
  const res = await query(
    `SELECT id, state, error_message, context_data FROM workflows WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC;`,
    [workspaceId]
  );
  return res.rows;
}

async function onlyWorkflow(workspaceId: string): Promise<any> {
  const rows = await workflowsOf(workspaceId);
  expect(rows.length).toBe(1);
  return rows[0];
}

async function orderOf(orderId: string): Promise<any> {
  const res = await query(`SELECT * FROM orders WHERE id = $1;`, [orderId]);
  return res.rows[0];
}

/** Inserts a quote row the way startReplenishment does, with a validity relative to now. */
async function seedQuote(input: {
  workspaceId: string;
  quoteId: string;
  supplierId: string;
  sku: string;
  quantity: number;
  unitPriceCents: bigint;
  totalPriceCents: bigint;
  validUntilSql: string;
}): Promise<void> {
  await query(
    `INSERT INTO quotes (id, workspace_id, rfq_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, currency, valid_until, created_at)
     VALUES ($1, $2, $3, $4, 'Sysco Metro Distribution', $5, $6, $7, $8, 'USDC', NOW() + $9::interval, NOW());`,
    [
      input.quoteId,
      input.workspaceId,
      `rfq_${input.quoteId}`,
      input.supplierId,
      input.sku,
      input.quantity,
      input.unitPriceCents,
      input.totalPriceCents,
      input.validUntilSql,
    ]
  );
}

/** A workflow already AUTHORIZED (or SUBMITTED) against a stored quote, as a crash would leave it. */
async function seedWorkflow(input: {
  workspaceId: string;
  label: string;
  state: WorkflowState.AUTHORIZED | WorkflowState.SUBMITTED;
  quoteId: string;
  supplierId: string;
  sku: string;
  quantity: number;
  unitPriceCents: bigint;
  totalPriceCents: bigint;
}): Promise<string> {
  const workflowId = `wf_osr_${input.label}_${run}`;
  await engine.createWorkflow(workflowId, input.workspaceId, "kitchen_replenishment", `idem_osr_${input.label}_${run}`, {
    itemName: "Organic All-Purpose Flour",
    quote: {
      quoteId: input.quoteId,
      rfqId: `rfq_${input.quoteId}`,
      supplierId: input.supplierId,
      supplierName: "Sysco Metro Distribution",
      sku: input.sku,
      quantity: input.quantity,
      unitPriceCents: input.unitPriceCents.toString(),
      totalPriceCents: input.totalPriceCents.toString(),
    },
  });
  if (input.state === WorkflowState.AUTHORIZED) {
    await engine.transition(workflowId, { fromState: WorkflowState.DRAFT, toState: WorkflowState.AUTHORIZED });
  } else {
    await engine.transition(workflowId, { fromState: WorkflowState.DRAFT, toState: WorkflowState.SUBMITTED });
  }
  return workflowId;
}

describe("order submission through the reservation and the effects ledger (PostgreSQL)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    setEffectFault(null);
    if (created.length > 0) {
      await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [created.splice(0)]);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it("the order row exists in a spend-counting status before the supplier is called", async () => {
    const ws = await newWorkspace("rowfirst");
    const spy = spySupplier({ lookup: true });
    let statusAtSubmit: string | null = null;
    spy.control.beforeSubmit = async (req) => {
      const row = await orderOf(req.orderId);
      statusAtSubmit = row?.status ?? null;
    };

    const result = await runnerWith(spy).startReplenishment(ws, FLOUR);

    expect(result.state).toBe(WorkflowState.CONFIRMED);
    expect(spy.submits.length).toBe(1);
    expect(statusAtSubmit).not.toBeNull();
    expect(SPEND_COUNTING_ORDER_STATUSES).toContain(statusAtSubmit);
  });

  it("a crash after the supplier accepted the order causes exactly one supplier submission after recovery", async () => {
    const ws = await newWorkspace("aftercall");
    const spy = spySupplier({ lookup: true });
    armOrderFault("after_call_before_complete", ws);

    await expect(runnerWith(spy).startReplenishment(ws, FLOUR)).rejects.toThrow("injected fault");
    expect(spy.submits.length).toBe(1);
    const wf = await onlyWorkflow(ws);
    expect(wf.state).toBe(WorkflowState.SUBMITTED);

    const report = await recoveryWith(spy).recoverInterruptedWorkflows();

    expect(spy.submits.length).toBe(1);
    expect(report.inDoubt).toEqual([]);
    const after = await onlyWorkflow(ws);
    expect(after.state).toBe(WorkflowState.CONFIRMED);
    const order = await orderOf(`ord_${wf.id}`);
    expect(order.status).toBe("confirmed");
    expect(order.external_order_ref).toBe(spy.responses[0].externalOrderRef);
  });

  it("without a supplier lookup the order stays submitted and is reported in doubt, never resubmitted", async () => {
    const ws = await newWorkspace("nolookup");
    const spy = spySupplier({ lookup: false });
    armOrderFault("after_call_before_complete", ws);

    await expect(runnerWith(spy).startReplenishment(ws, FLOUR)).rejects.toThrow("injected fault");
    const wf = await onlyWorkflow(ws);

    const first = await recoveryWith(spy).recoverInterruptedWorkflows();
    const second = await recoveryWith(spy).recoverInterruptedWorkflows();

    expect(spy.submits.length).toBe(1);
    const order = await orderOf(`ord_${wf.id}`);
    expect(order.status).toBe("submitted");
    expect((await onlyWorkflow(ws)).state).toBe(WorkflowState.SUBMITTED);

    const unresolved = (await listUnresolvedEffects(ws)).find((e) => e.operation === "orders.submit");
    expect(unresolved).toBeDefined();
    expect(first.inDoubt).toContainEqual({ workflowId: wf.id, effectId: unresolved!.id });
    expect(second.inDoubt).toContainEqual({ workflowId: wf.id, effectId: unresolved!.id });
    expect(first.failedCount).toBe(0);
  });

  it("a crash before the supplier call is resumed with one submission", async () => {
    const ws = await newWorkspace("beforecall");
    const spy = spySupplier({ lookup: true });
    armOrderFault("before_call", ws);

    await expect(runnerWith(spy).startReplenishment(ws, FLOUR)).rejects.toThrow("injected fault");
    expect(spy.submits.length).toBe(0);
    const wf = await onlyWorkflow(ws);

    await recoveryWith(spy).recoverInterruptedWorkflows();

    expect(spy.submits.length).toBe(1);
    expect((await onlyWorkflow(ws)).state).toBe(WorkflowState.CONFIRMED);
    expect((await orderOf(`ord_${wf.id}`)).status).toBe("confirmed");
  });

  it("two concurrent commitments cannot both pass the daily limit", async () => {
    // The limit fits the larger order alone, so two orders together never fit.
    for (let i = 0; i < 10; i += 1) {
      const ws = await newWorkspace(`race${i}`, BUTTER_TOTAL);
      const spy = spySupplier({ lookup: true });
      const runner = runnerWith(spy);

      const [a, b] = await Promise.all([runner.startReplenishment(ws, FLOUR), runner.startReplenishment(ws, BUTTER)]);

      expect(spy.submits.length).toBe(1);
      const orders = await query(`SELECT id, status FROM orders WHERE workspace_id = $1;`, [ws]);
      expect(orders.rows.length).toBe(1);
      expect(orders.rows[0].status).toBe("confirmed");

      const states = [a.state, b.state].sort();
      expect(states).toEqual([WorkflowState.CONFIRMED, WorkflowState.FAILED].sort());
      const failed = (await workflowsOf(ws)).find((w) => w.state === WorkflowState.FAILED);
      expect(failed).toBeDefined();
      expect(failed.error_message).toContain("DAILY_LIMIT_EXCEEDED");
    }
  });

  it("the reservation refuses a quote that expired before submission", async () => {
    const ws = await newWorkspace("expired");
    const spy = spySupplier({ lookup: true });
    const quoteId = `quote_osr_expired_${run}`;
    await seedQuote({
      workspaceId: ws,
      quoteId,
      supplierId: `${ws}_supp-sysco-metro`,
      sku: FLOUR,
      quantity: 10,
      unitPriceCents: 2450n,
      totalPriceCents: FLOUR_TOTAL,
      validUntilSql: "-1 minute",
    });
    const wfId = await seedWorkflow({
      workspaceId: ws,
      label: "expired",
      state: WorkflowState.AUTHORIZED,
      quoteId,
      supplierId: `${ws}_supp-sysco-metro`,
      sku: FLOUR,
      quantity: 10,
      unitPriceCents: 2450n,
      totalPriceCents: FLOUR_TOTAL,
    });

    const result = await runnerWith(spy).resumeOrderSubmission(wfId);

    expect(result.state).toBe(WorkflowState.FAILED);
    expect(spy.submits.length).toBe(0);
    const wf = await engine.getWorkflow(wfId);
    expect(wf?.state).toBe(WorkflowState.FAILED);
    expect(wf?.errorMessage).toContain("QUOTE_EXPIRED");
    expect(await orderOf(`ord_${wfId}`)).toBeUndefined();
  });

  it("a rejected supplier order cancels the reservation and frees the budget", async () => {
    // The limit fits exactly one flour order, so the second order only passes once the first budget is released.
    const ws = await newWorkspace("rejected", FLOUR_TOTAL);
    const spy = spySupplier({ lookup: true });
    const runner = runnerWith(spy);
    spy.control.rejectNext = true;

    const first = await runner.startReplenishment(ws, FLOUR);

    expect(first.state).toBe(WorkflowState.FAILED);
    const rejectedOrder = await orderOf(`ord_${first.workflowId}`);
    expect(rejectedOrder.status).toBe("cancelled");
    expect((await engine.getWorkflow(first.workflowId))?.state).toBe(WorkflowState.FAILED);

    // Stock fell again. A different on-hand quantity gives the second workflow its own idempotency key.
    await query(`UPDATE inventory_items SET current_quantity = 2 WHERE workspace_id = $1 AND sku = $2;`, [ws, FLOUR]);
    const second = await runner.startReplenishment(ws, FLOUR);

    expect(second.state).toBe(WorkflowState.CONFIRMED);
    expect(spy.submits.length).toBe(2);
    expect((await orderOf(`ord_${second.workflowId}`)).status).toBe("confirmed");
  });

  it("an unknown error from the supplier leaves the order submitted and does not fail the workflow", async () => {
    const ws = await newWorkspace("unknownerr");
    const spy = spySupplier({ lookup: true });
    spy.control.failNext = new Error("supplier connection reset");

    await expect(runnerWith(spy).startReplenishment(ws, FLOUR)).rejects.toThrow("supplier connection reset");

    const wf = await onlyWorkflow(ws);
    expect(wf.state).toBe(WorkflowState.SUBMITTED);
    expect((await orderOf(`ord_${wf.id}`)).status).toBe("submitted");
  });

  it("recovery of a submitted workflow does not adopt another workflow's order", async () => {
    const ws = await newWorkspace("noadopt");
    const spy = spySupplier({ lookup: true });
    const supplierId = `${ws}_supp-sysco-metro`;
    const quoteId = `quote_osr_noadopt_${run}`;
    await seedQuote({
      workspaceId: ws,
      quoteId,
      supplierId,
      sku: FLOUR,
      quantity: 10,
      unitPriceCents: 2450n,
      totalPriceCents: FLOUR_TOTAL,
      validUntilSql: "1 day",
    });
    // An unrelated, already confirmed order in the same workspace that carries an external reference.
    const otherOrderId = `ord_other_${run}`;
    await query(
      `INSERT INTO orders (id, workspace_id, order_number, supplier_id, supplier_name, item_sku, item_name, quantity, unit_price_cents, total_price_cents, currency, status, idempotency_key, external_order_ref)
       VALUES ($1, $2, 'PO-OTHER001', $3, 'Sysco Metro Distribution', 'FOOD-MILK-CASE', 'Whole Milk Case', 6, 1680, 10080, 'USDC', 'confirmed', $4, 'EXT-OTHER-REF');`,
      [otherOrderId, ws, supplierId, `idem_other_${run}`]
    );
    const wfId = await seedWorkflow({
      workspaceId: ws,
      label: "noadopt",
      state: WorkflowState.SUBMITTED,
      quoteId,
      supplierId,
      sku: FLOUR,
      quantity: 10,
      unitPriceCents: 2450n,
      totalPriceCents: FLOUR_TOTAL,
    });

    await recoveryWith(spy).recoverInterruptedWorkflows();

    expect(spy.submits.length).toBe(1);
    const wf = await engine.getWorkflow(wfId);
    expect(wf?.state).toBe(WorkflowState.CONFIRMED);
    expect(wf?.contextData.orderId).toBe(`ord_${wfId}`);
    const own = await orderOf(`ord_${wfId}`);
    expect(own.status).toBe("confirmed");
    expect(own.external_order_ref).toBe(spy.responses[0].externalOrderRef);
    const other = await orderOf(otherOrderId);
    expect(other.status).toBe("confirmed");
    expect(other.external_order_ref).toBe("EXT-OTHER-REF");
  });

  it("recovery of an authorized workflow re-checks policy", async () => {
    const ws = await newWorkspace("recheck");
    const spy = spySupplier({ lookup: true });
    const quoteId = `quote_osr_recheck_${run}`;
    await seedQuote({
      workspaceId: ws,
      quoteId,
      supplierId: `${ws}_supp-sysco-metro`,
      sku: FLOUR,
      quantity: 10,
      unitPriceCents: 2450n,
      totalPriceCents: FLOUR_TOTAL,
      validUntilSql: "-1 minute",
    });
    const wfId = await seedWorkflow({
      workspaceId: ws,
      label: "recheck",
      state: WorkflowState.AUTHORIZED,
      quoteId,
      supplierId: `${ws}_supp-sysco-metro`,
      sku: FLOUR,
      quantity: 10,
      unitPriceCents: 2450n,
      totalPriceCents: FLOUR_TOTAL,
    });

    await recoveryWith(spy).recoverInterruptedWorkflows();

    expect(spy.submits.length).toBe(0);
    const wf = await engine.getWorkflow(wfId);
    expect(wf?.state).toBe(WorkflowState.FAILED);
    expect(wf?.errorMessage).toContain("QUOTE_EXPIRED");
    const audit = await query(
      `SELECT policy_decision, evidence FROM audit_logs WHERE workflow_id = $1 AND action = 'commitment.recheck';`,
      [wfId]
    );
    expect(audit.rows.length).toBe(1);
    expect(audit.rows[0].policy_decision).toBe("DENY");
    expect(audit.rows[0].evidence.reasonCodes).toContain("QUOTE_EXPIRED");
  });

  it("ledger keys include the workspace id", async () => {
    const ws = await newWorkspace("keys");
    const spy = spySupplier({ lookup: true });

    const result = await runnerWith(spy).startReplenishment(ws, FLOUR);

    const effects = await query(
      `SELECT operation, idempotency_key, workspace_id FROM effects WHERE workflow_id = $1 ORDER BY operation;`,
      [result.workflowId]
    );
    const operations = effects.rows.map((r) => r.operation);
    expect(operations).toEqual(["orders.submit", "suppliers.request_quote"]);
    for (const row of effects.rows) {
      expect(row.workspace_id).toBe(ws);
      expect(row.idempotency_key.startsWith(ws)).toBe(true);
    }
  });

  it("a quote request with the same rfq id is sent once", async () => {
    const ws = await newWorkspace("quoteonce");
    const spy = spySupplier({ lookup: true });
    const runner = runnerWith(spy);
    const rfqId = `rfq_quoteonce_${run}`;
    const request = { workspaceId: ws, supplierId: `${ws}_supp-sysco-metro`, sku: FLOUR, quantity: 10, rfqId };

    const first = await runner.requestQuote(request);
    const second = await runner.requestQuote(request);

    expect(spy.quotes.length).toBe(1);
    expect(second.quoteId).toBe(first.quoteId);
    const rows = await query(`SELECT id FROM quotes WHERE workspace_id = $1 AND rfq_id = $2;`, [ws, rfqId]);
    expect(rows.rows.length).toBe(1);
  });

  it("the same idempotency key returns the same external ref", async () => {
    const adapter = new SimulatedSupplierAdapter("supp-sysco-metro", "Sysco", 1.0);
    const ws = `wsosr-ref-${run}`;
    const req: OrderRequest = {
      workspaceId: ws,
      orderId: `ord_ref_${run}`,
      orderNumber: orderNumberFor(`ord_ref_${run}`),
      supplierId: "supp-sysco-metro",
      sku: FLOUR,
      quantity: 10,
      unitPriceCents: 2450n,
      totalPriceCents: FLOUR_TOTAL,
      idempotencyKey: `idem_ord_ord_ref_${run}`,
    };

    const first = await adapter.submitOrder(req);
    const second = await adapter.submitOrder(req);

    expect(first.externalOrderRef).toMatch(/^EXT-SUPP-SYSCO-METRO-[0-9A-F]{9}$/);
    expect(second.externalOrderRef).toBe(first.externalOrderRef);
    expect(second.confirmedAt.getTime()).toBe(first.confirmedAt.getTime());
  });

  it("lookupOrder finds an accepted order and returns null for an unknown key", async () => {
    const adapter = new SimulatedSupplierAdapter("supp-sysco-metro", "Sysco", 1.0);
    const ws = `wsosr-lookup-${run}`;
    const orderId = `ord_lookup_${run}`;
    const idempotencyKey = `idem_ord_${orderId}`;
    const accepted = await adapter.submitOrder({
      workspaceId: ws,
      orderId,
      orderNumber: orderNumberFor(orderId),
      supplierId: "supp-sysco-metro",
      sku: FLOUR,
      quantity: 10,
      unitPriceCents: 2450n,
      totalPriceCents: FLOUR_TOTAL,
      idempotencyKey,
    });

    const found = await adapter.lookupOrder({ workspaceId: ws, orderId, idempotencyKey });
    const missing = await adapter.lookupOrder({ workspaceId: ws, orderId, idempotencyKey: `idem_unknown_${run}` });

    expect(found?.externalOrderRef).toBe(accepted.externalOrderRef);
    expect(missing).toBeNull();
  });
});
