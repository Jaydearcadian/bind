import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  main,
  revertSelectorOf,
  runLiveArcVerification,
  RpcTransportError,
  buildCastEnv,
  makeExecCast,
  resolveSender,
  SECRET_ENV_NAMES,
  SELECTOR_DAILY_LIMIT_EXCEEDED,
  SELECTOR_VENDOR_NOT_WHITELISTED,
  type CastExec,
  type CastOutcome,
  type CastRequest,
  type ExecFileLike,
  type LiveArcDeps,
  type MainDeps,
  type RpcCall,
  type RpcRequest,
} from "../../scripts/verify-live-arc.js";

/**
 * The live-check script with injected cast and RPC. No test here touches the network or runs cast. The token in the
 * configured URL is a test value and is used only to prove that no output contains it.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EVIDENCE = path.join(ROOT, "docs/RELEASE_EVIDENCE.md");
const TOKEN = "SECRETTOKEN-XYZ123";
const CONFIGURED_URL = `https://rpc.example.test/v1/${TOKEN}`;
const PLACEHOLDER_URL = "https://rpc.testnet.arc-node.example/v1/<ARC_RPC_TOKEN>";
const TX = `0x${"ab".repeat(32)}`;

const GOOD_CODE = `0x${"60".repeat(40)}`;
const CHAIN_HEX = "0x4cef52"; // 5042002
/**
 * Test values only. KEY is a throwaway key (32 bytes of 0xad, which no fixture uses); DERIVED is the address viem derives from it. SENDER is a
 * different well-formed address, used to produce a mismatch.
 */
const SENDER = "0x1A2b3C4d5E6f708192a3B4c5D6e7F8091a2B3c4D";
const KEY = `0x${"ad".repeat(32)}`;
const DERIVED = "0x45C4Ef602bC5EB4493070d69B4F3b6a74f952216";

function revertStderr(selector: string): string {
  return `Error: server returned an error response: error code 3: execution reverted, data: "${selector}${"0".repeat(64)}"`;
}

type CastOverrides = Partial<Record<"allowlist" | "vendorRevert" | "limitRevert", CastOutcome>>;

/** A cast runner that answers the three kinds of call the script makes. The address is derived in process, never by cast. */
function castWith(overrides: CastOverrides = {}): CastExec & { calls: CastRequest[] } {
  const calls: CastRequest[] = [];
  const exec = (async (request: CastRequest) => {
    calls.push(request);
    const args = request.args.join(" ");
    if (args.includes("whitelistedVendors")) {
      return overrides.allowlist ?? { kind: "completed", exitCode: 0, stdout: "true\n", stderr: "" };
    }
    if (args.includes("--value 1000000000000000") || request.args.includes("1000000000000000")) {
      return overrides.vendorRevert ?? { kind: "completed", exitCode: 1, stdout: "", stderr: revertStderr(SELECTOR_VENDOR_NOT_WHITELISTED) };
    }
    return overrides.limitRevert ?? { kind: "completed", exitCode: 1, stdout: "", stderr: revertStderr(SELECTOR_DAILY_LIMIT_EXCEEDED) };
  }) as CastExec & { calls: CastRequest[] };
  exec.calls = calls;
  return exec;
}

function rpcWith(overrides: Partial<Record<string, unknown | Error>> = {}): RpcCall & { calls: RpcRequest[] } {
  const calls: RpcRequest[] = [];
  const rpc = (async (request: RpcRequest) => {
    calls.push(request);
    const over = overrides[request.method];
    if (over instanceof Error) throw over;
    if (over !== undefined) return over as { result?: unknown; error?: { message?: string } };
    if (request.method === "eth_chainId") return { result: CHAIN_HEX };
    if (request.method === "eth_getCode") return { result: GOOD_CODE };
    if (request.method === "eth_getTransactionReceipt") return { result: { status: "0x1", blockNumber: "0x40" } };
    throw new Error(`unexpected method ${request.method}`);
  }) as RpcCall & { calls: RpcRequest[] };
  rpc.calls = calls;
  return rpc;
}

function deps(over: { exec?: CastExec; rpc?: RpcCall; env?: Record<string, string | undefined> } = {}): LiveArcDeps & { exec: CastExec; rpc: RpcCall } {
  return {
    exec: over.exec ?? castWith(),
    rpc: over.rpc ?? rpcWith(),
    env: over.env ?? { ARC_RPC_URL: CONFIGURED_URL, LAST_LIVE_SETTLEMENT_TX: TX, ARC_SIGNER_ADDRESS: SENDER },
    now: () => new Date("2026-10-20T12:00:00.000Z"),
  };
}

function gateNamed(report: { gates: { gate: string; status: string; detail: string }[] }, fragment: string) {
  const found = report.gates.find((g) => g.gate.includes(fragment));
  if (!found) throw new Error(`no gate containing ${fragment}`);
  return found;
}

const CAST_GATES = ["whitelistedVendors", "VendorNotWhitelisted", "DailyLimitExceeded"];

describe("live Arc check (scripts/verify-live-arc.ts), with injected cast and RPC", () => {
  it("a missing cast binary is blocked, not a pass", async () => {
    const missing: CastExec = async () => ({ kind: "missing_binary" });
    const report = await runLiveArcVerification(deps({ exec: missing }));
    for (const fragment of CAST_GATES) {
      const g = gateNamed(report, fragment);
      expect(g.status, g.gate).toBe("BLOCKED");
      expect(g.detail).toContain("not found");
    }
    // The RPC gates still run and pass; the overall result is still a failure.
    expect(gateNamed(report, "chain id").status).toBe("LIVE_READ_PASS");
    expect(report.exitCode).toBe(1);
  });

  it("a network error is blocked", async () => {
    const rpc = rpcWith({
      eth_chainId: new RpcTransportError("network"),
      eth_getCode: new RpcTransportError("network"),
      eth_getTransactionReceipt: new RpcTransportError("network"),
    });
    const networkCast: CastExec = async () => ({
      kind: "completed",
      exitCode: 1,
      stdout: "",
      stderr: `Error: error sending request for url (${CONFIGURED_URL})`,
    });
    const report = await runLiveArcVerification(deps({ rpc, exec: networkCast }));
    for (const fragment of ["chain id", "bytecode", "receipt", ...CAST_GATES]) {
      const g = gateNamed(report, fragment);
      expect(g.status, g.gate).toBe("BLOCKED");
    }
    expect(report.exitCode).toBe(1);
    expect(report.lines.join("\n")).not.toContain(TOKEN);
  });

  it("an rpc http error is blocked", async () => {
    const rpc = rpcWith({
      eth_chainId: new RpcTransportError("http", 503),
      eth_getCode: new RpcTransportError("http", 503),
      eth_getTransactionReceipt: new RpcTransportError("http", 503),
    });
    const report = await runLiveArcVerification(deps({ rpc }));
    const chain = gateNamed(report, "chain id");
    expect(chain.status).toBe("BLOCKED");
    expect(chain.detail).toContain("HTTP 503");
    expect(gateNamed(report, "receipt").status).toBe("BLOCKED");
    expect(report.exitCode).toBe(1);
  });

  it("an unconfigured rpc url blocks every gate and prints no url", async () => {
    for (const env of [{}, { ARC_RPC_URL: PLACEHOLDER_URL }, { ARC_RPC_URL: "" }]) {
      const exec = castWith();
      const rpc = rpcWith();
      const report = await runLiveArcVerification(deps({ exec, rpc, env }));
      expect(report.gates).toHaveLength(6);
      for (const g of report.gates) {
        expect(g.status, g.gate).toBe("BLOCKED");
        expect(g.detail).toContain("RPC URL not configured");
      }
      expect(exec.calls, "no cast call is made").toHaveLength(0);
      expect(rpc.calls, "no rpc call is made").toHaveLength(0);
      const printed = report.lines.join("\n");
      expect(printed).not.toContain("<ARC_RPC_TOKEN>");
      expect(printed).not.toContain("rpc.testnet.arc-node");
      expect(report.exitCode).toBe(1);
    }
  });

  it("a matching revert selector passes", async () => {
    const report = await runLiveArcVerification(deps());
    const vendor = gateNamed(report, "VendorNotWhitelisted");
    const limit = gateNamed(report, "DailyLimitExceeded");
    expect(vendor.status, vendor.detail).toBe("LIVE_READ_PASS");
    expect(vendor.detail).toContain(SELECTOR_VENDOR_NOT_WHITELISTED);
    expect(limit.status, limit.detail).toBe("LIVE_READ_PASS");
    expect(limit.detail).toContain(SELECTOR_DAILY_LIMIT_EXCEEDED);
    expect(report.exitCode).toBe(0);
  });

  it("a different revert selector fails", async () => {
    const exec = castWith({ vendorRevert: { kind: "completed", exitCode: 1, stdout: "", stderr: revertStderr(SELECTOR_DAILY_LIMIT_EXCEEDED) } });
    const report = await runLiveArcVerification(deps({ exec }));
    const vendor = gateNamed(report, "VendorNotWhitelisted");
    expect(vendor.status).toBe("FAILED");
    expect(vendor.detail).toContain(SELECTOR_DAILY_LIMIT_EXCEEDED);
    expect(report.exitCode).toBe(1);
  });

  it("a successful call with the wrong output is not a pass", async () => {
    // The allowlist read returns false: a successful call, unexpected output.
    const exec = castWith({ allowlist: { kind: "completed", exitCode: 0, stdout: "false\n", stderr: "" } });
    const report = await runLiveArcVerification(deps({ exec }));
    expect(gateNamed(report, "whitelistedVendors").status).toBe("FAILED");

    // A revert gate whose call succeeded: the expected revert did not happen.
    const succeeded = castWith({ limitRevert: { kind: "completed", exitCode: 0, stdout: "0x", stderr: "" } });
    const second = await runLiveArcVerification(deps({ exec: succeeded }));
    const limit = gateNamed(second, "DailyLimitExceeded");
    expect(limit.status).toBe("FAILED");
    expect(limit.detail).toContain("did not happen");

    // A response that is not a JSON-RPC object is a transport problem, not a result.
    const notAnObject = await runLiveArcVerification(deps({ rpc: (async () => null) as unknown as RpcCall }));
    expect(gateNamed(notAnObject, "chain id").status).toBe("BLOCKED");
    expect(gateNamed(notAnObject, "chain id").detail).toContain("not JSON");

    // A chain id that differs is a failure of the expectation, not a pass.
    const wrongChain = await runLiveArcVerification(deps({ rpc: rpcWith({ eth_chainId: { result: "0x1" } }) }));
    expect(gateNamed(wrongChain, "chain id").status).toBe("FAILED");
  });

  it("the script writes nothing unless asked", async () => {
    const before = fs.readFileSync(EVIDENCE, "utf8");
    const beforeHash = crypto.createHash("sha256").update(before).digest("hex");
    const writes: string[] = [];
    const lines: string[] = [];
    const fakeMain: MainDeps = {
      ...deps(),
      log: (line) => lines.push(line),
      writeNewFile: async (p) => {
        writes.push(p);
      },
      fileExists: async () => false,
    };
    const code = await main([], fakeMain);
    expect(code).toBe(0); // the default fakes pass every gate
    expect(writes, "no file is written without --write-evidence").toEqual([]);
    expect(crypto.createHash("sha256").update(fs.readFileSync(EVIDENCE, "utf8")).digest("hex")).toBe(beforeHash);

    // With the flag, the table goes to the named file, once.
    const code2 = await main(["--write-evidence", "/no/such/dir/new-evidence.md"], fakeMain);
    expect(code2).toBe(0);
    expect(writes).toEqual(["/no/such/dir/new-evidence.md"]);

    // A file that already exists is never replaced. Real filesystem, a fresh temporary directory.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bind-live-arc-"));
    const target = path.join(dir, "evidence.md");
    const realMain: MainDeps = {
      ...deps(),
      log: () => {},
      writeNewFile: (p, text) => fs.promises.writeFile(p, text, { encoding: "utf8", flag: "wx" }),
      fileExists: async (p) => fs.existsSync(p),
    };
    expect(await main(["--write-evidence", target], realMain)).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
    const written = fs.readFileSync(target, "utf8");
    expect(written).toContain("| Gate | Status | Detail |");
    expect(await main(["--write-evidence", target], realMain)).toBe(2);
    expect(fs.readFileSync(target, "utf8")).toBe(written);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no output contains the token", async () => {
    const leaky: CastExec = async (request) => ({
      kind: "completed",
      exitCode: 1,
      stdout: `echo ${request.rpcUrl}`,
      stderr: `Error: request to ${CONFIGURED_URL} failed; token ${TOKEN}`,
    });
    const leakyRpc: RpcCall = async () => ({ error: { code: -32000, message: `upstream ${CONFIGURED_URL} rejected ${TOKEN}` } });
    const report = await runLiveArcVerification(deps({ exec: leaky, rpc: leakyRpc }));
    const everything = [...report.lines, report.markdown, ...report.gates.map((g) => `${g.gate} ${g.detail}`)].join("\n");
    expect(everything).not.toContain(TOKEN);
    expect(everything).not.toContain("rpc.example.test");
    expect(everything).not.toContain(CONFIGURED_URL);

    // The success path: the connected detail names the chain, not the URL.
    const ok = await runLiveArcVerification(deps());
    const ok2 = [...ok.lines, ok.markdown].join("\n");
    expect(ok2).not.toContain(TOKEN);
    expect(ok2).not.toContain("rpc.example.test");
  });

  it("the revert selector is read from the revert data, not from a transaction hash", () => {
    expect(revertSelectorOf(`execution reverted, data: "0xef664d6a${"0".repeat(64)}"`)).toBe("0xef664d6a");
    expect(revertSelectorOf(`custom error 0x65e822e9: VendorNotWhitelisted`)).toBe("0x65e822e9");
    // A transaction hash (64 hex digits) and an address (40 hex digits) are not selectors.
    expect(revertSelectorOf(`tx ${TX} failed`)).toBeUndefined();
    expect(revertSelectorOf(`to 0xa8358AED200D6CB6C856F972D853C1be833006ea`)).toBeUndefined();
  });

  it("both revert calls carry --from the configured sender", async () => {
    const exec = castWith();
    await runLiveArcVerification(deps({ exec }));
    const settle = exec.calls.filter((c) => c.args.includes("settleOrder(bytes32,address,bytes32)"));
    expect(settle).toHaveLength(2);
    for (const call of settle) {
      const i = call.args.indexOf("--from");
      expect(i, call.args.join(" ")).toBeGreaterThanOrEqual(0);
      expect(call.args[i + 1]).toBe(SENDER);
      expect(Object.keys(call).sort(), "a cast request carries no environment of its own").toEqual(["args", "rpcUrl", "timeoutMs"]);
    }
    // The allowlist read is not a revert call and keeps its arguments.
    expect(exec.calls.find((c) => c.args.includes("whitelistedVendors(address)(bool)"))?.args).not.toContain("--from");
  });

  it("with no sender configured, both revert gates are BLOCKED and cast is not run for them", async () => {
    const exec = castWith();
    const env = { ARC_RPC_URL: CONFIGURED_URL, LAST_LIVE_SETTLEMENT_TX: TX };
    const report = await runLiveArcVerification(deps({ exec, env }));
    for (const fragment of ["VendorNotWhitelisted", "DailyLimitExceeded"]) {
      const g = gateNamed(report, fragment);
      expect(g.status, g.gate).toBe("BLOCKED");
      expect(g.detail).toContain("no sender configured");
    }
    expect(exec.calls.filter((c) => c.args.includes("settleOrder(bytes32,address,bytes32)"))).toHaveLength(0);
    expect(exec.calls.filter((c) => c.args[0] === "wallet"), "no key, so no derivation").toHaveLength(0);
    // The allowlist read does not need a sender and still runs.
    expect(gateNamed(report, "whitelistedVendors").status).toBe("LIVE_READ_PASS");
    expect(report.exitCode).toBe(1);
  });

  it("an invalid ARC_SIGNER_ADDRESS blocks both revert gates, runs no revert call, and never echoes the value", async () => {
    // A value that looks like a private key pasted into the address variable must not be printed.
    for (const bad of ["0xnotanaddress", "0x1234", KEY, `${SENDER}00`]) {
      const exec = castWith();
      const report = await runLiveArcVerification(deps({ exec, env: { ARC_RPC_URL: CONFIGURED_URL, LAST_LIVE_SETTLEMENT_TX: TX, ARC_SIGNER_ADDRESS: bad } }));
      for (const fragment of ["VendorNotWhitelisted", "DailyLimitExceeded"]) {
        const g = gateNamed(report, fragment);
        expect(g.status, g.gate).toBe("BLOCKED");
        expect(g.detail).toContain("not a 0x-prefixed 40-hex address");
      }
      expect(exec.calls.filter((c) => c.args.includes("settleOrder(bytes32,address,bytes32)"))).toHaveLength(0);
      // A key pasted into the address variable is not printed back.
      expect([...report.lines, report.markdown].join("\n")).not.toContain(bad);
    }

    // An invalid address is never replaced by the key: no fallback, and no derivation.
    const exec = castWith();
    const withKey = await runLiveArcVerification(
      deps({ exec, env: { ARC_RPC_URL: CONFIGURED_URL, LAST_LIVE_SETTLEMENT_TX: TX, ARC_SIGNER_ADDRESS: "0xbad", ARC_SIGNER_PRIVATE_KEY: KEY } })
    );
    expect(gateNamed(withKey, "VendorNotWhitelisted").status).toBe("BLOCKED");
    expect(exec.calls.filter((c) => c.args[0] === "wallet")).toHaveLength(0);
  });

  it("a key that derives a different address than ARC_SIGNER_ADDRESS blocks both revert gates", async () => {
    const exec = castWith();
    const report = await runLiveArcVerification(deps({ exec, env: { ARC_RPC_URL: CONFIGURED_URL, LAST_LIVE_SETTLEMENT_TX: TX, ARC_SIGNER_ADDRESS: SENDER, ARC_SIGNER_PRIVATE_KEY: KEY } }));
    for (const fragment of ["VendorNotWhitelisted", "DailyLimitExceeded"]) {
      const g = gateNamed(report, fragment);
      expect(g.status, g.gate).toBe("BLOCKED");
      expect(g.detail).toContain("sender does not match key");
    }
    expect(exec.calls.filter((c) => c.args.includes("settleOrder(bytes32,address,bytes32)"))).toHaveLength(0);
    expect(report.exitCode).toBe(1);
  });

  it("a matching key and address pass, and the key never reaches cast", async () => {
    // Address comparison ignores case: the lower-case form matches the derived checksum address.
    const exec = castWith();
    const report = await runLiveArcVerification(
      deps({ exec, env: { ARC_RPC_URL: CONFIGURED_URL, LAST_LIVE_SETTLEMENT_TX: TX, ARC_SIGNER_ADDRESS: DERIVED.toLowerCase(), ARC_SIGNER_PRIVATE_KEY: KEY } })
    );
    expect(gateNamed(report, "VendorNotWhitelisted").status).toBe("LIVE_READ_PASS");
    expect(gateNamed(report, "DailyLimitExceeded").status).toBe("LIVE_READ_PASS");
    for (const call of exec.calls) {
      expect(call.args.join(" "), "key is never in argv").not.toContain(KEY.slice(2));
      expect(JSON.stringify(call), "key is in no cast request").not.toContain(KEY.slice(2));
    }
    expect([...report.lines, report.markdown, ...report.gates.map((g) => g.detail)].join("\n")).not.toContain(KEY);
  });

  it("with only the key set, the sender is derived in process and the revert calls use it", async () => {
    const exec = castWith();
    const report = await runLiveArcVerification(deps({ exec, env: { ARC_RPC_URL: CONFIGURED_URL, LAST_LIVE_SETTLEMENT_TX: TX, ARC_SIGNER_PRIVATE_KEY: KEY } }));
    expect(gateNamed(report, "VendorNotWhitelisted").status).toBe("LIVE_READ_PASS");
    expect(gateNamed(report, "DailyLimitExceeded").status).toBe("LIVE_READ_PASS");
    const settle = exec.calls.filter((c) => c.args.includes("settleOrder(bytes32,address,bytes32)"));
    expect(settle).toHaveLength(2);
    for (const call of settle) expect(call.args[call.args.indexOf("--from") + 1]).toBe(DERIVED);
    expect(exec.calls.filter((c) => c.args[0] === "wallet"), "no cast derivation: the address is derived in process").toHaveLength(0);
  });

  it("a malformed or underivable key blocks both gates and leaks nothing", async () => {
    const cases = [`0x${"zz".repeat(32)}`, KEY.slice(2), `${KEY}00`, "0x1234", `0x${"00".repeat(32)}`];
    for (const bad of cases) {
      const exec = castWith();
      const report = await runLiveArcVerification(deps({ exec, env: { ARC_RPC_URL: CONFIGURED_URL, LAST_LIVE_SETTLEMENT_TX: TX, ARC_SIGNER_PRIVATE_KEY: bad } }));
      for (const fragment of ["VendorNotWhitelisted", "DailyLimitExceeded"]) {
        const g = gateNamed(report, fragment);
        expect(g.status, g.gate).toBe("BLOCKED");
        expect(g.detail).toContain("ARC_SIGNER_PRIVATE_KEY");
      }
      expect(exec.calls.filter((c) => c.args.includes("settleOrder(bytes32,address,bytes32)"))).toHaveLength(0);
      const everything = [...report.lines, report.markdown, ...report.gates.map((g) => `${g.gate} ${g.detail}`)].join("\n");
      expect(everything).not.toContain(bad);
    }
  });

  it("the all-zero address is blocked, whether configured or derived", async () => {
    const zero = "0x0000000000000000000000000000000000000000";
    const exec = castWith();
    const report = await runLiveArcVerification(deps({ exec, env: { ARC_RPC_URL: CONFIGURED_URL, LAST_LIVE_SETTLEMENT_TX: TX, ARC_SIGNER_ADDRESS: zero } }));
    for (const fragment of ["VendorNotWhitelisted", "DailyLimitExceeded"]) {
      const g = gateNamed(report, fragment);
      expect(g.status, g.gate).toBe("BLOCKED");
      expect(g.detail).toContain("sender is the zero address");
    }
    expect(exec.calls.filter((c) => c.args.includes("settleOrder(bytes32,address,bytes32)"))).toHaveLength(0);
    // The resolver rule directly. No real key derives to the zero address, so the derived branch is covered by the same check.
    expect(resolveSender({ ARC_SIGNER_ADDRESS: zero }).ok).toBe(false);
    expect(resolveSender({ ARC_SIGNER_PRIVATE_KEY: KEY })).toEqual({ ok: true, address: DERIVED });
    expect(resolveSender({ ARC_SIGNER_ADDRESS: SENDER, ARC_SIGNER_PRIVATE_KEY: KEY })).toMatchObject({ ok: false });
  });

  it("the cast child environment drops every signing secret and sets ETH_RPC_URL", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" };
    for (const name of SECRET_ENV_NAMES) base[name] = KEY;
    const env = buildCastEnv(base, CONFIGURED_URL);
    for (const name of SECRET_ENV_NAMES) expect(env[name], name).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
    expect(env.ETH_RPC_URL).toBe(CONFIGURED_URL);
    expect(base.ARC_SIGNER_PRIVATE_KEY, "the parent environment object is not mutated").toBe(KEY);
  });

  it("the real cast runner spawns every cast child without a signing secret, and the key never reaches argv", async () => {
    const spawned: { file: string; args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const run: ExecFileLike = (file, args, options, done) => {
      spawned.push({ file, args, env: options.env });
      const joined = args.join(" ");
      if (joined.includes("whitelistedVendors")) return done(null, "true\n", "");
      const failure = Object.assign(new Error("exit code 1"), { code: 1 });
      if (joined.includes("1000000000000000")) return done(failure, "", revertStderr(SELECTOR_VENDOR_NOT_WHITELISTED));
      return done(failure, "", revertStderr(SELECTOR_DAILY_LIMIT_EXCEEDED));
    };
    // The parent environment holds every secret name. None of them may reach a cast child.
    const parentEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin", ARC_RPC_URL: CONFIGURED_URL, ARC_SIGNER_PRIVATE_KEY: KEY, ETH_PRIVATE_KEY: KEY, PRIVATE_KEY: KEY, MNEMONIC: "test test", ETH_KEYSTORE_PASSWORD: "pw" };
    const report = await runLiveArcVerification({
      exec: makeExecCast(run, () => parentEnv),
      rpc: rpcWith(),
      env: { ARC_RPC_URL: CONFIGURED_URL, LAST_LIVE_SETTLEMENT_TX: TX, ARC_SIGNER_PRIVATE_KEY: KEY },
      now: () => new Date("2026-10-20T12:00:00.000Z"),
    });

    expect(spawned).toHaveLength(3);
    for (const child of spawned) {
      expect(child.file).toBe("cast");
      for (const name of SECRET_ENV_NAMES) expect(child.env[name], `${name} in a cast child`).toBeUndefined();
      expect(Object.values(child.env).some((value) => value?.includes(KEY.slice(2))), "key in a child env value").toBe(false);
      expect(child.args.join(" "), "key in argv").not.toContain(KEY.slice(2));
      expect(child.env.ETH_RPC_URL).toBe(CONFIGURED_URL);
      expect(child.env.PATH).toBe("/usr/bin");
    }
    const settle = spawned.filter((c) => c.args.includes("settleOrder(bytes32,address,bytes32)"));
    for (const child of settle) expect(child.args[child.args.indexOf("--from") + 1]).toBe(DERIVED);
    expect(gateNamed(report, "VendorNotWhitelisted").status).toBe("LIVE_READ_PASS");
    expect(gateNamed(report, "DailyLimitExceeded").status).toBe("LIVE_READ_PASS");
    expect([...report.lines, report.markdown].join("\n")).not.toContain(KEY);
  });

  it("a generic Error(string) revert (0x08c379a0) is never a pass for a revert gate", async () => {
    const generic = `Error: execution reverted, data: "0x08c379a0${"0".repeat(64)}"`;
    const exec = castWith({
      vendorRevert: { kind: "completed", exitCode: 1, stdout: "", stderr: generic },
      limitRevert: { kind: "completed", exitCode: 1, stdout: "", stderr: generic },
    });
    const report = await runLiveArcVerification(deps({ exec }));
    for (const fragment of ["VendorNotWhitelisted", "DailyLimitExceeded"]) {
      const g = gateNamed(report, fragment);
      expect(g.status, g.gate).toBe("FAILED");
      expect(g.detail).toContain("0x08c379a0");
    }
    expect(report.exitCode).toBe(1);

    // A revert with no selector at all is blocked, not passed.
    const bare = castWith({ vendorRevert: { kind: "completed", exitCode: 1, stdout: "", stderr: "execution reverted" } });
    const second = await runLiveArcVerification(deps({ exec: bare }));
    expect(gateNamed(second, "VendorNotWhitelisted").status).toBe("BLOCKED");
  });
});
