import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { config } from "../../src/config/env.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { createReplenishmentTools } from "../../src/agents/replenishmentTools.js";
import { notificationEmitter } from "../../src/adapters/web2/notifications.js";
import { sendApprovalNotification, sendOwnerNotification } from "../../src/notifications/dispatch.js";
import { requestOwnerEmailVerification, verifyOwnerEmail } from "../../src/notifications/owner-emails.js";
import { EmailRecipientNotVerifiedError, sendOwnerNoticeEmail } from "../../src/notifications/email.js";
import { upsertSurfaceBinding } from "../../src/adapters/socialSurface.js";
import { setLogSink } from "../../src/observability/logger.js";
import { startFakeResend, codeIn, type FakeResend } from "../helpers/fake-resend.js";

/**
 * End to end (ADR 0074): a real approval, made by the existing replenishment flow, reaches a verified owner's address
 * through a local fake provider. Exactly one email per owner, a second trigger sends nothing, a provider failure leaves the
 * approval intact and is audited, and two verified owners are each told once. With no provider the notice is simulated.
 */

const run = Date.now();
const SKU = "FOOD-FLOUR-50LB";
const KEY = "re_e2e_test_key_0123456789";
const SUPPLIER = "Sysco Metro Distribution";
const engine = new WorkflowEngine();
const logged: string[] = [];

let fake: FakeResend;
let counter = 0;
const wsIds: string[] = [];

const saved = {
  provider: config.BIND_EMAIL_PROVIDER,
  key: config.BIND_EMAIL_API_KEY,
  from: config.BIND_EMAIL_FROM,
  base: config.BIND_EMAIL_API_BASE,
};

function enableEmail(): void {
  config.BIND_EMAIL_PROVIDER = "resend";
  config.BIND_EMAIL_API_KEY = KEY;
  config.BIND_EMAIL_FROM = "Bind <notices@example.test>";
  config.BIND_EMAIL_API_BASE = fake.baseUrl;
}

function disableEmail(): void {
  config.BIND_EMAIL_PROVIDER = undefined;
  config.BIND_EMAIL_API_KEY = undefined;
  config.BIND_EMAIL_FROM = undefined;
  config.BIND_EMAIL_API_BASE = undefined;
}

beforeAll(async () => {
  await runMigrations();
  fake = await startFakeResend();
  setLogSink((line) => logged.push(line));
});

beforeEach(() => {
  fake.received.length = 0;
  fake.status = 200;
  fake.delayMs = 0;
  fake.rawBody = null;
  logged.length = 0;
  notificationEmitter.clear();
  enableEmail();
});

afterAll(async () => {
  setLogSink(null);
  config.BIND_EMAIL_PROVIDER = saved.provider;
  config.BIND_EMAIL_API_KEY = saved.key;
  config.BIND_EMAIL_FROM = saved.from;
  config.BIND_EMAIL_API_BASE = saved.base;
  await fake.close();
  for (const id of wsIds.splice(0)) {
    await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
  }
  await closePool();
});

/** A fresh kitchen workspace. Each test decides which owner addresses it has. */
async function freshWorkspace(): Promise<string> {
  counter += 1;
  const wsId = `ws-oen-${run}-${counter}`;
  wsIds.push(wsId);
  await provisionWorkspace(wsId, "Notice Kitchen", "kitchen-v1");
  return wsId;
}

/** Verifies an owner address through the real service: the code is taken from the fake provider's email. */
async function verifiedOwner(wsId: string, address: string): Promise<string> {
  const requested = await requestOwnerEmailVerification(wsId, address, "owner-e2e");
  const sent = fake.received.at(-1);
  if (!sent) throw new Error("no verification email was sent");
  const verified = await verifyOwnerEmail(wsId, requested.id, codeIn(sent), "owner-e2e");
  expect(verified.status).toBe("verified");
  return requested.id;
}

/**
 * Runs the real policy evaluation for a proposal that needs approval, so the approval notice goes through
 * createReplenishmentTools exactly as in production (the same setup as tests/integration/notification-recipients.test.ts).
 */
async function evaluateNeedingApproval(wsId: string): Promise<{ wfId: string; approvalId: string }> {
  counter += 1;
  const wfId = `wf_oen_${run}_${counter}`;
  const quoteId = `quote_oen_${run}_${counter}`;
  const totalCents = 30000;
  await query(
    `INSERT INTO quotes (id, workspace_id, rfq_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, currency, valid_until)
     VALUES ($1, $2, $3, $4, $5, $6, 10, $7, $8, 'USDC', NOW() + INTERVAL '1 day');`,
    [quoteId, wsId, `rfq_${quoteId}`, `${wsId}_supp-sysco-metro`, SUPPLIER, SKU, totalCents / 10, totalCents]
  );
  await engine.createWorkflow(wfId, wsId, "kitchen_replenishment", `idem_oen_${wfId}`, {
    sku: SKU,
    replenishmentProposal: {
      proposalId: `prop_${wfId}`,
      workflowId: wfId,
      sku: SKU,
      quantity: 10,
      supplierId: `${wsId}_supp-sysco-metro`,
      supplierName: SUPPLIER,
      quoteId,
      unitPriceCents: String(totalCents / 10),
      totalPriceCents: String(totalCents),
      jevEvaluation: { holdForOwnerReview: false },
      status: "VALIDATED",
    },
  });
  const tools = createReplenishmentTools({ workspaceId: wsId, workflowId: wfId });
  await tools.requestPolicyEvaluationTool.invoke({ requestId: wfId });
  return { wfId, approvalId: `appr_${wfId}` };
}

async function approvalStatus(approvalId: string): Promise<string> {
  const row = await query(`SELECT status FROM approvals WHERE id = $1;`, [approvalId]);
  return row.rows[0]?.status;
}

describe("owner email notices, end to end, against a local fake provider", () => {
  it("a real approval sends exactly one email to the verified owner, and a second trigger sends none", async () => {
    const wsId = await freshWorkspace();
    await verifiedOwner(wsId, "owner.one@kitchen.example");
    fake.received.length = 0;

    const { wfId, approvalId } = await evaluateNeedingApproval(wsId);
    expect(await approvalStatus(approvalId)).toBe("pending");

    expect(fake.received).toHaveLength(1);
    const email = fake.received[0];
    expect(email.body?.to).toEqual(["owner.one@kitchen.example"]);
    expect(email.body?.subject).toBe("Something is waiting for you in Bind");
    const text = email.body?.text ?? "";
    const [sentence] = text.split("\n");
    expect(sentence).toBe(`A purchase from ${SUPPLIER} for $300.00 USDC is waiting for your approval.`);
    expect(text).toContain(`${config.APP_BASE_URL.replace(/\/+$/, "")}/app/\n`);
    expect(text).toContain("Open Bind to look at it and decide. Nothing happens until you do.");
    expect(text).not.toMatch(/approve|reject|token|\/api\//i);

    // A second trigger for the same approval, with the same request, replays the completed effect: no second email.
    const [original] = notificationEmitter.getSentNotifications("email");
    const again = await sendApprovalNotification({ workspaceId: wsId, workflowId: wfId, approvalId, payload: original });
    expect(again).toEqual({ sent: true });
    expect(fake.received).toHaveLength(1);

    const ledger = await query(`SELECT status FROM effects WHERE idempotency_key = $1;`, [`${wsId}:notify:approval:${approvalId}`]);
    expect(ledger.rows[0]).toEqual({ status: "completed" });

    // Nothing in the logs names the address, the key or the code.
    const logText = logged.join("\n");
    expect(logText).not.toContain(KEY);
    expect(logText).not.toContain("owner.one@kitchen.example");
  });

  it("a provider failure leaves the approval pending, audits the failure, and is not sent again", async () => {
    const wsId = await freshWorkspace();
    await verifiedOwner(wsId, "owner.fail@kitchen.example");
    fake.received.length = 0;
    fake.status = 500;

    const { wfId, approvalId } = await evaluateNeedingApproval(wsId);
    expect(await approvalStatus(approvalId)).toBe("pending");
    expect(fake.received).toHaveLength(1);

    const failed = await query(
      `SELECT evidence::text AS evidence FROM audit_logs WHERE workspace_id = $1 AND action = 'notification.failed' AND evidence::text LIKE $2;`,
      [wsId, `%${approvalId}%`]
    );
    expect(failed.rows).toHaveLength(1);
    expect(failed.rows[0].evidence).toContain("HTTP 500");
    expect(failed.rows[0].evidence).not.toContain("owner.fail@kitchen.example");

    // The failed effect is in doubt: a retry does not send again, and says so in the audit.
    fake.status = 200;
    const [original] = notificationEmitter.getSentNotifications("email");
    const retry = await sendApprovalNotification({ workspaceId: wsId, workflowId: wfId, approvalId, payload: original });
    expect(retry).toEqual({ sent: false, reason: "in_doubt" });
    expect(fake.received).toHaveLength(1);
    expect(await approvalStatus(approvalId)).toBe("pending");
  });

  it("with two verified owners, each is told once, and a second trigger sends nothing more", async () => {
    const wsId = await freshWorkspace();
    const firstId = await verifiedOwner(wsId, "first.owner@kitchen.example");
    const secondId = await verifiedOwner(wsId, "second.owner@kitchen.example");
    fake.received.length = 0;

    const { wfId, approvalId } = await evaluateNeedingApproval(wsId);
    expect(fake.received.map((r) => r.body?.to?.[0]).sort()).toEqual(["first.owner@kitchen.example", "second.owner@kitchen.example"]);

    // The first (oldest verified) keeps the key used before there were several; the second adds its id.
    const keys = await query(`SELECT idempotency_key, status FROM effects WHERE workspace_id = $1 AND idempotency_key LIKE $2 ORDER BY idempotency_key;`, [
      wsId,
      `${wsId}:notify:approval:${approvalId}%`,
    ]);
    expect(keys.rows.map((r) => r.idempotency_key).sort()).toEqual(
      [`${wsId}:notify:approval:${approvalId}`, `${wsId}:notify:approval:${approvalId}:${secondId}`].sort()
    );
    expect(keys.rows.every((r) => r.status === "completed")).toBe(true);
    expect(firstId).not.toBe(secondId);

    // A second trigger for both owners, with the same requests, sends nothing more.
    const recorded = notificationEmitter.getSentNotifications("email");
    expect(recorded).toHaveLength(2);
    const first = recorded.find((p) => p.recipient === "first.owner@kitchen.example")!;
    const second = recorded.find((p) => p.recipient === "second.owner@kitchen.example")!;
    await sendApprovalNotification({ workspaceId: wsId, workflowId: wfId, approvalId, recipientId: null, payload: first });
    await sendApprovalNotification({ workspaceId: wsId, workflowId: wfId, approvalId, recipientId: secondId, payload: second });
    expect(fake.received).toHaveLength(2);
  });

  it("a removed owner address is not told, and the remaining one still is", async () => {
    const wsId = await freshWorkspace();
    await verifiedOwner(wsId, "kept.owner@kitchen.example");
    const removedId = await verifiedOwner(wsId, "removed.owner@kitchen.example");
    await query(`UPDATE owner_emails SET removed_at = NOW() WHERE id = $1;`, [removedId]);
    fake.received.length = 0;

    await evaluateNeedingApproval(wsId);
    expect(fake.received.map((r) => r.body?.to?.[0])).toEqual(["kept.owner@kitchen.example"]);
  });

  it("a customer order notice never carries the customer's text, even when the message holds it", async () => {
    const wsId = await freshWorkspace();
    await verifiedOwner(wsId, "owner.orders@kitchen.example");
    fake.received.length = 0;

    const out = await sendOwnerNotification({
      workspaceId: wsId,
      kind: "order_declined",
      refId: `ord_oen_${run}`,
      payload: {
        workspaceId: wsId,
        channel: "email",
        recipient: "owner.orders@kitchen.example",
        title: "Bind: customer order declined",
        message: "Order ord_x status: declined. CUSTOMER-NOTE-SENTINEL",
        actionUrl: "http://127.0.0.1:3000/app/customer-orders/ord_x",
      },
    });
    expect(out).toEqual({ sent: true });
    expect(fake.received).toHaveLength(1);
    const text = fake.received[0].body?.text ?? "";
    expect(text).toBe(
      `A customer order was declined.\n\n${config.APP_BASE_URL.replace(/\/+$/, "")}/app/\n\nOpen Bind to look at it and decide. Nothing happens until you do.\n`
    );
    expect(fake.received[0].rawBody).not.toContain("CUSTOMER-NOTE-SENTINEL");
  });

  it("with no provider, the notice is simulated and labelled so, and nothing reaches the fake provider", async () => {
    disableEmail();
    try {
      const wsId = await freshWorkspace();
      await upsertSurfaceBinding(wsId, { surface: "email", actorId: "simulated.owner@kitchen.example", actorRole: "owner" }, { type: "owner", id: "test" });
      const spy = vi.spyOn(notificationEmitter, "send");
      const { approvalId } = await evaluateNeedingApproval(wsId);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(fake.received).toHaveLength(0);
      const recorded = notificationEmitter.getSentNotifications("email");
      expect(recorded).toHaveLength(1);
      expect(recorded[0].recipient).toBe("simulated.owner@kitchen.example");
      const ledger = await query(`SELECT status FROM effects WHERE idempotency_key = $1;`, [`${wsId}:notify:approval:${approvalId}`]);
      expect(ledger.rows[0]).toEqual({ status: "completed" });
      vi.restoreAllMocks();
    } finally {
      enableEmail();
    }
  });

  it("with no owner address at all, the approval is pending and the skip is audited, as before (ADR 0025)", async () => {
    // A workspace with no owner address at all: the approval exists and is pending, with no notice.
    const wsId = await freshWorkspace();
    const { approvalId } = await evaluateNeedingApproval(wsId);
    expect(await approvalStatus(approvalId)).toBe("pending");
    expect(fake.received).toHaveLength(0);
    const skipped = await query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'notification.skipped_no_recipient';`, [wsId]);
    expect(skipped.rows[0].n).toBe(1);
  });
});

describe("an address is mailed only once it is verified (ADR 0074)", () => {
  it("an owner-created email binding with no verified address sends nothing when email is on", async () => {
    const wsId = await freshWorkspace();
    await upsertSurfaceBinding(wsId, { surface: "email", actorId: "typed.owner@kitchen.example", actorRole: "owner" }, { type: "owner", id: "test" });
    const { approvalId } = await evaluateNeedingApproval(wsId);

    expect(fake.received).toHaveLength(0);
    expect(notificationEmitter.getSentNotifications("email")).toHaveLength(0);
    expect(await approvalStatus(approvalId)).toBe("pending");
    const skipped = await query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1 AND action = 'notification.skipped_no_recipient';`, [wsId]);
    expect(skipped.rows[0].n).toBe(1);
  });

  it("a demo workspace with an owner email binding sends nothing when email is on", async () => {
    const wsId = await freshWorkspace();
    await query(`UPDATE workspaces SET is_demo = true, demo_expires_at = NOW() + INTERVAL '1 day' WHERE id = $1;`, [wsId]);
    await upsertSurfaceBinding(wsId, { surface: "email", actorId: "demo.owner@kitchen.example", actorRole: "owner" }, { type: "owner", id: "test" });
    const { approvalId } = await evaluateNeedingApproval(wsId);

    expect(fake.received).toHaveLength(0);
    expect(await approvalStatus(approvalId)).toBe("pending");
  });

  it("the send path refuses an address that is not a verified owner address, and nothing leaves the server", async () => {
    const wsId = await freshWorkspace();
    await expect(
      sendOwnerNotification({
        workspaceId: wsId,
        kind: "order_held",
        refId: `ord_unverified_${run}`,
        payload: {
          workspaceId: wsId,
          channel: "email",
          recipient: "never.verified@kitchen.example",
          title: "Bind",
          message: "x",
        },
      })
    ).resolves.toEqual({ sent: false, reason: "not_verified" });
    expect(fake.received).toHaveLength(0);
    const audit = await query(
      `SELECT evidence::text AS evidence FROM audit_logs WHERE workspace_id = $1 AND action = 'notification.skipped_no_recipient';`,
      [wsId]
    );
    expect(audit.rows[0].evidence).toContain("email_not_verified");
    expect(audit.rows[0].evidence).not.toContain("never.verified@kitchen.example");
  });

  it("the send function itself refuses an unverified address (defence in depth)", async () => {
    const wsId = await freshWorkspace();
    await expect(
      sendOwnerNoticeEmail({
        workspaceId: wsId,
        channel: "email",
        recipient: "direct.unverified@kitchen.example",
        title: "Bind",
        message: "x",
        metadata: { noticeKind: "order_held" },
      })
    ).rejects.toBeInstanceOf(EmailRecipientNotVerifiedError);
    expect(fake.received).toHaveLength(0);
  });

  it("a verified address that has since been removed is not sent to", async () => {
    const wsId = await freshWorkspace();
    const id = await verifiedOwner(wsId, "removed.later@kitchen.example");
    await query(`UPDATE owner_emails SET removed_at = NOW() WHERE id = $1;`, [id]);
    fake.received.length = 0;
    const out = await sendOwnerNotification({
      workspaceId: wsId,
      kind: "order_held",
      refId: `ord_removed_${run}`,
      payload: { workspaceId: wsId, channel: "email", recipient: "removed.later@kitchen.example", title: "Bind", message: "x" },
    });
    expect(out).toEqual({ sent: false, reason: "not_verified" });
    expect(fake.received).toHaveLength(0);
  });

  it("the ledger keeps no address: the stored effect row holds a hash, not the recipient", async () => {
    const wsId = await freshWorkspace();
    const address = "ledger.check@kitchen.example";
    await verifiedOwner(wsId, address);
    fake.received.length = 0;
    await sendOwnerNotification({
      workspaceId: wsId,
      kind: "order_held",
      refId: `ord_ledger_${run}`,
      payload: { workspaceId: wsId, channel: "email", recipient: address, title: "Bind", message: "x" },
    });
    expect(fake.received).toHaveLength(1);
    const rows = await query(`SELECT row_to_json(e)::text AS row FROM effects e WHERE workspace_id = $1 AND idempotency_key LIKE $2;`, [
      wsId,
      `${wsId}:notify:order_held:ord_ledger_${run}%`,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].row).not.toContain(address);
  });
});

describe("the workflow state is not changed by a notice", () => {
  it("the workflow awaits approval after a notified request", async () => {
    const wsId = await freshWorkspace();
    await verifiedOwner(wsId, "owner.state@kitchen.example");
    const { wfId } = await evaluateNeedingApproval(wsId);
    const wf = await query(`SELECT state FROM workflows WHERE id = $1;`, [wfId]);
    expect(wf.rows[0].state).toBe(WorkflowState.AWAITING_APPROVAL);
  });
});
