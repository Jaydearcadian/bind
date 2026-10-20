/**
 * Removes test fixture workspaces and their derived template directories (ADR 0040, docs/RUNBOOK.md section 16).
 *
 * A dry run is the default: it prints what it would delete and writes nothing. `--apply` deletes. A template directory is
 * removed only when git does not track it. The demo workspace and the reference templates are never matched.
 *
 * NEVER run this against a production database. It refuses when NODE_ENV is production. It deletes workspaces, and the
 * deletes cascade to every row that belongs to them.
 *
 * Usage: npm run test:clean            (dry run)
 *        npm run test:clean -- --apply
 */
import "./guard-not-production.js";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, closePool } from "../src/db/client.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES_DIR = path.join(ROOT, "templates");

/**
 * The fixture families that the test suites create (ADR 0040). Each is used only by tests; the product creates no workspace with
 * these prefixes. Left out on purpose: `ws-kitchen-` (the demo workspace family), and short or generic names such as `ws-a-`
 * that real data could use. `ws-probe` also matches the probe directories `ws-probe-new` and `ws-probe2`.
 */
export const FIXTURE_PREFIXES: readonly string[] = [
  "ws-contract-",
  "wu-",
  "ws-gate-",
  "ws-e2e-blank-",
  "ws-test-",
  "ws-untrusted-",
  "ws-mcp-",
  "ws-sdk-",
  "ws-probe",
  "ws-cred-",
  "ws-auth-",
  "ws-hook-",
  "ws-settle-",
  "ws-approval-",
  "ws-ledger-",
  "ws-journal-",
  "ws-policy-",
  "ws-paused-",
  "ws-replenish-",
  "ws-echo-",
  "ws-events-",
  "ws-effects-",
  "ws-crypto-",
  "ws-audit-",
  "ws-blank-",
  "ws-operation-",
  "ws-payee-",
  "ws-reconcile-",
  "ws-recheck-",
  "ws-notify-",
  "ws-menu-",
  "ws-integration-",
  "ws-crash-",
  "ws-budget-",
  "ws-attn-",
  "ws-recip-",
  "ws-payment-",
  "ws-pause-",
  "ws-spause-",
  "ws-twm-",
  "ws-fxe-",
  "ws-ful-",
];
/** A plain token: no slash, no space, no dots in a row. Only these ids are matched, so an id is never a path. */
const PLAIN_ID = /^[A-Za-z0-9._-]{1,120}$/;
/** Never removed, whatever the pattern says: the demo workspace and the reference templates. */
export const PROTECTED_IDS: ReadonlySet<string> = new Set(["ws-kitchen-main", "kitchen-ops", "coffee-roaster"]);

/** True for a fixture workspace id (and for the name of its template directory). */
export function isFixtureWorkspaceId(id: string): boolean {
  if (PROTECTED_IDS.has(id)) return false;
  if (!PLAIN_ID.test(id) || id.includes("..")) return false;
  return FIXTURE_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/**
 * True when git tracks something under the directory (relative to the repository root). `git ls-files --error-unmatch`
 * exits 1 when nothing matches. Any other failure (no git, not a checkout) counts as tracked, so nothing is removed.
 */
export function isTrackedByGit(relativeDir: string): boolean {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", relativeDir], { cwd: ROOT, encoding: "utf8" });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return true;
}

export interface FixturePlan {
  workspaceIds: string[];
  /** Directory names under templates/ (not paths). */
  directories: string[];
}

/** Lists what a cleanup would remove. Reads the database and the templates directory; changes nothing. */
export async function planFixtureCleanup(): Promise<FixturePlan> {
  const rows = await query(`SELECT id FROM workspaces ORDER BY id ASC;`);
  const workspaceIds = (rows.rows as Array<{ id: string }>).map((row) => row.id).filter(isFixtureWorkspaceId);
  const names = fs.existsSync(TEMPLATES_DIR)
    ? fs
        .readdirSync(TEMPLATES_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : [];
  const directories = names
    .filter(isFixtureWorkspaceId)
    .filter((name) => !isTrackedByGit(`templates/${name}`))
    .sort();
  return { workspaceIds, directories };
}

/** Deletes the planned workspaces and directories. A directory is removed only if it is directly under templates/. */
export async function applyFixtureCleanup(plan: FixturePlan): Promise<void> {
  if (plan.workspaceIds.length > 0) {
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [plan.workspaceIds]);
  }
  for (const name of plan.directories) {
    const absolute = path.join(TEMPLATES_DIR, name);
    if (path.dirname(absolute) !== TEMPLATES_DIR || !isFixtureWorkspaceId(name)) continue;
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  if (args.some((arg) => arg !== "--apply")) {
    console.error("usage: npm run test:clean [-- --apply]");
    process.exitCode = 2;
    return;
  }
  if (process.env.NODE_ENV === "production") {
    console.error("Refused: NODE_ENV is production. This script deletes workspaces and must never run against production.");
    process.exitCode = 1;
    return;
  }
  const plan = await planFixtureCleanup();
  console.log(`mode=${apply ? "apply" : "dry-run"}`);
  console.log(`workspaces=${plan.workspaceIds.length} template_directories=${plan.directories.length}`);
  for (const id of plan.workspaceIds) console.log(`  workspace ${id}`);
  for (const name of plan.directories) console.log(`  directory templates/${name}`);
  if (!apply) {
    console.log("Dry run: nothing was deleted. Add --apply to delete.");
    return;
  }
  await applyFixtureCleanup(plan);
  console.log("Deleted.");
}

// Runs only when executed directly, so the tests can import the matching function without touching the database.
const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .catch(() => {
      console.error("Fixture cleanup failed.");
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
