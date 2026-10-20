import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { config } from "../../src/config/env.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { upsertSurfaceBinding } from "../../src/adapters/socialSurface.js";
import { resolveOwnerRecipient } from "../../src/notifications/recipients.js";
import { WorkflowEngine } from "../../src/workflows/engine.js";
import { WorkflowState } from "../../src/workflows/types.js";
import { createReplenishmentTools } from "../../src/agents/replenishmentTools.js";
import { notificationEmitter } from "../../src/adapters/web2/notifications.js";

const run = Date.now();
const SKU = "FOOD-FLOUR-50LB";
const PHONE = "12125550199";

describe("Approval notifications go to the owner's own binding with a plain link", () => {
  const engine = new WorkflowEngine();
  const wsIds: string[] = [];
  let counter = 0;

  beforeAll(async () => {
    await runMigrations();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    notificationEmitter.clear();
    for (const id of wsIds.splice(0)) {
      await query(`DELETE FROM workspaces WHERE id = $1;`, [id]);
    }
  });

  afterAll(async () => {
    await closePool();
  });

  /** A fresh kitchen workspace. Each test decides which surface bindings it has. */
  async function freshWorkspace(): Promise<string> {
    counter += 1;
    const wsId = `ws-recip-${run}-${counter}`;
    wsIds.push(wsId);
    await provisionWorkspace(wsId, "Recipient Kitchen", "kitchen-v1");
    return wsId;
  }

  async function bind(wsId: string, surface: "whatsapp" | "telegram" | "email", actorId: string, actorRole: "owner" | "staff") {
    await upsertSurfaceBinding(wsId, { surface, actorId, actorRole }, { type: "owner", id: "test-owner" });
  }

  /**
   * Runs the real policy evaluation for a proposal that needs approval, so the approval notification goes through
   * createReplenishmentTools exactly as in production. Returns the tool output.
   */
  async function evaluateNeedingApproval(wsId: string) {
    counter += 1;
    const wfId = `wf_recip_${run}_${counter}`;
    const quoteId = `quote_recip_${run}_${counter}`;
    const totalCents = 30000;
    await query(
      `INSERT INTO quotes (id, workspace_id, rfq_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, currency, valid_until)
       VALUES ($1, $2, $3, $4, 'Sysco Metro Distribution', $5, 10, $6, $7, 'USDC', NOW() + INTERVAL '1 day');`,
      [quoteId, wsId, `rfq_${quoteId}`, `${wsId}_supp-sysco-metro`, SKU, totalCents / 10, totalCents]
    );
    await engine.createWorkflow(wfId, wsId, "kitchen_replenishment", `idem_recip_${wfId}`, {
      sku: SKU,
      replenishmentProposal: {
        proposalId: `prop_${wfId}`,
        workflowId: wfId,
        sku: SKU,
        quantity: 10,
        supplierId: `${wsId}_supp-sysco-metro`,
        supplierName: "Sysco Metro Distribution",
        quoteId,
        unitPriceCents: String(totalCents / 10),
        totalPriceCents: String(totalCents),
        jevEvaluation: { holdForOwnerReview: false },
        status: "VALIDATED",
      },
    });
    const tools = createReplenishmentTools({ workspaceId: wsId, workflowId: wfId });
    const out = JSON.parse(await tools.requestPolicyEvaluationTool.invoke({ requestId: wfId }));
    return { wfId, out };
  }

  it("the recipient is the owner binding of the workspace", async () => {
    const wsId = await freshWorkspace();
    await bind(wsId, "whatsapp", "+15550100002", "owner");
    await bind(wsId, "whatsapp", "+15550100003", "owner");

    // Within a channel the oldest owner binding is used.
    expect(await resolveOwnerRecipient(wsId)).toEqual({ channel: "whatsapp", recipient: "+15550100002" });
  });

  it("a staff binding is never used as the recipient", async () => {
    const wsId = await freshWorkspace();
    // The staff binding is older, so only the role check can keep it from being chosen.
    await bind(wsId, "whatsapp", "+15550100004", "staff");
    expect(await resolveOwnerRecipient(wsId)).toBeNull();

    await bind(wsId, "email", "owner@kitchen.example", "owner");
    expect(await resolveOwnerRecipient(wsId)).toEqual({ channel: "email", recipient: "owner@kitchen.example" });
  });

  it("another workspace's owner binding is never used", async () => {
    const wsA = await freshWorkspace();
    const wsB = await freshWorkspace();
    await bind(wsB, "whatsapp", "+15550100005", "owner");

    expect(await resolveOwnerRecipient(wsA)).toBeNull();
    expect(await resolveOwnerRecipient(wsB)).toEqual({ channel: "whatsapp", recipient: "+15550100005" });
  });

  it("whatsapp is preferred over telegram and email", async () => {
    const wsId = await freshWorkspace();
    // The email and telegram bindings are older, so the channel order is what decides.
    await bind(wsId, "email", "owner@kitchen.example", "owner");
    await bind(wsId, "telegram", "@kitchen_owner", "owner");
    await bind(wsId, "whatsapp", "+15550100006", "owner");
    expect(await resolveOwnerRecipient(wsId)).toEqual({ channel: "whatsapp", recipient: "+15550100006" });

    await query(`DELETE FROM surface_bindings WHERE workspace_id = $1 AND surface = 'whatsapp';`, [wsId]);
    expect(await resolveOwnerRecipient(wsId)).toEqual({ channel: "telegram", recipient: "@kitchen_owner" });
  });

  it("with no owner binding nothing is sent and the skip is audited", async () => {
    const wsId = await freshWorkspace();
    const spy = vi.spyOn(notificationEmitter, "send");

    const { wfId, out } = await evaluateNeedingApproval(wsId);

    // The approval still exists and is pending, so the owner can decide in the app.
    expect(out.policyDecision).toBe("REQUIRE_APPROVAL");
    expect(out.workflowState).toBe(WorkflowState.AWAITING_APPROVAL);
    const approval = await query(`SELECT status FROM approvals WHERE id = $1;`, [out.approvalId]);
    expect(approval.rows[0].status).toBe("pending");

    expect(spy).not.toHaveBeenCalled();
    expect(notificationEmitter.getSentNotifications()).toEqual([]);
    const effects = await query(`SELECT id FROM effects WHERE workspace_id = $1 AND idempotency_key LIKE '%:notify:%';`, [wsId]);
    expect(effects.rows).toEqual([]);

    const audit = await query(
      `SELECT actor_type, actor_id, effect_class, action, policy_decision, evidence FROM audit_logs
       WHERE workspace_id = $1 AND workflow_id = $2 AND action = 'notification.skipped_no_recipient';`,
      [wsId, wfId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_type: "system",
      actor_id: "system:notifications",
      effect_class: "external_request",
      action: "notification.skipped_no_recipient",
      policy_decision: "ALLOW",
    });
    expect(audit.rows[0].evidence).toEqual({ approvalId: out.approvalId });
  });

  it("the approval message carries a plain link and no token", async () => {
    const wsId = await freshWorkspace();
    await bind(wsId, "whatsapp", "+15550100007", "owner");

    const { out } = await evaluateNeedingApproval(wsId);
    const sent = notificationEmitter.getSentNotifications("whatsapp").filter((n) => n.workspaceId === wsId);

    expect(sent).toHaveLength(1);
    const payload = sent[0];
    expect(payload.recipient).toBe("+15550100007");
    const base = config.APP_BASE_URL.replace(/\/+$/, "");
    expect(payload.actionUrl).toBe(`${base}/app/approvals/${out.approvalId}`);
    // A plain page link: no query string, and no decision endpoint.
    expect(payload.actionUrl).not.toContain("?");
    expect(payload.actionUrl).not.toMatch(/\/approve(\/|$)/);
    expect(payload).not.toHaveProperty("approvalToken");
    // The approval id appears once, in the link path. It is not repeated as a credential-looking value.
    expect(JSON.stringify(payload).split(out.approvalId).length - 1).toBe(1);
  });

  it("no hard-coded phone number remains in src", async () => {
    const srcRoot = fileURLToPath(new URL("../../src", import.meta.url));
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (full !== path.join(srcRoot, "ui")) walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        if (readFileSync(full, "utf8").includes(PHONE)) offenders.push(path.relative(srcRoot, full));
      }
    };
    walk(srcRoot);

    expect(offenders).toEqual([]);
  });
});
