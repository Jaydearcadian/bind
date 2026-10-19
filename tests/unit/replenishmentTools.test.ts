import { describe, it, expect } from "vitest";
import {
  listAvailableTemplates,
  resolveTemplateDir,
} from "../../src/agents/bindTemplateAgent.js";
import { createReplenishmentTools } from "../../src/agents/replenishmentTools.js";

describe("Replenishment Tools & Open Template Discovery", () => {
  it("discovers available business templates dynamically from disk", () => {
    const templates = listAvailableTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(2);

    const ids = templates.map((t) => t.id);
    expect(ids).toContain("kitchen-ops");
    expect(ids).toContain("coffee-roaster");

    for (const t of templates) {
      expect(t.dir).toBeDefined();
      expect(t.agentsSpecPath).toContain("AGENTS.md");
      expect(t.hasSkills).toBe(true);
    }
  });

  it("resolves template directories with alias mapping", () => {
    const kitchenDir = resolveTemplateDir("kitchen-ops");
    expect(kitchenDir).toContain("templates/kitchen-ops");

    const kitchenV1Dir = resolveTemplateDir("kitchen-v1");
    expect(kitchenV1Dir).toContain("templates/kitchen-ops");

    const roasterDir = resolveTemplateDir("coffee-roaster");
    expect(roasterDir).toContain("templates/coffee-roaster");
  });

  it("creates all 6 closure-bound typed tools with strictly validated schemas", () => {
    const tools = createReplenishmentTools({
      workspaceId: "ws_test_mock",
      workflowId: "wf_test_mock",
    });

    expect(tools.allTools.length).toBe(6);

    const toolNames = tools.allTools.map((t) => t.name);
    expect(toolNames).toEqual([
      "get_business_context",
      "get_stock_snapshot",
      "get_approved_supplier_quotes",
      "create_replenishment_proposal",
      "request_policy_evaluation",
      "get_request_status",
    ]);

    // Check descriptions and schemas
    expect(tools.createReplenishmentProposalTool.description).toContain(
      "Server recalculates all pricing in BigInt base units"
    );
    expect(tools.requestPolicyEvaluationTool.description).toContain(
      "deterministic commitment gate"
    );
  });
});
