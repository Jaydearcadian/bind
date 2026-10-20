/**
 * Writes the journal entries that reconciled orders are missing (ADR 0040, docs/RUNBOOK.md section 16). The ledger GET does
 * not do this any more: it only reads. A dry run is the default and writes nothing. `--apply` writes. Only counts are
 * printed, never an amount, memo, hash or customer text.
 *
 * Usage:
 *   npm run accounting:backfill -- <workspaceId>          dry run for one workspace
 *   npm run accounting:backfill -- <workspaceId> --apply  write them
 *   npm run accounting:backfill -- --all [--apply]        every workspace with a reconciled order
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, closePool } from "../src/db/client.js";
import { backfillReconciledJournalEntries, type JournalBackfillReport } from "../src/studio/documentsAndAccounting.js";

export type BackfillTarget = string | "all";

const USAGE = "usage: npm run accounting:backfill -- <workspaceId | --all> [--apply]";
const WORKSPACE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export class WorkspaceNotFoundError extends Error {
  constructor() {
    super("Workspace not found.");
    this.name = "WorkspaceNotFoundError";
  }
}

/** Reads the arguments. A dry run unless `--apply` is given. A workspace id or `--all` is required, never both. */
export function parseBackfillArgs(argv: string[]): { target: BackfillTarget; apply: boolean } | { error: string } {
  const apply = argv.includes("--apply");
  const rest = argv.filter((arg) => arg !== "--apply");
  if (rest.some((arg) => arg.startsWith("--") && arg !== "--all")) return { error: USAGE };
  const all = rest.includes("--all");
  const ids = rest.filter((arg) => arg !== "--all");
  if (all) return ids.length === 0 ? { target: "all", apply } : { error: USAGE };
  if (ids.length !== 1 || !WORKSPACE_ID.test(ids[0])) return { error: USAGE };
  return { target: ids[0], apply };
}

/** Runs the backfill for one workspace, or for every workspace with a reconciled order. Returns counts per workspace. */
export async function runJournalBackfill(opts: { target: BackfillTarget; apply: boolean }): Promise<JournalBackfillReport[]> {
  let workspaceIds: string[];
  if (opts.target === "all") {
    const res = await query(`SELECT DISTINCT workspace_id FROM orders WHERE status = 'reconciled' ORDER BY workspace_id ASC;`);
    workspaceIds = res.rows.map((row) => row.workspace_id as string);
  } else {
    const res = await query(`SELECT 1 FROM workspaces WHERE id = $1;`, [opts.target]);
    if (res.rows.length === 0) throw new WorkspaceNotFoundError();
    workspaceIds = [opts.target];
  }
  const reports: JournalBackfillReport[] = [];
  for (const workspaceId of workspaceIds) {
    reports.push(await backfillReconciledJournalEntries(workspaceId, { apply: opts.apply }));
  }
  return reports;
}

async function main(): Promise<void> {
  const parsed = parseBackfillArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(parsed.error);
    process.exitCode = 2;
    return;
  }
  const reports = await runJournalBackfill(parsed);
  console.log(`mode=${parsed.apply ? "apply" : "dry-run"}`);
  for (const r of reports) {
    console.log(
      `workspace=${r.workspaceId} reconciled=${r.reconciled} with_entry=${r.withEntry} missing=${r.missing} written=${r.written} conflicts=${r.conflicts}`
    );
  }
  if (!parsed.apply) console.log("Dry run: nothing was written. Add --apply to write.");
}

// Runs only when executed directly, so the tests can import the functions without starting a backfill.
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .catch((err: unknown) => {
      console.error(err instanceof WorkspaceNotFoundError ? err.message : "Journal backfill failed.");
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
