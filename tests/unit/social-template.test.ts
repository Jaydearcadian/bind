import { describe, it, expect } from "vitest";
import { socialTemplate } from "../../src/templates/social-v1.js";
import { EffectClass } from "../../src/policy/effect-classifier.js";
import {
  getTemplate,
  listTemplates,
  refusesStock,
  templateHasStock,
  templateHasSuppliers,
} from "../../src/templates/registry.js";
import { kitchenTemplate } from "../../src/templates/kitchen-v1.js";
import { agencyTemplate } from "../../src/templates/agency-v1.js";

describe("Social media manager template (social-v1, docs/decisions/0083)", () => {
  it("is registered and listed alongside the kitchen and agency templates", () => {
    expect(getTemplate("social-v1")).toBe(socialTemplate);
    expect(listTemplates().map((t) => t.templateId).sort()).toEqual(["agency-v1", "kitchen-v1", "social-v1"]);
    expect(socialTemplate.name).toBe("Social media manager");
  });

  it("has three roles with the expected names", () => {
    expect(socialTemplate.roles.map((r) => r.roleName)).toEqual([
      "analytics_agent",
      "reporting_agent",
      "content_planner_agent",
    ]);
  });

  it("never permits a commercial commitment, in any role", () => {
    for (const role of socialTemplate.roles) {
      expect(role.permittedEffects).not.toContain(EffectClass.COMMERCIAL_COMMITMENT);
    }
    // Serialised too, so no commitment effect can hide in a nested field.
    const serialised = JSON.stringify(socialTemplate, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    expect(serialised).not.toContain("commercial_commitment");
  });

  it("limits every role to read and external request, with no spending authority", () => {
    for (const role of socialTemplate.roles) {
      expect(role.spendingLimitCents).toBe(0n);
      for (const effect of role.permittedEffects) {
        expect([EffectClass.READ, EffectClass.EXTERNAL_REQUEST]).toContain(effect);
      }
    }
    const planner = socialTemplate.roles.find((r) => r.roleName === "content_planner_agent")!;
    expect(planner.permittedEffects).toEqual([EffectClass.READ]);
  });

  it("moves no money by default", () => {
    expect(socialTemplate.defaultDailyLimitCents).toBe(0n);
    expect(socialTemplate.defaultApprovalThresholdCents).toBe(0n);
  });

  it("has no stock and no supplier module", () => {
    expect(socialTemplate.seedInventory).toBeUndefined();
    expect(socialTemplate.seedSuppliers).toBeUndefined();
    expect(templateHasStock(socialTemplate)).toBe(false);
    expect(templateHasSuppliers(socialTemplate)).toBe(false);
    expect(refusesStock("social-v1")).toBe(true);
  });

  it("declares only read-only data sources, and says so in the description", () => {
    expect(socialTemplate.dataSources).toEqual([
      { id: "instagram_insights", label: "Instagram post insights", kind: "instagram_insights", readOnly: true },
    ]);
    expect(socialTemplate.description).toMatch(/never posts, runs ads or replies/);
    expect(socialTemplate.description).toMatch(/separately approved capability/);
  });

  it("declares the weekly report and post-published triggers, and a report output only", () => {
    expect(socialTemplate.triggers?.map((t) => [t.id, t.kind])).toEqual([
      ["weekly_report", "schedule"],
      ["post_published", "event"],
    ]);
    expect(socialTemplate.outputs?.map((o) => [o.id, o.kind])).toEqual([["weekly_report", "report"]]);
  });

  it("does not change the kitchen or agency stock and supplier modules", () => {
    expect(templateHasStock(kitchenTemplate)).toBe(true);
    expect(templateHasSuppliers(kitchenTemplate)).toBe(true);
    expect(templateHasStock(agencyTemplate)).toBe(true);
    expect(templateHasSuppliers(agencyTemplate)).toBe(true);
    expect(refusesStock("kitchen-v1")).toBe(false);
    expect(refusesStock("agency-v1")).toBe(false);
  });

  it("does not refuse a blank workspace whose template_id names no template", () => {
    expect(refusesStock("ws-blank-onboarded-1")).toBe(false);
    expect(refusesStock("")).toBe(false);
    expect(refusesStock(null)).toBe(false);
    expect(refusesStock(undefined)).toBe(false);
  });
});
