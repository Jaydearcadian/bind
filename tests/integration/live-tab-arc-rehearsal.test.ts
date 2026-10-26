import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { DEFAULT_SPEND_LEDGER } from "../../scripts/live-tab-arc.js";

/*
 * The live tab harness, rehearsed end to end (docs/RUNBOOK.md section 16.4): scripts/live-tab-arc.ts settle, with the
 * local simulator, on a private local Postgres. The orchestrator spawns the send child (a real process), the child runs
 * TabLedger.settleTab through Bind's own code, and the orchestrator verifies the database. No network, no spend.
 *
 * It needs BIND_LIVE_PG_ADMIN_URL: an admin connection to a LOCAL Postgres server (127.0.0.1 or localhost) on which this
 * test creates a bind_live_rehearsal_<random> database, and drops it afterwards. Without that variable the suite is SKIPPED
 * and the skip is printed; a skipped suite is never reported as a pass.
 */
const ADMIN_URL = process.env.BIND_LIVE_PG_ADMIN_URL;
if (!ADMIN_URL) {
  console.warn("[live-tab-arc rehearsal] SKIPPED: set BIND_LIVE_PG_ADMIN_URL to a local Postgres admin URL to run it.");
}

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HARNESS = path.join(REPO, "scripts", "live-tab-arc.ts");
const SCENARIO_TIMEOUT_MS = 240_000;

/** The environment of a rehearsal: the private database, and no live setting at all (local-sim refuses them). */
function rehearsalEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "test" };
  delete env.ARC_RPC_URL;
  delete env.ARC_SIGNER_PRIVATE_KEY;
  delete env.SETTLEMENT_MODE;
  delete env.BIND_SETTLEMENT_ADDRESS;
  delete env.BIND_SETTLEMENT_DEPLOY_BLOCK;
  return env;
}

/** The harness's one JSON report on stdout. Log lines from the modules it loads may share stdout, so the report is cut out. */
function reportOf(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf('{\n  "harness"');
  const end = stdout.lastIndexOf("\n}");
  if (start < 0 || end < start) throw new Error(`no report on stdout: ${stdout.slice(0, 300)}`);
  return JSON.parse(stdout.slice(start, end + 2)) as Record<string, unknown>;
}

function runHarness(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, ["--import", "tsx", HARNESS, ...args], {
    cwd: REPO,
    env,
    encoding: "utf8",
    timeout: SCENARIO_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe.skipIf(!ADMIN_URL)("[live-tab-arc rehearsal] settle on local-sim, real Postgres, real child process", () => {
  let admin: pg.Client;
  let dbName = "";
  let databaseUrl = "";
  let workDir = "";

  beforeAll(async () => {
    const adminUrl = new URL(ADMIN_URL!);
    if (adminUrl.hostname !== "127.0.0.1" && adminUrl.hostname !== "localhost") {
      throw new Error("BIND_LIVE_PG_ADMIN_URL must point at 127.0.0.1 or localhost");
    }
    dbName = `bind_live_rehearsal_${crypto.randomBytes(4).toString("hex")}`;
    admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName};`);
    const target = new URL(ADMIN_URL!);
    target.pathname = `/${dbName}`;
    databaseUrl = target.toString();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "live-tab-rehearsal-"));

    // The schema, through the repository's own migration entry point, on the private database only.
    const migrate = spawnSync(process.execPath, ["--import", "tsx", path.join(REPO, "src", "db", "migrate.ts")], {
      cwd: REPO,
      env: rehearsalEnv(databaseUrl),
      encoding: "utf8",
      timeout: SCENARIO_TIMEOUT_MS,
    });
    if (migrate.status !== 0) throw new Error(`migrations failed on the rehearsal database: ${(migrate.stderr ?? "").slice(0, 300)}`);
  }, SCENARIO_TIMEOUT_MS);

  afterAll(async () => {
    if (admin) {
      if (dbName) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE);`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  async function queryDb<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      return (await client.query<T>(sql, params as never[])).rows;
    } finally {
      await client.end();
    }
  }

  it(
    "the happy path: one 1-cent settlement, confirmed, the carried-over remainder, the fixture limits, and no spend ledger write",
    async () => {
      const state = path.join(workDir, "settle.json");
      const evidence = path.join(workDir, "settle-report.json");
      const ledgerBefore = fs.existsSync(DEFAULT_SPEND_LEDGER) ? fs.statSync(DEFAULT_SPEND_LEDGER).size : null;

      const run = runHarness(["settle", "--adapter", "local-sim", "--state", state, "--write-evidence", evidence], rehearsalEnv(databaseUrl));
      const report = reportOf(run.stdout);
      expect(run.code, run.stderr.slice(0, 400)).toBe(0);
      expect(report).toMatchObject({
        result: "PASS",
        evidenceClass: "LOCAL_PASS",
        mode: "LOCAL_SIMULATOR_NO_CHAIN",
        exitCode: 0,
        confirmed: { bool: true },
      });
      expect((report.submitted as string[]).length).toBe(1);
      expect(JSON.parse(fs.readFileSync(evidence, "utf8"))).toMatchObject({ result: "PASS" });

      // The database, read directly: the fixture limits, one confirmed one-cent settlement, one clear, the remainder.
      const ws = await queryDb<{ budget_daily_limit_cents: string; approval_threshold_cents: string; settlement_mode: string }>(
        `SELECT budget_daily_limit_cents::text, approval_threshold_cents::text, settlement_mode FROM workspaces;`
      );
      expect(ws).toHaveLength(1);
      expect(ws[0]).toMatchObject({ budget_daily_limit_cents: "1", approval_threshold_cents: "1", settlement_mode: "local" });

      const settlements = await queryDb<{ status: string; amount_cents: string; tx_hash: string | null }>(
        `SELECT status, amount_cents::text AS amount_cents, tx_hash FROM tab_settlements;`
      );
      expect(settlements).toHaveLength(1);
      expect(settlements[0]).toMatchObject({ status: "confirmed", amount_cents: "1" });
      expect(settlements[0].tx_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);

      const entries = await queryDb<{ kind: string; amount: string }>(
        `SELECT kind, SUM(amount_micro)::text AS amount FROM tab_entries GROUP BY kind ORDER BY kind;`
      );
      expect(Object.fromEntries(entries.map((e) => [e.kind, e.amount]))).toEqual({ charge: "15000", clear: "10000" });

      const audits = await queryDb<{ action: string; n: string }>(
        `SELECT action, COUNT(*)::text AS n FROM audit_logs WHERE action LIKE 'tab.%' GROUP BY action ORDER BY action;`
      );
      const counts = Object.fromEntries(audits.map((a) => [a.action, Number(a.n)]));
      expect(counts["tab.settlement_submitted"]).toBe(1);
      expect(counts["tab.settlement_confirmed"]).toBe(1);

      // The rehearsal never reads or writes the real spend ledger.
      const ledgerAfter = fs.existsSync(DEFAULT_SPEND_LEDGER) ? fs.statSync(DEFAULT_SPEND_LEDGER).size : null;
      expect(ledgerAfter).toBe(ledgerBefore);
    },
    SCENARIO_TIMEOUT_MS
  );

  it(
    "a second run with the same state is refused (the send already ran), and a new state in this database is refused (one database per scenario)",
    async () => {
      const state = path.join(workDir, "settle.json");
      const again = runHarness(["settle", "--adapter", "local-sim", "--state", state], rehearsalEnv(databaseUrl));
      expect(again.code).toBe(2);
      expect(reportOf(again.stdout)).toMatchObject({ result: "REFUSED" });

      const other = path.join(workDir, "other.json");
      const second = runHarness(["settle", "--adapter", "local-sim", "--state", other], rehearsalEnv(databaseUrl));
      expect(second.code).toBe(2);
      expect(JSON.stringify(reportOf(second.stdout))).toMatch(/not empty|dedicated database/);

      // Nothing new was written by either refusal.
      const settlements = await queryDb<{ n: string }>(`SELECT COUNT(*)::text AS n FROM tab_settlements;`);
      expect(settlements[0].n).toBe("1");
    },
    SCENARIO_TIMEOUT_MS
  );
});
