import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { Server } from "node:http";
import crypto from "crypto";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { ProcurementWorkflowRunner } from "../../src/workflows/procurement.js";
import { acceptCustomerOrder, type AgentActor } from "../../src/workflows/fulfilment.js";
import { proposeMenuChange } from "../../src/workflows/menu.js";
import type { OwnerActor } from "../../src/workflows/fulfilment.js";
import { ingestFeedback } from "../../src/workflows/feedback.js";
import { SimulatedSupplierAdapter } from "../../src/adapters/suppliers/simulated.js";
import { setEffectFault } from "../../src/effects/faults.js";
import type { SupplierAdapter } from "../../src/adapters/suppliers/types.js";
import type {
  SettlementAdapter,
  SettlementStatus,
  TransferRequest,
  TransferResult,
} from "../../src/adapters/settlement/types.js";

/**
 * The needs-attention list (ADR 0030). A member reads it. It holds only ids, codes, enum values and times. Each test
 * here creates the condition with real services where it can, and ages rows with SQL where the window is time.
 */

const run = Date.now();
const FLOUR = "FOOD-FLOUR-50LB";
const PAYER = `0x${"11".repeat(20)}`;
const PAYEE = `0x${"22".repeat(20)}`;
const AGENT: AgentActor = { kind: "agent", roleName: "fulfilment_agent" };
const OWNER: OwnerActor = { kind: "owner", label: "attention-owner" };

const engine = new WorkflowEngine();
const created: string[] = [];
let counter = 0;

async function newWorkspace(label: string): Promise<string> {
  counter += 1;
  const id = `ws-attn-${label}-${run}-${counter}`;
  await provisionWorkspace(id, `Attention ${label}`, "kitchen-v1", {
    customDailyLimitCents: 10_000_000n,
    customApprovalThresholdCents: 10_000_000n,
  });
  await query(`UPDATE workspaces SET settlement_address = $2 WHERE id = $1;`, [id, PAYER]);
  created.push(id);
  return id;
}

class QuietSettlement implements SettlementAdapter {
  readonly mode = "local" as const;
  readonly transfers: TransferRequest[] = [];
  private seq = 0;
  async getBalance(): Promise<bigint> {
    return 1_000_000n;
  }
  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    this.transfers.push(req);
    this.seq += 1;
    const txHash = `0x${crypto.createHash("sha256").update(`${req.idempotencyKey}:${this.seq}`).digest("hex")}`;
    return { txHash, status: "submitted", timestamp: new Date(), mode: "local", simulated: true };
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

function supplierAdapter(): SupplierAdapter {
  const base = new SimulatedSupplierAdapter("supp-sysco-metro", "Attention Supplier", 1.0);
  return {
    supplierId: base.supplierId,
    supplierName: base.supplierName,
    isSimulated: true,
    requestQuote: (req) => base.requestQuote(req),
    submitOrder: (req) => base.submitOrder(req),
    generateDeliveryReceipt: (orderId, sku, quantity) => base.generateDeliveryReceipt(orderId, sku, quantity),
    generateBill: (orderId, sku, quantity, unitPriceCents, vendorId) =>
      base.generateBill(orderId, sku, quantity, unitPriceCents, vendorId),
  };
}

async function orderRow(orderId: string): Promise<any> {
  return (await query(`SELECT * FROM orders WHERE id = $1;`, [orderId])).rows[0];
}

/** A flour order that is confirmed and whose supplier is verified and payable, as the runner leaves it. */
async function confirmedOrder(runner: ProcurementWorkflowRunner, ws: string): Promise<{ orderId: string; workflowId: string }> {
  const started = await runner.startReplenishment(ws, FLOUR);
  expect(started.state).toBe(WorkflowState.CONFIRMED);
  const orderId = started.orderId!;
  await query(`UPDATE suppliers SET verified = TRUE, payment_address = $2 WHERE id = $1;`, [(await orderRow(orderId)).supplier_id, PAYEE]);
  return { orderId, workflowId: started.workflowId };
}

async function insertEffect(ws: string, operation: string, status: "started" | "failed", age: string): Promise<string> {
  const id = `eff_attn_${crypto.randomUUID()}`;
  await query(
    `INSERT INTO effects (id, workspace_id, effect_class, operation, idempotency_key, request_hash, status, attempts, created_at, updated_at)
     VALUES ($1, $2, 'external_request', $3, $4, 'hash', $5, 1, NOW() - $6::interval, NOW() - $6::interval);`,
    [id, ws, operation, `attn:${id}`, status, age]
  );
  return id;
}

interface AttentionItem {
  kind: string;
  id: string;
  since: string;
  codes: string[];
  nextAction: string;
}

describe("the needs-attention list (PostgreSQL)", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";

  async function list(token: string, ws: string) {
    const res = await fetch(`${baseUrl}/api/workspaces/${ws}/needs-attention`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as { items: AttentionItem[]; capped: boolean }, text };
  }

  async function ownerTokenFor(ws: string): Promise<string> {
    return (await issueToken(ws, "owner", `owner-${counter}`)).token;
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

  afterEach(async () => {
    for (const id of created.splice(0)) {
      await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
  });

  it("lists only this workspace's items", async () => {
    const a = await newWorkspace("scope-a");
    const b = await newWorkspace("scope-b");
    const effectA = await insertEffect(a, "suppliers.request_quote", "started", "10 minutes");
    const effectB = await insertEffect(b, "suppliers.request_quote", "started", "10 minutes");
    const tokenA = await ownerTokenFor(a);

    const seen = await list(tokenA, a);
    expect(seen.status).toBe(200);
    const ids = seen.body.items.map((i) => i.id);
    expect(ids).toContain(effectA);
    expect(ids).not.toContain(effectB);

    // Another workspace's token gets the same 404 a missing workspace gets, and sees nothing of B.
    const crossed = await list(tokenA, b);
    expect(crossed.status).toBe(404);
    expect(crossed.text).not.toContain(effectB);
  });

  it("contains no customer text or note", async () => {
    const ws = await newWorkspace("no-text");
    const token = await ownerTokenFor(ws);
    const secrets = {
      note: `CUSTOMER-NOTE-SECRET-${run}`,
      externalRef: `EXTREF-SECRET-${run}`,
      feedback: `FEEDBACK-SECRET-${run}`,
      rationale: `RATIONALE-SECRET-${run}`,
      menuName: `MENU-NAME-SECRET-${run}`,
    };
    // A held customer order with a note and a reference of the customer's choosing. Paused, so it is held.
    await query(`UPDATE workspaces SET agents_paused = TRUE WHERE id = $1;`, [ws]);
    const held = await acceptCustomerOrder(
      { workspaceId: ws, externalRef: secrets.externalRef, lines: [{ sku: FLOUR, quantity: 1 }], note: secrets.note },
      AGENT
    );
    expect(held.status).toBe("needs_owner");
    await query(`UPDATE workspaces SET agents_paused = FALSE WHERE id = $1;`, [ws]);
    await ingestFeedback({ workspaceId: ws, source: "guest_review", externalId: `ext-${run}`, text: secrets.feedback });
    await proposeMenuChange(
      { workspaceId: ws, change: { type: "add_item", name: secrets.menuName, priceCents: 800 }, rationale: secrets.rationale },
      OWNER
    );
    // A payment hold: the order is confirmed, then held with no audit hold code, so it reports UNKNOWN.
    const { orderId } = await confirmedOrder(new ProcurementWorkflowRunner({ supplierFor: () => supplierAdapter(), settlementFor: () => new QuietSettlement() }), ws);
    await query(`UPDATE orders SET status = 'payment_hold', updated_at = NOW() - INTERVAL '1 hour' WHERE id = $1;`, [orderId]);

    const res = await list(token, ws);

    expect(res.status).toBe(200);
    expect(res.body.items.map((i) => i.kind)).toEqual(expect.arrayContaining(["customer_order_held", "menu_proposal_awaiting", "payment_hold"]));
    for (const secret of Object.values(secrets)) {
      expect(res.text).not.toContain(secret);
    }
  });

  it("an in-doubt effect appears after two minutes and not before", async () => {
    const ws = await newWorkspace("in-doubt");
    const token = await ownerTokenFor(ws);
    const effect = await insertEffect(ws, "orders.submit", "started", "90 seconds");

    const early = await list(token, ws);
    expect(early.body.items.find((i) => i.id === effect)).toBeUndefined();

    await query(`UPDATE effects SET updated_at = NOW() - INTERVAL '130 seconds' WHERE id = $1;`, [effect]);
    const later = await list(token, ws);
    const item = later.body.items.find((i) => i.id === effect);
    expect(item).toMatchObject({ kind: "effect_in_doubt", codes: ["orders.submit", "started"], nextAction: "RESOLVE_EFFECT" });
    expect(Number.isNaN(Date.parse(item!.since))).toBe(false);
  });

  it("a payment hold lists its hold code", async () => {
    const ws = await newWorkspace("hold");
    const token = await ownerTokenFor(ws);
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplierAdapter(), settlementFor: () => new QuietSettlement() });
    const { orderId } = await confirmedOrder(runner, ws);
    // The supplier is not verified, so the match passes and the payment is held before any transfer.
    await query(`UPDATE suppliers SET verified = FALSE WHERE id = $1;`, [(await orderRow(orderId)).supplier_id]);
    const held = await runner.fulfillAndReconcile(orderId, ws);
    expect(held.hold).toBe("SUPPLIER_NOT_VERIFIED");

    const res = await list(token, ws);
    expect(res.body.items.find((i) => i.id === orderId)).toMatchObject({
      kind: "payment_hold",
      codes: ["SUPPLIER_NOT_VERIFIED"],
      nextAction: "RECONCILE_ORDER",
    });

    // A hold with no audit row that names a hold code reports UNKNOWN.
    const second = await newWorkspace("hold-unknown");
    const secondRunner = new ProcurementWorkflowRunner({ supplierFor: () => supplierAdapter(), settlementFor: () => new QuietSettlement() });
    const unknown = await confirmedOrder(secondRunner, second);
    await query(`UPDATE orders SET status = 'payment_hold' WHERE id = $1;`, [unknown.orderId]);
    const other = await list(await ownerTokenFor(second), second);
    expect(other.body.items.find((i) => i.id === unknown.orderId)).toMatchObject({ kind: "payment_hold", codes: ["UNKNOWN"] });
  });

  it("a settlement past the poll window says polling stopped", async () => {
    const ws = await newWorkspace("poll");
    const token = await ownerTokenFor(ws);
    const settle = new QuietSettlement();
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplierAdapter(), settlementFor: () => settle });
    const { orderId } = await confirmedOrder(runner, ws);
    const sent = await runner.fulfillAndReconcile(orderId, ws);
    expect(sent.pending).toBe("AWAITING_SETTLEMENT_CONFIRMATION");
    const key = `${ws}:settle:${orderId}`;

    // Sent six minutes ago: unconfirmed, and still being polled.
    await query(`UPDATE effects SET created_at = NOW() - INTERVAL '6 minutes' WHERE idempotency_key = $1;`, [key]);
    const polling = await list(token, ws);
    const pollingItem = polling.body.items.find((i) => i.id === orderId);
    expect(pollingItem).toMatchObject({ kind: "settlement_unconfirmed", nextAction: "CONFIRM_SETTLEMENT" });
    expect(pollingItem!.codes).not.toContain("POLLING_STOPPED");

    // Sent 25 hours ago: the worker no longer polls it.
    await query(`UPDATE effects SET created_at = NOW() - INTERVAL '25 hours' WHERE idempotency_key = $1;`, [key]);
    const stopped = await list(token, ws);
    expect(stopped.body.items.find((i) => i.id === orderId)!.codes).toContain("POLLING_STOPPED");
  });

  it("a submission left in doubt appears after five minutes and not before", async () => {
    const ws = await newWorkspace("submit-doubt");
    const token = await ownerTokenFor(ws);
    const runner = new ProcurementWorkflowRunner({ supplierFor: () => supplierAdapter(), settlementFor: () => new QuietSettlement() });
    // The supplier receives the order, then the process dies before the outcome is stored: the order stays `submitted`.
    setEffectFault({ point: "after_call_before_complete", match: (spec) => spec.operation === "orders.submit" && spec.workspaceId === ws });
    await expect(runner.startReplenishment(ws, FLOUR)).rejects.toThrow("injected fault");
    const wf = (await query(`SELECT id FROM workflows WHERE workspace_id = $1 AND state = 'submitted';`, [ws])).rows[0].id as string;
    const orderId = `ord_${wf}`;
    expect((await orderRow(orderId)).status).toBe("submitted");

    await query(`UPDATE workflows SET updated_at = NOW() - INTERVAL '4 minutes' WHERE id = $1;`, [wf]);
    expect((await list(token, ws)).body.items.find((i) => i.id === wf)).toBeUndefined();

    await query(`UPDATE workflows SET updated_at = NOW() - INTERVAL '6 minutes' WHERE id = $1;`, [wf]);
    const res = await list(token, ws);
    expect(res.body.items.find((i) => i.id === wf)).toMatchObject({
      kind: "order_submission_in_doubt",
      codes: ["SUPPLIER_OUTCOME_UNKNOWN"],
      nextAction: "RESOLVE_ORDER_WITH_SUPPLIER",
    });
  });

  it("a held customer order appears with its reason codes", async () => {
    const ws = await newWorkspace("held");
    const token = await ownerTokenFor(ws);
    await query(`UPDATE workspaces SET agents_paused = TRUE WHERE id = $1;`, [ws]);
    const held = await acceptCustomerOrder({ workspaceId: ws, externalRef: `held-${run}`, lines: [{ sku: FLOUR, quantity: 2 }] }, AGENT);
    expect(held.reasons.map((r) => r.code)).toContain("AGENTS_PAUSED");

    const res = await list(token, ws);
    const item = res.body.items.find((i) => i.id === held.orderId);
    expect(item).toMatchObject({ kind: "customer_order_held", nextAction: "ACCEPT_OR_CANCEL_ORDER" });
    expect(item!.codes).toEqual(expect.arrayContaining(["AGENTS_PAUSED"]));
    expect(item!.codes.every((code) => /^[A-Z_]+$/.test(code))).toBe(true);
  });

  it("a proposal awaiting a decision appears", async () => {
    const ws = await newWorkspace("proposal");
    const token = await ownerTokenFor(ws);
    const proposal = await proposeMenuChange({ workspaceId: ws, change: { type: "add_item", name: `Soup ${run}`, priceCents: 600 } }, OWNER);

    const res = await list(token, ws);
    expect(res.body.items.find((i) => i.id === proposal.proposalId)).toMatchObject({
      kind: "menu_proposal_awaiting",
      codes: ["proposed"],
      nextAction: "APPROVE_REJECT_OR_PUBLISH",
    });
  });

  it("an approval about to expire appears", async () => {
    const ws = await newWorkspace("approval");
    const token = await ownerTokenFor(ws);
    const soon = `appr_attn_soon_${run}_${counter}`;
    const later = `appr_attn_later_${run}_${counter}`;
    await engine.createApproval(soon, ws, "order", `wf_soon_${run}`, "submit_order", 24500n, "procurement");
    await engine.createApproval(later, ws, "order", `wf_later_${run}`, "submit_order", 24500n, "procurement");
    await query(`UPDATE approvals SET expires_at = NOW() + INTERVAL '30 minutes' WHERE id = $1;`, [soon]);
    await query(`UPDATE approvals SET expires_at = NOW() + INTERVAL '5 hours' WHERE id = $1;`, [later]);

    const res = await list(token, ws);
    expect(res.body.items.find((i) => i.id === soon)).toMatchObject({ kind: "approval_pending", nextAction: "DECIDE_APPROVAL" });
    expect(res.body.items.find((i) => i.id === later)).toBeUndefined();
  });

  it("the list is capped at 200 and says so", async () => {
    const ws = await newWorkspace("cap");
    const token = await ownerTokenFor(ws);
    await query(
      `INSERT INTO effects (id, workspace_id, effect_class, operation, idempotency_key, request_hash, status, attempts, created_at, updated_at)
       SELECT 'eff_cap_' || g || '_' || $2, $1, 'external_request', 'suppliers.request_quote', 'cap:' || g || ':' || $2, 'h', 'started', 1,
              NOW() - (g || ' minutes')::interval - INTERVAL '10 minutes', NOW() - (g || ' minutes')::interval - INTERVAL '10 minutes'
       FROM generate_series(1, 201) AS g;`,
      [ws, String(run)]
    );

    const res = await list(token, ws);

    expect(res.status).toBe(200);
    expect(res.body.capped).toBe(true);
    expect(res.body.items).toHaveLength(200);
    const times = res.body.items.map((i) => Date.parse(i.since));
    expect(times).toEqual([...times].sort((x, y) => x - y));
    // The oldest item is kept: the 201st minute, the oldest row inserted.
    expect(res.body.items[0].id).toBe(`eff_cap_201_${run}`);
    expect(res.body.items.some((i) => i.id === `eff_cap_1_${run}`)).toBe(false);
  });

  it("a short list is not capped", async () => {
    const ws = await newWorkspace("short");
    const token = await ownerTokenFor(ws);
    await insertEffect(ws, "suppliers.request_quote", "started", "10 minutes");
    const res = await list(token, ws);
    expect(res.body.capped).toBe(false);
    expect(res.body.items).toHaveLength(1);
  });

  it("staff can read it", async () => {
    const ws = await newWorkspace("staff");
    const staff = (await issueToken(ws, "staff", "line-cook")).token;
    const res = await list(staff, ws);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], capped: false });
  });

  it("every item has a next action", async () => {
    const ws = await newWorkspace("actions");
    const token = await ownerTokenFor(ws);
    await insertEffect(ws, "orders.submit", "failed", "10 minutes");
    await proposeMenuChange({ workspaceId: ws, change: { type: "add_item", name: `Bread ${run}`, priceCents: 300 } }, OWNER);
    await engine.createApproval(`appr_actions_${run}_${counter}`, ws, "order", `wf_actions_${run}`, "submit_order", 1n, "procurement");
    await query(`UPDATE approvals SET expires_at = NOW() + INTERVAL '10 minutes' WHERE workspace_id = $1;`, [ws]);

    const res = await list(token, ws);

    expect(res.body.items.length).toBeGreaterThanOrEqual(3);
    for (const item of res.body.items) {
      expect(typeof item.nextAction).toBe("string");
      expect(item.nextAction.length).toBeGreaterThan(0);
      expect(Array.isArray(item.codes)).toBe(true);
    }
    expect(new Set(res.body.items.map((i) => i.kind))).toEqual(new Set(["effect_in_doubt", "menu_proposal_awaiting", "approval_pending"]));
  });
});
