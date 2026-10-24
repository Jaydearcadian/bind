import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseEventLogs,
  toHex,
  TransactionReceiptNotFoundError,
  type AbiEvent,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { SettlementAdapter, SettlementStatus, TransferRequest, TransferResult } from "./types.js";
import {
  SettlementChainMismatchError,
  SettlementNotConfiguredError,
  SettlementNotSupportedError,
  SettlementPayerMismatchError,
  SettlementRejectedError,
  SettlementTransportError,
  assertPayableCentAmount,
  transportErrorFrom,
} from "./errors.js";
import { BIND_SETTLEMENT_ABI } from "./bind-settlement.abi.js";
import { config } from "../../config/env.js";
import { ARC_LOG_CHUNK_BLOCKS, findNewestLog, rangeLimitOfError } from "./log-scan.js";

// Native USDC Precompile / ERC-20 ABI on Arc L1
export const USDC_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

// ERC-8183 Standard Agent Escrow Interface ABI
export const ERC8183_ABI = [
  {
    type: "function",
    name: "depositMilestone",
    stateMutability: "nonpayable",
    inputs: [
      { name: "milestoneId", type: "bytes32" },
      { name: "contractor", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "releaseMilestone",
    stateMutability: "nonpayable",
    inputs: [
      { name: "milestoneId", type: "bytes32" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getMilestone",
    stateMutability: "view",
    inputs: [{ name: "milestoneId", type: "bytes32" }],
    outputs: [
      {
        components: [
          { name: "depositor", type: "address" },
          { name: "contractor", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "released", type: "bool" },
        ],
        type: "tuple",
      },
    ],
  },
] as const;

export const ARC_TESTNET_CHAIN_ID = 5042002;
export const ARC_USDC_PRECOMPILE: Address = "0x3600000000000000000000000000000000000000";

const ARC_EXPLORER_TX_PREFIX = "https://testnet.arcscan.app/tx/";
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const PRIVATE_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const RECEIPT_POLL_MS = 500;
const DEFAULT_CONFIRM_WAIT_MS = 8000;

export interface ArcL1SettlementOptions {
  rpcUrl?: string;
  chainId?: number;
  contractAddress?: Address;
  signerPrivateKey?: Hex;
  transport?: Transport;
  confirmWaitMs?: number;
  /** First block to scan for an earlier settlement of the same order id. Defaults to config, else 0. */
  deployBlock?: bigint;
  /** Window size of the log scan (tests only). Defaults to ARC_LOG_CHUNK_BLOCKS, below the RPC's 100000-block limit. */
  logChunkBlocks?: number;
}

/** Revert data is the hex string an RPC error carries for a custom error. Walks the cause chain for it. */
function revertDataOf(error: unknown): Hex | undefined {
  let node: unknown = error;
  for (let depth = 0; node !== null && typeof node === "object" && depth < 10; depth++) {
    const data = (node as { data?: unknown }).data;
    if (typeof data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(data)) return data as Hex;
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
}

function decodeRevert(data: Hex): { errorName: string; args?: unknown[] } | undefined {
  try {
    const decoded = decodeErrorResult({ abi: BIND_SETTLEMENT_ABI, data });
    return { errorName: decoded.errorName, args: decoded.args ? [...decoded.args] : undefined };
  } catch {
    return undefined;
  }
}

function deployBlockFromConfig(): bigint {
  return config.BIND_SETTLEMENT_DEPLOY_BLOCK === undefined ? 0n : BigInt(config.BIND_SETTLEMENT_DEPLOY_BLOCK);
}

/**
 * Arc L1 settlement through the BindSettlement contract. Every value returned is either read from
 * the chain or built from a hash the chain returned. Nothing is fabricated.
 *
 * Every field is an ES private field. The RPC URL, the chain object and the signer key therefore do not
 * appear in JSON.stringify or util.inspect output of the adapter.
 */
export class ArcL1SettlementAdapter implements SettlementAdapter {
  readonly mode = "arc-testnet" as const;
  readonly #chainId: number;
  readonly #chain: Chain;
  readonly #rpcUrl: string;
  readonly #transport: Transport;
  readonly #contractSetting: string | undefined;
  #keySetting: string | undefined;
  readonly #confirmWaitMs: number;
  readonly #deployBlock: bigint;
  readonly #logChunkBlocks: number;
  readonly #publicClient: PublicClient;
  #signer: PrivateKeyAccount | undefined;
  #walletClient: WalletClient<Transport, Chain, PrivateKeyAccount> | undefined;
  #chainVerified = false;

  constructor(opts: ArcL1SettlementOptions = {}) {
    // An option that is present is used as given, even when undefined. Only an absent option falls back to config.
    this.#chainId = opts.chainId ?? config.ARC_CHAIN_ID;
    this.#contractSetting = "contractAddress" in opts ? opts.contractAddress : config.BIND_SETTLEMENT_ADDRESS;
    this.#keySetting = "signerPrivateKey" in opts ? opts.signerPrivateKey : config.ARC_SIGNER_PRIVATE_KEY;
    this.#deployBlock = "deployBlock" in opts ? (opts.deployBlock ?? 0n) : deployBlockFromConfig();
    this.#confirmWaitMs = opts.confirmWaitMs ?? DEFAULT_CONFIRM_WAIT_MS;
    this.#logChunkBlocks = opts.logChunkBlocks ?? ARC_LOG_CHUNK_BLOCKS;
    this.#rpcUrl = opts.rpcUrl ?? config.ARC_RPC_URL ?? config.RPC_URL;
    this.#chain = defineChain({
      id: this.#chainId,
      name: this.#chainId === ARC_TESTNET_CHAIN_ID ? "Arc Testnet" : `Chain ${this.#chainId}`,
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [this.#rpcUrl] } },
    });
    this.#transport = opts.transport ?? http(this.#rpcUrl);
    this.#publicClient = createPublicClient({ chain: this.#chain, transport: this.#transport });
  }

  async getBalance(address: string): Promise<bigint> {
    try {
      const balance = await this.#publicClient.readContract({
        address: ARC_USDC_PRECOMPILE,
        abi: USDC_ABI,
        functionName: "balanceOf",
        args: [address as Address],
      });
      // Convert 6 decimal USDC units to cents (cents = units / 10^4)
      return balance / 10000n;
    } catch {
      // Return 0 if network unreachable or precompile call reverts
      return 0n;
    }
  }

  /**
   * Sends settleOrder after a pre-flight eth_call. Returns `submitted` with the hash of a real
   * transaction, or with the hash of the earlier settlement when the order was already paid.
   */
  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    // First: a sub-cent or non-bigint amount is refused before any settings check, chain read or RPC call.
    assertPayableCentAmount(req.amountCents);
    const { contractAddress, signer, walletClient } = this.#requireSettings();
    await this.#assertChain();

    if (!isAddress(req.fromAddress) || getAddress(req.fromAddress) !== signer.address) {
      throw new SettlementPayerMismatchError();
    }
    if (
      !isAddress(req.toAddress) ||
      !req.orderId ||
      !HASH_RE.test(req.matchHash ?? "")
    ) {
      throw new SettlementRejectedError("INVALID_REQUEST");
    }

    const supplier = getAddress(req.toAddress);
    const matchHash = req.matchHash as Hex;
    const value = req.amountCents * 10n ** 16n; // 1 cent = 1e16 wei of native 18-decimal USDC
    const orderId32 = keccak256(toHex(req.orderId));
    const args = [orderId32, supplier, matchHash] as const;

    const data = encodeFunctionData({ abi: BIND_SETTLEMENT_ABI, functionName: "settleOrder", args });
    try {
      await this.#publicClient.call({ account: signer.address, to: contractAddress, data, value });
    } catch (error) {
      return this.#classifyFailure(error, "pre-flight call", contractAddress, orderId32);
    }

    let txHash: Hex;
    try {
      txHash = await walletClient.writeContract({
        address: contractAddress,
        abi: BIND_SETTLEMENT_ABI,
        functionName: "settleOrder",
        args,
        value,
        account: signer,
        chain: this.#chain,
      });
    } catch (error) {
      // A revert here means the order was settled between the pre-flight and the send.
      return this.#classifyFailure(error, "settleOrder send", contractAddress, orderId32);
    }
    return this.#result(txHash, "submitted");
  }

  /**
   * Looks for the transaction's receipt for at most `confirmWaitMs`. Confirmed only when the receipt
   * succeeded and the contract emitted SettlementExecuted. Any RPC failure leaves the outcome unknown,
   * which is reported as submitted.
   */
  async confirm(txHash: string): Promise<TransferResult> {
    if (!HASH_RE.test(txHash)) throw new SettlementRejectedError("INVALID_REQUEST");
    const contractAddress = this.#contractAddress();
    const hash = txHash as Hex;

    const receipt = await this.#pollReceipt(hash);
    if (!receipt) return this.#result(hash, "submitted");

    const blockNumber = Number(receipt.blockNumber);
    if (receipt.status !== "success") {
      return this.#result(hash, "failed", { blockNumber, failureCode: "REVERTED" });
    }
    const fromContract = receipt.logs.filter((log) => log.address.toLowerCase() === contractAddress.toLowerCase());
    let executed: unknown[];
    try {
      executed = parseEventLogs({ abi: BIND_SETTLEMENT_ABI, logs: fromContract, eventName: "SettlementExecuted" });
    } catch (error) {
      throw transportErrorFrom("receipt decode", error, this.#secrets());
    }
    if (executed.length === 0) {
      return this.#result(hash, "failed", { blockNumber, failureCode: "EVENT_MISSING" });
    }
    return this.#result(hash, "confirmed", { blockNumber });
  }

  /**
   * Looks up the settlement made for an order id, from the deploy block to the latest block. A
   * SettlementExecuted log is emitted only by a successful transaction, so a log found here is a confirmed
   * transfer and is returned as `confirmed` with its real hash and block. No log means no settlement has been
   * mined for the order, and null is returned. That is not proof that nothing is in flight: a transaction that
   * was sent but is not yet mined has no log. That is safe only because the contract refuses a second
   * settleOrder for the same order id (OrderAlreadySettled). See docs/decisions/0019-settlement-through-the-ledger.md.
   * An RPC failure throws; it is never reported as null.
   */
  async findTransfer(req: { orderId: string }): Promise<TransferResult | null> {
    const contractAddress = this.#contractAddress();
    const log = await this.#findSettlement(contractAddress, keccak256(toHex(req.orderId)));
    if (!log) return null;
    if (!log.transactionHash) {
      throw new SettlementTransportError("settlement lookup", "the settlement log has no transaction hash");
    }
    return this.#result(log.transactionHash, "confirmed", log.blockNumber === null ? {} : { blockNumber: Number(log.blockNumber) });
  }

  /**
   * Reads the contract's `settledOrders` mapping for the order id, as `transferUSDC` computes it. A read only: nothing is
   * sent. The chain id is checked first, as the other reads do. Any failed read throws; a failure is never `false`.
   */
  async isOrderSettled(orderId: string): Promise<boolean> {
    const contractAddress = this.#contractAddress();
    await this.#assertChain();
    let settled: unknown;
    try {
      settled = await this.#publicClient.readContract({
        address: contractAddress,
        abi: BIND_SETTLEMENT_ABI,
        functionName: "settledOrders",
        args: [keccak256(toHex(orderId))],
      });
    } catch (error) {
      throw transportErrorFrom("settled order read", error, this.#secrets());
    }
    if (typeof settled !== "boolean") {
      throw new SettlementTransportError("settled order read", "the contract returned no boolean");
    }
    return settled;
  }

  async depositEscrow(_req: TransferRequest, _milestoneId: string): Promise<TransferResult> {
    throw new SettlementNotSupportedError("depositEscrow");
  }

  async releaseEscrow(_milestoneId: string, _toAddress: string): Promise<TransferResult> {
    throw new SettlementNotSupportedError("releaseEscrow");
  }

  #result(txHash: Hex, status: SettlementStatus, extra: Partial<TransferResult> = {}): TransferResult {
    const explorer = this.#chainId === ARC_TESTNET_CHAIN_ID ? { explorerUrl: `${ARC_EXPLORER_TX_PREFIX}${txHash}` } : {};
    return {
      txHash,
      status,
      timestamp: new Date(),
      mode: "arc-testnet",
      simulated: false,
      ...explorer,
      ...extra,
    };
  }

  /** Strings that must never appear in an error message: the RPC URL (it can carry a token) and the signer key. */
  #secrets(): string[] {
    return [this.#rpcUrl, this.#keySetting ?? ""];
  }

  /**
   * A custom revert is decoded and becomes a domain result. Only an error with no revert data is a transport
   * failure, and it is wrapped with the operation name and a redacted reason.
   */
  async #classifyFailure(
    error: unknown,
    operation: string,
    contractAddress: Address,
    orderId32: Hex
  ): Promise<TransferResult> {
    const revert = revertDataOf(error);
    if (revert === undefined) throw transportErrorFrom(operation, error, this.#secrets());
    const decoded = decodeRevert(revert);
    if (!decoded) throw new SettlementRejectedError("UNKNOWN_REVERT");
    if (decoded.errorName !== "OrderAlreadySettled") {
      throw new SettlementRejectedError(decoded.errorName, decoded.args);
    }
    const earlier = await this.#findSettlement(contractAddress, orderId32);
    if (!earlier?.transactionHash) throw new SettlementRejectedError("OrderAlreadySettled");
    return this.#result(earlier.transactionHash, "submitted");
  }

  #contractAddress(): Address {
    const setting = this.#contractSetting;
    if (!setting || !isAddress(setting)) {
      throw new SettlementNotConfiguredError(["BIND_SETTLEMENT_ADDRESS"]);
    }
    return getAddress(setting);
  }

  /** Validates the contract address and the signer key. The key is never copied into an error. */
  #requireSettings(): { contractAddress: Address; signer: PrivateKeyAccount; walletClient: WalletClient<Transport, Chain, PrivateKeyAccount> } {
    const missing: string[] = [];
    const contract = this.#contractSetting;
    const key = this.#keySetting;
    if (!contract || !isAddress(contract)) missing.push("BIND_SETTLEMENT_ADDRESS");
    if (!key || !PRIVATE_KEY_RE.test(key)) missing.push("ARC_SIGNER_PRIVATE_KEY");
    if (missing.length > 0 || !contract || !key) throw new SettlementNotConfiguredError(missing);

    if (!this.#signer) {
      try {
        this.#signer = privateKeyToAccount(key as Hex);
      } catch {
        throw new SettlementNotConfiguredError(["ARC_SIGNER_PRIVATE_KEY"]);
      }
    }
    if (!this.#walletClient) {
      this.#walletClient = createWalletClient({ account: this.#signer, chain: this.#chain, transport: this.#transport });
    }
    return { contractAddress: getAddress(contract), signer: this.#signer, walletClient: this.#walletClient };
  }

  /** Checks eth_chainId once. A successful check is cached; a mismatch is never cached. */
  async #assertChain(): Promise<void> {
    if (this.#chainVerified) return;
    let actual: number;
    try {
      actual = await this.#publicClient.getChainId();
    } catch (error) {
      throw transportErrorFrom("chain id check", error, this.#secrets());
    }
    if (actual !== this.#chainId) throw new SettlementChainMismatchError(this.#chainId, actual);
    this.#chainVerified = true;
  }

  #settlementEvent(): AbiEvent {
    const item = BIND_SETTLEMENT_ABI.find((entry) => entry.type === "event" && entry.name === "SettlementExecuted");
    if (!item) throw new Error("BindSettlement ABI has no SettlementExecuted event");
    return item as AbiEvent;
  }

  /**
   * The SettlementExecuted log of the settlement that paid this order id. The span from the deploy block to the head is
   * scanned in windows of at most ARC_LOG_CHUNK_BLOCKS, newest first, and the scan stops at the first window with a log.
   * Undefined when no window has one. Any failed read throws: the head read or a window. A failure is never read as
   * "no settlement" (see log-scan.ts).
   *
   * Known limitation: when the deploy block is past the head, the span is empty. No window is read and the lookup returns
   * undefined, which the caller reads as "not found". That is not evidence that nothing is in flight or settled, so a null
   * there is not a safe-to-resend answer. The live harness refuses to continue on it.
   */
  async #findSettlement(
    contractAddress: Address,
    orderId32: Hex
  ): Promise<{ transactionHash: Hex | null; blockNumber: bigint | null } | undefined> {
    const event = this.#settlementEvent();
    let log: Awaited<ReturnType<PublicClient["getLogs"]>>[number] | undefined;
    try {
      const latest = await this.#publicClient.getBlockNumber();
      log = await findNewestLog({
        latest,
        deployBlock: this.#deployBlock,
        chunkBlocks: this.#logChunkBlocks,
        rangeLimitOf: rangeLimitOfError,
        fetchRange: (from, to) =>
          this.#publicClient.getLogs({
            address: contractAddress,
            event,
            args: { orderId: orderId32 },
            fromBlock: from,
            toBlock: to,
          }),
      });
    } catch (error) {
      throw transportErrorFrom("settlement lookup", error, this.#secrets());
    }
    if (!log) return undefined;
    return { transactionHash: log.transactionHash, blockNumber: log.blockNumber };
  }

  async #pollReceipt(hash: Hex): Promise<TransactionReceipt | undefined> {
    const deadline = Date.now() + this.#confirmWaitMs;
    for (;;) {
      try {
        return await this.#publicClient.getTransactionReceipt({ hash });
      } catch (error) {
        // Not mined yet: keep waiting. Any other failure leaves the outcome unknown.
        if (!(error instanceof TransactionReceiptNotFoundError)) return undefined;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await new Promise((resolve) => setTimeout(resolve, Math.min(RECEIPT_POLL_MS, remaining)));
    }
  }
}
