import type pg from "pg";
import { withTransaction } from "../db/client.js";
import { newId } from "../utils/ids.js";
import { workspaceWebhookSecret } from "../webhooks/signing.js";

/**
 * Owner controls over a workspace's agents and webhook signing (ADR 0022). Each change and each secret view writes its
 * audit row in the same transaction. No audit evidence ever holds a secret.
 */

/** Who made the change: an owner token label, or a surface binding of an owner. */
export interface ControlActor {
  type: "owner";
  id: string;
}

async function writeControlAudit(
  client: pg.PoolClient,
  workspaceId: string,
  actor: ControlActor,
  effectClass: "read" | "commercial_commitment",
  action: string,
  evidence: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO audit_logs (id, workspace_id, workflow_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
     VALUES ($1, $2, NULL, $3, $4, $5, $6, 'ALLOW', $7::jsonb, NOW());`,
    [newId("audit"), workspaceId, actor.type, actor.id, effectClass, action, JSON.stringify(evidence)]
  );
}

/**
 * Sets the pause switch and returns the value read back from the row. Returns null when the workspace does not exist.
 * `source` says whether the owner changed it from a surface card or from the owner API.
 */
export async function setAgentsPaused(
  workspaceId: string,
  paused: boolean,
  actor: ControlActor,
  source: "surface" | "owner_api"
): Promise<boolean | null> {
  return withTransaction(async (client) => {
    const upd = await client.query(
      `UPDATE workspaces SET agents_paused = $2, updated_at = NOW() WHERE id = $1 RETURNING agents_paused;`,
      [workspaceId, paused]
    );
    if (upd.rows.length === 0) return null;
    const stored = upd.rows[0].agents_paused === true;
    await writeControlAudit(client, workspaceId, actor, "commercial_commitment", "workspace.agents_paused_changed", {
      paused: stored,
      source,
    });
    return stored;
  });
}

export interface WebhookSecretView {
  secret: string;
  version: number;
}

/** The current signing secret of a workspace. Audited as a view. Returns null when the workspace does not exist. */
export async function viewWebhookSecret(
  workspaceId: string,
  masterSecret: string,
  actor: ControlActor
): Promise<WebhookSecretView | null> {
  return withTransaction(async (client) => {
    const ws = await client.query(`SELECT webhook_secret_version FROM workspaces WHERE id = $1;`, [workspaceId]);
    if (ws.rows.length === 0) return null;
    const version = Number(ws.rows[0].webhook_secret_version);
    await writeControlAudit(client, workspaceId, actor, "read", "auth.webhook_secret_viewed", { version });
    return { secret: workspaceWebhookSecret(masterSecret, workspaceId, version), version };
  });
}

/**
 * Rotates the signing secret: the version goes up by one, so every signature made with the old secret stops
 * validating. Returns the new secret. Returns null when the workspace does not exist.
 */
export async function rotateWebhookSecret(
  workspaceId: string,
  masterSecret: string,
  actor: ControlActor
): Promise<WebhookSecretView | null> {
  return withTransaction(async (client) => {
    const upd = await client.query(
      `UPDATE workspaces SET webhook_secret_version = webhook_secret_version + 1, updated_at = NOW()
       WHERE id = $1 RETURNING webhook_secret_version;`,
      [workspaceId]
    );
    if (upd.rows.length === 0) return null;
    const version = Number(upd.rows[0].webhook_secret_version);
    await writeControlAudit(client, workspaceId, actor, "commercial_commitment", "auth.webhook_secret_rotated", { version });
    return { secret: workspaceWebhookSecret(masterSecret, workspaceId, version), version };
  });
}
