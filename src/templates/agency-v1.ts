import { EffectClass } from "../policy/effect-classifier.js";
import { WorkspaceTemplate } from "./types.js";

export const agencyTemplate: WorkspaceTemplate = {
  templateId: "agency-v1",
  name: "Digital Agency & Dev Studio",
  description: "Autonomous contractor milestone escrow, API spend tracking, and client invoicing for software agencies and developer studios.",
  defaultDailyLimitCents: 200000n, // $2,000.00 daily
  defaultApprovalThresholdCents: 50000n, // $500.00 needs owner approval
  roles: [
    {
      roleName: "contractor_ops_agent",
      displayName: "Contractor Operations Agent",
      description: "Verifies deliverables (GitHub PRs, test reports), calculates milestone completions, and creates ERC-8183 escrow releases for external contractors.",
      permittedEffects: [EffectClass.READ, EffectClass.EXTERNAL_REQUEST, EffectClass.COMMERCIAL_COMMITMENT],
      spendingLimitCents: 100000n, // $1,000.00 per milestone
      enabled: true,
    },
    {
      roleName: "billing_credits_agent",
      displayName: "API & Cloud Spend Monitor",
      description: "Tracks usage and credits across Nebius, Parallel AI, OpenAI, and cloud hosting; flags burn rate anomalies and projects runway.",
      permittedEffects: [EffectClass.READ, EffectClass.EXTERNAL_REQUEST],
      spendingLimitCents: 0n,
      enabled: true,
    },
    {
      roleName: "client_invoicing_agent",
      displayName: "Client Invoicing Agent",
      description: "Aggregates project billable items and milestones, issues deterministic payment requests via Circle USDC, and tracks on-chain settlement.",
      permittedEffects: [EffectClass.READ, EffectClass.EXTERNAL_REQUEST, EffectClass.COMMERCIAL_COMMITMENT],
      spendingLimitCents: 50000n,
      enabled: true,
    },
  ],
  seedInventory: [
    {
      sku: "SVC-DEV-FRONTEND",
      name: "Senior Frontend Engineering (Sprint Blocks)",
      category: "Contractor Services",
      unit: "hours",
      currentQuantity: 15,
      parLevel: 20, // Low stock: trigger replenish hours!
      reorderQuantity: 40,
      unitPriceCents: 6500n, // $65.00/hr
      preferredSupplierId: "supp-contractor-alex",
    },
    {
      sku: "CREDIT-NEBIUS-TOKEN",
      name: "Nebius Token Factory Compute Credits",
      category: "API Infrastructure",
      unit: "credits",
      currentQuantity: 120,
      parLevel: 100,
      reorderQuantity: 500,
      unitPriceCents: 100n, // $1.00 per unit
      preferredSupplierId: "supp-nebius-api",
    },
    {
      sku: "CREDIT-PARALLEL-TASK",
      name: "Parallel Task API & Deep Research Units",
      category: "API Infrastructure",
      unit: "queries",
      currentQuantity: 45,
      parLevel: 50, // Low stock: trigger reload!
      reorderQuantity: 200,
      unitPriceCents: 50n, // $0.50 per query
      preferredSupplierId: "supp-parallel-web",
    },
  ],
  seedSuppliers: [
    {
      id: "supp-contractor-alex",
      name: "Alex Dev (Lead Smart Contract Engineer)",
      adapterType: "escrow_contractor",
      contactEmail: "alex@contractor.example.com",
      isSimulated: true,
      endpointUrl: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    },
    {
      id: "supp-parallel-web",
      name: "Parallel AI Task API (Live/Simulated)",
      adapterType: "parallel_task",
      contactEmail: "support@parallel.ai",
      isSimulated: true,
      endpointUrl: "https://api.parallel.ai/v1",
    },
  ],
};
