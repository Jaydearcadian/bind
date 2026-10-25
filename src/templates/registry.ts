import { kitchenTemplate } from "./kitchen-v1.js";
import { agencyTemplate } from "./agency-v1.js";
import { socialTemplate } from "./social-v1.js";
import { WorkspaceTemplate } from "./types.js";
import { withTransaction } from "../db/client.js";
import { simulatedPaymentAddress } from "../adapters/suppliers/payment-address.js";

const BASE_TEMPLATES: Record<string, WorkspaceTemplate> = {
  "kitchen-v1": kitchenTemplate,
  "agency-v1": agencyTemplate,
  "social-v1": socialTemplate,
};

/** Refusal code for a stock route on a workspace whose template has no stock module (docs/decisions/0083). */
export const NO_STOCK_CODE = "TEMPLATE_HAS_NO_STOCK" as const;
export const NO_STOCK_MESSAGE = "This workspace's template has no stock module.";

/** True when the template has a stock module. A template with no seedInventory has none. */
export function templateHasStock(template: WorkspaceTemplate): boolean {
  return template.seedInventory !== undefined;
}

/** True when the template has a purchasing (suppliers) module. */
export function templateHasSuppliers(template: WorkspaceTemplate): boolean {
  return template.seedSuppliers !== undefined;
}

/**
 * True when a workspace's template is a known template with no stock module. A blank workspace (its template_id is its own
 * id, so it names no template) is not refused: stock routes behave as they always did for it.
 */
export function refusesStock(templateId: string | null | undefined): boolean {
  if (!templateId) return false;
  const template = getTemplate(templateId);
  return template !== undefined && !templateHasStock(template);
}

/** Thrown by the replenishment start for a stock-less template. The route answers 400 with `code`. */
export class NoStockModuleError extends Error {
  readonly code = NO_STOCK_CODE;

  constructor() {
    super(NO_STOCK_MESSAGE);
    this.name = "NoStockModuleError";
  }
}

export function getTemplate(templateId: string): WorkspaceTemplate | undefined {
  // Only the template table's own keys count: "constructor" or "__proto__" name no template (Task 11).
  const own = (id: string): WorkspaceTemplate | undefined =>
    Object.prototype.hasOwnProperty.call(BASE_TEMPLATES, id) ? BASE_TEMPLATES[id] : undefined;
  if (own(templateId)) return own(templateId);
  if (templateId === "kitchen-ops") return own("kitchen-v1");
  return own(templateId);
}

export function listTemplates(): WorkspaceTemplate[] {
  return Object.values(BASE_TEMPLATES);
}

export interface ProvisionOptions {
  settlementAddress?: string;
  settlementMode?: "local" | "arc-testnet";
  customDailyLimitCents?: bigint;
  customApprovalThresholdCents?: bigint;
  /**
   * When the workspace already exists, leave it completely untouched: no field reset, no role, supplier or
   * inventory re-seeding. Used for the demo workspace on every boot, so an owner's policy survives a restart.
   */
  ifAbsent?: boolean;
  /**
   * Makes the workspace a demo that expires at this time (docs/decisions/0057). Written in the same insert as the workspace row.
   * Only a new row gets it: a conflicting id is updated without the demo fields, so a real workspace never becomes a demo.
   */
  demoExpiresAt?: Date;
}

/**
 * Provisions a complete business workspace from a template in a single transaction.
 * Creates the workspace, roles, seed inventory items, and suppliers.
 */
export async function provisionWorkspace(
  workspaceId: string,
  name: string,
  templateId: string,
  options?: ProvisionOptions
): Promise<WorkspaceTemplate> {
  const template = getTemplate(templateId);
  if (!template) {
    throw new Error(`Invalid templateId '${templateId}'. Supported templates: ${Object.keys(BASE_TEMPLATES).join(", ")}`);
  }

  const dailyLimit = options?.customDailyLimitCents ?? template.defaultDailyLimitCents;
  const approvalThreshold = options?.customApprovalThresholdCents ?? template.defaultApprovalThresholdCents;
  const settlementMode = options?.settlementMode ?? "local";
  // No shared default payer wallet. A local workspace gets its own simulated address. An
  // arc-testnet workspace without an address stores NULL, and its payments are held until one is set.
  const explicitSettlementAddress = options?.settlementAddress || null;
  const isDemo = options?.demoExpiresAt !== undefined;
  const demoExpiresAt = options?.demoExpiresAt ?? null;
  const settlementAddress =
    explicitSettlementAddress ??
    (settlementMode === "local" ? simulatedPaymentAddress(`workspace:${workspaceId}`) : null);

  await withTransaction(async (client) => {
    // 1. Insert Workspace
    if (options?.ifAbsent) {
      const created = await client.query(
        `INSERT INTO workspaces (id, name, template_id, settlement_address, settlement_mode, budget_daily_limit_cents, approval_threshold_cents, is_demo, demo_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING
         RETURNING id;`,
        [workspaceId, name, templateId, settlementAddress, settlementMode, dailyLimit, approvalThreshold, isDemo, demoExpiresAt]
      );
      if ((created.rowCount ?? 0) === 0) {
        // Already provisioned: the owner's configuration is not touched, and nothing else is seeded.
        return;
      }
    } else {
      await client.query(
        `INSERT INTO workspaces (id, name, template_id, settlement_address, settlement_mode, budget_daily_limit_cents, approval_threshold_cents, is_demo, demo_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           template_id = EXCLUDED.template_id,
           settlement_address = COALESCE($8::text, workspaces.settlement_address, EXCLUDED.settlement_address),
           settlement_mode = EXCLUDED.settlement_mode,
           budget_daily_limit_cents = EXCLUDED.budget_daily_limit_cents,
           approval_threshold_cents = EXCLUDED.approval_threshold_cents,
           updated_at = NOW();`,
        [
          workspaceId,
          name,
          templateId,
          settlementAddress,
          settlementMode,
          dailyLimit,
          approvalThreshold,
          explicitSettlementAddress,
          isDemo,
          demoExpiresAt,
        ]
      );
    }

    // 2. Insert Agent Roles
    for (const role of template.roles) {
      const roleId = `role_${workspaceId}_${role.roleName}`;
      await client.query(
        `INSERT INTO agent_roles (id, workspace_id, role_name, display_name, description, permitted_effects, spending_limit_cents, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (workspace_id, role_name) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           description = EXCLUDED.description,
           permitted_effects = EXCLUDED.permitted_effects,
           spending_limit_cents = EXCLUDED.spending_limit_cents,
           enabled = EXCLUDED.enabled;`,
        [
          roleId,
          workspaceId,
          role.roleName,
          role.displayName,
          role.description,
          role.permittedEffects,
          role.spendingLimitCents,
          role.enabled,
        ]
      );
    }

    // 3. Insert Seed Suppliers
    if (template.seedSuppliers) {
      for (const supp of template.seedSuppliers) {
        const suppId = `${workspaceId}_${supp.id}`;
        // Only simulated suppliers get a payee address here; a real supplier gets one from its owner.
        const paymentAddress = supp.isSimulated ? simulatedPaymentAddress(suppId) : null;
        await client.query(
          `INSERT INTO suppliers (id, workspace_id, name, adapter_type, contact_email, verified, is_simulated, endpoint_url, payment_address)
           VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8)
           ON CONFLICT (id) DO NOTHING;`,
          [
            suppId,
            workspaceId,
            supp.name,
            supp.adapterType,
            supp.contactEmail,
            supp.isSimulated,
            supp.endpointUrl,
            paymentAddress,
          ]
        );
      }
    }

    // 4. Insert Seed Inventory
    if (template.seedInventory) {
      for (const item of template.seedInventory) {
        const itemId = `inv_${workspaceId}_${item.sku}`;
        const suppId = item.preferredSupplierId ? `${workspaceId}_${item.preferredSupplierId}` : null;
        await client.query(
          `INSERT INTO inventory_items (id, workspace_id, sku, name, category, unit, current_quantity, par_level, reorder_quantity, unit_price_cents, preferred_supplier_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (workspace_id, sku) DO UPDATE SET
             current_quantity = EXCLUDED.current_quantity,
             par_level = EXCLUDED.par_level,
             reorder_quantity = EXCLUDED.reorder_quantity,
             unit_price_cents = EXCLUDED.unit_price_cents;`,
          [
            itemId,
            workspaceId,
            item.sku,
            item.name,
            item.category,
            item.unit,
            item.currentQuantity,
            item.parLevel,
            item.reorderQuantity,
            item.unitPriceCents,
            suppId,
          ]
        );
      }
    }
  });

  return template;
}
