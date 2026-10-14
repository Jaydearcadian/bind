export enum EffectClass {
  READ = "read",
  EXTERNAL_REQUEST = "external_request",
  COMMERCIAL_COMMITMENT = "commercial_commitment",
}

const OPERATION_EFFECT_MAP: Record<string, EffectClass> = {
  // Reads
  "inventory.read_stock": EffectClass.READ,
  "suppliers.list": EffectClass.READ,
  "quotes.view": EffectClass.READ,
  "orders.get_status": EffectClass.READ,
  "audit.query": EffectClass.READ,
  "treasury.get_balance": EffectClass.READ,
  "workflows.get_state": EffectClass.READ,

  // External Requests (No financial or legal commitment)
  "suppliers.request_quote": EffectClass.EXTERNAL_REQUEST,
  "notifications.send_summary": EffectClass.EXTERNAL_REQUEST,
  "notifications.send_approval_request": EffectClass.EXTERNAL_REQUEST,
  "webhooks.ping": EffectClass.EXTERNAL_REQUEST,
  "suppliers.inquire_availability": EffectClass.EXTERNAL_REQUEST,
  "client.send_invoice_draft": EffectClass.EXTERNAL_REQUEST,

  // Commercial Commitments (Binding business effects, movement of money, legal agreements)
  "orders.submit": EffectClass.COMMERCIAL_COMMITMENT,
  "quotes.accept": EffectClass.COMMERCIAL_COMMITMENT,
  "settlement.transfer_usdc": EffectClass.COMMERCIAL_COMMITMENT,
  "escrow.deposit": EffectClass.COMMERCIAL_COMMITMENT,
  "escrow.release_milestone": EffectClass.COMMERCIAL_COMMITMENT,
  "contractors.payout": EffectClass.COMMERCIAL_COMMITMENT,
  "invoices.issue_and_settle": EffectClass.COMMERCIAL_COMMITMENT,
};

/**
 * Classifies an operation into its deterministic EffectClass.
 * Fails closed if the operation is unrecognized.
 */
export function classifyOperation(operationName: string): EffectClass {
  const effect = OPERATION_EFFECT_MAP[operationName];
  if (!effect) {
    throw new Error(
      `Unrecognized operation '${operationName}'. Must be explicitly declared in effect classification map.`
    );
  }
  return effect;
}

/**
 * Validates if a declared effect is permitted under the role's allowed effects.
 */
export function isEffectPermitted(
  permittedEffects: EffectClass[] | string[],
  requiredEffect: EffectClass
): boolean {
  return permittedEffects.includes(requiredEffect);
}
