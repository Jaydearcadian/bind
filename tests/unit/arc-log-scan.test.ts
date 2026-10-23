import { describe, it, expect } from "vitest";
import { custom, encodeAbiParameters, encodeEventTopics, keccak256, stringToHex, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BIND_SETTLEMENT_ABI } from "../../src/adapters/settlement/bind-settlement.abi.js";
import { ArcL1SettlementAdapter } from "../../src/adapters/settlement/arc-l1.js";
import { SettlementTransportError } from "../../src/adapters/settlement/errors.js";
import {
  ARC_LOG_CHUNK_BLOCKS,
  collectLogs,
  findNewestLog,
  rangeLimitOfError,
  scanLogWindows,
  windowsNewestFirst,
  type LogScanInput,
} from "../../src/adapters/settlement/log-scan.js";

/**
 * The chunked settlement scan, against a stub RPC that behaves like the Arc endpoint: an eth_getLogs over more than
 * 100000 blocks is refused with "query exceeds max block range 100000". No network: the stub is an in-memory function.
 */

const RPC_RANGE_LIMIT = 100_000;
const CONTRACT: Address = "0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29";
const KEY: Hex = `0x${"11".repeat(32)}`;
const SIGNER = privateKeyToAccount(KEY).address;
const SUPPLIER: Address = "0xa8358AED200D6CB6C856F972D853C1be833006ea";
const MATCH = `0x${"ab".repeat(32)}` as Hex;
const ORDER = "ord_scan_1";
const ORDER_TOPIC = keccak256(stringToHex(ORDER));

interface StubLog {
  block: bigint;
  orderTopic: Hex;
  tx: Hex;
}

interface StubOptions {
  head: bigint;
  logs: StubLog[];
  /** The window that fails with an upstream error, identified by its inclusive from block. */
  failFromBlock?: bigint;
  /** The RPC's range limit. Defaults to 100000. */
  rangeLimit?: number;
  /** The number the error names. Defaults to the limit. */
  namedLimit?: number;
  /** A tighter limit that is refused without naming a number, for the bounded-retry test. */
  hardMaxSpan?: number;
}

function encodedLog(log: StubLog) {
  const topics = encodeEventTopics({
    abi: BIND_SETTLEMENT_ABI,
    eventName: "SettlementExecuted",
    args: { orderId: log.orderTopic, payer: SIGNER, supplier: SUPPLIER },
  } as never);
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
    [24_500n, MATCH, 1_700_000_000n]
  );
  return {
    address: CONTRACT,
    topics,
    data,
    blockNumber: toHex(log.block),
    transactionHash: log.tx,
    blockHash: `0x${"cc".repeat(32)}`,
    logIndex: "0x0",
    transactionIndex: "0x0",
    removed: false,
  };
}

function stubTransport(opts: StubOptions) {
  const calls: Array<[bigint, bigint]> = [];
  const limit = opts.rangeLimit ?? RPC_RANGE_LIMIT;
  const named = opts.namedLimit ?? limit;
  const transport = custom(
    {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        if (method === "eth_blockNumber") return toHex(opts.head);
        if (method !== "eth_getLogs") throw new Error(`stub does not answer ${method}`);
        const filter = (params as Array<{ fromBlock: Hex; toBlock: Hex; topics: unknown[] }>)[0];
        const from = BigInt(filter.fromBlock);
        const to = BigInt(filter.toBlock);
        calls.push([from, to]);
        const span = to - from + 1n;
        if (span > BigInt(limit)) throw new Error(`query exceeds max block range ${named}`);
        if (opts.hardMaxSpan !== undefined && span > BigInt(opts.hardMaxSpan)) {
          throw new Error("query returned more than the provider's limit, narrow the range");
        }
        if (opts.failFromBlock !== undefined && from === opts.failFromBlock) {
          throw new Error("upstream returned 503");
        }
        return opts.logs
          .filter((log) => log.block >= from && log.block <= to && log.orderTopic === ORDER_TOPIC)
          .map(encodedLog);
      },
    } as never,
    { retryCount: 0 }
  );
  return { transport, calls };
}

function adapterOn(stub: ReturnType<typeof stubTransport>, deployBlock: bigint, logChunkBlocks?: number) {
  return new ArcL1SettlementAdapter({
    chainId: 5042002,
    contractAddress: CONTRACT,
    signerPrivateKey: KEY,
    transport: stub.transport,
    confirmWaitMs: 0,
    deployBlock,
    ...(logChunkBlocks !== undefined ? { logChunkBlocks } : {}),
  });
}

const logAt = (block: bigint, tx = `0x${block.toString(16).padStart(64, "0")}` as Hex): StubLog => ({
  block,
  orderTopic: ORDER_TOPIC,
  tx,
});

describe("window arithmetic: inclusive, consecutive, no gap, no overlap", () => {
  it("lists the windows newest first with the exact inclusive bounds", () => {
    expect(windowsNewestFirst(10n, 3n, 4)).toEqual([
      [7n, 10n],
      [3n, 6n],
    ]);
  });

  it("covers the whole span with no gap and no overlap, for a span that is not a multiple of the window", () => {
    const windows = windowsNewestFirst(1_000_000n, 0n, ARC_LOG_CHUNK_BLOCKS);
    expect(windows[0]).toEqual([910_001n, 1_000_000n]);
    expect(windows[windows.length - 1][0]).toBe(0n);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i][1] + 1n).toBe(windows[i - 1][0]);
    }
    const covered = windows.reduce((sum, [from, to]) => sum + (to - from + 1n), 0n);
    expect(covered).toBe(1_000_001n);
    for (const [from, to] of windows) expect(to - from + 1n).toBeLessThanOrEqual(BigInt(ARC_LOG_CHUNK_BLOCKS));
  });

  it("yields one window when the span fits, and none when the head is behind the deploy block", () => {
    expect(windowsNewestFirst(50n, 40n, 90_000)).toEqual([[40n, 50n]]);
    expect(windowsNewestFirst(10n, 20n, 90_000)).toEqual([]);
  });

  it("keeps the chunk size below the RPC's limit", () => {
    expect(ARC_LOG_CHUNK_BLOCKS).toBeLessThan(RPC_RANGE_LIMIT);
  });
});

describe("the generic scan: find, collect, failure, and bounded retry", () => {
  function input(latest: bigint, deploy: bigint, chunk: number, fetch: LogScanInput<number>["fetchRange"]): LogScanInput<number> {
    return { latest, deployBlock: deploy, chunkBlocks: chunk, fetchRange: fetch, rangeLimitOf: rangeLimitOfError };
  }

  it("findNewestLog stops at the first window with a log, newest first, and returns that log", async () => {
    const seen: Array<[bigint, bigint]> = [];
    const found = await findNewestLog(
      input(30n, 0n, 10, async (from, to) => {
        seen.push([from, to]);
        return to === 20n ? [111] : to === 10n ? [222] : [];
      })
    );
    expect(found).toBe(111);
    expect(seen).toEqual([
      [21n, 30n],
      [11n, 20n],
    ]);
  });

  it("collectLogs gathers every window, and a failing window throws rather than returning a partial list", async () => {
    const all = await collectLogs(input(30n, 0n, 10, async (_from, to) => [Number(to)]));
    expect(all).toEqual([30, 20, 10, 0]);
    await expect(
      collectLogs(input(30n, 0n, 10, async (from) => {
        if (from === 11n) throw new Error("upstream returned 503");
        return [];
      }))
    ).rejects.toThrow(/503/);
  });

  it("scanLogWindows reads nothing for an empty span, and refuses a non-positive window size", async () => {
    let reads = 0;
    const empty = await scanLogWindows(
      input(5n, 10n, 10, async () => {
        reads++;
        return [];
      }),
      () => false
    );
    expect(empty).toBe(false);
    expect(reads).toBe(0);
    await expect(scanLogWindows(input(5n, 0n, 0, async () => []), () => false)).rejects.toThrow(/positive integer/);
  });

  it("retries a window once at the size a range error names, and a second range error throws", async () => {
    const calls: Array<[bigint, bigint]> = [];
    const refuse = (from: bigint, to: bigint) => {
      calls.push([from, to]);
      if (to - from + 1n > 50n) {
        const error = new Error("query exceeds max block range 50");
        throw error;
      }
      return [];
    };
    await expect(findNewestLog(input(100n, 0n, 90, async (from, to) => refuse(from, to)))).resolves.toBeUndefined();
    // The first window (90 blocks) is refused and named 50, so it is retried at 50 blocks; every later window is 50 blocks.
    expect(calls[0]).toEqual([11n, 100n]);
    expect(calls.slice(1).every(([from, to]) => to - from + 1n <= 50n)).toBe(true);

    // A range error that persists at the reduced size is not retried a second time.
    let attempts = 0;
    await expect(
      findNewestLog(
        input(100n, 0n, 90, async () => {
          attempts++;
          throw new Error("query exceeds max block range 50");
        })
      )
    ).rejects.toThrow(/max block range 50/);
    expect(attempts).toBe(2);
  });

  it("reads the named limit from an error message, a shortMessage, or a cause, and ignores anything else", () => {
    expect(rangeLimitOfError(new Error("query exceeds max block range 100000"))).toBe(100_000);
    expect(rangeLimitOfError({ shortMessage: "eth_getLogs: max block range 5000" })).toBe(5_000);
    expect(rangeLimitOfError(new Error("wrapper", { cause: new Error("max block range 2000") }))).toBe(2_000);
    expect(rangeLimitOfError(new Error("max block range 0"))).toBeUndefined();
    expect(rangeLimitOfError(new Error("connection reset"))).toBeUndefined();
  });
});

describe("the Arc adapter lookup scans in windows (findTransfer)", () => {
  it("the stub refuses the old single-range query over this span, so the old code would have failed", async () => {
    const stub = stubTransport({ head: 1_370_000n, logs: [] });
    // The previous lookup was one eth_getLogs from the deploy block to the head. The stub refuses it.
    await expect(
      stub.transport({ chain: undefined } as never).request({
        method: "eth_getLogs",
        params: [{ address: CONTRACT, fromBlock: "0x3e8", toBlock: toHex(1_370_000n), topics: [] }],
      })
    ).rejects.toThrow(/max block range 100000/);
  });

  it("finds a settlement in the newest window, with one window read", async () => {
    const stub = stubTransport({ head: 1_000_000n, logs: [logAt(999_500n)] });
    const found = await adapterOn(stub, 0n).findTransfer({ orderId: ORDER });
    expect(found).toMatchObject({ status: "confirmed", blockNumber: 999_500 });
    expect(stub.calls).toEqual([[910_001n, 1_000_000n]]);
  });

  it("finds a settlement in the oldest window, after scanning every window newest first", async () => {
    const stub = stubTransport({ head: 1_000_000n, logs: [logAt(5n)] });
    const found = await adapterOn(stub, 0n).findTransfer({ orderId: ORDER });
    expect(found).toMatchObject({ status: "confirmed", blockNumber: 5 });
    expect(stub.calls).toEqual(windowsNewestFirst(1_000_000n, 0n, ARC_LOG_CHUNK_BLOCKS));
  });

  it("returns null only after every window was scanned and none held a log", async () => {
    const stub = stubTransport({ head: 1_000_000n, logs: [] });
    expect(await adapterOn(stub, 0n).findTransfer({ orderId: ORDER })).toBeNull();
    expect(stub.calls).toEqual(windowsNewestFirst(1_000_000n, 0n, ARC_LOG_CHUNK_BLOCKS));
  });

  it("throws, and does not return null, when a middle window fails", async () => {
    const windows = windowsNewestFirst(1_000_000n, 0n, ARC_LOG_CHUNK_BLOCKS);
    const middle = windows[Math.floor(windows.length / 2)][0];
    const stub = stubTransport({ head: 1_000_000n, logs: [logAt(5n)], failFromBlock: middle });
    const err = await adapterOn(stub, 0n).findTransfer({ orderId: ORDER }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SettlementTransportError);
    expect((err as Error).message).toMatch(/settlement lookup/);
  });

  it("returns null without any read when the deploy block is ahead of the head (an empty span)", async () => {
    const stub = stubTransport({ head: 1_000n, logs: [] });
    expect(await adapterOn(stub, 2_000_000n).findTransfer({ orderId: ORDER })).toBeNull();
    expect(stub.calls).toEqual([]);
  });

  it("scans a 1.37M-block span with the default windows, and every window stays under the RPC limit", async () => {
    const stub = stubTransport({ head: 68_530_000n, logs: [logAt(67_200_000n)], rangeLimit: RPC_RANGE_LIMIT });
    const found = await adapterOn(stub, 67_155_017n).findTransfer({ orderId: ORDER });
    expect(found).toMatchObject({ status: "confirmed", blockNumber: 67_200_000 });
    for (const [from, to] of stub.calls) expect(to - from + 1n).toBeLessThanOrEqual(BigInt(RPC_RANGE_LIMIT));
  });

  it("recovers from a range refusal that names a smaller limit, retrying that window once at that size", async () => {
    const stub = stubTransport({ head: 1_000_000n, logs: [logAt(999_500n)], rangeLimit: 50_000, namedLimit: 50_000 });
    const found = await adapterOn(stub, 0n).findTransfer({ orderId: ORDER });
    expect(found).toMatchObject({ status: "confirmed", blockNumber: 999_500 });
    // The first attempt used the default window, was refused, and the retry used windows of at most 50000 blocks.
    expect(stub.calls[0][1] - stub.calls[0][0] + 1n).toBe(BigInt(ARC_LOG_CHUNK_BLOCKS));
    expect(stub.calls.slice(1).every(([from, to]) => to - from + 1n <= 50_000n)).toBe(true);
  });

  it("a range refusal that keeps coming is a throw after one retry, never an unbounded loop", async () => {
    // Refuses every span above 10000 blocks while naming 50000: the retry at 50000 is refused too, and must throw.
    const stub = stubTransport({ head: 1_000_000n, logs: [], hardMaxSpan: 10_000, rangeLimit: 10_000, namedLimit: 50_000 });
    await expect(adapterOn(stub, 0n).findTransfer({ orderId: ORDER })).rejects.toBeInstanceOf(SettlementTransportError);
    expect(stub.calls.length).toBeLessThanOrEqual(3);
  });

  it("the window size can be set for tests, and the boundaries hold with a small window", async () => {
    const stub = stubTransport({ head: 25n, logs: [logAt(3n)] });
    const found = await adapterOn(stub, 1n, 10).findTransfer({ orderId: ORDER });
    expect(found).toMatchObject({ status: "confirmed", blockNumber: 3 });
    expect(stub.calls).toEqual([
      [16n, 25n],
      [6n, 15n],
      [1n, 5n],
    ]);
  });
});
