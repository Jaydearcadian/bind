import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "crypto";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { SimulatedSupplierAdapter } from "../../src/adapters/suppliers/simulated.js";
import type { SupplierAdapter } from "../../src/adapters/suppliers/types.js";
import type {
  SettlementAdapter,
  SettlementStatus,
  TransferRequest,
  TransferResult,
} from "../../src/adapters/settlement/types.js";
import { acquireAdvisoryLock } from "../../src/db/advisory-lock.js";
import { runTick, type TickOptions } from "../../src/workers/runner.js";

/**
 * The restock sweep (worker step 5, ADR 0030). It starts a replenishment for each sku whose available quantity (on
 * hand less active reservations) is below par, with no workflow in the cooldown and no active workflow. It is off in
 * runTick unless enabled, and it is restricted to the listed workspaces in these tests, because the database is shared.
 *
 * Settlement is never reached here (a replenishment stops at a confirmed order), but the spy is passed anyway, so no
 * other step can reach a real settlement adapter.
 */

const run = Date.now();
const FLOUR = "FOOD-FLOUR-50LB"; // par 6, on hand 3, reorder 10
const PAYER = `0x${"11".repeat(20)}`;

const created: string[] = [];

async function newWorkspace(label: string): Promise<string> {
  const id = `wkr-sweep-${label}-${run}-${created.length}`;
  await provisionWorkspace(id, `Sweep ${label}`, "kitchen-v1", {
    customDailyLimitCents: 10_000_000n,
    customApprovalThresholdCents: 10_000_000n,
  });
  await query(`UPDATE workspaces SET settlement_address = $2 WHERE id = $1;`, [id, PAYER]);
  // The kitchen template also seeds butter below par. Counted above par here, so flour is the only low sku.
  await query(`UPDATE inventory_items SET current_quantity = 10 WHERE workspace_id = $1 AND sku = 'FOOD-BUTTER-36LB';`, [id]);
  created.push(id);
  return id;
}

/**
 * A supplier that refuses quotes for `refuseSku`. Every other sku gets a normal simulated quote and order.
 */
function supplierFor(refuseSku?: string): SupplierAdapter {
  const base = new SimulatedSupplierAdapter("supp-sysco-metro", "Sweep Supplier", 1.0);
  return {
    supplierId: base.supplierId,
    supplierName: base.supplierName,
    isSimulated: true,
    requestQuote: async (req) => {
      if (refuseSku !== undefined && req.sku === refuseSku) throw new Error(`quote refused for ${req.sku}`);
      return base.requestQuote(req);
    },
    submitOrder: (req) => base.submitOrder(req),
    generateDeliveryReceipt: (orderId, sku, quantity) => base.generateDeliveryReceipt(orderId, sku, quantity),
    generateBill: (orderId, sku, quantity, unitPriceCents, vendorId) =>
      base.generateBill(orderId, sku, quantity, unitPriceCents, vendorId),
  };
}

/** The settlement adapter is never asked to transfer in these tests. Any call to it is a failure. */
class NoSettlement implements SettlementAdapter {
  readonly mode = "local" as const;
  readonly transfers: TransferRequest[] = [];
  async getBalance(): Promise<bigint> {
    return 0n;
  }
  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    this.transfers.push(req);
    throw new Error("no transfer is expected in the sweep tests");
  }
  async confirm(txHash: string): Promise<TransferResult> {
    return { txHash, status: "submitted" as SettlementStatus, timestamp: new Date(), mode: "local", simulated: true };
  }
  async depositEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }
  async releaseEscrow(): Promise<TransferResult> {
    throw new Error("not used");
  }
}

function deps(refuseSku?: string) {
  const settle = new NoSettlement();
  return { settle, deps: { supplierFor: () => supplierFor(refuseSku), settlementFor: () => settle } };
}

function opts(workspaceIds: string[], extra: TickOptions = {}): TickOptions {
  return { ...extra, restockSweep: true, restockWorkspaceIds: workspaceIds };
}

async function workflowsFor(ws: string, sku: string): Promise<Array<{ id: string; state: string; context_data: any; created_at: Date }>> {
  return (
    await query(
      `SELECT id, state, context_data, created_at FROM workflows WHERE workspace_id = $1 AND context_data->>'sku' = $2 ORDER BY created_at, id;`,
      [ws, sku]
    )
  ).rows;
}

async function auditCount(ws: string, action: string): Promise<number> {
  return (await query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = $2;`, [ws, action])).rows[0].n;
}

async function sweepAuditCount(ws: string): Promise<number> {
  return (
    await query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action LIKE 'replenishment.sweep%';`, [ws])
  ).rows[0].n;
}

async function setStock(ws: string, sku: string, onHand: number): Promise<void> {
  await query(`UPDATE inventory_items SET current_quantity = $3, updated_at = NOW() WHERE workspace_id = $1 AND sku = $2;`, [ws, sku, onHand]);
}

async function ageItem(ws: string, sku: string, interval: string): Promise<void> {
  await query(`UPDATE inventory_items SET updated_at = NOW() - $3::interval WHERE workspace_id = $1 AND sku = $2;`, [ws, sku, interval]);
}

async function addItem(ws: string, sku: string, name: string, onHand: number, par: number): Promise<void> {
  await query(
    `INSERT INTO inventory_items (id, workspace_id, sku, name, category, unit, current_quantity, par_level, reorder_quantity, unit_price_cents, updated_at)
     VALUES ($1, $2, $3, $4, 'Dry Goods', 'bag', $5, $6, 10, 2450, NOW());`,
    [`inv_${crypto.randomUUID()}`, ws, sku, name, onHand, par]
  );
}

describe("the restock sweep (worker step 5, PostgreSQL)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    for (const id of created.splice(0)) {
      await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it("the sweep starts a replenishment for a low sku and not again within the cooldown", async () => {
    const ws = await newWorkspace("cooldown");
    const { deps: d, settle } = deps();

    const first = await runTick({ ...opts([ws]), deps: d });
    expect(first.restockSweep).toMatchObject({ skipped: false, started: 1, failed: 0 });
    const [started] = await workflowsFor(ws, FLOUR);
    expect(started).toBeDefined();
    expect(await auditCount(ws, "inventory.detect_low_stock")).toBe(1);

    // The replenishment ends (an owner cancelled it), so no workflow is active for the sku any more.
    await query(`UPDATE workflows SET state = 'cancelled' WHERE id = $1;`, [started.id]);

    // Same stock, a minute later: the cooldown holds the sku back. Without it the sweep would try again.
    const second = await runTick({ ...opts([ws]), deps: d });
    expect(second.restockSweep).toMatchObject({ started: 0, failed: 0 });
    expect(await workflowsFor(ws, FLOUR)).toHaveLength(1);
    expect(await auditCount(ws, "inventory.detect_low_stock")).toBe(1);
    expect(await sweepAuditCount(ws)).toBe(0);
    expect(settle.transfers).toHaveLength(0);
  });

  it("after the cooldown a counted low stock starts a replenishment again", async () => {
    const ws = await newWorkspace("aftercooldown");
    const { deps: d } = deps();
    await runTick({ ...opts([ws]), deps: d });
    const [first] = await workflowsFor(ws, FLOUR);
    await query(`UPDATE workflows SET state = 'failed', created_at = NOW() - INTERVAL '7 hours' WHERE id = $1;`, [first.id]);

    // A new count (2, not 3) is a new replenishment: the idempotency key is built from the quantity.
    await setStock(ws, FLOUR, 2);
    const later = await runTick({ ...opts([ws]), deps: d });

    expect(later.restockSweep).toMatchObject({ started: 1, failed: 0 });
    expect(await workflowsFor(ws, FLOUR)).toHaveLength(2);
  });

  it("the sweep skips a paused workspace", async () => {
    const ws = await newWorkspace("paused");
    const { deps: d } = deps();
    await query(`UPDATE workspaces SET agents_paused = TRUE WHERE id = $1;`, [ws]);

    const report = await runTick({ ...opts([ws]), deps: d });

    expect(report.restockSweep).toMatchObject({ skipped: false, started: 0, failed: 0 });
    expect(await workflowsFor(ws, FLOUR)).toHaveLength(0);
    // The paused workspace is not even attempted: no sweep row of any kind.
    expect(await sweepAuditCount(ws)).toBe(0);
    expect(await auditCount(ws, "inventory.detect_low_stock")).toBe(0);
  });

  it("the sweep counts reservations: on-hand above par but available below par starts one", async () => {
    const ws = await newWorkspace("reserved");
    const { deps: d } = deps();
    await setStock(ws, FLOUR, 8); // on hand 8 is above par 6 ...
    const order = `cord_sweep_${run}_${created.length}`;
    await query(
      `INSERT INTO customer_orders (id, workspace_id, external_ref, request_hash, status) VALUES ($1, $2, $3, 'h', 'accepted');`,
      [order, ws, `ref-${order}`]
    );
    await query(
      `INSERT INTO stock_reservations (id, workspace_id, order_id, sku, quantity, status) VALUES ($1, $2, $3, $4, 3, 'active');`,
      [`res_${order}`, ws, order, FLOUR]
    ); // ... but 3 are promised, so 5 are free and below par.

    const report = await runTick({ ...opts([ws]), deps: d });

    expect(report.restockSweep).toMatchObject({ started: 1, failed: 0 });
    const [wf] = await workflowsFor(ws, FLOUR);
    expect(wf.context_data.currentQty).toBe(5);
  });

  it("a sweep failure for one sku does not stop the others", async () => {
    const ws = await newWorkspace("isolate");
    await addItem(ws, "FOOD-BAD-SKU", "Refused Quote Item", 1, 6);
    await ageItem(ws, "FOOD-BAD-SKU", "2 days"); // the older deficit is tried first
    const { deps: d } = deps("FOOD-BAD-SKU");

    const report = await runTick({ ...opts([ws]), deps: d });

    expect(report.restockSweep).toMatchObject({ started: 1, failed: 1 });
    expect(await workflowsFor(ws, FLOUR)).toHaveLength(1);
    const failures = (
      await query(`SELECT evidence FROM audit_logs WHERE workspace_id = $1 AND action = 'replenishment.sweep_failed';`, [ws])
    ).rows;
    expect(failures).toHaveLength(1);
    expect(failures[0].evidence.sku).toBe("FOOD-BAD-SKU");
    expect(failures[0].evidence.error).toContain("quote refused");
  });

  it("the sweep is off unless enabled", async () => {
    const ws = await newWorkspace("off");
    const { deps: d } = deps();

    const off = await runTick({ deps: d, restockWorkspaceIds: [ws] });
    expect(off.restockSweep).toEqual({ skipped: true, started: 0, failed: 0 });
    expect(await workflowsFor(ws, FLOUR)).toHaveLength(0);

    const on = await runTick({ ...opts([ws]), deps: d });
    expect(on.restockSweep).toMatchObject({ skipped: false, started: 1 });
    expect(await workflowsFor(ws, FLOUR)).toHaveLength(1);
  });

  it("the sweep only touches the listed workspaces when restricted", async () => {
    const listed = await newWorkspace("listed");
    const unlisted = await newWorkspace("unlisted");
    const { deps: d } = deps();

    const report = await runTick({ ...opts([listed]), deps: d });

    expect(report.restockSweep).toMatchObject({ started: 1, failed: 0 });
    expect(await workflowsFor(listed, FLOUR)).toHaveLength(1);
    expect(await workflowsFor(unlisted, FLOUR)).toHaveLength(0);
    expect(await sweepAuditCount(unlisted)).toBe(0);
  });

  it("the sweep respects the batch size", async () => {
    const wsIds = [await newWorkspace("batch-a"), await newWorkspace("batch-b"), await newWorkspace("batch-c")];
    // Each deficit is older than the last, so the first two in the batch are the first two workspaces.
    await ageItem(wsIds[0], FLOUR, "3 days");
    await ageItem(wsIds[1], FLOUR, "2 days");
    await ageItem(wsIds[2], FLOUR, "1 day");
    const { deps: d } = deps();

    const report = await runTick({ ...opts(wsIds, { batchSize: 2 }), deps: d });

    expect(report.restockSweep).toMatchObject({ started: 2, failed: 0 });
    expect(await workflowsFor(wsIds[0], FLOUR)).toHaveLength(1);
    expect(await workflowsFor(wsIds[1], FLOUR)).toHaveLength(1);
    expect(await workflowsFor(wsIds[2], FLOUR)).toHaveLength(0);
  });

  it("two sweeps at once start one replenishment", async () => {
    const ws = await newWorkspace("twice");
    const { deps: d } = deps();

    const [a, b] = await Promise.all([runTick({ ...opts([ws]), deps: d }), runTick({ ...opts([ws]), deps: d })]);

    expect((a.restockSweep.started ?? 0) + (b.restockSweep.started ?? 0)).toBe(1);
    expect(await workflowsFor(ws, FLOUR)).toHaveLength(1);
    expect(await auditCount(ws, "inventory.detect_low_stock")).toBe(1);
    expect(await sweepAuditCount(ws)).toBe(0);
  });

  it("a busy sweep lock skips the step and the other steps still run", async () => {
    const ws = await newWorkspace("busy");
    const { deps: d } = deps();
    const held = await acquireAdvisoryLock("worker:restock_sweep", 0);
    expect(held).not.toBeNull();
    try {
      const report = await runTick({ ...opts([ws]), deps: d });
      expect(report.restockSweep).toMatchObject({ skipped: true, started: 0, failed: 0 });
      expect(await workflowsFor(ws, FLOUR)).toHaveLength(0);
      expect(report.expiry.skipped).toBe(false);
    } finally {
      await held!.release();
    }
  });
  it("a tick with no sweep option reports the sweep as not run", async () => {
    const ws = await newWorkspace("default");
    const { deps: d } = deps();
    const report = await runTick({ deps: d });
    expect(report.restockSweep).toEqual({ skipped: true, started: 0, failed: 0 });
    expect(await workflowsFor(ws, FLOUR)).toHaveLength(0);
  });
});
