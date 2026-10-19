import { describe, it, expect } from "vitest";
import {
  CircleAgentStackAdapter,
  BIND_SETTLEMENT_CONTRACT,
  WHITELISTED_VENDOR,
  isFlagEnabled,
} from "../../src/adapters/circleAgentStack.js";

const WALLET = "0x" + "ab".repeat(20);
const HASH = "0x" + "11".repeat(32);
const LIVE_ENV = { ENABLE_LIVE_CIRCLE_CLI: "1" };

type ExecCall = { file: string; args: string[]; opts: { timeout: number } };

/** Records every call and answers with the supplied behaviour. No process is spawned. */
function recordingExec(
  answer: () => Promise<{ stdout: string }>
): { exec: (file: string, args: string[], opts: { timeout: number }) => Promise<{ stdout: string }>; calls: ExecCall[] } {
  const calls: ExecCall[] = [];
  return {
    calls,
    exec: async (file, args, opts) => {
      calls.push({ file, args, opts });
      return answer();
    },
  };
}

function failingWith(err: Error): () => Promise<{ stdout: string }> {
  return async () => {
    throw err;
  };
}

function succeedingWith(stdout: string): () => Promise<{ stdout: string }> {
  return async () => ({ stdout });
}

const SETTLE_PARAMS = {
  functionSignature: "settleOrder(bytes32,address,bytes32)",
  abiArgs: ["0x01", WHITELISTED_VENDOR, "0x02"],
  amountUsdc: "0.001",
};

describe("Circle CLI adapter", () => {
  it("simulated execution claims neither settlement nor a transaction hash", async () => {
    const { exec, calls } = recordingExec(succeedingWith("{}"));
    const adapter = new CircleAgentStackAdapter(WALLET, { exec, env: {} });

    const result = await adapter.executeBindSettlement(SETTLE_PARAMS);

    expect(calls).toHaveLength(0);
    expect(result.paymentStatus).toBe("SIMULATED_LOCAL");
    expect(result.executionMode).toBe("SIMULATED_NO_LIVE_CLI");
    expect(result.txHash).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result, "txHash")).toBe(false);
    expect(JSON.parse(result.rawOutput)).toEqual({
      status: "simulated",
      note: "live Circle CLI not enabled",
    });
    expect(result.rawOutput).not.toContain("LOCAL_PASS");
    expect(result.rawOutput).not.toContain("0xsim");

    // Live CLI enabled but no wallet configured is still simulated.
    const noWallet = new CircleAgentStackAdapter("", { exec, env: LIVE_ENV });
    const noWalletResult = await noWallet.executeBindSettlement(SETTLE_PARAMS);
    expect(noWalletResult.paymentStatus).toBe("SIMULATED_LOCAL");
    expect(noWalletResult.txHash).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("simulated whitelist query returns null, not true", async () => {
    const { exec, calls } = recordingExec(succeedingWith("{}"));
    const adapter = new CircleAgentStackAdapter(WALLET, { exec, env: {} });

    const result = await adapter.queryVendorWhitelistStatus(WHITELISTED_VENDOR);

    expect(calls).toHaveLength(0);
    expect(result.whitelisted).toBeNull();
    expect(result.executionMode).toBe("SIMULATED_NO_LIVE_CLI");
    expect(result.command).toContain("whitelistedVendors");
    expect(result.command).toContain(BIND_SETTLEMENT_CONTRACT);
    expect(result.rawOutput).not.toContain("true");
  });

  it("a live success with a hash is submitted, never settled", async () => {
    const { exec, calls } = recordingExec(succeedingWith(JSON.stringify({ data: { txHash: HASH } })));
    const adapter = new CircleAgentStackAdapter(WALLET, { exec, env: LIVE_ENV });

    const result = await adapter.executeBindSettlement(SETTLE_PARAMS);

    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("circle");
    expect(calls[0].args.slice(0, 2)).toEqual(["wallet", "execute"]);
    expect(result.paymentStatus).toBe("SUBMITTED_ON_ARC_TESTNET");
    expect(result.paymentStatus).not.toBe("SETTLED_ON_ARC_TESTNET");
    expect(result.txHash).toBe(HASH);
    expect(result.executionMode).toBe("LIVE_CIRCLE_CLI_ARC_TESTNET");

    // Top-level txHash is also accepted, as before.
    const topLevel = new CircleAgentStackAdapter(WALLET, {
      exec: recordingExec(succeedingWith(JSON.stringify({ txHash: HASH }))).exec,
      env: LIVE_ENV,
    });
    const topLevelResult = await topLevel.executeBindSettlement(SETTLE_PARAMS);
    expect(topLevelResult.paymentStatus).toBe("SUBMITTED_ON_ARC_TESTNET");
    expect(topLevelResult.txHash).toBe(HASH);
  });

  it("a live success without a hash is outcome unknown", async () => {
    const { exec } = recordingExec(succeedingWith(JSON.stringify({ data: { status: "pending" } })));
    const adapter = new CircleAgentStackAdapter(WALLET, { exec, env: LIVE_ENV });

    const result = await adapter.executeBindSettlement(SETTLE_PARAMS);

    expect(result.paymentStatus).toBe("OUTCOME_UNKNOWN");
    expect(result.txHash).toBeUndefined();
    expect(result.executionMode).toBe("LIVE_CIRCLE_CLI_ARC_TESTNET");
  });

  it("a revert message is a rejection", async () => {
    const messages = [
      new Error("Command failed: circle wallet execute\nexecution reverted"),
      new Error("Command failed: circle wallet execute\nDailyLimitExceeded()"),
      new Error("Command failed: circle wallet execute\nVendorNotWhitelisted()"),
      new Error("Command failed: circle wallet execute\nOrderAlreadySettled()"),
    ];
    for (const err of messages) {
      const { exec } = recordingExec(failingWith(err));
      const adapter = new CircleAgentStackAdapter(WALLET, { exec, env: LIVE_ENV });
      const result = await adapter.executeBindSettlement(SETTLE_PARAMS);
      expect(result.paymentStatus).toBe("REJECTED_BY_ONCHAIN_POLICY");
      expect(result.txHash).toBeUndefined();
    }

    // The policy word may arrive on stderr/stdout attached to the error.
    const withStderr = Object.assign(new Error("Command failed: circle wallet execute"), {
      stderr: "OrderAlreadySettled",
    });
    const adapter = new CircleAgentStackAdapter(WALLET, {
      exec: recordingExec(failingWith(withStderr)).exec,
      env: LIVE_ENV,
    });
    const result = await adapter.executeBindSettlement(SETTLE_PARAMS);
    expect(result.paymentStatus).toBe("REJECTED_BY_ONCHAIN_POLICY");
  });

  it("a timeout is outcome unknown, never a rejection", async () => {
    const timeout = Object.assign(new Error("Command failed: circle wallet execute"), {
      killed: true,
      signal: "SIGTERM",
      code: "ETIMEDOUT",
    });
    const { exec } = recordingExec(failingWith(timeout));
    const adapter = new CircleAgentStackAdapter(WALLET, { exec, env: LIVE_ENV });

    const result = await adapter.executeBindSettlement(SETTLE_PARAMS);

    expect(result.paymentStatus).toBe("OUTCOME_UNKNOWN");
    expect(result.paymentStatus).not.toBe("REJECTED_BY_ONCHAIN_POLICY");
    expect(result.txHash).toBeUndefined();

    // A URL inside the error text (the RPC endpoint is part of the command line) is redacted.
    const withUrl = Object.assign(
      new Error("Command failed: circle wallet execute --rpc-url https://rpc.example.test/v1/secret-token timed out"),
      { killed: true, signal: "SIGTERM" }
    );
    const redacted = await new CircleAgentStackAdapter(WALLET, {
      exec: recordingExec(failingWith(withUrl)).exec,
      env: LIVE_ENV,
    }).executeBindSettlement(SETTLE_PARAMS);
    expect(redacted.paymentStatus).toBe("OUTCOME_UNKNOWN");
    expect(redacted.rawOutput).toContain("[redacted-url]");
    expect(redacted.rawOutput).not.toContain("https://");
    expect(redacted.rawOutput).not.toContain("secret-token");
  });

  it("a missing binary is outcome unknown", async () => {
    const enoent = Object.assign(new Error("spawn circle ENOENT"), { code: "ENOENT" });
    const { exec } = recordingExec(failingWith(enoent));
    const adapter = new CircleAgentStackAdapter(WALLET, { exec, env: LIVE_ENV });

    const result = await adapter.executeBindSettlement(SETTLE_PARAMS);

    expect(result.paymentStatus).toBe("OUTCOME_UNKNOWN");
    expect(result.txHash).toBeUndefined();
    expect(result.executionMode).toBe("LIVE_CIRCLE_CLI_ARC_TESTNET");
  });

  it("malformed JSON is outcome unknown", async () => {
    // Output that mentions a hash but is not JSON is still not a confirmed hash.
    const { exec } = recordingExec(succeedingWith(`not json, txHash ${HASH}`));
    const adapter = new CircleAgentStackAdapter(WALLET, { exec, env: LIVE_ENV });

    const result = await adapter.executeBindSettlement(SETTLE_PARAMS);

    expect(result.paymentStatus).toBe("OUTCOME_UNKNOWN");
    expect(result.txHash).toBeUndefined();
  });

  it("the live flag is enabled only by 1, true, yes or on", async () => {
    for (const value of ["1", "true", "yes", "on", "TRUE", " Yes ", "On"]) {
      expect(isFlagEnabled(value)).toBe(true);
    }

    // Through the adapter: an enabling value with a wallet reaches the CLI.
    const { exec, calls } = recordingExec(succeedingWith(JSON.stringify({ data: { txHash: HASH } })));
    const result = await new CircleAgentStackAdapter(WALLET, {
      exec,
      env: { ENABLE_LIVE_CIRCLE_CLI: "yes" },
    }).executeBindSettlement(SETTLE_PARAMS);
    expect(calls).toHaveLength(1);
    expect(result.executionMode).toBe("LIVE_CIRCLE_CLI_ARC_TESTNET");
  });

  it("the live flag stays off for 0, false, empty and unset", async () => {
    for (const value of ["0", "false", "", "   ", "off", "no", undefined]) {
      expect(isFlagEnabled(value)).toBe(false);
    }

    // Through the adapter: "0" and "false" never reach the CLI.
    for (const value of ["0", "false"]) {
      const { exec, calls } = recordingExec(succeedingWith(JSON.stringify({ data: { txHash: HASH } })));
      const adapter = new CircleAgentStackAdapter(WALLET, { exec, env: { ENABLE_LIVE_CIRCLE_CLI: value } });
      const result = await adapter.executeBindSettlement(SETTLE_PARAMS);
      expect(calls).toHaveLength(0);
      expect(result.paymentStatus).toBe("SIMULATED_LOCAL");
      expect(result.txHash).toBeUndefined();
    }
  });

  it("the live whitelist query parses data.result true and false, and returns null for garbage", async () => {
    const cases: Array<[string, boolean | null]> = [
      [JSON.stringify({ data: { result: true } }), true],
      [JSON.stringify({ data: { result: false } }), false],
      ["garbage text, not json", null],
      [JSON.stringify({ data: { result: "true" } }), null],
      [JSON.stringify({ data: {} }), null],
    ];
    for (const [stdout, expected] of cases) {
      const { exec, calls } = recordingExec(succeedingWith(stdout));
      const adapter = new CircleAgentStackAdapter(WALLET, { exec, env: LIVE_ENV });
      const result = await adapter.queryVendorWhitelistStatus(WHITELISTED_VENDOR);
      expect(calls).toHaveLength(1);
      expect(result.executionMode).toBe("LIVE_CIRCLE_CLI_ARC_TESTNET");
      expect(result.whitelisted).toBe(expected);
    }

    // A failed read is not an answer.
    const failed = await new CircleAgentStackAdapter(WALLET, {
      exec: recordingExec(failingWith(Object.assign(new Error("spawn circle ENOENT"), { code: "ENOENT" }))).exec,
      env: LIVE_ENV,
    }).queryVendorWhitelistStatus(WHITELISTED_VENDOR);
    expect(failed.whitelisted).toBeNull();
  });
});
