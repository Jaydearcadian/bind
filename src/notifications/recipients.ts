import { query } from "../db/client.js";
import { config } from "../config/env.js";
import type { NotificationChannel } from "../adapters/web2/types.js";

export interface OwnerRecipient {
  channel: NotificationChannel;
  recipient: string;
  /**
   * null for the first recipient, whose ledger key is the key used before there were several recipients (ADR 0074). For an
   * additional verified owner email it is that email's owner_emails id, which keeps each recipient's key apart.
   */
  recipientId: string | null;
}

/**
 * Every owner contact that is told about a workspace's notices, in order (ADR 0025, ADR 0074).
 *
 * 1. A whatsapp or telegram binding of the owner (surface_bindings, actor_role = 'owner'): the single recipient, the oldest
 *    within the channel. The channel order is unchanged.
 * 2. Otherwise, the owner's verified email addresses (owner_emails, verified and not removed): every one, oldest verified
 *    first. The first is the primary recipient (recipientId null), the rest carry their row id.
 * 3. Otherwise, an owner email binding (surface_bindings), as before owner_emails existed, but only while email delivery is
 *    off (simulated). With delivery on, a binding is never a recipient unless it is a verified owner address (step 2), so an
 *    owner cannot make the server mail an address by writing a binding through /surfaces.
 *
 * Demo workspaces never get email (ADR 0057, ADR 0074). Staff bindings and other workspaces' rows are never used. Returns an
 * empty list when there is none, in which case no notice is sent.
 */
export async function resolveOwnerRecipients(workspaceId: string): Promise<OwnerRecipient[]> {
  const workspace = await query<{ is_demo: boolean }>(`SELECT is_demo FROM workspaces WHERE id = $1;`, [workspaceId]);
  const isDemo = workspace.rows[0]?.is_demo === true;

  const res = await query<{ surface: string; actor_id: string }>(
    `SELECT surface, actor_id FROM surface_bindings
     WHERE workspace_id = $1
       AND actor_role = 'owner'
       AND surface = ANY($2::text[])
     ORDER BY created_at ASC, id ASC;`,
    [workspaceId, ["whatsapp", "telegram", "email"]]
  );
  for (const channel of ["whatsapp", "telegram"] as const) {
    const row = res.rows.find((r) => r.surface === channel);
    if (row) return [{ channel, recipient: row.actor_id, recipientId: null }];
  }
  if (isDemo) return [];

  const verified = await query<{ id: string; email: string }>(
    `SELECT id, email FROM owner_emails
     WHERE workspace_id = $1 AND verified_at IS NOT NULL AND removed_at IS NULL
     ORDER BY verified_at ASC, id ASC;`,
    [workspaceId]
  );
  if (verified.rows.length > 0) {
    return verified.rows.map((row, index) => ({
      channel: "email" as const,
      recipient: row.email,
      recipientId: index === 0 ? null : row.id,
    }));
  }

  const emailBinding = res.rows.find((r) => r.surface === "email");
  if (emailBinding && config.BIND_EMAIL_PROVIDER === undefined) {
    return [{ channel: "email", recipient: emailBinding.actor_id, recipientId: null }];
  }
  return [];
}

/**
 * True when the address is a live (not removed) verified owner address of this workspace (ADR 0074). Used by the email send
 * path as the last check before a message leaves the server.
 */
export async function isVerifiedOwnerAddress(workspaceId: string, address: string): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM owner_emails
      WHERE workspace_id = $1 AND email = $2 AND verified_at IS NOT NULL AND removed_at IS NULL
      LIMIT 1;`,
    [workspaceId, address]
  );
  return res.rows.length > 0;
}

/**
 * The first owner contact, or null. Kept for callers that send one message. Notices that may go to several owners use
 * resolveOwnerRecipients.
 */
export async function resolveOwnerRecipient(workspaceId: string): Promise<{ channel: NotificationChannel; recipient: string } | null> {
  const [first] = await resolveOwnerRecipients(workspaceId);
  return first ? { channel: first.channel, recipient: first.recipient } : null;
}
