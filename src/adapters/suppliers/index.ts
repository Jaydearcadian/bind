import { SupplierAdapter } from "./types.js";
import { SimulatedSupplierAdapter } from "./simulated.js";

const adapters = new Map<string, SupplierAdapter>();

// Seed default supplier adapters
adapters.set(
  "supp-sysco-metro",
  new SimulatedSupplierAdapter("supp-sysco-metro", "Sysco Metro Distribution", 1.0)
);
adapters.set(
  "supp-baldor-metro",
  new SimulatedSupplierAdapter("supp-baldor-metro", "Baldor Specialty Foods", 1.05) // Baldor is 5% premium
);
adapters.set(
  "supp-contractor-alex",
  new SimulatedSupplierAdapter("supp-contractor-alex", "Alex Dev Engineering", 1.0)
);
adapters.set(
  "supp-parallel-web",
  new SimulatedSupplierAdapter("supp-parallel-web", "Parallel AI Task API", 1.0)
);

export function getSupplierAdapter(supplierId: string): SupplierAdapter {
  const cleanId = supplierId.includes("_") ? supplierId.split("_").slice(1).join("_") : supplierId;
  const adapter = adapters.get(cleanId) || adapters.get(supplierId);
  if (!adapter) {
    // Default to a generic simulated adapter
    const generic = new SimulatedSupplierAdapter(supplierId, `Supplier ${supplierId}`, 1.0);
    adapters.set(supplierId, generic);
    return generic;
  }
  return adapter;
}
