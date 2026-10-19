import type { EffectSpec } from "./ledger.js";

/**
 * Test-only fault injection for runEffect.
 *
 * - before_call: thrown after the `started` row exists and before fn runs (a crash before the call).
 * - after_call_before_complete: thrown after fn resolved and before the row is marked completed (a crash
 *   after the external call; the result is lost and the row stays `started`).
 *
 * A fault fires once and then clears itself. Arming is refused unless NODE_ENV is "test", so production code
 * cannot arm it. Only runEffect reads this module's state (through takeEffectFault).
 */

export type FaultPoint = "before_call" | "after_call_before_complete";

export interface EffectFault {
  point: FaultPoint;
  match: (spec: EffectSpec) => boolean;
  error?: Error;
}

let active: EffectFault | null = null;

export function setEffectFault(fault: EffectFault | null): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Effect fault injection can only be armed when NODE_ENV is 'test'");
  }
  active = fault;
}

/** Returns the error to throw if the armed fault matches this point and spec, and disarms it. Used only by runEffect. */
export function takeEffectFault(point: FaultPoint, spec: EffectSpec): Error | null {
  const fault = active;
  if (!fault || fault.point !== point || !fault.match(spec)) return null;
  active = null;
  return fault.error ?? new Error("injected fault");
}
