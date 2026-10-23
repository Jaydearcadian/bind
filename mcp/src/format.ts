/**
 * The tool results (docs/decisions/0037): one text item holding JSON. A success is wrapped as untrusted data, with the paths of
 * the free text it carries. An error carries only the fields the API documents, never the token, a header or a URL.
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BindApiError } from "../../sdk/src/index.js";
import { redactText } from "./logger.js";

export const MAX_ARRAY_ITEMS = 100;
export const MAX_STRING_CHARS = 2000;
const MAX_MESSAGE_CHARS = 500;

export const SOURCE = "bind-api";

/** One value that was cut: an array kept to MAX_ARRAY_ITEMS, or a string kept to MAX_STRING_CHARS. */
export type Truncation = { path: string; kept: number; total: number } | { path: string; kept: number; length: number };

interface Cut {
  value: unknown;
  truncations: Truncation[];
}

/** Cuts arrays and strings to the caps, and records each cut with its path. Objects are kept whole, key by key. */
export function truncateValue(value: unknown, path: string, out: Truncation[] = []): unknown {
  if (typeof value === "string") {
    const chars = Array.from(value);
    if (chars.length <= MAX_STRING_CHARS) return value;
    out.push({ path, kept: MAX_STRING_CHARS, length: chars.length });
    return chars.slice(0, MAX_STRING_CHARS).join("");
  }
  if (Array.isArray(value)) {
    const kept = value.length > MAX_ARRAY_ITEMS ? value.slice(0, MAX_ARRAY_ITEMS) : value;
    if (value.length > MAX_ARRAY_ITEMS) out.push({ path, kept: MAX_ARRAY_ITEMS, total: value.length });
    return kept.map((item, index) => truncateValue(item, `${path}[${index}]`, out));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = truncateValue(item, `${path}.${key}`, out);
    }
    return result;
  }
  return value;
}

/** Truncates a value and returns the cut value with its list of cuts. */
export function cut(value: unknown, path = "data"): Cut {
  const truncations: Truncation[] = [];
  const truncated = truncateValue(value, path, truncations);
  return { value: truncated, truncations };
}

/** Replaces the configured secrets and any `bnd_` value in a text. */
function scrub(text: string, secrets: readonly string[]): string {
  return redactText(text, secrets);
}

function asText(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export interface SuccessInput {
  workspaceId: string;
  untrustedTextFields: readonly string[];
  data: unknown;
  secrets: readonly string[];
}

/** A successful result: the API's answer as data, with the paths of its free text listed. */
export function successResult(input: SuccessInput): CallToolResult {
  const { value, truncations } = cut(input.data);
  const envelope: Record<string, unknown> = {
    source: SOURCE,
    workspaceId: input.workspaceId,
    untrustedTextFields: [...input.untrustedTextFields],
    data: value,
  };
  if (truncations.length > 0) {
    envelope.truncated = true;
    envelope.truncatedPaths = truncations;
  }
  const result = asText(envelope);
  const first = result.content[0];
  if (first.type === "text") first.text = scrub(first.text, input.secrets);
  return result;
}

function errorResult(error: Record<string, unknown>, secrets: readonly string[]): CallToolResult {
  const result = asText({ source: SOURCE, error });
  const first = result.content[0];
  if (first.type === "text") first.text = scrub(first.text, secrets);
  return { ...result, isError: true };
}

/** A BindApiError: its status, code, message, request id and reason codes, and nothing else. */
export function apiErrorResult(error: BindApiError, secrets: readonly string[]): CallToolResult {
  const message = scrub(error.message, secrets).slice(0, MAX_MESSAGE_CHARS);
  return errorResult(
    {
      status: error.status,
      code: error.code ?? null,
      message,
      requestId: error.requestId ?? null,
      reasonCodes: error.reasonCodes ?? null,
    },
    secrets
  );
}

/** The API did not answer in time, or could not be reached. The cause is not repeated: a URL may be in it. */
export function unreachableResult(secrets: readonly string[]): CallToolResult {
  return errorResult({ message: "Bind API unreachable" }, secrets);
}

/** Any other failure of a call. Its message is not repeated, because a failure can carry any text. */
export function genericFailureResult(secrets: readonly string[]): CallToolResult {
  return errorResult({ message: "The Bind API call failed" }, secrets);
}
