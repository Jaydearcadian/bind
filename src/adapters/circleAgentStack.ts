import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Read-only Circle CLI helper: one `circle contract query` against BindSettlement.sol (vendor allowlist check).
 *
 * This module does NOT move value. The settlement execution that used to live here, a Circle Agent Wallet transfer call,
 * was removed (docs/decisions/0085): value moves only in the settlement adapters (src/adapters/settlement/), through the
 * effects ledger and the commitment gate. Nothing in src/agents/ may import this module
 * (tests/unit/no-value-moving-model-tools.test.ts).
 */

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

export type CircleExec = (
  file: string,
  args: string[],
  opts: { timeout: number }
) => Promise<{ stdout: string }>;

export interface CircleAgentStackDeps {
  exec?: CircleExec;
  env?: Record<string, string | undefined>;
}

const ENABLED_FLAG_VALUES = new Set(["1", "true", "yes", "on"]);

const SIMULATED_RAW_OUTPUT = JSON.stringify({
  status: "simulated",
  note: "live Circle CLI not enabled",
});

const defaultExec: CircleExec = async (file, args, opts) => {
  const { stdout } = await execFileAsync(file, args, opts);
  return { stdout: String(stdout) };
};

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

function parseWhitelisted(stdout: string): boolean | null {
  try {
    const parsed = JSON.parse(stdout) as { data?: { result?: unknown } } | null;
    const result = parsed?.data?.result;
    return typeof result === "boolean" ? result : null;
  } catch {
    return null;
  }
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
   * Read-only pre-flight check on BindSettlement.sol via `circle contract query`.
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
}
