import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./client.js";
import { acquireAdvisoryLock } from "./advisory-lock.js";
import { log } from "../observability/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** The session advisory lock that serialises schema changes across instances (docs/decisions/0032). */
export const MIGRATION_LOCK_KEY = "migrations";
export const MIGRATION_LOCK_WAIT_MS = 60_000;

export interface MigrationOptions {
  /** How long to wait for the lock. Default 60 seconds. Tests shorten it. */
  lockWaitMs?: number;
}

/**
 * Applies schema.sql. The DDL runs under a session lock on a dedicated connection, so instances that start together run
 * it one after another. If the lock is still held after the wait, the migration is refused with a clear error.
 */
export async function runMigrations(options: MigrationOptions = {}): Promise<void> {
  let schemaPath = path.resolve(__dirname, "schema.sql");
  if (!fs.existsSync(schemaPath)) {
    schemaPath = path.resolve(__dirname, "../../src/db/schema.sql");
  }
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found at ${schemaPath}`);
  }

  const ddl = fs.readFileSync(schemaPath, "utf-8");
  const lock = await acquireAdvisoryLock(MIGRATION_LOCK_KEY, options.lockWaitMs ?? MIGRATION_LOCK_WAIT_MS);
  if (lock === null) {
    throw new Error(
      `Migrations not run: another process is running migrations and the lock was not free after ${Math.round(
        (options.lockWaitMs ?? MIGRATION_LOCK_WAIT_MS) / 1000
      )} seconds`
    );
  }
  try {
    log.info("db.migrate.started");
    await pool.query(ddl);
    log.info("db.migrate.completed");
  } finally {
    await lock.release();
  }
}

// Allow direct execution
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  runMigrations()
    .then(() => {
      log.info("db.migrate.cli_completed");
      process.exit(0);
    })
    .catch((err) => {
      log.error("db.migrate.failed", { error: err });
      process.exit(1);
    });
}
