import dotenv from "dotenv";
import { z } from "zod";

// Load .env.local first if present, otherwise .env
dotenv.config({ path: ".env.local" });
dotenv.config();

/** An optional secret: unset or empty is undefined; otherwise at least 32 characters. The value is never logged. */
function optionalSecret(name: string) {
  return z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().min(32, `${name} must be at least 32 characters when set`).optional()
  );
}

/**
 * The bytes of a credential key: base64 of exactly 32 bytes (AES-256), or null. Never throws and never reports the value.
 * An empty string is handled by the caller as unset.
 */
export function credentialKeyBytes(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 ? bytes : null;
}

/** An optional credential key (ADR 0024). Unset or empty is undefined; otherwise base64 of exactly 32 bytes. */
function optionalCredentialKey(name: string) {
  return z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .refine((v) => credentialKeyBytes(v) !== null, `${name} must be base64 of exactly 32 bytes`)
      .optional()
  );
}

/**
 * A base URL that may carry a secret or a message: the email provider's API base and the app link base (ADR 0074). It must
 * be https. The one exception is 127.0.0.1 or localhost outside production, which tests use for a local fake provider.
 * Userinfo is refused. Never throws, and never reports the value.
 */
export function emailBaseUrlAllowed(raw: string, nodeEnv: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") && nodeEnv !== "production";
}

/** An optional text setting for email: unset or empty is undefined. */
function optionalEmailText(max: number) {
  return z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).max(max).optional());
}

const envShape = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(3000),
  APP_BASE_URL: z.string().default("http://127.0.0.1:3000"),
  DATABASE_URL: z.string().default("postgres://bind_local:bind_local_only@127.0.0.1:5432/bind_local"),
  SETTLEMENT_MODE: z.enum(["local", "arc-testnet", "simulated"]).default("local"),
  CHAIN_ID: z.coerce.number().default(31337),
  RPC_URL: z.string().default("http://127.0.0.1:8545"),
  ARC_RPC_URL: z.string().optional(),
  ARC_CHAIN_ID: z.coerce.number().default(5042002),
  BIND_SETTLEMENT_ADDRESS: z.string().optional(),
  ARC_SIGNER_PRIVATE_KEY: z.string().optional(),
  BIND_SETTLEMENT_DEPLOY_BLOCK: z.string().regex(/^\d+$/, "must be a non-negative integer").optional(),
  SUPPLIER_ADAPTER_MODE: z.enum(["simulated", "live"]).default("simulated"),
  // No hard-coded secret. Empty when unset; an empty value is ignored by log redaction (effects/ledger.ts).
  SESSION_SECRET: z.string().default(""),
  // Comma-separated browser origins allowed to call the API. Unset: no CORS headers are sent.
  BIND_CORS_ORIGINS: z.string().optional(),
  // Optional owner token for the demo workspace. Same format as issued tokens (bnd_ + 43 base64url characters, the
  // length of 32 random bytes). It is stored as a hash only. Generate one with `npm run token:issue`.
  BIND_DEMO_OWNER_TOKEN: z
    .string()
    .regex(/^bnd_[A-Za-z0-9_-]{43}$/, "must be a Bind token: 'bnd_' followed by 43 base64url characters")
    .optional(),
  // Sign-in with Privy (ADR 0051). Both unset: the account routes answer 503 and nothing else changes. The verification key is the
  // app's public key (PEM) from the Privy dashboard; it is not a secret, but it is configuration, never source.
  PRIVY_APP_ID: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).max(128).optional()),
  PRIVY_VERIFICATION_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).max(8192).optional()),
  // How long an account session lasts, in minutes (ADR 0051). Default 60.
  BIND_SESSION_MINUTES: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(5).max(1440).optional()
  ),
  // Webhook signing (ADR 0022). No defaults in source. Unset: the routes that need a secret answer 503 and process
  // nothing. An empty value counts as unset. When set, at least 32 characters.
  BIND_MASTER_SECRET: optionalSecret("BIND_MASTER_SECRET"),
  BIND_WEBHOOK_SECRET: optionalSecret("BIND_WEBHOOK_SECRET"),
  // Connector credential encryption (ADR 0024). Unset: the credential store is disabled and its routes answer 503.
  // BIND_CREDENTIAL_KEY_PREVIOUS is decrypt-only, for rotation (npm run credentials:rotate-key).
  BIND_CREDENTIAL_KEY: optionalCredentialKey("BIND_CREDENTIAL_KEY"),
  BIND_CREDENTIAL_KEY_PREVIOUS: optionalCredentialKey("BIND_CREDENTIAL_KEY_PREVIOUS"),
  // The background worker (ADR 0029) runs in the server process. Only the exact value "false" disables it.
  BIND_WORKER_ENABLED: z.string().optional(),
  // The restock sweep (ADR 0030) runs in the worker unless this is exactly "false".
  BIND_RESTOCK_SWEEP: z.string().optional(),
  // Log level for the structured logger (ADR 0032). Unset or empty means info.
  LOG_LEVEL: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["debug", "info", "warn", "error"]).optional()),
  // Bearer token for GET /metrics (ADR 0032). Not a workspace token. Unset: /metrics answers 404. At least 32 characters.
  BIND_METRICS_TOKEN: optionalSecret("BIND_METRICS_TOKEN"),
  // Client address behind a proxy (docs/decisions/0033): how many proxy hops are trusted to set X-Forwarded-For. 0, the
  // default, means the socket address. Only a non-negative integer is accepted; anything else stops startup.
  BIND_TRUST_PROXY: z
    .preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().regex(/^\d+$/, "BIND_TRUST_PROXY must be a non-negative integer (the number of proxy hops)").optional()
    )
    .transform((v) => (v === undefined ? 0 : Number(v))),
  // Demo workspaces (docs/decisions/0057). Unset: on outside production and off in production. "true" or "false" decides.
  BIND_DEMO_ENABLED: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["true", "false"]).optional()),
  // The most demo workspaces that may be active at once (not expired). Over it, creating a demo answers 503.
  BIND_DEMO_MAX_ACTIVE: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(1).max(100000).optional()
  ),
  // Rate limits (docs/decisions/0033). The only accepted value is "off", which turns the default off. It is for local
  // development only. Unset: the default (on, except in tests).
  BIND_RATE_LIMITS: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["off"]).optional()),
  ALLOW_NO_CONTRACTS: z.string().optional().default("1"),
  PARALLEL_API_KEY: z.string().optional(),
  NEBIUS_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  LANGSMITH_API_KEY: z.string().optional(),
  // Owner email (ADR 0074). Unset: email notices stay simulated and labelled so, and the owner email routes answer
  // EMAIL_NOT_CONFIGURED. "resend" is the only provider. The link in an email is APP_BASE_URL (ADR 0025), so there is no
  // second public URL. The API base may be overridden for a local fake provider (https, or localhost outside production).
  BIND_EMAIL_PROVIDER: z.preprocess((v) => (v === "" ? undefined : v), z.enum(["resend"]).optional()),
  BIND_EMAIL_API_KEY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .min(8)
      .max(512)
      .regex(/^\S+$/, "must not contain spaces or line breaks")
      .optional()
  ),
  BIND_EMAIL_FROM: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z
      .string()
      .min(3)
      .max(200)
      .refine(
        (v) => v.includes("@") && !Array.from(v).some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f),
        "must be an address such as Bind <notices@example.com>, without control characters"
      )
      .optional()
  ),
  BIND_EMAIL_API_BASE: optionalEmailText(300),
});

/**
 * The environment rules that span variables (ADR 0074). A provider needs its key, its sender address, and an app link base
 * that is https (or local, outside production). A set API base must pass the same URL rule. Messages name a variable and
 * never a value.
 */
const envSchema = envShape.superRefine((env, ctx) => {
  if (env.BIND_EMAIL_API_BASE !== undefined && !emailBaseUrlAllowed(env.BIND_EMAIL_API_BASE, env.NODE_ENV)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["BIND_EMAIL_API_BASE"],
      message: "BIND_EMAIL_API_BASE must be https, or http on 127.0.0.1 or localhost outside production",
    });
  }
  if (env.BIND_EMAIL_PROVIDER !== undefined) {
    if (env.BIND_EMAIL_API_KEY === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["BIND_EMAIL_API_KEY"], message: "BIND_EMAIL_API_KEY is required when BIND_EMAIL_PROVIDER is set" });
    }
    if (env.BIND_EMAIL_FROM === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["BIND_EMAIL_FROM"], message: "BIND_EMAIL_FROM is required when BIND_EMAIL_PROVIDER is set" });
    }
    if (!emailBaseUrlAllowed(env.APP_BASE_URL, env.NODE_ENV)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["APP_BASE_URL"],
        message: "APP_BASE_URL must be https (or http on 127.0.0.1 or localhost outside production) when BIND_EMAIL_PROVIDER is set",
      });
    }
  }
});

/**
 * The production database rule (docs/decisions/0033). The DATABASE_URL default names a local development database with a
 * known password, so a production start without DATABASE_URL is refused. The message names the variable and never a value.
 * Other environments keep the local default.
 */
export function databaseUrlRule(input: { nodeEnv: string | undefined; databaseUrl: string | undefined }): void {
  if (input.nodeEnv === "production" && (input.databaseUrl === undefined || input.databaseUrl === "")) {
    throw new Error("DATABASE_URL must be set when NODE_ENV is production (the default is a local development database)");
  }
}

export type EnvConfig = z.infer<typeof envSchema>;

databaseUrlRule({ nodeEnv: process.env.NODE_ENV, databaseUrl: process.env.DATABASE_URL });
export { envSchema };
export const config: EnvConfig = envSchema.parse(process.env);
