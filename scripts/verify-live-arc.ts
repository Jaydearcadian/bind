/**
 * Read-only live checks against the Arc Testnet RPC and the deployed BindSettlement (docs/CONTRACT_SCOPE.md, section 2).
 *
 * Usage:  ARC_RPC_URL=<arc-rpc-url-with-token> npx tsx scripts/verify-live-arc.ts [--write-evidence <new-file>]
 *
 * Rules (docs/decisions/0039-contract-properties-and-live-check.md):
 * - A gate is LIVE_READ_PASS only when the call succeeded and its output matches the expectation. For a revert gate the
 *   expectation is the revert selector in the output, and a successful call is never a pass.
 * - A missing `cast` binary, a spawn error, a timeout, an RPC HTTP error, a network error, an unconfigured RPC URL or a
 *   failure that does not match a revert is BLOCKED, with the reason. Those are never passes.
 * - A successful call whose output does not match is FAILED.
 * - Every call here is a read or an eth_call. Nothing is signed or sent, so no gate can produce VERIFIED_REMOTE.
 * - The script writes nothing unless `--write-evidence <path>` is given, and then only to a NEW file at that path. It
 *   never appends to docs/RELEASE_EVIDENCE.md.
 * - No output line and no evidence line contains the RPC URL or its token (redacted with src/utils/redact.ts).
 * - Exit code 0 only when every gate is LIVE_READ_PASS. Otherwise 1 (2 for a usage error).
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactText } from "../src/utils/redact.js";

export const EXPECTED_CHAIN_ID = 5042002;
export const BIND_SETTLEMENT_CONTRACT = "0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29";
export const WHITELISTED_SUPPLIER = "0xa8358AED200D6CB6C856F972D853C1be833006ea";
export const UNAPPROVED_SUPPLIER = "0x000000000000000000000000000000000000dEaD";
export const SELECTOR_VENDOR_NOT_WHITELISTED = "0x65e822e9";
export const SELECTOR_DAILY_LIMIT_EXCEEDED = "0xef664d6a";
export const DEFAULT_CONFIRMED_TX = "0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb";

const PLACEHOLDER = "<ARC_RPC_TOKEN>";
const CAST_TIMEOUT_MS = 30_000;
const RPC_TIMEOUT_MS = 15_000;

/** Evidence statuses. FAILED is added for a successful call whose output does not match (docs/TESTING_AND_RELEASE_GATES.md, section 10). */
export type EvidenceStatus =
  | "LOCAL_PASS"
  | "LIVE_READ_PASS"
  | "VERIFIED_REMOTE"
  | "NOT_RUN"
  | "BLOCKED"
  | "FAILED"
  | "SIMULATED";

/** The statuses this script can produce. VERIFIED_REMOTE is never one of them: every call here is read-only. */
export type LiveGateStatus = Extract<EvidenceStatus, "LIVE_READ_PASS" | "BLOCKED" | "FAILED">;

export interface GateResult {
  gate: string;
  status: LiveGateStatus;
  detail: string;
}

/** What a cast run produced. A spawn problem or a timeout is not a completed run, so it has no exit code. */
export type CastOutcome =
  | { kind: "completed"; exitCode: number; stdout: string; stderr: string }
  | { kind: "missing_binary" }
  | { kind: "spawn_error"; message: string }
  | { kind: "timeout" };

export interface CastRequest {
  args: string[];
  rpcUrl: string;
  timeoutMs: number;
}

export type CastExec = (request: CastRequest) => Promise<CastOutcome>;

export interface RpcRequest {
  url: string;
  method: string;
  params: unknown[];
  timeoutMs: number;
}

/**
 * Transport failure of a JSON-RPC request. It carries a kind and, for HTTP, the status. It never carries the URL or the
 * underlying message, because those can contain the token.
 */
export class RpcTransportError extends Error {
  constructor(
    readonly kind: "http" | "network" | "timeout" | "invalid_json",
    readonly status?: number
  ) {
    super(`rpc ${kind}${status !== undefined ? ` ${status}` : ""}`);
    this.name = "RpcTransportError";
  }
}

/** A JSON-RPC response body: either a result or an error object. */
export type RpcBody = { result?: unknown; error?: { code?: number; message?: string } };

export type RpcCall = (request: RpcRequest) => Promise<RpcBody>;

export interface LiveArcDeps {
  exec: CastExec;
  rpc: RpcCall;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now: () => Date;
}

export interface LiveArcReport {
  generatedAt: string;
  rpcConfigured: boolean;
  gates: GateResult[];
  /** The table, redacted. The same text that `--write-evidence` writes. */
  markdown: string;
  /** Output lines, redacted. Printed by main. */
  lines: string[];
  exitCode: 0 | 1;
}

/** The URL and the path segments that can be a token. Everything in this list is removed from every output. */
export function secretsOf(rpcUrl: string | undefined): string[] {
  if (!rpcUrl) return [];
  const found = new Set<string>([rpcUrl]);
  try {
    const url = new URL(rpcUrl);
    for (const segment of url.pathname.split("/")) {
      if (segment.length >= 8) found.add(decodeURIComponent(segment));
    }
  } catch {
    // Not a parseable URL: the whole value is already in the set.
  }
  return [...found];
}

/** Redacts every output. Uses the one redaction module (ADR 0024) with the RPC URL and its path segments as extras. */
export function scrubber(rpcUrl: string | undefined): (text: string) => string {
  const secrets = secretsOf(rpcUrl);
  return (text: string) => redactText(text, secrets);
}

/**
 * The revert selector in a cast message: the first four bytes of the revert data. Prefers `data: "0x..."`, then a
 * standalone 8-hex token such as `custom error 0xef664d6a`. A transaction hash or an address does not match.
 */
export function revertSelectorOf(text: string): string | undefined {
  const data = /data:?\s*"?(0x[0-9a-fA-F]{8,})/.exec(text);
  if (data) return data[1].slice(0, 10).toLowerCase();
  const token = /(?<![0-9a-zA-Z])(0x[0-9a-fA-F]{8})(?![0-9a-fA-F])/.exec(text);
  return token ? token[1].toLowerCase() : undefined;
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
}

function isHex(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);
}

function gate(name: string, status: LiveGateStatus, detail: string): GateResult {
  return { gate: name, status, detail };
}

const GATE_NAMES = {
  chainId: "Arc RPC chain id (eth_chainId)",
  bytecode: "BindSettlement bytecode at the configured address (eth_getCode)",
  allowlist: "Approved supplier allowlist (whitelistedVendors)",
  vendorRevert: "Negative path: unapproved supplier rejected (VendorNotWhitelisted 0x65e822e9)",
  limitRevert: "Negative path: daily cap rejected (DailyLimitExceeded 0xef664d6a)",
  receipt: "Confirmed settlement receipt (eth_getTransactionReceipt)",
} as const;

function rpcBlocked(name: string, error: unknown): GateResult {
  if (error instanceof RpcTransportError) {
    const reason =
      error.kind === "http"
        ? `RPC HTTP ${error.status}`
        : error.kind === "timeout"
          ? "RPC request timed out"
          : error.kind === "invalid_json"
            ? "RPC response was not JSON"
            : "RPC network error";
    return gate(name, "BLOCKED", `${reason}; no result`);
  }
  return gate(name, "BLOCKED", "RPC request failed; no result");
}

/** Reads the outcome of one cast run for a read gate. Only a completed exit 0 is a candidate for a pass. */
function castReadOutcome(name: string, outcome: CastOutcome, scrub: (t: string) => string): { ok: true; stdout: string } | { ok: false; result: GateResult } {
  if (outcome.kind === "missing_binary") {
    return { ok: false, result: gate(name, "BLOCKED", "cast binary not found on PATH; read not performed") };
  }
  if (outcome.kind === "spawn_error") {
    return { ok: false, result: gate(name, "BLOCKED", `cannot start cast (${scrub(outcome.message)}); read not performed`) };
  }
  if (outcome.kind === "timeout") {
    return { ok: false, result: gate(name, "BLOCKED", `cast timed out after ${CAST_TIMEOUT_MS / 1000}s; read not performed`) };
  }
  if (outcome.exitCode !== 0) {
    return {
      ok: false,
      result: gate(name, "BLOCKED", `cast exited ${outcome.exitCode} without a usable result: ${scrub(firstLine(outcome.stderr || outcome.stdout))}`),
    };
  }
  return { ok: true, stdout: outcome.stdout.trim() };
}

/**
 * Evaluates a revert gate from one cast run. The expected selector must appear in the revert data. A successful call
 * has no revert, so it cannot pass a revert gate.
 */
function castRevertGate(name: string, expected: string, outcome: CastOutcome, scrub: (t: string) => string, what: string): GateResult {
  if (outcome.kind === "missing_binary") {
    return gate(name, "BLOCKED", "cast binary not found on PATH; the revert was not checked");
  }
  if (outcome.kind === "spawn_error") {
    return gate(name, "BLOCKED", `cannot start cast (${scrub(outcome.message)}); the revert was not checked`);
  }
  if (outcome.kind === "timeout") {
    return gate(name, "BLOCKED", `cast timed out after ${CAST_TIMEOUT_MS / 1000}s; the revert was not checked`);
  }
  if (outcome.exitCode === 0) {
    return gate(name, "FAILED", `the call succeeded (output ${scrub(firstLine(outcome.stdout) || "empty")}); the expected revert did not happen`);
  }
  const selector = revertSelectorOf(`${outcome.stderr}\n${outcome.stdout}`);
  if (selector === undefined) {
    return gate(name, "BLOCKED", `cast failed without a revert selector (${scrub(firstLine(outcome.stderr || outcome.stdout))}); the revert was not checked`);
  }
  if (selector !== expected) {
    return gate(name, "FAILED", `reverted with ${selector}, expected ${expected}; ${what}`);
  }
  return gate(name, "LIVE_READ_PASS", `eth_call reverted with ${expected} as expected; read-only, nothing sent; ${what}`);
}

/** Runs the six gates. Reads env, calls exec and rpc, and writes nothing. */
export async function runLiveArcVerification(deps: LiveArcDeps): Promise<LiveArcReport> {
  const generatedAt = deps.now().toISOString();
  const rawUrl = deps.env.ARC_RPC_URL || deps.env.ARC_TESTNET_RPC_URL || "";
  const rpcUrl = rawUrl.trim();
  const configured = rpcUrl.length > 0 && !rpcUrl.includes(PLACEHOLDER);
  const scrub = scrubber(configured ? rpcUrl : undefined);
  const txHash = (deps.env.LAST_LIVE_SETTLEMENT_TX || DEFAULT_CONFIRMED_TX).trim();

  let gates: GateResult[];
  if (!configured) {
    gates = Object.values(GATE_NAMES).map((name) => gate(name, "BLOCKED", "RPC URL not configured (set ARC_RPC_URL); no call was made"));
  } else {
    gates = await evaluateGates({ deps, rpcUrl, scrub, txHash });
  }

  const safeGates = gates.map((g) => ({ gate: g.gate, status: g.status, detail: scrub(g.detail) }));
  const header = "| Gate | Status | Detail |\n| :--- | :--- | :--- |";
  const rows = safeGates.map((g) => `| ${g.gate} | \`${g.status}\` | ${g.detail} |`);
  const markdown = [
    `## Live Arc Testnet read-only checks (${generatedAt})`,
    "",
    header,
    ...rows,
    "",
  ].join("\n");
  const passed = safeGates.filter((g) => g.status === "LIVE_READ_PASS").length;
  const lines = [markdown, `summary: ${passed} of ${safeGates.length} gates LIVE_READ_PASS`].map(scrub);
  return {
    generatedAt,
    rpcConfigured: configured,
    gates: safeGates,
    markdown: scrub(markdown),
    lines,
    exitCode: passed === safeGates.length ? 0 : 1,
  };
}

async function evaluateGates(input: { deps: LiveArcDeps; rpcUrl: string; scrub: (t: string) => string; txHash: string }): Promise<GateResult[]> {
  const { deps, rpcUrl, scrub, txHash } = input;
  const rpc = async (method: string, params: unknown[]): Promise<RpcBody | RpcTransportError> => {
    try {
      const body = await deps.rpc({ url: rpcUrl, method, params, timeoutMs: RPC_TIMEOUT_MS });
      // Valid JSON that is not an object (null, a number, a string) is not a JSON-RPC response.
      if (body === null || typeof body !== "object") return new RpcTransportError("invalid_json");
      return body;
    } catch (error) {
      if (error instanceof RpcTransportError) return error;
      return new RpcTransportError("network");
    }
  };
  const cast = (args: string[]) => deps.exec({ args, rpcUrl, timeoutMs: CAST_TIMEOUT_MS }).catch((): CastOutcome => ({ kind: "spawn_error", message: "exec failed" }));

  const results: GateResult[] = [];

  // 1. Chain id.
  {
    const r = await rpc("eth_chainId", []);
    if (r instanceof RpcTransportError) results.push(rpcBlocked(GATE_NAMES.chainId, r));
    else if (r.error) results.push(gate(GATE_NAMES.chainId, "BLOCKED", `RPC returned an error for eth_chainId (${scrub(String(r.error.message ?? r.error.code))})`));
    else if (!isHex(r.result)) results.push(gate(GATE_NAMES.chainId, "FAILED", "eth_chainId returned something that is not a hex number"));
    else {
      const chainId = parseInt(r.result, 16);
      results.push(
        chainId === EXPECTED_CHAIN_ID
          ? gate(GATE_NAMES.chainId, "LIVE_READ_PASS", `chain id ${chainId} matches ${EXPECTED_CHAIN_ID}`)
          : gate(GATE_NAMES.chainId, "FAILED", `chain id ${chainId}, expected ${EXPECTED_CHAIN_ID}`)
      );
    }
  }

  // 2. Bytecode at the contract address.
  {
    const r = await rpc("eth_getCode", [BIND_SETTLEMENT_CONTRACT, "latest"]);
    if (r instanceof RpcTransportError) results.push(rpcBlocked(GATE_NAMES.bytecode, r));
    else if (r.error) results.push(gate(GATE_NAMES.bytecode, "BLOCKED", `RPC returned an error for eth_getCode (${scrub(String(r.error.message ?? r.error.code))})`));
    else if (!isHex(r.result) || r.result.length <= 2) results.push(gate(GATE_NAMES.bytecode, "FAILED", "no bytecode at the configured address"));
    else results.push(gate(GATE_NAMES.bytecode, "LIVE_READ_PASS", `bytecode present at ${BIND_SETTLEMENT_CONTRACT} (${r.result.length} hex characters)`));
  }

  // 3. Allowlist read through cast.
  {
    const out = await cast(["call", BIND_SETTLEMENT_CONTRACT, "whitelistedVendors(address)(bool)", WHITELISTED_SUPPLIER]);
    const read = castReadOutcome(GATE_NAMES.allowlist, out, scrub);
    if (!read.ok) results.push(read.result);
    else if (read.stdout === "true") results.push(gate(GATE_NAMES.allowlist, "LIVE_READ_PASS", `whitelistedVendors(${WHITELISTED_SUPPLIER}) = true`));
    else results.push(gate(GATE_NAMES.allowlist, "FAILED", `whitelistedVendors(${WHITELISTED_SUPPLIER}) = ${scrub(read.stdout)}, expected true`));
  }

  // 4. Unapproved supplier must revert with VendorNotWhitelisted.
  {
    const out = await cast([
      "call",
      BIND_SETTLEMENT_CONTRACT,
      "settleOrder(bytes32,address,bytes32)",
      "0x1111111111111111111111111111111111111111111111111111111111111111",
      UNAPPROVED_SUPPLIER,
      "0x2222222222222222222222222222222222222222222222222222222222222222",
      "--value",
      "1000000000000000",
    ]);
    results.push(castRevertGate(GATE_NAMES.vendorRevert, SELECTOR_VENDOR_NOT_WHITELISTED, out, scrub, "0.001 USDC to an unapproved supplier"));
  }

  // 5. A 2.0 USDC settlement must revert with DailyLimitExceeded.
  {
    const out = await cast([
      "call",
      BIND_SETTLEMENT_CONTRACT,
      "settleOrder(bytes32,address,bytes32)",
      "0x3333333333333333333333333333333333333333333333333333333333333333",
      WHITELISTED_SUPPLIER,
      "0x4444444444444444444444444444444444444444444444444444444444444444",
      "--value",
      "2000000000000000000",
    ]);
    results.push(castRevertGate(GATE_NAMES.limitRevert, SELECTOR_DAILY_LIMIT_EXCEEDED, out, scrub, "2.0 USDC against the daily limit"));
  }

  // 6. The recorded settlement receipt.
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    results.push(gate(GATE_NAMES.receipt, "BLOCKED", "LAST_LIVE_SETTLEMENT_TX is not a 32-byte transaction hash; no call was made"));
  } else {
    const r = await rpc("eth_getTransactionReceipt", [txHash]);
    if (r instanceof RpcTransportError) results.push(rpcBlocked(GATE_NAMES.receipt, r));
    else if (r.error) results.push(gate(GATE_NAMES.receipt, "BLOCKED", `RPC returned an error for eth_getTransactionReceipt (${scrub(String(r.error.message ?? r.error.code))})`));
    else if (r.result === null || typeof r.result !== "object") results.push(gate(GATE_NAMES.receipt, "FAILED", `no receipt returned for ${txHash}`));
    else {
      const receipt = r.result as { status?: unknown; blockNumber?: unknown };
      if (receipt.status !== "0x1") {
        results.push(gate(GATE_NAMES.receipt, "FAILED", `receipt status ${String(receipt.status)}, expected 0x1`));
      } else {
        const block = isHex(receipt.blockNumber) ? parseInt(receipt.blockNumber, 16) : "unknown";
        results.push(gate(GATE_NAMES.receipt, "LIVE_READ_PASS", `${txHash} status 0x1 in block ${block}`));
      }
    }
  }

  return results;
}

/** The real cast runner. Passes the RPC URL to cast in the environment, not on the command line. */
export const execCast: CastExec = (request) =>
  new Promise<CastOutcome>((resolve) => {
    execFile(
      "cast",
      request.args,
      { timeout: request.timeoutMs, env: { ...process.env, ETH_RPC_URL: request.rpcUrl }, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ kind: "completed", exitCode: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          resolve({ kind: "missing_binary" });
          return;
        }
        if ((error as { killed?: boolean }).killed && (error as { signal?: string }).signal) {
          resolve({ kind: "timeout" });
          return;
        }
        if (typeof code === "number") {
          resolve({ kind: "completed", exitCode: code, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        resolve({ kind: "spawn_error", message: error.message });
      }
    );
  });

/** The real JSON-RPC call. Errors carry a kind and a status, never the URL. */
export const fetchRpc: RpcCall = async ({ url, method, params, timeoutMs }) => {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = (error as { name?: string }).name;
    throw new RpcTransportError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
  }
  if (!response.ok) throw new RpcTransportError("http", response.status);
  try {
    return (await response.json()) as RpcBody;
  } catch {
    throw new RpcTransportError("invalid_json");
  }
};

export interface MainDeps extends LiveArcDeps {
  log: (line: string) => void;
  /** Writes a new file. The default uses flag "wx", so an existing file is never replaced. */
  writeNewFile: (filePath: string, text: string) => Promise<void>;
  fileExists: (filePath: string) => Promise<boolean>;
}

export function defaultMainDeps(): MainDeps {
  return {
    exec: execCast,
    rpc: fetchRpc,
    env: process.env,
    now: () => new Date(),
    log: (line) => console.log(line),
    writeNewFile: (filePath, text) => fs.writeFile(filePath, text, { encoding: "utf8", flag: "wx" }),
    fileExists: async (filePath) => fs
      .access(filePath)
      .then(() => true)
      .catch(() => false),
  };
}

/**
 * The command line. With no argument it prints the table and writes nothing. With `--write-evidence <path>` it writes the
 * table to that path, which must not exist yet. Returns the exit code.
 */
export async function main(argv: string[], deps: MainDeps = defaultMainDeps()): Promise<number> {
  let writePath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--write-evidence") {
      writePath = argv[i + 1];
      if (!writePath) {
        deps.log("usage: verify-live-arc.ts [--write-evidence <new-file>]");
        return 2;
      }
      i++;
    } else if (arg.startsWith("--write-evidence=")) {
      writePath = arg.slice("--write-evidence=".length);
    } else {
      deps.log("usage: verify-live-arc.ts [--write-evidence <new-file>]");
      return 2;
    }
  }

  const report = await runLiveArcVerification(deps);
  for (const line of report.lines) deps.log(line);

  if (writePath !== undefined) {
    const target = path.resolve(writePath);
    if (await deps.fileExists(target)) {
      deps.log(`refusing to overwrite ${path.basename(target)}; choose a new file name`);
      return 2;
    }
    await deps.writeNewFile(target, `${report.markdown}\n`);
    deps.log(`wrote ${path.basename(target)} (new file)`);
  }
  return report.exitCode;
}

const isEntrypoint = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = redactText(error instanceof Error ? error.message : String(error), secretsOf(process.env.ARC_RPC_URL));
      console.error(`[VERIFY_LIVE_ARC_FAILED] ${message}`);
      process.exitCode = 2;
    }
  );
}
