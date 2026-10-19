import { EffectClass } from "./effect-classifier.js";

export enum PolicyDecision {
  ALLOW = "ALLOW",
  REQUIRE_APPROVAL = "REQUIRE_APPROVAL",
  DENY = "DENY",
}

export interface WorkspacePolicyContext {
  workspaceId: string;
}

export interface AgentRoleContext {
  roleId: string;
  workspaceId: string;
  roleName: string;
  permittedEffects: string[];
  enabled: boolean;
}

export interface EvaluationRequest {
  workspace: WorkspacePolicyContext;
  role: AgentRoleContext;
  operation: string;
}

export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  effectClass: EffectClass;
  reason: string;
  requiresApproval: boolean;
  evaluatedAt: Date;
}
