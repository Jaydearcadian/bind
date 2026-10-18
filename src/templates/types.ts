import { EffectClass } from "../policy/effect-classifier.js";

export interface RoleDefinition {
  roleName: string;
  displayName: string;
  description: string;
  permittedEffects: EffectClass[];
  spendingLimitCents: bigint;
  enabled: boolean;
}

export interface InventorySeedItem {
  sku: string;
  name: string;
  category: string;
  unit: string;
  currentQuantity: number;
  parLevel: number;
  reorderQuantity: number;
  unitPriceCents: bigint;
  preferredSupplierId?: string;
}

export interface SupplierSeedItem {
  id: string;
  name: string;
  adapterType: string;
  contactEmail: string;
  isSimulated: boolean;
  endpointUrl?: string;
}

export interface WorkspaceTemplate {
  templateId: string;
  name: string;
  description: string;
  defaultDailyLimitCents: bigint;
  defaultApprovalThresholdCents: bigint;
  roles: RoleDefinition[];
  seedInventory?: InventorySeedItem[];
  seedSuppliers?: SupplierSeedItem[];
}
