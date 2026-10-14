import { kitchenTemplate } from "./kitchen-v1.js";
import { agencyTemplate } from "./agency-v1.js";
import { WorkspaceTemplate } from "./types.js";
import { withTransaction } from "../db/client.js";

const TEMPLATES: Record<string, WorkspaceTemplate> = {
  "kitchen-v1": kitchenTemplate,
  "agency-v1": agencyTemplate,
};

export function getTemplate(templateId: string): WorkspaceTemplate | undefined {
  return TEMPLATES[templateId];
}

export function listTemplates(): WorkspaceTemplate[] {
  return Object.values(TEMPLATES);
}

export interface ProvisionOptions {
  settlementAddress?: string;
  settlementMode?: "local" | "arc-testnet";
  customDailyLimitCents?: bigint;
  customApprovalThresholdCents?: bigint;
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
    throw new Error(`Invalid templateId '${templateId}'. Supported templates: ${Object.keys(TEMPLATES).join(", ")}`);
  }

  const dailyLimit = options?.customDailyLimitCents ?? template.defaultDailyLimitCents;
  const approvalThreshold = options?.customApprovalThresholdCents ?? template.defaultApprovalThresholdCents;
  const settlementMode = options?.settlementMode ?? "local";
  const settlementAddress = options?.settlementAddress || "0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2";

  await withTransaction(async (client) => {
    // 1. Insert Workspace
    await client.query(
      `INSERT INTO workspaces (id, name, template_id, settlement_address, settlement_mode, budget_daily_limit_cents, approval_threshold_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         template_id = EXCLUDED.template_id,
         settlement_address = EXCLUDED.settlement_address,
         settlement_mode = EXCLUDED.settlement_mode,
         budget_daily_limit_cents = EXCLUDED.budget_daily_limit_cents,
         approval_threshold_cents = EXCLUDED.approval_threshold_cents,
         updated_at = NOW();`,
      [workspaceId, name, templateId, settlementAddress, settlementMode, dailyLimit, approvalThreshold]
    );

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
        await client.query(
          `INSERT INTO suppliers (id, workspace_id, name, adapter_type, contact_email, verified, is_simulated, endpoint_url)
           VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7)
           ON CONFLICT (id) DO NOTHING;`,
          [suppId, workspaceId, supp.name, supp.adapterType, supp.contactEmail, supp.isSimulated, supp.endpointUrl]
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
