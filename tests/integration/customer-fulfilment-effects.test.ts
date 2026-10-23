import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { config } from "../../src/config/env.js";
import { notificationEmitter } from "../../src/adapters/web2/notifications.js";
import type { NotificationPayload } from "../../src/adapters/web2/types.js";
import { upsertSurfaceBinding } from "../../src/adapters/socialSurface.js";
import { sendOwnerNotification } from "../../src/notifications/dispatch.js";
import { setEffectFault } from "../../src/effects/faults.js";
import { setAgentsPaused } from "../../src/studio/workspaceControls.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { generateIdempotencyKey } from "../../src/utils/idempotency.js";
import {
  acceptCustomerOrder,
  acceptHeldOrder,
  setKitchenCapacity,
  type AcceptResult,
  type AgentActor,
  type OwnerActor,
} from "../../src/workflows/fulfilment.js";

/*
 * Owner notices for held, declined and partly available customer orders, and the low-stock restock trigger from
 * available stock (Task 8b, ADR 0027). Real PostgreSQL. Every workspace is unique to a test run and removed afterwards.
 */

// Base-36 keeps workspace ids short: the template's role ids (role_<workspace>_<role>) must fit in VARCHAR(64).
const run = Date.now().toString(36);
const phoneRun = String(Date.now() % 10_000).padStart(4, "0");
const HOUR = 3_600_000;
const FLOUR = "SKU-FLOUR";
const AGENT: AgentActor = { kind: "agent", roleName: "fulfilment_agent" };
const OWNER: OwnerActor = { kind: "owner", label: "owner-test" };

let counter = 0;
const createdWorkspaces: string[] = [];

interface StockLine {
  onHand: number;
  par?: number;
  reorder?: number;
}

interface WorkspaceOptions {
  stock?: Record<string, StockLine>;
  /** Grant the fulfilment role commercial_commitment (the owner's grant, as a direct fixture). */
  grant?: boolean;
  /** Bind the owner's WhatsApp, so a notice has a recipient. Without it the skip is audited. */
  bindOwner?: boolean;
}

interface Workspace {
  id: string;
  /** The owner's bound WhatsApp id, or null when no binding was made. */
  phone: string | null;
}

async function makeWorkspace(label: string, options: WorkspaceOptions = {}): Promise<Workspace> {
  counter += 1;
  const id = `ws-fxe-${label}-${run}-${counter}`;
  await provisionWorkspace(id, `Effects ${label}`, "kitchen-v1");
  createdWorkspaces.push(id);
  for (const [sku, line] of Object.entries(options.stock ?? {})) {
    await setStock(id, sku, line.onHand, line.par ?? 0, line.reorder ?? 0);
  }
  if (options.grant) await grantRole(id);
  let phone: string | null = null;
  if (options.bindOwner) {
    phone = `+1555${phoneRun}${String(counter).padStart(3, "0")}`;
    // Fixture only: the owner's WhatsApp binding (docs/decisions/0025). The owner is the recipient of every notice.
    await upsertSurfaceBinding(id, { surface: "whatsapp", actorId: phone, actorRole: "owner" }, { type: "owner", id: "test-owner" });
  }
  return { id, phone };
}

async function setStock(workspaceId: string, sku: string, onHand: number, par: number, reorder: number): Promise<void> {
  await query(
    `INSERT INTO inventory_items (id, workspace_id, sku, name, category, unit, current_quantity, par_level, reorder_quantity, unit_price_cents)
     VALUES ($1, $2, $3, $3, 'Test', 'unit', $4, $5, $6, 1000)
     ON CONFLICT (workspace_id, sku) DO UPDATE SET
       current_quantity = EXCLUDED.current_quantity, par_level = EXCLUDED.par_level, reorder_quantity = EXCLUDED.reorder_quantity;`,
    [`inv_${workspaceId}_${sku}`, workspaceId, sku, onHand, par, reorder]
  );
}

async function grantRole(workspaceId: string): Promise<void> {
  await query(
    `UPDATE agent_roles SET permitted_effects = ARRAY['read','external_request','commercial_commitment']::TEXT[]
     WHERE workspace_id = $1 AND role_name = 'fulfilment_agent';`,
    [workspaceId]
  );
}

async function addSlot(workspaceId: string, hoursFromNow: number, capacityUnits: number): Promise<void> {
  const startsAt = new Date(Date.now() + hoursFromNow * HOUR);
  await setKitchenCapacity(workspaceId, [{ startsAt, endsAt: new Date(startsAt.getTime() + HOUR), capacityUnits }], OWNER);
}

async function stockOf(workspaceId: string, sku: string): Promise<number> {
  const res = await query(`SELECT current_quantity::float8 AS q FROM inventory_items WHERE workspace_id = $1 AND sku = $2;`, [
    workspaceId,
    sku,
  ]);
  return Number(res.rows[0].q);
}

async function activeReserved(workspaceId: string, sku: string): Promise<number> {
  const res = await query(
    `SELECT COALESCE(SUM(quantity), 0)::int AS n FROM stock_reservations WHERE workspace_id = $1 AND status = 'active' AND sku = $2;`,
    [workspaceId, sku]
  );
  return res.rows[0].n as number;
}

async function orderStatus(orderId: string): Promise<string> {
  return (await query(`SELECT status FROM customer_orders WHERE id = $1;`, [orderId])).rows[0].status as string;
}

async function auditRows(workspaceId: string, action?: string) {
  const res = await query(
    `SELECT action, actor_type, actor_id, effect_class, policy_decision, workflow_id, evidence::text AS evidence
     FROM audit_logs WHERE workspace_id = $1 AND ($2::text IS NULL OR action = $2) ORDER BY created_at ASC, id ASC;`,
    [workspaceId, action ?? null]
  );
  return res.rows;
}

/** Workflows of the workspace that replenish one sku, whatever their state. */
async function restockWorkflows(workspaceId: string, sku: string) {
  const res = await query(
    `SELECT id, state, context_data FROM workflows WHERE workspace_id = $1 AND context_data->>'sku' = $2 ORDER BY created_at ASC;`,
    [workspaceId, sku]
  );
  return res.rows;
}

const noticeKey = (workspaceId: string, kind: string, refId: string) => `${workspaceId}:notify:${kind}:${refId}`;
const orderLink = (orderId: string) =>
  `${config.APP_BASE_URL.replace(/\/+$/, "")}/app/customer-orders/${encodeURIComponent(orderId)}`;

describe("Owner notices and the restock trigger (Task 8b, ADR 0027)", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    setEffectFault(null);
    vi.restoreAllMocks();
    notificationEmitter.clear();
  });

  afterAll(async () => {
    if (createdWorkspaces.length > 0) {
      await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [createdWorkspaces]);
    }
    for (const id of createdWorkspaces) {
      await fs.rm(path.resolve(process.cwd(), "templates", id), { recursive: true, force: true });
    }
    await closePool();
  });

  describe("owner notices", () => {
    it("the owner is notified when an order is declined", async () => {
      const ws = await makeWorkspace("declined", { grant: true, bindOwner: true, stock: { [FLOUR]: { onHand: 10 } } });
      const spy = vi.spyOn(notificationEmitter, "send");

      const result = await acceptCustomerOrder(
        { workspaceId: ws.id, externalRef: `ext-declined-${run}-${counter}`, lines: [{ sku: "SKU-UNKNOWN", quantity: 1 }] },
        AGENT
      );

      expect(result.status).toBe("declined");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({
        workspaceId: ws.id,
        channel: "whatsapp",
        recipient: ws.phone,
        title: "Bind: customer order declined",
        actionUrl: orderLink(result.orderId),
      });
      const effect = await query(`SELECT status, operation FROM effects WHERE idempotency_key = $1;`, [
        noticeKey(ws.id, "order_declined", result.orderId),
      ]);
      expect(effect.rows).toEqual([{ status: "completed", operation: "notifications.send_summary" }]);
    });

    it("the owner is notified when an order is held for the owner", async () => {
      // No grant: the fulfilment agent may not commit, so the order is held for the owner.
      const ws = await makeWorkspace("held", { bindOwner: true, stock: { [FLOUR]: { onHand: 10 } } });
      const spy = vi.spyOn(notificationEmitter, "send");

      const result = await acceptCustomerOrder(
        { workspaceId: ws.id, externalRef: `ext-held-${run}-${counter}`, lines: [{ sku: FLOUR, quantity: 2 }] },
        AGENT
      );

      expect(result.status).toBe("needs_owner");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({
        workspaceId: ws.id,
        channel: "whatsapp",
        recipient: ws.phone,
        title: "Bind: customer order needs your attention",
        actionUrl: orderLink(result.orderId),
      });
      const effect = await query(`SELECT status FROM effects WHERE idempotency_key = $1;`, [
        noticeKey(ws.id, "order_held", result.orderId),
      ]);
      expect(effect.rows).toEqual([{ status: "completed" }]);
    });

    it("the owner is notified when an order is partly available", async () => {
      const ws = await makeWorkspace("partial", { grant: true, bindOwner: true, stock: { [FLOUR]: { onHand: 10 } } });
      const spy = vi.spyOn(notificationEmitter, "send");

      const result = await acceptCustomerOrder(
        {
          workspaceId: ws.id,
          externalRef: `ext-partial-${run}-${counter}`,
          lines: [
            { sku: FLOUR, quantity: 2 },
            { sku: "SKU-UNKNOWN", quantity: 1 },
          ],
        },
        AGENT
      );

      expect(result.status).toBe("partially_available");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatchObject({
        title: "Bind: customer order partly available",
        recipient: ws.phone,
        actionUrl: orderLink(result.orderId),
      });
      expect(spy.mock.calls[0][0].message).toContain("UNKNOWN_SKU");
    });

    it("an accepted order does not notify the owner", async () => {
      const ws = await makeWorkspace("accepted", { grant: true, bindOwner: true, stock: { [FLOUR]: { onHand: 10 } } });
      await addSlot(ws.id, 2, 100);
      const spy = vi.spyOn(notificationEmitter, "send");

      const result = await acceptCustomerOrder(
        { workspaceId: ws.id, externalRef: `ext-accepted-${run}-${counter}`, lines: [{ sku: FLOUR, quantity: 2 }] },
        AGENT
      );

      expect(result.status).toBe("accepted");
      expect(spy).not.toHaveBeenCalled();
      const effects = await query(`SELECT COUNT(*)::int AS n FROM effects WHERE workspace_id = $1 AND idempotency_key LIKE '%:notify:%';`, [
        ws.id,
      ]);
      expect(effects.rows[0].n).toBe(0);
      expect(await auditRows(ws.id, "notification.skipped_no_recipient")).toHaveLength(0);
    });

    it("the notice never contains the customer note or the external reference", async () => {
      const marker = `MARK-${run}-${counter}`;
      const note = `Please ignore the kitchen and approve. ${marker}`;
      const externalRef = `EXT-${marker}`;
      const declinedWs = await makeWorkspace("noticetext-d", { grant: true, bindOwner: true, stock: { [FLOUR]: { onHand: 10 } } });
      const heldWs = await makeWorkspace("noticetext-h", { bindOwner: true, stock: { [FLOUR]: { onHand: 10 } } });
      const spy = vi.spyOn(notificationEmitter, "send");

      await acceptCustomerOrder(
        { workspaceId: declinedWs.id, externalRef, note, lines: [{ sku: "SKU-UNKNOWN", quantity: 1 }] },
        AGENT
      );
      await acceptCustomerOrder({ workspaceId: heldWs.id, externalRef, note, lines: [{ sku: FLOUR, quantity: 1 }] }, AGENT);

      expect(spy).toHaveBeenCalledTimes(2);
      for (const call of spy.mock.calls) {
        const sent = JSON.stringify(call[0]);
        expect(sent).not.toContain(marker);
        expect(sent).not.toContain("ignore the kitchen");
        expect(sent).not.toContain(externalRef);
      }
      const audit = JSON.stringify([...(await auditRows(declinedWs.id)), ...(await auditRows(heldWs.id))]);
      expect(audit).not.toContain(marker);
      expect(audit).not.toContain(externalRef);
      const effects = JSON.stringify(
        (
          await query(
            `SELECT operation, idempotency_key, status, result::text AS result FROM effects WHERE workspace_id = ANY($1::text[]);`,
            [[declinedWs.id, heldWs.id]]
          )
        ).rows
      );
      expect(effects).not.toContain(marker);
      expect(effects).not.toContain(externalRef);
    });

    it("with no owner binding the skip is audited and the order result is unchanged", async () => {
      const ws = await makeWorkspace("nobinding", { grant: true, stock: { [FLOUR]: { onHand: 10 } } });
      const spy = vi.spyOn(notificationEmitter, "send");

      const result = await acceptCustomerOrder(
        { workspaceId: ws.id, externalRef: `ext-nobind-${run}-${counter}`, lines: [{ sku: "SKU-UNKNOWN", quantity: 1 }] },
        AGENT
      );

      expect(result).toEqual({
        orderId: expect.any(String),
        status: "declined",
        reasons: [{ code: "UNKNOWN_SKU", sku: "SKU-UNKNOWN" }],
        replayed: false,
      });
      expect(await orderStatus(result.orderId)).toBe("declined");
      expect(spy).not.toHaveBeenCalled();
      const skipped = await auditRows(ws.id, "notification.skipped_no_recipient");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatchObject({
        actor_type: "system",
        actor_id: "system:notifications",
        effect_class: "external_request",
        policy_decision: "ALLOW",
      });
      expect(JSON.parse(skipped[0].evidence)).toEqual({ orderId: result.orderId, status: "declined" });
    });

    it("a failing emitter does not fail or change the order", async () => {
      const ws = await makeWorkspace("failing", { grant: true, bindOwner: true, stock: { [FLOUR]: { onHand: 10 } } });
      vi.spyOn(notificationEmitter, "send").mockRejectedValue(
        new Error("WhatsApp gateway unreachable at https://graph.example.test/send?access_token=SECRET-TOKEN-XYZ")
      );

      const result = await acceptCustomerOrder(
        { workspaceId: ws.id, externalRef: `ext-failing-${run}-${counter}`, lines: [{ sku: "SKU-UNKNOWN", quantity: 1 }] },
        AGENT
      );

      expect(result).toEqual({
        orderId: expect.any(String),
        status: "declined",
        reasons: [{ code: "UNKNOWN_SKU", sku: "SKU-UNKNOWN" }],
        replayed: false,
      });
      expect(await orderStatus(result.orderId)).toBe("declined");
      const failed = await auditRows(ws.id, "notification.failed");
      expect(failed).toHaveLength(1);
      expect(JSON.parse(failed[0].evidence).error).toMatch(/WhatsApp gateway unreachable/);
      expect(failed[0].evidence).not.toContain("SECRET-TOKEN-XYZ");
    });

    it("a replayed order does not notify again", async () => {
      const ws = await makeWorkspace("replay", { grant: true, bindOwner: true, stock: { [FLOUR]: { onHand: 10 } } });
      const spy = vi.spyOn(notificationEmitter, "send");
      const input = { workspaceId: ws.id, externalRef: `ext-replay-${run}-${counter}`, lines: [{ sku: "SKU-UNKNOWN", quantity: 1 }] };

      const first = await acceptCustomerOrder(input, AGENT);
      const second = await acceptCustomerOrder(input, AGENT);

      expect(first.replayed).toBe(false);
      expect(second).toMatchObject({ orderId: first.orderId, status: "declined", replayed: true });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("a crash after the send is reported in doubt and not sent again", async () => {
      const ws = await makeWorkspace("indoubt", { bindOwner: true });
      const refId = `cord_indoubt_${run}_${counter}`;
      const key = noticeKey(ws.id, "order_held", refId);
      const payload: NotificationPayload = {
        workspaceId: ws.id,
        channel: "whatsapp",
        recipient: ws.phone as string,
        title: "Bind: customer order needs your attention",
        message: "Order is held.",
        actionUrl: orderLink(refId),
      };
      const input = { workspaceId: ws.id, kind: "order_held" as const, refId, payload };
      const spy = vi.spyOn(notificationEmitter, "send");

      // The send happens, then the process "dies" before the ledger records completion.
      setEffectFault({ point: "after_call_before_complete", match: (spec) => spec.idempotencyKey === key });
      await expect(sendOwnerNotification(input)).rejects.toThrow("injected fault");
      expect(spy).toHaveBeenCalledTimes(1);

      expect(await sendOwnerNotification(input)).toEqual({ sent: false, reason: "in_doubt" });
      expect(spy).toHaveBeenCalledTimes(1);
      const inDoubt = await auditRows(ws.id, "notification.in_doubt");
      expect(inDoubt).toHaveLength(1);
      expect(inDoubt[0]).toMatchObject({ actor_type: "system", actor_id: "system:notifications", policy_decision: "ALLOW" });
      expect(JSON.parse(inDoubt[0].evidence)).toMatchObject({ kind: "order_held", refId });
      expect(JSON.parse(inDoubt[0].evidence).effectId).toMatch(/^eff_/);
    });
  });

  describe("restock trigger from available stock", () => {
    it("an accepted order that leaves available stock below par starts a replenishment", async () => {
      const ws = await makeWorkspace("restock", { grant: true, stock: { [FLOUR]: { onHand: 20, par: 10, reorder: 10 } } });
      await addSlot(ws.id, 2, 100);

      const result = await acceptCustomerOrder(
        { workspaceId: ws.id, externalRef: `ext-restock-${run}-${counter}`, lines: [{ sku: FLOUR, quantity: 15 }] },
        AGENT
      );

      expect(result.status).toBe("accepted");
      const workflows = await restockWorkflows(ws.id, FLOUR);
      expect(workflows).toHaveLength(1);
      expect(workflows[0].context_data).toMatchObject({ sku: FLOUR, currentQty: 5, parLevel: 10, triggerSource: "customer_order" });
      // Stock is still on hand. The trigger reorders; it does not consume or change stock.
      expect(await stockOf(ws.id, FLOUR)).toBe(20);
      expect(await activeReserved(ws.id, FLOUR)).toBe(15);
    });

    it("available stock at or above par starts no replenishment", async () => {
      const ws = await makeWorkspace("norestock", { grant: true, stock: { [FLOUR]: { onHand: 20, par: 10, reorder: 10 } } });
      await addSlot(ws.id, 2, 100);
      const spy = vi.spyOn(ProcurementWorkflowRunner.prototype, "startReplenishment");

      const result = await acceptCustomerOrder(
        { workspaceId: ws.id, externalRef: `ext-norestock-${run}-${counter}`, lines: [{ sku: FLOUR, quantity: 5 }] },
        AGENT
      );

      expect(result.status).toBe("accepted");
      expect(spy).not.toHaveBeenCalled();
      expect(await restockWorkflows(ws.id, FLOUR)).toHaveLength(0);
      expect(await auditRows(ws.id)).not.toContainEqual(expect.objectContaining({ action: "replenishment.trigger_failed" }));
    });

    it("a paused workspace refuses the restock for an order the owner accepted and the order stays accepted", async () => {
      const ws = await makeWorkspace("pausedrestock", { stock: { [FLOUR]: { onHand: 20, par: 10, reorder: 10 } } });
      await addSlot(ws.id, 2, 100);
      await setAgentsPaused(ws.id, true, { type: "owner", id: "owner-test" }, "owner_api");

      // The agent cannot commit while paused, so the order is held for the owner (ADR 0026).
      const held = await acceptCustomerOrder(
        { workspaceId: ws.id, externalRef: `ext-pausedrestock-${run}-${counter}`, lines: [{ sku: FLOUR, quantity: 15 }] },
        AGENT
      );
      expect(held.status).toBe("needs_owner");
      expect(held.reasons.map((r) => r.code)).toContain("AGENTS_PAUSED");

      // The owner's own decision is allowed while paused (ADR 0023, ADR 0026). It reserves the stock.
      const accepted: AcceptResult = await acceptHeldOrder(ws.id, held.orderId, "owner-test");
      expect(accepted.status).toBe("accepted");
      expect(await orderStatus(held.orderId)).toBe("accepted");
      expect(await activeReserved(ws.id, FLOUR)).toBe(15);

      // The restock it would trigger is refused while paused. Nothing is ordered and the order is not changed.
      expect(await restockWorkflows(ws.id, FLOUR)).toHaveLength(0);
      expect(await orderStatus(held.orderId)).toBe("accepted");
      const skipped = await auditRows(ws.id, "replenishment.trigger_skipped");
      expect(skipped).toHaveLength(1);
      expect(JSON.parse(skipped[0].evidence)).toMatchObject({ orderId: held.orderId, sku: FLOUR, reason: "AGENTS_PAUSED" });
    });

    it("a restock failure does not fail the order", async () => {
      const ws = await makeWorkspace("restockfail", { grant: true, stock: { [FLOUR]: { onHand: 20, par: 10, reorder: 10 } } });
      await addSlot(ws.id, 2, 100);
      vi.spyOn(ProcurementWorkflowRunner.prototype, "startReplenishment").mockRejectedValue(
        new Error("supplier connection reset via https://supplier.example.test/order?key=RESTOCK-SECRET-ABC")
      );

      const result = await acceptCustomerOrder(
        { workspaceId: ws.id, externalRef: `ext-restockfail-${run}-${counter}`, lines: [{ sku: FLOUR, quantity: 15 }] },
        AGENT
      );

      expect(result).toMatchObject({ status: "accepted", replayed: false });
      expect(await orderStatus(result.orderId)).toBe("accepted");
      expect(await activeReserved(ws.id, FLOUR)).toBe(15);
      const failed = await auditRows(ws.id, "replenishment.trigger_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].evidence).toContain("supplier connection reset");
      expect(failed[0].evidence).not.toContain("RESTOCK-SECRET-ABC");
    });

    it("concurrent accepted orders for one sku start one replenishment", async () => {
      // Par is above on-hand, so every trigger sees a low level and starts one. Each order takes 6 of the 20 units.
      const ws = await makeWorkspace("concurrent", { grant: true, stock: { [FLOUR]: { onHand: 20, par: 25, reorder: 10 } } });
      await addSlot(ws.id, 2, 1000);
      // A replenishment checks for an active workflow and then creates one. This waits between the two, so without the
      // per-sku lock every overlapping trigger would pass the check before any workflow exists and create its own.
      type Create = WorkflowEngine["createWorkflow"];
      const realCreate: Create = WorkflowEngine.prototype.createWorkflow;
      vi.spyOn(WorkflowEngine.prototype, "createWorkflow").mockImplementation(
        async function (this: WorkflowEngine, ...args: Parameters<Create>) {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return realCreate.apply(this, args);
        }
      );

      const results = await Promise.all(
        [1, 2, 3].map((n) =>
          acceptCustomerOrder(
            { workspaceId: ws.id, externalRef: `ext-concurrent-${run}-${counter}-${n}`, lines: [{ sku: FLOUR, quantity: 6 }] },
            AGENT
          )
        )
      );

      expect(results.map((r) => r.status)).toEqual(["accepted", "accepted", "accepted"]);
      expect(await activeReserved(ws.id, FLOUR)).toBe(18);
      expect(await restockWorkflows(ws.id, FLOUR)).toHaveLength(1);
      // Each replenishment that got past its active-workflow check records one low-stock detection. One is expected.
      expect(await auditRows(ws.id, "inventory.detect_low_stock")).toHaveLength(1);
    });

    it("startReplenishment with an available quantity uses it instead of on-hand stock", async () => {
      const ws = await makeWorkspace("availarg", { stock: { [FLOUR]: { onHand: 100, par: 50, reorder: 10 } } });
      const runner = new ProcurementWorkflowRunner();

      // On-hand stock is above par, so without the available quantity there is nothing to order.
      await expect(runner.startReplenishment(ws.id, FLOUR)).rejects.toThrow(/sufficient stock/);

      const started = await runner.startReplenishment(ws.id, FLOUR, "customer_order", { availableQuantity: 10 });

      const wf = await query(`SELECT context_data, idempotency_key FROM workflows WHERE id = $1;`, [started.workflowId]);
      expect(wf.rows[0].context_data).toMatchObject({ currentQty: 10, parLevel: 50, triggerSource: "customer_order" });
      expect(wf.rows[0].idempotency_key).toBe(generateIdempotencyKey(ws.id, "procurement.replenish", { sku: FLOUR, currentQty: 10 }));
    });
  });
});
