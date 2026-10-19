import { query } from "../db/client.js";

/**
 * The key already holds an entry for another workspace or another amount. The message does not name the other
 * workspace or the stored amount. Nothing was changed.
 */
export class JournalConflictError extends Error {
  constructor(message: string = "A journal entry with this key already exists and does not match this request.") {
    super(message);
    this.name = "JournalConflictError";
  }
}

/**
 * Writes the journal entry for an order, at most one row per key. A repeat call with the same workspace and amount
 * returns the stored row. A stored transaction hash is never replaced (the first one wins). A missing one can be
 * filled in by a later call. A call from another workspace, or with another amount, changes nothing and throws
 * JournalConflictError.
 */
export async function recordIdempotentJournalEntry(params: {
  workspaceId: string;
  orderId: string;
  orderNumber: string;
  itemName: string;
  supplierName: string;
  amountCents: bigint;
  txHash?: string;
}) {
  const idemKey = `idem_je_${params.orderId}`;
  const entryId = `je_${params.orderId}`;
  const entryNumber = `JE-${params.orderNumber.replace(/^PO-/, "")}`;
  const memo = `3-Way Match Verified: ${params.itemName} from ${params.supplierName} (${params.orderNumber})`;

  const res = await query(
    `INSERT INTO accounting_journal_entries (id, workspace_id, order_id, entry_number, debit_account, credit_account, amount_cents, currency, memo, provenance, tx_hash, idempotency_key, created_at)
     VALUES ($1, $2, $3, $4, '1400 · Inventory Asset', '2000 · Accounts Payable / USDC Treasury', $5, 'USDC', $6, 'THREE_WAY_MATCH_VERIFIED', $7, $8, NOW())
     ON CONFLICT (idempotency_key) DO UPDATE SET
       tx_hash = COALESCE(accounting_journal_entries.tx_hash, EXCLUDED.tx_hash)
     WHERE accounting_journal_entries.workspace_id = EXCLUDED.workspace_id
       AND accounting_journal_entries.amount_cents = EXCLUDED.amount_cents
     RETURNING *;`,
    [
      entryId,
      params.workspaceId,
      params.orderId,
      entryNumber,
      params.amountCents.toString(),
      memo,
      params.txHash || null,
      idemKey,
    ]
  );

  // No row back means the conflict WHERE failed: another workspace or another amount holds this key.
  if (res.rows[0] === undefined) {
    throw new JournalConflictError();
  }
  return res.rows[0];
}
