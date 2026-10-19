import dotenv from "dotenv";
import { z } from "zod";

// Load .env.local first if present, otherwise .env
dotenv.config({ path: ".env.local" });
dotenv.config();

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
  SESSION_SECRET: z.string().default("f3b890f6723e42d765870bca578b8a071c7b8c8d839352e051c5beea2d78bfb0"),
  ALLOW_NO_CONTRACTS: z.string().optional().default("1"),
  PARALLEL_API_KEY: z.string().optional(),
  NEBIUS_API_KEY: z.string().optional(),
  GEMINI_API_KEY: z.string().optional(),
  LANGSMITH_API_KEY: z.string().optional(),
});

export type EnvConfig = z.infer<typeof envSchema>;

export const config: EnvConfig = envSchema.parse(process.env);
