/**
 * Error body v2 adds a per-request `requestId` (ADR 0047). Tests that check "these two refusals are identical" (so no tenant
 * or token existence leaks) compare the bodies without it; every other field must still match.
 */
export function withoutRequestId<T>(body: T): T {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const rest = { ...(body as Record<string, unknown>) };
  delete rest.requestId;
  return rest as T;
}

/** The JSON text of a body with the request id removed, for comparing two responses byte for byte. */
export function stableText(text: string): string {
  try {
    return JSON.stringify(withoutRequestId(JSON.parse(text)));
  } catch {
    return text;
  }
}
