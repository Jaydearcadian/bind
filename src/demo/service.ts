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
import { deleteDemoRows, purgeExpiredDemos, removeDemoArtifacts } from "./purge.js";

/**
 * Creating, seeding and resetting demo workspaces (docs/decisions/0057). A demo is provisioned in one transaction (the
 * workspace row carries is_demo and its expiry), gets an owner token, and is then seeded through the real replenishment
 * runner against the simulated supplier. The seed is best effort: a failure is logged and the demo is still returned, so
 * no record is invented to fill a gap.
 *
 * Every create and reset takes one advisory lock, so the active-demo count and the insert cannot race past the cap. The
 * lock is waited for briefly; when it is not obtained the answer is DEMO_BUSY, with Retry-After. Each create also removes
 * up to PURGE_PER_CREATE expired demos, so expired rows do not pile up on a deployment where no worker runs.
 */

export type DemoErrorCode = "DEMO_CAPACITY_REACHED" | "DEMO_BUSY" | "NOT_A_DEMO";

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
/** How long a create or reset waits for the lock before it answers DEMO_BUSY. Short on purpose: a burst must not hold connections. */
export const DEMO_LOCK_WAIT_MS = 3_000;
/** The most expired demos one create removes. */
export const PURGE_PER_CREATE = 10;

async function withCreateLock<T>(work: () => Promise<T>): Promise<T> {
  const lock = await acquireAdvisoryLock(CREATE_LOCK, DEMO_LOCK_WAIT_MS);
  if (lock === null) throw new DemoError("DEMO_BUSY", "Demo creation is busy. Try again in a few seconds.");
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

/** Refuses when the count is already at the cap, so one more demo would exceed it. The caller holds the create lock. */
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

/** Removes up to PURGE_PER_CREATE expired demos before a create. A failure is logged and never fails the create. */
async function purgeExpiredBeforeCreate(): Promise<void> {
  try {
    const purged = await purgeExpiredDemos(PURGE_PER_CREATE);
    for (const failure of purged.failures) {
      const message = failure instanceof Error ? failure.message : String(failure);
      log.warn("demo.purge_failed", { error: redactText(message).slice(0, 300) });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("demo.purge_failed", { error: redactText(message).slice(0, 300) });
  }
}

/** Creates a demo for a visitor. Refused with DEMO_CAPACITY_REACHED when the cap is full, DEMO_BUSY when the lock is busy. */
export async function createDemoWorkspace(options: DemoOptions): Promise<DemoCredentials> {
  await purgeExpiredBeforeCreate();
  const created = await withCreateLock(async () => {
    assertCapacity(await countActiveDemos(), options.maxActive);
    return provisionDemo("create");
  });
  await seedDemo(created.workspaceId);
  return created;
}

/**
 * Returns a fresh demo with new credentials and deletes the old one. The new demo is provisioned first and the old one is
 * deleted after, so a failure never leaves the visitor with nothing. The end count of active demos is unchanged, so the cap
 * is checked as the count plus one for the moment both exist. Refused with NOT_A_DEMO for any other workspace, which is never
 * touched. If the old demo cannot be deleted now, it is logged and the worker removes it when it expires.
 */
export async function resetDemoWorkspace(workspaceId: string, options: DemoOptions): Promise<DemoCredentials> {
  const created = await withCreateLock(async () => {
    const row = await query(`SELECT is_demo FROM workspaces WHERE id = $1;`, [workspaceId]);
    if (row.rows[0]?.is_demo !== true) {
      throw new DemoError("NOT_A_DEMO", "This workspace is not a demo workspace, so it cannot be reset.");
    }
    // Both demos exist for a moment, so the transient count is active + 1; the old one is deleted straight after.
    assertCapacity(await countActiveDemos(), options.maxActive + 1);
    const fresh = await provisionDemo("reset");
    try {
      await removeDemoArtifacts(workspaceId);
      await deleteDemoRows(workspaceId, false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("demo.reset_cleanup_failed", { workspaceId, error: redactText(message).slice(0, 300) });
    }
    return fresh;
  });
  await seedDemo(created.workspaceId);
  return created;
}
