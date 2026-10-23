import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { query, closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { provisionWorkspace } from "../../src/templates/registry.js";
import { recordIdempotentJournalEntry, JournalConflictError } from "../../src/accounting/journal.js";

const run = Date.now();
const wsA = `ws-journal-a-${run}`;
const wsB = `ws-journal-b-${run}`;
const orderId = `ord_journal_${run}`;

function entry(workspaceId: string, overrides: Partial<Parameters<typeof recordIdempotentJournalEntry>[0]> = {}) {
  return {
    workspaceId,
    orderId,
    orderNumber: "PO-ABCDEF12",
    itemName: "Organic All-Purpose Flour",
    supplierName: "Sysco Metro Distribution",
    amountCents: 24500n,
    ...overrides,
  };
}

describe("accounting journal entries are idempotent by key (PostgreSQL)", () => {
  beforeAll(async () => {
    await runMigrations();
    await provisionWorkspace(wsA, "Journal Kitchen A", "kitchen-v1");
    await provisionWorkspace(wsB, "Journal Kitchen B", "kitchen-v1");
    await query(
      `INSERT INTO orders (id, workspace_id, order_number, supplier_name, item_sku, item_name, quantity, unit_price_cents, total_price_cents, status, idempotency_key)
       VALUES ($1, $2, 'PO-ABCDEF12', 'Sysco Metro Distribution', 'FOOD-FLOUR-50LB', 'Organic All-Purpose Flour', 10, 2450, 24500, 'confirmed', $3);`,
      [orderId, wsA, `idem_${orderId}`]
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM workspaces WHERE id = ANY($1::text[]);`, [[wsA, wsB]]);
    await closePool();
  });

  it("the same journal entry written twice leaves one row", async () => {
    const first = await recordIdempotentJournalEntry(entry(wsA, { txHash: "0xfirst" }));
    const second = await recordIdempotentJournalEntry(entry(wsA, { txHash: "0xfirst" }));

    const rows = await query(`SELECT id, tx_hash FROM accounting_journal_entries WHERE order_id = $1;`, [orderId]);
    expect(rows.rows).toHaveLength(1);
    expect(second.id).toBe(first.id);
    expect(rows.rows[0].tx_hash).toBe("0xfirst");
  });

  it("a journal entry from another workspace cannot overwrite it", async () => {
    const before = await query(
      `SELECT workspace_id, amount_cents, tx_hash FROM accounting_journal_entries WHERE idempotency_key = $1;`,
      [`idem_je_${orderId}`]
    );
    expect(before.rows[0]).toMatchObject({ workspace_id: wsA, amount_cents: "24500", tx_hash: "0xfirst" });

    const attempt = await recordIdempotentJournalEntry(
      entry(wsB, { amountCents: 99999n, txHash: "0xintruder" })
    ).catch((err: unknown) => err);

    // Another tenant's write is refused, or at least does not receive or change this tenant's row.
    expect(attempt instanceof Error || (attempt as { workspace_id?: string }).workspace_id !== wsA).toBe(true);
    const after = await query(
      `SELECT workspace_id, amount_cents, tx_hash FROM accounting_journal_entries WHERE idempotency_key = $1;`,
      [`idem_je_${orderId}`]
    );
    expect(after.rows[0]).toMatchObject({ workspace_id: wsA, amount_cents: "24500", tx_hash: "0xfirst" });
  });

  /** Each test below uses its own order, so the shared-order tests above are unaffected. */
  async function freshOrder(name: string): Promise<string> {
    const id = `ord_journal_${name}_${run}`;
    await query(
      `INSERT INTO orders (id, workspace_id, order_number, supplier_name, item_sku, item_name, quantity, unit_price_cents, total_price_cents, status, idempotency_key)
       VALUES ($1, $2, 'PO-ABCDEF12', 'Sysco Metro Distribution', 'FOOD-FLOUR-50LB', 'Organic All-Purpose Flour', 10, 2450, 24500, 'confirmed', $3);`,
      [id, wsA, `idem_${id}`]
    );
    return id;
  }

  it("a different amount for the same entry is refused and changes nothing", async () => {
    const id = await freshOrder("amount");
    await recordIdempotentJournalEntry(entry(wsA, { orderId: id, txHash: "0xamount" }));

    const attempt = await recordIdempotentJournalEntry(
      entry(wsA, { orderId: id, amountCents: 99999n, txHash: "0xother" })
    ).catch((err: unknown) => err);

    expect(attempt).toBeInstanceOf(JournalConflictError);
    expect((attempt as Error).message).not.toMatch(/99999/);
    const rows = await query(
      `SELECT amount_cents, tx_hash FROM accounting_journal_entries WHERE idempotency_key = $1;`,
      [`idem_je_${id}`]
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ amount_cents: "24500", tx_hash: "0xamount" });
  });

  it("a stored transaction hash is never replaced", async () => {
    const id = await freshOrder("hash");
    await recordIdempotentJournalEntry(entry(wsA, { orderId: id, txHash: "0xone" }));

    const later = await recordIdempotentJournalEntry(entry(wsA, { orderId: id, txHash: "0xtwo" }));

    expect(later.tx_hash).toBe("0xone");
    const rows = await query(`SELECT tx_hash FROM accounting_journal_entries WHERE idempotency_key = $1;`, [`idem_je_${id}`]);
    expect(rows.rows[0].tx_hash).toBe("0xone");
  });

  it("a missing transaction hash is filled in by a later call", async () => {
    const id = await freshOrder("fill");
    const first = await recordIdempotentJournalEntry(entry(wsA, { orderId: id }));
    expect(first.tx_hash).toBeNull();

    const later = await recordIdempotentJournalEntry(entry(wsA, { orderId: id, txHash: "0xlater" }));

    expect(later.tx_hash).toBe("0xlater");
    const rows = await query(`SELECT tx_hash FROM accounting_journal_entries WHERE idempotency_key = $1;`, [`idem_je_${id}`]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].tx_hash).toBe("0xlater");
  });
});
