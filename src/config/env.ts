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

const envSchema = z.object({
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
  ALLOW_NO_CONTRACTS: z.string().optional().default("1"),
  PARALLEL_API_KEY: z.string().optional(),
  NEBIUS_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  LANGSMITH_API_KEY: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

export const config: EnvConfig = envSchema.parse(process.env);
