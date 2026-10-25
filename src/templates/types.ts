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

/**
 * Descriptive metadata only (docs/decisions/0083). Nothing reads these yet: they are shown in the template listing and
 * no behaviour is wired to them.
 */
export interface DataSourceDefinition {
  id: string;
  label: string;
  /** Free text, e.g. "instagram_insights". */
  kind: string;
  readOnly: true;
}

export interface TriggerDefinition {
  id: string;
  kind: "schedule" | "event" | "manual";
  description: string;
}

export interface OutputDefinition {
  id: string;
  kind: "report" | "notice" | "order";
  description: string;
}

export interface WorkspaceTemplate {
  templateId: string;
  name: string;
  description: string;
  defaultDailyLimitCents: bigint;
  defaultApprovalThresholdCents: bigint;
  roles: RoleDefinition[];
  /**
   * Optional stock module. A template with no seedInventory has no stock: it has no replenishment, and the stock write
   * route refuses it (docs/decisions/0083).
   */
  seedInventory?: InventorySeedItem[];
  /** Optional purchasing module. A template with no seedSuppliers has no supplier suggestions at onboarding. */
  seedSuppliers?: SupplierSeedItem[];
  dataSources?: DataSourceDefinition[];
  triggers?: TriggerDefinition[];
  outputs?: OutputDefinition[];
}
