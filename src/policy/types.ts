import { EffectClass } from "./effect-classifier.js";

export enum PolicyDecision {
  ALLOW = "ALLOW",
  REQUIRE_APPROVAL = "REQUIRE_APPROVAL",
  DENY = "DENY",
}

export interface WorkspacePolicyContext {
  workspaceId: string;
  budgetDailyLimitCents: bigint;
  approvalThresholdCents: bigint;
  dailySpentCents: bigint;
  allowedSuppliers?: string[];
}

export interface AgentRoleContext {
  roleId: string;
  workspaceId: string;
  roleName: string;
  permittedEffects: EffectClass[];
  spendingLimitCents: bigint;
  enabled: boolean;
}

export interface EvaluationRequest {
  workspace: WorkspacePolicyContext;
  role: AgentRoleContext;
  operation: string;
  amountCents?: bigint;
  supplierId?: string;
}

export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  effectClass: EffectClass;
  reason: string;
  requiresApproval: boolean;
  evaluatedAt: Date;
}
