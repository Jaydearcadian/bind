import { classifyOperation, EffectClass, isEffectPermitted } from "./effect-classifier.js";
import {
  EvaluationRequest,
  PolicyDecision,
  PolicyEvaluationResult,
} from "./types.js";

export { PolicyDecision };

/**
 * First stage of the commitment gate (see commitment-gate.ts): tenancy, role status and the role's effect
 * grant. Amounts, suppliers, quotes and limits are decided by the gate, which calls this for the role stage.
 */
export class PolicyEngine {
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

    return {
      decision: PolicyDecision.ALLOW,
      effectClass,
      reason: `Operation '${req.operation}' is granted to role '${req.role.roleName}'.`,
      requiresApproval: false,
      evaluatedAt,
    };
  }
}
