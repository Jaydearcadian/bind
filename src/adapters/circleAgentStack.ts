import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const ARC_TESTNET_CHAIN = "ARC-TESTNET";
export const ARC_TESTNET_RPC =
  process.env.ARC_RPC_URL ||
  process.env.RPC_URL ||
  "https://rpc.testnet.arc-node.thecanteenapp.com/v1/<ARC_RPC_TOKEN>";
export const BIND_SETTLEMENT_CONTRACT =
  "0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29";
export const WHITELISTED_VENDOR =
  "0xa8358AED200D6CB6C856F972D853C1be833006ea";

export interface CircleContractQueryResult {
  command: string;
  rawOutput: string;
  executionMode: "LIVE_CIRCLE_CLI_ARC_TESTNET" | "SIMULATED_NO_LIVE_CLI";
  /** `null` when nothing was actually read (simulated, failed, or unparsable). */
  whitelisted: boolean | null;
}

export interface CircleSettlementExecutionResult {
  command: string;
  txHash?: string;
  rawOutput: string;
  chain: typeof ARC_TESTNET_CHAIN;
  contractAddress: typeof BIND_SETTLEMENT_CONTRACT;
  paymentStatus:
    | "SIMULATED_LOCAL"
    | "SUBMITTED_ON_ARC_TESTNET"
    | "REJECTED_BY_ONCHAIN_POLICY"
    | "OUTCOME_UNKNOWN";
  fulfilmentStatus: "AWAITING_PHYSICAL_DELIVERY_3WAY_MATCH";
  executionMode: "LIVE_CIRCLE_CLI_ARC_TESTNET" | "SIMULATED_NO_LIVE_CLI";
}

export type CircleExec = (
  file: string,
  args: string[],
  opts: { timeout: number }
) => Promise<{ stdout: string }>;

export interface CircleAgentStackDeps {
  exec?: CircleExec;
  env?: Record<string, string | undefined>;
}

// Commands that move USDC or alter wallet security on Circle Agent Stack
const APPROVAL_REQUIRED_PREFIXES = [
  "wallet execute",
  "wallet transfer",
  "wallet sign",
  "wallet limit set",
  "services pay",
  "bridge transfer",
  "gateway deposit",
];

// Failure text that means the contract itself refused the call.
const POLICY_REJECTION_PATTERN = /revert|DailyLimitExceeded|VendorNotWhitelisted|OrderAlreadySettled/i;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const SIMULATED_RAW_OUTPUT = JSON.stringify({
  status: "simulated",
  note: "live Circle CLI not enabled",
});

const defaultExec: CircleExec = async (file, args, opts) => {
  const { stdout } = await execFileAsync(file, args, opts);
  return { stdout: String(stdout) };
};

export function requiresOwnerApprovalGate(circleArgs: string[]): boolean {
  const joined = circleArgs.join(" ");
  return APPROVAL_REQUIRED_PREFIXES.some((prefix) => joined.startsWith(prefix));
}

const ENABLED_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);

/** Explicit opt-in parsing: only the listed values enable a flag. "0", "false" and unset stay off. */
export function isFlagEnabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  return ENABLED_FLAG_VALUES.has(value.trim().toLowerCase());
}

function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>)]+/gi, "[redacted-url]");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined;
}

/** Every text the failed CLI run produced, used only to classify the failure. */
function errorText(err: unknown): string {
  const parts = [errorMessage(err)];
  if (typeof err === "object" && err !== null) {
    const { stderr, stdout } = err as { stderr?: unknown; stdout?: unknown };
    for (const candidate of [textOf(stderr), textOf(stdout)]) {
      if (candidate) parts.push(candidate);
    }
  }
  return parts.join("\n");
}

/** A killed or timed-out process never proves the contract refused the call. */
function wasKilledOrTimedOut(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { killed, code, signal } = err as { killed?: unknown; code?: unknown; signal?: unknown };
  return killed === true || code === "ETIMEDOUT" || (typeof signal === "string" && signal.length > 0);
}

function classifyLiveFailure(err: unknown): "REJECTED_BY_ONCHAIN_POLICY" | "OUTCOME_UNKNOWN" {
  if (wasKilledOrTimedOut(err)) return "OUTCOME_UNKNOWN";
  return POLICY_REJECTION_PATTERN.test(errorText(err)) ? "REJECTED_BY_ONCHAIN_POLICY" : "OUTCOME_UNKNOWN";
}

function parseWhitelisted(stdout: string): boolean | null {
  try {
    const parsed = JSON.parse(stdout) as { data?: { result?: unknown } } | null;
    const result = parsed?.data?.result;
    return typeof result === "boolean" ? result : null;
  } catch {
    return null;
  }
}

/** A transaction hash only counts when the CLI output parses and carries a 32-byte hex hash. */
function parseTxHash(stdout: string): string | undefined {
  let parsed: { data?: { txHash?: unknown }; txHash?: unknown } | null;
  try {
    parsed = JSON.parse(stdout) as typeof parsed;
  } catch {
    return undefined;
  }
  const candidate = parsed?.data?.txHash ?? parsed?.txHash;
  return typeof candidate === "string" && TX_HASH_PATTERN.test(candidate) ? candidate : undefined;
}

export class CircleAgentStackAdapter {
  private readonly agentWalletAddress: string;
  private readonly exec: CircleExec;
  private readonly env: Record<string, string | undefined>;

  constructor(agentWalletAddress?: string, deps: CircleAgentStackDeps = {}) {
    this.env = deps.env ?? process.env;
    this.exec = deps.exec ?? defaultExec;
    this.agentWalletAddress = agentWalletAddress ?? this.env.CIRCLE_AGENT_WALLET_ADDRESS ?? "";
  }

  /** The live CLI runs only when it is enabled and a wallet is configured. */
  private isLive(): boolean {
    return isFlagEnabled(this.env.ENABLE_LIVE_CIRCLE_CLI) && this.agentWalletAddress.trim().length > 0;
  }

  /**
   * Read-only pre-flight check on BindSettlement.sol via `circle contract query`
   */
  async queryVendorWhitelistStatus(
    vendorAddress: string
  ): Promise<CircleContractQueryResult> {
    const args = [
      "contract",
      "query",
      "whitelistedVendors(address)(bool)",
      vendorAddress,
      "--contract",
      BIND_SETTLEMENT_CONTRACT,
      "--chain",
      ARC_TESTNET_CHAIN,
      "--rpc-url",
      ARC_TESTNET_RPC,
    ];
    const commandStr = `circle ${args.join(" ")}`;

    if (!this.isLive()) {
      return {
        command: commandStr,
        rawOutput: SIMULATED_RAW_OUTPUT,
        executionMode: "SIMULATED_NO_LIVE_CLI",
        whitelisted: null,
      };
    }

    try {
      const { stdout } = await this.exec("circle", args, { timeout: 30_000 });
      return {
        command: commandStr,
        rawOutput: stdout.trim(),
        executionMode: "LIVE_CIRCLE_CLI_ARC_TESTNET",
        whitelisted: parseWhitelisted(stdout),
      };
    } catch (err: unknown) {
      return {
        command: commandStr,
        rawOutput: JSON.stringify({ error: redactUrls(errorMessage(err)) }),
        executionMode: "LIVE_CIRCLE_CLI_ARC_TESTNET",
        whitelisted: null,
      };
    }
  }

  /**
   * Executes settlement on BindSettlement.sol on Arc L1 via `circle wallet execute`.
   * A hash means the transaction was submitted, not confirmed.
   */
  async executeBindSettlement(params: {
    functionSignature: string;
    abiArgs: string[];
    amountUsdc: string;
  }): Promise<CircleSettlementExecutionResult> {
    const args = [
      "wallet",
      "execute",
      params.functionSignature,
      ...params.abiArgs,
      "--contract",
      BIND_SETTLEMENT_CONTRACT,
      "--address",
      this.agentWalletAddress,
      "--chain",
      ARC_TESTNET_CHAIN,
      "--amount",
      params.amountUsdc,
      "--rpc-url",
      ARC_TESTNET_RPC,
    ];
    const commandStr = `circle ${args.join(" ")}`;

    if (!this.isLive()) {
      return {
        command: commandStr,
        rawOutput: SIMULATED_RAW_OUTPUT,
        chain: ARC_TESTNET_CHAIN,
        contractAddress: BIND_SETTLEMENT_CONTRACT,
        paymentStatus: "SIMULATED_LOCAL",
        fulfilmentStatus: "AWAITING_PHYSICAL_DELIVERY_3WAY_MATCH",
        executionMode: "SIMULATED_NO_LIVE_CLI",
      };
    }

    let stdout: string;
    try {
      ({ stdout } = await this.exec("circle", args, { timeout: 60_000 }));
    } catch (err: unknown) {
      return {
        command: commandStr,
        rawOutput: JSON.stringify({ error: redactUrls(errorMessage(err)) }),
        chain: ARC_TESTNET_CHAIN,
        contractAddress: BIND_SETTLEMENT_CONTRACT,
        paymentStatus: classifyLiveFailure(err),
        fulfilmentStatus: "AWAITING_PHYSICAL_DELIVERY_3WAY_MATCH",
        executionMode: "LIVE_CIRCLE_CLI_ARC_TESTNET",
      };
    }

    const txHash = parseTxHash(stdout);
    return {
      command: commandStr,
      rawOutput: stdout.trim(),
      chain: ARC_TESTNET_CHAIN,
      contractAddress: BIND_SETTLEMENT_CONTRACT,
      ...(txHash ? { txHash } : {}),
      paymentStatus: txHash ? "SUBMITTED_ON_ARC_TESTNET" : "OUTCOME_UNKNOWN",
      fulfilmentStatus: "AWAITING_PHYSICAL_DELIVERY_3WAY_MATCH",
      executionMode: "LIVE_CIRCLE_CLI_ARC_TESTNET",
    };
  }
}
