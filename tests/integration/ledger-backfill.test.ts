import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../../src/server/app.js";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { issueToken } from "../../src/auth/tokens.js";
import { parseBackfillArgs, runJournalBackfill } from "../../scripts/backfill-journal.js";

const run = Date.now();
const wsId = `ws-ledger-read-${run}`;
const wsScript = `ws-ledger-script-${run}`;

/** A reconciled order with no journal entry yet, as an order settled before the journal existed would look. */
async function reconciledOrderWithoutEntry(workspaceId: string, suffix: string): Promise<string> {
  const id = `ord_ledger_${suffix}_${run}`;
  await query(
    `INSERT INTO orders (id, workspace_id, order_number, supplier_name, item_sku, item_name, quantity, unit_price_cents, total_price_cents, status, idempotency_key, tx_hash)
     VALUES ($1, $2, 'PO-LEDGER01', 'Sysco Metro Distribution', 'FOOD-FLOUR-50LB', 'Organic All-Purpose Flour', 10, 2450, 24500, 'reconciled', $3, $4);`,
    [id, workspaceId, `idem_${id}`, `0x${suffix.padEnd(8, "0")}`]
  );
  return id;
}

async function counts(workspaceId: string) {
  const journal = await query(`SELECT COUNT(*)::int AS n FROM accounting_journal_entries WHERE workspace_id = $1;`, [workspaceId]);
  const audit = await query(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE workspace_id = $1;`, [workspaceId]);
  return { journal: journal.rows[0].n as number, audit: audit.rows[0].n as number };
}

describe("the accounting ledger GET is read-only, and the backfill is an explicit operator command", () => {
  const app = createApp();
  let server: Server;
  let baseUrl = "";
  let ownerToken = "";

  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsId, "Ledger Read Kitchen", "kitchen-v1");
    await provisionWorkspace(wsScript, "Ledger Script Kitchen", "kitchen-v1");
    ownerToken = (await issueToken(wsId, "owner", "ledger-owner")).token;
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [[wsId, wsScript]]);
    await closePool();
  });

  it("reading the ledger twice writes nothing", async () => {
    await reconciledOrderWithoutEntry(wsId, "read");
    const before = await counts(wsId);
    expect(before.journal).toBe(0);

    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${baseUrl}/api/workspaces/${wsId}/accounting/ledger`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      expect(res.status).toBe(200);
      // The GET returns only stored entries: the reconciled order has none, so the list is empty.
      expect(await res.json()).toEqual([]);
    }

    expect(await counts(wsId)).toEqual(before);
  });

  it("the backfill script is a dry run by default and writes only with --apply and is idempotent", async () => {
    const orderId = await reconciledOrderWithoutEntry(wsScript, "script");

    // The arguments: a workspace id is required, and the dry run is the default.
    expect(parseBackfillArgs([])).toEqual({ error: expect.stringContaining("usage") });
    expect(parseBackfillArgs([wsScript])).toEqual({ target: wsScript, apply: false });
    expect(parseBackfillArgs([wsScript, "--apply"])).toEqual({ target: wsScript, apply: true });
    expect(parseBackfillArgs(["--all"])).toEqual({ target: "all", apply: false });

    const dry = await runJournalBackfill({ target: wsScript, apply: false });
    expect(dry).toEqual([{ workspaceId: wsScript, reconciled: 1, withEntry: 0, missing: 1, written: 0, conflicts: 0 }]);
    expect((await counts(wsScript)).journal).toBe(0);

    const applied = await runJournalBackfill({ target: wsScript, apply: true });
    expect(applied).toEqual([{ workspaceId: wsScript, reconciled: 1, withEntry: 0, missing: 1, written: 1, conflicts: 0 }]);
    const entry = await query(`SELECT order_id, amount_cents, tx_hash FROM accounting_journal_entries WHERE workspace_id = $1;`, [wsScript]);
    expect(entry.rows).toEqual([{ order_id: orderId, amount_cents: "24500", tx_hash: `0x${"script".padEnd(8, "0")}` }]);

    // A second --apply writes nothing: the entry exists and already holds the hash.
    const again = await runJournalBackfill({ target: wsScript, apply: true });
    expect(again).toEqual([{ workspaceId: wsScript, reconciled: 1, withEntry: 1, missing: 0, written: 0, conflicts: 0 }]);
    expect((await counts(wsScript)).journal).toBe(1);
  });
});
