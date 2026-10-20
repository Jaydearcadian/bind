import crypto from "node:crypto";
import { query } from "../db/client.js";
import { acquireAdvisoryLock } from "../db/advisory-lock.js";
import { provisionWorkspace } from "../templates/registry.js";
import { issueToken } from "../auth/tokens.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { ProcurementWorkflowRunner } from "../workflows/procurement.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PolicyDecision } from "../policy/engine.js";
import { log } from "../observability/logger.js";
import { redactText } from "../utils/redact.js";
import {
  DEMO_OWNER_LABEL,
  DEMO_SEED_SKU,
  DEMO_SETTLEMENT_MODE,
  DEMO_TEMPLATE_ID,
  DEMO_TTL_MS,
  DEMO_WORKSPACE_NAME,
} from "./policy.js";
import { deleteDemoRows, removeDemoArtifacts } from "./purge.js";

/**
 * Creating, seeding and resetting demo workspaces (docs/decisions/0057). A demo is provisioned in one transaction (the
 * workspace row carries is_demo and its expiry), gets an owner token, and is then seeded through the real replenishment
 * runner against the simulated supplier. The seed is best effort: a failure is logged and the demo is still returned, so
 * no record is invented to fill a gap.
 *
 * Every create and reset takes one advisory lock, so the active-demo count and the insert cannot race past the cap.
 */

export type DemoErrorCode = "DEMO_CAPACITY_REACHED" | "NOT_A_DEMO" | "UNAVAILABLE";

/** A demo operation that cannot be done. The route maps the code to a status. */
export class DemoError extends Error {
  readonly code: DemoErrorCode;

  constructor(code: DemoErrorCode, message: string) {
    super(message);
    this.name = "DemoError";
    this.code = code;
  }
}

/** What a visitor gets: the workspace, its owner token (shown once) and when the demo ends. */
export interface DemoCredentials {
  workspaceId: string;
  token: string;
  expiresAt: Date;
}

export interface DemoOptions {
  /** The most demo workspaces that may be active (not expired) at once. */
  maxActive: number;
}

const CREATE_LOCK = "demo:create";
const LOCK_WAIT_MS = 30_000;

async function withCreateLock<T>(work: () => Promise<T>): Promise<T> {
  const lock = await acquireAdvisoryLock(CREATE_LOCK, LOCK_WAIT_MS);
  if (lock === null) throw new DemoError("UNAVAILABLE", "Demo creation is busy. Try again in a moment.");
  try {
    return await work();
  } finally {
    await lock.release();
  }
}

async function countActiveDemos(): Promise<number> {
  const res = await query(`SELECT COUNT(*)::int AS n FROM workspaces WHERE is_demo AND demo_expires_at > NOW();`);
  return Number(res.rows[0].n);
}

/** Refuses when the active count is already at the cap, so one more demo would exceed it. The caller holds the create lock. */
function assertCapacity(active: number, maxActive: number): void {
  if (active >= maxActive) {
    throw new DemoError("DEMO_CAPACITY_REACHED", "The demo limit is reached on this server. Try again later.");
  }
}

/**
 * Provisions one demo and its owner token, and writes its audit row. The caller holds the create lock and has checked the cap.
 * If the token cannot be issued the workspace is deleted, so no demo is left without an owner.
 */
async function provisionDemo(reason: "create" | "reset"): Promise<DemoCredentials> {
  const workspaceId = `ws-demo-${crypto.randomBytes(8).toString("hex")}`;
  const expiresAt = new Date(Date.now() + DEMO_TTL_MS);
  await provisionWorkspace(workspaceId, DEMO_WORKSPACE_NAME, DEMO_TEMPLATE_ID, {
    settlementMode: DEMO_SETTLEMENT_MODE,
    demoExpiresAt: expiresAt,
  });
  let issued: { token: string };
  try {
    issued = await issueToken(workspaceId, "owner", DEMO_OWNER_LABEL, { type: "system", id: "system:demo" });
  } catch (err) {
    await query(`DELETE FROM workspaces WHERE id = $1 AND is_demo;`, [workspaceId]);
    throw err;
  }
  await new WorkflowEngine().recordAudit(
    workspaceId,
    null,
    "system",
    "system:demo",
    EffectClass.READ,
    "demo.created",
    PolicyDecision.ALLOW,
    { reason, expiresAt: expiresAt.toISOString() }
  );
  return { workspaceId, token: issued.token, expiresAt };
}

/**
 * Starts one replenishment for the seed sku through the real runner. A demo is left as it is when this fails: the
 * failure is logged with its message (redacted), and no record is written for it.
 */
export async function seedDemo(workspaceId: string, runner: ProcurementWorkflowRunner = new ProcurementWorkflowRunner()): Promise<void> {
  try {
    const result = await runner.startReplenishment(workspaceId, DEMO_SEED_SKU, "demo_seed");
    log.info("demo.seeded", { workspaceId, workflowId: result.workflowId, state: result.state });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("demo.seed_failed", { workspaceId, step: "replenishment", error: redactText(message).slice(0, 300) });
  }
}

/** Creates a demo for a visitor. Refused with DEMO_CAPACITY_REACHED when the cap is full. */
export async function createDemoWorkspace(options: DemoOptions): Promise<DemoCredentials> {
  const created = await withCreateLock(async () => {
    assertCapacity(await countActiveDemos(), options.maxActive);
    return provisionDemo("create");
  });
  await seedDemo(created.workspaceId);
  return created;
}

/**
 * Deletes a demo and returns a fresh one with new credentials. The old token stops working because its workspace is gone.
 * Refused with NOT_A_DEMO for any other workspace, which is never touched. The cap is checked before anything is deleted,
 * so a refused reset leaves the demo as it was.
 */
export async function resetDemoWorkspace(workspaceId: string, options: DemoOptions): Promise<DemoCredentials> {
  const created = await withCreateLock(async () => {
    const row = await query(`SELECT is_demo FROM workspaces WHERE id = $1;`, [workspaceId]);
    if (row.rows[0]?.is_demo !== true) {
      throw new DemoError("NOT_A_DEMO", "This workspace is not a demo workspace, so it cannot be reset.");
    }
    // The old demo is counted as active until it is deleted, so the new one would make the count active - 1 + 1.
    assertCapacity((await countActiveDemos()) - 1, options.maxActive);
    await removeDemoArtifacts(workspaceId);
    await deleteDemoRows(workspaceId, false);
    return provisionDemo("reset");
  });
  await seedDemo(created.workspaceId);
  return created;
}
