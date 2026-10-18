import { describe, it, expect } from "vitest";
import { PolicyEngine, PolicyDecision } from "../../src/policy/engine.js";
import { EffectClass } from "../../src/policy/effect-classifier.js";
import { WorkspacePolicyContext, AgentRoleContext, EvaluationRequest } from "../../src/policy/types.js";

describe("Deterministic Policy Evaluation Engine", () => {
  const workspace: WorkspacePolicyContext = {
    workspaceId: "ws-kitchen-01",
    budgetDailyLimitCents: 100000n, // $1,000.00
    approvalThresholdCents: 25000n,  // $250.00
    dailySpentCents: 0n,
    allowedSuppliers: ["supplier-sysco", "supplier-baldor"],
  };

  const procurementRole: AgentRoleContext = {
    roleId: "role-procurement",
    workspaceId: "ws-kitchen-01",
    roleName: "procurement_agent",
    permittedEffects: [EffectClass.READ, EffectClass.EXTERNAL_REQUEST, EffectClass.COMMERCIAL_COMMITMENT],
    spendingLimitCents: 50000n, // $500.00 per transaction
    enabled: true,
  };

  const menuRole: AgentRoleContext = {
    roleId: "role-menu",
    workspaceId: "ws-kitchen-01",
    roleName: "menu_feedback_agent",
    permittedEffects: [EffectClass.READ, EffectClass.EXTERNAL_REQUEST], // Cannot commit funds
    spendingLimitCents: 0n,
    enabled: true,
  };

  it("ALLOWS read operations for authorized roles", () => {
    const engine = new PolicyEngine();
    const req: EvaluationRequest = {
      workspace,
      role: procurementRole,
      operation: "inventory.read_stock",
      amountCents: 0n,
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
      amountCents: 0n,
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
      amountCents: 0n,
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
      amountCents: 10000n, // $100.00
      supplierId: "supplier-sysco",
    };

    const decision = engine.evaluate(req);
    expect(decision.decision).toBe(PolicyDecision.DENY);
    expect(decision.reason).toMatch(/Effect 'commercial_commitment' not permitted for role/i);
  });

  it("ALLOWS commercial commitment when amount is below approval threshold and within limits", () => {
    const engine = new PolicyEngine();
    const req: EvaluationRequest = {
      workspace,
      role: procurementRole,
      operation: "orders.submit",
      amountCents: 15000n, // $150.00 (below $250.00 threshold)
      supplierId: "supplier-sysco",
    };

    const decision = engine.evaluate(req);
    expect(decision.decision).toBe(PolicyDecision.ALLOW);
  });

  it("REQUIRES APPROVAL when commercial commitment exceeds the approval threshold ($250)", () => {
    const engine = new PolicyEngine();
    const req: EvaluationRequest = {
      workspace,
      role: procurementRole,
      operation: "orders.submit",
      amountCents: 35000n, // $350.00 (exceeds $250.00 approval threshold, under $500.00 limit)
      supplierId: "supplier-sysco",
    };

    const decision = engine.evaluate(req);
    expect(decision.decision).toBe(PolicyDecision.REQUIRE_APPROVAL);
    expect(decision.reason).toMatch(/Exceeds automatic approval threshold/i);
  });

  it("DENIES commercial commitment when amount exceeds role single-transaction spending limit ($500)", () => {
    const engine = new PolicyEngine();
    const req: EvaluationRequest = {
      workspace,
      role: procurementRole,
      operation: "orders.submit",
      amountCents: 60000n, // $600.00 (exceeds $500.00 role limit)
      supplierId: "supplier-sysco",
    };

    const decision = engine.evaluate(req);
    expect(decision.decision).toBe(PolicyDecision.DENY);
    expect(decision.reason).toMatch(/Exceeds role spending limit/i);
  });

  it("DENIES commercial commitment when daily workspace budget would be exceeded", () => {
    const engine = new PolicyEngine();
    const maxedWorkspace: WorkspacePolicyContext = {
      ...workspace,
      dailySpentCents: 90000n, // already spent $900 today
    };

    const req: EvaluationRequest = {
      workspace: maxedWorkspace,
      role: procurementRole,
      operation: "orders.submit",
      amountCents: 15000n, // $150.00 -> 900 + 150 = 1050 > 1000 daily budget
      supplierId: "supplier-sysco",
    };

    const decision = engine.evaluate(req);
    expect(decision.decision).toBe(PolicyDecision.DENY);
    expect(decision.reason).toMatch(/Exceeds workspace daily budget limit/i);
  });

  it("DENIES commitment if supplier is not in allowed list", () => {
    const engine = new PolicyEngine();
    const req: EvaluationRequest = {
      workspace,
      role: procurementRole,
      operation: "orders.submit",
      amountCents: 5000n,
      supplierId: "unverified-sketchy-vendor",
    };

    const decision = engine.evaluate(req);
    expect(decision.decision).toBe(PolicyDecision.DENY);
    expect(decision.reason).toMatch(/Supplier 'unverified-sketchy-vendor' is not in allowed list/i);
  });
});
