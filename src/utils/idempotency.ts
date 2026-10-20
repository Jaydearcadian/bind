import crypto from "crypto";

/**
 * Deterministically serializes an object with sorted keys. Shared by idempotency keys and the effects
 * ledger request hash (src/effects/serialize.ts), so there is one canonical form.
 */
export function canonicalStringify(obj: any): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map(canonicalStringify).join(",") + "]";
  }
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k])).join(",") + "}";
}

/**
 * Generates a collision-resistant deterministic idempotency key.
 */
export function generateIdempotencyKey(
  workspaceId: string,
  action: string,
  payload: Record<string, any>
): string {
  const canonical = canonicalStringify(payload);
  const hash = crypto
    .createHash("sha256")
    .update(`${workspaceId}:${action}:${canonical}`)
    .digest("hex");
  return `idem_${action.replace(/[^a-zA-Z0-9]/g, "_")}_${hash.slice(0, 24)}`;
}
