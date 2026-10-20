import { query } from "../db/client.js";
import type { NotificationChannel } from "../adapters/web2/types.js";

/** Channels in preference order. A workspace's owner is reached on the first one they have bound. */
const CHANNEL_PREFERENCE: NotificationChannel[] = ["whatsapp", "telegram", "email"];

export interface OwnerRecipient {
  channel: NotificationChannel;
  recipient: string;
}

/**
 * The owner's own contact for a workspace, from the owner's surface binding (surface_bindings, actor_role = 'owner').
 * Staff bindings and other workspaces' bindings are never used. Within a channel the oldest binding wins. Returns
 * null when the owner has bound none of the channels, in which case no approval message is sent.
 *
 * Nothing is hard-coded: the owner sets the binding, and the binding's actor_id is the recipient.
 */
export async function resolveOwnerRecipient(workspaceId: string): Promise<OwnerRecipient | null> {
  const res = await query<{ surface: string; actor_id: string }>(
    `SELECT surface, actor_id FROM surface_bindings
     WHERE workspace_id = $1
       AND actor_role = 'owner'
       AND surface = ANY($2::text[])
     ORDER BY created_at ASC, id ASC;`,
    [workspaceId, CHANNEL_PREFERENCE]
  );
  for (const channel of CHANNEL_PREFERENCE) {
    const row = res.rows.find((r) => r.surface === channel);
    if (row) return { channel, recipient: row.actor_id };
  }
  return null;
}
