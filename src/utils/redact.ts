import { config } from "../config/env.js";

/**
 * The one redaction module (ADR 0024). Every place that writes text or evidence out of the process (stored error
 * messages, audit evidence, workflow evidence, errors that reach a model or a route) goes through here.
 *
 * Pure except for reading configuration at call time, so a secret set in the environment is always known.
 */

const REDACTED = "[redacted]";
const REDACTED_TOKEN = "[redacted-token]";
const REDACTED_URL = "[redacted-url]";
const REDACTED_KEY = "[REDACTED]";
const MAX_DEPTH = 8;

/** Configured secrets shorter than this are not used as redaction patterns: a short value would hide ordinary text. */
const MIN_CONFIGURED_SECRET_LENGTH = 8;

/** Environment variables whose values are secrets, or contain one. Read at call time. */
const CONFIGURED_SECRET_NAMES = [
  "ARC_SIGNER_PRIVATE_KEY",
  "PARALLEL_API_KEY",
  "NEBIUS_API_KEY",
  "GEMINI_API_KEY",
  "LANGSMITH_API_KEY",
  "SESSION_SECRET",
  "BIND_MASTER_SECRET",
  "BIND_WEBHOOK_SECRET",
  "BIND_CREDENTIAL_KEY",
  "BIND_CREDENTIAL_KEY_PREVIOUS",
  "DATABASE_URL",
  "RPC_URL",
  "ARC_RPC_URL",
] as const;

/** Connection strings whose password is also a secret on its own (a driver error can print the password alone). */
const URL_CONFIG_NAMES = ["DATABASE_URL", "RPC_URL", "ARC_RPC_URL"] as const;

/** A workspace token: `bnd_` and 43 base64url characters (ADR 0021). Longer runs are redacted whole. */
const WORKSPACE_TOKEN = /bnd_[A-Za-z0-9_-]{43,}/g;
const BEARER = /(\bBearer\s+)[^\s"',;<>)]+/gi;
/** A private key assigned to a label: the 0x value is redacted, the label stays. A bare transaction hash is not matched. */
const PRIVATE_KEY_ASSIGNMENT = /(private[ _-]?key["']?\s*[=:]\s*["']?)0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/gi;
/** Any URL-like text, for the error paths that replace every URL. */
const ANY_URL = /\b(?:https?|wss?|postgres(?:ql)?|redis|mysql|mongodb(?:\+srv)?):\/\/[^\s"'<>)]+/gi;
/** A query parameter whose value is a credential. Matches `key`, `api_key`, `x-api-key`, `access_token` and the like. */
const SENSITIVE_PARAM = /(?:^|[_-])(?:key|api_?key|apikey|token|secret|sig|signature|password)$/i;
/** A path segment that looks like an opaque endpoint key (an RPC path token). */
const OPAQUE_SEGMENT = /^[A-Za-z0-9_-]{20,}$/;

/** Words that, as the last word of a key, name a secret: `token`, `clientSecret`, `PASSWORD`. */
const SECRET_KEY_LAST_WORDS = new Set([
  "secret",
  "token",
  "password",
  "passphrase",
  "credential",
  "credentials",
  "authorization",
  "cookie",
]);
/** Two-word endings that name a secret: `apiKey`, `private_key`, `auth-token`. `keyId` and `publicKey` are not among them. */
const SECRET_KEY_ENDINGS = new Set(["api key", "private key", "secret key", "access key", "auth token", "signing key"]);

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "[unrenderable]";
  }
}

/** The configured secrets, longest first, without duplicates. Read at call time. */
function configuredSecrets(): string[] {
  const found = new Set<string>();
  for (const name of CONFIGURED_SECRET_NAMES) {
    const value: unknown = config[name];
    if (typeof value === "string" && value.length >= MIN_CONFIGURED_SECRET_LENGTH) found.add(value);
  }
  for (const name of URL_CONFIG_NAMES) {
    const value: unknown = config[name];
    if (typeof value !== "string") continue;
    try {
      const password = decodeURIComponent(new URL(value).password);
      if (password.length >= MIN_CONFIGURED_SECRET_LENGTH) found.add(password);
    } catch {
      // Not a URL: the whole value is already a configured secret above.
    }
  }
  return [...found].sort((a, b) => b.length - a.length);
}

/** Replaces each URL that carries credentials, a credential parameter or an opaque endpoint key. Other URLs stay. */
function scrubUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return REDACTED_URL;
  }
  if (url.username || url.password) return REDACTED_URL;
  for (const name of url.searchParams.keys()) {
    if (SENSITIVE_PARAM.test(name)) return REDACTED_URL;
  }
  for (const segment of url.pathname.split("/")) {
    if (OPAQUE_SEGMENT.test(segment)) return REDACTED_URL;
  }
  return raw;
}

/**
 * Redacts text: every known secret, workspace tokens, bearer values, private key assignments, and URLs that carry
 * credentials. `extraSecrets` are replaced wherever they occur, whatever their length. Configured secrets of at least
 * eight characters are replaced too. A transaction hash and a plain URL are kept (they are evidence). Never throws.
 */
export function redactText(text: string, extraSecrets: readonly string[] = []): string {
  try {
    let out = safeString(text);
    const extras = extraSecrets.filter((s): s is string => typeof s === "string" && s.length > 0);
    const secrets = [...new Set([...extras, ...configuredSecrets()])].sort((a, b) => b.length - a.length);
    for (const secret of secrets) {
      out = out.split(secret).join(REDACTED);
    }
    out = out.replace(WORKSPACE_TOKEN, REDACTED_TOKEN);
    out = out.replace(BEARER, (_match, prefix: string) => `${prefix}[redacted]`);
    out = out.replace(PRIVATE_KEY_ASSIGNMENT, (_match, label: string) => `${label}${REDACTED}`);
    out = out.replace(ANY_URL, (raw) => scrubUrl(raw));
    return out;
  } catch {
    return "[redaction failed]";
  }
}

/**
 * Replaces every URL, whether or not it carries a credential. Error messages use it: an RPC or supplier error can print
 * an endpoint whose path is the credential, which no pattern can recognise. Then redactText applies.
 */
export function redactUrls(text: string): string {
  return safeString(text).replace(ANY_URL, REDACTED_URL);
}

/**
 * True when a key names a secret. The key is split into words (camelCase, snake_case, kebab-case, spaces). The last word
 * is one of the secret words, or the last two words are a secret ending. `idempotencyKey`, `publicKey`, `keyId`,
 * `tokenId`, `txHash`, `matchHash` and `orderId` do not name a secret.
 */
export function keyNamesSecret(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_\-.]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return false;
  if (SECRET_KEY_LAST_WORDS.has(words[words.length - 1])) return true;
  return words.length >= 2 && SECRET_KEY_ENDINGS.has(words.slice(-2).join(" "));
}

/**
 * A copy of a value with every string redacted, and the value of every secret-named key replaced by "[REDACTED]".
 * Walks objects and arrays, cycle-safe, and stops at depth 8. The input is not changed. Never throws.
 */
export function redactDeep<T>(value: T, extraSecrets: readonly string[] = []): T {
  try {
    return walk(value, 0, new Set<object>(), extraSecrets) as T;
  } catch {
    return "[redaction failed]" as unknown as T;
  }
}

function walk(value: unknown, depth: number, ancestors: Set<object>, extras: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, extras);
  if (typeof value === "function") return "[function]";
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) return "[circular]";
  if (depth >= MAX_DEPTH) return "[depth limit]";
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Uint8Array) return "[binary]";
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message, extras) };
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1, ancestors, extras));
    if (value instanceof Map) return walk(Array.from(value.entries()), depth, ancestors, extras);
    if (value instanceof Set) return walk(Array.from(value.values()), depth, ancestors, extras);

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const replaced = keyNamesSecret(key) && item !== null && item !== undefined;
      Object.defineProperty(out, key, {
        value: replaced ? REDACTED_KEY : walk(item, depth + 1, ancestors, extras),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}
