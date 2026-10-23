import { describe, it, expect } from "vitest";
import { PolicyEngine, PolicyDecision } from "../../src/policy/engine.js";
import { EffectClass } from "../../src/policy/effect-classifier.js";
import { WorkspacePolicyContext, AgentRoleContext, EvaluationRequest } from "../../src/policy/types.js";

/**
 * PolicyEngine is the role stage of the commitment gate: tenancy, role status and effect grants.
 * Amount, supplier, quote and limit rules are tested in commitment-gate.test.ts.
 */
describe("Deterministic Policy Evaluation Engine: role stage", () => {
  const workspace: WorkspacePolicyContext = {
    workspaceId: "ws-kitchen-01",
  };

  const procurementRole: AgentRoleContext = {
    roleId: "role-procurement",
    workspaceId: "ws-kitchen-01",
    roleName: "procurement_agent",
    permittedEffects: [EffectClass.READ, EffectClass.EXTERNAL_REQUEST, EffectClass.COMMERCIAL_COMMITMENT],
    enabled: true,
  };

  const menuRole: AgentRoleContext = {
    roleId: "role-menu",
    workspaceId: "ws-kitchen-01",
    roleName: "menu_feedback_agent",
    permittedEffects: [EffectClass.READ, EffectClass.EXTERNAL_REQUEST], // Cannot commit funds
    enabled: true,
  };

  it("ALLOWS read operations for authorized roles", () => {
    const engine = new PolicyEngine();
    const req: EvaluationRequest = {
      workspace,
      role: procurementRole,
      operation: "inventory.read_stock",
    };

    const decision = engine.evaluate(req);
    expect(decision.decision).toBe(PolicyDecision.ALLOW);
  });

  it("DENIES cross-tenant execution if role does not belong to workspace", () => {
    const engine = new PolicyEngine();
    const attackerRole: AgentRoleContext = {
      ...procurementRole,
      workspaceId: "other-workspace-attacker",
    };

    const req: EvaluationRequest = {
      workspace,
      role: attackerRole,
      operation: "inventory.read_stock",
    };

    const decision = engine.evaluate(req);
    expect(decision.decision).toBe(PolicyDecision.DENY);
    expect(decision.reason).toMatch(/Workspace tenant mismatch/i);
  });

  it("DENIES execution if role is disabled", () => {
    const engine = new PolicyEngine();
    const disabledRole: AgentRoleContext = {
      ...procurementRole,
      enabled: false,
    };

    const req: EvaluationRequest = {
      workspace,
      role: disabledRole,
      operation: "inventory.read_stock",
    };

    const decision = engine.evaluate(req);
    expect(decision.decision).toBe(PolicyDecision.DENY);
    expect(decision.reason).toMatch(/Role is disabled/i);
  });

  it("DENIES commercial commitment if role lacks commercial_commitment permission", () => {
    const engine = new PolicyEngine();
    const req: EvaluationRequest = {
      workspace,
      role: menuRole, // Menu agent only has read & external_request
      operation: "orders.submit",
    };

    const decision = engine.evaluate(req);
    expect(decision.decision).toBe(PolicyDecision.DENY);
    expect(decision.reason).toMatch(/Effect 'commercial_commitment' not permitted for role/i);
  });

  it("GRANTS commercial commitment to a role that holds the effect (limits are the gate's job)", () => {
    const engine = new PolicyEngine();
    const req: EvaluationRequest = {
      workspace,
      role: procurementRole,
      operation: "orders.submit",
    };

    const decision = engine.evaluate(req);
    expect(decision.decision).toBe(PolicyDecision.ALLOW);
    expect(decision.effectClass).toBe(EffectClass.COMMERCIAL_COMMITMENT);
  });
});
