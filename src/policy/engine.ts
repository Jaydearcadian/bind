import { classifyOperation, EffectClass, isEffectPermitted } from "./effect-classifier.js";
import {
  EvaluationRequest,
  PolicyDecision,
  PolicyEvaluationResult,
} from "./types.js";

export { PolicyDecision };

export class PolicyEngine {
  /**
   * Deterministically evaluates an operation against workspace constraints and role grants.
   * Completely decoupled from any LLM prompt or unverified assertion.
   */
  evaluate(req: EvaluationRequest): PolicyEvaluationResult {
    const evaluatedAt = new Date();

    // 1. Tenancy Integrity: Role must belong to the workspace
    if (req.role.workspaceId !== req.workspace.workspaceId) {
      return {
        decision: PolicyDecision.DENY,
        effectClass: EffectClass.READ,
        reason: `Workspace tenant mismatch: role workspace (${req.role.workspaceId}) does not match request workspace (${req.workspace.workspaceId}).`,
        requiresApproval: false,
        evaluatedAt,
      };
    }

    // 2. Role Status Check: Must be enabled
    if (!req.role.enabled) {
      return {
        decision: PolicyDecision.DENY,
        effectClass: EffectClass.READ,
        reason: `Role is disabled for workspace ${req.workspace.workspaceId}.`,
        requiresApproval: false,
        evaluatedAt,
      };
    }

    // 3. Effect Classification Check
    const effectClass = classifyOperation(req.operation);
    if (!isEffectPermitted(req.role.permittedEffects, effectClass)) {
      return {
        decision: PolicyDecision.DENY,
        effectClass,
        reason: `Effect '${effectClass}' not permitted for role '${req.role.roleName}'.`,
        requiresApproval: false,
        evaluatedAt,
      };
    }

    // Read and External Request operations that are permitted by role grants are allowed
    if (effectClass === EffectClass.READ || effectClass === EffectClass.EXTERNAL_REQUEST) {
      return {
        decision: PolicyDecision.ALLOW,
        effectClass,
        reason: `Operation '${req.operation}' classified as '${effectClass}' and permitted for role.`,
        requiresApproval: false,
        evaluatedAt,
      };
    }

    // 4. Commercial Commitment Guards
    const amount = req.amountCents ?? 0n;

    // Allowed supplier check
    if (req.supplierId && req.workspace.allowedSuppliers && req.workspace.allowedSuppliers.length > 0) {
      if (!req.workspace.allowedSuppliers.includes(req.supplierId)) {
        return {
          decision: PolicyDecision.DENY,
          effectClass,
          reason: `Supplier '${req.supplierId}' is not in allowed list for workspace ${req.workspace.workspaceId}.`,
          requiresApproval: false,
          evaluatedAt,
        };
      }
    }

    // Single-transaction spending limit
    if (amount > req.role.spendingLimitCents) {
      return {
        decision: PolicyDecision.DENY,
        effectClass,
        reason: `Amount ($${(Number(amount) / 100).toFixed(2)}) exceeds role spending limit ($${(Number(req.role.spendingLimitCents) / 100).toFixed(2)}).`,
        requiresApproval: false,
        evaluatedAt,
      };
    }

    // Daily budget limit check
    if (req.workspace.dailySpentCents + amount > req.workspace.budgetDailyLimitCents) {
      return {
        decision: PolicyDecision.DENY,
        effectClass,
        reason: `Amount ($${(Number(amount) / 100).toFixed(2)}) exceeds workspace daily budget limit ($${(Number(req.workspace.budgetDailyLimitCents) / 100).toFixed(2)}). Current daily spent: $${(Number(req.workspace.dailySpentCents) / 100).toFixed(2)}.`,
        requiresApproval: false,
        evaluatedAt,
      };
    }

    // Approval threshold check
    if (amount > req.workspace.approvalThresholdCents) {
      return {
        decision: PolicyDecision.REQUIRE_APPROVAL,
        effectClass,
        reason: `Amount ($${(Number(amount) / 100).toFixed(2)}) exceeds automatic approval threshold ($${(Number(req.workspace.approvalThresholdCents) / 100).toFixed(2)}). Human owner approval required.`,
        requiresApproval: true,
        evaluatedAt,
      };
    }

    // Authorized
    return {
      decision: PolicyDecision.ALLOW,
      effectClass,
      reason: `Operation '${req.operation}' is fully authorized within limits.`,
      requiresApproval: false,
      evaluatedAt,
    };
  }
}
