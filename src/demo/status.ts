import { query } from "../db/client.js";

/** Whether a workspace is a demo (docs/decisions/0057). An unknown workspace is not a demo. */
export async function isDemoWorkspace(workspaceId: string): Promise<boolean> {
  const res = await query(`SELECT is_demo FROM workspaces WHERE id = $1;`, [workspaceId]);
  return res.rows[0]?.is_demo === true;
}
