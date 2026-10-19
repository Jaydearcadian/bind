/**
 * Issues an access token for an existing workspace and prints it once. Older workspaces have no tokens, so this is the
 * way to get the first one. The token is stored as a hash only; it cannot be shown again.
 *
 * Usage: npm run token:issue -- <workspaceId> <label> [owner|staff]
 */
import { query, closePool } from "../src/db/client.js";
import { issueToken } from "../src/auth/tokens.js";

async function main(): Promise<void> {
  const [workspaceId, label, roleArg = "owner"] = process.argv.slice(2);
  if (!workspaceId || !label || (roleArg !== "owner" && roleArg !== "staff")) {
    console.error("Usage: npm run token:issue -- <workspaceId> <label> [owner|staff]");
    process.exitCode = 1;
    return;
  }

  const ws = await query("SELECT id FROM workspaces WHERE id = $1;", [workspaceId]);
  if (ws.rows.length === 0) {
    console.error(`Workspace '${workspaceId}' not found.`);
    process.exitCode = 1;
    return;
  }

  const issued = await issueToken(workspaceId, roleArg, label, { type: "system", id: "system:operator-cli" });
  console.log("Token (shown once; store it now):");
  console.log(issued.token);
  console.log(`id=${issued.id} workspace=${workspaceId} role=${issued.role} label=${issued.label}`);
}

main()
  .catch((err: unknown) => {
    console.error("Token issue failed:", err instanceof Error ? err.message : "unknown error");
    process.exitCode = 1;
  })
  .finally(() => closePool());
