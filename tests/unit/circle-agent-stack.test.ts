import { describe, it, expect } from "vitest";
import {
  CircleAgentStackAdapter,
  BIND_SETTLEMENT_CONTRACT,
  WHITELISTED_VENDOR,
  isFlagEnabled,
} from "../../src/adapters/circleAgentStack.js";

const WALLET = "0x" + "ab".repeat(20);
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

// The settlement-execution tests that used to sit here were removed with the value-moving path (docs/decisions/0085).
// What remains is the read-only whitelist query and the live-flag parsing it shares.
describe("Circle CLI adapter (read-only)", () => {
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

  it("the live flag is enabled only by 1, true, yes or on", async () => {
    for (const value of ["1", "true", "yes", "on", "TRUE", " Yes ", "On"]) {
      expect(isFlagEnabled(value)).toBe(true);
    }

    // Through the adapter: an enabling value with a wallet reaches the CLI (a read).
    const { exec, calls } = recordingExec(succeedingWith(JSON.stringify({ data: { result: true } })));
    const result = await new CircleAgentStackAdapter(WALLET, {
      exec,
      env: { ENABLE_LIVE_CIRCLE_CLI: "yes" },
    }).queryVendorWhitelistStatus(WHITELISTED_VENDOR);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 2)).toEqual(["contract", "query"]);
    expect(result.executionMode).toBe("LIVE_CIRCLE_CLI_ARC_TESTNET");
  });

  it("the live flag stays off for 0, false, empty and unset", async () => {
    for (const value of ["0", "false", "", "   ", "off", "no", undefined]) {
      expect(isFlagEnabled(value)).toBe(false);
    }

    // Through the adapter: "0" and "false" never reach the CLI.
    for (const value of ["0", "false"]) {
      const { exec, calls } = recordingExec(succeedingWith(JSON.stringify({ data: { result: true } })));
      const adapter = new CircleAgentStackAdapter(WALLET, { exec, env: { ENABLE_LIVE_CIRCLE_CLI: value } });
      const result = await adapter.queryVendorWhitelistStatus(WHITELISTED_VENDOR);
      expect(calls).toHaveLength(0);
      expect(result.executionMode).toBe("SIMULATED_NO_LIVE_CLI");
      expect(result.whitelisted).toBeNull();
    }
  });

  it("a live query with no wallet configured stays simulated", async () => {
    const { exec, calls } = recordingExec(succeedingWith(JSON.stringify({ data: { result: true } })));
    const result = await new CircleAgentStackAdapter("", { exec, env: LIVE_ENV }).queryVendorWhitelistStatus(
      WHITELISTED_VENDOR
    );
    expect(calls).toHaveLength(0);
    expect(result.executionMode).toBe("SIMULATED_NO_LIVE_CLI");
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

    // A failed read is not an answer, and a URL in the error text is redacted.
    const failed = await new CircleAgentStackAdapter(WALLET, {
      exec: recordingExec(failingWith(Object.assign(new Error("spawn circle ENOENT"), { code: "ENOENT" }))).exec,
      env: LIVE_ENV,
    }).queryVendorWhitelistStatus(WHITELISTED_VENDOR);
    expect(failed.whitelisted).toBeNull();

    const withUrl = await new CircleAgentStackAdapter(WALLET, {
      exec: recordingExec(
        failingWith(new Error("Command failed: circle contract query --rpc-url https://rpc.example.test/v1/secret-token"))
      ).exec,
      env: LIVE_ENV,
    }).queryVendorWhitelistStatus(WHITELISTED_VENDOR);
    expect(withUrl.whitelisted).toBeNull();
    expect(withUrl.rawOutput).toContain("[redacted-url]");
    expect(withUrl.rawOutput).not.toContain("secret-token");
  });
});
