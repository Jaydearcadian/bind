import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { query, withTransaction } from "../db/client.js";
import { getTemplate } from "../templates/registry.js";
import { simulatedPaymentAddress } from "../adapters/suppliers/payment-address.js";
import { CANONICAL_ARC_LOCK } from "../agents/antiDriftWriter.js";
import { templatesArtifactsDir } from "../utils/artifacts.js";
import { newId } from "../utils/ids.js";

export const SAFE_AGENT_TOOLS = [
  "get_business_context",
  "get_stock_snapshot",
  "get_approved_supplier_quotes",
  "create_replenishment_proposal",
  "request_policy_evaluation",
  "get_request_status",
] as const;

export const FORBIDDEN_AGENT_CAPABILITIES = [
  "transfer_usdc",
  "raw_signer",
  "private_key_export",
  "self_approve_order",
  "bypass_policy",
  "override_daily_limit",
] as const;

export class ForbiddenCapabilityError extends Error {
  constructor(message: string) {
    super(`[FORBIDDEN_CAPABILITY_VIOLATION] ${message}`);
    this.name = "ForbiddenCapabilityError";
  }
}

export const InitialSupplyItemSchema = z.object({
  sku: z.string().min(2).max(64),
  name: z.string().min(2).max(120),
  category: z.string().min(2).max(64).default("General"),
  unit: z.string().min(1).max(32).default("unit"),
  currentQuantity: z.number().nonnegative(),
  parLevel: z.number().nonnegative(),
  reorderQuantity: z.number().positive(),
  unitPriceCents: z.number().int().nonnegative(),
  preferredSupplierId: z.string().optional(),
});

export const InitialSupplierSchema = z.object({
  id: z.string().min(2).max(64),
  name: z.string().min(2).max(120),
  adapterType: z
    .enum(["simulated_sysco", "simulated_baldor", "rest_api", "manual_quote"])
    .default("manual_quote"),
  contactEmail: z.string().email().optional().or(z.literal("")),
  verified: z.boolean().default(true),
  isSimulated: z.boolean().default(true),
  endpointUrl: z.string().optional(),
});

export const PROTECTED_CANONICAL_TEMPLATES = new Set([
  "kitchen-ops",
  "coffee-roaster",
]);

export const OnboardWorkspaceSchema = z.object({
  workspaceId: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9-_]+$/i, "workspaceId must be alphanumeric with hyphens/underscores")
    .refine(
      (val) => !PROTECTED_CANONICAL_TEMPLATES.has(val.toLowerCase()),
      "workspaceId cannot overwrite a protected canonical reference template (kitchen-ops, coffee-roaster)"
    ),
  name: z.string().min(2).max(120),
  businessType: z
    .enum(["kitchen", "cafe", "roastery", "retail", "service", "custom"])
    .default("kitchen"),
  referenceTemplateId: z.string().optional(),
  settlementMode: z.enum(["local", "arc-testnet"]).default("local"),
  settlementAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid 40-hex-character EVM address")
    .optional(),
  budgetDailyLimitCents: z.number().int().positive(),
  approvalThresholdCents: z.number().int().nonnegative(),
  supplies: z.array(InitialSupplyItemSchema).default([]),
  suppliers: z.array(InitialSupplierSchema).default([]),
});

export type OnboardWorkspaceInput = z.infer<typeof OnboardWorkspaceSchema>;

export const AgentRoleUpsertSchema = z.object({
  roleName: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9_]+$/, "roleName must be lowercase snake_case"),
  displayName: z.string().min(2).max(120),
  description: z.string().min(5).max(1000),
  permittedEffects: z
    .array(z.enum(["read", "external_request", "commercial_commitment"]))
    .min(1),
  spendingLimitCents: z.number().int().nonnegative(),
  allowedTools: z.array(z.string()).min(1),
  enabled: z.boolean().default(true),
});

export type AgentRoleUpsertInput = z.infer<typeof AgentRoleUpsertSchema>;

/**
 * Validates that every requested tool is in SAFE_AGENT_TOOLS and none are forbidden.
 */
export function assertSafeAgentTools(tools: string[]): void {
  const safeSet = new Set<string>(SAFE_AGENT_TOOLS);
  for (const t of tools) {
    if ((FORBIDDEN_AGENT_CAPABILITIES as readonly string[]).includes(t)) {
      throw new ForbiddenCapabilityError(
        `Capability '${t}' is permanently forbidden for agents. Financial settlement and owner approvals are enforced deterministically outside the model.`
      );
    }
    if (!safeSet.has(t)) {
      throw new ForbiddenCapabilityError(
        `Tool '${t}' is not in the approved typed tool registry (${SAFE_AGENT_TOOLS.join(", ")}).`
      );
    }
  }
}

/**
 * Returns an optional blueprint pre-fill from a reference template without creating any database records.
 */
export function getTemplateBlueprint(templateId: string) {
  const tpl = getTemplate(templateId);
  if (!tpl) {
    return null;
  }
  return {
    referenceTemplateId: tpl.templateId,
    name: tpl.name,
    description: tpl.description,
    defaultDailyLimitCents: Number(tpl.defaultDailyLimitCents),
    defaultApprovalThresholdCents: Number(tpl.defaultApprovalThresholdCents),
    suggestedRoles: tpl.roles.map((r) => ({
      roleName: r.roleName,
      displayName: r.displayName,
      description: r.description,
      permittedEffects: r.permittedEffects,
      spendingLimitCents: Number(r.spendingLimitCents),
      allowedTools: [...SAFE_AGENT_TOOLS],
      enabled: r.enabled,
    })),
    suggestedSuppliers: (tpl.seedSuppliers || []).map((s) => ({
      id: s.id,
      name: s.name,
      adapterType: s.adapterType,
      contactEmail: s.contactEmail || "",
      verified: true,
      isSimulated: s.isSimulated,
    })),
    suggestedSupplies: (tpl.seedInventory || []).map((i) => ({
      sku: i.sku,
      name: i.name,
      category: i.category,
      unit: i.unit,
      currentQuantity: i.currentQuantity,
      parLevel: i.parLevel,
      reorderQuantity: i.reorderQuantity,
      unitPriceCents: Number(i.unitPriceCents),
      preferredSupplierId: i.preferredSupplierId,
    })),
  };
}

/**
 * Creates a genuinely blank or owner-configured workspace in PostgreSQL.
 * Never fabricates orders, workflows, invoices, or transactions.
 */
export async function onboardBlankWorkspace(rawInput: unknown) {
  const input = OnboardWorkspaceSchema.parse(rawInput);

  if (input.approvalThresholdCents > input.budgetDailyLimitCents) {
    throw new Error(
      `Approval threshold (${input.approvalThresholdCents}¢) cannot exceed daily budget limit (${input.budgetDailyLimitCents}¢).`
    );
  }

  // Same rule as provisionWorkspace: a local workspace gets its own simulated address, an
  // arc-testnet workspace without an address stores NULL (payments are held until one is set).
  const settlementAddress =
    input.settlementAddress ??
    (input.settlementMode === "local" ? simulatedPaymentAddress(`workspace:${input.workspaceId}`) : null);

  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO workspaces (id, name, template_id, settlement_address, settlement_mode, budget_daily_limit_cents, approval_threshold_cents, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         template_id = EXCLUDED.template_id,
         settlement_address = COALESCE($8::text, workspaces.settlement_address, EXCLUDED.settlement_address),
         settlement_mode = EXCLUDED.settlement_mode,
         budget_daily_limit_cents = EXCLUDED.budget_daily_limit_cents,
         approval_threshold_cents = EXCLUDED.approval_threshold_cents,
         updated_at = NOW();`,
      [
        input.workspaceId,
        input.name,
        input.workspaceId,
        settlementAddress,
        input.settlementMode,
        input.budgetDailyLimitCents,
        input.approvalThresholdCents,
        input.settlementAddress ?? null,
      ]
    );

    // Insert default procurement_agent role bounded by the owner's configured limits
    const defaultRoleId = `role_${input.workspaceId}_procurement_agent`;
    await client.query(
      `INSERT INTO agent_roles (id, workspace_id, role_name, display_name, description, permitted_effects, spending_limit_cents, allowed_tools, enabled)
       VALUES ($1, $2, 'procurement_agent', 'Replenishment & Procurement Agent', 'Monitors workspace stock levels, evaluates approved supplier quotes, and proposes replenishment within deterministic policy bounds.', ARRAY['read', 'external_request', 'commercial_commitment']::TEXT[], $3, $4::TEXT[], TRUE)
       ON CONFLICT (workspace_id, role_name) DO UPDATE SET
         spending_limit_cents = EXCLUDED.spending_limit_cents;`,
      [
        defaultRoleId,
        input.workspaceId,
        input.approvalThresholdCents,
        [...SAFE_AGENT_TOOLS],
      ]
    );

    // Insert owner-configured suppliers (if any provided)
    for (const supp of input.suppliers) {
      const fullSuppId = supp.id.startsWith(`${input.workspaceId}_`)
        ? supp.id
        : `${input.workspaceId}_${supp.id}`;
      await client.query(
        `INSERT INTO suppliers (id, workspace_id, name, adapter_type, contact_email, verified, is_simulated, endpoint_url, payment_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           verified = EXCLUDED.verified,
           contact_email = EXCLUDED.contact_email,
           payment_address = COALESCE(suppliers.payment_address, EXCLUDED.payment_address);`,
        [
          fullSuppId,
          input.workspaceId,
          supp.name,
          supp.adapterType,
          supp.contactEmail || null,
          supp.verified,
          supp.isSimulated,
          supp.endpointUrl || null,
          supp.isSimulated ? simulatedPaymentAddress(fullSuppId) : null,
        ]
      );
    }

    // Insert owner-configured supplies (if any provided)
    for (const item of input.supplies) {
      const itemId = `inv_${input.workspaceId}_${item.sku}`;
      const prefSupp = item.preferredSupplierId
        ? item.preferredSupplierId.startsWith(`${input.workspaceId}_`)
          ? item.preferredSupplierId
          : `${input.workspaceId}_${item.preferredSupplierId}`
        : null;
      await client.query(
        `INSERT INTO inventory_items (id, workspace_id, sku, name, category, unit, current_quantity, par_level, reorder_quantity, unit_price_cents, preferred_supplier_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT (workspace_id, sku) DO UPDATE SET
           name = EXCLUDED.name,
           current_quantity = EXCLUDED.current_quantity,
           par_level = EXCLUDED.par_level,
           reorder_quantity = EXCLUDED.reorder_quantity,
           unit_price_cents = EXCLUDED.unit_price_cents,
           preferred_supplier_id = EXCLUDED.preferred_supplier_id,
           updated_at = NOW();`,
        [
          itemId,
          input.workspaceId,
          item.sku,
          item.name,
          item.category,
          item.unit,
          item.currentQuantity,
          item.parLevel,
          item.reorderQuantity,
          item.unitPriceCents,
          prefSupp,
        ]
      );
    }

    // Record owner audit log
    await client.query(
      `INSERT INTO audit_logs (id, workspace_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
       VALUES ($1, $2, 'owner', 'owner@bind.local', 'commercial_commitment', 'workspace.onboard_configured', 'ALLOW', $3::jsonb, NOW());`,
      [
        newId("audit_onboard"),
        input.workspaceId,
        JSON.stringify({
          provenance: "OWNER_CONFIRMED",
          businessType: input.businessType,
          referenceTemplateId: input.referenceTemplateId || "blank",
          budgetDailyLimitCents: input.budgetDailyLimitCents,
          approvalThresholdCents: input.approvalThresholdCents,
          suppliesCount: input.supplies.length,
          suppliersCount: input.suppliers.length,
        }),
      ]
    );
  });

  const derivedFiles = await syncWorkspaceDerivedTemplateFiles(input.workspaceId);

  return {
    workspaceId: input.workspaceId,
    name: input.name,
    provenance: "OWNER_CONFIRMED" as const,
    derivedFiles,
  };
}

/**
 * Upserts an agent role in PostgreSQL and regenerates derived AGENTS.md / SKILL.md files.
 */
export async function upsertAgentRole(workspaceId: string, rawInput: unknown) {
  const input = AgentRoleUpsertSchema.parse(rawInput);
  assertSafeAgentTools(input.allowedTools);

  const wsRes = await query(`SELECT * FROM workspaces WHERE id = $1;`, [workspaceId]);
  if (wsRes.rows.length === 0) {
    throw new Error(`Workspace '${workspaceId}' not found.`);
  }
  const ws = wsRes.rows[0];
  const dailyLimitCents = Number(ws.budget_daily_limit_cents);
  if (input.spendingLimitCents > dailyLimitCents) {
    throw new Error(
      `Role spending limit (${input.spendingLimitCents}¢) cannot exceed workspace daily budget limit (${dailyLimitCents}¢).`
    );
  }

  const roleId = `role_${workspaceId}_${input.roleName}`;
  await query(
    `INSERT INTO agent_roles (id, workspace_id, role_name, display_name, description, permitted_effects, spending_limit_cents, allowed_tools, enabled)
     VALUES ($1, $2, $3, $4, $5, $6::TEXT[], $7, $8::TEXT[], $9)
     ON CONFLICT (workspace_id, role_name) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       permitted_effects = EXCLUDED.permitted_effects,
       spending_limit_cents = EXCLUDED.spending_limit_cents,
       allowed_tools = EXCLUDED.allowed_tools,
       enabled = EXCLUDED.enabled;`,
    [
      roleId,
      workspaceId,
      input.roleName,
      input.displayName,
      input.description,
      input.permittedEffects,
      input.spendingLimitCents,
      input.allowedTools,
      input.enabled,
    ]
  );

  await query(
    `INSERT INTO audit_logs (id, workspace_id, actor_type, actor_id, effect_class, action, policy_decision, evidence, created_at)
     VALUES ($1, $2, 'owner', 'owner@bind.local', 'commercial_commitment', 'agent_role.configure', 'ALLOW', $3::jsonb, NOW());`,
    [
      newId("audit_role"),
      workspaceId,
      JSON.stringify({
        provenance: "OWNER_CONFIRMED",
        roleName: input.roleName,
        displayName: input.displayName,
        permittedEffects: input.permittedEffects,
        spendingLimitCents: input.spendingLimitCents,
        allowedTools: input.allowedTools,
        enabled: input.enabled,
      }),
    ]
  );

  const derivedFiles = await syncWorkspaceDerivedTemplateFiles(workspaceId);
  return {
    roleId,
    workspaceId,
    roleName: input.roleName,
    displayName: input.displayName,
    permittedEffects: input.permittedEffects,
    spendingLimitCents: input.spendingLimitCents,
    allowedTools: input.allowedTools,
    enabled: input.enabled,
    derivedFiles,
  };
}

/**
 * Generates templates/<workspaceId>/AGENTS.md and skills/supply-replenishment/SKILL.md
 * as derived artifacts from the canonical PostgreSQL workspace + agent_roles state.
 */
export async function syncWorkspaceDerivedTemplateFiles(workspaceId: string) {
  if (PROTECTED_CANONICAL_TEMPLATES.has(workspaceId.toLowerCase())) {
    throw new Error(
      `Refusing to overwrite protected canonical reference template '${workspaceId}'.`
    );
  }
  const wsRes = await query(`SELECT * FROM workspaces WHERE id = $1;`, [workspaceId]);
  if (wsRes.rows.length === 0) {
    throw new Error(`Workspace '${workspaceId}' not found.`);
  }
  const ws = wsRes.rows[0];
  const rolesRes = await query(
    `SELECT * FROM agent_roles WHERE workspace_id = $1 ORDER BY created_at ASC;`,
    [workspaceId]
  );

  const templateDir = path.join(templatesArtifactsDir(), workspaceId);
  const skillDir = path.join(templateDir, "skills", "supply-replenishment");
  const stateDir = path.join(templateDir, "state", "requests");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });

  const dailyFormatted = `$${(Number(ws.budget_daily_limit_cents) / 100).toFixed(2)} USDC`;
  const gateFormatted = `$${(Number(ws.approval_threshold_cents) / 100).toFixed(2)} USDC`;

  const rolesMarkdown = rolesRes.rows
    .map((r: any) => {
      const limitFmt = `$${(Number(r.spending_limit_cents) / 100).toFixed(2)} USDC`;
      const toolsList = (r.allowed_tools || SAFE_AGENT_TOOLS).join(", ");
      const effectsList = (r.permitted_effects || []).join(", ");
      return `### ${r.display_name} (\`${r.role_name}\`)
- **Status:** ${r.enabled ? "ENABLED (Enforced by PolicyEngine)" : "DISABLED"}
- **Permitted Effect Classes:** \`${effectsList}\`
- **Role Spending Cap:** \`${limitFmt}\`
- **Allowed Typed Tools:** \`${toolsList}\`
- **Operating Mandate:** ${r.description || "Execute assigned workflow within deterministic bounds."}`;
    })
    .join("\n\n");

  const agentsMd = `# ${ws.name} — Bind Agent Operating Constitution (Derived Artifact)

> **Canonical Source of Truth:** PostgreSQL (\`workspaces.id = '${ws.id}'\`).
> **Enforcement Invariant:** Prompt instructions never grant financial authority. All spending limits, counterparty allowlists, and approval gates are enforced deterministically by \`PolicyEngine\` and \`BindSettlement.sol\`.

## 1. Workspace Authority & Spending Policy
- **Workspace ID:** \`${ws.id}\`
- **Settlement Mode:** \`${ws.settlement_mode}\`
- **Treasury Address:** \`${ws.settlement_address ?? "not set"}\`
- **BindSettlement Contract (Arc Testnet 5042002):** \`${CANONICAL_ARC_LOCK.bindSettlementContract}\`
- **Hard Daily Spend Limit:** \`${dailyFormatted}\`
- **Owner Approval Gate:** Orders exceeding \`${gateFormatted}\` require explicit owner sign-off.

## 2. Configured Role-Specific Agents
${rolesMarkdown || "No roles configured."}

## 3. Non-Negotiable Anti-Drift Rules
1. Never fabricate a supplier quote, delivery receipt, invoice, or transaction hash.
2. Model confidence never independently authorizes a payment; deterministic policy rules govern all commitments.
3. Keep \`SETTLED_ON_ARC_TESTNET\` separate from physical delivery (\`AWAITING_3WAY_MATCH\` / \`RECONCILED\`).
`;

  const skillMd = `---
name: supply-replenishment
description: Governed stock monitoring, verified quote evaluation, and deterministic policy submission for ${ws.name}.
---

# Supply Replenishment Procedure (${ws.name})

1. Call \`get_business_context\` and \`get_stock_snapshot\` to inspect current stock vs. par levels.
2. Call \`get_approved_supplier_quotes\` for the low-stock SKU and select the best unexpired verified quote.
3. Call \`create_replenishment_proposal\` with integer quantities and underlying database record IDs.
4. Call \`request_policy_evaluation\` so the deterministic backend policy engine evaluates the proposal against the ${gateFormatted} owner approval gate and ${dailyFormatted} daily cap.
5. Call \`get_request_status\` and report the resulting state honestly.
`;

  const agentsPath = path.join(templateDir, "AGENTS.md");
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(agentsPath, agentsMd, "utf8");
  await fs.writeFile(skillPath, skillMd, "utf8");

  return {
    agentsSpecPath: `templates/${workspaceId}/AGENTS.md`,
    skillSpecPath: `templates/${workspaceId}/skills/supply-replenishment/SKILL.md`,
  };
}
