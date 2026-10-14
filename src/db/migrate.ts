import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function runMigrations(): Promise<void> {
  let schemaPath = path.resolve(__dirname, "schema.sql");
  if (!fs.existsSync(schemaPath)) {
    schemaPath = path.resolve(__dirname, "../../src/db/schema.sql");
  }
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found at ${schemaPath}`);
  }

  const ddl = fs.readFileSync(schemaPath, "utf-8");
  console.log("Running migrations from schema.sql...");
  await pool.query(ddl);
  console.log("Migrations applied successfully.");
}

// Allow direct execution
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  runMigrations()
    .then(() => {
      console.log("Migration complete.");
      process.exit(0);
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
