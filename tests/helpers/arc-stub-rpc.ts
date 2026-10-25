import {
  custom,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  numberToHex,
  toFunctionSelector,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ArcL1SettlementAdapter, ARC_TESTNET_CHAIN_ID, USDC_ABI } from "../../src/adapters/settlement/arc-l1.js";
import { BIND_SETTLEMENT_ABI } from "../../src/adapters/settlement/bind-settlement.abi.js";

/**
 * A scripted JSON-RPC stub for the Arc adapter. Every request is recorded, and every raw transaction the adapter broadcasts is
 * kept, so a test can decode what would have gone to the network. Local test keys only; nothing is signed for a network.
 */

export const STUB_CONTRACT = "0x5a86a8f9c2d8f8f0a3b9d3c0e4b1f2a6c7d8e9f0" as const;
export const STUB_USDC = "0x3600000000000000000000000000000000000000" as const;
export const SYSTEM_EMITTER = "0xffffFFFfFFffffffffffffffFfFFFfffFFFfFFfE" as const;
export const SIGNER_KEY: Hex = `0x${"11".repeat(32)}`;
export const SIGNER = privateKeyToAccount(SIGNER_KEY).address;
export const SUPPLIER = "0x2222222222222222222222222222222222222222" as const;
export const MATCH_HASH: Hex = keccak256(toHex("po|receipt|bill"));
export const GWEI = 1_000_000_000n;

export interface RpcStubOptions {
  chainId?: number;
  /** eth_getBlockByNumber: the base fee the block reports (wei), or "error" to make the estimate throw. */
  baseFeeWei?: bigint | "error";
  /** eth_maxPriorityFeePerGas (wei). */
  priorityFeeWei?: bigint;
  /** eth_call of settleOrder (the pre-flight): ok, a custom revert by data, or an error text. */
  preflight?: "ok" | { revertData: Hex } | { text: string };
  /** eth_call of balanceOf: the 6-decimal ERC-20 units the account holds. */
  balanceUnits?: bigint;
  /** eth_getTransactionReceipt: a receipt object, "pending" (null) or "error". */
  receipt?: unknown | "pending" | "error";
  /** eth_getTransactionByHash: a transaction object, null (not found) or "error". */
  transaction?: unknown | null | "error";
  /** eth_getLogs: the logs any scan receives (before the adapter's own filter), or "error". */
  logs?: unknown[] | "error";
  /** eth_blockNumber. */
  blockNumber?: bigint;
}

export interface RpcCall {
  method: string;
  params: any;
}

export interface RpcStub {
  transport: ReturnType<typeof custom>;
  calls: RpcCall[];
  /** Every raw transaction the adapter broadcast, in order. */
  raws: Hex[];
}

function block(baseFeeWei: bigint) {
  return {
    number: "0x1",
    hash: `0x${"ab".repeat(32)}`,
    parentHash: `0x${"00".repeat(32)}`,
    timestamp: "0x1",
    gasLimit: "0x1c9c380",
    gasUsed: "0x0",
    miner: `0x${"00".repeat(20)}`,
    transactions: [],
    baseFeePerGas: numberToHex(baseFeeWei),
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    sha3Uncles: `0x${"00".repeat(32)}`,
    logsBloom: `0x${"00".repeat(256)}`,
    transactionsRoot: `0x${"00".repeat(32)}`,
    stateRoot: `0x${"00".repeat(32)}`,
    receiptsRoot: `0x${"00".repeat(32)}`,
    extraData: "0x",
    size: "0x1",
    uncles: [],
  };
}

const BALANCE_OF_SELECTOR = toFunctionSelector("balanceOf(address)");

export function rpcStub(opts: RpcStubOptions = {}): RpcStub {
  const calls: RpcCall[] = [];
  const raws: Hex[] = [];
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: any }) {
        calls.push({ method, params });
        switch (method) {
          case "eth_chainId":
            return numberToHex(opts.chainId ?? ARC_TESTNET_CHAIN_ID);
          case "eth_call": {
            const data = String(params[0].data ?? "0x");
            if (data.toLowerCase().startsWith(BALANCE_OF_SELECTOR)) {
              return encodeFunctionResult({ abi: USDC_ABI, functionName: "balanceOf", result: opts.balanceUnits ?? 0n });
            }
            const pre = opts.preflight ?? "ok";
            if (pre === "ok") return "0x";
            if ("text" in pre) throw new Error(pre.text);
            throw Object.assign(new Error("execution reverted"), { code: 3, data: pre.revertData });
          }
          case "eth_getTransactionCount":
            return "0x0";
          case "eth_estimateGas":
            return "0x30d40";
          case "eth_gasPrice":
            return numberToHex(GWEI);
          case "eth_maxPriorityFeePerGas":
            return numberToHex(opts.priorityFeeWei ?? GWEI);
          case "eth_getBlockByNumber":
            if (opts.baseFeeWei === "error") throw new Error("fee history unavailable");
            return block(opts.baseFeeWei ?? GWEI);
          case "eth_blockNumber":
            return numberToHex(opts.blockNumber ?? 10n);
          case "eth_sendRawTransaction": {
            const raw = params[0] as Hex;
            raws.push(raw);
            return keccak256(raw);
          }
          case "eth_getTransactionReceipt":
            if (opts.receipt === "error") throw new Error("receipt read failed");
            if (opts.receipt === undefined || opts.receipt === "pending") return null;
            return opts.receipt;
          case "eth_getTransactionByHash":
            if (opts.transaction === "error") throw new Error("transaction read failed");
            if (opts.transaction === undefined || opts.transaction === null) return null;
            return opts.transaction;
          case "eth_getLogs":
            if (opts.logs === "error") throw new Error("log read failed");
            return opts.logs ?? [];
          default:
            throw new Error(`unexpected RPC method in test: ${method}`);
        }
      },
    } as never,
    { retryCount: 0 }
  );
  return { transport, calls, raws };
}

export function adapterOn(transport: ReturnType<typeof custom>, extra: { confirmWaitMs?: number } = {}): ArcL1SettlementAdapter {
  return new ArcL1SettlementAdapter({
    rpcUrl: "http://127.0.0.1:9",
    chainId: ARC_TESTNET_CHAIN_ID,
    contractAddress: STUB_CONTRACT,
    signerPrivateKey: SIGNER_KEY,
    transport,
    confirmWaitMs: extra.confirmWaitMs ?? 0,
  });
}

/** The revert data of a custom error of the BindSettlement ABI. */
export function customRevert(errorName: string, args: unknown[] = []): Hex {
  return encodeErrorResult({ abi: BIND_SETTLEMENT_ABI, errorName, args } as never);
}

/** A SettlementExecuted log as the BindSettlement contract emits it, at `emitter`, for `orderId32`. */
export function settlementLog(opts: { emitter?: string; orderId32: Hex; txHash: Hex; blockNumber?: bigint; supplier?: string }) {
  const topics = encodeEventTopics({
    abi: BIND_SETTLEMENT_ABI,
    eventName: "SettlementExecuted",
    args: { orderId: opts.orderId32, payer: SIGNER, supplier: (opts.supplier ?? SUPPLIER) as `0x${string}` },
  } as never);
  const data = encodeAbiParameters(
    [
      { type: "uint256", name: "amount" },
      { type: "bytes32", name: "matchHash" },
      { type: "uint256", name: "timestamp" },
    ],
    [24500n * 10n ** 16n, MATCH_HASH, 1_700_000_000n]
  );
  return {
    address: opts.emitter ?? STUB_CONTRACT,
    topics,
    data,
    blockNumber: numberToHex(opts.blockNumber ?? 5n),
    blockHash: `0x${"cd".repeat(32)}`,
    transactionHash: opts.txHash,
    transactionIndex: "0x0",
    logIndex: "0x0",
    removed: false,
  };
}

/** A receipt object the adapter can read: status, block and logs. */
export function receiptWith(logs: unknown[], status: "0x1" | "0x0" = "0x1", txHash: Hex = `0x${"ef".repeat(32)}`) {
  return {
    transactionHash: txHash,
    transactionIndex: "0x0",
    blockHash: `0x${"cd".repeat(32)}`,
    blockNumber: numberToHex(5n),
    from: SIGNER,
    to: STUB_CONTRACT,
    cumulativeGasUsed: "0x1",
    gasUsed: "0x1",
    contractAddress: null,
    logs,
    logsBloom: `0x${"00".repeat(256)}`,
    status,
    effectiveGasPrice: numberToHex(GWEI),
    type: "0x2",
  };
}
