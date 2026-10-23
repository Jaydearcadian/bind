/**
 * The promise decision for a customer order (Task 8a, ADR 0026). Pure: no I/O, no clock, no mutation of its inputs.
 *
 * Bind promises a time only when stock minus active reservations covers every line and a kitchen slot has room for
 * the order's units. Invalid input is refused before any other rule. An automated actor without the role or while the
 * workspace is paused is held for the owner, and nothing else is evaluated for a held order. Partial acceptance is not
 * offered: a partly covered order gets no date and no reservation.
 */

export type PromiseReason =
  | "UNKNOWN_SKU"
  | "INSUFFICIENT_STOCK"
  | "NO_CAPACITY_SLOT"
  | "INVALID_QUANTITY"
  | "ROLE_NOT_PERMITTED"
  | "AGENTS_PAUSED";

export interface PromiseReasonRef {
  code: PromiseReason;
  sku?: string;
}

export interface PromiseFacts {
  /** Keyed by sku. `onHand` is the counted quantity; `reserved` is the sum of active reservations for the sku. */
  stock: Record<string, { onHand: number; reserved: number } | undefined>;
  slots: { id: string; startsAt: Date; capacityUnits: number; usedUnits: number }[];
  /** The fulfilment role holds commercial_commitment and is enabled (decided by the caller from agent_roles). */
  roleGranted: boolean;
  agentsPaused: boolean;
}

export interface PromiseInput {
  lines: { sku: string; quantity: number }[];
  requestedFor?: Date;
  now: Date;
  /** `agent` is an automated actor. `owner` is a human decision and needs no role. */
  actor: "agent" | "owner";
}

export interface PromiseDecision {
  status: "accepted" | "partially_available" | "declined" | "needs_owner";
  reasons: PromiseReasonRef[];
  /** Only on `accepted`. */
  promisedFor?: Date;
  /** Only on `accepted`. */
  slotId?: string;
  /** Sum of the line quantities when the lines are valid, otherwise 0. */
  units: number;
}

export const MAX_LINE_QUANTITY = 10_000;
export const MAX_LINES = 50;

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

/** Invalid quantities, duplicate skus, an empty order and an oversized order. Returns the reasons (empty when valid). */
function invalidLineReasons(lines: PromiseInput["lines"]): PromiseReasonRef[] {
  if (lines.length === 0 || lines.length > MAX_LINES) return [{ code: "INVALID_QUANTITY" }];

  const reasons: PromiseReasonRef[] = [];
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const line of lines) {
    const quantityOk = Number.isInteger(line.quantity) && line.quantity >= 1 && line.quantity <= MAX_LINE_QUANTITY;
    if (!quantityOk) reasons.push({ code: "INVALID_QUANTITY", sku: line.sku });
    if (seen.has(line.sku)) duplicated.add(line.sku);
    seen.add(line.sku);
  }
  for (const sku of duplicated) reasons.push({ code: "INVALID_QUANTITY", sku });
  return reasons;
}

export function decidePromise(facts: PromiseFacts, input: PromiseInput): PromiseDecision {
  const invalid = invalidLineReasons(input.lines);
  if (invalid.length > 0) {
    return { status: "declined", reasons: invalid, units: 0 };
  }

  const units = input.lines.reduce((sum, line) => sum + line.quantity, 0);

  // A held order is decided only by the owner. The reasons are final: stock and capacity are not evaluated.
  if (input.actor === "agent") {
    const holds: PromiseReasonRef[] = [];
    if (!facts.roleGranted) holds.push({ code: "ROLE_NOT_PERMITTED" });
    if (facts.agentsPaused) holds.push({ code: "AGENTS_PAUSED" });
    if (holds.length > 0) return { status: "needs_owner", reasons: holds, units };
  }

  const shortLines: PromiseReasonRef[] = [];
  let coveredLines = 0;
  for (const line of input.lines) {
    const stock = hasOwn(facts.stock, line.sku) ? facts.stock[line.sku] : undefined;
    if (!stock) {
      shortLines.push({ code: "UNKNOWN_SKU", sku: line.sku });
    } else if (stock.onHand - stock.reserved < line.quantity) {
      shortLines.push({ code: "INSUFFICIENT_STOCK", sku: line.sku });
    } else {
      coveredLines += 1;
    }
  }

  if (coveredLines === 0) return { status: "declined", reasons: shortLines, units };
  if (coveredLines < input.lines.length) return { status: "partially_available", reasons: shortLines, units };

  // Every line is covered. The promise is the earliest slot at or after the requested time that has room for all units.
  const earliest = new Date(Math.max(input.now.getTime(), input.requestedFor?.getTime() ?? input.now.getTime()));
  const usable = facts.slots
    .filter((slot) => slot.startsAt.getTime() >= earliest.getTime() && slot.capacityUnits - slot.usedUnits >= units)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  if (usable.length === 0) return { status: "declined", reasons: [{ code: "NO_CAPACITY_SLOT" }], units };

  const slot = usable[0];
  return {
    status: "accepted",
    reasons: [],
    promisedFor: new Date(slot.startsAt.getTime()),
    slotId: slot.id,
    units,
  };
}
