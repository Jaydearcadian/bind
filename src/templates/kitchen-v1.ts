import { EffectClass } from "../policy/effect-classifier.js";
import { WorkspaceTemplate } from "./types.js";

export const kitchenTemplate: WorkspaceTemplate = {
  templateId: "kitchen-v1",
  name: "Commercial Kitchen & Restaurant",
  description: "Automated replenishment, inventory tracking, supplier RFQ, and fulfillment for restaurants and dark kitchens.",
  defaultDailyLimitCents: 100000n, // $1,000.00 daily
  defaultApprovalThresholdCents: 25000n, // $250.00 needs owner approval
  roles: [
    {
      roleName: "procurement_agent",
      displayName: "Kitchen Procurement Agent",
      description: "Monitors inventory levels, issues supplier RFQs, compares price quotes against historical baselines, and issues purchase orders within authority limits.",
      permittedEffects: [EffectClass.READ, EffectClass.EXTERNAL_REQUEST, EffectClass.COMMERCIAL_COMMITMENT],
      spendingLimitCents: 50000n, // $500.00 per transaction
      enabled: true,
    },
    {
      roleName: "fulfilment_agent",
      displayName: "Customer & Fulfilment Agent",
      description: "Tracks incoming delivery receipts, logs goods arrival condition, reserves ingredients for kitchen prep, and informs staff of delivery ETAs.",
      permittedEffects: [EffectClass.READ, EffectClass.EXTERNAL_REQUEST],
      spendingLimitCents: 0n,
      enabled: true,
    },
    {
      roleName: "menu_feedback_agent",
      displayName: "Menu & Feedback Agent",
      description: "Ingests guest reviews, tracks ingredient waste logs, and generates recommended menu pricing and specials without directly publishing operational changes.",
      permittedEffects: [EffectClass.READ, EffectClass.EXTERNAL_REQUEST],
      spendingLimitCents: 0n,
      enabled: true,
    },
  ],
  seedInventory: [
    {
      sku: "FOOD-FLOUR-50LB",
      name: "Organic All-Purpose Flour (50 lb)",
      category: "Dry Goods",
      unit: "bag",
      currentQuantity: 3, // Low stock: below par level of 6!
      parLevel: 6,
      reorderQuantity: 10,
      unitPriceCents: 2450n, // $24.50
      preferredSupplierId: "supp-sysco-metro",
    },
    {
      sku: "FOOD-MILK-CASE",
      name: "Whole Milk (4 Gallon Case)",
      category: "Dairy",
      unit: "case",
      currentQuantity: 8,
      parLevel: 5,
      reorderQuantity: 6,
      unitPriceCents: 1680n, // $16.80
      preferredSupplierId: "supp-baldor-metro",
    },
    {
      sku: "FOOD-BUTTER-36LB",
      name: "European Unsalted Butter (36 lb)",
      category: "Dairy",
      unit: "case",
      currentQuantity: 2, // Low stock: below par level of 4!
      parLevel: 4,
      reorderQuantity: 4,
      unitPriceCents: 9800n, // $98.00
      preferredSupplierId: "supp-sysco-metro",
    },
    {
      sku: "FOOD-COFFEE-5LB",
      name: "Single-Origin Espresso Beans (5 lb)",
      category: "Beverage",
      unit: "bag",
      currentQuantity: 12,
      parLevel: 4,
      reorderQuantity: 8,
      unitPriceCents: 5200n, // $52.00
      preferredSupplierId: "supp-baldor-metro",
    },
  ],
  seedSuppliers: [
    {
      id: "supp-sysco-metro",
      name: "Sysco Metro Distribution (Simulated)",
      adapterType: "simulated_sysco",
      contactEmail: "orders@sysco-metro.example.com",
      isSimulated: true,
      endpointUrl: "https://api-sandbox.sysco.example.com/v1",
    },
    {
      id: "supp-baldor-metro",
      name: "Baldor Specialty Foods (Simulated)",
      adapterType: "simulated_baldor",
      contactEmail: "orders@baldor-foods.example.com",
      isSimulated: true,
      endpointUrl: "https://api-sandbox.baldorfoods.example.com/v1",
    },
  ],
};
