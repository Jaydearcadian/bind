import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decodeErrorResult,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { BIND_SETTLEMENT_ABI } from "../../src/adapters/settlement/bind-settlement.abi.js";
import { USDC_ABI } from "../../src/adapters/settlement/arc-l1.js";
import {
  APPROVED_SETTLEMENT_ADDRESS,
  BlockedError,
  assertDeployBlockCode,
  databaseHostProblem,
  KILL_ARMED_MARK,
  PAYMENT_CENTS,
  RefusedError,
  VENDOR_ADDRESS,
  assertContractGuards,
  assertPhaseAllowed,
  assertStateMatches,
  contractGuardFailures,
  countOf,
  crashAssertions,
  guardedAdapter,
  httpRpc,
  makeScrubber,
  makeTimeoutTransport,
  oneCentInBaseUnits,
  parseArgs,
  parseState,
  preRestartAssertions,
  realFiles,
  readSettlementLogs,
  runOrchestrator,
  scenarioRecoverPlan,
  signerAddressOf,
  staticGuards,
  timeoutAssertions,
  toSnapshot,
  verdictOf,
  waitUntil,
  type CliArgs,
  type ChildOutcome,
  type HarnessDb,
  type HarnessPorts,
  type RpcCall,
  type ScenarioState,
  type SettlementSnapshot,
} from "../../scripts/live-recovery-arc.js";

/**
 * The live recovery harness with every edge stubbed: no network, no database, no child process. The fake chain answers
 * the JSON-RPC reads the harness makes, and the fake database holds one order row that the scripted children change.
 * The token and the key below are test values. They must never appear in any output.
 */
const TOKEN = "SECRETTOKEN-XYZ123";
const RPC_URL = `https://rpc.example.test/v1/${TOKEN}`;
const TEST_KEY = `0x${"11".repeat(32)}`;
const DB_URL = "postgres://bind_local:bind_local_only@127.0.0.1:5432/bind_local";
const SIGNER = signerAddressOf(TEST_KEY) as string;
const ORDER = "ord-test-1";
const WORKSPACE = "ws-test-1";
const DEPLOY_BLOCK = "1000";
const HASH1 = `0x${"ab".repeat(32)}` as Hex;
const HASH2 = `0x${"cd".repeat(32)}` as Hex;
const CHAIN_ID_HEX = "0x4cef52";

const GOOD_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: DB_URL,
  ARC_RPC_URL: RPC_URL,
  ARC_SIGNER_PRIVATE_KEY: TEST_KEY,
  BIND_SETTLEMENT_ADDRESS: APPROVED_SETTLEMENT_ADDRESS,
  BIND_SETTLEMENT_DEPLOY_BLOCK: DEPLOY_BLOCK,
};

function args(over: Partial<CliArgs> = {}): CliArgs {
  return {
    scenario: "crash-before-record",
    phase: "orchestrate",
    adapter: "arc",
    confirmTestnetSpend: true,
    statePath: path.join(os.tmpdir(), "unused-state.json"),
    fresh: false,
    ...over,
  };
}

function snap(over: Partial<SettlementSnapshot> = {}): SettlementSnapshot {
  return {
    status: "settling",
    txHash: null,
    submittedAt: null,
    confirmedAt: null,
    confirmedBlock: null,
    settledAmountCents: "1",
    effect: { status: "started", attempts: 1, operation: "settlement.transfer_usdc", externalRef: null },
    audits: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The fake chain. It answers the reads the harness makes. A broadcast is recorded when it is mined in this fake.
// ---------------------------------------------------------------------------------------------------------------------

interface FakeChain {
  rpc: RpcCall;
  calls: string[];
  latest: bigint;
  pending: bigint;
  vendorBalance: bigint;
  blockCounter: bigint;
  receipts: Map<string, { status: "0x1" | "0x0"; blockNumber: string; from: string; to: string }>;
  logs: { topic1: string; transactionHash: string; blockNumber: string }[];
  /** Mines one transaction from the signer for this order. The fake uses the hash it is given. */
  broadcastAndMine(hash: Hex, status?: "0x1" | "0x0"): void;
  /** Adds a pending transaction that is never mined. */
  broadcastOnly(): void;
}

function makeChain(over: { chainId?: string; owner?: string; whitelisted?: boolean; enforced?: boolean; noCode?: boolean } = {}): FakeChain {
  const orderTopic = keccak256(stringToHex(ORDER));
  const answers = new Map<string, () => string>();
  const put = (data: Hex, value: () => string) => answers.set(data.toLowerCase(), value);
  put(encodeFunctionData({ abi: BIND_SETTLEMENT_ABI, functionName: "owner" }), () =>
    encodeFunctionResult({ abi: BIND_SETTLEMENT_ABI, functionName: "owner", result: (over.owner ?? SIGNER) as Address })
  );
  put(encodeFunctionData({ abi: BIND_SETTLEMENT_ABI, functionName: "enforceVendorWhitelist" }), () =>
    encodeFunctionResult({ abi: BIND_SETTLEMENT_ABI, functionName: "enforceVendorWhitelist", result: over.enforced ?? true })
  );
  put(
    encodeFunctionData({ abi: BIND_SETTLEMENT_ABI, functionName: "whitelistedVendors", args: [VENDOR_ADDRESS as Address] }),
    () => encodeFunctionResult({ abi: BIND_SETTLEMENT_ABI, functionName: "whitelistedVendors", result: over.whitelisted ?? true })
  );
  put(encodeFunctionData({ abi: USDC_ABI, functionName: "decimals" }), () =>
    encodeFunctionResult({ abi: USDC_ABI, functionName: "decimals", result: 6 })
  );

  const chain: FakeChain = {
    rpc: async () => undefined,
    calls: [],
    latest: 5n,
    pending: 5n,
    vendorBalance: 0n,
    blockCounter: 100n,
    receipts: new Map(),
    logs: [],
    broadcastAndMine(hash, status = "0x1") {
      chain.pending += 1n;
      chain.latest = chain.pending;
      chain.blockCounter += 1n;
      const blockNumber = `0x${chain.blockCounter.toString(16)}`;
      chain.receipts.set(hash, { status, blockNumber, from: SIGNER, to: APPROVED_SETTLEMENT_ADDRESS });
      if (status === "0x1") {
        chain.logs.push({ topic1: orderTopic, transactionHash: hash, blockNumber });
        chain.vendorBalance += 10_000n;
      }
    },
    broadcastOnly() {
      chain.pending += 1n;
    },
  } as FakeChain;

  chain.rpc = async (method, params) => {
    chain.calls.push(method);
    if (method === "eth_chainId") return over.chainId ?? CHAIN_ID_HEX;
    // The head is well past the deploy block used in these tests (1000), so the deploy block exists.
    if (method === "eth_blockNumber") return "0x1388";
    if (method === "eth_getCode") return over.noCode ? "0x" : "0x6080";
    if (method === "eth_getTransactionCount") {
      const tag = (params as unknown[])[1];
      return `0x${(tag === "pending" ? chain.pending : chain.latest).toString(16)}`;
    }
    if (method === "eth_call") {
      const call = params[0] as { to: string; data: Hex };
      if (call.to.toLowerCase() === "0x3600000000000000000000000000000000000000") {
        const balanceData = encodeFunctionData({ abi: USDC_ABI, functionName: "balanceOf", args: [VENDOR_ADDRESS as Address] });
        if (call.data.toLowerCase() === balanceData.toLowerCase()) {
          return encodeFunctionResult({ abi: USDC_ABI, functionName: "balanceOf", result: chain.vendorBalance });
        }
      }
      const value = answers.get(call.data.toLowerCase());
      if (!value) throw new Error(`fake chain has no answer for ${call.data.slice(0, 10)}`);
      return value();
    }
    if (method === "eth_getLogs") {
      const filter = params[0] as { topics: (string | null)[] };
      const topic1 = filter.topics[1];
      return chain.logs
        .filter((log) => log.topic1 === topic1)
        .map((log) => ({ transactionHash: log.transactionHash, blockNumber: log.blockNumber }));
    }
    if (method === "eth_getTransactionReceipt") {
      const receipt = chain.receipts.get(params[0] as string);
      if (!receipt) return null;
      return { status: receipt.status, blockNumber: receipt.blockNumber, from: receipt.from, to: receipt.to };
    }
    if (method === "eth_getTransactionByHash") {
      const receipt = chain.receipts.get(params[0] as string);
      if (!receipt) return null;
      return { from: receipt.from, to: receipt.to, input: "0x", value: "0x0", blockNumber: receipt.blockNumber };
    }
    throw new Error(`fake chain does not answer ${method}`);
  };
  return chain;
}

// ---------------------------------------------------------------------------------------------------------------------
// The fake database and ports
// ---------------------------------------------------------------------------------------------------------------------

interface FakeDb extends HarnessDb {
  row: SettlementSnapshot;
  prepared: number;
  closed: boolean;
}

function makeDb(row: SettlementSnapshot = snap(), total = PAYMENT_CENTS): FakeDb {
  const db: FakeDb = {
    row,
    prepared: 0,
    closed: false,
    async prepare() {
      db.prepared += 1;
      return { workspaceId: WORKSPACE, orderId: ORDER, workflowId: "wf-1", orderStatus: "confirmed" };
    },
    async orderTotalCents() {
      return total;
    },
    async snapshot() {
      return { ...db.row, audits: [...db.row.audits], effect: db.row.effect ? { ...db.row.effect } : null };
    },
    async close() {
      db.closed = true;
    },
  };
  return db;
}

interface PortsHarness {
  ports: HarnessPorts;
  files: Map<string, string>;
  spawned: string[][];
  emitted: string[];
  clock: { t: number };
}

function makePorts(opts: {
  env?: NodeJS.ProcessEnv;
  chain?: FakeChain | undefined;
  db: FakeDb;
  spawn: (argv: string[]) => Promise<ChildOutcome>;
  files?: Map<string, string>;
}): PortsHarness {
  const files = opts.files ?? new Map<string, string>();
  const spawned: string[][] = [];
  const emitted: string[] = [];
  const clock = { t: 0 };
  const scrub = makeScrubber(opts.env ?? GOOD_ENV);
  const ports: HarnessPorts = {
    env: opts.env ?? GOOD_ENV,
    emit: (text) => emitted.push(scrub(text)),
    notify: (text) => emitted.push(scrub(text)),
    files: {
      exists: (file) => files.has(file),
      read: (file) => (files.has(file) ? (files.get(file) as string) : null),
      write: (file, text, mode) => {
        if (mode === "new" && files.has(file)) throw new Error("EEXIST: file already exists");
        files.set(file, text);
      },
    },
    rpc: opts.chain?.rpc,
    db: opts.db,
    spawnPhase: async (argv) => {
      spawned.push(argv);
      // The real child writes its own marker to the state file before it sends, so the fake does the same.
      const phase = argv[argv.indexOf("--phase") + 1];
      const file = argv[argv.indexOf("--state") + 1];
      const text = files.get(file);
      if (text !== undefined && (phase === "send-child" || phase === "recover")) {
        const s = JSON.parse(text) as ScenarioState;
        if (phase === "send-child") s.sendStartedAt = s.sendStartedAt ?? "2026-10-22T00:00:00.000Z";
        else s.recoverStartedAt = "2026-10-22T00:00:01.000Z";
        files.set(file, JSON.stringify(s, null, 2));
      }
      return opts.spawn(argv);
    },
    sleep: async (ms) => {
      clock.t += ms;
    },
    now: () => clock.t,
  };
  return { ports, files, spawned, emitted, clock };
}

const statePath = path.join(os.tmpdir(), "live-recovery-test-state.json");

function killed(): ChildOutcome {
  return { code: null, signal: "SIGKILL", timedOut: false, lines: [KILL_ARMED_MARK] };
}

function ok(result: unknown): ChildOutcome {
  return { code: 0, signal: null, timedOut: false, lines: [], result };
}

// ---------------------------------------------------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------------------------------------------------

describe("argument parsing", () => {
  it("defaults to the arc adapter, the orchestrate phase, and a state file in the given directory", () => {
    const parsed = parseArgs(["timeout-retry"], "/tmp/state-dir");
    expect(parsed).toMatchObject({ scenario: "timeout-retry", adapter: "arc", phase: "orchestrate", confirmTestnetSpend: false, fresh: false });
    expect(parsed.statePath).toBe(path.join("/tmp/state-dir", "bind-live-recovery-timeout-retry.json"));
  });

  it("refuses an option that would set the amount, so the amount cannot be configured", () => {
    expect(() => parseArgs(["crash-before-record", "--amount-cents", "500"])).toThrow(/unknown option --amount-cents/);
    expect(() => parseArgs(["crash-before-record", "--amount=0.5"])).toThrow(/unknown option --amount/);
  });

  it("refuses an unknown scenario, a missing value, an unknown adapter and an unknown phase", () => {
    expect(() => parseArgs(["crash-everything"])).toThrow(/unknown scenario/);
    expect(() => parseArgs(["crash-before-record", "--state"])).toThrow(/needs a value/);
    expect(() => parseArgs(["crash-before-record", "--adapter", "mainnet"])).toThrow(/--adapter must be arc or local-sim/);
    expect(() => parseArgs(["crash-before-record", "--phase", "drain"])).toThrow(/unknown phase/);
    expect(() => parseArgs([])).toThrow(/usage/);
  });

  it("reads the confirm flag, the fresh flag and the evidence path", () => {
    const parsed = parseArgs(["crash-before-confirm", "--confirm-testnet-spend", "--fresh", "--write-evidence", "/tmp/x.json"], "/tmp");
    expect(parsed).toMatchObject({ confirmTestnetSpend: true, fresh: true, writeEvidence: "/tmp/x.json" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Static guards
// ---------------------------------------------------------------------------------------------------------------------

describe("static guards (no network)", () => {
  it("passes a complete arc configuration with the flag", () => {
    expect(staticGuards(GOOD_ENV, args(), false)).toEqual([]);
  });

  it("refuses an arc run without --confirm-testnet-spend", () => {
    const failures = staticGuards(GOOD_ENV, args({ confirmTestnetSpend: false }), false);
    expect(failures.map((f) => f.guard)).toEqual(["confirm-flag"]);
  });

  it("refuses NODE_ENV=production", () => {
    expect(staticGuards({ ...GOOD_ENV, NODE_ENV: "production" }, args(), false).map((f) => f.guard)).toContain("node-env");
  });

  it("refuses a DATABASE_URL whose host is not local, and an unset one, and accepts localhost", () => {
    const remote = staticGuards({ ...GOOD_ENV, DATABASE_URL: "postgres://u:p@db.example.test:5432/x" }, args(), false);
    expect(remote.map((f) => f.guard)).toContain("database-host");
    expect(staticGuards({ ...GOOD_ENV, DATABASE_URL: undefined }, args(), false).map((f) => f.guard)).toContain("database-host");
    expect(staticGuards({ ...GOOD_ENV, DATABASE_URL: "postgres://u:p@localhost:5432/x" }, args(), false)).toEqual([]);
    expect(staticGuards({ ...GOOD_ENV, DATABASE_URL: "postgres://u:p@127.0.0.1:5432/x" }, args(), false)).toEqual([]);
  });

  it("refuses SETTLEMENT_MODE set to anything but arc-testnet, and accepts it unset or arc-testnet", () => {
    expect(staticGuards({ ...GOOD_ENV, SETTLEMENT_MODE: "local" }, args(), false).map((f) => f.guard)).toContain("settlement-mode");
    expect(staticGuards({ ...GOOD_ENV, SETTLEMENT_MODE: "simulated" }, args(), false).map((f) => f.guard)).toContain("settlement-mode");
    expect(staticGuards({ ...GOOD_ENV, SETTLEMENT_MODE: "arc-testnet" }, args(), false)).toEqual([]);
    expect(staticGuards({ ...GOOD_ENV, SETTLEMENT_MODE: undefined }, args(), false)).toEqual([]);
  });

  it("refuses any contract other than the approved one, and accepts the approved one in any letter case", () => {
    const other = "0x1111111111111111111111111111111111111111";
    expect(staticGuards({ ...GOOD_ENV, BIND_SETTLEMENT_ADDRESS: other }, args(), false).map((f) => f.guard)).toContain(
      "settlement-address"
    );
    expect(staticGuards({ ...GOOD_ENV, BIND_SETTLEMENT_ADDRESS: undefined }, args(), false).map((f) => f.guard)).toContain(
      "settlement-address"
    );
    expect(
      staticGuards({ ...GOOD_ENV, BIND_SETTLEMENT_ADDRESS: APPROVED_SETTLEMENT_ADDRESS.toLowerCase() }, args(), false)
    ).toEqual([]);
  });

  it("refuses a missing or non-integer deploy block", () => {
    expect(staticGuards({ ...GOOD_ENV, BIND_SETTLEMENT_DEPLOY_BLOCK: undefined }, args(), false).map((f) => f.guard)).toContain(
      "deploy-block"
    );
    expect(staticGuards({ ...GOOD_ENV, BIND_SETTLEMENT_DEPLOY_BLOCK: "12a" }, args(), false).map((f) => f.guard)).toContain(
      "deploy-block"
    );
  });

  it("refuses a malformed RPC URL and a malformed key", () => {
    expect(staticGuards({ ...GOOD_ENV, ARC_RPC_URL: "wss://rpc.example.test" }, args(), false).map((f) => f.guard)).toContain("rpc-url");
    expect(staticGuards({ ...GOOD_ENV, ARC_SIGNER_PRIVATE_KEY: "0x1234" }, args(), false).map((f) => f.guard)).toContain("signer-key");
  });

  it("refuses a --write-evidence file that already exists", () => {
    expect(staticGuards(GOOD_ENV, args({ writeEvidence: "/tmp/exists.json" }), true).map((f) => f.guard)).toContain("evidence-file");
  });

  it("refuses local-sim while the live settings are present, so a rehearsal cannot reach the network", () => {
    expect(staticGuards(GOOD_ENV, args({ adapter: "local-sim", confirmTestnetSpend: false }), false).map((f) => f.guard)).toEqual([
      "local-sim-offline",
    ]);
    expect(
      staticGuards({ NODE_ENV: "test", DATABASE_URL: DB_URL }, args({ adapter: "local-sim", confirmTestnetSpend: false }), false)
    ).toEqual([]);
  });

  it("names the rules in every refusal and never prints a value", () => {
    const failures = staticGuards(
      { ...GOOD_ENV, ARC_RPC_URL: `https://rpc.example.test/v1/${TOKEN}`, ARC_SIGNER_PRIVATE_KEY: "0xdeadbeef", NODE_ENV: "production" },
      args({ confirmTestnetSpend: false }),
      false
    );
    const text = failures.map((f) => f.reason).join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("deadbeef");
    expect(text).toMatch(/NODE_ENV is production/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Contract guards and the RPC boundary
// ---------------------------------------------------------------------------------------------------------------------

describe("contract guards (reads only)", () => {
  const cfg = { contract: APPROVED_SETTLEMENT_ADDRESS, signer: SIGNER, vendor: VENDOR_ADDRESS };

  it("passes when the chain id, owner, whitelist and enforcement all hold", async () => {
    const chain = makeChain();
    const reading = await assertContractGuards(chain.rpc, cfg);
    expect(reading).toMatchObject({ chainId: 5042002, owner: SIGNER, vendorWhitelisted: true, whitelistEnforced: true });
  });

  it("refuses a chain id other than 5042002 and reports the value it read", async () => {
    const chain = makeChain({ chainId: "0x1" });
    await expect(assertContractGuards(chain.rpc, cfg)).rejects.toMatchObject({ name: "RefusedError" });
    await expect(assertContractGuards(chain.rpc, cfg)).rejects.toThrow(/eth_chainId is 1, expected 5042002/);
  });

  it("refuses when the owner is not the signer", async () => {
    const chain = makeChain({ owner: "0x2222222222222222222222222222222222222222" });
    await expect(assertContractGuards(chain.rpc, cfg)).rejects.toThrow(/owner is not the signer/);
  });

  it("refuses when the vendor is not whitelisted, and when enforcement is off", async () => {
    await expect(assertContractGuards(makeChain({ whitelisted: false }).rpc, cfg)).rejects.toThrow(/vendor is not whitelisted/);
    await expect(assertContractGuards(makeChain({ enforced: false }).rpc, cfg)).rejects.toThrow(/enforceVendorWhitelist is false/);
  });

  it("reports a failed read as BLOCKED, not as a refusal, and sends nothing", async () => {
    const failing: RpcCall = async () => {
      throw new Error("connection refused");
    };
    const err = await assertContractGuards(failing, cfg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err).not.toBeInstanceOf(RefusedError);
  });

  it("contractGuardFailures is empty only when every rule holds", () => {
    const good = { chainId: 5042002, owner: SIGNER, vendorWhitelisted: true, whitelistEnforced: true };
    expect(contractGuardFailures(good, SIGNER)).toEqual([]);
    expect(contractGuardFailures({ ...good, chainId: 1 }, SIGNER)).toHaveLength(1);
  });

  it("derives the signer address from a key and gives undefined for anything else", () => {
    expect(signerAddressOf(TEST_KEY)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(signerAddressOf("not-a-key")).toBeUndefined();
    expect(signerAddressOf(undefined)).toBeUndefined();
  });
});

describe("the RPC client", () => {
  it("never puts the URL in an error", async () => {
    const rpc = httpRpc(RPC_URL, (async () => {
      throw new Error(`fetch failed for ${RPC_URL}`);
    }) as unknown as typeof fetch);
    const err = (await rpc("eth_chainId", []).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).toContain("eth_chainId");
  });

  it("reports an HTTP status and a JSON-RPC error with its code and data", async () => {
    const http = httpRpc(RPC_URL, (async () => new Response("no", { status: 503 })) as unknown as typeof fetch);
    await expect(http("eth_chainId", [])).rejects.toThrow(/HTTP 503/);
    const rpcErr = httpRpc(
      RPC_URL,
      (async () => new Response(JSON.stringify({ error: { code: 3, message: "reverted", data: "0x12345678" } }))) as unknown as typeof fetch
    );
    const err = (await rpcErr("eth_call", []).catch((e: unknown) => e)) as { data?: unknown; code?: number };
    expect(err.data).toBe("0x12345678");
    expect(err.code).toBe(3);
  });
});

describe("amounts", () => {
  it("one cent is 10^(decimals-2) base units and is refused for a token with fewer than two decimals", () => {
    expect(oneCentInBaseUnits(6)).toBe(10_000n);
    expect(oneCentInBaseUnits(18)).toBe(10n ** 16n);
    expect(() => oneCentInBaseUnits(1)).toThrow(BlockedError);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Scenario state and the phase guard (a second send is refused)
// ---------------------------------------------------------------------------------------------------------------------

function state(over: Partial<ScenarioState> = {}): ScenarioState {
  return {
    version: 1,
    scenario: "crash-before-record",
    adapter: "arc",
    workspaceId: WORKSPACE,
    orderId: ORDER,
    workflowId: null,
    payer: SIGNER,
    vendor: VENDOR_ADDRESS,
    results: {},
    ...over,
  };
}

describe("scenario state and the phase guard", () => {
  const a = { scenario: "crash-before-record" as const, adapter: "arc" as const };

  it("refuses a send when there is no prepared state", () => {
    expect(() => assertPhaseAllowed(null, "send", a)).toThrow(RefusedError);
  });

  it("allows one send, then refuses a second send for the same scenario state", () => {
    const fresh = state();
    expect(() => assertPhaseAllowed(fresh, "send", a)).not.toThrow();
    const sent = state({ sendStartedAt: "2026-10-22T00:00:00.000Z" });
    expect(() => assertPhaseAllowed(sent, "send", a)).toThrow(/second send is refused/);
  });

  it("refuses recover before the send, allows it once after, and refuses it a second time", () => {
    expect(() => assertPhaseAllowed(state(), "recover", a)).toThrow(/send has not started/);
    const sent = state({ sendStartedAt: "t" });
    expect(() => assertPhaseAllowed(sent, "recover", a)).not.toThrow();
    expect(() => assertPhaseAllowed(state({ sendStartedAt: "t", recoverStartedAt: "t2" }), "recover", a)).toThrow(
      /already ran/
    );
  });

  it("refuses a state file that belongs to another scenario or adapter", () => {
    expect(() => assertStateMatches(state({ scenario: "timeout-retry" }), a)).toThrow(/another scenario or adapter/);
    expect(() => assertStateMatches(state({ adapter: "local-sim" }), a)).toThrow(/another scenario or adapter/);
  });

  it("parses only a complete state record", () => {
    expect(parseState(JSON.stringify(state()))).toMatchObject({ orderId: ORDER });
    expect(parseState("not json")).toBeNull();
    expect(parseState(JSON.stringify({ version: 2 }))).toBeNull();
    expect(parseState("null")).toBeNull();
  });

  it("gives the recover plan for each crash scenario and none for timeout-retry", () => {
    expect(scenarioRecoverPlan("crash-before-record")).toEqual(["tick", "fulfill", "tick", "fulfill-repeat"]);
    expect(scenarioRecoverPlan("crash-before-confirm")).toEqual(["tick", "tick", "fulfill-repeat"]);
    expect(scenarioRecoverPlan("timeout-retry")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The adapter wrapper: the amount guard, the chain re-read, and the crash points
// ---------------------------------------------------------------------------------------------------------------------

function innerAdapter(log: string[]) {
  return {
    mode: "arc-testnet" as const,
    getBalance: async () => 0n,
    transferUSDC: async () => {
      log.push("transfer");
      return { txHash: HASH1, status: "submitted" as const, timestamp: new Date(), mode: "arc-testnet" as const, simulated: false };
    },
    confirm: async () => {
      log.push("confirm");
      return { txHash: HASH1, status: "confirmed" as const, timestamp: new Date(), mode: "arc-testnet" as const, simulated: false };
    },
    depositEscrow: async () => {
      throw new Error("unused");
    },
    releaseEscrow: async () => {
      throw new Error("unused");
    },
  };
}

const REQ = {
  fromAddress: SIGNER,
  toAddress: VENDOR_ADDRESS,
  amountCents: PAYMENT_CENTS,
  currency: "USDC",
  orderId: ORDER,
  idempotencyKey: `idem_pay_${ORDER}`,
  matchHash: `0x${"ef".repeat(32)}`,
};
/** The transfer's pins: the signer, the pinned vendor and the prepared order. REQ satisfies all three. */
const PINS = { payer: SIGNER, vendor: VENDOR_ADDRESS, orderId: ORDER };

describe("guarded adapter", () => {
  it("refuses any amount other than one cent before the chain is read or the adapter is called", async () => {
    const log: string[] = [];
    const guarded = guardedAdapter(innerAdapter(log), { beforeTransfer: async () => void log.push("beforeTransfer") }, PINS);
    await expect(guarded.transferUSDC({ ...REQ, amountCents: 2n })).rejects.toThrow(/not 1 cent/);
    await expect(guarded.transferUSDC({ ...REQ, amountCents: 0n })).rejects.toThrow(/nothing is sent/);
    expect(log).toEqual([]);
  });

  it("re-reads the chain before each transfer, and sends nothing when the re-read refuses", async () => {
    const log: string[] = [];
    const guarded = guardedAdapter(innerAdapter(log), {
      beforeTransfer: async () => {
        throw new RefusedError(["the chain id changed"]);
      },
    }, PINS);
    await expect(guarded.transferUSDC(REQ)).rejects.toThrow(/chain id changed/);
    expect(log).toEqual([]);
  });

  it("runs the crash hook after the real transfer returned, so the hash exists before the process dies", async () => {
    const log: string[] = [];
    const guarded = guardedAdapter(innerAdapter(log), {
      beforeTransfer: async () => void log.push("beforeTransfer"),
      afterTransfer: async (result) => void log.push(`afterTransfer:${result.txHash}`),
    }, PINS);
    const result = await guarded.transferUSDC(REQ);
    expect(result.txHash).toBe(HASH1);
    expect(log).toEqual(["beforeTransfer", "transfer", `afterTransfer:${HASH1}`]);
  });

  it("runs the confirm hook on entry, before the adapter's confirm", async () => {
    const log: string[] = [];
    const guarded = guardedAdapter(innerAdapter(log), {
      beforeTransfer: async () => undefined,
      beforeConfirm: async () => void log.push("beforeConfirm"),
    }, PINS);
    await guarded.confirm(HASH1);
    expect(log).toEqual(["beforeConfirm", "confirm"]);
    expect(guarded.findTransfer).toBeUndefined();
  });
});

describe("timeout transport", () => {
  it("forwards the first raw send, then fails it with a timeout, and reports the broadcast hash", async () => {
    const raw = `0x${"02".repeat(40)}` as Hex;
    const methods: string[] = [];
    const broadcasts: Hex[] = [];
    const forward: RpcCall = async (method) => {
      methods.push(method);
      if (method === "eth_sendRawTransaction") return HASH1;
      return "0x4cef52";
    };
    const transport = makeTimeoutTransport(forward, (hash) => broadcasts.push(hash)) as unknown as (
      p: object
    ) => { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> };
    const inst = transport({});
    await expect(inst.request({ method: "eth_sendRawTransaction", params: [raw] })).rejects.toThrow(/timed out after the transaction was sent/);
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]).toBe(keccak256(raw));
    // The second send is not injected: it returns the node's answer.
    await expect(inst.request({ method: "eth_sendRawTransaction", params: [raw] })).resolves.toBe(HASH1);
    await expect(inst.request({ method: "eth_chainId", params: [] })).resolves.toBe("0x4cef52");
    expect(methods).toEqual(["eth_sendRawTransaction", "eth_sendRawTransaction", "eth_chainId"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Pure assertions
// ---------------------------------------------------------------------------------------------------------------------

describe("pre-restart assertions", () => {
  it("crash-before-record expects no hash and an unfinished effect", () => {
    const ok1 = preRestartAssertions("crash-before-record", snap());
    expect(verdictOf(ok1, "arc")).toBe("PASS");
    const withHash = preRestartAssertions("crash-before-record", snap({ txHash: HASH1 }));
    expect(withHash.find((a) => a.name === "pre_restart_no_hash")?.status).toBe("FAIL");
  });

  it("crash-before-confirm expects the hash, submitted_at set, confirmed_at unset, a completed effect and the audits", () => {
    const good = snap({
      txHash: HASH1,
      submittedAt: "2026-10-22T00:00:00.000Z",
      effect: { status: "completed", attempts: 1, operation: "settlement.transfer_usdc", externalRef: HASH1 },
      audits: ["settlement.submitted"],
    });
    expect(verdictOf(preRestartAssertions("crash-before-confirm", good), "arc")).toBe("PASS");
    const confirmed = { ...good, audits: ["settlement.submitted", "settlement.confirmed"] };
    expect(preRestartAssertions("crash-before-confirm", confirmed).find((a) => a.name === "pre_restart_confirmed_audit_absent")?.status).toBe(
      "FAIL"
    );
  });

  it("counts audits exactly", () => {
    expect(countOf(["settlement.submitted", "settlement.confirmed", "settlement.submitted"], "settlement.submitted")).toBe(2);
  });
});

describe("crash assertions", () => {
  const chain = (over: Partial<Parameters<typeof crashAssertions>[0]["chain"] & object> = {}) => ({
    contract: APPROVED_SETTLEMENT_ADDRESS,
    startNonce: "5",
    endNonce: "6",
    vendorBefore: "0",
    vendorAfter: "10000",
    expectedDelta: "10000",
    logs: [{ transactionHash: HASH1, blockNumber: 101n }],
    receipt: { hash: HASH1, status: "success" as const, blockNumber: 101n, from: SIGNER, to: APPROVED_SETTLEMENT_ADDRESS },
    ...over,
  });
  const finalGood = snap({
    status: "reconciled",
    txHash: HASH1,
    submittedAt: "t",
    confirmedAt: "t",
    confirmedBlock: "101",
    effect: { status: "completed", attempts: 1, operation: "settlement.transfer_usdc", externalRef: HASH1 },
    audits: ["settlement.submitted", "settlement.confirmed"],
  });
  const repeatGood = { alreadyReconciled: true, reconciled: true, nonceBefore: "6", nonceAfter: "6" };

  it("passes every check on a clean run with one log, one nonce and the exact vendor delta", () => {
    const out = crashAssertions({
      scenario: "crash-before-record",
      adapter: "arc",
      childSignal: "SIGKILL",
      killArmed: true,
      final: finalGood,
      repeat: repeatGood,
      chain: chain(),
    });
    expect(verdictOf(out, "arc")).toBe("PASS");
  });

  it("fails on a second settlement log, a nonce delta of two, or a vendor delta that is not exact", () => {
    const twoLogs = crashAssertions({
      scenario: "crash-before-record",
      adapter: "arc",
      childSignal: "SIGKILL",
      killArmed: true,
      final: finalGood,
      repeat: repeatGood,
      chain: chain({ logs: [{ transactionHash: HASH1, blockNumber: 101n }, { transactionHash: HASH2, blockNumber: 102n }] }),
    });
    expect(twoLogs.find((a) => a.name === "one_settlement_log")?.status).toBe("FAIL");
    const nonce2 = crashAssertions({
      scenario: "crash-before-record",
      adapter: "arc",
      childSignal: "SIGKILL",
      killArmed: true,
      final: finalGood,
      repeat: repeatGood,
      chain: chain({ endNonce: "7" }),
    });
    expect(nonce2.find((a) => a.name === "signer_nonce_delta_one")?.status).toBe("FAIL");
    const vendor = crashAssertions({
      scenario: "crash-before-record",
      adapter: "arc",
      childSignal: "SIGKILL",
      killArmed: true,
      final: finalGood,
      repeat: repeatGood,
      chain: chain({ vendorAfter: "20000" }),
    });
    expect(vendor.find((a) => a.name === "vendor_delta_exact")?.status).toBe("FAIL");
  });

  it("fails when the repeat is not alreadyReconciled, or when the repeat moved the nonce", () => {
    const notAlready = crashAssertions({
      scenario: "crash-before-confirm",
      adapter: "arc",
      childSignal: "SIGKILL",
      killArmed: true,
      final: finalGood,
      repeat: { ...repeatGood, alreadyReconciled: false },
      chain: chain(),
    });
    expect(notAlready.find((a) => a.name === "repeat_already_reconciled")?.status).toBe("FAIL");
    const moved = crashAssertions({
      scenario: "crash-before-confirm",
      adapter: "arc",
      childSignal: "SIGKILL",
      killArmed: true,
      final: finalGood,
      repeat: { ...repeatGood, nonceAfter: "7" },
      chain: chain(),
    });
    expect(moved.find((a) => a.name === "nonce_unchanged_by_repeat")?.status).toBe("FAIL");
  });

  it("fails when the child did not die by SIGKILL at its kill point", () => {
    const out = crashAssertions({
      scenario: "crash-before-record",
      adapter: "arc",
      childSignal: "SIGTERM",
      killArmed: true,
      final: finalGood,
      repeat: repeatGood,
      chain: chain(),
    });
    expect(out.find((a) => a.name === "child_killed_at_crash_point")?.status).toBe("FAIL");
  });

  it("marks every chain check SKIPPED for local-sim, and does not count a skip as a failure", () => {
    const out = crashAssertions({
      scenario: "crash-before-record",
      adapter: "local-sim",
      childSignal: "SIGKILL",
      killArmed: true,
      final: finalGood,
      repeat: repeatGood,
      chain: undefined,
    });
    expect(out.filter((a) => a.name === "one_settlement_log").map((a) => a.status)).toEqual(["SKIPPED"]);
    expect(verdictOf(out, "local-sim")).toBe("PASS");
  });
});

describe("timeout assertions", () => {
  const afterAttempt1 = snap({
    status: "confirmed",
    effect: { status: "failed", attempts: 1, operation: "settlement.transfer_usdc", externalRef: null },
  });
  const failedAttempt = { name: "attempt-1", ok: false, error: { name: "SettlementTransportError", message: "timed out" } };
  const reconciledFinal = snap({
    status: "reconciled",
    txHash: HASH1,
    effect: { status: "completed", attempts: 2, operation: "settlement.transfer_usdc", externalRef: HASH1 },
  });
  const chain = {
    contract: APPROVED_SETTLEMENT_ADDRESS,
    startNonce: "5",
    endNonce: "6",
    vendorBefore: "0",
    vendorAfter: "10000",
    expectedDelta: "10000",
    logs: [{ transactionHash: HASH1, blockNumber: 101n }],
    receipt: null,
  };

  it("passes when the first call's unknown outcome is followed by one settlement and the exact vendor delta", () => {
    const out = timeoutAssertions({
      stopped: undefined,
      broadcastsAfterAttempt1: 1,
      attempts: [failedAttempt, { name: "attempt-2-immediate", ok: true, result: { reconciled: true } }],
      afterAttempt1,
      final: reconciledFinal,
      adapter: "arc",
      chain,
      broadcasts: [{ hash: HASH1, receipt: null }],
    });
    expect(verdictOf(out, "arc")).toBe("PASS");
  });

  it("fails on two settlement logs and on a vendor delta of two cents, and reports the second broadcast's revert", () => {
    const out = timeoutAssertions({
      stopped: undefined,
      broadcastsAfterAttempt1: 1,
      attempts: [failedAttempt],
      afterAttempt1,
      final: reconciledFinal,
      adapter: "arc",
      chain: { ...chain, logs: [{ transactionHash: HASH1, blockNumber: 101n }, { transactionHash: HASH2, blockNumber: 102n }], vendorAfter: "20000" },
      broadcasts: [
        { hash: HASH1, receipt: { hash: HASH1, status: "success", blockNumber: 101n, from: SIGNER, to: APPROVED_SETTLEMENT_ADDRESS } },
        { hash: HASH2, receipt: { hash: HASH2, status: "reverted", blockNumber: 102n, from: SIGNER, to: APPROVED_SETTLEMENT_ADDRESS }, revert: "OrderAlreadySettled" },
      ],
    });
    expect(out.find((a) => a.name === "one_settlement_log")?.status).toBe("FAIL");
    expect(out.find((a) => a.name === "vendor_delta_exact")?.status).toBe("FAIL");
    expect(out.find((a) => a.name === "broadcast" && a.detail.includes("OrderAlreadySettled"))).toBeDefined();
  });

  it("reports an order that is held rather than reconciled as a failed assertion, and does not hide it", () => {
    const held = snap({ status: "payment_hold", txHash: HASH2 });
    const out = timeoutAssertions({
      stopped: undefined,
      broadcastsAfterAttempt1: 1,
      attempts: [failedAttempt],
      afterAttempt1,
      final: held,
      adapter: "arc",
      chain,
      broadcasts: [{ hash: HASH1, receipt: null }],
    });
    expect(out.find((a) => a.name === "order_reconciled")?.status).toBe("FAIL");
    expect(out.find((a) => a.name === "tx_hash_matches_log")?.status).toBe("FAIL");
  });

  it("fails when the sequence stopped before its last call", () => {
    const out = timeoutAssertions({
      stopped: "the transfer was not mined within the bound",
      attempts: [failedAttempt],
      afterAttempt1,
      final: afterAttempt1,
      adapter: "local-sim",
      chain: undefined,
      broadcasts: [],
    });
    expect(out.find((a) => a.name === "sequence_completed")?.status).toBe("FAIL");
  });
});

describe("snapshot conversion", () => {
  it("turns database rows into the snapshot, with dates as ISO text and the block as text", () => {
    const s = toSnapshot(
      {
        status: "reconciled",
        tx_hash: HASH1,
        settlement_submitted_at: new Date("2026-10-22T00:00:00.000Z"),
        settlement_confirmed_at: null,
        settlement_confirmed_block: "42",
        settled_amount_cents: "1",
      },
      { status: "completed", attempts: 1, operation: "settlement.transfer_usdc", external_ref: HASH1 },
      [{ action: "settlement.submitted" }]
    );
    expect(s).toMatchObject({
      status: "reconciled",
      txHash: HASH1,
      submittedAt: "2026-10-22T00:00:00.000Z",
      confirmedAt: null,
      confirmedBlock: "42",
      audits: ["settlement.submitted"],
    });
    expect(() => toSnapshot(undefined, undefined, [])).toThrow(BlockedError);
  });
});

describe("waiting", () => {
  it("returns true as soon as the check passes, and false at the bound, without sending anything", async () => {
    const clock = { t: 0 };
    const opts = { timeoutMs: 10_000, pollMs: 2_000, now: () => clock.t, sleep: async (ms: number) => void (clock.t += ms) };
    let calls = 0;
    expect(await waitUntil(async () => ++calls >= 3, opts)).toBe(true);
    clock.t = 0;
    expect(await waitUntil(async () => false, opts)).toBe(false);
    expect(clock.t).toBeGreaterThanOrEqual(10_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Orchestration: the refusals send nothing, the phases run in order, the second send is refused
// ---------------------------------------------------------------------------------------------------------------------

describe("orchestration refusals send nothing", () => {
  it("refuses without the flag: no prepare, no child, no state written", async () => {
    const db = makeDb();
    const chain = makeChain();
    const h = makePorts({ chain, db, spawn: async () => ok({}) });
    const code = await runOrchestrator(args({ confirmTestnetSpend: false }), h.ports);
    expect(code).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(db.prepared).toBe(0);
    expect(h.files.size).toBe(0);
    expect(h.emitted.join("\n")).toMatch(/"result": "REFUSED"/);
  });

  it("refuses a chain id other than 5042002 before preparing anything", async () => {
    const db = makeDb();
    const chain = makeChain({ chainId: "0x1" });
    const h = makePorts({ chain, db, spawn: async () => ok({}) });
    expect(await runOrchestrator(args(), h.ports)).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(db.prepared).toBe(0);
  });

  it("reports an unreachable RPC as BLOCKED and sends nothing", async () => {
    const db = makeDb();
    const down: RpcCall = async () => {
      throw new Error("connection refused");
    };
    const h = makePorts({ chain: undefined, db, spawn: async () => ok({}) });
    h.ports.rpc = down;
    expect(await runOrchestrator(args(), h.ports)).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(h.emitted.join("\n")).toMatch(/"result": "BLOCKED"/);
  });

  it("refuses a second send for the same scenario state unless --fresh is given", async () => {
    const db = makeDb();
    const chain = makeChain();
    const files = new Map<string, string>([
      [statePath, JSON.stringify(state({ sendStartedAt: "2026-10-22T00:00:00.000Z" }), null, 2)],
    ]);
    const h = makePorts({ chain, db, spawn: async () => ok({}), files });
    expect(await runOrchestrator(args({ statePath }), h.ports)).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(db.prepared).toBe(0);
    expect(h.emitted.join("\n")).toMatch(/second send is refused|already ran/);
  });

  it("refuses a state file that belongs to another scenario", async () => {
    const db = makeDb();
    const chain = makeChain();
    const files = new Map<string, string>([[statePath, JSON.stringify(state({ scenario: "timeout-retry" }))]]);
    const h = makePorts({ chain, db, spawn: async () => ok({}), files });
    expect(await runOrchestrator(args({ statePath }), h.ports)).toBe(2);
    expect(h.spawned).toEqual([]);
  });

  it("refuses an order whose total is not exactly one cent, before any send", async () => {
    const db = makeDb(snap(), 2n);
    const chain = makeChain();
    const h = makePorts({ chain, db, spawn: async () => ok({}) });
    expect(await runOrchestrator(args({ statePath }), h.ports)).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(h.emitted.join("\n")).toMatch(/not 1 cent/);
  });

  it("refuses an evidence file that already exists, before anything runs", async () => {
    const db = makeDb();
    const chain = makeChain();
    const files = new Map<string, string>([["/tmp/already.json", "{}"]]);
    const h = makePorts({ chain, db, spawn: async () => ok({}), files });
    expect(await runOrchestrator(args({ writeEvidence: "/tmp/already.json", statePath }), h.ports)).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(db.prepared).toBe(0);
  });

  it("a prepare that does not leave the order confirmed is refused before the send", async () => {
    const db = makeDb();
    db.prepare = async () => ({ workspaceId: WORKSPACE, orderId: ORDER, workflowId: null, orderStatus: "submitted" });
    const chain = makeChain();
    const h = makePorts({ chain, db, spawn: async () => ok({}) });
    expect(await runOrchestrator(args({ statePath }), h.ports)).toBe(2);
    expect(h.spawned).toEqual([]);
  });
});

describe("orchestration, the send is one process and the restart is another", () => {
  it("a child that reports a blocked read exits BLOCKED, not REFUSED, and nothing more is started", async () => {
    const chain = makeChain();
    const db = makeDb();
    const h = makePorts({
      chain,
      db,
      spawn: async () => ({
        code: 2,
        signal: null,
        timedOut: false,
        lines: ['LIVE_RECOVERY_RESULT {"blocked":true,"reason":"the chain id read failed"}'],
      }),
    });
    expect(await runOrchestrator(args({ statePath }), h.ports)).toBe(2);
    expect(h.spawned).toHaveLength(1);
    expect(h.emitted.join("\n")).toMatch(/"result": "BLOCKED"/);
    expect(h.emitted.join("\n")).toMatch(/the chain id read failed/);
  });

  it("a child that does not die at its kill point is a FAIL: no restart, and the state says the send started", async () => {
    const db = makeDb();
    const chain = makeChain();
    const h = makePorts({
      chain,
      db,
      files: new Map(),
      spawn: async () => ({ code: 1, signal: null, timedOut: false, lines: ["boom"] }),
    });
    const code = await runOrchestrator(args({ statePath }), h.ports);
    expect(code).toBe(1);
    expect(h.spawned.map((s) => s[s.indexOf("--phase") + 1])).toEqual(["send-child"]);
    expect(h.emitted.join("\n")).toMatch(/did not die at its kill point/);
  });

  it("crash-before-record: send child killed, transfer mined, restart reconciles, the repeat sends nothing, PASS", async () => {
    const chain = makeChain();
    const db = makeDb();
    const h = makePorts({
      chain,
      db,
      spawn: async (argv) => {
        const phase = argv[argv.indexOf("--phase") + 1];
        if (phase === "send-child") {
          // The transfer is broadcast and mined, then the child dies before the hash is stored.
          chain.broadcastAndMine(HASH1);
          db.row = snap({ status: "settling", txHash: null, effect: { status: "started", attempts: 1, operation: "settlement.transfer_usdc", externalRef: null } });
          return killed();
        }
        // The restart reconciles the transfer it finds on chain, then the repeat finds it done.
        db.row = snap({
          status: "reconciled",
          txHash: HASH1,
          submittedAt: "2026-10-22T00:00:00.000Z",
          confirmedAt: "2026-10-22T00:00:01.000Z",
          confirmedBlock: String(Number(chain.receipts.get(HASH1)!.blockNumber)),
          effect: { status: "completed", attempts: 1, operation: "settlement.transfer_usdc", externalRef: HASH1 },
          audits: ["settlement.submitted", "settlement.confirmed"],
        });
        return ok({
          steps: [
            { name: "tick", report: {}, snapshot: db.row },
            { name: "fulfill", result: { reconciled: true }, nonceBefore: "6", nonceAfter: "6" },
            { name: "tick", report: {}, snapshot: db.row },
            { name: "fulfill-repeat", result: { reconciled: true, alreadyReconciled: true }, nonceBefore: "6", nonceAfter: "6" },
          ],
        });
      },
    });
    const code = await runOrchestrator(args({ statePath, scenario: "crash-before-record" }), h.ports);
    expect(code).toBe(0);
    expect(h.spawned.map((s) => s[s.indexOf("--phase") + 1])).toEqual(["send-child", "recover"]);
    expect(db.closed).toBe(true);
    expect(h.emitted.join("\n")).toMatch(/"result": "PASS"/);
    expect(h.emitted.join("\n")).toMatch(/"evidenceClass": "VERIFIED_REMOTE"/);
  });

  it("crash-before-confirm: the pre-restart state is checked, two ticks confirm, PASS", async () => {
    const chain = makeChain();
    const db = makeDb();
    const h = makePorts({
      chain,
      db,
      spawn: async (argv) => {
        const phase = argv[argv.indexOf("--phase") + 1];
        if (phase === "send-child") {
          chain.broadcastAndMine(HASH1);
          db.row = snap({
            status: "settling",
            txHash: HASH1,
            submittedAt: "2026-10-22T00:00:00.000Z",
            effect: { status: "completed", attempts: 1, operation: "settlement.transfer_usdc", externalRef: HASH1 },
            audits: ["settlement.submitted"],
          });
          return killed();
        }
        db.row = snap({
          status: "reconciled",
          txHash: HASH1,
          submittedAt: "2026-10-22T00:00:00.000Z",
          confirmedAt: "2026-10-22T00:00:01.000Z",
          confirmedBlock: String(Number(chain.receipts.get(HASH1)!.blockNumber)),
          effect: { status: "completed", attempts: 1, operation: "settlement.transfer_usdc", externalRef: HASH1 },
          audits: ["settlement.submitted", "settlement.confirmed"],
        });
        return ok({
          steps: [
            { name: "tick", report: {}, snapshot: db.row },
            { name: "tick", report: {}, snapshot: db.row },
            { name: "fulfill-repeat", result: { reconciled: false, alreadyReconciled: true }, nonceBefore: "6", nonceAfter: "6" },
          ],
        });
      },
    });
    const code = await runOrchestrator(args({ statePath, scenario: "crash-before-confirm" }), h.ports);
    expect(code).toBe(0);
    const report = h.emitted.join("\n");
    expect(report).toMatch(/"name": "pre_restart_submitted_audit_present"[\s\S]*?"status": "PASS"/);
    expect(report).toMatch(/"result": "PASS"/);
  });

  it("a crashed transfer that is not mined within the bound stops the run: the restart is not started", async () => {
    const chain = makeChain();
    const db = makeDb();
    const h = makePorts({
      chain,
      db,
      spawn: async (argv) => {
        const phase = argv[argv.indexOf("--phase") + 1];
        if (phase === "send-child") {
          chain.broadcastOnly();
          db.row = snap();
          return killed();
        }
        throw new Error("the restart must not run");
      },
    });
    const code = await runOrchestrator(args({ statePath }), h.ports);
    expect(code).toBe(1);
    expect(h.spawned.map((s) => s[s.indexOf("--phase") + 1])).toEqual(["send-child"]);
    expect(h.emitted.join("\n")).toMatch(/not mined within the bound/);
  });

  it("a recover process that does not finish cleanly is a FAIL: no further process is started", async () => {
    const chain = makeChain();
    const db = makeDb();
    const h = makePorts({
      chain,
      db,
      spawn: async (argv) => {
        const phase = argv[argv.indexOf("--phase") + 1];
        if (phase === "send-child") {
          chain.broadcastAndMine(HASH1);
          db.row = snap();
          return killed();
        }
        return { code: 1, signal: null, timedOut: false, lines: [] };
      },
    });
    expect(await runOrchestrator(args({ statePath }), h.ports)).toBe(1);
    expect(h.spawned).toHaveLength(2);
  });

  it("a rehearsal with local-sim skips every chain read and labels it, and needs no RPC", async () => {
    const db = makeDb();
    const h = makePorts({
      chain: undefined,
      db,
      env: { NODE_ENV: "test", DATABASE_URL: DB_URL },
      spawn: async (argv) => {
        const phase = argv[argv.indexOf("--phase") + 1];
        if (phase === "send-child") {
          db.row = snap({ status: "settling", txHash: null });
          return killed();
        }
        db.row = snap({
          status: "reconciled",
          txHash: HASH1,
          submittedAt: "t",
          confirmedAt: "t",
          confirmedBlock: null,
          effect: { status: "completed", attempts: 2, operation: "settlement.transfer_usdc", externalRef: HASH1 },
          audits: ["settlement.submitted", "settlement.confirmed"],
        });
        return ok({ steps: [{ name: "fulfill-repeat", result: { alreadyReconciled: true }, nonceBefore: "0", nonceAfter: "0" }] });
      },
    });
    const code = await runOrchestrator(args({ statePath, adapter: "local-sim", confirmTestnetSpend: false }), h.ports);
    expect(code).toBe(0);
    const report = h.emitted.join("\n");
    expect(report).toMatch(/"chainAssertions": "SKIPPED/);
    expect(report).toMatch(/"name": "chain_assertions"/);
    expect(report).toMatch(/"evidenceClass": "LOCAL_PASS"/);
  });

  it("a timeout sequence that gives the expected outcomes passes with one settlement", async () => {
    const chain = makeChain();
    const db = makeDb();
    const h = makePorts({
      chain,
      db,
      spawn: async (argv) => {
        const phase = argv[argv.indexOf("--phase") + 1];
        expect(phase).toBe("send-child");
        chain.broadcastAndMine(HASH1);
        db.row = snap({
          status: "reconciled",
          txHash: HASH1,
          submittedAt: "t",
          confirmedAt: "t",
          confirmedBlock: String(Number(chain.receipts.get(HASH1)!.blockNumber)),
          effect: { status: "completed", attempts: 2, operation: "settlement.transfer_usdc", externalRef: HASH1 },
          audits: ["settlement.submitted", "settlement.confirmed"],
        });
        return ok({
          broadcastsAfterAttempt1: 1,
          attempts: [
            { name: "attempt-1", ok: false, error: { name: "SettlementTransportError", message: "timed out" } },
            { name: "attempt-2-immediate", ok: true, result: { reconciled: true } },
            { name: "attempt-3-after-mining", ok: true, result: { reconciled: false, alreadyReconciled: true } },
          ],
          afterAttempt1: snap({ status: "confirmed", effect: { status: "failed", attempts: 1, operation: "settlement.transfer_usdc", externalRef: null } }),
          broadcasts: [HASH1],
        });
      },
    });
    const code = await runOrchestrator(args({ statePath, scenario: "timeout-retry" }), h.ports);
    expect(code).toBe(0);
    expect(h.spawned).toHaveLength(1);
    expect(h.emitted.join("\n")).toMatch(/"result": "PASS"/);
  });

  it("a timeout sequence that leaves the order held fails the assertion and says so, without sending again", async () => {
    const chain = makeChain();
    const db = makeDb();
    const h = makePorts({
      chain,
      db,
      spawn: async () => {
        chain.broadcastAndMine(HASH1);
        chain.broadcastAndMine(HASH2, "0x0");
        db.row = snap({ status: "payment_hold", txHash: HASH2 });
        return ok({
          broadcastsAfterAttempt1: 1,
          attempts: [{ name: "attempt-1", ok: false, error: { name: "SettlementTransportError", message: "timed out" } }],
          afterAttempt1: snap({ status: "confirmed", effect: { status: "failed", attempts: 1, operation: "settlement.transfer_usdc", externalRef: null } }),
          broadcasts: [HASH1, HASH2],
        });
      },
    });
    const code = await runOrchestrator(args({ statePath, scenario: "timeout-retry" }), h.ports);
    expect(code).toBe(1);
    expect(h.spawned).toHaveLength(1);
    expect(h.emitted.join("\n")).toMatch(/"name": "order_reconciled"[\s\S]*?"status": "FAIL"/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Secrets and the report file
// ---------------------------------------------------------------------------------------------------------------------

describe("secrets never appear in output", () => {
  it("redacts the RPC token and the key from anything a child or a guard prints", () => {
    const scrub = makeScrubber(GOOD_ENV);
    const line = `error at ${RPC_URL} with key ${TEST_KEY} and token ${TOKEN}`;
    const out = scrub(line);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(TEST_KEY);
  });

  it("the orchestrator's output, including a child's log lines, carries no token and no key", async () => {
    const chain = makeChain();
    const db = makeDb();
    const h = makePorts({
      chain,
      db,
      spawn: async () => ({
        code: null,
        signal: "SIGKILL",
        timedOut: false,
        lines: [KILL_ARMED_MARK, `child log: rpc ${RPC_URL} key ${TEST_KEY}`],
      }),
    });
    db.row = snap();
    await runOrchestrator(args({ statePath }), h.ports);
    const all = h.emitted.join("\n");
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain(TEST_KEY);
  });

  it("a report file is written once, as a new file, and refuses to overwrite", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-recovery-report-"));
    const file = path.join(dir, "evidence.json");
    const files = realFiles();
    files.write(file, "{}\n", "new");
    expect(fs.readFileSync(file, "utf8")).toBe("{}\n");
    expect(() => files.write(file, "{\"x\":1}\n", "new")).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("{}\n");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the orchestrator's evidence write goes through the new-file rule", async () => {
    const chain = makeChain();
    const db = makeDb();
    const files = new Map<string, string>();
    const h = makePorts({
      chain,
      db,
      files,
      spawn: async () => ({ code: 1, signal: null, timedOut: false, lines: [] }),
    });
    const evidence = path.join(os.tmpdir(), "evidence-new.json");
    await runOrchestrator(args({ statePath, writeEvidence: evidence }), h.ports);
    expect(files.has(path.resolve(evidence))).toBe(true);
    expect(files.get(path.resolve(evidence))).toMatch(/"harness": "live-recovery-arc"/);
  });
});

describe("the settlement event topic and the revert name", () => {
  it("decodes the contract's OrderAlreadySettled revert name", () => {
    const data = encodeErrorResult({ abi: BIND_SETTLEMENT_ABI, errorName: "OrderAlreadySettled" });
    expect(decodeErrorResult({ abi: BIND_SETTLEMENT_ABI, data }).errorName).toBe("OrderAlreadySettled");
  });

  it("indexes the event by the order id, the same way the adapter filters", () => {
    const topics = encodeEventTopics({
      abi: BIND_SETTLEMENT_ABI,
      eventName: "SettlementExecuted",
      args: { orderId: keccak256(stringToHex(ORDER)) },
    } as never);
    expect(topics[1]).toBe(keccak256(stringToHex(ORDER)));
  });
});

describe("the payment amount", () => {
  it("is one cent and nothing else", () => {
    expect(PAYMENT_CENTS).toBe(1n);
    expect(VENDOR_ADDRESS.toLowerCase()).toBe("0xa8358aed200d6cb6c856f972d853c1be833006ea");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Review fixes: the evidence file is scrubbed, transfers are pinned, the broadcast count is exact, the database host is
// parsed, a skip on the live chain is a failure, and the deploy block must hold code.
// ---------------------------------------------------------------------------------------------------------------------

describe("the evidence and state files go through the scrubber", () => {
  it("a file written through the real port carries neither the RPC URL, its token, the key, nor the database URL", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-recovery-scrub-"));
    const file = path.join(dir, "evidence.json");
    const files = realFiles(makeScrubber(GOOD_ENV));
    files.write(file, `error: ${RPC_URL} and ${DB_URL} and key ${TEST_KEY}`, "new");
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("bind_local_only");
    expect(text).not.toContain(TEST_KEY);
    expect(text).not.toContain(RPC_URL);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the orchestrator's evidence file is scrubbed when a blocked read's error text carries both URLs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-recovery-evidence-"));
    const evidence = path.join(dir, "evidence.json");
    const db = makeDb();
    const h = makePorts({ chain: undefined, db, spawn: async () => ok({}) });
    h.ports.files = realFiles(makeScrubber(GOOD_ENV));
    h.ports.rpc = async () => {
      throw new Error(`connect to ${RPC_URL} failed for ${DB_URL}`);
    };
    const code = await runOrchestrator(args({ statePath: path.join(dir, "state.json"), writeEvidence: evidence }), h.ports);
    expect(code).toBe(2);
    const text = fs.readFileSync(evidence, "utf8");
    expect(text).toMatch(/"result": "BLOCKED"/);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("bind_local_only");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("the transfer is pinned to the signer, the vendor and the prepared order", () => {
  function pinned(req: Partial<typeof REQ>) {
    const log: string[] = [];
    const guarded = guardedAdapter(
      innerAdapter(log),
      { beforeTransfer: async () => void log.push("beforeTransfer") },
      PINS
    );
    return { run: () => guarded.transferUSDC({ ...REQ, ...req }), log };
  }

  it("refuses a transfer from an address other than the signer, before any chain read or send", async () => {
    const p = pinned({ fromAddress: "0x3333333333333333333333333333333333333333" });
    await expect(p.run()).rejects.toBeInstanceOf(RefusedError);
    expect(p.log).toEqual([]);
  });

  it("refuses a transfer to a vendor other than the pinned one", async () => {
    const p = pinned({ toAddress: "0x4444444444444444444444444444444444444444" });
    await expect(p.run()).rejects.toThrow(/pinned vendor/);
    expect(p.log).toEqual([]);
  });

  it("refuses a transfer for another order id", async () => {
    const p = pinned({ orderId: "ord-other" });
    await expect(p.run()).rejects.toThrow(/prepared order/);
    expect(p.log).toEqual([]);
  });

  it("accepts the same vendor in another letter case", async () => {
    const p = pinned({ toAddress: VENDOR_ADDRESS.toLowerCase() });
    await expect(p.run()).resolves.toMatchObject({ txHash: HASH1 });
    expect(p.log).toEqual(["beforeTransfer", "transfer"]);
  });
});

describe("the broadcast count is exact in the timeout scenario", () => {
  const afterAttempt1 = snap({
    status: "confirmed",
    effect: { status: "failed", attempts: 1, operation: "settlement.transfer_usdc", externalRef: null },
  });
  const failedAttempt = { name: "attempt-1", ok: false, error: { name: "SettlementTransportError", message: "timed out" } };
  const chain = {
    contract: APPROVED_SETTLEMENT_ADDRESS,
    startNonce: "5",
    endNonce: "7",
    vendorBefore: "0",
    vendorAfter: "10000",
    expectedDelta: "10000",
    logs: [{ transactionHash: HASH1, blockNumber: 101n }],
    receipt: null,
  };

  it("fails attempt 1 when it broadcast twice, and the broadcast count is then not exactly one", () => {
    const out = timeoutAssertions({
      stopped: undefined,
      broadcastsAfterAttempt1: 2,
      attempts: [failedAttempt],
      afterAttempt1,
      final: afterAttempt1,
      adapter: "arc",
      chain,
      broadcasts: [{ hash: HASH1, receipt: null }, { hash: HASH2, receipt: null }],
    });
    expect(out.find((a) => a.name === "attempt1_broadcast_exactly_once")?.status).toBe("FAIL");
    expect(verdictOf(out, "arc")).toBe("FAIL");
  });

  it("makes the nonce delta a hard check: it must equal the broadcasts and be one or two", () => {
    const base = {
      stopped: undefined,
      broadcastsAfterAttempt1: 1,
      attempts: [failedAttempt],
      afterAttempt1,
      final: snap({ status: "reconciled", txHash: HASH1 }),
      adapter: "arc" as const,
    };
    const oneBroadcastDeltaTwo = timeoutAssertions({
      ...base,
      chain,
      broadcasts: [{ hash: HASH1, receipt: null }],
    });
    expect(oneBroadcastDeltaTwo.find((a) => a.name === "signer_nonce_delta")?.status).toBe("FAIL");

    const twoBroadcastsDeltaTwo = timeoutAssertions({
      ...base,
      chain,
      broadcasts: [{ hash: HASH1, receipt: null }, { hash: HASH2, receipt: null }],
    });
    expect(twoBroadcastsDeltaTwo.find((a) => a.name === "signer_nonce_delta")?.status).toBe("PASS");
    expect(twoBroadcastsDeltaTwo.find((a) => a.name === "signer_nonce_delta")?.status).not.toBe("INFO");

    const threeBroadcasts = timeoutAssertions({
      ...base,
      chain: { ...chain, endNonce: "8" },
      broadcasts: [{ hash: HASH1, receipt: null }, { hash: HASH2, receipt: null }, { hash: HASH2, receipt: null }],
    });
    expect(threeBroadcasts.find((a) => a.name === "signer_nonce_delta")?.status).toBe("FAIL");
  });

  it("a skipped check on the live chain fails the run, and a skipped check on local-sim does not", () => {
    const assertions = [
      { name: "x", status: "PASS" as const, detail: "" },
      { name: "y", status: "SKIPPED" as const, detail: "" },
    ];
    expect(verdictOf(assertions, "arc")).toBe("FAIL");
    expect(verdictOf(assertions, "local-sim")).toBe("PASS");
    expect(verdictOf([{ name: "z", status: "FAIL" as const, detail: "" }], "local-sim")).toBe("FAIL");
  });
});

describe("the database host is parsed as pg parses it", () => {
  it("accepts 127.0.0.1 and localhost, with or without other query parameters", () => {
    expect(databaseHostProblem("postgres://u:p@127.0.0.1:5432/x")).toBeUndefined();
    expect(databaseHostProblem("postgres://u:p@localhost:5432/x?sslmode=require")).toBeUndefined();
  });

  it("refuses a remote host, an unset URL and a value that is not a URL, and names no value", () => {
    const remote = databaseHostProblem("postgres://u:p@db.example.test:5432/x");
    expect(remote).toMatch(/must be 127.0.0.1 or localhost/);
    expect(remote).not.toContain("example.test");
    expect(databaseHostProblem(undefined)).toMatch(/not set/);
    expect(databaseHostProblem("not a url")).toMatch(/not a URL/);
  });

  it("refuses a host or hostaddr query parameter, whatever the authority says, in any letter case", () => {
    expect(databaseHostProblem("postgres://u:p@127.0.0.1:5432/x?host=db.example.test")).toMatch(/host or hostaddr/);
    expect(databaseHostProblem("postgres://u:p@127.0.0.1:5432/x?hostaddr=10.0.0.1")).toMatch(/host or hostaddr/);
    expect(databaseHostProblem("postgres://u:p@localhost:5432/x?HOST=db.example.test")).toMatch(/host or hostaddr/);
  });

  it("refuses the run through the static guards too", () => {
    const failures = staticGuards({ ...GOOD_ENV, DATABASE_URL: "postgres://u:p@127.0.0.1:5432/x?host=db.example.test" }, args(), false);
    expect(failures.map((f) => f.guard)).toContain("database-host");
  });
});

describe("the deploy block must hold code, and must exist, before anything is sent", () => {
  it("passes when the contract has code at the deploy block and the block is at or before the head", async () => {
    const chain = makeChain();
    await expect(assertDeployBlockCode(chain.rpc, APPROVED_SETTLEMENT_ADDRESS, 1000n)).resolves.toBeUndefined();
  });

  it("is BLOCKED when the contract has no code at the deploy block", async () => {
    const chain = makeChain({ noCode: true });
    await expect(assertDeployBlockCode(chain.rpc, APPROVED_SETTLEMENT_ADDRESS, 1000n)).rejects.toThrow(/no code at BIND_SETTLEMENT_DEPLOY_BLOCK/);
  });

  it("is BLOCKED when the deploy block is ahead of the chain head", async () => {
    const chain = makeChain();
    const err = await assertDeployBlockCode(chain.rpc, APPROVED_SETTLEMENT_ADDRESS, 999999n).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect((err as Error).message).toMatch(/ahead of the chain head/);
  });

  it("is BLOCKED when the read fails", async () => {
    const down: RpcCall = async () => {
      throw new Error("connection refused");
    };
    await expect(assertDeployBlockCode(down, APPROVED_SETTLEMENT_ADDRESS, 1000n)).rejects.toBeInstanceOf(BlockedError);
  });

  it("an orchestrator run stops before any send when the deploy block holds no code", async () => {
    const db = makeDb();
    const chain = makeChain({ noCode: true });
    const h = makePorts({ chain, db, spawn: async () => ok({}) });
    expect(await runOrchestrator(args({ statePath }), h.ports)).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(db.prepared).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// --resume: continues a run whose send started, never sends, and refuses on every missing mark.
// ---------------------------------------------------------------------------------------------------------------------

describe("--resume arguments", () => {
  it("accepts --resume with the orchestrate phase, and an operator baseline only with --resume", () => {
    expect(parseArgs(["crash-before-record", "--resume"], "/tmp")).toMatchObject({ resume: true });
    expect(
      parseArgs(["crash-before-record", "--resume", "--baseline-nonce", "9", "--baseline-vendor-balance", "61000"], "/tmp")
    ).toMatchObject({ resume: true, baselineNonce: "9", baselineVendorBalance: "61000" });
  });

  it("refuses --resume with another phase, a baseline without --resume, and a baseline that is not a whole number", () => {
    expect(() => parseArgs(["crash-before-record", "--resume", "--phase", "verify"])).toThrow(/orchestrate phase only/);
    expect(() => parseArgs(["crash-before-record", "--baseline-nonce", "9"])).toThrow(/only used with --resume/);
    expect(() => parseArgs(["crash-before-record", "--resume", "--baseline-nonce", "9.5", "--baseline-vendor-balance", "1"])).toThrow(
      /whole number/
    );
  });
});

/** A state file for a crash scenario whose send started and was killed, with the kill recorded. */
function crashState(over: Partial<ScenarioState> = {}): ScenarioState {
  return state({
    sendStartedAt: "2026-10-22T00:00:00.000Z",
    baseline: {
      startNonce: "5",
      vendorBalanceBefore: "0",
      decimals: 6,
      contract: APPROVED_SETTLEMENT_ADDRESS,
      deployBlock: DEPLOY_BLOCK,
      signer: SIGNER,
      vendor: VENDOR_ADDRESS,
    },
    results: {
      sendChild: { signal: "SIGKILL", killArmed: true },
      preCrash: snap(),
      preRestart: preRestartAssertions("crash-before-record", snap()),
    },
    ...over,
  });
}

describe("--resume refusals (no send is made on any refusal)", () => {
  const withState = (st: ScenarioState | null, over: Partial<CliArgs> = {}) => {
    const files = new Map<string, string>();
    if (st) files.set(statePath, JSON.stringify(st, null, 2));
    const db = makeDb();
    const chain = makeChain();
    const h = makePorts({ chain, db, files, spawn: async () => ok({}) });
    return { h, db, run: () => runOrchestrator(args({ statePath, resume: true, ...over }), h.ports) };
  };

  it("refuses when there is no state file", async () => {
    const t = withState(null);
    expect(await t.run()).toBe(2);
    expect(t.h.spawned).toEqual([]);
    expect(t.h.emitted.join("\n")).toMatch(/has none/);
  });

  it("refuses when the send has not started", async () => {
    const t = withState(crashState({ sendStartedAt: undefined }));
    expect(await t.run()).toBe(2);
    expect(t.h.spawned).toEqual([]);
    expect(t.h.emitted.join("\n")).toMatch(/send has not started/);
  });

  it("refuses when the recovery already started", async () => {
    const t = withState(crashState({ recoverStartedAt: "2026-10-22T00:00:01.000Z" }));
    expect(await t.run()).toBe(2);
    expect(t.h.spawned).toEqual([]);
    expect(t.h.emitted.join("\n")).toMatch(/will not run it again/);
  });

  it("refuses a crash scenario whose kill point is not recorded", async () => {
    const t = withState(crashState({ results: { sendChild: { signal: "SIGTERM", killArmed: false } } }));
    expect(await t.run()).toBe(2);
    expect(t.h.spawned).toEqual([]);
    expect(t.h.emitted.join("\n")).toMatch(/does not record the SIGKILL/);
  });

  it("refuses timeout-retry unless the state shows attempt 1 completed", async () => {
    const t = withState(
      state({ scenario: "timeout-retry", sendStartedAt: "2026-10-22T00:00:00.000Z", results: { send: null } }),
      { scenario: "timeout-retry" }
    );
    expect(await t.run()).toBe(2);
    expect(t.h.spawned).toEqual([]);
    expect(t.h.emitted.join("\n")).toMatch(/attempt 1 completed/);
  });

  it("refuses without --confirm-testnet-spend before reading the state", async () => {
    const t = withState(crashState(), { confirmTestnetSpend: false });
    expect(await t.run()).toBe(2);
    expect(t.h.spawned).toEqual([]);
  });
});

describe("--resume baseline handling", () => {
  it("refuses a state with no baseline when no operator baseline is supplied", async () => {
    const files = new Map<string, string>([[statePath, JSON.stringify(crashState({ baseline: undefined }))]]);
    const h = makePorts({ chain: makeChain(), db: makeDb(), files, spawn: async () => ok({}) });
    expect(await runOrchestrator(args({ statePath, resume: true }), h.ports)).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(h.emitted.join("\n")).toMatch(/supply --baseline-nonce/);
  });

  it("records an operator-supplied baseline, labelled as such, and then runs only the restart", async () => {
    const files = new Map<string, string>([[statePath, JSON.stringify(crashState({ baseline: undefined }))]]);
    const chain = makeChain();
    chain.broadcastAndMine(HASH1);
    const db = makeDb(snap({ status: "settling", txHash: null, effect: { status: "started", attempts: 1, operation: "settlement.transfer_usdc", externalRef: null } }));
    const h = makePorts({
      chain,
      db,
      files,
      spawn: async (argv) => {
        expect(argv[argv.indexOf("--phase") + 1]).toBe("recover");
        db.row = snap({
          status: "reconciled",
          txHash: HASH1,
          submittedAt: "t",
          confirmedAt: "t",
          confirmedBlock: String(Number(chain.receipts.get(HASH1)!.blockNumber)),
          effect: { status: "completed", attempts: 1, operation: "settlement.transfer_usdc", externalRef: HASH1 },
          audits: ["settlement.submitted", "settlement.confirmed"],
        });
        return ok({ steps: [{ name: "fulfill-repeat", result: { alreadyReconciled: true }, nonceBefore: "6", nonceAfter: "6" }] });
      },
    });
    const code = await runOrchestrator(args({ statePath, resume: true, baselineNonce: "5", baselineVendorBalance: "0" }), h.ports);
    expect(code).toBe(0);
    expect(h.spawned.map((a) => a[a.indexOf("--phase") + 1])).toEqual(["recover"]);
    const saved = JSON.parse(files.get(statePath)!);
    expect(saved.results.baselineSource).toBe("supplied by operator");
    expect(saved.baseline.startNonce).toBe("5");
    expect(h.emitted.join("\n")).toMatch(/"baselineSource": "supplied by operator"|supplied by operator/);
    expect(h.emitted.join("\n")).toMatch(/"result": "PASS"/);
  });

  it("refuses a supplied baseline that differs from the state file's, and overwrites nothing", async () => {
    const files = new Map<string, string>([[statePath, JSON.stringify(crashState())]]);
    const h = makePorts({ chain: makeChain(), db: makeDb(), files, spawn: async () => ok({}) });
    const before = files.get(statePath);
    expect(await runOrchestrator(args({ statePath, resume: true, baselineNonce: "9", baselineVendorBalance: "61000" }), h.ports)).toBe(2);
    expect(h.spawned).toEqual([]);
    expect(files.get(statePath)).toBe(before);
  });
});

describe("--resume never invokes the send path", () => {
  it("a crash resume runs the restart child only, reads the chain, and sends nothing", async () => {
    const files = new Map<string, string>([[statePath, JSON.stringify(crashState())]]);
    const chain = makeChain();
    chain.broadcastAndMine(HASH1);
    const db = makeDb(snap({ status: "settling", txHash: null, effect: { status: "started", attempts: 1, operation: "settlement.transfer_usdc", externalRef: null } }));
    const phases: string[] = [];
    const h = makePorts({
      chain,
      db,
      files,
      spawn: async (argv) => {
        phases.push(argv[argv.indexOf("--phase") + 1]);
        db.row = snap({
          status: "reconciled",
          txHash: HASH1,
          submittedAt: "t",
          confirmedAt: "t",
          confirmedBlock: String(Number(chain.receipts.get(HASH1)!.blockNumber)),
          effect: { status: "completed", attempts: 1, operation: "settlement.transfer_usdc", externalRef: HASH1 },
          audits: ["settlement.submitted", "settlement.confirmed"],
        });
        return ok({ steps: [{ name: "fulfill-repeat", result: { alreadyReconciled: true }, nonceBefore: "6", nonceAfter: "6" }] });
      },
    });
    // The fake chain answers no eth_sendRawTransaction: a send from this process would throw, and the test would fail.
    expect(await runOrchestrator(args({ statePath, resume: true }), h.ports)).toBe(0);
    expect(phases).toEqual(["recover"]);
    expect(db.prepared).toBe(0);
    expect(chain.calls).not.toContain("eth_sendRawTransaction");
    expect(h.emitted.join("\n")).toMatch(/"sendsSpawnedByResume": 0/);
  });

  it("a timeout-retry resume with attempt 1 completed verifies the outcome and spawns nothing", async () => {
    const files = new Map<string, string>([
      [
        statePath,
        JSON.stringify(
          state({
            scenario: "timeout-retry",
            sendStartedAt: "2026-10-22T00:00:00.000Z",
            baseline: {
              startNonce: "5",
              vendorBalanceBefore: "0",
              decimals: 6,
              contract: APPROVED_SETTLEMENT_ADDRESS,
              deployBlock: DEPLOY_BLOCK,
              signer: SIGNER,
              vendor: VENDOR_ADDRESS,
            },
            results: {
              send: {
                attempts: [
                  { name: "attempt-1", ok: false, error: { name: "SettlementTransportError", message: "timed out" } },
                  { name: "attempt-2-immediate", ok: true, result: { reconciled: true } },
                  { name: "attempt-3-after-mining", ok: true, result: { reconciled: false, alreadyReconciled: true } },
                ],
                broadcastsAfterAttempt1: 1,
                afterAttempt1: snap({ status: "confirmed", effect: { status: "failed", attempts: 1, operation: "settlement.transfer_usdc", externalRef: null } }),
                broadcasts: [HASH1],
              },
            },
          }),
          null,
          2
        ),
      ],
    ]);
    const chain = makeChain();
    chain.broadcastAndMine(HASH1);
    const db = makeDb(
      snap({
        status: "reconciled",
        txHash: HASH1,
        submittedAt: "t",
        confirmedAt: "t",
        confirmedBlock: String(Number(chain.receipts.get(HASH1)!.blockNumber)),
        effect: { status: "completed", attempts: 2, operation: "settlement.transfer_usdc", externalRef: HASH1 },
        audits: ["settlement.submitted", "settlement.confirmed"],
      })
    );
    const h = makePorts({ chain, db, files, spawn: async () => ok({}) });
    expect(await runOrchestrator(args({ statePath, resume: true, scenario: "timeout-retry" }), h.ports)).toBe(0);
    expect(h.spawned).toEqual([]);
    expect(h.emitted.join("\n")).toMatch(/"result": "PASS"/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The harness's own settlement-log read is chunked too.
// ---------------------------------------------------------------------------------------------------------------------

describe("the harness's settlement-log read scans in windows", () => {
  /** A range-limited RPC: refuses any eth_getLogs over 100000 blocks, like the Arc endpoint, and answers the rest. */
  function rangeLimitedRpc(head: bigint, logBlocks: bigint[], refuseFromBlock?: bigint) {
    const spans: Array<[bigint, bigint]> = [];
    const rpc: RpcCall = async (method, params) => {
      if (method === "eth_blockNumber") return `0x${head.toString(16)}`;
      if (method !== "eth_getLogs") throw new Error(`stub does not answer ${method}`);
      const filter = params[0] as { fromBlock: string; toBlock: string };
      const from = BigInt(filter.fromBlock);
      const to = BigInt(filter.toBlock);
      spans.push([from, to]);
      if (to - from + 1n > 100_000n) throw new Error("eth_getLogs: query exceeds max block range 100000");
      if (refuseFromBlock !== undefined && from === refuseFromBlock) throw new Error("eth_getLogs: upstream returned 503");
      return logBlocks
        .filter((b) => b >= from && b <= to)
        .map((b) => ({ transactionHash: `0x${b.toString(16).padStart(64, "0")}`, blockNumber: `0x${b.toString(16)}` }));
    };
    return { rpc, spans };
  }

  it("finds every log across a 1.37M-block span, with every window under the RPC limit", async () => {
    const stub = rangeLimitedRpc(1_370_000n, [1_000_500n, 1_300_000n]);
    const logs = await readSettlementLogs(stub.rpc, APPROVED_SETTLEMENT_ADDRESS, ORDER, 1000n);
    expect(logs.map((l) => l.blockNumber)).toEqual([1_300_000n, 1_000_500n]);
    expect(stub.spans.length).toBeGreaterThan(1);
    for (const [from, to] of stub.spans) expect(to - from + 1n).toBeLessThanOrEqual(100_000n);
  });

  it("a failed window is BLOCKED, never an incomplete answer", async () => {
    const stub = rangeLimitedRpc(1_370_000n, [1_300_000n], 1_370_000n - 90_000n + 1n);
    await expect(readSettlementLogs(stub.rpc, APPROVED_SETTLEMENT_ADDRESS, ORDER, 1000n)).rejects.toBeInstanceOf(BlockedError);
  });
});
