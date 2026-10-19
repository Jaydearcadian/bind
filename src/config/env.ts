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
  ALLOW_NO_CONTRACTS: z.string().optional().default("1"),
  PARALLEL_API_KEY: z.string().optional(),
  NEBIUS_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  LANGSMITH_API_KEY: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

export const config: EnvConfig = envSchema.parse(process.env);
