/**
 * Live crash and timeout recovery of the Arc settlement path (opt-in). Each scenario sends exactly ONE payment of exactly
 * 1 cent (0.01 USDC) on Arc testnet, through Bind's own code: ProcurementWorkflowRunner.fulfillAndReconcile,
 * OrderSettlementService, ArcL1SettlementAdapter and the worker tick (runTick). The harness never calls transferUSDC
 * itself and never retries on its own after a failure. The one exception is the scripted retry sequence of
 * timeout-retry, which the scenario prescribes. Every retry is still Bind's code deciding what to send.
 *
 * Live (spends 0.01 USDC of testnet funds per scenario):
 *   npx tsx scripts/live-recovery-arc.ts <scenario> --confirm-testnet-spend [--write-evidence <new-file>] [--state <file>] [--fresh]
 * Offline rehearsal (no network, no spend; every chain read and assertion is skipped and labelled as such):
 *   npx tsx scripts/live-recovery-arc.ts <scenario> --adapter local-sim [--write-evidence <new-file>] [--state <file>]
 *
 * Scenarios: crash-before-record | crash-before-confirm | timeout-retry
 * Phases: orchestrate (default: prepare, send-child, recover, verify), or one of prepare | verify run alone. send-child and
 * recover are internal: the orchestrator re-runs this script with `node --import tsx` for each one, so each runs in its own
 * process. The scenario state file records that the send started, so a second send for the same scenario is refused
 * unless --fresh starts a new run.
 *
 * Environment (names only, never printed or written): ARC_RPC_URL, ARC_SIGNER_PRIVATE_KEY, BIND_SETTLEMENT_ADDRESS (must be
 * 0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29), BIND_SETTLEMENT_DEPLOY_BLOCK, DATABASE_URL (a local host only).
 *
 * Exit codes: 0 PASS (or PREPARED), 1 FAIL (an unexpected state or a failed assertion), 2 REFUSED or BLOCKED (nothing sent).
 * Every output and every written report goes through src/utils/redact.ts with the RPC URL, its path segments, the signer key
 * and the database URL as extra secrets.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  custom,
  decodeErrorResult,
  decodeFunctionResult,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_USDC_PRECOMPILE, ArcL1SettlementAdapter, USDC_ABI } from "../src/adapters/settlement/arc-l1.js";
import { BIND_SETTLEMENT_ABI } from "../src/adapters/settlement/bind-settlement.abi.js";
import { LocalSettlementSimulator } from "../src/adapters/settlement/local-sim.js";
import type { SettlementAdapter, TransferRequest, TransferResult } from "../src/adapters/settlement/types.js";
import { parse as parsePgConnectionString } from "pg-connection-string";
import { ARC_LOG_CHUNK_BLOCKS, collectLogs, rangeLimitOfError } from "../src/adapters/settlement/log-scan.js";
import { redactText } from "../src/utils/redact.js";
import { secretsOf } from "./verify-live-arc.js";

// ---------------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------------

export const ARC_TESTNET_CHAIN_ID = 5042002;
/** The BindSettlement contract the owner approved for this test. Any other address is refused. */
export const APPROVED_SETTLEMENT_ADDRESS = "0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29";
/** The whitelisted vendor the reference driver paid. */
export const VENDOR_ADDRESS = "0xa8358AED200D6CB6C856F972D853C1be833006ea";
/** The local simulator's seeded treasury, used as the payer for a rehearsal (no key exists for it). */
const LOCAL_SIM_PAYER = "0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2";
/** The one amount the harness ever sends. It is not configurable (there is no option for it). */
export const PAYMENT_CENTS = 1n;
export const PAYMENT_LABEL = "1 cent (0.01 USDC)";

export const SCENARIOS = ["crash-before-record", "crash-before-confirm", "timeout-retry"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export type AdapterKind = "arc" | "local-sim";
export type Phase = "orchestrate" | "prepare" | "send-child" | "recover" | "verify";
export type RunResult = "PASS" | "FAIL" | "REFUSED" | "BLOCKED" | "PREPARED";

/** Printed by the child right before it kills itself, so a SIGKILL from anywhere else is not mistaken for the crash point. */
export const KILL_ARMED_MARK = "LIVE_RECOVERY_KILL_ARMED";
const RESULT_PREFIX = "LIVE_RECOVERY_RESULT ";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const CRASH_WAIT_MS = 60_000;
const TIMEOUT_WAIT_MS = 90_000;
const POLL_MS = 2_000;
const CHILD_TIMEOUT_MS = 10 * 60_000;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
/** The tick is anchored a minute ahead, so a row updated a moment ago by the database clock still counts as stale. */
const TICK_CLOCK_MARGIN_MS = 60_000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------------------------------

/** A guard refused the run before anything was sent. The reasons name variables and rules, never their values. */
export class RefusedError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join("; "));
    this.name = "RefusedError";
    this.reasons = reasons;
  }
}

/** A read the guards need could not be completed. Nothing is sent when this is thrown. */
export class BlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedError";
  }
}

export class RpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;
  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------------------------------

export interface CliArgs {
  scenario: Scenario;
  phase: Phase;
  adapter: AdapterKind;
  confirmTestnetSpend: boolean;
  writeEvidence?: string;
  statePath: string;
  fresh: boolean;
  /** Continue a run whose send already started, without sending. See runResume. */
  resume?: boolean;
  /** Only with resume, and only when the state has no baseline. Recorded in the state and the report as supplied by the operator. */
  baselineNonce?: string;
  baselineVendorBalance?: string;
}

export const USAGE =
  "usage: live-recovery-arc.ts <scenario> [--confirm-testnet-spend] [--adapter arc|local-sim] [--phase orchestrate|prepare|verify] " +
  "[--write-evidence <new-file>] [--state <file>] [--fresh]; scenarios: " +
  SCENARIOS.join(" | ");

const PHASES: readonly Phase[] = ["orchestrate", "prepare", "send-child", "recover", "verify"];

/** Parses the command line. There is no option for the amount: an unknown option is refused, so it cannot be set. */
export function parseArgs(argv: string[], tmpDir: string = os.tmpdir()): CliArgs {
  const positional: string[] = [];
  let confirmTestnetSpend = false;
  let fresh = false;
  let writeEvidence: string | undefined;
  let statePath: string | undefined;
  let adapter: string = "arc";
  let phase: string = "orchestrate";
  let resume = false;
  let baselineNonce: string | undefined;
  let baselineVendorBalance: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (name: string): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value. ${USAGE}`);
      i++;
      return next;
    };
    if (arg === "--confirm-testnet-spend") confirmTestnetSpend = true;
    else if (arg === "--fresh") fresh = true;
    else if (arg === "--write-evidence") writeEvidence = value(arg);
    else if (arg === "--state") statePath = value(arg);
    else if (arg === "--adapter") adapter = value(arg);
    else if (arg === "--phase") phase = value(arg);
    else if (arg === "--resume") resume = true;
    else if (arg === "--baseline-nonce") baselineNonce = value(arg);
    else if (arg === "--baseline-vendor-balance") baselineVendorBalance = value(arg);
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg.split("=")[0]}. ${USAGE}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new Error(USAGE);
  const scenario = positional[0];
  if (!(SCENARIOS as readonly string[]).includes(scenario)) throw new Error(`unknown scenario. ${USAGE}`);
  if (adapter !== "arc" && adapter !== "local-sim") throw new Error(`--adapter must be arc or local-sim. ${USAGE}`);
  if (!(PHASES as readonly string[]).includes(phase)) throw new Error(`unknown phase. ${USAGE}`);
  if (resume && phase !== "orchestrate") throw new Error(`--resume is used with the orchestrate phase only. ${USAGE}`);
  if (baselineNonce !== undefined && !/^\d+$/.test(baselineNonce)) throw new Error("--baseline-nonce must be a whole number");
  if (baselineVendorBalance !== undefined && !/^\d+$/.test(baselineVendorBalance)) {
    throw new Error("--baseline-vendor-balance must be a whole number of token base units");
  }
  if ((baselineNonce !== undefined || baselineVendorBalance !== undefined) && !resume) {
    throw new Error("--baseline-nonce and --baseline-vendor-balance are only used with --resume");
  }
  return {
    scenario: scenario as Scenario,
    phase: phase as Phase,
    adapter: adapter as AdapterKind,
    confirmTestnetSpend,
    writeEvidence,
    statePath: statePath ?? path.join(tmpDir, `bind-live-recovery-${scenario}.json`),
    fresh,
    resume,
    baselineNonce,
    baselineVendorBalance,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Static guards (no network): run first, in the orchestrator and again in every child
// ---------------------------------------------------------------------------------------------------------------------

export type Env = NodeJS.ProcessEnv;

export interface GuardFailure {
  guard: string;
  reason: string;
}

/**
 * The database host, as pg will connect to it. The connection string is parsed with pg-connection-string (the parser
 * pg uses). A `host` or `hostaddr` query parameter is refused outright: pg would connect to it, whatever the authority says.
 * Returns a reason, never the value.
 */
export function databaseHostProblem(databaseUrl: string | undefined): string | undefined {
  if (!databaseUrl) return "DATABASE_URL is not set";
  let query: URLSearchParams;
  try {
    query = new URL(databaseUrl).searchParams;
  } catch {
    return "DATABASE_URL is not a URL";
  }
  for (const key of query.keys()) {
    if (/^(host|hostaddr)$/i.test(key)) return "DATABASE_URL must not set a host or hostaddr query parameter";
  }
  let parsed: { host?: string | null };
  try {
    parsed = parsePgConnectionString(databaseUrl) as { host?: string | null };
  } catch {
    return "DATABASE_URL is not a valid connection string";
  }
  const host = parsed.host;
  if (typeof host !== "string" || !LOCAL_HOSTS.has(host)) return "DATABASE_URL host must be 127.0.0.1 or localhost";
  return undefined;
}

function isHttpUrl(value: string | undefined): boolean {
  if (!value || !/^https?:\/\//i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** The address of a signer key, derived in process with viem. Undefined for anything that is not a 32-byte hex key. */
export function signerAddressOf(key: string | undefined): Address | undefined {
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return undefined;
  try {
    return privateKeyToAccount(key as Hex).address;
  } catch {
    return undefined;
  }
}

/**
 * Every static guard. Each failure names the rule, never a value. An empty list means the static guards pass.
 * `evidenceExists` is true when the --write-evidence target is already a file.
 */
export function staticGuards(env: Env, args: CliArgs, evidenceExists: boolean): GuardFailure[] {
  const failures: GuardFailure[] = [];
  const add = (guard: string, reason: string): void => {
    failures.push({ guard, reason });
  };
  const arc = args.adapter === "arc";

  if (arc && !args.confirmTestnetSpend) {
    add("confirm-flag", `pass --confirm-testnet-spend: each scenario sends one ${PAYMENT_LABEL} on Arc testnet`);
  }
  if (env.NODE_ENV === "production") add("node-env", "NODE_ENV is production");

  const dbProblem = databaseHostProblem(env.DATABASE_URL);
  if (dbProblem !== undefined) add("database-host", dbProblem);

  if (env.SETTLEMENT_MODE !== undefined && env.SETTLEMENT_MODE !== "arc-testnet") {
    add("settlement-mode", "SETTLEMENT_MODE is set to something other than arc-testnet");
  }
  if (args.writeEvidence !== undefined && evidenceExists) {
    add("evidence-file", "the --write-evidence file already exists; choose a new file name");
  }

  if (arc) {
    const contract = env.BIND_SETTLEMENT_ADDRESS;
    if (!contract || !isAddress(contract) || contract.toLowerCase() !== APPROVED_SETTLEMENT_ADDRESS.toLowerCase()) {
      add("settlement-address", "BIND_SETTLEMENT_ADDRESS is not the owner-approved contract address");
    }
    if (!/^\d+$/.test(env.BIND_SETTLEMENT_DEPLOY_BLOCK ?? "")) {
      add("deploy-block", "BIND_SETTLEMENT_DEPLOY_BLOCK must be set to a non-negative integer");
    }
    if (!isHttpUrl(env.ARC_RPC_URL)) add("rpc-url", "ARC_RPC_URL is not set or is not an http(s) URL");
    if (signerAddressOf(env.ARC_SIGNER_PRIVATE_KEY) === undefined) {
      add("signer-key", "ARC_SIGNER_PRIVATE_KEY is not set or is not a 32-byte hex key");
    }
  } else if (env.ARC_RPC_URL || env.ARC_SIGNER_PRIVATE_KEY) {
    // A rehearsal must not run from a shell that holds live settings, so the network cannot be reached by mistake.
    add("local-sim-offline", "local-sim requires ARC_RPC_URL and ARC_SIGNER_PRIVATE_KEY to be unset");
  }
  return failures;
}

// ---------------------------------------------------------------------------------------------------------------------
// RPC access (plain JSON-RPC over fetch, so the guards and the reads need no adapter)
// ---------------------------------------------------------------------------------------------------------------------

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

/** A JSON-RPC client. Errors never carry the URL: the messages name the method and the status only. */
export function httpRpc(url: string, fetchFn: typeof fetch = fetch, timeoutMs = 30_000): RpcCall {
  let nextId = 1;
  return async (method, params) => {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new RpcError(`${method} failed (network error or timeout)`);
    }
    if (!res.ok) throw new RpcError(`${method} returned HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    if (body.error) {
      throw new RpcError(`${method}: ${body.error.message ?? "RPC error"}`, body.error.code, body.error.data);
    }
    return body.result;
  };
}

async function blockedOn<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new BlockedError(`${what} failed: ${reason}`);
  }
}

function hexQuantity(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new BlockedError(`unexpected RPC answer for ${what}`);
  return BigInt(value);
}

function hexData(value: unknown, what: string): Hex {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) throw new BlockedError(`unexpected RPC answer for ${what}`);
  return value as Hex;
}

async function ethCall(rpc: RpcCall, to: string, data: Hex): Promise<Hex> {
  return hexData(await rpc("eth_call", [{ to, data }, "latest"]), "eth_call");
}

export async function readChainId(rpc: RpcCall): Promise<number> {
  return blockedOn("the chain id read", async () => Number(hexQuantity(await rpc("eth_chainId", []), "eth_chainId")));
}

export async function readNonce(rpc: RpcCall, address: string, tag: "latest" | "pending"): Promise<bigint> {
  return blockedOn(`nonce (${tag})`, async () => hexQuantity(await rpc("eth_getTransactionCount", [address, tag]), "nonce"));
}

// ---------------------------------------------------------------------------------------------------------------------
// Contract guards: chain id, owner, whitelist. Read fresh at the start and again just before each send.
// ---------------------------------------------------------------------------------------------------------------------

export interface ContractReading {
  chainId: number;
  owner: string;
  vendorWhitelisted: boolean;
  whitelistEnforced: boolean;
}

export async function readContractGuards(rpc: RpcCall, contract: string, vendor: string): Promise<ContractReading> {
  const chainId = await readChainId(rpc);
  return blockedOn("contract reads", async () => {
    const owner = decodeFunctionResult({
      abi: BIND_SETTLEMENT_ABI,
      functionName: "owner",
      data: await ethCall(rpc, contract, encodeFunctionData({ abi: BIND_SETTLEMENT_ABI, functionName: "owner" })),
    }) as string;
    const vendorWhitelisted = decodeFunctionResult({
      abi: BIND_SETTLEMENT_ABI,
      functionName: "whitelistedVendors",
      args: [vendor as Address],
      data: await ethCall(
        rpc,
        contract,
        encodeFunctionData({ abi: BIND_SETTLEMENT_ABI, functionName: "whitelistedVendors", args: [vendor as Address] })
      ),
    }) as boolean;
    const whitelistEnforced = decodeFunctionResult({
      abi: BIND_SETTLEMENT_ABI,
      functionName: "enforceVendorWhitelist",
      data: await ethCall(rpc, contract, encodeFunctionData({ abi: BIND_SETTLEMENT_ABI, functionName: "enforceVendorWhitelist" })),
    }) as boolean;
    return { chainId, owner, vendorWhitelisted, whitelistEnforced };
  });
}

/** The rules the contract reading must satisfy before any send. Empty when all of them hold. */
export function contractGuardFailures(reading: ContractReading, signer: string): GuardFailure[] {
  const failures: GuardFailure[] = [];
  if (reading.chainId !== ARC_TESTNET_CHAIN_ID) {
    failures.push({ guard: "chain-id", reason: `eth_chainId is ${reading.chainId}, expected ${ARC_TESTNET_CHAIN_ID}` });
  }
  if (reading.owner.toLowerCase() !== signer.toLowerCase()) {
    failures.push({ guard: "contract-owner", reason: "the contract owner is not the signer" });
  }
  if (!reading.vendorWhitelisted) failures.push({ guard: "vendor-whitelist", reason: "the vendor is not whitelisted" });
  if (!reading.whitelistEnforced) failures.push({ guard: "whitelist-enforced", reason: "enforceVendorWhitelist is false" });
  return failures;
}

/** Reads the contract and refuses (RefusedError) unless every rule holds. A failed read is BlockedError. */
export async function assertContractGuards(
  rpc: RpcCall,
  cfg: { contract: string; signer: string; vendor: string }
): Promise<ContractReading> {
  const reading = await readContractGuards(rpc, cfg.contract, cfg.vendor);
  const failures = contractGuardFailures(reading, cfg.signer);
  if (failures.length > 0) throw new RefusedError(failures.map((f) => f.reason));
  return reading;
}

// ---------------------------------------------------------------------------------------------------------------------
// Chain facts used by the assertions
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The contract must have code at its deploy block, and that block must already exist on the chain. Otherwise the scan
 * from the deploy block would prove nothing. Any other answer is BLOCKED, and nothing is sent.
 */
/**
 * The contract's settledOrders(bytes32) for this order id: true once a settlement for it has been paid. It is read fresh
 * before any send, so a duplicate broadcast is refused even when the log lookup finds nothing. A failed read is BLOCKED.
 */
export async function readSettledOrder(rpc: RpcCall, contract: string, orderId: string): Promise<boolean> {
  return blockedOn("the settledOrders read", async () => {
    const orderId32 = keccak256(stringToHex(orderId));
    const data = await ethCall(
      rpc,
      contract,
      encodeFunctionData({ abi: BIND_SETTLEMENT_ABI, functionName: "settledOrders", args: [orderId32] })
    );
    return decodeFunctionResult({ abi: BIND_SETTLEMENT_ABI, functionName: "settledOrders", data }) as boolean;
  });
}

/** Refuses (RefusedError) when the contract already settled this order. Runs before every transfer, so nothing is broadcast. */
export async function assertNotSettled(rpc: RpcCall, contract: string, orderId: string): Promise<void> {
  if (await readSettledOrder(rpc, contract, orderId)) {
    throw new RefusedError(["the contract already settled this order; nothing is broadcast"]);
  }
}

export async function assertDeployBlockCode(rpc: RpcCall, contract: string, deployBlock: bigint): Promise<void> {
  const head = await blockedOn("the block number read", async () =>
    hexQuantity(await rpc("eth_blockNumber", []), "eth_blockNumber")
  );
  if (deployBlock > head) throw new BlockedError("BIND_SETTLEMENT_DEPLOY_BLOCK is ahead of the chain head");
  const code = await blockedOn("the code read", async () =>
    hexData(await rpc("eth_getCode", [contract, `0x${deployBlock.toString(16)}`]), "eth_getCode")
  );
  if (code.length <= 2) throw new BlockedError("the contract has no code at BIND_SETTLEMENT_DEPLOY_BLOCK");
}

export async function readVendorBalance(rpc: RpcCall, vendor: string): Promise<bigint> {
  return blockedOn("vendor balance", async () => {
    const data = await ethCall(rpc, ARC_USDC_PRECOMPILE, encodeFunctionData({ abi: USDC_ABI, functionName: "balanceOf", args: [vendor as Address] }));
    return decodeFunctionResult({ abi: USDC_ABI, functionName: "balanceOf", data }) as bigint;
  });
}

export async function readDecimals(rpc: RpcCall): Promise<number> {
  return blockedOn("USDC decimals", async () => {
    const data = await ethCall(rpc, ARC_USDC_PRECOMPILE, encodeFunctionData({ abi: USDC_ABI, functionName: "decimals" }));
    return Number(decodeFunctionResult({ abi: USDC_ABI, functionName: "decimals", data }));
  });
}

/** One cent in the token's base units: 10^(decimals - 2). Refused unless the token has at least two decimals. */
export function oneCentInBaseUnits(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 2) throw new BlockedError("the USDC decimals are not usable");
  return 10n ** BigInt(decimals - 2);
}

export interface LogFact {
  transactionHash: string;
  blockNumber: bigint;
}

/**
 * Every SettlementExecuted log for this order id, from the deploy block to the head. The span is read in windows of at most
 * ARC_LOG_CHUNK_BLOCKS, because the RPC refuses a single eth_getLogs over 100000 blocks. Any failed window is BLOCKED.
 */
export async function readSettlementLogs(rpc: RpcCall, contract: string, orderId: string, deployBlock: bigint): Promise<LogFact[]> {
  return blockedOn("settlement logs", async () => {
    const topics = encodeEventTopics({
      abi: BIND_SETTLEMENT_ABI,
      eventName: "SettlementExecuted",
      args: { orderId: keccak256(stringToHex(orderId)) },
    } as never);
    const latest = hexQuantity(await rpc("eth_blockNumber", []), "eth_blockNumber");
    return collectLogs<LogFact>({
      latest,
      deployBlock,
      chunkBlocks: ARC_LOG_CHUNK_BLOCKS,
      rangeLimitOf: rangeLimitOfError,
      fetchRange: async (from, to) => {
        const logs = (await rpc("eth_getLogs", [
          { address: contract, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics },
        ])) as unknown;
        if (!Array.isArray(logs)) throw new BlockedError("unexpected RPC answer for eth_getLogs");
        return logs.map((log: { transactionHash?: unknown; blockNumber?: unknown }) => ({
          transactionHash: String(log.transactionHash),
          blockNumber: hexQuantity(log.blockNumber, "log block number"),
        }));
      },
    });
  });
}

export interface ReceiptFact {
  hash: string;
  status: "success" | "reverted";
  blockNumber: bigint;
  from: string;
  to: string | null;
}

export async function readReceipt(rpc: RpcCall, hash: string): Promise<ReceiptFact | null> {
  return blockedOn("transaction receipt", async () => {
    const receipt = (await rpc("eth_getTransactionReceipt", [hash])) as
      | { status?: unknown; blockNumber?: unknown; from?: unknown; to?: unknown }
      | null;
    if (receipt === null) return null;
    return {
      hash,
      status: receipt.status === "0x1" ? "success" : "reverted",
      blockNumber: hexQuantity(receipt.blockNumber, "receipt block"),
      from: String(receipt.from),
      to: receipt.to === null || receipt.to === undefined ? null : String(receipt.to),
    };
  });
}

/**
 * Replays a reverted transaction at the block before it, so the revert name can be reported. Best effort: a transaction
 * whose replay does not revert with decodable data reports undefined.
 */
export async function explainRevert(rpc: RpcCall, hash: string): Promise<string | undefined> {
  const tx = (await rpc("eth_getTransactionByHash", [hash])) as
    | { from?: unknown; to?: unknown; input?: unknown; value?: unknown; blockNumber?: unknown }
    | null;
  if (!tx || typeof tx.to !== "string") return undefined;
  const block = hexQuantity(tx.blockNumber, "transaction block");
  const before = block > 0n ? block - 1n : 0n;
  try {
    await rpc("eth_call", [{ from: tx.from, to: tx.to, data: tx.input, value: tx.value }, `0x${before.toString(16)}`]);
    return undefined;
  } catch (error) {
    const data = error instanceof RpcError ? error.data : undefined;
    if (typeof data !== "string" || !/^0x[0-9a-fA-F]{8,}$/.test(data)) return undefined;
    try {
      return decodeErrorResult({ abi: BIND_SETTLEMENT_ABI, data: data as Hex }).errorName;
    } catch {
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Scenario state (one file per scenario): the phase guard and the record of what was run
// ---------------------------------------------------------------------------------------------------------------------

export interface Baseline {
  startNonce: string;
  vendorBalanceBefore: string;
  decimals: number;
  contract: string;
  deployBlock: string;
  signer: string;
  vendor: string;
}

export interface ScenarioState {
  version: 1;
  scenario: Scenario;
  adapter: AdapterKind;
  workspaceId: string;
  orderId: string;
  workflowId: string | null;
  payer: string;
  vendor: string;
  baseline?: Baseline;
  /** Set by the send child just before its first send. Its presence means a send has started. */
  sendStartedAt?: string;
  /** Set by the recover child just before it runs. */
  recoverStartedAt?: string;
  results: Record<string, unknown>;
}

export type ChildPhase = "send" | "recover";

/** Parses a state file. Returns null for a file that is not a state record. */
export function parseState(text: string): ScenarioState | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const s = value as Partial<ScenarioState>;
  if (s.version !== 1 || typeof s.scenario !== "string" || typeof s.adapter !== "string") return null;
  if (typeof s.workspaceId !== "string" || typeof s.orderId !== "string" || typeof s.payer !== "string") return null;
  if (typeof s.vendor !== "string" || typeof s.results !== "object" || s.results === null) return null;
  return s as ScenarioState;
}

/** The state must belong to the scenario and adapter that is asked for. */
export function assertStateMatches(state: ScenarioState, args: Pick<CliArgs, "scenario" | "adapter">): void {
  if (state.scenario !== args.scenario || state.adapter !== args.adapter) {
    throw new RefusedError(["the state file belongs to another scenario or adapter; use its own --state file or --fresh"]);
  }
}

/**
 * The phase guard. The send can run once per scenario state, and recover only after a send and only once. Anything
 * else is refused before a process is started or a transfer is made.
 */
export function assertPhaseAllowed(state: ScenarioState | null, phase: ChildPhase, args: Pick<CliArgs, "scenario" | "adapter">): void {
  if (state === null) throw new RefusedError(["no prepared state for this scenario: run the prepare phase first"]);
  assertStateMatches(state, args);
  if (phase === "send") {
    if (state.sendStartedAt !== undefined) {
      throw new RefusedError([
        "the send phase already ran for this scenario; a second send is refused (use --fresh to start a new run)",
      ]);
    }
    return;
  }
  if (state.sendStartedAt === undefined) throw new RefusedError(["the recover phase is refused: the send has not started"]);
  if (state.recoverStartedAt !== undefined) throw new RefusedError(["the recover phase already ran for this scenario"]);
}

// ---------------------------------------------------------------------------------------------------------------------
// The adapter wrappers: the amount guard, the chain re-read before each send, and the crash points
// ---------------------------------------------------------------------------------------------------------------------

export interface SendHooks {
  /** Runs before every transferUSDC: the chain is re-read here, so a change since the start is caught. */
  beforeTransfer: () => Promise<void>;
  /** Runs after the real transfer returned a result. A throw here reaches the ledger as an unknown outcome. */
  afterTransfer?: (result: TransferResult) => Promise<void>;
  /** Runs on entry to confirm. */
  beforeConfirm?: (txHash: string) => Promise<void>;
}

/** What a transfer may name. Anything else is refused before the chain is read or the adapter is called. */
export interface TransferPins {
  payer: string;
  vendor: string;
  orderId: string;
}

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/**
 * Wraps an adapter. A transfer is refused unless it is exactly one cent, pays from the signer, pays the pinned vendor and
 * is for the prepared order. These checks run before beforeTransfer, so a bad request never reaches the chain read.
 */
export function guardedAdapter(inner: SettlementAdapter, hooks: SendHooks, pins: TransferPins): SettlementAdapter {
  return {
    mode: inner.mode,
    getBalance: (address: string) => inner.getBalance(address),
    transferUSDC: async (req: TransferRequest): Promise<TransferResult> => {
      if (req.amountCents !== PAYMENT_CENTS) {
        throw new RefusedError([`the amount is not ${PAYMENT_LABEL}; nothing is sent`]);
      }
      if (!sameAddress(req.fromAddress, pins.payer)) {
        throw new RefusedError(["the transfer does not pay from the signer; nothing is sent"]);
      }
      if (!sameAddress(req.toAddress, pins.vendor)) {
        throw new RefusedError(["the transfer does not pay the pinned vendor; nothing is sent"]);
      }
      if (req.orderId !== pins.orderId) {
        throw new RefusedError(["the transfer is not for the prepared order; nothing is sent"]);
      }
      await hooks.beforeTransfer();
      const result = await inner.transferUSDC(req);
      await hooks.afterTransfer?.(result);
      return result;
    },
    confirm: async (txHash: string): Promise<TransferResult> => {
      await hooks.beforeConfirm?.(txHash);
      return inner.confirm(txHash);
    },
    findTransfer: inner.findTransfer ? (req: { orderId: string }) => inner.findTransfer!(req) : undefined,
    depositEscrow: (req, milestoneId) => inner.depositEscrow(req, milestoneId),
    releaseEscrow: (milestoneId, toAddress) => inner.releaseEscrow(milestoneId, toAddress),
  } as SettlementAdapter;
}

/**
 * A viem transport for the timeout scenario. The first eth_sendRawTransaction is forwarded to the real node, so the
 * transaction is broadcast, and then it fails with a timeout-style error. The adapter therefore believes the send
 * failed. Every broadcast's hash is reported through onBroadcast. Other requests pass through unchanged.
 */
export function makeTimeoutTransport(forward: RpcCall, onBroadcast: (hash: Hex) => void): Transport {
  let armed = true;
  // retryCount 0: viem retries a failed request by default (three times), and a retry would be answered by the node
  // with the same hash. The adapter would then never see the failure this scenario exists to test.
  return custom(
    {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        const list = Array.isArray(params) ? (params as unknown[]) : [];
        if (method !== "eth_sendRawTransaction") return forward(method, list);
        const raw = list[0] as Hex;
        const result = await forward(method, list);
        onBroadcast(keccak256(raw));
        if (!armed) return result;
        armed = false;
        throw new Error("RPC request timed out after the transaction was sent");
      },
    } as never,
    { retryCount: 0 }
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Pure assertions over observed facts
// ---------------------------------------------------------------------------------------------------------------------

export interface Assertion {
  name: string;
  status: "PASS" | "FAIL" | "SKIPPED" | "INFO";
  detail: string;
}

const check = (name: string, ok: boolean, detail: string): Assertion => ({ name, status: ok ? "PASS" : "FAIL", detail });
const info = (name: string, detail: string): Assertion => ({ name, status: "INFO", detail });
const skipped = (name: string): Assertion => ({ name, status: "SKIPPED", detail: "local-sim: no chain reads" });

export interface EffectSnapshot {
  status: string;
  attempts: number;
  operation: string;
  externalRef: string | null;
}

/** The database state of one order and its transfer effect, as the harness reads it. */
export interface SettlementSnapshot {
  status: string;
  txHash: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  confirmedBlock: string | null;
  settledAmountCents: string | null;
  effect: EffectSnapshot | null;
  audits: string[];
}

export function countOf(list: string[], value: string): number {
  return list.filter((item) => item === value).length;
}

/** Assertions on the state before the restart. They are written before the restart runs, so the crash point is on record. */
export function preRestartAssertions(scenario: Scenario, snap: SettlementSnapshot): Assertion[] {
  if (scenario === "crash-before-record") {
    return [
      check("pre_restart_order_settling", snap.status === "settling", `order status ${snap.status}`),
      check("pre_restart_no_hash", snap.txHash === null, "tx_hash must be unset: the hash was never stored"),
      check("pre_restart_effect_started", snap.effect?.status === "started", `effect status ${snap.effect?.status ?? "none"}`),
      check(
        "pre_restart_no_submitted_audit",
        countOf(snap.audits, "settlement.submitted") === 0,
        "no settlement.submitted audit is written without a stored hash"
      ),
    ];
  }
  if (scenario === "crash-before-confirm") {
    // The claim for confirmSettlement moves settlement_submitted to settling before confirm() runs (ADR 0079), so the
    // order is settling here, not settlement_submitted as the brief expected. The harness asserts what the code does.
    return [
      check(
        "pre_restart_order_settling_with_hash",
        snap.status === "settling" && snap.txHash !== null,
        `order status ${snap.status}; the confirm claim holds the order as settling`
      ),
      check("pre_restart_submitted_at_set", snap.submittedAt !== null, "settlement_submitted_at is set"),
      check("pre_restart_confirmed_at_null", snap.confirmedAt === null, "settlement_confirmed_at is unset"),
      check("pre_restart_effect_completed", snap.effect?.status === "completed", `effect status ${snap.effect?.status ?? "none"}`),
      check(
        "pre_restart_submitted_audit_present",
        countOf(snap.audits, "settlement.submitted") === 1,
        "settlement.submitted audit is written once"
      ),
      check(
        "pre_restart_confirmed_audit_absent",
        countOf(snap.audits, "settlement.confirmed") === 0,
        "settlement.confirmed audit is absent"
      ),
    ];
  }
  return [];
}

export interface ChainFacts {
  contract: string;
  startNonce: string;
  endNonce: string;
  vendorBefore: string;
  vendorAfter: string;
  expectedDelta: string;
  logs: LogFact[];
  receipt: ReceiptFact | null;
}

export interface RepeatFact {
  reconciled?: boolean;
  alreadyReconciled?: boolean;
  hold?: string;
  nonceBefore?: string;
  nonceAfter?: string;
}

/** The final assertions of a crash scenario (after the restart and the repeat). */
export function crashAssertions(input: {
  scenario: Scenario;
  adapter: AdapterKind;
  childSignal: string | null;
  killArmed: boolean;
  final: SettlementSnapshot;
  repeat: RepeatFact | undefined;
  chain: ChainFacts | undefined;
}): Assertion[] {
  const { final, repeat, chain } = input;
  const out: Assertion[] = [
    check(
      "child_killed_at_crash_point",
      input.killArmed && input.childSignal === "SIGKILL",
      `kill point reached: ${input.killArmed}; child signal: ${input.childSignal ?? "none"}`
    ),
    check("order_reconciled", final.status === "reconciled", `order status ${final.status}`),
    check("order_tx_hash_set", final.txHash !== null, "tx_hash is set"),
    check("submitted_at_set", final.submittedAt !== null, "settlement_submitted_at is set"),
    check("confirmed_at_set", final.confirmedAt !== null, "settlement_confirmed_at is set"),
    // The block comes from the adapter's receipt. The simulator reports none, so the column stays NULL there (ADR 0079).
    input.adapter === "arc"
      ? check("confirmed_block_set", final.confirmedBlock !== null, "settlement_confirmed_block is set")
      : skipped("confirmed_block_set"),
    check("effect_completed", final.effect?.status === "completed", `effect status ${final.effect?.status ?? "none"}`),
    check(
      "confirmed_audit_once",
      countOf(final.audits, "settlement.confirmed") === 1,
      `settlement.confirmed audits: ${countOf(final.audits, "settlement.confirmed")}`
    ),
    check(
      "repeat_already_reconciled",
      repeat?.alreadyReconciled === true,
      `repeat result: ${repeat ? JSON.stringify({ alreadyReconciled: repeat.alreadyReconciled, reconciled: repeat.reconciled }) : "not run"}`
    ),
  ];
  // The ledger's attempt count. A restart that adopts the transfer it finds on chain leaves it at 1. A restart that sends
  // again would make it 2. The simulator forgets its transfer when the process dies, so under local-sim a 2 is expected.
  const attempts = final.effect?.attempts ?? 0;
  if (input.adapter === "local-sim" || !chain) {
    out.push(skipped("one_settlement_log"), skipped("signer_nonce_delta_one"), skipped("vendor_delta_exact"));
    out.push(skipped("tx_hash_matches_log"), skipped("confirmed_block_matches_log"), skipped("receipt_success"));
    out.push(skipped("nonce_unchanged_by_repeat"));
    out.push(
      info(
        "transfer_not_sent_again",
        `local-sim: effect attempts ${attempts}. The in-memory simulator forgets the transfer across processes, so the restart re-sends here; not evidence about the chain`
      )
    );
    return out;
  }
  out.push(
    check(
      "transfer_not_sent_again",
      attempts === 1,
      `effect attempts ${attempts}: 1 means the restart adopted the transfer found on chain and did not send it again`
    )
  );
  const log = chain.logs[0];
  out.push(
    check("one_settlement_log", chain.logs.length === 1, `SettlementExecuted logs for the order id: ${chain.logs.length}`),
    check(
      "signer_nonce_delta_one",
      BigInt(chain.endNonce) - BigInt(chain.startNonce) === 1n,
      `signer nonce ${chain.startNonce} -> ${chain.endNonce}`
    ),
    check(
      "vendor_delta_exact",
      BigInt(chain.vendorAfter) - BigInt(chain.vendorBefore) === BigInt(chain.expectedDelta),
      `vendor balance delta ${BigInt(chain.vendorAfter) - BigInt(chain.vendorBefore)} base units, expected ${chain.expectedDelta}`
    ),
    check(
      "tx_hash_matches_log",
      log !== undefined && final.txHash !== null && log.transactionHash.toLowerCase() === final.txHash.toLowerCase(),
      `order tx_hash ${final.txHash ?? "none"}, log ${log?.transactionHash ?? "none"}`
    ),
    check(
      "confirmed_block_matches_log",
      log !== undefined && final.confirmedBlock !== null && BigInt(final.confirmedBlock) === log.blockNumber,
      `confirmed block ${final.confirmedBlock ?? "none"}, log block ${log?.blockNumber.toString() ?? "none"}`
    ),
    check("receipt_success", chain.receipt?.status === "success", `receipt status ${chain.receipt?.status ?? "none"}`),
    check(
      "nonce_unchanged_by_repeat",
      repeat?.nonceBefore !== undefined && repeat.nonceBefore === repeat.nonceAfter && repeat.nonceAfter === chain.endNonce,
      `nonce before repeat ${repeat?.nonceBefore ?? "none"}, after ${repeat?.nonceAfter ?? "none"}, at the end ${chain.endNonce}`
    )
  );
  return out;
}

export interface AttemptRecord {
  name: string;
  ok: boolean;
  error?: { name: string; message: string };
  result?: RepeatFact & { status?: string; txHash?: string };
}

export interface BroadcastRecord {
  hash: string;
  receipt: ReceiptFact | null;
  revert?: string;
}

/** The assertions of the timeout scenario. Money is checked hard; the order state and the nonce are reported. */
export function timeoutAssertions(input: {
  stopped: string | undefined;
  attempts: AttemptRecord[];
  broadcastsAfterAttempt1?: number;
  afterAttempt1: SettlementSnapshot | undefined;
  final: SettlementSnapshot | undefined;
  adapter: AdapterKind;
  chain: ChainFacts | undefined;
  broadcasts: BroadcastRecord[];
}): Assertion[] {
  const out: Assertion[] = [];
  out.push(
    input.stopped === undefined
      ? check("sequence_completed", true, "all three calls ran")
      : check("sequence_completed", false, `the sequence stopped: ${input.stopped}`)
  );
  const first = input.attempts[0];
  const a1 = input.afterAttempt1;
  out.push(
    check(
      "attempt1_broadcast_exactly_once",
      input.broadcastsAfterAttempt1 === 1,
      `broadcasts after attempt 1: ${input.broadcastsAfterAttempt1 ?? "not recorded"}; the scenario needs exactly one`
    )
  );
  out.push(
    check(
      "attempt1_unknown_outcome",
      first !== undefined && !first.ok && a1?.status === "confirmed" && a1.effect?.status === "failed",
      `attempt 1 ${first?.ok === false ? `threw ${first.error?.name ?? "error"}` : "did not throw"}; order ${a1?.status ?? "none"}; effect ${a1?.effect?.status ?? "none"}`
    )
  );
  if (input.adapter === "local-sim" || !input.chain) {
    out.push(skipped("one_settlement_log"), skipped("vendor_delta_exact"), skipped("broadcasts_at_most_two"));
    out.push(skipped("signer_nonce_delta"), skipped("tx_hash_matches_log"));
  } else {
    const chain = input.chain;
    const log = chain.logs[0];
    out.push(
      check("one_settlement_log", chain.logs.length === 1, `SettlementExecuted logs for the order id: ${chain.logs.length}`),
      check(
        "vendor_delta_exact",
        BigInt(chain.vendorAfter) - BigInt(chain.vendorBefore) === BigInt(chain.expectedDelta),
        `vendor balance delta ${BigInt(chain.vendorAfter) - BigInt(chain.vendorBefore)} base units, expected ${chain.expectedDelta}`
      ),
      check(
        "broadcasts_at_most_two",
        input.broadcasts.length <= 2,
        `broadcasts by the signer during the scenario: ${input.broadcasts.length}`
      ),
      check(
        "signer_nonce_delta",
        BigInt(chain.endNonce) - BigInt(chain.startNonce) === BigInt(input.broadcasts.length) &&
          (input.broadcasts.length === 1 || input.broadcasts.length === 2),
        `signer nonce ${chain.startNonce} -> ${chain.endNonce} (delta ${BigInt(chain.endNonce) - BigInt(chain.startNonce)}) against ${input.broadcasts.length} broadcast(s): the delta must equal the broadcasts, and be 1 or 2`
      ),
      check(
        "tx_hash_matches_log",
        log !== undefined && input.final?.txHash != null && log.transactionHash.toLowerCase() === input.final.txHash.toLowerCase(),
        `order tx_hash ${input.final?.txHash ?? "none"}, log ${log?.transactionHash ?? "none"}`
      )
    );
  }
  for (const b of input.broadcasts) {
    out.push(
      info(
        "broadcast",
        `${b.hash}: receipt ${b.receipt?.status ?? "not found"}${b.revert ? `, revert ${b.revert}` : ""}`
      )
    );
  }
  out.push(
    check(
      "order_reconciled",
      input.final?.status === "reconciled",
      `order status ${input.final?.status ?? "none"}${input.final?.status === "payment_hold" || input.final?.status === "settlement_submitted" ? " (reported, not a money loss)" : ""}`
    )
  );
  const last = input.attempts[input.attempts.length - 1];
  out.push(info("attempt_results", input.attempts.map((a) => `${a.name}: ${a.ok ? "returned" : `threw ${a.error?.name ?? "error"}`}`).join("; ")));
  if (last && last.ok && last.result) {
    out.push(info("last_result", JSON.stringify({ reconciled: last.result.reconciled, alreadyReconciled: last.result.alreadyReconciled, hold: last.result.hold })));
  }
  return out;
}

/**
 * PASS only when nothing failed and, on the live chain, nothing was skipped: a skipped chain check on arc is a gap in the
 * evidence, so it cannot pass. A local-sim rehearsal may skip its chain checks; that is what the rehearsal is.
 */
export function verdictOf(assertions: Assertion[], adapter: AdapterKind): RunResult {
  if (assertions.some((a) => a.status === "FAIL")) return "FAIL";
  if (adapter === "arc" && assertions.some((a) => a.status === "SKIPPED")) return "FAIL";
  return "PASS";
}

/** The database state as the harness stores it. Pure, so the tests can build one from rows. */
export function toSnapshot(
  order: Record<string, unknown> | undefined,
  effect: Record<string, unknown> | undefined,
  audits: { action: string }[]
): SettlementSnapshot {
  if (!order) throw new BlockedError("the order row is missing");
  const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
  const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return {
    status: String(order.status),
    txHash: str(order.tx_hash),
    submittedAt: iso(order.settlement_submitted_at),
    confirmedAt: iso(order.settlement_confirmed_at),
    confirmedBlock: str(order.settlement_confirmed_block),
    settledAmountCents: str(order.settled_amount_cents),
    effect: effect
      ? {
          status: String(effect.status),
          attempts: Number(effect.attempts),
          operation: String(effect.operation),
          externalRef: str(effect.external_ref),
        }
      : null,
    audits: audits.map((a) => a.action),
  };
}

/**
 * The restart's calls, in order, for each crash scenario. A tick is the worker's own code. A fulfill is Bind's own
 * settle path. The last fulfill is the repeat: it must find the order already reconciled and send nothing.
 * crash-before-confirm needs two ticks: the first moves the order from settling to settlement_submitted (the stuck
 * step runs after the poll step), and the second polls and confirms it.
 */
export function scenarioRecoverPlan(scenario: Scenario): ("tick" | "fulfill" | "fulfill-repeat")[] {
  if (scenario === "crash-before-record") return ["tick", "fulfill", "tick", "fulfill-repeat"];
  if (scenario === "crash-before-confirm") return ["tick", "tick", "fulfill-repeat"];
  return [];
}

// ---------------------------------------------------------------------------------------------------------------------
// Waiting (bounded). Nothing is sent by a wait.
// ---------------------------------------------------------------------------------------------------------------------

export async function waitUntil(
  check: () => Promise<boolean>,
  opts: { timeoutMs: number; pollMs: number; now: () => number; sleep: (ms: number) => Promise<void> }
): Promise<boolean> {
  const deadline = opts.now() + opts.timeoutMs;
  for (;;) {
    if (await check()) return true;
    const remaining = deadline - opts.now();
    if (remaining <= 0) return false;
    await opts.sleep(Math.min(opts.pollMs, remaining));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Output: every line passes through the redaction module with the configured secrets
// ---------------------------------------------------------------------------------------------------------------------

export function makeScrubber(env: Env): (text: string) => string {
  const extras = [
    ...secretsOf(env.ARC_RPC_URL),
    env.ARC_SIGNER_PRIVATE_KEY ?? "",
    env.DATABASE_URL ?? "",
  ].filter((s) => s.length > 0);
  return (text: string) => redactText(text, extras);
}

/** A JSON document on one line, with bigints as strings. */
export function jsonText(value: unknown, pretty = false): string {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === "bigint" ? v.toString() : v),
    pretty ? 2 : undefined
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Ports: the effectful edges. The orchestrator takes them as arguments so the tests can stub every one.
// ---------------------------------------------------------------------------------------------------------------------

export interface ChildOutcome {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  result?: unknown;
  lines: string[];
}

export interface PreparedRun {
  workspaceId: string;
  orderId: string;
  workflowId: string | null;
  orderStatus: string;
}

export interface HarnessDb {
  prepare(input: { scenario: Scenario; payer: string; vendor: string; adapter: AdapterKind }): Promise<PreparedRun>;
  orderTotalCents(orderId: string, workspaceId: string): Promise<bigint>;
  snapshot(orderId: string, workspaceId: string): Promise<SettlementSnapshot>;
  close(): Promise<void>;
}

export interface HarnessPorts {
  env: Env;
  /** Writes the report to stdout. The caller passes text that has already been redacted. */
  emit(text: string): void;
  /** A notice for a person (stderr), so stdout stays one JSON report. Already redacted by the caller. */
  notify(text: string): void;
  files: {
    exists(file: string): boolean;
    read(file: string): string | null;
    write(file: string, text: string, mode: "new" | "overwrite"): void;
  };
  rpc: RpcCall | undefined;
  db: HarnessDb;
  spawnPhase(childArgs: string[], timeoutMs: number): Promise<ChildOutcome>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

function childArgs(args: CliArgs, phase: "send-child" | "recover"): string[] {
  return [
    args.scenario,
    "--phase",
    phase,
    "--adapter",
    args.adapter,
    "--state",
    args.statePath,
    ...(args.confirmTestnetSpend ? ["--confirm-testnet-spend"] : []),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------------------------------

const EXIT_CODE: Record<RunResult, number> = { PASS: 0, PREPARED: 0, FAIL: 1, REFUSED: 2, BLOCKED: 2 };

class ReportBuilder {
  private readonly startedAt: number;
  private readonly steps: { name: string; at: string; data?: unknown }[] = [];
  private readonly children: unknown[] = [];
  private chain: unknown;
  private ids: unknown;
  private assertions: Assertion[] = [];

  constructor(
    private readonly args: CliArgs,
    private readonly ports: HarnessPorts
  ) {
    this.startedAt = ports.now();
  }

  step(name: string, data?: unknown): void {
    this.steps.push({ name, at: new Date(this.ports.now()).toISOString(), data });
  }

  child(phase: string, outcome: ChildOutcome): void {
    this.children.push({
      phase,
      exitCode: outcome.code,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      killArmed: outcome.lines.some((line) => line.includes(KILL_ARMED_MARK)),
      result: outcome.result ?? null,
      logTail: outcome.lines.slice(-20),
    });
  }

  setChain(chain: unknown): void {
    this.chain = chain;
  }

  setIds(ids: unknown): void {
    this.ids = ids;
  }

  setAssertions(assertions: Assertion[]): void {
    this.assertions = assertions;
  }

  end(result: RunResult, reasons: string[] = []): number {
    const finishedAt = this.ports.now();
    const adapterIsArc = this.args.adapter === "arc";
    const evidenceClass =
      result === "PASS" ? (adapterIsArc ? "VERIFIED_REMOTE" : "LOCAL_PASS") : result === "REFUSED" ? "NOT_RUN" : result === "BLOCKED" ? "BLOCKED" : null;
    const doc = {
      harness: "live-recovery-arc",
      harnessVersion: 1,
      scenario: this.args.scenario,
      phase: this.args.phase,
      resume: this.args.resume === true,
      adapter: this.args.adapter,
      mode: adapterIsArc ? "LIVE_ARC_TESTNET" : "LOCAL_SIMULATOR_NO_CHAIN",
      chainAssertions: adapterIsArc
        ? "CHECKED"
        : "SKIPPED (local-sim: no chain reads, so the exactly-one-payment and balance checks are not evaluated)",
      amount: { cents: PAYMENT_CENTS.toString(), usdc: "0.01" },
      result,
      evidenceClass,
      reasons,
      ids: this.ids ?? null,
      chain: this.chain ?? null,
      steps: this.steps,
      children: this.children,
      assertions: this.assertions,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - this.startedAt,
      exitCode: EXIT_CODE[result],
    };
    const text = jsonText(doc, true);
    this.ports.emit(text);
    if (this.args.writeEvidence !== undefined) {
      try {
        this.ports.files.write(path.resolve(this.args.writeEvidence), `${text}\n`, "new");
        this.ports.notify(`wrote ${path.basename(this.args.writeEvidence)} (new file)`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        this.ports.notify(`evidence file not written: ${reason}`);
        return 2;
      }
    }
    return EXIT_CODE[result];
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The orchestrator (runs in the parent process)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Continues a run whose send already started. It never sends: the parent makes no transfer, and no send-child is spawned.
 * What it does: refuses unless the state shows the send started and the crash (or, for timeout-retry, attempt 1) was
 * recorded; checks the chain (chain id, owner, whitelist, deploy-block code) fresh; restores the baseline from the state, or
 * from --baseline-nonce and --baseline-vendor-balance when the state has none (recorded as supplied by the operator); waits
 * for the crashed transfer to be mined; runs the restart child (recover), which includes the same-key repeat; then verifies.
 * For timeout-retry the attempts already ran in the send child, so resume only verifies.
 */
async function runResume(args: CliArgs, ports: HarnessPorts, report: ReportBuilder): Promise<number> {
  const previous = loadState(ports.files, args.statePath);
  if (previous === null) {
    return report.end("REFUSED", ["resume needs the state file of the send, and this scenario has none"]);
  }
  assertStateMatches(previous, args);
  if (previous.recoverStartedAt !== undefined) {
    return report.end("REFUSED", ["the recovery already started for this scenario; resume will not run it again"]);
  }
  if (previous.sendStartedAt === undefined) {
    return report.end("REFUSED", ["resume refused: the send has not started (the state file has no sendStartedAt)"]);
  }
  if (args.scenario === "timeout-retry") {
    const send = previous.results.send as { attempts?: unknown[]; afterAttempt1?: unknown } | null | undefined;
    if (!send || !Array.isArray(send.attempts) || send.attempts.length < 1 || send.afterAttempt1 === undefined) {
      return report.end("REFUSED", ["resume refused for timeout-retry: the state does not show attempt 1 completed"]);
    }
  } else {
    const sendChild = previous.results.sendChild as { signal?: string | null; killArmed?: boolean } | undefined;
    if (!sendChild || sendChild.signal !== "SIGKILL" || sendChild.killArmed !== true) {
      return report.end("REFUSED", ["resume refused: the state does not record the SIGKILL at the kill point"]);
    }
  }

  const signer = signerAddressOf(ports.env.ARC_SIGNER_PRIVATE_KEY) ?? LOCAL_SIM_PAYER;
  const contract = ports.env.BIND_SETTLEMENT_ADDRESS ?? APPROVED_SETTLEMENT_ADDRESS;
  const deployBlock = ports.env.BIND_SETTLEMENT_DEPLOY_BLOCK ?? "0";
  if (args.adapter === "arc") {
    if (!ports.rpc) return report.end("BLOCKED", ["no RPC client"]);
    const reading = await assertContractGuards(ports.rpc, { contract, signer, vendor: VENDOR_ADDRESS });
    await assertDeployBlockCode(ports.rpc, contract, BigInt(deployBlock));
    report.step("contract-guards", { chainId: reading.chainId, owner: reading.owner, whitelisted: reading.vendorWhitelisted });
  }

  let state = previous;
  let baselineSource: "state file" | "supplied by operator" = "state file";
  const supplied = args.baselineNonce !== undefined || args.baselineVendorBalance !== undefined;
  if (state.baseline === undefined) {
    if (args.baselineNonce === undefined || args.baselineVendorBalance === undefined) {
      return report.end("REFUSED", [
        "the state has no baseline: supply --baseline-nonce and --baseline-vendor-balance (they are recorded as supplied by the operator)",
      ]);
    }
    const decimals = args.adapter === "arc" && ports.rpc ? await readDecimals(ports.rpc) : 18;
    const baseline: Baseline = {
      startNonce: args.baselineNonce,
      vendorBalanceBefore: args.baselineVendorBalance,
      decimals,
      contract: args.adapter === "arc" ? contract : "",
      deployBlock: args.adapter === "arc" ? deployBlock : "0",
      signer,
      vendor: VENDOR_ADDRESS,
    };
    state = updateState(ports, args.statePath, (s) => {
      s.baseline = baseline;
      s.results.baselineSource = "supplied by operator";
    });
    baselineSource = "supplied by operator";
  } else {
    const b = state.baseline;
    if (supplied && (b.startNonce !== args.baselineNonce || b.vendorBalanceBefore !== args.baselineVendorBalance)) {
      return report.end("REFUSED", ["the supplied baseline differs from the baseline in the state file; nothing is overwritten"]);
    }
    if (args.adapter === "arc" && (b.contract.toLowerCase() !== contract.toLowerCase() || b.deployBlock !== deployBlock)) {
      return report.end("REFUSED", ["the state's baseline names another contract or deploy block than this environment"]);
    }
  }
  report.step("baseline", { ...state.baseline, source: baselineSource });

  if (args.adapter === "arc") {
    if (!ports.rpc) return report.end("BLOCKED", ["no RPC client"]);
    const rpc = ports.rpc;
    // The contract says this order is settled. Then the log must be found, or nothing can be adopted: stop before any child.
    if (await readSettledOrder(rpc, contract, state.orderId)) {
      const logsNow = await readSettlementLogs(rpc, contract, state.orderId, BigInt(state.baseline!.deployBlock));
      report.step("settled-check", { settledOrders: true, logsFound: logsNow.length });
      if (logsNow.length === 0) {
        return report.end("BLOCKED", [
          "the contract reports this order settled, but no SettlementExecuted log was found: nothing can be adopted, nothing is sent",
        ]);
      }
    }
    const startNonce = BigInt(state.baseline!.startNonce);
    const mined = await waitUntil(
      async () => {
        const logs = await readSettlementLogs(rpc, contract, state.orderId, BigInt(state.baseline!.deployBlock));
        const latest = await readNonce(rpc, signer, "latest");
        return logs.length >= 1 && latest > startNonce;
      },
      { timeoutMs: CRASH_WAIT_MS, pollMs: POLL_MS, now: ports.now, sleep: ports.sleep }
    );
    report.step("wait-for-mining", { mined, timeoutMs: CRASH_WAIT_MS });
    if (!mined) {
      return report.end("FAIL", ["the transfer is not mined within the bound; resume runs nothing further"]);
    }
  }

  if (args.scenario !== "timeout-retry") {
    if (state.results.preRestart === undefined) {
      const preCrash = await ports.db.snapshot(state.orderId, state.workspaceId);
      const preRestart = preRestartAssertions(args.scenario, preCrash);
      state = updateState(ports, args.statePath, (s) => {
        s.results.preCrash = preCrash;
        s.results.preRestart = preRestart;
      });
    }
    assertPhaseAllowed(state, "recover", args);
    // The restart child is the only process spawned here. The send-child is never spawned by resume.
    const recover = await ports.spawnPhase(childArgs(args, "recover"), CHILD_TIMEOUT_MS);
    report.child("recover", recover);
    state = updateState(ports, args.statePath, (s) => {
      s.results.recover = recover.result ?? null;
    });
    if (recover.code === 2) {
      const stop = childStop(recover);
      return report.end(stop.result, stop.reasons);
    }
    if (recover.code !== 0 || recover.result === undefined) {
      return report.end("FAIL", ["the recover process did not finish cleanly; nothing further was sent"]);
    }
  }
  report.step("resume", { baselineSource, sendsSpawnedByResume: 0 });
  const verdict = await verifyRun(args, state, ports, report);
  return report.end(verdict);
}

function loadState(files: HarnessPorts["files"], file: string): ScenarioState | null {
  const text = files.read(file);
  if (text === null) return null;
  const state = parseState(text);
  if (state === null) throw new RefusedError(["the state file is not a valid scenario record; use --fresh or another --state file"]);
  return state;
}

function saveState(ports: HarnessPorts, file: string, state: ScenarioState): void {
  ports.files.write(file, jsonText(state, true), "overwrite");
}

/**
 * Re-reads the state file, applies one change and saves it. A child writes its own markers (sendStartedAt, recoverStartedAt)
 * to the same file, so the orchestrator must never save a copy it read before the child ran: that copy would drop them.
 */
function updateState(ports: HarnessPorts, file: string, change: (state: ScenarioState) => void): ScenarioState {
  const current = loadState(ports.files, file);
  if (current === null) throw new BlockedError("the state file disappeared during the run");
  change(current);
  saveState(ports, file, current);
  return current;
}

/** The chain facts of a finished run, read after the restart. */
async function chainFacts(
  rpc: RpcCall,
  state: ScenarioState,
  finalSnap: SettlementSnapshot
): Promise<ChainFacts> {
  const baseline = state.baseline;
  if (!baseline) throw new BlockedError("the baseline is missing from the state file");
  const endNonce = await readNonce(rpc, baseline.signer, "latest");
  const vendorAfter = await readVendorBalance(rpc, baseline.vendor);
  const logs = await readSettlementLogs(rpc, baseline.contract, state.orderId, BigInt(baseline.deployBlock));
  const receipt = finalSnap.txHash ? await readReceipt(rpc, finalSnap.txHash) : null;
  const decimals = baseline.decimals;
  return {
    contract: baseline.contract,
    startNonce: baseline.startNonce,
    endNonce: endNonce.toString(),
    vendorBefore: baseline.vendorBalanceBefore,
    vendorAfter: vendorAfter.toString(),
    expectedDelta: oneCentInBaseUnits(decimals).toString(),
    logs,
    receipt,
  };
}

function repeatFromRecover(recover: unknown): RepeatFact | undefined {
  const steps = (recover as { steps?: { name: string; result?: RepeatFact; nonceBefore?: string; nonceAfter?: string }[] } | undefined)?.steps;
  const last = steps?.filter((s) => s.name === "fulfill-repeat").pop();
  if (!last || !last.result) return undefined;
  return { ...last.result, nonceBefore: last.nonceBefore, nonceAfter: last.nonceAfter };
}

/** Reads the final state, then the chain, and asserts. Used by the orchestrator and by the verify phase. */
async function verifyRun(args: CliArgs, state: ScenarioState, ports: HarnessPorts, report: ReportBuilder): Promise<RunResult> {
  const final = await ports.db.snapshot(state.orderId, state.workspaceId);
  report.step("final-snapshot", final);
  const sendResult = state.results.send as
    | { broadcastsAfterAttempt1?: number; attempts?: AttemptRecord[]; afterAttempt1?: SettlementSnapshot; afterAttempt2?: SettlementSnapshot; afterAttempt3?: SettlementSnapshot; stopped?: string; broadcasts?: string[] }
    | undefined;
  const sendBroadcasts = sendResult?.broadcasts ?? [];

  let chain: ChainFacts | undefined;
  const broadcasts: BroadcastRecord[] = [];
  if (args.adapter === "arc") {
    if (!ports.rpc) throw new BlockedError("no RPC client for the arc adapter");
    chain = await chainFacts(ports.rpc, state, final);
    report.setChain({ ...state.baseline, ...chain });
    for (const hash of sendBroadcasts) {
      const receipt = await readReceipt(ports.rpc, hash);
      const revert = receipt?.status === "reverted" ? await explainRevert(ports.rpc, hash) : undefined;
      broadcasts.push({ hash, receipt, revert });
    }
  }

  let assertions: Assertion[];
  if (args.scenario === "timeout-retry") {
    assertions = timeoutAssertions({
      stopped: sendResult?.stopped,
      attempts: sendResult?.attempts ?? [],
      broadcastsAfterAttempt1: sendResult?.broadcastsAfterAttempt1,
      afterAttempt1: sendResult?.afterAttempt1,
      final,
      adapter: args.adapter,
      chain,
      broadcasts,
    });
  } else {
    const sendChild = state.results.sendChild as { signal?: string | null; killArmed?: boolean } | undefined;
    assertions = [
      ...((state.results.preRestart as Assertion[] | undefined) ?? []),
      ...crashAssertions({
        scenario: args.scenario,
        adapter: args.adapter,
        childSignal: sendChild?.signal ?? null,
        killArmed: sendChild?.killArmed === true,
        final,
        repeat: repeatFromRecover(state.results.recover),
        chain,
      }),
    ];
  }
  if (args.adapter === "local-sim") {
    assertions.unshift({
      name: "chain_assertions",
      status: "SKIPPED",
      detail: "local-sim rehearsal: no chain reads; the simulator is in memory and cannot show one payment across processes",
    });
  }
  report.setAssertions(assertions);
  return verdictOf(assertions, args.adapter);
}

/**
 * The orchestrator. It runs the phases in order and stops at the first unexpected state. It never retries a send. Returns
 * the exit code; every outcome is also written as the report.
 */
export async function runOrchestrator(args: CliArgs, ports: HarnessPorts): Promise<number> {
  const report = new ReportBuilder(args, ports);
  try {
    const evidenceExists = args.writeEvidence !== undefined && ports.files.exists(path.resolve(args.writeEvidence));
    const failures = staticGuards(ports.env, args, evidenceExists);
    if (failures.length > 0) return report.end("REFUSED", failures.map((f) => f.reason));
    if (args.resume) return await runResume(args, ports, report);

    const previous = loadState(ports.files, args.statePath);
    if (previous !== null && args.phase !== "verify") assertStateMatches(previous, args);
    if (previous?.sendStartedAt !== undefined && !args.fresh && args.phase !== "verify") {
      return report.end("REFUSED", ["the send already ran for this scenario; a second send is refused (use --fresh for a new run)"]);
    }

    const signer = signerAddressOf(ports.env.ARC_SIGNER_PRIVATE_KEY) ?? LOCAL_SIM_PAYER;
    const contract = ports.env.BIND_SETTLEMENT_ADDRESS ?? APPROVED_SETTLEMENT_ADDRESS;
    if (args.adapter === "arc") {
      if (!ports.rpc) return report.end("BLOCKED", ["no RPC client"]);
      const reading = await assertContractGuards(ports.rpc, { contract, signer, vendor: VENDOR_ADDRESS });
      await assertDeployBlockCode(ports.rpc, contract, BigInt(ports.env.BIND_SETTLEMENT_DEPLOY_BLOCK ?? "0"));
      report.step("contract-guards", { chainId: reading.chainId, owner: reading.owner, whitelisted: reading.vendorWhitelisted });
    }

    let state: ScenarioState;
    if (args.phase === "verify") {
      if (previous === null) return report.end("REFUSED", ["no state file to verify"]);
      state = previous;
    } else if (previous !== null && !args.fresh) {
      state = previous;
      report.step("prepare-reused", { workspaceId: state.workspaceId, orderId: state.orderId });
    } else {
      const prepared = await ports.db.prepare({ scenario: args.scenario, payer: signer, vendor: VENDOR_ADDRESS, adapter: args.adapter });
      if (prepared.orderStatus !== "confirmed") {
        return report.end("REFUSED", [`the prepared order is ${prepared.orderStatus}, expected confirmed`]);
      }
      state = {
        version: 1,
        scenario: args.scenario,
        adapter: args.adapter,
        workspaceId: prepared.workspaceId,
        orderId: prepared.orderId,
        workflowId: prepared.workflowId,
        payer: signer,
        vendor: VENDOR_ADDRESS,
        results: {},
      };
      saveState(ports, args.statePath, state);
      report.step("prepared", { workspaceId: state.workspaceId, orderId: state.orderId });
    }
    report.setIds({ workspaceId: state.workspaceId, orderId: state.orderId, workflowId: state.workflowId });

    const total = await ports.db.orderTotalCents(state.orderId, state.workspaceId);
    if (total !== PAYMENT_CENTS) return report.end("REFUSED", [`the order total is not ${PAYMENT_LABEL}; nothing is sent`]);

    if (args.phase === "prepare") return report.end("PREPARED");

    if (args.phase !== "verify") {
      assertPhaseAllowed(state, "send", args);
      if (args.adapter === "arc") {
        if (!ports.rpc) return report.end("BLOCKED", ["no RPC client"]);
        const decimals = await readDecimals(ports.rpc);
        state.baseline = {
          startNonce: (await readNonce(ports.rpc, signer, "latest")).toString(),
          vendorBalanceBefore: (await readVendorBalance(ports.rpc, VENDOR_ADDRESS)).toString(),
          decimals,
          contract,
          deployBlock: ports.env.BIND_SETTLEMENT_DEPLOY_BLOCK ?? "0",
          signer,
          vendor: VENDOR_ADDRESS,
        };
      } else {
        // No chain: nothing is read. The simulator's values are placeholders, labelled by the mode in the report.
        state.baseline = { startNonce: "0", vendorBalanceBefore: "0", decimals: 18, contract: "", deployBlock: "0", signer, vendor: VENDOR_ADDRESS };
      }
      saveState(ports, args.statePath, state);
      report.step("baseline", state.baseline);

      const send = await ports.spawnPhase(childArgs(args, "send-child"), CHILD_TIMEOUT_MS);
      report.child("send-child", send);
      const killArmedSeen = send.lines.some((l) => l.includes(KILL_ARMED_MARK));
      state = updateState(ports, args.statePath, (s) => {
        s.results.send = send.result ?? null;
        s.results.sendChild = { signal: send.signal, killArmed: killArmedSeen };
      });

      if (send.code === 2) {
        const stop = childStop(send);
        return report.end(stop.result, stop.reasons);
      }
      if (args.scenario === "timeout-retry") {
        if (send.code !== 0 || send.result === undefined) {
          report.step("unexpected-send-child-outcome", { code: send.code, signal: send.signal, timedOut: send.timedOut });
          return report.end("FAIL", ["the timeout sequence did not finish cleanly; nothing further was sent"]);
        }
      } else {
        const killArmed = send.lines.some((l) => l.includes(KILL_ARMED_MARK));
        if (send.signal !== "SIGKILL" || !killArmed) {
          const snap = await ports.db.snapshot(state.orderId, state.workspaceId);
          report.step("send-child-not-killed", snap);
          return report.end("FAIL", [
            `the send child did not die at its kill point (signal ${send.signal ?? "none"}, code ${send.code ?? "none"}); the restart is not run`,
          ]);
        }
        const preCrash = await ports.db.snapshot(state.orderId, state.workspaceId);
        const preRestart = preRestartAssertions(args.scenario, preCrash);
        state = updateState(ports, args.statePath, (s) => {
          s.results.preCrash = preCrash;
          s.results.preRestart = preRestart;
        });
        report.step("after-crash", preCrash);

        if (args.adapter === "arc") {
          if (!ports.rpc) return report.end("BLOCKED", ["no RPC client"]);
          const rpc = ports.rpc;
          const startNonce = BigInt(state.baseline!.startNonce);
          const mined = await waitUntil(
            async () => {
              const logs = await readSettlementLogs(rpc, contract, state.orderId, BigInt(state.baseline!.deployBlock));
              const latest = await readNonce(rpc, signer, "latest");
              return logs.length >= 1 && latest > startNonce;
            },
            { timeoutMs: CRASH_WAIT_MS, pollMs: POLL_MS, now: ports.now, sleep: ports.sleep }
          );
          report.step("wait-for-mining", { mined, timeoutMs: CRASH_WAIT_MS });
          if (!mined) {
            return report.end("FAIL", ["the crashed transfer was not mined within the bound; the restart is not run, nothing was sent again"]);
          }
        }

        assertPhaseAllowed(state, "recover", args);
        const recover = await ports.spawnPhase(childArgs(args, "recover"), CHILD_TIMEOUT_MS);
        report.child("recover", recover);
        state = updateState(ports, args.statePath, (s) => {
          s.results.recover = recover.result ?? null;
        });
        if (recover.code === 2) {
          const stop = childStop(recover);
          return report.end(stop.result, stop.reasons);
        }
        if (recover.code !== 0 || recover.result === undefined) {
          return report.end("FAIL", ["the recover process did not finish cleanly; nothing further was sent"]);
        }
      }
    }

    const verdict = await verifyRun(args, state, ports, report);
    return report.end(verdict);
  } catch (error) {
    if (error instanceof RefusedError) return report.end("REFUSED", error.reasons);
    if (error instanceof BlockedError) return report.end("BLOCKED", [error.message]);
    const reason = error instanceof Error ? error.message : "unknown error";
    return report.end("FAIL", [`unexpected error: ${reason}`]);
  } finally {
    await ports.db.close().catch(() => undefined);
  }
}

/**
 * What a child that exited 2 says. A blocked read (the RPC or the database could not be reached) is BLOCKED; a guard that
 * refused is REFUSED. Either way the child sent nothing, and the reasons are the child's own, already redacted.
 */
function childStop(outcome: ChildOutcome): { result: RunResult; reasons: string[] } {
  const line = [...outcome.lines].reverse().find((l) => l.startsWith(RESULT_PREFIX));
  if (line) {
    try {
      const parsed = JSON.parse(line.slice(RESULT_PREFIX.length)) as { blocked?: boolean; reason?: string; reasons?: string[] };
      if (parsed.blocked === true) return { result: "BLOCKED", reasons: [String(parsed.reason ?? "a read was blocked")] };
      if (Array.isArray(parsed.reasons) && parsed.reasons.length > 0) return { result: "REFUSED", reasons: parsed.reasons };
    } catch {
      // fall through
    }
  }
  return { result: "REFUSED", reasons: ["a child process refused the run before sending"] };
}

// ---------------------------------------------------------------------------------------------------------------------
// The child phases (send-child, recover). These run in their own process and are the only code that can send.
// ---------------------------------------------------------------------------------------------------------------------

export interface TickSummary {
  report: unknown;
  snapshot: SettlementSnapshot;
}

/** The guarded adapter for this process. Arc uses ArcL1SettlementAdapter; local-sim uses the simulator. */
export function buildAdapter(
  args: CliArgs,
  env: Env,
  timeoutInjection: boolean,
  onBroadcast: (hash: Hex) => void,
  forward: RpcCall | undefined
): SettlementAdapter {
  if (args.adapter === "local-sim") return new LocalSettlementSimulator();
  const transport = timeoutInjection && forward ? makeTimeoutTransport(forward, onBroadcast) : undefined;
  return new ArcL1SettlementAdapter({
    rpcUrl: env.ARC_RPC_URL,
    chainId: ARC_TESTNET_CHAIN_ID,
    contractAddress: APPROVED_SETTLEMENT_ADDRESS,
    signerPrivateKey: env.ARC_SIGNER_PRIVATE_KEY as Hex,
    deployBlock: BigInt(env.BIND_SETTLEMENT_DEPLOY_BLOCK ?? "0"),
    transport,
  });
}

/** The child's result line. It is redacted by the emitter, and it carries no URL or key. */
function emitResult(emit: (text: string) => void, value: unknown): void {
  emit(`${RESULT_PREFIX}${jsonText(value)}`);
}

export async function runChildPhase(args: CliArgs, env: Env, emit: (text: string) => void, open: () => Promise<HarnessDb>): Promise<number> {
  const phase: ChildPhase = args.phase === "send-child" ? "send" : "recover";
  const rpc = args.adapter === "arc" && env.ARC_RPC_URL ? httpRpc(env.ARC_RPC_URL) : undefined;
  const signer = signerAddressOf(env.ARC_SIGNER_PRIVATE_KEY) ?? LOCAL_SIM_PAYER;
  const contract = env.BIND_SETTLEMENT_ADDRESS ?? APPROVED_SETTLEMENT_ADDRESS;
  const files = realFiles(makeScrubber(env));
  let database: HarnessDb | undefined;
  try {
    const failures = staticGuards(env, args, false);
    if (failures.length > 0) throw new RefusedError(failures.map((f) => f.reason));
    const state = loadState(files, args.statePath);
    if (state === null) throw new RefusedError(["no prepared state for this scenario: run the prepare phase first"]);
    assertPhaseAllowed(state, phase, args);
    if (!state.baseline) throw new RefusedError(["the baseline is missing: the orchestrator has not started the send"]);
    if (rpc) {
      await assertContractGuards(rpc, { contract, signer, vendor: VENDOR_ADDRESS });
      await assertDeployBlockCode(rpc, contract, BigInt(env.BIND_SETTLEMENT_DEPLOY_BLOCK ?? "0"));
    }

    const db = await open();
    database = db;
    const total = await db.orderTotalCents(state.orderId, state.workspaceId);
    if (total !== PAYMENT_CENTS) throw new RefusedError([`the order total is not ${PAYMENT_LABEL}; nothing is sent`]);

    // The state records that the send (or the recover) started, before anything is sent.
    const stamp = new Date().toISOString();
    if (phase === "send") state.sendStartedAt = stamp;
    else state.recoverStartedAt = stamp;
    files.write(args.statePath, jsonText(state, true), "overwrite");

    // Every send this process makes, by hash: a transport broadcast (arc) or a simulated transfer (local-sim).
    const broadcasts: string[] = [];
    const adapter = buildAdapter(args, env, args.scenario === "timeout-retry", (hash) => broadcasts.push(hash), rpc);
    const guardCfg = { contract, signer, vendor: VENDOR_ADDRESS };
    let armedOnce = false;
    // The local-sim timeout: the transfer has been made (it is recorded), and the call then fails with a timeout.
    const timeoutAfterTransfer = async (result: TransferResult) => {
      if (armedOnce) return;
      armedOnce = true;
      broadcasts.push(result.txHash);
      throw new Error("RPC request timed out after the transaction was sent");
    };
    const kill = (): never => {
      emit(KILL_ARMED_MARK);
      process.kill(process.pid, "SIGKILL");
      throw new Error("unreachable: the process was killed");
    };
    const guarded = guardedAdapter(
      adapter,
      {
        beforeTransfer: async () => {
          if (rpc) {
            await assertContractGuards(rpc, guardCfg);
            await assertNotSettled(rpc, contract, state.orderId);
          }
        },
        afterTransfer:
          phase === "send" && args.scenario === "crash-before-record"
            ? async () => kill()
            : phase === "send" && args.scenario === "timeout-retry" && args.adapter === "local-sim"
              ? timeoutAfterTransfer
              : undefined,
        beforeConfirm: phase === "send" && args.scenario === "crash-before-confirm" ? async () => kill() : undefined,
      },
      { payer: signer, vendor: VENDOR_ADDRESS, orderId: state.orderId }
    );

    const { ProcurementWorkflowRunner } = await import("../src/workflows/procurement.js");
    const runner = new ProcurementWorkflowRunner({ settlementFor: () => guarded });
    const orderId = state.orderId;
    const workspaceId = state.workspaceId;

    if (phase === "send" && args.scenario !== "timeout-retry") {
      emit(`sending one ${PAYMENT_LABEL} for the prepared order`);
      const result = await runner.fulfillAndReconcile(orderId, workspaceId);
      // Reaching this line means the crash point was not reached. The parent treats it as unexpected.
      emitResult(emit, { unexpectedReturn: true, result: result as unknown as Record<string, unknown> });
      return 1;
    }
    if (phase === "send") {
      const seq = await timeoutSequence({
        runner,
        orderId,
        workspaceId,
        db: database,
        rpc,
        signer,
        contract,
        deployBlock: BigInt(env.BIND_SETTLEMENT_DEPLOY_BLOCK ?? "0"),
        adapter: args.adapter,
        broadcasts,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      emitResult(emit, seq);
      return 0;
    }
    // recover
    const recover = await recoverSequence({
      scenario: args.scenario,
      runner,
      orderId,
      workspaceId,
      db: database,
      rpc,
      signer,
      guardedSettlementFor: () => guarded,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    emitResult(emit, recover);
    return 0;
  } catch (error) {
    if (error instanceof RefusedError) {
      emitResult(emit, { refused: true, reasons: error.reasons });
      return 2;
    }
    if (error instanceof BlockedError) {
      emitResult(emit, { blocked: true, reason: error.message });
      return 2;
    }
    const reason = error instanceof Error ? error.message : "unknown error";
    emitResult(emit, { failed: true, reason });
    return 1;
  } finally {
    if (database) await database.close().catch(() => undefined);
  }
}

/** The timeout scenario's calls, in order. Attempt 2 is immediate; attempt 3 runs after the transfer is mined. */
async function timeoutSequence(input: {
  runner: { fulfillAndReconcile(orderId: string, workspaceId: string): Promise<unknown> };
  orderId: string;
  workspaceId: string;
  db: HarnessDb;
  rpc: RpcCall | undefined;
  signer: string;
  contract: string;
  deployBlock: bigint;
  adapter: AdapterKind;
  broadcasts: string[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<Record<string, unknown>> {
  const attempts: AttemptRecord[] = [];
  const attempt = async (name: string): Promise<void> => {
    try {
      const result = (await input.runner.fulfillAndReconcile(input.orderId, input.workspaceId)) as RepeatFact & { status?: string; txHash?: string };
      attempts.push({ name, ok: true, result });
    } catch (error) {
      const err = error as { name?: string; message?: string };
      attempts.push({ name, ok: false, error: { name: err?.name ?? "Error", message: String(err?.message ?? "") } });
    }
  };
  const out: Record<string, unknown> = { attempts, broadcasts: input.broadcasts };
  await attempt("attempt-1");
  out.afterAttempt1 = await input.db.snapshot(input.orderId, input.workspaceId);
  const a1 = out.afterAttempt1 as SettlementSnapshot;
  out.broadcastsAfterAttempt1 = input.broadcasts.length;
  if (input.broadcasts.length !== 1) {
    out.stopped = `attempt 1 did not broadcast exactly once (${input.broadcasts.length} broadcasts)`;
    return out;
  }
  if (attempts[0].ok || a1.status !== "confirmed" || a1.effect?.status !== "failed") {
    out.stopped = `attempt 1 did not give the expected unknown outcome (order ${a1.status}, effect ${a1.effect?.status ?? "none"})`;
    return out;
  }
  await attempt("attempt-2-immediate");
  out.afterAttempt2 = await input.db.snapshot(input.orderId, input.workspaceId);
  if (input.rpc) {
    const rpc = input.rpc;
    const mined = await waitUntil(
      async () => {
        const logs = await readSettlementLogs(rpc, input.contract, input.orderId, input.deployBlock);
        const latest = await readNonce(rpc, input.signer, "latest");
        const pending = await readNonce(rpc, input.signer, "pending");
        return logs.length >= 1 && latest === pending;
      },
      { timeoutMs: TIMEOUT_WAIT_MS, pollMs: POLL_MS, now: input.now, sleep: input.sleep }
    );
    if (!mined) {
      out.stopped = "the transfer was not mined within the bound; the third call is not made";
      return out;
    }
    out.minedBeforeAttempt3 = true;
  }
  await attempt("attempt-3-after-mining");
  out.afterAttempt3 = await input.db.snapshot(input.orderId, input.workspaceId);
  return out;
}

/** The restart. Each step is a tick (the worker's own code) or a fulfillAndReconcile (Bind's own code), in the scenario's order. */
async function recoverSequence(input: {
  scenario: Scenario;
  runner: { fulfillAndReconcile(orderId: string, workspaceId: string): Promise<unknown> };
  orderId: string;
  workspaceId: string;
  db: HarnessDb;
  rpc: RpcCall | undefined;
  signer: string;
  guardedSettlementFor: () => SettlementAdapter;
  sleep: (ms: number) => Promise<void>;
}): Promise<{ steps: Record<string, unknown>[] }> {
  const { runTick } = await import("../src/workers/runner.js");
  const steps: Record<string, unknown>[] = [];
  for (const kind of scenarioRecoverPlan(input.scenario)) {
    if (kind === "tick") {
      const tick = await runTick({
        // A minute ahead, so rows the database clock stamped a moment ago still count as stale.
        now: new Date(Date.now() + TICK_CLOCK_MARGIN_MS),
        stuckSettlingAfterMs: 0,
        confirmAfterMs: 0,
        maxPollAgeMs: ONE_WEEK_MS,
        // Nothing is resumed by the recovery step: the workflows of this run are not restarted.
        staleAfterMs: ONE_YEAR_MS,
        deps: { settlementFor: input.guardedSettlementFor },
      });
      steps.push({ name: "tick", report: tick, snapshot: await input.db.snapshot(input.orderId, input.workspaceId) });
      continue;
    }
    const nonceBefore = input.rpc ? (await readNonce(input.rpc, input.signer, "latest")).toString() : undefined;
    let result: unknown;
    let error: { name: string; message: string } | undefined;
    try {
      result = await input.runner.fulfillAndReconcile(input.orderId, input.workspaceId);
    } catch (err) {
      const e = err as { name?: string; message?: string };
      error = { name: e?.name ?? "Error", message: String(e?.message ?? "") };
    }
    const nonceAfter = input.rpc ? (await readNonce(input.rpc, input.signer, "latest")).toString() : undefined;
    steps.push({
      name: kind,
      result,
      error,
      nonceBefore,
      nonceAfter,
      snapshot: await input.db.snapshot(input.orderId, input.workspaceId),
    });
  }
  return { steps };
}

// ---------------------------------------------------------------------------------------------------------------------
// The real edges: files, the database, child processes, the entrypoint
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The real files port. Every write goes through `scrub` first, the same redaction as stdout, so the evidence file and the
 * state file never hold the RPC URL, its path segments, the key or the database URL.
 */
export function realFiles(scrub: (text: string) => string = (text) => text): HarnessPorts["files"] {
  return {
    exists: (file) => fs.existsSync(file),
    read: (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null),
    write: (file, text, mode) => fs.writeFileSync(file, scrub(text), { flag: mode === "new" ? "wx" : "w" }),
  };
}

export async function openRealDb(): Promise<HarnessDb> {
  const { query, closePool } = await import("../src/db/client.js");
  const { provisionWorkspace } = await import("../src/templates/registry.js");
  const { ProcurementWorkflowRunner } = await import("../src/workflows/procurement.js");
  return {
    async prepare({ scenario, payer, vendor, adapter }) {
      // Short on purpose: order and effect keys are derived from this id, and the id columns are VARCHAR(64).
      const workspaceId = `ws-live-${Date.now().toString(36)}-${crypto.randomBytes(2).toString("hex")}`;
      await provisionWorkspace(workspaceId, `Live recovery ${scenario} (${adapter})`, "kitchen-v1", {
        customDailyLimitCents: 100000n,
        customApprovalThresholdCents: 25000n,
      });
      await query(`UPDATE workspaces SET settlement_address = $2 WHERE id = $1;`, [workspaceId, payer]);
      const started = await new ProcurementWorkflowRunner().startReplenishment(workspaceId, "FOOD-FLOUR-50LB");
      if (!started.orderId) throw new Error(`prepare: no order was created (workflow state ${started.state})`);
      const orderId = started.orderId;
      const sup = await query(`SELECT supplier_id FROM orders WHERE id = $1;`, [orderId]);
      await query(`UPDATE suppliers SET verified = TRUE, payment_address = $2 WHERE id = $1;`, [sup.rows[0].supplier_id, vendor]);
      // Fixture: one unit at one cent, so the payable amount is exactly 1 cent. Nothing in the harness makes it configurable.
      await query(`UPDATE orders SET quantity = 1, unit_price_cents = 1, total_price_cents = 1 WHERE id = $1;`, [orderId]);
      await query(`UPDATE workspaces SET settlement_mode = $2 WHERE id = $1;`, [workspaceId, adapter === "arc" ? "arc-testnet" : "local"]);
      const row = await query(`SELECT status FROM orders WHERE id = $1;`, [orderId]);
      return {
        workspaceId,
        orderId,
        workflowId: started.workflowId ?? null,
        orderStatus: String(row.rows[0].status),
      };
    },
    async orderTotalCents(orderId, workspaceId) {
      const res = await query(`SELECT total_price_cents FROM orders WHERE id = $1 AND workspace_id = $2;`, [orderId, workspaceId]);
      if (res.rows.length === 0) throw new Error("the order is not in this workspace");
      return BigInt(res.rows[0].total_price_cents);
    },
    async snapshot(orderId, workspaceId) {
      const order = (
        await query(
          `SELECT status, tx_hash, settlement_submitted_at, settlement_confirmed_at, settlement_confirmed_block, settled_amount_cents
           FROM orders WHERE id = $1;`,
          [orderId]
        )
      ).rows[0];
      const effect = (
        await query(`SELECT status, attempts, operation, external_ref FROM effects WHERE idempotency_key = $1;`, [
          `${workspaceId}:settle:${orderId}`,
        ])
      ).rows[0];
      const audits = (
        await query(
          `SELECT action FROM audit_logs WHERE workspace_id = $1 AND action LIKE 'settlement.%' ORDER BY created_at ASC, id ASC;`,
          [workspaceId]
        )
      ).rows as { action: string }[];
      return toSnapshot(order, effect, audits);
    },
    close: () => closePool(),
  };
}

/** Splits a stream into lines, keeping a partial line until its end arrives. */
function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; flush(): void } {
  let pending = "";
  return {
    push(chunk: Buffer) {
      pending += chunk.toString("utf8");
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        onLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    },
    flush() {
      if (pending.length > 0) onLine(pending);
      pending = "";
    },
  };
}

/** Runs one child phase: this script again, under tsx, with the same environment and no added variables. */
export function spawnChildProcess(childArgv: string[], timeoutMs: number, scrub: (text: string) => string): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...childArgv], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const lines: string[] = [];
    const keep = (line: string) => lines.push(scrub(line));
    const out = lineSplitter(keep);
    const err = lineSplitter(keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      out.flush();
      err.flush();
      const resultLine = [...lines].reverse().find((l) => l.startsWith(RESULT_PREFIX));
      let result: unknown;
      if (resultLine) {
        try {
          result = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
        } catch {
          result = undefined;
        }
      }
      resolve({ code, signal, timedOut, result, lines });
    });
  });
}

function realPorts(env: Env, emit: (text: string) => void, scrub: (text: string) => string): HarnessPorts {
  let dbPromise: Promise<HarnessDb> | undefined;
  const db = (): Promise<HarnessDb> => (dbPromise ??= openRealDb());
  return {
    env,
    emit,
    notify: (text) => {
      process.stderr.write(`${scrub(text)}\n`);
    },
    files: realFiles(scrub),
    rpc: env.ARC_RPC_URL && isHttpUrl(env.ARC_RPC_URL) ? httpRpc(env.ARC_RPC_URL) : undefined,
    db: {
      prepare: async (input) => (await db()).prepare(input),
      orderTotalCents: async (orderId, workspaceId) => (await db()).orderTotalCents(orderId, workspaceId),
      snapshot: async (orderId, workspaceId) => (await db()).snapshot(orderId, workspaceId),
      close: async () => {
        if (dbPromise) await (await dbPromise).close();
      },
    },
    spawnPhase: (argv, timeoutMs) => spawnChildProcess(argv, timeoutMs, scrub),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** The command. Child phases and the orchestrator share this entry point. Returns the exit code. */
export async function cli(argv: string[], env: Env = process.env): Promise<number> {
  const scrub = makeScrubber(env);
  const emit = (text: string) => {
    process.stdout.write(`${scrub(text)}\n`);
  };
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : USAGE;
    emit(jsonText({ result: "REFUSED", reasons: [reason] }, true));
    return 2;
  }
  if (args.phase === "send-child" || args.phase === "recover") {
    return runChildPhase(args, env, emit, openRealDb);
  }
  return runOrchestrator(args, realPorts(env, emit, scrub));
}

const isEntrypoint = process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isEntrypoint) {
  cli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const scrub = makeScrubber(process.env);
      const message = scrub(error instanceof Error ? error.message : String(error));
      process.stdout.write(`${jsonText({ result: "FAIL", reasons: [message] }, true)}\n`);
      process.exitCode = 1;
    }
  );
}
