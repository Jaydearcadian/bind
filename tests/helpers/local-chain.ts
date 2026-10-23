import { createVM, runTx } from "@ethereumjs/vm";
import { createCustomCommon, Mainnet, Hardfork } from "@ethereumjs/common";
import { createBlock } from "@ethereumjs/block";
import { createTxFromRLP } from "@ethereumjs/tx";
import { createAddressFromString, hexToBytes, bytesToHex, createAccount } from "@ethereumjs/util";

/**
 * In-process EVM exposed as an EIP-1193 request function, enough for viem's public and wallet clients.
 * Test-only. It is not Anvil and does not sign or broadcast anything outside this process.
 * Ported from tests/helpers reference (.superpowers/.../local-chain.reference.mjs).
 */

export interface LocalChainRequest {
  method: string;
  params?: unknown[];
}

export interface LocalChain {
  /** Chain id the EVM was created with. viem clients must use the same id to sign valid transactions. */
  readonly chainId: number;
  request: (args: LocalChainRequest) => Promise<unknown>;
  advanceTime(seconds: number): void;
  blockNumber(): bigint;
  /**
   * The clock as the next transaction will see it, minus one: a transaction mined now gets `currentTime() + 1`, and
   * eth_call runs at `currentTime() + 1`. Added for the property tests, which model the clock.
   */
  currentTime(): number;
}

export interface LocalChainOptions {
  chainId?: number;
  balances?: Record<string, bigint>;
  startTime?: number;
}

const GWEI = 10n ** 9n;
const BLOCK_GAS_LIMIT = 30_000_000n;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const ZERO_BLOOM = `0x${"0".repeat(512)}`;
const hex = (n: bigint): string => `0x${n.toString(16)}`;

export async function createLocalChain(opts: LocalChainOptions = {}): Promise<LocalChain> {
  const chainId = opts.chainId ?? 31337;
  const balances = opts.balances ?? {};
  const startTime = opts.startTime ?? 1_700_000_000;

  const common = createCustomCommon({ chainId }, Mainnet, { hardfork: Hardfork.Cancun });
  const vm = await createVM({ common });
  let number = 0n;
  let time = BigInt(startTime);
  const receipts = new Map<string, unknown>();
  const logs: any[] = [];
  const blocks = new Map<bigint, bigint>();

  for (const [addr, wei] of Object.entries(balances)) {
    await vm.stateManager.putAccount(createAddressFromString(addr), createAccount({ balance: wei }));
  }

  const blockObj = (n: bigint, t: bigint): any =>
    createBlock(
      { header: { number: n, timestamp: t, gasLimit: BLOCK_GAS_LIMIT, baseFeePerGas: undefined } },
      { common, setHardfork: false }
    );

  const toRpcBlock = (n: bigint) => ({
    number: hex(n),
    hash: `0x${n.toString(16).padStart(64, "0")}`,
    parentHash: `0x${(n - 1n).toString(16).padStart(64, "0")}`,
    timestamp: hex(blocks.get(n) ?? time),
    gasLimit: hex(BLOCK_GAS_LIMIT),
    gasUsed: "0x0",
    miner: `0x${"0".repeat(40)}`,
    transactions: [] as string[],
    baseFeePerGas: undefined,
    nonce: "0x0000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    sha3Uncles: ZERO_HASH,
    logsBloom: ZERO_BLOOM,
    transactionsRoot: ZERO_HASH,
    stateRoot: ZERO_HASH,
    receiptsRoot: ZERO_HASH,
    extraData: "0x",
    size: "0x1",
    uncles: [] as string[],
  });

  async function accountOf(addr: string) {
    return vm.stateManager.getAccount(createAddressFromString(addr));
  }

  async function request({ method, params = [] }: LocalChainRequest): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return hex(BigInt(chainId));
      case "net_version":
        return String(chainId);
      case "eth_blockNumber":
        return hex(number);
      case "eth_getBalance":
        return hex((await accountOf(params[0] as string))?.balance ?? 0n);
      case "eth_getTransactionCount":
        return hex((await accountOf(params[0] as string))?.nonce ?? 0n);
      case "eth_getCode":
        return bytesToHex(await vm.stateManager.getCode(createAddressFromString(params[0] as string)));
      case "eth_gasPrice":
        return hex(GWEI);
      case "eth_maxPriorityFeePerGas":
        return hex(1n);
      case "eth_estimateGas":
        return hex(8_000_000n);
      case "eth_getBlockByNumber": {
        const tag = params[0] as string;
        const n = tag === "latest" || tag === "pending" || tag === "safe" || tag === "finalized" ? number : BigInt(tag);
        return toRpcBlock(n);
      }
      case "eth_getTransactionReceipt":
        return receipts.get(params[0] as string) ?? null;
      case "eth_getLogs": {
        const f: any = params[0] ?? {};
        const from = f.fromBlock && f.fromBlock !== "earliest" && f.fromBlock !== "latest" ? BigInt(f.fromBlock) : 0n;
        const to = f.toBlock && f.toBlock !== "latest" ? BigInt(f.toBlock) : number;
        return logs.filter((l) => {
          const bn = BigInt(l.blockNumber);
          if (bn < from || bn > to) return false;
          if (f.address && l.address.toLowerCase() !== String(f.address).toLowerCase()) return false;
          const topicFilters: unknown[] = f.topics ?? [];
          for (let i = 0; i < topicFilters.length; i++) {
            const want = topicFilters[i];
            if (want == null) continue;
            const wants = (Array.isArray(want) ? want : [want]) as string[];
            if (!wants.map((x) => x.toLowerCase()).includes((l.topics[i] ?? "").toLowerCase())) return false;
          }
          return true;
        });
      }
      case "eth_call": {
        const c: any = params[0];
        const blockNo = number + 1n;
        await vm.stateManager.checkpoint();
        try {
          const res = await vm.evm.runCall({
            caller: createAddressFromString(c.from ?? `0x${"0".repeat(40)}`),
            to: c.to ? createAddressFromString(c.to) : undefined,
            data: c.data ? hexToBytes(c.data) : undefined,
            value: c.value ? BigInt(c.value) : 0n,
            gasLimit: 8_000_000n,
            block: blockObj(blockNo, time + 1n),
          });
          if (res.execResult.exceptionError) {
            const err: Error & { code?: number; data?: string } = new Error("execution reverted");
            err.code = 3;
            err.data = bytesToHex(res.execResult.returnValue);
            throw err;
          }
          return bytesToHex(res.execResult.returnValue);
        } finally {
          await vm.stateManager.revert();
        }
      }
      case "eth_sendRawTransaction": {
        const tx = createTxFromRLP(hexToBytes(params[0] as `0x${string}`), { common });
        number += 1n;
        time += 1n;
        blocks.set(number, time);
        const result = await runTx(vm, {
          tx,
          block: blockObj(number, time),
          skipBalance: false,
          skipHardForkValidation: true,
        });
        const hash = bytesToHex(tx.hash());
        const failed = !!result.execResult.exceptionError;
        const blockHash = toRpcBlock(number).hash;
        const rlogs = failed
          ? []
          : result.receipt.logs.map((l: any, i: number) => ({
              address: bytesToHex(l[0]),
              topics: l[1].map(bytesToHex),
              data: bytesToHex(l[2]),
              blockNumber: hex(number),
              blockHash,
              transactionHash: hash,
              transactionIndex: "0x0",
              logIndex: hex(BigInt(i)),
              removed: false,
            }));
        logs.push(...rlogs);
        receipts.set(hash, {
          transactionHash: hash,
          transactionIndex: "0x0",
          blockHash,
          blockNumber: hex(number),
          from: tx.getSenderAddress().toString(),
          to: tx.to ? tx.to.toString() : null,
          cumulativeGasUsed: hex(result.totalGasSpent),
          gasUsed: hex(result.totalGasSpent),
          contractAddress: result.createdAddress ? result.createdAddress.toString() : null,
          logs: rlogs,
          logsBloom: ZERO_BLOOM,
          status: failed ? "0x0" : "0x1",
          effectiveGasPrice: hex(GWEI),
          type: "0x0",
        });
        return hash;
      }
      default: {
        const err: Error & { code?: number } = new Error(`method not supported by the local chain: ${method}`);
        err.code = -32601;
        throw err;
      }
    }
  }

  return {
    chainId,
    request,
    advanceTime(seconds: number) {
      time += BigInt(seconds);
    },
    blockNumber: () => number,
    currentTime: () => Number(time),
  };
}
