import { query } from "../db/client.js";

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
       tx_hash = COALESCE(EXCLUDED.tx_hash, accounting_journal_entries.tx_hash)
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

  return res.rows[0];
}
