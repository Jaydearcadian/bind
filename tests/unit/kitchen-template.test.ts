import { describe, it, expect } from "vitest";
import { kitchenTemplate } from "../../src/templates/kitchen-v1.js";
import { agencyTemplate } from "../../src/templates/agency-v1.js";
import { EffectClass } from "../../src/policy/effect-classifier.js";
import { getTemplate, listTemplates } from "../../src/templates/registry.js";

describe("Workspace Templates (Kitchen & Agency)", () => {
  it("registers both kitchen-v1 and agency-v1 templates", () => {
    const templates = listTemplates();
    expect(templates.length).toBe(2);
    expect(getTemplate("kitchen-v1")).toBeDefined();
    expect(getTemplate("agency-v1")).toBeDefined();
  });

  describe("Kitchen Vertical Slice Specification (kitchen-v1)", () => {
    it("provisions the exact 3 coordinated roles defined in BIND_BUILD_SPEC.md", () => {
      const roleNames = kitchenTemplate.roles.map((r) => r.roleName);
      expect(roleNames).toEqual([
        "procurement_agent",
        "fulfilment_agent",
        "menu_feedback_agent",
      ]);
    });

    it("restricts commercial_commitment strictly to procurement_agent", () => {
      const procurement = kitchenTemplate.roles.find((r) => r.roleName === "procurement_agent")!;
      const fulfilment = kitchenTemplate.roles.find((r) => r.roleName === "fulfilment_agent")!;
      const menu = kitchenTemplate.roles.find((r) => r.roleName === "menu_feedback_agent")!;

      expect(procurement.permittedEffects).toContain(EffectClass.COMMERCIAL_COMMITMENT);
      expect(fulfilment.permittedEffects).not.toContain(EffectClass.COMMERCIAL_COMMITMENT);
      expect(menu.permittedEffects).not.toContain(EffectClass.COMMERCIAL_COMMITMENT);
    });

    it("contains seed inventory items with low-stock states ready for replenishment trigger", () => {
      const flour = (kitchenTemplate.seedInventory || []).find((i) => i.sku === "FOOD-FLOUR-50LB")!;
      const butter = (kitchenTemplate.seedInventory || []).find((i) => i.sku === "FOOD-BUTTER-36LB")!;

      expect(flour).toBeDefined();
      expect(flour.currentQuantity).toBeLessThan(flour.parLevel); // 3 < 6 -> Low stock!

      expect(butter).toBeDefined();
      expect(butter.currentQuantity).toBeLessThan(butter.parLevel); // 2 < 4 -> Low stock!
    });

    it("clearly labels simulated supplier adapters", () => {
      expect(kitchenTemplate.seedSuppliers?.every((s) => s.isSimulated === true)).toBe(true);
      expect(kitchenTemplate.seedSuppliers?.some((s) => s.name.includes("(Simulated)"))).toBe(true);
    });
  });

  describe("Digital Agency Specification (agency-v1)", () => {
    it("provisions the 3 contractor and cloud billing roles", () => {
      const roleNames = agencyTemplate.roles.map((r) => r.roleName);
      expect(roleNames).toEqual([
        "contractor_ops_agent",
        "billing_credits_agent",
        "client_invoicing_agent",
      ]);
    });
  });
});
