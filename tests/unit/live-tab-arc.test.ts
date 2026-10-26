import { afterEach, describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFunctionData, encodeFunctionData, encodeFunctionResult, keccak256, toHex, type Address, type Hex } from "viem";
import type { TransferRequest } from "../../src/adapters/settlement/types.js";
import { BIND_SETTLEMENT_ABI } from "../../src/adapters/settlement/bind-settlement.abi.js";
import { USDC_ABI } from "../../src/adapters/settlement/arc-l1.js";
import { ledgerKeys, tabAdapterOrderId } from "../../src/tabs/units.js";
import {
  APPROVED_SETTLEMENT_ADDRESS,
  BlockedError,
  RefusedError,
  VENDOR_ADDRESS,
  assertContractGuards,
  assertNotSettled,
  makeScrubber,
  oneCentInBaseUnits,
  realFiles,
  signerAddressOf,
  verdictOf,
  type Assertion,
  type RpcCall,
} from "../../scripts/live-recovery-arc.js";
import {
  CHARGE_MICRO,
  APPROVED_DEPLOY_BLOCK,
  CONFIRMATION_CHECKS,
  DEFAULT_SPEND_LEDGER,
  assertNoCodeBefore,
  effectiveDeployBlock,
  EXIT_SUBMITTED_UNCONFIRMED,
  GAS_MARGIN_NATIVE_WEI,
  KILL_ARMED_MARK,
  LOCAL_SIM_PAYER,
  PAYMENT_NATIVE_WEI,
  REMAINDER_MICRO,
  SETTLEMENT_MICRO,
  TAB_TOTAL_MICRO,
  TOTAL_CAP_PAYMENTS,
  assertCapAndBalance,
  assertOneCentSettlement,
  assertOrderUnpaid,
  assertSimulates,
  balanceReasons,
  buildSendHooks,
  classifyPriorSend,
  classifySendFacts,
  countVendorPayments,
  databaseNameProblem,
  readNativeBalance,
  realSpendLedger,
  recordedBroadcastHashes,
  runTabPreflight,
  settleOrderCall,
  totalCapReasons,
  verdictFor,
  workspaceRowsProblem,
  type SendFacts,
  type SpendLedger,
  type SpendLock,
  type SpendRecord,
  assertTabPhase,
  assertTabStateMatches,
  auditIndex,
  broadcastsFromOutcome,
  clearCountOf,
  countAudits,
  isLoopbackRpcUrl,
  localRehearsalAdapter,
  parseTabArgs,
  parseTabState,
  pinSettlement,
  preRestartAssertions,
  preparedTabAssertions,
  readPaymentsFromSigner,
  resumeProblems,
  reversalCount,
  runTabChild,
  runTabOrchestrator,
  tabAssertions,
  tabGuardedAdapter,
  tabRecoverPlan,
  tabStaticGuards,
  toTabSnapshot,
  type ChainFacts,
  type ChildEvidence,
  type SettlementRowView,
  type TabCliArgs,
  type TabPorts,
  type TabSnapshot,
  type TabState,
  type VerifyInput,
} from "../../scripts/live-tab-arc.js";

/**
 * The tab harness with every edge stubbed: no network, no database, no child process. The fake RPC answers the reads the
 * harness makes; the fake database and the fake ports hold rows the tests build. The key and the token are test values:
 * neither may appear in any output or file the harness writes.
 */
const TOKEN = "SECRETTOKEN-XYZ123";
const RPC_URL = `https://rpc.example.test/v1/${TOKEN}`;
const TEST_KEY = `0x${"11".repeat(32)}`;
const DB_URL = "postgres://bind_local:bind_local_only@127.0.0.1:5432/bind_tab_rehearsal";
const SIGNER = signerAddressOf(TEST_KEY) as string;
const WS = "ws-unit-tab";
const CP = "cp-unit-tab";
const SET = "tabset-unit-1";
const TX = `0x${"ab".repeat(32)}`;
const TX2 = `0x${"cd".repeat(32)}`;
const CONTRACT = APPROVED_SETTLEMENT_ADDRESS;
const DEPLOY = "1000";

const GOOD_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: DB_URL,
  ARC_RPC_URL: RPC_URL,
  ARC_SIGNER_PRIVATE_KEY: TEST_KEY,
  BIND_SETTLEMENT_ADDRESS: APPROVED_SETTLEMENT_ADDRESS,
  BIND_SETTLEMENT_DEPLOY_BLOCK: DEPLOY,
};

function args(over: Partial<TabCliArgs> = {}): TabCliArgs {
  return {
    scenario: "settle",
    phase: "orchestrate",
    adapter: "arc",
    confirmTestnetSpend: true,
    statePath: path.join(os.tmpdir(), "unused-live-tab-state.json"),
    fresh: false,
    resume: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// A fake JSON-RPC (answers by method, and for eth_call by the function selector). Nothing leaves the process.
// ---------------------------------------------------------------------------------------------------------------------

/** A balance comfortably above one cent plus the gas margin, in the native token. */
const FUNDED = `0x${(10n ** 18n).toString(16)}`;

function fakeRpc(answers: Record<string, (params: unknown[]) => unknown> = {}, calls: string[] = []): RpcCall {
  const base: Record<string, (params: unknown[]) => unknown> = {
    eth_chainId: () => "0x4cef52",
    eth_blockNumber: () => "0x3e8",
    eth_getCode: () => "0x6000",
    eth_getTransactionCount: () => "0x0",
    eth_getLogs: () => [],
    eth_getTransactionReceipt: () => null,
    eth_getBalance: () => FUNDED,
    eth_estimateGas: () => "0x5208",
    ...answers,
  };
  return async (method: string, params: unknown[]) => {
    calls.push(method);
    const handler = base[method];
    if (!handler) throw new Error(`fake rpc: ${method} not answered`);
    return handler(params);
  };
}

/** A chain whose contract guards all hold, and whose settled read answers `settled`. */
function guardedChain(
  over: {
    chainId?: string;
    owner?: string;
    whitelisted?: boolean;
    enforced?: boolean;
    settled?: boolean;
    latestNonce?: string;
    pendingNonce?: string;
    /** How many SettlementExecuted logs an order query (two topics) answers with. */
    logs?: number;
    /** How many logs a payment query (the signer's, or the signer's to the vendor) answers with. Defaults to `logs`. */
    payments?: number;
    balance?: string;
    estimate?: "ok" | "revert";
  } = {},
  calls: string[] = []
): RpcCall {
  const ethCall = (params: unknown[]) => {
    const data = (params[0] as { data: Hex }).data;
    const is = (fn: string, extra: unknown[] = []) => data === encodeFunctionData({ abi: BIND_SETTLEMENT_ABI, functionName: fn as never, args: extra as never });
    if (is("owner")) return encodeFunctionResult({ abi: BIND_SETTLEMENT_ABI, functionName: "owner", result: (over.owner ?? SIGNER) as Address });
    if (is("enforceVendorWhitelist")) return encodeFunctionResult({ abi: BIND_SETTLEMENT_ABI, functionName: "enforceVendorWhitelist", result: over.enforced ?? true });
    if (data.startsWith(encodeFunctionData({ abi: BIND_SETTLEMENT_ABI, functionName: "whitelistedVendors", args: [VENDOR_ADDRESS as Address] }).slice(0, 10))) {
      return encodeFunctionResult({ abi: BIND_SETTLEMENT_ABI, functionName: "whitelistedVendors", result: over.whitelisted ?? true });
    }
    if (data === encodeFunctionData({ abi: USDC_ABI, functionName: "decimals" })) {
      return encodeFunctionResult({ abi: USDC_ABI, functionName: "decimals", result: 6 });
    }
    if (data.startsWith(encodeFunctionData({ abi: USDC_ABI, functionName: "balanceOf", args: [VENDOR_ADDRESS as Address] }).slice(0, 10))) {
      return encodeFunctionResult({ abi: USDC_ABI, functionName: "balanceOf", result: 0n });
    }
    if (data.startsWith(encodeFunctionData({ abi: BIND_SETTLEMENT_ABI, functionName: "settledOrders", args: [`0x${"00".repeat(32)}`] }).slice(0, 10))) {
      return encodeFunctionResult({ abi: BIND_SETTLEMENT_ABI, functionName: "settledOrders", result: over.settled ?? false });
    }
    throw new Error("fake rpc: unexpected eth_call");
  };
  return fakeRpc(
    {
      eth_chainId: () => over.chainId ?? "0x4cef52",
      eth_call: ethCall,
      eth_getTransactionCount: (params) => (params[1] === "pending" ? (over.pendingNonce ?? "0x0") : (over.latestNonce ?? "0x0")),
      eth_getLogs: (params) => {
        // viem pads every indexed slot with null. An order query names the order id (slot 1); a payment query names the payer.
        const topics = (params[0] as { topics: unknown[] }).topics;
        const isOrder = topics[1] !== null && topics[1] !== undefined;
        const n = isOrder ? (over.logs ?? 0) : (over.payments ?? over.logs ?? 0);
        return Array.from({ length: n }, (_, i) => ({ transactionHash: `0x${(i + 1).toString(16).padStart(64, "0")}`, blockNumber: "0x3e8" }));
      },
      eth_getBalance: () => over.balance ?? FUNDED,
      // Code at the deploy block (1000) and none at the block before it (999), as a fresh deployment shows.
      eth_getCode: (params) => (params[1] === "0x3e7" ? "0x" : "0x6000"),
      eth_estimateGas: () => {
        if (over.estimate === "revert") throw new Error("execution reverted");
        return "0x5208";
      },
    },
    calls
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Fixtures for the pure builders
// ---------------------------------------------------------------------------------------------------------------------

const settled = (over: Record<string, unknown> = {}) => ({
  id: SET,
  amount_cents: "1",
  status: "confirmed",
  tx_hash: TX,
  hold_reason: null,
  submitted_at: new Date("2026-10-24T10:00:00Z"),
  confirmed_at: new Date("2026-10-24T10:00:05Z"),
  confirmed_block: "1006",
  reconcile_attempts: 0,
  ...over,
});

function goodSnapshot(over: { settlement?: Record<string, unknown>; entries?: Record<string, unknown>[]; effect?: Record<string, unknown> | null; audits?: string[]; supplier?: Record<string, unknown> | null } = {}): TabSnapshot {
  const charges = [1, 2, 3].map(() => ({ kind: "charge", amount_micro: CHARGE_MICRO.toString(), settlement_id: null }));
  const audits = over.audits ?? ["tab.settlement_reserved", "tab.settlement_submitted", "tab.settlement_confirmed"];
  const effect =
    over.effect === null
      ? undefined
      : {
          idempotency_key: ledgerKeys.effect(WS, SET),
          status: "completed",
          attempts: 1,
          operation: "settlement.transfer_usdc",
          external_ref: TX,
          ...(over.effect ?? {}),
        };
  return toTabSnapshot({
    workspaceId: WS,
    settlements: [settled(over.settlement)],
    entries: over.entries ?? [...charges, { kind: "clear", amount_micro: SETTLEMENT_MICRO.toString(), settlement_id: SET }],
    effects: effect ? [effect] : [],
    audits: audits.map((action) => ({ action, tx_hash: action === "tab.settlement_submitted" || action === "tab.settlement_confirmed" ? TX : null })),
    supplier: over.supplier === undefined ? { verified: true, payment_address: VENDOR_ADDRESS } : over.supplier,
  });
}

function goodChain(over: Partial<ChainFacts> = {}): ChainFacts {
  return {
    contract: CONTRACT,
    orderId: tabAdapterOrderId(SET),
    startNonce: "0",
    endNonce: "1",
    vendorBefore: "0",
    vendorAfter: "10000",
    expectedDelta: "10000",
    logs: [{ transactionHash: TX, blockNumber: 1006n }],
    paymentsSinceBaseline: [{ transactionHash: TX, blockNumber: 1006n }],
    ...over,
  };
}

const confirmed = (txHash: string = TX): ChildEvidence["confirmSnapshots"][number] => ({
  txHash,
  settlementStatus: "submitted",
  submittedAt: true,
  submittedAuditRows: 1,
  txHashRecorded: txHash,
});

function settleSend(over: Partial<ChildEvidence> = {}): ChildEvidence {
  return {
    phase: "send",
    steps: [
      { name: "settle", data: { result: { outcome: "settlement", status: "confirmed" }, transferCalls: 1 } },
      { name: "repeat", data: { result: { outcome: "below_threshold" }, transferCallsDelta: 0, nonceBefore: "1", nonceAfter: "1" } },
    ],
    confirmSnapshots: [confirmed()],
    broadcasts: [TX],
    transferCalls: 1,
    ...over,
  };
}

function crashInput(over: Partial<VerifyInput> = {}): VerifyInput {
  return {
    scenario: "crash-after-send",
    adapter: "arc",
    snap: goodSnapshot(),
    chain: goodChain(),
    broadcasts: [TX],
    receipts: { [TX]: { hash: TX, status: "success", blockNumber: 1006n, from: SIGNER, to: CONTRACT } },
    send: undefined,
    recover: {
      phase: "recover",
      steps: [
        { name: "tick", data: { settlementStatus: "confirmed", tab: { resumed: 1, confirmed: 1 } } },
        { name: "tick-repeat", data: { settlementStatus: "confirmed", transferCallsDelta: 0, nonceBefore: "1", nonceAfter: "1" } },
      ],
      confirmSnapshots: [confirmed()],
      broadcasts: [],
      transferCalls: 0,
    },
    sendChild: { signal: "SIGKILL", killArmed: true },
    preRestart: [],
    ...over,
  };
}

function heldSend(): ChildEvidence {
  return {
    phase: "send",
    steps: [
      { name: "timeout-send", data: { threw: { name: "Error", message: "timed out" }, broadcasts: 1, transferCalls: 1, settlementStatus: "pending", effectStatus: "failed" } },
      { name: "wait-mined", data: { mined: true } },
      {
        name: "hold-unverified",
        data: { outcome: { kind: "held", hold: "SETTLEMENT_OUTCOME_UNKNOWN" }, clearsKept: true, reversals: 0, broadcastsDelta: 0, transferCallsDelta: 0, verifiedRestored: true },
      },
      {
        name: "restore-refused",
        data: {
          outcome: { kind: "refused", code: "NOT_PROVABLY_UNSENT", reason: "a transfer for the order was found" },
          reversals: 0,
          holdStatus: "held",
          lookup: { found: true, isOrderSettled: true },
        },
      },
      {
        name: "worker-tick",
        data: { tab: { reconciled: 1, failed: 0 }, settlementStatus: "confirmed", transferCallsDelta: 0, nonceBefore: "1", nonceAfter: "1" },
      },
      { name: "reconcile-repeat", data: { outcome: { kind: "current" }, transferCallsDelta: 0, nonceBefore: "1", nonceAfter: "1" } },
    ],
    confirmSnapshots: [confirmed()],
    broadcasts: [TX],
    transferCalls: 1,
  };
}

function heldSnapshot(): TabSnapshot {
  return goodSnapshot({
    audits: ["tab.settlement_held", "tab.settlement_hash_adopted", "tab.settlement_restore_refused", "tab.settlement_confirmed"],
  });
}

function heldInput(over: Partial<VerifyInput> = {}): VerifyInput {
  return {
    scenario: "held-adopt",
    adapter: "arc",
    snap: heldSnapshot(),
    chain: goodChain(),
    broadcasts: [TX],
    receipts: { [TX]: { hash: TX, status: "success", blockNumber: 1006n, from: SIGNER, to: CONTRACT } },
    send: heldSend(),
    sendChild: { signal: null, killArmed: false },
    ...over,
  };
}

function settleInput(over: Partial<VerifyInput> = {}): VerifyInput {
  return {
    scenario: "settle",
    adapter: "arc",
    snap: goodSnapshot(),
    chain: goodChain(),
    broadcasts: [TX],
    receipts: { [TX]: { hash: TX, status: "success", blockNumber: 1006n, from: SIGNER, to: CONTRACT } },
    send: settleSend(),
    sendChild: { signal: null, killArmed: false },
    ...over,
  };
}

const failing = (list: { name: string; status: string }[]) => list.filter((a) => a.status === "FAIL").map((a) => a.name);

/** Every state file the orchestrator tests write. Removed after each test, so the temp directory is left as it was. */
const TMP_FILES: string[] = [];
afterEach(() => {
  for (const file of TMP_FILES.splice(0)) fs.rmSync(file, { force: true });
});

// ---------------------------------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------------------------------

describe("parseTabArgs", () => {
  it("takes one scenario and the documented options", () => {
    const parsed = parseTabArgs(["settle", "--confirm-testnet-spend", "--state", "/tmp/s.json", "--write-evidence", "/tmp/e.json", "--fresh"]);
    expect(parsed).toMatchObject({ scenario: "settle", adapter: "arc", confirmTestnetSpend: true, statePath: "/tmp/s.json", writeEvidence: "/tmp/e.json", fresh: true, resume: false, phase: "orchestrate" });
  });

  it("defaults the state file to a per-scenario file in the temp directory", () => {
    expect(parseTabArgs(["held-adopt"], "/x").statePath).toBe(path.join("/x", "bind-live-tab-held-adopt.json"));
  });

  it("refuses an unknown scenario, a missing or extra scenario, and a bad adapter or phase", () => {
    expect(() => parseTabArgs(["nope"])).toThrow(/unknown scenario/);
    expect(() => parseTabArgs([])).toThrow(/usage/);
    expect(() => parseTabArgs(["settle", "held-adopt"])).toThrow(/usage/);
    expect(() => parseTabArgs(["settle", "--adapter", "mainnet"])).toThrow(/--adapter/);
    expect(() => parseTabArgs(["settle", "--phase", "verify"])).toThrow(/unknown phase/);
  });

  it("refuses every option that could change the amount, the recipient, the contract or the endpoint", () => {
    for (const bad of ["--amount", "--amount-cents", "--micro", "--vendor", "--contract", "--rpc", "--rpc-url", "--key", "--count"]) {
      expect(() => parseTabArgs(["settle", bad, "1"])).toThrow(/unknown option/);
    }
  });

  it("refuses --resume with a phase, and a value option with no value", () => {
    expect(() => parseTabArgs(["settle", "--resume", "--phase", "send-child"])).toThrow(/orchestrate phase only/);
    expect(() => parseTabArgs(["settle", "--state"])).toThrow(/needs a value/);
  });

  it("says in the usage text that --fresh is a new payment", () => {
    expect(() => parseTabArgs(["nope"])).toThrow(/--fresh starts a NEW payment of 0\.01 USDC/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Static guards: every rule refuses, and none names a value
// ---------------------------------------------------------------------------------------------------------------------

describe("tabStaticGuards", () => {
  const guardsOf = (env: NodeJS.ProcessEnv, over: Partial<Parameters<typeof tabStaticGuards>[1]> = {}, exists = false) =>
    tabStaticGuards(env, { adapter: "arc", confirmTestnetSpend: true, writeEvidence: undefined, ...over }, exists).map((f) => f.guard);

  it("passes for a complete arc environment with the confirm flag", () => {
    expect(guardsOf(GOOD_ENV)).toEqual([]);
  });

  it("refuses an arc run without --confirm-testnet-spend", () => {
    expect(guardsOf(GOOD_ENV, { confirmTestnetSpend: false })).toContain("confirm-flag");
  });

  it("refuses NODE_ENV production, a non-local database host, and host or hostaddr parameters", () => {
    expect(guardsOf({ ...GOOD_ENV, NODE_ENV: "production" })).toContain("node-env");
    expect(guardsOf({ ...GOOD_ENV, DATABASE_URL: "postgres://u:p@db.example.com:5432/bind" })).toContain("database-host");
    expect(guardsOf({ ...GOOD_ENV, DATABASE_URL: "postgres://u:p@127.0.0.1/bind?host=db.example.com" })).toContain("database-host");
    expect(guardsOf({ ...GOOD_ENV, DATABASE_URL: "postgres://u:p@127.0.0.1/bind?hostaddr=10.0.0.5" })).toContain("database-host");
    expect(guardsOf({ ...GOOD_ENV, DATABASE_URL: undefined })).toContain("database-host");
  });

  it("refuses a SETTLEMENT_MODE other than arc-testnet, and allows it unset", () => {
    expect(guardsOf({ ...GOOD_ENV, SETTLEMENT_MODE: "local" })).toContain("settlement-mode");
    expect(guardsOf({ ...GOOD_ENV, SETTLEMENT_MODE: "arc-testnet" })).toEqual([]);
  });

  it("refuses any contract address but the approved one, a missing deploy block, a non-http RPC and a bad key", () => {
    expect(guardsOf({ ...GOOD_ENV, BIND_SETTLEMENT_ADDRESS: "0x0000000000000000000000000000000000000001" })).toContain("settlement-address");
    expect(guardsOf({ ...GOOD_ENV, BIND_SETTLEMENT_ADDRESS: undefined })).toContain("settlement-address");
    // The approved deploy block is hardcoded: an unset override is the approved block, and an override above it is refused.
    expect(guardsOf({ ...GOOD_ENV, BIND_SETTLEMENT_DEPLOY_BLOCK: undefined })).not.toContain("deploy-block");
    expect(guardsOf({ ...GOOD_ENV, BIND_SETTLEMENT_DEPLOY_BLOCK: (APPROVED_DEPLOY_BLOCK + 1n).toString() })).toContain("deploy-block");
    expect(guardsOf({ ...GOOD_ENV, BIND_SETTLEMENT_DEPLOY_BLOCK: "12.5" })).toContain("deploy-block");
    expect(guardsOf({ ...GOOD_ENV, ARC_RPC_URL: "ws://rpc.example.test" })).toContain("rpc-url");
    expect(guardsOf({ ...GOOD_ENV, ARC_SIGNER_PRIVATE_KEY: "0x1234" })).toContain("signer-key");
  });

  it("refuses an existing evidence file", () => {
    expect(guardsOf(GOOD_ENV, { writeEvidence: "/tmp/exists.json" }, true)).toContain("evidence-file");
    expect(guardsOf(GOOD_ENV, { writeEvidence: "/tmp/new.json" }, false)).toEqual([]);
  });

  it("refuses local-sim while the live settings are present, and passes local-sim with them unset", () => {
    expect(guardsOf({ NODE_ENV: "test", DATABASE_URL: DB_URL, ARC_RPC_URL: RPC_URL }, { adapter: "local-sim", confirmTestnetSpend: false })).toContain("local-sim-offline");
    expect(guardsOf({ NODE_ENV: "test", DATABASE_URL: DB_URL }, { adapter: "local-sim", confirmTestnetSpend: false })).toEqual([]);
  });

  it("names the rule and never the value", () => {
    const reasons = tabStaticGuards(
      { ...GOOD_ENV, ARC_RPC_URL: "ftp://" + TOKEN, ARC_SIGNER_PRIVATE_KEY: "0xff", DATABASE_URL: "postgres://x:y@db.example.com/" + TOKEN },
      { adapter: "arc", confirmTestnetSpend: true },
      false
    )
      .map((f) => f.reason)
      .join(" ");
    expect(reasons).not.toContain(TOKEN);
    expect(reasons).not.toContain("0xff");
  });
});

describe("isLoopbackRpcUrl", () => {
  it("is true for this machine only", () => {
    expect(isLoopbackRpcUrl("http://127.0.0.1:8545/x")).toBe(true);
    expect(isLoopbackRpcUrl("http://localhost:8545")).toBe(true);
    expect(isLoopbackRpcUrl(RPC_URL)).toBe(false);
    expect(isLoopbackRpcUrl(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Amount and pin guards
// ---------------------------------------------------------------------------------------------------------------------

describe("assertOneCentSettlement", () => {
  it("accepts exactly one cent and refuses everything else", () => {
    expect(() => assertOneCentSettlement("1")).not.toThrow();
    expect(() => assertOneCentSettlement(1n)).not.toThrow();
    for (const bad of ["0", "2", "10", "1.5"]) expect(() => assertOneCentSettlement(bad)).toThrow(RefusedError);
  });
});

describe("pinSettlement", () => {
  const rowOf = (over: Partial<SettlementRowView> = {}) => ({
    db: {
      settlementRow: async (_ws: string, id: string): Promise<SettlementRowView | null> =>
        id === SET ? { id: SET, counterpartyId: CP, status: "pending", amountCents: "1", ...over } : null,
    },
  });

  it("accepts a pending one-cent settlement of this tab", async () => {
    await expect(pinSettlement(rowOf().db, WS, CP, tabAdapterOrderId(SET))).resolves.toBeUndefined();
  });

  it("refuses an order id that is not a tab order id, an unknown settlement, another tab, a settled row and a non-cent amount", async () => {
    const { db } = rowOf();
    await expect(pinSettlement(db, WS, CP, "ord-123")).rejects.toThrow(/not a tab settlement order id/);
    await expect(pinSettlement(db, WS, CP, "tab_missing")).rejects.toThrow(/not a settlement of this tab/);
    await expect(pinSettlement(rowOf().db, WS, "other-tab", tabAdapterOrderId(SET))).rejects.toThrow(/not a settlement of this tab/);
    await expect(pinSettlement(rowOf({ status: "confirmed" }).db, WS, CP, tabAdapterOrderId(SET))).rejects.toThrow(/not pending/);
    await expect(pinSettlement(rowOf({ amountCents: "2" }).db, WS, CP, tabAdapterOrderId(SET))).rejects.toThrow(/not 1 cent/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The guarded adapter: the synchronous pins, then the hooks; nothing reaches the inner adapter on a refusal
// ---------------------------------------------------------------------------------------------------------------------

describe("tabGuardedAdapter", () => {
  function setup() {
    const order: string[] = [];
    let inner = 0;
    const adapter = {
      mode: "arc-testnet" as const,
      getBalance: async () => 0n,
      transferUSDC: async () => {
        inner += 1;
        order.push("inner");
        return { txHash: TX, status: "submitted" as const, timestamp: new Date(), mode: "arc-testnet" as const, simulated: false };
      },
      confirm: async () => ({ txHash: TX, status: "confirmed" as const, timestamp: new Date(), mode: "arc-testnet" as const, simulated: false }),
      findTransfer: async () => null,
      isOrderSettled: async () => false,
      depositEscrow: async () => {
        throw new Error("no");
      },
      releaseEscrow: async () => {
        throw new Error("no");
      },
    };
    const hooks = {
      beforeTransfer: async () => {
        order.push("beforeTransfer");
      },
      afterTransfer: async () => {
        order.push("afterTransfer");
      },
      beforeConfirm: async () => {
        order.push("beforeConfirm");
      },
    };
    const guarded = tabGuardedAdapter(adapter, hooks, { payer: SIGNER, vendor: VENDOR_ADDRESS });
    const good = { fromAddress: SIGNER, toAddress: VENDOR_ADDRESS, amountCents: 1n, currency: "USDC", orderId: tabAdapterOrderId(SET), idempotencyKey: "k", matchHash: TX };
    return { guarded, good, order, inner: () => inner };
  }

  it("sends exactly the pinned transfer, with the hooks in order", async () => {
    const { guarded, good, order, inner } = setup();
    await guarded.adapter.transferUSDC(good);
    expect(inner()).toBe(1);
    expect(guarded.transferCalls()).toBe(1);
    expect(order).toEqual(["beforeTransfer", "inner", "afterTransfer"]);
  });

  it("refuses an amount that is not one cent before any hook or the inner adapter", async () => {
    for (const amountCents of [2n, 0n, 1000n]) {
      const { guarded, good, order, inner } = setup();
      await expect(guarded.adapter.transferUSDC({ ...good, amountCents })).rejects.toThrow(RefusedError);
      expect(order).toEqual([]);
      expect(inner()).toBe(0);
    }
  });

  it("refuses a payer other than the signer, a payee other than the vendor, and an order id that is not a tab's", async () => {
    const { guarded, good, inner, order } = setup();
    await expect(guarded.adapter.transferUSDC({ ...good, fromAddress: LOCAL_SIM_PAYER })).rejects.toThrow(/does not pay from the signer/);
    await expect(guarded.adapter.transferUSDC({ ...good, toAddress: "0x0000000000000000000000000000000000000002" })).rejects.toThrow(/does not pay the pinned vendor/);
    await expect(guarded.adapter.transferUSDC({ ...good, orderId: "ord-1" })).rejects.toThrow(/not a tab settlement/);
    expect(inner()).toBe(0);
    expect(order).toEqual([]);
  });

  it("refuses when a hook refuses, and the inner adapter is not called", async () => {
    const order: string[] = [];
    const adapter = {
      mode: "arc-testnet" as const,
      getBalance: async () => 0n,
      transferUSDC: async () => {
        order.push("inner");
        throw new Error("must not run");
      },
      confirm: async () => {
        throw new Error("no");
      },
      depositEscrow: async () => {
        throw new Error("no");
      },
      releaseEscrow: async () => {
        throw new Error("no");
      },
    };
    const guarded = tabGuardedAdapter(adapter, { beforeTransfer: async () => { throw new RefusedError(["the owner is not the signer"]); } }, { payer: SIGNER, vendor: VENDOR_ADDRESS });
    await expect(
      guarded.adapter.transferUSDC({ fromAddress: SIGNER, toAddress: VENDOR_ADDRESS, amountCents: 1n, currency: "USDC", orderId: tabAdapterOrderId(SET), idempotencyKey: "k", matchHash: TX })
    ).rejects.toThrow(/owner is not the signer/);
    expect(guarded.transferCalls()).toBe(0);
    expect(order).toEqual([]);
  });

  it("confirms through the hook, and passes the reads through", async () => {
    const { guarded, order } = setup();
    await guarded.adapter.confirm(TX);
    expect(order).toEqual(["beforeConfirm"]);
    expect(guarded.adapter.findTransfer).toBeDefined();
    expect(guarded.adapter.isOrderSettled).toBeDefined();
  });

  it("refuses escrow", async () => {
    const { guarded } = setup();
    await expect(guarded.adapter.depositEscrow!({} as never, "m")).rejects.toThrow(RefusedError);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Chain guards: each rule refuses, and a settled order is refused before any broadcast
// ---------------------------------------------------------------------------------------------------------------------

describe("chain guards before a send", () => {
  const cfg = { contract: CONTRACT, signer: SIGNER, vendor: VENDOR_ADDRESS };

  it("passes when chain id, owner, whitelist and enforcement all hold", async () => {
    await expect(assertContractGuards(guardedChain(), cfg)).resolves.toMatchObject({ chainId: 5042002 });
  });

  it("refuses a wrong chain id, a foreign owner, an unlisted vendor and a disabled whitelist", async () => {
    await expect(assertContractGuards(guardedChain({ chainId: "0x1" }), cfg)).rejects.toThrow(/eth_chainId is 1/);
    await expect(assertContractGuards(guardedChain({ owner: "0x0000000000000000000000000000000000000009" }), cfg)).rejects.toThrow(/owner is not the signer/);
    await expect(assertContractGuards(guardedChain({ whitelisted: false }), cfg)).rejects.toThrow(/vendor is not whitelisted/);
    await expect(assertContractGuards(guardedChain({ enforced: false }), cfg)).rejects.toThrow(/enforceVendorWhitelist is false/);
  });

  it("refuses an order the contract already settled, and sends nothing (no broadcast is attempted)", async () => {
    const calls: string[] = [];
    await expect(assertNotSettled(guardedChain({ settled: true }, calls), CONTRACT, tabAdapterOrderId(SET))).rejects.toThrow(/already settled/);
    expect(calls).not.toContain("eth_sendRawTransaction");
  });

  it("passes an unsettled order", async () => {
    await expect(assertNotSettled(guardedChain({ settled: false }), CONTRACT, tabAdapterOrderId(SET))).resolves.toBeUndefined();
  });
});

describe("readPaymentsFromSigner", () => {
  it("reads the signer's SettlementExecuted logs from the given block, in windows, and maps them", async () => {
    const seen: unknown[] = [];
    const rpc = fakeRpc({
      eth_blockNumber: () => "0x3e8",
      eth_getLogs: (params) => {
        seen.push(params[0]);
        return [{ transactionHash: TX, blockNumber: "0x3f0" }];
      },
    });
    const logs = await readPaymentsFromSigner(rpc, CONTRACT, SIGNER, 990n);
    expect(logs).toEqual([{ transactionHash: TX, blockNumber: 1008n }]);
    // One window: from 990 to the head 1000, as an inclusive range, filtered on the event and the payer.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ address: CONTRACT, fromBlock: "0x3de", toBlock: "0x3e8" });
    expect((seen[0] as { topics: unknown[] }).topics).toHaveLength(4);
  });

  it("throws when a window fails: a failed read is never read as no payment", async () => {
    const rpc = fakeRpc({
      eth_blockNumber: () => "0x3e8",
      eth_getLogs: () => {
        throw new Error("fake: range failed");
      },
    });
    await expect(readPaymentsFromSigner(rpc, CONTRACT, SIGNER, 990n)).rejects.toThrow(/range failed/);
  });
});

describe("oneCentInBaseUnits", () => {
  it("is 10^(decimals-2), and refuses unusable decimals", () => {
    expect(oneCentInBaseUnits(6)).toBe(10_000n);
    expect(() => oneCentInBaseUnits(1)).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// State: the phase guard, the resume refusals and the parse
// ---------------------------------------------------------------------------------------------------------------------

function stateOf(over: Partial<TabState> = {}): TabState {
  return {
    version: 1,
    harness: "live-tab-arc",
    scenario: "settle",
    adapter: "arc",
    workspaceId: WS,
    counterpartyId: CP,
    payer: SIGNER,
    vendor: VENDOR_ADDRESS,
    baseline: { startNonce: "0", vendorBalanceBefore: "0", decimals: 6, contract: CONTRACT, deployBlock: DEPLOY, signer: SIGNER, vendor: VENDOR_ADDRESS },
    results: {},
    ...over,
  };
}

describe("state", () => {
  it("parses a record of this harness and refuses any other file", () => {
    expect(parseTabState(JSON.stringify(stateOf()))).not.toBeNull();
    expect(parseTabState(JSON.stringify({ ...stateOf(), harness: "live-recovery-arc" }))).toBeNull();
    expect(parseTabState(JSON.stringify({ ...stateOf(), version: 2 }))).toBeNull();
    expect(parseTabState("not json")).toBeNull();
    expect(parseTabState("null")).toBeNull();
  });

  it("refuses a state that belongs to another scenario or adapter", () => {
    expect(() => assertTabStateMatches(stateOf(), { scenario: "held-adopt", adapter: "arc" })).toThrow(RefusedError);
    expect(() => assertTabStateMatches(stateOf(), { scenario: "settle", adapter: "local-sim" })).toThrow(RefusedError);
  });

  it("refuses a second send, a recover before the send, and a second recover", () => {
    expect(() => assertTabPhase(null, "send", { scenario: "settle", adapter: "arc" })).toThrow(/no prepared state/);
    expect(() => assertTabPhase(stateOf({ sendStartedAt: "t" }), "send", { scenario: "settle", adapter: "arc" })).toThrow(/a second send is refused/);
    expect(() => assertTabPhase(stateOf(), "recover", { scenario: "settle", adapter: "arc" })).toThrow(/the send has not started/);
    expect(() => assertTabPhase(stateOf({ sendStartedAt: "t", recoverStartedAt: "t2" }), "recover", { scenario: "settle", adapter: "arc" })).toThrow(/already ran/);
    expect(() => assertTabPhase(stateOf(), "send", { scenario: "settle", adapter: "arc" })).not.toThrow();
    expect(() => assertTabPhase(stateOf({ sendStartedAt: "t" }), "recover", { scenario: "settle", adapter: "arc" })).not.toThrow();
  });

  it("refuses a resume with no state, no send, a recovery already started, no kill marker, and a baseline mismatch", () => {
    const env = { BIND_SETTLEMENT_ADDRESS: APPROVED_SETTLEMENT_ADDRESS, BIND_SETTLEMENT_DEPLOY_BLOCK: DEPLOY };
    const a = { scenario: "crash-after-send" as const, adapter: "arc" as const };
    expect(resumeProblems(null, a, env, SIGNER)[0]).toMatch(/has none/);
    expect(resumeProblems(stateOf({ scenario: "crash-after-send" }), a, env, SIGNER)[0]).toMatch(/send has not started/);
    const started = { sendStartedAt: "t", results: { sendChild: { signal: "SIGKILL", killArmed: true } } };
    expect(resumeProblems(stateOf({ scenario: "crash-after-send", ...started, recoverStartedAt: "r" }), a, env, SIGNER)[0]).toMatch(/recovery already started/);
    // On arc, a send with no recorded result is decided by the chain (runTabResume), not refused here.
    expect(resumeProblems(stateOf({ scenario: "crash-after-send", sendStartedAt: "t", results: {} }), a, env, SIGNER)).toEqual([]);
    // The local rehearsal has no chain to read, so it still needs the recorded kill.
    const local = { scenario: "crash-after-send" as const, adapter: "local-sim" as const };
    expect(resumeProblems(stateOf({ ...local, sendStartedAt: "t", results: {} }), local, env, SIGNER)[0]).toMatch(/SIGKILL/);
    expect(resumeProblems(stateOf({ scenario: "crash-after-send", ...started }), a, env, SIGNER)).toEqual([]);
    expect(resumeProblems(stateOf({ scenario: "crash-after-send", ...started }), a, { ...env, BIND_SETTLEMENT_DEPLOY_BLOCK: "1001" }, SIGNER).join(" ")).toMatch(/baseline mismatch/);
    expect(resumeProblems(stateOf({ scenario: "crash-after-send", ...started }), a, env, "0x0000000000000000000000000000000000000001").join(" ")).toMatch(/baseline mismatch/);
  });

  it("refuses a settle resume whose send child did not finish, and one with no baseline", () => {
    const env = { BIND_SETTLEMENT_ADDRESS: APPROVED_SETTLEMENT_ADDRESS, BIND_SETTLEMENT_DEPLOY_BLOCK: DEPLOY };
    const a = { scenario: "settle" as const, adapter: "arc" as const };
    // On arc the chain decides a send with no recorded child result: resume does not refuse on it.
    expect(resumeProblems(stateOf({ sendStartedAt: "t" }), a, env, SIGNER)).toEqual([]);
    const local = { scenario: "settle" as const, adapter: "local-sim" as const };
    expect(resumeProblems(stateOf({ ...local, sendStartedAt: "t" }), local, env, SIGNER).join(" ")).toMatch(/send child did not finish/);
    expect(resumeProblems(stateOf({ sendStartedAt: "t", baseline: undefined, results: { send: {} } }), a, env, SIGNER).join(" ")).toMatch(/no baseline/);
    expect(resumeProblems(stateOf({ sendStartedAt: "t", results: { send: {} } }), a, env, SIGNER)).toEqual([]);
  });

  it("recovers with the same two ticks for crash and settle, and none for held-adopt (the child does it all)", () => {
    expect(tabRecoverPlan("crash-after-send")).toEqual(["tick", "tick-repeat"]);
    expect(tabRecoverPlan("settle")).toEqual(["tick", "tick-repeat"]);
    expect(tabRecoverPlan("held-adopt")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The database view and the assertions
// ---------------------------------------------------------------------------------------------------------------------

describe("toTabSnapshot", () => {
  it("computes the balance from charges, clears and reversals, and keys the effect by settlement", () => {
    const snap = goodSnapshot();
    expect(snap.balanceMicro).toBe(REMAINDER_MICRO.toString());
    expect(snap.effects[SET]?.attempts).toBe(1);
    expect(snap.settlements[0].txHash).toBe(TX);
    expect(clearCountOf(snap, SET)).toBe(1);
    expect(reversalCount(snap)).toBe(0);
    expect(snap.counterparty).toEqual({ verified: true, paymentAddress: VENDOR_ADDRESS });
  });

  it("reads a reversal as a credit back to the balance", () => {
    const snap = goodSnapshot({
      entries: [
        { kind: "charge", amount_micro: "15000", settlement_id: null },
        { kind: "clear", amount_micro: "10000", settlement_id: SET },
        { kind: "reversal", amount_micro: "10000", settlement_id: SET },
      ],
    });
    expect(snap.balanceMicro).toBe("15000");
    expect(reversalCount(snap)).toBe(1);
  });
});

describe("preparedTabAssertions and preRestartAssertions", () => {
  it("accept the prepared tab and refuse a different one", () => {
    const prepared = toTabSnapshot({
      workspaceId: WS,
      settlements: [],
      entries: [1, 2, 3].map(() => ({ kind: "charge", amount_micro: "5000", settlement_id: null })),
      effects: [],
      audits: [],
      supplier: null,
    });
    expect(failing(preparedTabAssertions(prepared))).toEqual([]);
    expect(preparedTabAssertions(toTabSnapshot({ workspaceId: WS, settlements: [], entries: [{ kind: "charge", amount_micro: "15000", settlement_id: null }], effects: [], audits: [], supplier: null })).some((a) => a.status === "FAIL")).toBe(true);
    expect(failing(preparedTabAssertions(goodSnapshot()))).toContain("prepared_no_settlement");
  });

  it("accept a settlement pending after a crash, and refuse one that already has a hash", () => {
    const pending = goodSnapshot({
      settlement: { status: "pending", tx_hash: null, submitted_at: null, confirmed_at: null, confirmed_block: null },
      effect: { status: "started", attempts: 1, external_ref: null },
      audits: ["tab.settlement_reserved"],
      entries: [
        ...[1, 2, 3].map(() => ({ kind: "charge", amount_micro: "5000", settlement_id: null })),
        { kind: "clear", amount_micro: "10000", settlement_id: SET },
      ],
    });
    expect(failing(preRestartAssertions(pending))).toEqual([]);
    expect(failing(preRestartAssertions(goodSnapshot({ settlement: { status: "pending" }, effect: { status: "started" }, audits: ["tab.settlement_reserved"] })))).toContain("pre_restart_no_hash");
    expect(failing(preRestartAssertions(goodSnapshot({ settlement: { status: "pending", tx_hash: null }, effect: { status: "completed" }, audits: ["tab.settlement_reserved"] })))).toContain("pre_restart_effect_started");
  });
});

describe("tabAssertions (arc, the three scenarios)", () => {
  it("the settle scenario passes on consistent facts, and the verdict is PASS", () => {
    const list = tabAssertions(settleInput());
    expect(failing(list)).toEqual([]);
    expect(verdictOf(list, "arc")).toBe("PASS");
  });

  it("the crash scenario passes when the restart adopts and sends nothing", () => {
    const list = tabAssertions(crashInput());
    expect(failing(list)).toEqual([]);
    expect(verdictOf(list, "arc")).toBe("PASS");
  });

  it("the held scenario passes when the hold keeps the clear, the restore is refused by the chain, and the worker adopts", () => {
    const list = tabAssertions(heldInput());
    expect(failing(list)).toEqual([]);
    expect(verdictOf(list, "arc")).toBe("PASS");
  });

  it("fails a second payment, a second log, a vendor delta that is not one cent, and a nonce delta that is not the broadcasts", () => {
    expect(failing(tabAssertions(settleInput({ chain: goodChain({ paymentsSinceBaseline: [{ transactionHash: TX, blockNumber: 1006n }, { transactionHash: TX2, blockNumber: 1007n }] }) })))).toContain("only_this_run_paid_since_baseline");
    expect(failing(tabAssertions(settleInput({ chain: goodChain({ logs: [{ transactionHash: TX, blockNumber: 1006n }, { transactionHash: TX2, blockNumber: 1007n }] }) })))).toContain("one_settlement_log");
    expect(failing(tabAssertions(settleInput({ chain: goodChain({ vendorAfter: "20000" }) })))).toContain("vendor_delta_one_cent");
    expect(failing(tabAssertions(settleInput({ chain: goodChain({ endNonce: "2" }) })))).toContain("signer_nonce_delta_one");
    expect(failing(tabAssertions(settleInput({ broadcasts: [TX, TX2] })))).toContain("broadcasts_exactly_one");
  });

  it("fails a reverted receipt, a hash that does not match the log, and a block that does not match", () => {
    expect(failing(tabAssertions(settleInput({ receipts: { [TX]: { hash: TX, status: "reverted", blockNumber: 1006n, from: SIGNER, to: CONTRACT } } })))).toContain("receipt_success");
    expect(failing(tabAssertions(settleInput({ chain: goodChain({ logs: [{ transactionHash: TX2, blockNumber: 1006n }] }) })))).toContain("tx_hash_matches_log");
    expect(failing(tabAssertions(settleInput({ chain: goodChain({ logs: [{ transactionHash: TX, blockNumber: 1007n }] }) })))).toContain("confirmed_block_matches_log");
  });

  it("fails a reversal, a second clear, a balance that is not the remainder, a second submitted audit and a confirmation twice", () => {
    expect(failing(tabAssertions(settleInput({ snap: goodSnapshot({ entries: [{ kind: "charge", amount_micro: "5000", settlement_id: null }, { kind: "charge", amount_micro: "5000", settlement_id: null }, { kind: "charge", amount_micro: "5000", settlement_id: null }, { kind: "clear", amount_micro: "10000", settlement_id: SET }, { kind: "reversal", amount_micro: "10000", settlement_id: SET }] }) })))).toContain("ledger_zero_reversals");
    expect(failing(tabAssertions(settleInput({ snap: goodSnapshot({ audits: ["tab.settlement_submitted", "tab.settlement_submitted", "tab.settlement_confirmed"] }) })))).toContain("audit_submitted_once");
    expect(failing(tabAssertions(settleInput({ snap: goodSnapshot({ audits: ["tab.settlement_submitted", "tab.settlement_confirmed", "tab.settlement_confirmed"] }) })))).toContain("audit_confirmed_once");
    expect(failing(tabAssertions(settleInput({ snap: goodSnapshot({ settlement: { status: "submitted" } }) })))).toContain("settlement_confirmed");
  });

  it("fails an effect that was attempted twice (a second send, not an adoption)", () => {
    expect(failing(tabAssertions(crashInput({ snap: goodSnapshot({ effect: { attempts: 2 } }) })))).toContain("effect_attempts_one");
  });

  it("fails the crash scenario when the child did not die at its kill point, and when the restart called transferUSDC", () => {
    expect(failing(tabAssertions(crashInput({ sendChild: { signal: null, killArmed: false } })))).toContain("child_killed_at_crash_point");
    const restart = crashInput();
    restart.recover!.transferCalls = 1;
    expect(failing(tabAssertions(restart))).toContain("restart_settles_without_resend");
  });

  it("fails the settle scenario when the repeat sent, or its nonce moved", () => {
    const sent = settleInput({ send: settleSend({ steps: [{ name: "settle", data: { result: { outcome: "settlement" } } }, { name: "repeat", data: { result: { outcome: "below_threshold" }, transferCallsDelta: 1, nonceBefore: "1", nonceAfter: "2" } }] }) });
    expect(failing(tabAssertions(sent))).toContain("repeat_below_threshold_no_send");
  });

  it("fails the held scenario when the restore was allowed, when the hold reversed the clear, and when the worker did not adopt", () => {
    const allowed = heldSend();
    allowed.steps[3] = { name: "restore-refused", data: { outcome: { kind: "cancelled" }, reversals: 1, holdStatus: "cancelled", lookup: { found: false, isOrderSettled: false } } };
    expect(failing(tabAssertions(heldInput({ send: allowed })))).toEqual(expect.arrayContaining(["restore_refused_by_chain", "restore_refused_no_reversal"]));
    const reversed = heldSend();
    reversed.steps[2] = { name: "hold-unverified", data: { outcome: { kind: "held", hold: "SETTLEMENT_OUTCOME_UNKNOWN" }, clearsKept: false, reversals: 1, broadcastsDelta: 1, transferCallsDelta: 1, verifiedRestored: true } };
    expect(failing(tabAssertions(heldInput({ send: reversed })))).toContain("hold_keeps_clear_no_reversal_no_broadcast");
    const noAdopt = heldSend();
    noAdopt.steps[4] = { name: "worker-tick", data: { tab: { reconciled: 0, failed: 0 }, settlementStatus: "held" } };
    expect(failing(tabAssertions(heldInput({ send: noAdopt })))).toContain("worker_held_step_adopts_and_confirms");
  });

  it("fails the held scenario when the first call did not end in an unknown outcome with one broadcast", () => {
    const bad = heldSend();
    bad.steps[0] = { name: "timeout-send", data: { threw: null, broadcasts: 2, transferCalls: 2, settlementStatus: "confirmed", effectStatus: "completed" } };
    expect(failing(tabAssertions(heldInput({ send: bad })))).toEqual(expect.arrayContaining(["timeout_send_threw_unknown", "timeout_one_broadcast"]));
  });
});

describe("tabAssertions (local-sim)", () => {
  it("skips the chain checks, never fails them, and passes on consistent database facts", () => {
    const list = tabAssertions(settleInput({ adapter: "local-sim", chain: undefined, receipts: {} }));
    expect(list.filter((a) => a.status === "SKIPPED").map((a) => a.name)).toEqual(expect.arrayContaining(["one_settlement_log", "vendor_delta_one_cent", "receipt_success"]));
    expect(verdictOf(list, "local-sim")).toBe("PASS");
  });

  it("reports the simulator's re-send after a restart as information, not as a check", () => {
    const list = tabAssertions(crashInput({ adapter: "local-sim", chain: undefined, receipts: {}, recover: { ...crashInput().recover!, transferCalls: 1 } }));
    expect(list.some((a) => a.name === "local_restart_transfer_calls" && a.status === "INFO")).toBe(true);
    expect(failing(list)).toEqual([]);
  });
});

describe("the arc verdict", () => {
  it("is FAIL when a chain check could not be read, because a skipped check is a gap in the evidence", () => {
    const list = tabAssertions(settleInput({ chain: undefined }));
    expect(verdictOf(list, "arc")).toBe("FAIL");
  });
});

describe("broadcastsFromOutcome", () => {
  it("collects the distinct hashes from the broadcast lines, in order", () => {
    expect(broadcastsFromOutcome(["sending", "LIVE_TAB_BROADCAST " + TX, "noise", "LIVE_TAB_BROADCAST " + TX2, "LIVE_TAB_BROADCAST " + TX])).toEqual([TX, TX2]);
  });
});

describe("auditIndex and countAudits", () => {
  it("count and order the audit actions", () => {
    const snap = goodSnapshot();
    expect(countAudits(snap, "tab.settlement_confirmed")).toBe(1);
    expect(auditIndex(snap, "tab.settlement_submitted")).toBeLessThan(auditIndex(snap, "tab.settlement_confirmed"));
    expect(auditIndex(snap, "tab.nothing")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Scrubbing and files
// ---------------------------------------------------------------------------------------------------------------------

describe("redaction", () => {
  const scrub = makeScrubber({ ARC_RPC_URL: RPC_URL, ARC_SIGNER_PRIVATE_KEY: TEST_KEY, DATABASE_URL: DB_URL });

  it("removes the RPC URL, its path token, the key and the database password from any text", () => {
    const text = `failed at ${RPC_URL} key ${TEST_KEY} db ${DB_URL} token ${TOKEN}`;
    const out = scrub(text);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(TEST_KEY);
    expect(out).not.toContain("bind_local_only");
    expect(out).not.toContain(RPC_URL);
  });

  it("removes a viem-style error that carries the RPC URL", () => {
    const error = new Error(`HTTP request failed. URL: ${RPC_URL} Request body: {"method":"eth_sendRawTransaction"}`);
    expect(scrub(error.message)).not.toContain(TOKEN);
  });

  it("keeps a transaction hash, which is not a secret", () => {
    expect(scrub(`hash ${TX}`)).toContain(TX);
  });
});

describe("evidence and state files", () => {
  it("writes a new file and refuses to overwrite one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-tab-unit-"));
    const file = path.join(dir, "evidence.json");
    const files = realFiles((text) => text);
    files.write(file, "one", "new");
    expect(() => files.write(file, "two", "new")).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("one");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("child process refusals (no process is started)", () => {
  it("refuses before it opens the database when a static guard fails", async () => {
    let opened = false;
    const emitted: string[] = [];
    const code = await runTabChild(args({ confirmTestnetSpend: false }), GOOD_ENV, (t) => emitted.push(t), async () => {
      opened = true;
      throw new Error("must not open");
    });
    expect(code).toBe(2);
    expect(opened).toBe(false);
    expect(emitted.join("\n")).toMatch(/LIVE_TAB_RESULT .*refused/);
  });

  it("refuses before it opens the database when there is no prepared state", async () => {
    let opened = false;
    const code = await runTabChild(args({ phase: "send-child", statePath: path.join(os.tmpdir(), `absent-${Date.now()}.json`) }), GOOD_ENV, () => undefined, async () => {
      opened = true;
      throw new Error("must not open");
    });
    expect(code).toBe(2);
    expect(opened).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The orchestrator, with stubbed ports: every refusal happens before a send child is spawned
// ---------------------------------------------------------------------------------------------------------------------

function fakeDb(over: Partial<{ precheck: string[]; rowsCheck: string[]; snapshot: TabSnapshot; prepared: boolean }> = {}) {
  const log = { prepared: 0, closed: 0 };
  const db = {
    precheck: async () => over.precheck ?? [],
    rowsCheck: async () => over.rowsCheck ?? [],
    prepare: async () => {
      log.prepared += 1;
      return { workspaceId: WS, counterpartyId: CP };
    },
    snapshot: async () =>
      over.snapshot ??
      toTabSnapshot({
        workspaceId: WS,
        settlements: [],
        entries: [1, 2, 3].map(() => ({ kind: "charge", amount_micro: "5000", settlement_id: null })),
        effects: [],
        audits: [],
        supplier: null,
      }),
    close: async () => {
      log.closed += 1;
    },
  };
  return { db, log };
}

/** An in-memory spend ledger. Records are kept in order; a test reads them to see what was attempted. */
function memorySpend(initial: SpendRecord[] = []) {
  const records = [...initial];
  let locked = false;
  return {
    records,
    read: () => [...records],
    append: (r: SpendRecord) => void records.push(r),
    acquire: (): SpendLock => {
      if (locked) throw new RefusedError(["a live tab payment lock is held"]);
      locked = true;
      return {
        release: () => {
          locked = false;
        },
      };
    },
    isLocked: () => locked,
  } satisfies SpendLedger & { records: SpendRecord[] };
}

function portsOf(over: Partial<TabPorts> & { calls?: { spawned: number }; db?: ReturnType<typeof fakeDb>["db"]; rpc?: RpcCall; statePath?: string } = {}): { ports: TabPorts; spawned: { n: number }; out: string[]; statePath: string; spend: ReturnType<typeof memorySpend> } {
  const spend = memorySpend();
  const spawned = { n: 0 };
  const out: string[] = [];
  const statePath = over.statePath ?? path.join(os.tmpdir(), `live-tab-orch-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  TMP_FILES.push(statePath);
  const ports: TabPorts = {
    env: GOOD_ENV,
    emit: (t) => out.push(t),
    notify: () => undefined,
    files: realFiles((t) => t),
    rpc: over.rpc ?? guardedChain(),
    db: over.db ?? fakeDb().db,
    spend,
    spawnPhase: async () => {
      spawned.n += 1;
      throw new Error("a send child must not be spawned in this test");
    },
    sleep: async () => undefined,
    now: () => Date.now(),
    ...over,
  } as TabPorts;
  return { ports, spawned, out, statePath, spend };
}

describe("the orchestrator refuses before any send child", () => {
  it("refuses without the confirm flag and spawns nothing", async () => {
    const { ports, spawned, out, statePath } = portsOf();
    const code = await runTabOrchestrator(args({ confirmTestnetSpend: false, statePath }), ports);
    expect(code).toBe(2);
    expect(spawned.n).toBe(0);
    expect(out.join("\n")).toMatch(/"result": "REFUSED"/);
  });

  it("refuses a prepared tab that is not the three charges, and spawns nothing", async () => {
    const { db } = fakeDb({ snapshot: goodSnapshot() });
    const { ports, spawned, statePath } = portsOf({ db });
    const code = await runTabOrchestrator(args({ statePath }), ports);
    expect(code).toBe(2);
    expect(spawned.n).toBe(0);
  });

  it("refuses a database that holds other tab or order work, and prepares nothing", async () => {
    const { db, log } = fakeDb({ precheck: ["the database holds tab settlements that are pending, submitted or held"] });
    const { ports, spawned, statePath } = portsOf({ db });
    expect(await runTabOrchestrator(args({ statePath }), ports)).toBe(2);
    expect(log.prepared).toBe(0);
    expect(spawned.n).toBe(0);
  });

  it("refuses when the signer has a transaction in flight (pending differs from latest), and spawns nothing", async () => {
    const { ports, spawned, statePath } = portsOf({ rpc: guardedChain({ latestNonce: "0x1", pendingNonce: "0x2" }) });
    const code = await runTabOrchestrator(args({ statePath }), ports);
    expect(code).toBe(2);
    expect(spawned.n).toBe(0);
  });

  it("refuses a second send over a state that already recorded one, without --fresh", async () => {
    const { ports, spawned, statePath } = portsOf();
    fs.writeFileSync(statePath, JSON.stringify(stateOf({ sendStartedAt: "2026-10-24T10:00:00Z" })));
    const code = await runTabOrchestrator(args({ statePath }), ports);
    expect(code).toBe(2);
    expect(spawned.n).toBe(0);
    fs.rmSync(statePath, { force: true });
  });

  it("refuses --resume with no state, and spawns nothing", async () => {
    const { ports, spawned, statePath } = portsOf();
    const code = await runTabOrchestrator(args({ resume: true, statePath }), ports);
    expect(code).toBe(2);
    expect(spawned.n).toBe(0);
  });

  it("refuses when the --write-evidence file already exists", async () => {
    const { ports, spawned, statePath } = portsOf({ files: { exists: () => true, read: () => null, write: () => undefined } });
    const code = await runTabOrchestrator(args({ statePath, writeEvidence: "/tmp/already.json" }), ports);
    expect(code).toBe(2);
    expect(spawned.n).toBe(0);
  });
});

describe("the child's database rule, before the send is marked started", () => {
  it("refuses a database that holds another workspace, and leaves the state as it was", async () => {
    const statePath = path.join(os.tmpdir(), `child-rows-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    TMP_FILES.push(statePath);
    fs.writeFileSync(statePath, JSON.stringify(stateOf({ adapter: "local-sim", scenario: "settle" })));
    const localEnv: NodeJS.ProcessEnv = { ...GOOD_ENV };
    delete localEnv.ARC_RPC_URL;
    delete localEnv.ARC_SIGNER_PRIVATE_KEY;
    const db = {
      rowsCheck: async () => ["the workspaces table holds rows that are not this run's; the run's dedicated database is not the one in use; nothing is sent"],
      precheck: async () => [],
      prepare: async () => ({ workspaceId: WS, counterpartyId: CP }),
      snapshot: async () => goodSnapshot(),
      settlementRow: async () => null,
      setVerified: async () => undefined,
      ageEffect: async () => undefined,
      close: async () => undefined,
    };
    const emitted: string[] = [];
    const code = await runTabChild(args({ phase: "send-child", adapter: "local-sim", statePath }), localEnv, (t) => emitted.push(t), async () => db as never);
    expect(code).toBe(2);
    expect(emitted.join("\n")).toMatch(/LIVE_TAB_RESULT .*refused/);
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).sendStartedAt).toBeUndefined();
  });
});

describe("the local rehearsal adapter", () => {
  it("reports a remembered transfer as confirmed, as the Arc log scan does", async () => {
    const adapter = localRehearsalAdapter();
    expect(await adapter.findTransfer!({ orderId: tabAdapterOrderId(SET) })).toBeNull();
    await adapter.transferUSDC({ fromAddress: LOCAL_SIM_PAYER, toAddress: VENDOR_ADDRESS, amountCents: 1n, currency: "USDC", orderId: tabAdapterOrderId(SET), idempotencyKey: "k", matchHash: TX });
    expect((await adapter.findTransfer!({ orderId: tabAdapterOrderId(SET) }))?.status).toBe("confirmed");
    expect(await adapter.isOrderSettled!(tabAdapterOrderId(SET))).toBe(true);
  });
});

describe("the constants the tests rely on", () => {
  it("make three sub-cent charges floor to exactly one cent, with 5000 micro carried over", () => {
    expect(TAB_TOTAL_MICRO).toBe(15_000n);
    expect(SETTLEMENT_MICRO).toBe(10_000n);
    expect(REMAINDER_MICRO).toBe(5_000n);
    expect(KILL_ARMED_MARK).toBe("LIVE_TAB_KILL_ARMED");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The total cap, the balance and the simulation (pure, and through the child's hooks and the orchestrator's checks)
// ---------------------------------------------------------------------------------------------------------------------

describe("the total cap and the balance (pure)", () => {
  it("counts three payments of one cent as the cap, and refuses at it on either count", () => {
    expect(TOTAL_CAP_PAYMENTS).toBe(3);
    expect(totalCapReasons(0, 0)).toEqual([]);
    expect(totalCapReasons(2, 2)).toEqual([]);
    expect(totalCapReasons(3, 0)[0]).toMatch(/total cap is reached.*chain shows 3.*nothing is sent/);
    expect(totalCapReasons(0, 3)[0]).toMatch(/spend ledger holds 3/);
    expect(totalCapReasons(3, 3)).toHaveLength(2);
  });

  it("requires one cent plus the 0.003 USDC margin in the native token, and no more and no less can pass", () => {
    expect(PAYMENT_NATIVE_WEI).toBe(10n ** 16n);
    expect(GAS_MARGIN_NATIVE_WEI).toBe(3n * 10n ** 15n);
    expect(balanceReasons(PAYMENT_NATIVE_WEI + GAS_MARGIN_NATIVE_WEI)).toEqual([]);
    expect(balanceReasons(PAYMENT_NATIVE_WEI + GAS_MARGIN_NATIVE_WEI - 1n)[0]).toMatch(/below one cent plus the 0.003 USDC gas margin/);
    expect(balanceReasons(0n)).toHaveLength(1);
  });

  it("builds the settleOrder call the adapter sends: the keccak of the order id, the supplier, the match hash, one cent of value", () => {
    const call = settleOrderCall({ contract: CONTRACT, orderId: tabAdapterOrderId(SET), supplier: VENDOR_ADDRESS, matchHash: TX });
    const decoded = decodeFunctionData({ abi: BIND_SETTLEMENT_ABI, data: call.data });
    expect(decoded.functionName).toBe("settleOrder");
    expect(decoded.args).toEqual([keccak256(toHex(tabAdapterOrderId(SET))), VENDOR_ADDRESS, TX]);
    expect(call.value).toBe(PAYMENT_NATIVE_WEI);
    expect(call.to).toBe(CONTRACT);
  });
});

describe("the chain reads of the cap and the simulation (fake RPC)", () => {
  it("reads the native balance, and refuses a malformed answer as BLOCKED", async () => {
    expect(await readNativeBalance(guardedChain({ balance: "0x2a" }), SIGNER)).toBe(42n);
    await expect(readNativeBalance(fakeRpc({ eth_getBalance: () => "42" }), SIGNER)).rejects.toThrow(BlockedError);
    await expect(readNativeBalance(fakeRpc({ eth_getBalance: () => { throw new Error("down"); } }), SIGNER)).rejects.toThrow(BlockedError);
  });

  it("passes a simulation that estimates a gas amount, and refuses one that reverts or estimates zero", async () => {
    const call = settleOrderCall({ contract: CONTRACT, orderId: tabAdapterOrderId(SET), supplier: VENDOR_ADDRESS, matchHash: TX });
    await expect(assertSimulates(guardedChain(), SIGNER, call)).resolves.toBeUndefined();
    await expect(assertSimulates(guardedChain({ estimate: "revert" }), SIGNER, call)).rejects.toThrow(/pre-send simulation.*nothing is sent/);
    await expect(assertSimulates(fakeRpc({ eth_estimateGas: () => "0x0" }), SIGNER, call)).rejects.toThrow(RefusedError);
  });

  it("filters the payments by the vendor as well as the payer, so the count is the payments to this vendor", async () => {
    const seen: unknown[][] = [];
    const rpc = fakeRpc({
      eth_getLogs: (params) => {
        seen.push(params);
        return [{ transactionHash: TX, blockNumber: "0x3e8" }];
      },
    });
    expect(await countVendorPayments(rpc, CONTRACT, SIGNER, VENDOR_ADDRESS, 1000n)).toBe(1);
    const topics = (seen[0][0] as { topics: string[] }).topics;
    expect(topics).toHaveLength(4);
    expect(topics[2]).toBe(`0x${"0".repeat(24)}${SIGNER.slice(2).toLowerCase()}`);
    expect(topics[3]).toBe(`0x${"0".repeat(24)}${VENDOR_ADDRESS.slice(2).toLowerCase()}`);
  });

  it("refuses an order that the contract settled, or that has a payment log, and passes an unpaid order", async () => {
    await expect(assertOrderUnpaid(guardedChain({ settled: true }), CONTRACT, tabAdapterOrderId(SET), 1000n)).rejects.toThrow(/already settled/);
    await expect(assertOrderUnpaid(guardedChain({ logs: 1 }), CONTRACT, tabAdapterOrderId(SET), 1000n)).rejects.toThrow(/already shows a payment/);
    await expect(assertOrderUnpaid(guardedChain(), CONTRACT, tabAdapterOrderId(SET), 1000n)).resolves.toBeUndefined();
  });
});

describe("assertCapAndBalance", () => {
  const cfg = (rpc: RpcCall, spend: SpendLedger) => ({ rpc, spend, contract: CONTRACT, signer: SIGNER, vendor: VENDOR_ADDRESS, deployBlock: 1000n });

  it("passes with room under the cap and a funded signer, and reports the counts", async () => {
    const spend = memorySpend([intent(), intent()]);
    expect(await assertCapAndBalance(cfg(guardedChain({ payments: 2 }), spend))).toEqual({ chainPayments: 2, ledgerAttempts: 2 });
  });

  it("refuses at the cap on the chain, with the ledger empty", async () => {
    await expect(assertCapAndBalance(cfg(guardedChain({ payments: 3 }), memorySpend()))).rejects.toThrow(/total cap is reached/);
  });

  it("refuses at the cap in the ledger, with the chain empty", async () => {
    await expect(assertCapAndBalance(cfg(guardedChain(), memorySpend([intent(), intent(), intent()])))).rejects.toThrow(/spend ledger holds 3/);
  });

  it("refuses a low balance, and a balance it cannot read is BLOCKED (never read as funded)", async () => {
    await expect(assertCapAndBalance(cfg(guardedChain({ balance: "0x1" }), memorySpend()))).rejects.toThrow(/gas margin/);
    await expect(assertCapAndBalance(cfg(fakeRpc({ eth_getBalance: () => { throw new Error("down"); } }), memorySpend()))).rejects.toThrow(BlockedError);
  });
});

function intent(settlementId: string = SET): SpendRecord {
  return { kind: "intent", at: "2026-10-26T00:00:00.000Z", scenario: "settle", workspaceId: WS, settlementId };
}

describe("buildSendHooks: every check runs before a broadcast, and the ledger intent is the last one", () => {
  const request = (over: Partial<TransferRequest> = {}): TransferRequest => ({
    fromAddress: SIGNER,
    toAddress: VENDOR_ADDRESS,
    amountCents: 1n,
    currency: "USDC",
    orderId: tabAdapterOrderId(SET),
    idempotencyKey: "k",
    matchHash: TX,
    ...over,
  });
  const db = { settlementRow: async (_ws: string, id: string) => ({ id, counterpartyId: CP, status: "pending", amountCents: "1" }) };
  const config = (rpc: RpcCall, spend: SpendLedger, over: Partial<Parameters<typeof buildSendHooks>[0]> = {}) => ({
    rpc,
    spend,
    contract: CONTRACT,
    signer: SIGNER,
    vendor: VENDOR_ADDRESS,
    deployBlock: 1000n,
    db,
    workspaceId: WS,
    counterpartyId: CP,
    scenario: "settle" as const,
    onChain: true,
    ...over,
  });

  it("passes on a clean chain and records exactly one intent for this settlement", async () => {
    const spend = memorySpend();
    await buildSendHooks(config(guardedChain(), spend)).beforeTransfer(request());
    expect(spend.records).toEqual([{ kind: "intent", at: expect.any(String), scenario: "settle", workspaceId: WS, settlementId: SET }]);
  });

  it("refuses each condition, and in every refusal nothing is recorded (no intent, so no broadcast can follow)", async () => {
    const cases: [string, RpcCall, ReturnType<typeof memorySpend>, string][] = [
      ["the chain cap", guardedChain({ payments: 3 }), memorySpend(), "total cap"],
      ["the ledger cap", guardedChain(), memorySpend([intent(), intent(), intent()]), "spend ledger"],
      ["the balance", guardedChain({ balance: "0x1" }), memorySpend(), "gas margin"],
      ["the simulation", guardedChain({ estimate: "revert" }), memorySpend(), "pre-send simulation"],
      ["a paid order", guardedChain({ logs: 1 }), memorySpend(), "already shows a payment"],
      ["a settled order", guardedChain({ settled: true }), memorySpend(), "already settled"],
      ["a wrong chain id", guardedChain({ chainId: "0x1" }), memorySpend(), "eth_chainId"],
    ];
    for (const [name, rpc, spend, reason] of cases) {
      const before = spend.records.length;
      await expect(buildSendHooks(config(rpc, spend)).beforeTransfer(request()), name).rejects.toThrow(reason);
      expect(spend.records.length, name).toBe(before);
      expect(spend.isLocked(), `${name}: the lock is released`).toBe(false);
    }
  });

  it("refuses a settlement that is not pending in the database, before any chain read", async () => {
    const spend = memorySpend();
    const confirmed = { settlementRow: async () => ({ id: SET, counterpartyId: CP, status: "confirmed", amountCents: "1" }) };
    await expect(buildSendHooks(config(guardedChain(), spend, { db: confirmed })).beforeTransfer(request())).rejects.toThrow(/not pending/);
    expect(spend.records).toEqual([]);
  });

  it("the local rehearsal makes no chain read and writes no ledger record", async () => {
    const spend = memorySpend();
    const noChain: RpcCall = async () => {
      throw new Error("the rehearsal must not read the chain");
    };
    await buildSendHooks(config(noChain, spend, { onChain: false })).beforeTransfer(request());
    expect(spend.records).toEqual([]);
  });

  it("refuses a transfer whose amount is not one cent before the hooks run", async () => {
    const spend = memorySpend();
    const guarded = tabGuardedAdapter(
      { mode: "arc-testnet", getBalance: async () => 0n, transferUSDC: async () => ({ txHash: TX, status: "submitted", timestamp: new Date(), mode: "arc-testnet", simulated: false }), confirm: async () => ({ txHash: TX, status: "confirmed", timestamp: new Date(), mode: "arc-testnet", simulated: false }), depositEscrow: async () => ({}) as never, releaseEscrow: async () => ({}) as never },
      buildSendHooks(config(guardedChain(), spend)),
      { payer: SIGNER, vendor: VENDOR_ADDRESS }
    );
    await expect(guarded.adapter.transferUSDC(request({ amountCents: 2n }))).rejects.toThrow(/not 1 cent/);
    expect(spend.records).toEqual([]);
    expect(guarded.transferCalls()).toBe(0);
  });
});

describe("tabGuardedAdapter: one payment per process", () => {
  it("refuses a second transfer in the same process, and the inner adapter is called once", async () => {
    let inner = 0;
    const adapter = {
      mode: "arc-testnet" as const,
      getBalance: async () => 0n,
      transferUSDC: async () => {
        inner += 1;
        return { txHash: TX, status: "submitted" as const, timestamp: new Date(), mode: "arc-testnet" as const, simulated: false };
      },
      confirm: async () => ({ txHash: TX, status: "confirmed" as const, timestamp: new Date(), mode: "arc-testnet" as const, simulated: false }),
      depositEscrow: async () => ({}) as never,
      releaseEscrow: async () => ({}) as never,
    };
    const guarded = tabGuardedAdapter(adapter, { beforeTransfer: async () => undefined }, { payer: SIGNER, vendor: VENDOR_ADDRESS });
    const req: TransferRequest = { fromAddress: SIGNER, toAddress: VENDOR_ADDRESS, amountCents: 1n, currency: "USDC", orderId: tabAdapterOrderId(SET), idempotencyKey: "k", matchHash: TX };
    await guarded.adapter.transferUSDC(req);
    await expect(guarded.adapter.transferUSDC(req)).rejects.toThrow(/second payment in one process/);
    expect(inner).toBe(1);
    expect(guarded.transferCalls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The spend ledger file, the classification of a started send, and the database rule
// ---------------------------------------------------------------------------------------------------------------------

describe("the spend ledger file", () => {
  it("lives at a fixed path in the operator's home directory, independent of the checkout and the temporary directory", () => {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    expect(DEFAULT_SPEND_LEDGER).toBe(path.join(os.homedir(), ".bind-live-state", "tab-spend-ledger.jsonl"));
    expect(DEFAULT_SPEND_LEDGER.startsWith(repo + path.sep)).toBe(false);
    expect(DEFAULT_SPEND_LEDGER.startsWith(os.tmpdir() + path.sep)).toBe(false);
  });

  it("reads a missing file as empty, appends one record per line in order, and refuses a corrupt file without resetting it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-tab-spend-"));
    try {
      const file = path.join(dir, "nested", "ledger.jsonl");
      const ledger = realSpendLedger(file);
      expect(ledger.read()).toEqual([]);
      ledger.append(intent(SET));
      ledger.append(intent("tabset-2"));
      expect(ledger.read().map((r) => r.settlementId)).toEqual([SET, "tabset-2"]);
      expect(fs.readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
      fs.appendFileSync(file, "not json\n");
      expect(() => ledger.read()).toThrow(BlockedError);
      expect(fs.readFileSync(file, "utf8")).toMatch(/not json/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const baseFacts: SendFacts = {
  orderLogs: 0,
  orderSettled: false,
  startNonce: 0n,
  latestNonce: 0n,
  pendingNonce: 0n,
  recordedBroadcasts: 0,
  signerPaymentsSinceBaseline: 0,
};

describe("classifySendFacts: what the chain proves about a started send", () => {
  it("is NOT_SENT only when nothing moved: no payment, nonce unchanged, no broadcast, no other payment", () => {
    const r = classifySendFacts(baseFacts);
    expect(r.outcome).toBe("NOT_SENT");
    expect(r.reasons[0]).toMatch(/not made/);
    expect(r.reasons[0]).not.toMatch(/HARD STOP/);
  });

  it("is PAID when the order's payment is on chain, whatever else moved", () => {
    expect(classifySendFacts({ ...baseFacts, orderLogs: 1, latestNonce: 1n }).outcome).toBe("PAID");
    expect(classifySendFacts({ ...baseFacts, orderLogs: 1, orderSettled: true, latestNonce: 1n }).outcome).toBe("PAID");
  });

  it("is AMBIGUOUS (a hard stop, not --fresh) in each case the chain does not prove", () => {
    const ambiguous: SendFacts[] = [
      { ...baseFacts, orderLogs: 2 },
      { ...baseFacts, orderSettled: true },
      { ...baseFacts, recordedBroadcasts: 1 },
      { ...baseFacts, latestNonce: 1n },
      { ...baseFacts, pendingNonce: 1n },
      { ...baseFacts, signerPaymentsSinceBaseline: 1 },
    ];
    for (const facts of ambiguous) {
      const r = classifySendFacts(facts);
      expect(r.outcome, JSON.stringify(facts, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe("AMBIGUOUS");
      expect(r.reasons[0]).toMatch(/HARD STOP/);
      expect(r.reasons[0]).toMatch(/Inspect the chain, do NOT use --fresh/);
    }
  });
});

describe("classifyPriorSend and recordedBroadcastHashes", () => {
  it("classifies from the chain and the database, and returns the facts it read", async () => {
    const r = await classifyPriorSend(guardedChain(), fakeDb().db as never, stateOf({ sendStartedAt: "t" }));
    expect(r.outcome).toBe("NOT_SENT");
    expect(r.facts).toMatchObject({ orderLogs: 0, startNonce: 0n });
  });

  it("is BLOCKED, with the do-not-use---fresh instruction, when there is no chain or a read fails", async () => {
    await expect(classifyPriorSend(undefined, fakeDb().db as never, stateOf({ sendStartedAt: "t" }))).rejects.toThrow(/do NOT use --fresh/);
    const broken = fakeRpc({ eth_getTransactionCount: () => { throw new Error("down"); } });
    await expect(classifyPriorSend(broken, fakeDb().db as never, stateOf({ sendStartedAt: "t" }))).rejects.toThrow(/do NOT use --fresh/);
  });

  it("collects each recorded broadcast hash once", () => {
    const state = stateOf({
      results: { send: { broadcasts: [TX] }, recover: null, broadcastLines: [TX, TX2], recoverLines: [TX2] },
    });
    expect(recordedBroadcastHashes(state)).toEqual([TX, TX2]);
  });
});

describe("the database rule (pure)", () => {
  it("accepts a bind_live_ database or one that holds the marker table, and refuses any other", () => {
    expect(databaseNameProblem("bind_live_settle", false)).toBeUndefined();
    expect(databaseNameProblem("bind_tab_rehearsal", true)).toBeUndefined();
    expect(databaseNameProblem("bind_tab_rehearsal", false)).toMatch(/not a dedicated live database/);
    expect(databaseNameProblem("postgres", false)).toMatch(/nothing is sent/);
  });

  it("requires an empty workspaces table for a new run, and only this run's workspace on a reuse", () => {
    expect(workspaceRowsProblem([], null)).toBeUndefined();
    expect(workspaceRowsProblem(["ws-1"], null)).toMatch(/not empty/);
    expect(workspaceRowsProblem(["ws-1"], "ws-1")).toBeUndefined();
    expect(workspaceRowsProblem(["ws-2"], "ws-1")).toMatch(/not this run's/);
    expect(workspaceRowsProblem(["ws-1", "ws-2"], "ws-1")).toMatch(/not this run's/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The orchestrator: resume and --fresh decide from the chain; the cap and the balance hold before any spawn
// ---------------------------------------------------------------------------------------------------------------------

function startedState(scenario: TabState["scenario"] = "held-adopt", over: Partial<TabState> = {}): TabState {
  return stateOf({ scenario, sendStartedAt: "2026-10-26T10:00:00Z", results: {}, ...over });
}

describe("orchestrator: a started send", () => {
  it("resume: an ambiguous chain is a hard stop that names --fresh as forbidden, and spawns nothing", async () => {
    const { ports, spawned, out, statePath } = portsOf({ rpc: guardedChain({ latestNonce: "0x1" }) });
    fs.writeFileSync(statePath, JSON.stringify(startedState()));
    const code = await runTabOrchestrator(args({ resume: true, statePath, scenario: "held-adopt" }), ports);
    expect(code).toBe(2);
    expect(spawned.n).toBe(0);
    expect(out.join("\n")).toMatch(/HARD STOP.*do NOT use --fresh/);
  });

  it("resume: a payment the chain shows is recovered and verified with no send", async () => {
    const withSettlement = { ...fakeDb().db, snapshot: async () => goodSnapshot() };
    const { ports, spawned, out, statePath } = portsOf({ db: withSettlement, rpc: guardedChain({ logs: 1, latestNonce: "0x1" }) });
    fs.writeFileSync(statePath, JSON.stringify(startedState()));
    await runTabOrchestrator(args({ resume: true, statePath, scenario: "held-adopt" }), ports);
    expect(spawned.n).toBe(0);
    expect(out.join("\n")).toMatch(/"outcome": "PAID"/);
  });

  it("--fresh is refused after a send that may have paid, and prepares nothing", async () => {
    const { db, log } = fakeDb();
    const { ports, spawned, out, statePath } = portsOf({ db, rpc: guardedChain({ latestNonce: "0x1" }) });
    fs.writeFileSync(statePath, JSON.stringify(startedState()));
    expect(await runTabOrchestrator(args({ fresh: true, statePath, scenario: "held-adopt" }), ports)).toBe(2);
    expect(log.prepared).toBe(0);
    expect(spawned.n).toBe(0);
    expect(out.join("\n")).toMatch(/do NOT use --fresh/);
  });

  it("--fresh is refused after a send the chain shows as paid: it would be a second payment", async () => {
    const made = fakeDb();
    const db = { ...made.db, snapshot: async () => goodSnapshot() };
    const log = made.log;
    const { ports, spawned, out, statePath } = portsOf({ db, rpc: guardedChain({ logs: 1, latestNonce: "0x1" }) });
    fs.writeFileSync(statePath, JSON.stringify(startedState()));
    expect(await runTabOrchestrator(args({ fresh: true, statePath, scenario: "held-adopt" }), ports)).toBe(2);
    expect(log.prepared).toBe(0);
    expect(spawned.n).toBe(0);
    expect(out.join("\n")).toMatch(/second payment/);
  });

  it("--fresh after a send the chain proves was not made still needs an empty dedicated database", async () => {
    const { db, log } = fakeDb({ precheck: ["the workspaces table is not empty: a new run needs an empty, dedicated database (one database per scenario); nothing is sent"] });
    const { ports, spawned, statePath } = portsOf({ db });
    fs.writeFileSync(statePath, JSON.stringify(startedState()));
    expect(await runTabOrchestrator(args({ fresh: true, statePath, scenario: "held-adopt" }), ports)).toBe(2);
    expect(log.prepared).toBe(0);
    expect(spawned.n).toBe(0);
  });

  it("without --resume, a started send is refused and the message says to use --resume", async () => {
    const { ports, spawned, out, statePath } = portsOf();
    fs.writeFileSync(statePath, JSON.stringify(startedState("settle")));
    expect(await runTabOrchestrator(args({ statePath }), ports)).toBe(2);
    expect(spawned.n).toBe(0);
    expect(out.join("\n")).toMatch(/run with --resume/);
  });
});

describe("orchestrator: the cap and the balance hold before any spawn, --fresh included", () => {
  it("--fresh does not bypass the chain cap: the prepared tab is refused before the send child", async () => {
    const { ports, spawned, out, statePath } = portsOf({ rpc: guardedChain({ payments: 3 }) });
    expect(await runTabOrchestrator(args({ fresh: true, statePath }), ports)).toBe(2);
    expect(spawned.n).toBe(0);
    expect(out.join("\n")).toMatch(/total cap is reached/);
  });

  it("refuses at the cap in the spend ledger, with the chain empty", async () => {
    const { ports, spawned, out, statePath, spend } = portsOf();
    spend.records.push(intent(), intent(), intent());
    expect(await runTabOrchestrator(args({ statePath }), ports)).toBe(2);
    expect(spawned.n).toBe(0);
    expect(out.join("\n")).toMatch(/spend ledger holds 3/);
  });

  it("refuses an underfunded signer before the send child", async () => {
    const { ports, spawned, statePath } = portsOf({ rpc: guardedChain({ balance: "0x1" }) });
    expect(await runTabOrchestrator(args({ statePath }), ports)).toBe(2);
    expect(spawned.n).toBe(0);
  });

  it("a reused state is checked against the database rule: another workspace in the database refuses it", async () => {
    const { db } = fakeDb({ rowsCheck: ["the workspaces table holds rows that are not this run's; the run's dedicated database is not the one in use; nothing is sent"] });
    const { ports, spawned, statePath } = portsOf({ db });
    fs.writeFileSync(statePath, JSON.stringify(stateOf({ results: {} })));
    expect(await runTabOrchestrator(args({ statePath }), ports)).toBe(2);
    expect(spawned.n).toBe(0);
  });
});

describe("orchestrator: a broadcast that is not confirmed is SUBMITTED_UNCONFIRMED, never FAIL or PASS", () => {
  it("a send child that stops after it broadcast, with no result, is SUBMITTED_UNCONFIRMED with the hash and exit 3", async () => {
    const spawnPhase = async () => ({ code: null, signal: "SIGTERM", timedOut: true, lines: [`LIVE_TAB_BROADCAST ${TX}`], result: undefined });
    const { ports, out, statePath } = portsOf({ spawnPhase } as never);
    const code = await runTabOrchestrator(args({ statePath }), ports);
    expect(code).toBe(EXIT_SUBMITTED_UNCONFIRMED);
    const doc = JSON.parse(out.join("\n"));
    expect(doc).toMatchObject({ result: "SUBMITTED_UNCONFIRMED", evidenceClass: "SUBMITTED_UNCONFIRMED", submitted: [TX], confirmed: { bool: false, block: null } });
  });

  it("a send child that stops before any broadcast is a plain FAIL", async () => {
    const spawnPhase = async () => ({ code: 1, signal: null, timedOut: false, lines: [], result: undefined });
    const { ports, out, statePath } = portsOf({ spawnPhase } as never);
    expect(await runTabOrchestrator(args({ statePath }), ports)).toBe(1);
    expect(JSON.parse(out.join("\n")).result).toBe("FAIL");
  });

  it("a broadcast that is not mined within the bound is SUBMITTED_UNCONFIRMED, and nothing is sent again", async () => {
    const prepared = toTabSnapshot({
      workspaceId: WS,
      settlements: [],
      entries: [1, 2, 3].map(() => ({ kind: "charge", amount_micro: "5000", settlement_id: null })),
      effects: [],
      audits: [],
      supplier: null,
    });
    let reads = 0;
    const db = { ...fakeDb().db, snapshot: async () => (reads++ === 0 ? prepared : goodSnapshot()) };
    let clock = 0;
    const spawnPhase = async () => ({ code: 0, signal: null, timedOut: false, lines: [`LIVE_TAB_BROADCAST ${TX}`], result: { phase: "send", steps: [], confirmSnapshots: [], broadcasts: [TX], transferCalls: 1 } });
    const { ports, out, statePath, spawned } = portsOf({ db, spawnPhase, now: () => (clock += 50_000) } as never);
    expect(await runTabOrchestrator(args({ statePath }), ports)).toBe(EXIT_SUBMITTED_UNCONFIRMED);
    expect(spawned.n).toBe(0);
    expect(JSON.parse(out.join("\n")).result).toBe("SUBMITTED_UNCONFIRMED");
  });
});

describe("verdictFor: a payment once on chain, unconfirmed in Bind's record, is not a FAIL", () => {
  const confirmationFails = (): Assertion[] => [
    { name: "settlement_confirmed", status: "FAIL", detail: "" },
    { name: "audit_confirmed_once", status: "FAIL", detail: "" },
    { name: "settlement_one_cent", status: "PASS", detail: "" },
  ];
  const oneLog = goodChain();

  it("is SUBMITTED_UNCONFIRMED when only the confirmation checks fail and the chain shows one payment", () => {
    expect(verdictFor(confirmationFails(), { adapter: "arc" }, [TX], oneLog, { [TX]: { hash: TX, status: "success", blockNumber: 1006n, from: SIGNER, to: CONTRACT } })).toBe("SUBMITTED_UNCONFIRMED");
    expect(CONFIRMATION_CHECKS.has("settlement_confirmed")).toBe(true);
  });

  it("is FAIL when another check fails, when nothing was broadcast, when the receipt reverted, or when the chain shows no payment", () => {
    const withLedgerFail = [...confirmationFails(), { name: "ledger_one_clear", status: "FAIL" as const, detail: "" }];
    const ok = { [TX]: { hash: TX, status: "success" as const, blockNumber: 1006n, from: SIGNER, to: CONTRACT } };
    expect(verdictFor(withLedgerFail, { adapter: "arc" }, [TX], oneLog, ok)).toBe("FAIL");
    expect(verdictFor(confirmationFails(), { adapter: "arc" }, [], oneLog, ok)).toBe("FAIL");
    expect(verdictFor(confirmationFails(), { adapter: "arc" }, [TX], oneLog, { [TX]: { ...ok[TX], status: "reverted" } })).toBe("FAIL");
    expect(verdictFor(confirmationFails(), { adapter: "arc" }, [TX], { ...oneLog, logs: [] }, ok)).toBe("FAIL");
  });

  it("is PASS when everything passes, and the local rehearsal never gets SUBMITTED_UNCONFIRMED", () => {
    expect(verdictFor([{ name: "a", status: "PASS", detail: "" }], { adapter: "arc" }, [TX], oneLog, {})).toBe("PASS");
    expect(verdictFor(confirmationFails(), { adapter: "local-sim" }, [TX], undefined, {})).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// --preflight: read-only. It prints the plan, spawns nothing, writes nothing, sends nothing.
// ---------------------------------------------------------------------------------------------------------------------

describe("--preflight", () => {
  it("parses, and refuses the options that would write or resume", () => {
    expect(parseTabArgs(["settle", "--preflight"])).toMatchObject({ preflight: true, adapter: "arc" });
    expect(() => parseTabArgs(["settle", "--preflight", "--fresh"])).toThrow(/writes nothing and sends nothing/);
    expect(() => parseTabArgs(["settle", "--preflight", "--resume"])).toThrow(/writes nothing and sends nothing/);
    expect(() => parseTabArgs(["settle", "--preflight", "--write-evidence", "/tmp/x.json"])).toThrow(/writes nothing and sends nothing/);
  });

  /** Ports that fail the test if a preflight writes or spawns. The spawn count is the one the assertions read. */
  function readOnlyPorts(over: Partial<Parameters<typeof portsOf>[0]> = {}) {
    const forbidden = (what: string) => () => {
      throw new Error(`preflight must not ${what}`);
    };
    const spawns = { n: 0 };
    const made = portsOf({
      files: { exists: () => false, read: () => null, write: forbidden("write a file") },
      spend: { read: () => [], append: forbidden("append to the spend ledger"), acquire: forbidden("take the spend lock"), isLocked: () => false },
      spawnPhase: async () => {
        spawns.n += 1;
        throw new Error("preflight must not spawn a child");
      },
      ...over,
    } as never);
    return { ...made, spawned: spawns };
  }

  it("prints a ready plan with exit 0, spawns nothing, writes nothing, and reports LIVE_READ_PASS", async () => {
    const { ports, spawned, out, statePath } = readOnlyPorts();
    const code = await runTabPreflight(args({ preflight: true, statePath }), ports);
    expect(code).toBe(0);
    expect(spawned.n).toBe(0);
    expect(out.join("\n")).toMatch(/"childrenSpawned": 0/);
    const doc = JSON.parse(out.join("\n"));
    expect(doc).toMatchObject({ result: "PREFLIGHT_READY", evidenceClass: "LIVE_READ_PASS", sendsMade: 0, childrenSpawned: 0, writes: "none", exitCode: 0 });
    expect(doc.plan.join(" ")).toMatch(/one settleTab of 1 cent/);
    expect(doc.checks.every((c: { status: string }) => c.status === "PASS")).toBe(true);
  });

  it("refuses with exit 2 while a spend lock file exists, and reports the lock as the failing check", async () => {
    const { ports, spawned, out, statePath } = readOnlyPorts({ spend: { read: () => [], append: () => undefined, acquire: () => ({ release: () => undefined }), isLocked: () => true } } as never);
    expect(await runTabPreflight(args({ preflight: true, statePath }), ports)).toBe(2);
    expect(spawned.n).toBe(0);
    expect(out.join("\n")).toMatch(/"spend_lock"[\s\S]*?"status": "FAIL"/);
  });

  it("refuses with exit 2 at the cap, an underfunded signer, a bad chain, an ambiguous prior send, and the local rehearsal", async () => {
    const cases: [string, Parameters<typeof portsOf>[0], string][] = [
      ["the cap", { rpc: guardedChain({ payments: 3 }) }, "total cap is reached"],
      ["the balance", { rpc: guardedChain({ balance: "0x1" }) }, "gas margin"],
      ["the chain", { rpc: guardedChain({ chainId: "0x1" }) }, "eth_chainId"],
    ];
    for (const [name, over, reason] of cases) {
      const { ports, spawned, out, statePath } = readOnlyPorts(over as never);
      expect(await runTabPreflight(args({ preflight: true, statePath }), ports), name).toBe(2);
      expect(spawned.n, name).toBe(0);
      expect(out.join("\n"), name).toMatch(new RegExp(reason));
    }
    const ambiguous = readOnlyPorts({ rpc: guardedChain({ latestNonce: "0x1" }) } as never);
    fs.writeFileSync(ambiguous.statePath, JSON.stringify(startedState()));
    expect(await runTabPreflight(args({ preflight: true, statePath: ambiguous.statePath }), ambiguous.ports)).toBe(2);
    const local = readOnlyPorts();
    expect(await runTabPreflight(args({ preflight: true, adapter: "local-sim", statePath: local.statePath }), local.ports)).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Concurrency, the spend lock, the in-flight check, the recount, the deploy block and the block before it
// ---------------------------------------------------------------------------------------------------------------------

describe("the spend lock on the real ledger file", () => {
  function tempLedger(): { dir: string; file: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-tab-lock-"));
    return { dir, file: path.join(dir, "nested", "tab-spend-ledger.jsonl"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  it("refuses a second take while the first is held, and takes it again after release", () => {
    const t = tempLedger();
    try {
      const ledger = realSpendLedger(t.file);
      const first = ledger.acquire();
      expect(ledger.isLocked()).toBe(true);
      expect(() => ledger.acquire()).toThrow(/lock is held.*never broken automatically/);
      first.release();
      expect(ledger.isLocked()).toBe(false);
      expect(() => ledger.acquire().release()).not.toThrow();
    } finally {
      t.cleanup();
    }
  });

  it("never breaks a stale lock: a lock whose owner is gone still refuses, and the file is left in place", () => {
    const t = tempLedger();
    try {
      const ledger = realSpendLedger(t.file);
      fs.mkdirSync(path.dirname(t.file), { recursive: true });
      fs.writeFileSync(`${t.file}.lock`, JSON.stringify({ token: "gone", pid: 999999, at: "2026-10-01T00:00:00Z" }));
      expect(() => ledger.acquire()).toThrow(/never broken automatically/);
      expect(fs.readFileSync(`${t.file}.lock`, "utf8")).toMatch(/"token":"gone"/);
    } finally {
      t.cleanup();
    }
  });

  it("a handle releases only the lock it wrote: another owner's lock is left alone", () => {
    const t = tempLedger();
    try {
      const ledger = realSpendLedger(t.file);
      const mine = ledger.acquire();
      fs.writeFileSync(`${t.file}.lock`, JSON.stringify({ token: "someone-else", pid: 1, at: "x" }));
      mine.release();
      expect(fs.readFileSync(`${t.file}.lock`, "utf8")).toMatch(/someone-else/);
    } finally {
      t.cleanup();
    }
  });
});

describe("two concurrent child hooks against one shared real ledger file", () => {
  const request: TransferRequest = {
    fromAddress: SIGNER,
    toAddress: VENDOR_ADDRESS,
    amountCents: 1n,
    currency: "USDC",
    orderId: tabAdapterOrderId(SET),
    idempotencyKey: "k",
    matchHash: TX,
  };
  const db = { settlementRow: async (_ws: string, id: string) => ({ id, counterpartyId: CP, status: "pending", amountCents: "1" }) };
  const hooks = (spend: SpendLedger, rpc: RpcCall = guardedChain({ payments: 2 })) =>
    buildSendHooks({ rpc, spend, contract: CONTRACT, signer: SIGNER, vendor: VENDOR_ADDRESS, deployBlock: 1000n, db, workspaceId: WS, counterpartyId: CP, scenario: "settle", onChain: true });

  it("at most one proceeds: the second is refused while the first holds the lock, and the ledger gains one record", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-tab-race-"));
    try {
      const file = path.join(dir, "tab-spend-ledger.jsonl");
      const ledger = realSpendLedger(file);
      ledger.append(intent("tabset-a"));
      ledger.append(intent("tabset-b"));
      const first = hooks(ledger);
      const second = hooks(ledger);
      const results = await Promise.allSettled([first.beforeTransfer(request), second.beforeTransfer(request)]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String(rejected[0].reason)).toMatch(/lock is held/);
      expect(ledger.read()).toHaveLength(3);
      expect(ledger.isLocked()).toBe(true);

      // The holder releases on exit. A later run then sees three attempts and is refused by the cap.
      first.release?.();
      expect(ledger.isLocked()).toBe(false);
      await expect(hooks(ledger).beforeTransfer(request)).rejects.toThrow(/spend ledger holds 3/);
      expect(ledger.read()).toHaveLength(3);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a stale lock file blocks the hook, names the inspection, and writes nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-tab-stale-"));
    try {
      const file = path.join(dir, "tab-spend-ledger.jsonl");
      const ledger = realSpendLedger(file);
      fs.writeFileSync(`${file}.lock`, JSON.stringify({ token: "dead-owner", pid: 999999, at: "x" }));
      await expect(hooks(ledger).beforeTransfer(request)).rejects.toThrow(/never broken automatically/);
      expect(fs.existsSync(`${file}.lock`)).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the hook's additional checks", () => {
  const request: TransferRequest = {
    fromAddress: SIGNER,
    toAddress: VENDOR_ADDRESS,
    amountCents: 1n,
    currency: "USDC",
    orderId: tabAdapterOrderId(SET),
    idempotencyKey: "k",
    matchHash: TX,
  };
  const db = { settlementRow: async (_ws: string, id: string) => ({ id, counterpartyId: CP, status: "pending", amountCents: "1" }) };
  const hooks = (spend: ReturnType<typeof memorySpend>, rpc: RpcCall) =>
    buildSendHooks({ rpc, spend, contract: CONTRACT, signer: SIGNER, vendor: VENDOR_ADDRESS, deployBlock: 1000n, db, workspaceId: WS, counterpartyId: CP, scenario: "settle", onChain: true });

  it("refuses a signer with a transaction in flight (pending differs from latest), with no append, and releases the lock", async () => {
    const spend = memorySpend();
    await expect(hooks(spend, guardedChain({ latestNonce: "0x1", pendingNonce: "0x2" })).beforeTransfer(request)).rejects.toThrow(/in flight/);
    expect(spend.records).toEqual([]);
    expect(spend.isLocked()).toBe(false);
  });

  it("re-reads the ledger after the append, and refuses (no broadcast) when another writer pushed it over the cap", async () => {
    const records: SpendRecord[] = [intent("a"), intent("b")];
    const spend: SpendLedger & { isLocked(): boolean } = {
      read: () => [...records],
      // A writer that does not take the lock adds one more attempt after our append.
      append: (r) => {
        records.push(r, intent("unlocked-writer"));
      },
      acquire: () => ({ release: () => undefined }),
      isLocked: () => false,
    };
    await expect(hooks(spend as never, guardedChain({ payments: 2 })).beforeTransfer(request)).rejects.toThrow(/over the cap of 3/);
  });

  it("the child's hook releases a lock it took when the hook returns without error and the caller releases it", async () => {
    const spend = memorySpend();
    const h = hooks(spend, guardedChain());
    await h.beforeTransfer(request);
    expect(spend.isLocked()).toBe(true);
    h.release?.();
    expect(spend.isLocked()).toBe(false);
  });
});

describe("the deploy block: hardcoded, with an override that may only be lower or equal", () => {
  it("is the approved block from the deployment record when unset, and a lower override is used", () => {
    expect(APPROVED_DEPLOY_BLOCK).toBe(67155017n);
    expect(effectiveDeployBlock({})).toBe(67155017n);
    expect(effectiveDeployBlock({ BIND_SETTLEMENT_DEPLOY_BLOCK: "1000" })).toBe(1000n);
    expect(effectiveDeployBlock({ BIND_SETTLEMENT_DEPLOY_BLOCK: "67155018" })).toBe(67155017n);
  });

  it("refuses an override above the approved block in the static guards", () => {
    const refused = tabStaticGuards({ ...GOOD_ENV, BIND_SETTLEMENT_DEPLOY_BLOCK: "67155018" }, { adapter: "arc", confirmTestnetSpend: true, writeEvidence: undefined }, false);
    expect(refused.map((f) => f.guard)).toContain("deploy-block");
  });

  it("refuses code before the deploy block, passes no code there, and is BLOCKED when the read fails", async () => {
    const codeAt = (before: string) => fakeRpc({ eth_getCode: (params) => (params[1] === "0x" + (1000n - 1n).toString(16) ? before : "0x6000") });
    await expect(assertNoCodeBefore(codeAt("0x6000"), CONTRACT, 1000n)).rejects.toThrow(/code before the deploy block/);
    await expect(assertNoCodeBefore(codeAt("0x"), CONTRACT, 1000n)).resolves.toBeUndefined();
    await expect(assertNoCodeBefore(fakeRpc({ eth_getCode: () => { throw new Error("pruned"); } }), CONTRACT, 1000n)).rejects.toThrow(BlockedError);
    await expect(assertNoCodeBefore(fakeRpc({ eth_getCode: () => { throw new Error("never asked"); } }), CONTRACT, 0n)).resolves.toBeUndefined();
  });
});
