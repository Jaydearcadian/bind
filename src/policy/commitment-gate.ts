import { query } from "../db/client.js";
import { spendStatusesSql } from "../orders/statuses.js";
import { PolicyEngine } from "./engine.js";
import { PolicyDecision } from "./types.js";

/**
 * The single authority for a commitment of money: a binding order, quote acceptance or payment. The
 * decision is made here, in code, from database facts. The model may ask for owner review
 * (`ownerReviewRequested`) but can never grant anything. See docs/decisions/0015-single-commitment-gate.md.
 */

export type CommitmentReasonCode =
  | "ROLE_NOT_PERMITTED"
  | "SUPPLIER_NOT_VERIFIED"
  | "QUOTE_NOT_FOUND"
  | "QUOTE_EXPIRED"
  | "QUOTE_CHANGED"
  | "INVALID_AMOUNT"
  | "DAILY_LIMIT_EXCEEDED"
  | "ROLE_LIMIT_EXCEEDED"
  | "ABOVE_APPROVAL_THRESHOLD"
  | "OWNER_REVIEW_REQUESTED"
  | "AGENTS_PAUSED";

export interface CommitmentInput {
  workspaceId: string;
  workflowId: string;
  actorRole: string; // e.g. "procurement_agent"
  supplierId: string;
  quoteId: string;
  quantity: number;
  totalPriceCents: bigint; // what the caller believes it is committing to
  ownerReviewRequested?: boolean; // scorer or model escalation; can only add REQUIRE_APPROVAL
  now?: Date;
}

export interface CommitmentDecision {
  decision: PolicyDecision;
  reasonCodes: CommitmentReasonCode[];
  evidence: Record<string, unknown>; // cents as decimal strings; null where a fact was not found
}

/** Plain database facts for one decision. Every row was loaded with the caller's workspace id. */
export interface CommitmentFacts {
  workspace: {
    workspaceId: string;
    budgetDailyLimitCents: bigint;
    approvalThresholdCents: bigint;
    /** The owner's pause switch (ADR 0022). Optional so fixtures written before it still type-check: absent means not paused. */
    agentsPaused?: boolean;
  } | null;
  role: {
    id: string;
    workspaceId: string;
    roleName: string;
    enabled: boolean;
    permittedEffects: string[];
    spendingLimitCents: bigint;
  } | null;
  supplier: { workspaceId: string; verified: boolean } | null;
  quote: {
    workspaceId: string;
    supplierId: string | null;
    quantity: number;
    totalPriceCents: bigint;
    validUntil: Date;
  } | null;
  committedSpendTodayCents: bigint;
}

/** The operation whose effect class a commercial commitment must be granted. */
const COMMIT_OPERATION = "orders.submit";

/**
 * Pure decision. No I/O. Rules are evaluated in order and every denial is collected. Escalations are only
 * considered when nothing was denied, and a denial always wins over an escalation.
 */
export function decideCommitment(facts: CommitmentFacts, input: CommitmentInput): CommitmentDecision {
  const now = input.now ?? new Date();
  const workspace = facts.workspace && facts.workspace.workspaceId === input.workspaceId ? facts.workspace : null;
  const role = facts.role;
  const supplier = facts.supplier && facts.supplier.workspaceId === input.workspaceId ? facts.supplier : null;
  const quote = facts.quote && facts.quote.workspaceId === input.workspaceId ? facts.quote : null;

  const denials: CommitmentReasonCode[] = [];

  // 1. The owner's pause switch denies every commitment while it is on. An approval cannot override it.
  if (workspace?.agentsPaused === true) denials.push("AGENTS_PAUSED");

  // 2. The role must exist in this workspace, be enabled and hold commercial_commitment. A missing row is a denial.
  let roleGranted = false;
  if (!role || !workspace) {
    denials.push("ROLE_NOT_PERMITTED");
  } else {
    const grant = new PolicyEngine().evaluate({
      workspace: { workspaceId: input.workspaceId },
      role: {
        roleId: role.id,
        workspaceId: role.workspaceId,
        roleName: role.roleName,
        permittedEffects: role.permittedEffects,
        enabled: role.enabled,
      },
      operation: COMMIT_OPERATION,
    });
    roleGranted = grant.decision === PolicyDecision.ALLOW;
    if (!roleGranted) denials.push("ROLE_NOT_PERMITTED");
  }

  // 3. Supplier must exist in this workspace and be verified.
  if (!supplier || !supplier.verified) denials.push("SUPPLIER_NOT_VERIFIED");

  // 4 and 5. The quote row decides the amount. The caller's claims must match it.
  if (!quote) {
    denials.push("QUOTE_NOT_FOUND");
  } else {
    if (quote.validUntil.getTime() <= now.getTime()) denials.push("QUOTE_EXPIRED");
    if (
      quote.supplierId !== input.supplierId ||
      quote.quantity !== input.quantity ||
      quote.totalPriceCents !== input.totalPriceCents
    ) {
      denials.push("QUOTE_CHANGED");
    }
  }

  // 5b. A commitment must be for a positive amount and quantity. The quote row and the caller's claims both count.
  const invalidOnQuote = quote !== null && (quote.totalPriceCents <= 0n || quote.quantity <= 0);
  const invalidFromCaller = input.quantity <= 0 || input.totalPriceCents <= 0n;
  if (invalidOnQuote || invalidFromCaller) denials.push("INVALID_AMOUNT");

  // 6. Committed spend today plus this amount must not exceed the workspace daily limit (inclusive).
  if (workspace && quote && facts.committedSpendTodayCents + quote.totalPriceCents > workspace.budgetDailyLimitCents) {
    denials.push("DAILY_LIMIT_EXCEEDED");
  }

  const evidence: Record<string, unknown> = {
    workspaceId: input.workspaceId,
    workflowId: input.workflowId,
    actorRole: input.actorRole,
    supplierId: input.supplierId,
    quoteId: input.quoteId,
    quantity: input.quantity,
    callerTotalPriceCents: input.totalPriceCents.toString(),
    amountCents: quote ? quote.totalPriceCents.toString() : null,
    dailySpentCents: facts.committedSpendTodayCents.toString(),
    dailyLimitCents: workspace ? workspace.budgetDailyLimitCents.toString() : null,
    thresholdCents: workspace ? workspace.approvalThresholdCents.toString() : null,
    roleLimitCents: role ? role.spendingLimitCents.toString() : null,
    quoteValidUntil: quote ? quote.validUntil.toISOString() : null,
    ownerReviewRequested: input.ownerReviewRequested === true,
    agentsPaused: workspace ? workspace.agentsPaused === true : null,
  };

  if (denials.length > 0 || !roleGranted || !workspace || !quote || !role) {
    return { decision: PolicyDecision.DENY, reasonCodes: denials, evidence };
  }

  // 7. Escalations. A role limit of 0 escalates every positive amount; it is not "unlimited".
  const amount = quote.totalPriceCents;
  const escalations: CommitmentReasonCode[] = [];
  if (amount > role.spendingLimitCents) escalations.push("ROLE_LIMIT_EXCEEDED");
  if (amount > workspace.approvalThresholdCents) escalations.push("ABOVE_APPROVAL_THRESHOLD");
  if (input.ownerReviewRequested) escalations.push("OWNER_REVIEW_REQUESTED");
  if (escalations.length > 0) {
    return { decision: PolicyDecision.REQUIRE_APPROVAL, reasonCodes: escalations, evidence };
  }

  // 8. Within every limit.
  return { decision: PolicyDecision.ALLOW, reasonCodes: [], evidence };
}

/** Loads the facts for one decision from PostgreSQL, every read scoped to the caller's workspace. */
export async function loadCommitmentFacts(input: CommitmentInput): Promise<CommitmentFacts> {
  const wsRes = await query(
    `SELECT id, budget_daily_limit_cents, approval_threshold_cents, agents_paused FROM workspaces WHERE id = $1;`,
    [input.workspaceId]
  );
  const roleRes = await query(
    `SELECT id, workspace_id, role_name, enabled, permitted_effects, spending_limit_cents
     FROM agent_roles WHERE workspace_id = $1 AND role_name = $2;`,
    [input.workspaceId, input.actorRole]
  );
  const supplierRes = await query(
    `SELECT workspace_id, verified FROM suppliers WHERE workspace_id = $1 AND id = $2;`,
    [input.workspaceId, input.supplierId]
  );
  const quoteRes = await query(
    `SELECT workspace_id, supplier_id, quantity, total_price_cents, valid_until
     FROM quotes WHERE workspace_id = $1 AND id = $2;`,
    [input.workspaceId, input.quoteId]
  );
  // Spend counts orders from the spend-counting statuses today. The workflow's own order is excluded so a
  // re-check never counts the commitment it is deciding.
  const spendRes = await query(
    `SELECT COALESCE(SUM(total_price_cents), 0) AS spent
     FROM orders
     WHERE workspace_id = $1
       AND created_at >= CURRENT_DATE
       AND status IN (${spendStatusesSql()})
       AND id <> $2;`,
    [input.workspaceId, `ord_${input.workflowId}`]
  );

  const ws = wsRes.rows[0];
  const role = roleRes.rows[0];
  const supplier = supplierRes.rows[0];
  const quote = quoteRes.rows[0];
  return {
    workspace: ws
      ? {
          workspaceId: ws.id,
          budgetDailyLimitCents: BigInt(ws.budget_daily_limit_cents),
          approvalThresholdCents: BigInt(ws.approval_threshold_cents),
          agentsPaused: ws.agents_paused === true,
        }
      : null,
    role: role
      ? {
          id: role.id,
          workspaceId: role.workspace_id,
          roleName: role.role_name,
          enabled: role.enabled === true,
          permittedEffects: role.permitted_effects ?? [],
          spendingLimitCents: BigInt(role.spending_limit_cents),
        }
      : null,
    supplier: supplier ? { workspaceId: supplier.workspace_id, verified: supplier.verified === true } : null,
    quote: quote
      ? {
          workspaceId: quote.workspace_id,
          supplierId: quote.supplier_id,
          quantity: Number(quote.quantity),
          totalPriceCents: BigInt(quote.total_price_cents),
          validUntil: new Date(quote.valid_until),
        }
      : null,
    committedSpendTodayCents: BigInt(spendRes.rows[0].spent ?? 0),
  };
}

export async function authorizeCommitment(input: CommitmentInput): Promise<CommitmentDecision> {
  return decideCommitment(await loadCommitmentFacts(input), input);
}

const REASON_SENTENCE: Record<CommitmentReasonCode, string> = {
  ROLE_NOT_PERMITTED: "The agent role is missing, disabled or lacks commercial commitment permission.",
  SUPPLIER_NOT_VERIFIED: "The supplier is not verified in this workspace.",
  QUOTE_NOT_FOUND: "The quote was not found in this workspace.",
  QUOTE_EXPIRED: "The quote has expired.",
  QUOTE_CHANGED: "The proposal does not match the stored quote.",
  INVALID_AMOUNT: "The amount and quantity must both be positive.",
  DAILY_LIMIT_EXCEEDED: "",
  ROLE_LIMIT_EXCEEDED: "The amount is above the agent's per-transaction limit.",
  ABOVE_APPROVAL_THRESHOLD: "The amount is above the owner approval threshold.",
  OWNER_REVIEW_REQUESTED: "Owner review was requested.",
  AGENTS_PAUSED: "The owner has paused the agents for this workspace.",
};

function usd(cents: unknown): string {
  return `$${(Number(cents ?? 0) / 100).toFixed(2)}`;
}

/** Human-readable reason text for a decision, with the codes first. Used for workflow error messages. */
export function describeCommitmentDecision(decision: CommitmentDecision): string {
  const codes = decision.reasonCodes.join(", ");
  const sentences = decision.reasonCodes.map((code) => {
    if (code === "DAILY_LIMIT_EXCEEDED") {
      const e = decision.evidence;
      return (
        `Daily spend limit exceeded: attempting ${usd(e.amountCents)} when ` +
        `${usd(e.dailySpentCents)} of ${usd(e.dailyLimitCents)} is already committed.`
      );
    }
    return REASON_SENTENCE[code];
  });
  return `[${codes}] ${sentences.join(" ")}`;
}
