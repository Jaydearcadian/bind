import { z } from "zod";
import { query } from "../db/client.js";
import {
  evaluateThreeWayMatch,
  MatchStatus,
} from "../accounting/three-way-match.js";
import { getSettlementAdapter } from "../adapters/settlement/index.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { WorkflowState } from "../workflows/types.js";
import { EffectClass } from "../policy/effect-classifier.js";
import { PolicyDecision } from "../policy/engine.js";

export const ExtractDocumentInputSchema = z.object({
  docType: z.enum(["quote", "delivery_receipt", "supplier_bill"]),
  sourceLabel: z.string().min(1).max(120).default("manual_upload"),
  rawText: z.string().min(4).max(20000),
  linkedOrderId: z.string().optional(),
});

export const ConfirmDocumentInputSchema = z.object({
  decidedBy: z.string().default("owner@bind.local"),
  linkedOrderId: z.string().optional(),
  sku: z.string().optional(),
  supplierId: z.string().optional(),
  supplierName: z.string().optional(),
  quantity: z.number().positive().optional(),
  unitPriceCents: z.number().int().nonnegative().optional(),
  totalPriceCents: z.number().int().nonnegative().optional(),
  billNumber: z.string().optional(),
});

function parseDollarToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const parts = cleaned.split(".");
  const dollars = Number(parts[0]);
  const cents = parts[1] ? Number(parts[1].padEnd(2, "0")) : 0;
  return dollars * 100 + cents;
}

/**
 * Stage 1 (Extract): Deterministic & structured extraction of untrusted document text.
 * Never commits to quotes, orders, or payments; stages as 'staged_unconfirmed' with warnings.
 */
export async function extractDocumentDraft(
  workspaceId: string,
  rawInput: unknown
) {
  const input = ExtractDocumentInputSchema.parse(rawInput);
  const text = input.rawText;
  const warnings: string[] = [];

  // Load workspace inventory and suppliers to cross-reference
  const [invRes, suppRes] = await Promise.all([
    query(`SELECT * FROM inventory_items WHERE workspace_id = $1;`, [workspaceId]),
    query(`SELECT * FROM suppliers WHERE workspace_id = $1;`, [workspaceId]),
  ]);
  const items = invRes.rows;
  const suppliers = suppRes.rows;

  // 1. Extract SKU (match explicit SKU:... or match against known workspace SKUs/names)
  let sku = "";
  const skuMatch = text.match(/SKU[:\s#-]*([A-Z0-9-_]{3,32})/i);
  if (skuMatch) {
    sku = skuMatch[1].toUpperCase();
  } else {
    for (const item of items) {
      if (
        text.toUpperCase().includes(String(item.sku).toUpperCase()) ||
        text.toLowerCase().includes(String(item.name).toLowerCase().split(" (")[0])
      ) {
        sku = item.sku;
        break;
      }
    }
  }
  const matchedItem = items.find((i: any) => i.sku === sku);
  if (!sku) {
    warnings.push("UNMATCHED_SKU: Could not automatically match an inventory SKU. Owner must confirm SKU.");
  } else if (!matchedItem) {
    warnings.push(`UNKNOWN_WORKSPACE_SKU: Extracted SKU '${sku}' is not yet in workspace inventory.`);
  }

  // 2. Extract Supplier
  let supplierName = "";
  let supplierId = "";
  const suppMatch = text.match(/(?:Supplier|Vendor|From)[:\s]+([^\n\r,;]+)/i);
  if (suppMatch) {
    supplierName = suppMatch[1].trim();
  }
  for (const s of suppliers) {
    const baseName = String(s.name).toLowerCase().replace(" (simulated)", "");
    if (
      text.toLowerCase().includes(baseName) ||
      (supplierName && baseName.includes(supplierName.toLowerCase()))
    ) {
      supplierId = s.id;
      supplierName = s.name;
      break;
    }
  }
  if (!supplierId) {
    warnings.push(
      `UNVERIFIED_SUPPLIER: Supplier '${supplierName || "Unknown"}' is not matched to a verified workspace supplier.`
    );
  }

  // 3. Extract Quantity
  let quantity = 0;
  const qtyMatch =
    text.match(/(?:Qty|Quantity|Received|Billed)[:\s]*(\d+(?:\.\d+)?)/i) ||
    text.match(/(\d+)\s*(?:bags?|cases?|units?|boxes?|kg|lb)/i);
  if (qtyMatch) {
    quantity = Number(qtyMatch[1]);
  }
  if (!quantity || quantity <= 0) {
    warnings.push("MISSING_QUANTITY: Quantity could not be parsed with certainty.");
  }

  // 4. Extract Unit Price & Total Price in integer cents
  let unitPriceCents = 0;
  let totalPriceCents = 0;
  const unitMatch =
    text.match(/(?:Unit\s*Price|Price|Rate|@)[:\s]*\$?(\d+(?:\.\d{1,2})?)/i);
  if (unitMatch) {
    unitPriceCents = parseDollarToCents(unitMatch[1]) ?? 0;
  }
  const totalMatch =
    text.match(/(?:Total\s*Price|Total\s*Amount|Total|Amount)[:\s]*\$?(\d+(?:\.\d{1,2})?)/i);
  if (totalMatch) {
    totalPriceCents = parseDollarToCents(totalMatch[1]) ?? 0;
  }

  if (unitPriceCents > 0 && quantity > 0 && totalPriceCents === 0) {
    totalPriceCents = Math.round(quantity * unitPriceCents);
  } else if (totalPriceCents > 0 && quantity > 0 && unitPriceCents === 0) {
    unitPriceCents = Math.round(totalPriceCents / quantity);
  }

  if (
    input.docType !== "delivery_receipt" &&
    unitPriceCents > 0 &&
    quantity > 0 &&
    totalPriceCents > 0 &&
    Math.round(quantity * unitPriceCents) !== totalPriceCents
  ) {
    warnings.push(
      `ARITHMETIC_VARIANCE: Stated total ($${(totalPriceCents / 100).toFixed(2)}) does not equal ${quantity} × $${(unitPriceCents / 100).toFixed(2)} ($${((quantity * unitPriceCents) / 100).toFixed(2)}).`
    );
  }

  // 5. Extract Bill / Invoice Number
  const billMatch = text.match(/(?:Bill|Invoice|Receipt|Ref)\s*(?:#|No\.?|ID)?[:\s]*([A-Z0-9-_]{3,32})/i);
  const billNumber = billMatch ? billMatch[1] : `DOC-${Date.now().toString().slice(-6)}`;

  const extractedData = {
    docType: input.docType,
    sku: sku || (matchedItem ? matchedItem.sku : ""),
    itemName: matchedItem?.name || sku || "Unmatched Item",
    supplierId,
    supplierName: supplierName || "Unconfirmed Supplier",
    quantity,
    unitPriceCents,
    totalPriceCents,
    billNumber,
    provenance: "DOCUMENT_EXTRACTED" as const,
  };

  const docId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
  const res = await query(
    `INSERT INTO staged_documents (id, workspace_id, doc_type, source_label, raw_text, extracted_data, warnings, status, linked_order_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'staged_unconfirmed', $8, NOW())
     RETURNING *;`,
    [
      docId,
      workspaceId,
      input.docType,
      input.sourceLabel,
      input.rawText,
      JSON.stringify(extractedData),
      JSON.stringify(warnings),
      input.linkedOrderId || null,
    ]
  );

  await query(
    `INSERT INTO audit_logs (id, workspace_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
     VALUES ($1, $2, 'owner', 'owner@bind.local', 'read', 'document.extract_staged', 'ALLOW', $3::jsonb, NOW());`,
    [
      `audit_doc_ext_${Date.now()}`,
      workspaceId,
      JSON.stringify({
        docId,
        docType: input.docType,
        provenance: "DOCUMENT_EXTRACTED",
        extractedData,
        warnings,
      }),
    ]
  );

  const row = res.rows[0];
  return {
    ...row,
    docId: row.id,
    docType: row.doc_type,
    provenance: "DOCUMENT_EXTRACTED",
    extractedFields: extractedData,
    warnings,
  };
}

/**
 * Stage 2 (Confirm): Owner confirms a staged document draft.
 * - Quotes -> inserted into `quotes` with OWNER_CONFIRMED provenance.
 * - Delivery Receipts / Supplier Bills -> linked to PO and evaluated via 3-way match.
 */
export async function confirmStagedDocument(
  workspaceId: string,
  docId: string,
  rawOverrides: unknown = {}
) {
  const overrides = ConfirmDocumentInputSchema.parse(rawOverrides || {});
  const docRes = await query(
    `SELECT * FROM staged_documents WHERE id = $1 AND workspace_id = $2 LIMIT 1;`,
    [docId, workspaceId]
  );
  if (docRes.rows.length === 0) {
    throw new Error(`Staged document '${docId}' not found in workspace '${workspaceId}'.`);
  }
  const doc = docRes.rows[0];

  // Idempotency guard: if already confirmed, return existing confirmation state
  if (doc.status === "owner_confirmed") {
    return {
      docId: doc.id,
      status: "owner_confirmed",
      idempotentReplay: true,
      extractedData: doc.extracted_data,
    };
  }

  const ext = doc.extracted_data || {};
  const sku = overrides.sku || ext.sku;
  const supplierName = overrides.supplierName || ext.supplierName || "Confirmed Supplier";
  let supplierId = overrides.supplierId || ext.supplierId;
  const quantity = Number(overrides.quantity ?? ext.quantity ?? 0);
  const unitPriceCents = Number(overrides.unitPriceCents ?? ext.unitPriceCents ?? 0);
  const totalPriceCents = Number(
    overrides.totalPriceCents ?? ext.totalPriceCents ?? Math.round(quantity * unitPriceCents)
  );
  const billNumber = overrides.billNumber || ext.billNumber || `INV-${Date.now().toString().slice(-6)}`;
  const linkedOrderId = overrides.linkedOrderId || doc.linked_order_id;

  if (!sku || quantity <= 0) {
    throw new Error("Confirmed document requires a valid SKU and positive quantity.");
  }

  // Case A: Confirmed Supplier Quote
  if (doc.doc_type === "quote") {
    if (unitPriceCents <= 0 || totalPriceCents <= 0) {
      throw new Error("Confirmed quote requires positive unitPriceCents and totalPriceCents.");
    }

    if (!supplierId) {
      supplierId = `${workspaceId}_supp_${supplierName.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 24)}`;
      await query(
        `INSERT INTO suppliers (id, workspace_id, name, adapter_type, verified, is_simulated)
         VALUES ($1, $2, $3, 'manual_quote', TRUE, FALSE)
         ON CONFLICT (id) DO NOTHING;`,
        [supplierId, workspaceId, supplierName]
      );
    }

    const quoteId = `q_doc_${doc.id}`;
    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await query(
      `INSERT INTO quotes (id, workspace_id, rfq_id, supplier_id, supplier_name, item_sku, quantity, unit_price_cents, total_price_cents, currency, valid_until, provenance, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'USDC', $10, 'OWNER_CONFIRMED', NOW())
       ON CONFLICT (id) DO NOTHING;`,
      [
        quoteId,
        workspaceId,
        `rfq_doc_${doc.id}`,
        supplierId,
        supplierName,
        sku,
        quantity,
        unitPriceCents,
        totalPriceCents,
        validUntil,
      ]
    );

    await query(
      `UPDATE staged_documents
       SET status = 'owner_confirmed',
           extracted_data = $1::jsonb,
           confirmed_by = $2,
           confirmed_at = NOW()
       WHERE id = $3;`,
      [
        JSON.stringify({
          ...ext,
          sku,
          supplierId,
          supplierName,
          quantity,
          unitPriceCents,
          totalPriceCents,
          quoteId,
          provenance: "OWNER_CONFIRMED",
        }),
        overrides.decidedBy,
        doc.id,
      ]
    );

    await query(
      `INSERT INTO audit_logs (id, workspace_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
       VALUES ($1, $2, 'owner', $3, 'commercial_commitment', 'document.confirm_quote', 'ALLOW', $4::jsonb, NOW());`,
      [
        `audit_doc_q_${Date.now()}`,
        workspaceId,
        overrides.decidedBy,
        JSON.stringify({ docId: doc.id, quoteId, sku, supplierId, unitPriceCents, totalPriceCents, provenance: "OWNER_CONFIRMED" }),
      ]
    );

    return {
      docId: doc.id,
      docType: "quote",
      status: "owner_confirmed",
      provenance: "OWNER_CONFIRMED",
      quoteId,
      sku,
      supplierId,
      unitPriceCents,
      totalPriceCents,
    };
  }

  // Case B: Confirmed Delivery Receipt or Supplier Bill (Linked to a Purchase Order for 3-Way Match)
  let orderRes;
  if (linkedOrderId) {
    orderRes = await query(
      `SELECT * FROM orders WHERE id = $1 AND workspace_id = $2 LIMIT 1;`,
      [linkedOrderId, workspaceId]
    );
  } else {
    orderRes = await query(
      `SELECT * FROM orders WHERE workspace_id = $1 AND item_sku = $2 ORDER BY created_at DESC LIMIT 1;`,
      [workspaceId, sku]
    );
  }

  if (!orderRes || orderRes.rows.length === 0) {
    throw new Error(
      `Cannot confirm ${doc.doc_type}: no Purchase Order found for SKU '${sku}' in workspace '${workspaceId}'.`
    );
  }
  const order = orderRes.rows[0];

  if (doc.doc_type === "delivery_receipt") {
    const receiptId = `rcpt_${doc.id}`;
    await query(
      `INSERT INTO delivery_receipts (id, order_id, received_quantity, received_at, condition_notes, discrepancy_reported)
       VALUES ($1, $2, $3, NOW(), $4, FALSE)
       ON CONFLICT (id) DO NOTHING;`,
      [receiptId, order.id, quantity, `Confirmed from document ${doc.id}`]
    );
  } else if (doc.doc_type === "supplier_bill") {
    const billId = `bill_${doc.id}`;
    await query(
      `INSERT INTO supplier_bills (id, order_id, bill_number, billed_quantity, billed_unit_price_cents, billed_total_cents, currency, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'USDC', NOW())
       ON CONFLICT (id) DO NOTHING;`,
      [billId, order.id, billNumber, quantity, unitPriceCents, totalPriceCents]
    );
  }

  await query(
    `UPDATE staged_documents
     SET status = 'owner_confirmed',
         linked_order_id = $1,
         confirmed_by = $2,
         confirmed_at = NOW()
     WHERE id = $3;`,
    [order.id, overrides.decidedBy, doc.id]
  );

  // Check if both a delivery_receipt and supplier_bill exist for this order (or synthesize the counterpart from PO if only testing a single invoice against a delivered PO)
  const [rcptRes, billRes] = await Promise.all([
    query(`SELECT * FROM delivery_receipts WHERE order_id = $1 ORDER BY received_at DESC LIMIT 1;`, [order.id]),
    query(`SELECT * FROM supplier_bills WHERE order_id = $1 ORDER BY received_at DESC LIMIT 1;`, [order.id]),
  ]);

  const activeReceipt = rcptRes.rows[0] || {
    id: `rcpt_auto_${order.id}`,
    order_id: order.id,
    received_quantity: doc.doc_type === "delivery_receipt" ? quantity : Number(order.quantity),
  };
  if (rcptRes.rows.length === 0 && doc.doc_type === "supplier_bill") {
    await query(
      `INSERT INTO delivery_receipts (id, order_id, received_quantity, received_at, condition_notes, discrepancy_reported)
       VALUES ($1, $2, $3, NOW(), 'Standard receipt paired for 3-way match check', FALSE)
       ON CONFLICT (id) DO NOTHING;`,
      [activeReceipt.id, order.id, activeReceipt.received_quantity]
    );
  }

  const activeBill = billRes.rows[0] || {
    id: `bill_auto_${order.id}`,
    order_id: order.id,
    bill_number: billNumber,
    billed_quantity: doc.doc_type === "supplier_bill" ? quantity : Number(order.quantity),
    billed_unit_price_cents:
      doc.doc_type === "supplier_bill" ? unitPriceCents : Number(order.unit_price_cents),
    billed_total_cents:
      doc.doc_type === "supplier_bill" ? totalPriceCents : Number(order.total_price_cents),
  };
  if (billRes.rows.length === 0 && doc.doc_type === "delivery_receipt") {
    await query(
      `INSERT INTO supplier_bills (id, order_id, bill_number, billed_quantity, billed_unit_price_cents, billed_total_cents, currency, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'USDC', NOW())
       ON CONFLICT (id) DO NOTHING;`,
      [
        activeBill.id,
        order.id,
        activeBill.bill_number,
        activeBill.billed_quantity,
        activeBill.billed_unit_price_cents,
        activeBill.billed_total_cents,
      ]
    );
  }

  // Evaluate strict Three-Way Match
  const matchResult = evaluateThreeWayMatch(
    {
      orderId: order.id,
      orderNumber: order.order_number,
      vendorId: order.supplier_id,
      sku: order.item_sku,
      quantity: Number(order.quantity),
      unitPriceCents: BigInt(order.unit_price_cents),
      totalPriceCents: BigInt(order.total_price_cents),
    },
    {
      receiptId: activeReceipt.id,
      orderId: order.id,
      sku: sku,
      receivedQuantity: Number(activeReceipt.received_quantity),
    },
    {
      billId: activeBill.id,
      orderId: order.id,
      billNumber: activeBill.bill_number,
      vendorId: supplierId || order.supplier_id,
      sku: sku,
      billedQuantity: Number(activeBill.billed_quantity),
      billedUnitPriceCents: BigInt(activeBill.billed_unit_price_cents),
      billedTotalCents: BigInt(activeBill.billed_total_cents),
    }
  );

  await query(
    `INSERT INTO three_way_matches (id, order_id, delivery_receipt_id, supplier_bill_id, match_status, variance_cents, notes, matched_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW());`,
    [
      `match_doc_${Date.now()}`,
      order.id,
      activeReceipt.id,
      activeBill.id,
      matchResult.status,
      matchResult.varianceCents.toString(),
      matchResult.discrepancyReason || "Verified 3-way match from owner-confirmed document",
    ]
  );

  if (matchResult.status !== MatchStatus.MATCHED) {
    await query(
      `INSERT INTO audit_logs (id, workspace_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
       VALUES ($1, $2, 'system', 'three_way_match_engine', 'commercial_commitment', 'accounting.three_way_match_failed', 'DENY', $3::jsonb, NOW());`,
      [
        `audit_3wm_fail_${Date.now()}`,
        workspaceId,
        JSON.stringify({
          orderId: order.id,
          docId: doc.id,
          matchStatus: matchResult.status,
          varianceCents: matchResult.varianceCents.toString(),
          discrepancyReason: matchResult.discrepancyReason,
        }),
      ]
    );

    return {
      docId: doc.id,
      docType: doc.doc_type,
      status: "owner_confirmed",
      orderId: order.id,
      matchStatus: matchResult.status,
      reconciled: false,
      varianceCents: matchResult.varianceCents.toString(),
      discrepancyReason: matchResult.discrepancyReason,
    };
  }

  // 3-Way Match Passed: Execute settlement & post idempotent journal entry
  const wsRes = await query(`SELECT * FROM workspaces WHERE id = $1;`, [workspaceId]);
  const ws = wsRes.rows[0];
  const settlementAdapter = getSettlementAdapter(ws.settlement_mode);
  const transferRes = await settlementAdapter.transferUSDC({
    fromAddress: ws.settlement_address || "0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2",
    toAddress: "0xa8358AED200D6CB6C856F972D853C1be833006ea",
    amountCents: matchResult.payableAmountCents,
    currency: "USDC",
    orderId: order.id,
    idempotencyKey: `idem_pay_${order.id}`,
  });

  await query(
    `UPDATE orders SET status = 'reconciled', tx_hash = $1, updated_at = NOW() WHERE id = $2;`,
    [transferRes.txHash, order.id]
  );

  await query(
    `UPDATE inventory_items
     SET current_quantity = current_quantity + $1, updated_at = NOW()
     WHERE workspace_id = $2 AND sku = $3;`,
    [Number(activeReceipt.received_quantity), workspaceId, order.item_sku]
  );

  const wfRes = await query(
    `SELECT id, state FROM workflows WHERE context_data->>'orderId' = $1 LIMIT 1;`,
    [order.id]
  );
  if (wfRes.rows.length > 0 && wfRes.rows[0].state === WorkflowState.CONFIRMED) {
    const wfEngine = new WorkflowEngine();
    await wfEngine.transition(wfRes.rows[0].id, {
      fromState: WorkflowState.CONFIRMED,
      toState: WorkflowState.RECONCILED,
      patchContext: { txHash: transferRes.txHash, settledAt: transferRes.timestamp },
    });
    await wfEngine.recordAudit(
      workspaceId,
      wfRes.rows[0].id,
      "system",
      "settlement_engine",
      EffectClass.COMMERCIAL_COMMITMENT,
      "settlement.reconcile_and_pay",
      PolicyDecision.ALLOW,
      { txHash: transferRes.txHash, payableAmountCents: matchResult.payableAmountCents.toString() },
      transferRes.txHash
    );
  }

  const journalEntry = await recordIdempotentJournalEntry({
    workspaceId,
    orderId: order.id,
    orderNumber: order.order_number,
    itemName: order.item_name,
    supplierName: order.supplier_name,
    amountCents: matchResult.payableAmountCents,
    txHash: transferRes.txHash,
  });

  return {
    docId: doc.id,
    docType: doc.doc_type,
    status: "owner_confirmed",
    orderId: order.id,
    matchStatus: MatchStatus.MATCHED,
    reconciled: true,
    txHash: transferRes.txHash,
    journalEntry,
  };
}

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

export async function listStagedDocuments(workspaceId: string) {
  const res = await query(
    `SELECT * FROM staged_documents WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 50;`,
    [workspaceId]
  );
  return res.rows;
}

export async function getWorkspaceAccountingLedger(workspaceId: string) {
  // Backfill any already-reconciled orders in this workspace that don't have a journal entry yet
  const reconciledOrders = await query(
    `SELECT * FROM orders WHERE workspace_id = $1 AND status = 'reconciled';`,
    [workspaceId]
  );
  for (const ord of reconciledOrders.rows) {
    await recordIdempotentJournalEntry({
      workspaceId,
      orderId: ord.id,
      orderNumber: ord.order_number,
      itemName: ord.item_name,
      supplierName: ord.supplier_name,
      amountCents: BigInt(ord.total_price_cents),
      txHash: ord.tx_hash || undefined,
    });
  }

  const res = await query(
    `SELECT * FROM accounting_journal_entries WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100;`,
    [workspaceId]
  );
  return res.rows;
}

export function formatLedgerAsCsv(entries: any[]): string {
  const header = [
    "entry_number",
    "created_at",
    "order_id",
    "debit_account",
    "credit_account",
    "amount_cents",
    "amount_usdc",
    "currency",
    "provenance",
    "tx_hash",
    "memo",
  ].join(",");

  const rows = entries.map((e) => {
    const cents = Number(e.amount_cents || 0);
    const usdc = (cents / 100).toFixed(2);
    const safeMemo = `"${String(e.memo || "").replace(/"/g, '""')}"`;
    return [
      e.entry_number,
      new Date(e.created_at).toISOString(),
      e.order_id || "",
      `"${e.debit_account}"`,
      `"${e.credit_account}"`,
      cents,
      usdc,
      e.currency || "USDC",
      e.provenance || "THREE_WAY_MATCH_VERIFIED",
      e.tx_hash || "",
      safeMemo,
    ].join(",");
  });

  return [header, ...rows].join("\n");
}
