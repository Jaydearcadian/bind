import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  type Abi,
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
} from "./errors.js";
import { config } from "../../config/env.js";

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
const ARTIFACT_RELATIVE_PATH = "contracts/artifacts/BindSettlement.json";

export interface ArcL1SettlementOptions {
  rpcUrl?: string;
  chainId?: number;
  contractAddress?: Address;
  signerPrivateKey?: Hex;
  transport?: Transport;
  confirmWaitMs?: number;
}

/**
 * Reads the committed BindSettlement ABI. It is read here, not imported statically, so a missing
 * artifact fails only when the Arc adapter is built, never when the settlement module is imported.
 */
function loadSettlementAbi(): Abi {
  const candidates = [
    fileURLToPath(new URL(`../../../${ARTIFACT_RELATIVE_PATH}`, import.meta.url)),
    path.resolve(process.cwd(), ARTIFACT_RELATIVE_PATH),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { abi?: unknown };
      if (!Array.isArray(parsed.abi)) {
        throw new Error(`BindSettlement artifact has no ABI: ${ARTIFACT_RELATIVE_PATH}`);
      }
      return parsed.abi as Abi;
    }
  }
  throw new Error(`BindSettlement artifact not found: ${ARTIFACT_RELATIVE_PATH}`);
}

/** Walks the error cause chain for the first hex string that can hold a custom error selector. */
function revertDataOf(error: unknown): Hex | undefined {
  let node: unknown = error;
  for (let depth = 0; node !== null && typeof node === "object" && depth < 10; depth++) {
    const data = (node as { data?: unknown }).data;
    if (typeof data === "string" && /^0x[0-9a-fA-F]{8,}$/.test(data)) return data as Hex;
    node = (node as { cause?: unknown }).cause;
  }
  return undefined;
}

function decodeRevert(abi: Abi, data: Hex): { errorName: string; args?: unknown[] } | undefined {
  try {
    const decoded = decodeErrorResult({ abi, data });
    return { errorName: decoded.errorName, args: decoded.args ? [...decoded.args] : undefined };
  } catch {
    return undefined;
  }
}

/**
 * Arc L1 settlement through the BindSettlement contract. Every value returned is either read from
 * the chain or built from a hash the chain returned. Nothing is fabricated.
 */
export class ArcL1SettlementAdapter implements SettlementAdapter {
  readonly mode = "arc-testnet" as const;
  private readonly chainId: number;
  private readonly chain: Chain;
  private readonly transport: Transport;
  private readonly contractSetting: string | undefined;
  private readonly keySetting: string | undefined;
  private readonly confirmWaitMs: number;
  private readonly abi: Abi;
  private readonly publicClient: PublicClient;
  private signer: PrivateKeyAccount | undefined;
  private walletClient: WalletClient<Transport, Chain, PrivateKeyAccount> | undefined;
  private chainVerified = false;

  constructor(opts: ArcL1SettlementOptions = {}) {
    this.chainId = opts.chainId ?? config.ARC_CHAIN_ID;
    // An option that is present is used as given, even when undefined. Only an absent option falls back to config.
    this.contractSetting = "contractAddress" in opts ? opts.contractAddress : config.BIND_SETTLEMENT_ADDRESS;
    this.keySetting = "signerPrivateKey" in opts ? opts.signerPrivateKey : config.ARC_SIGNER_PRIVATE_KEY;
    this.confirmWaitMs = opts.confirmWaitMs ?? DEFAULT_CONFIRM_WAIT_MS;
    const rpcUrl = opts.rpcUrl ?? config.ARC_RPC_URL ?? config.RPC_URL;
    this.abi = loadSettlementAbi();
    this.chain = defineChain({
      id: this.chainId,
      name: this.chainId === ARC_TESTNET_CHAIN_ID ? "Arc Testnet" : `Chain ${this.chainId}`,
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });
    this.transport = opts.transport ?? http(rpcUrl);
    this.publicClient = createPublicClient({ chain: this.chain, transport: this.transport });
  }

  async getBalance(address: string): Promise<bigint> {
    try {
      const balance = await this.publicClient.readContract({
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
    const { contractAddress, signer, walletClient } = this.requireSettings();
    await this.assertChain();

    if (!isAddress(req.fromAddress) || getAddress(req.fromAddress) !== signer.address) {
      throw new SettlementPayerMismatchError();
    }
    if (!isAddress(req.toAddress) || req.amountCents <= 0n || !req.orderId || !HASH_RE.test(req.matchHash ?? "")) {
      throw new SettlementRejectedError("INVALID_REQUEST");
    }

    const supplier = getAddress(req.toAddress);
    const matchHash = req.matchHash as Hex;
    const value = req.amountCents * 10n ** 16n; // 1 cent = 1e16 wei of native 18-decimal USDC
    const orderId32 = keccak256(toHex(req.orderId));
    const args = [orderId32, supplier, matchHash] as const;

    const data = encodeFunctionData({ abi: this.abi, functionName: "settleOrder", args: [...args] });
    try {
      await this.publicClient.call({ account: signer.address, to: contractAddress, data, value });
    } catch (error) {
      const revert = revertDataOf(error);
      if (revert === undefined) throw error;
      const decoded = decodeRevert(this.abi, revert);
      if (!decoded) throw new SettlementRejectedError("UNKNOWN_REVERT");
      if (decoded.errorName !== "OrderAlreadySettled") {
        throw new SettlementRejectedError(decoded.errorName, decoded.args);
      }
      const earlier = await this.findSettlement(contractAddress, orderId32);
      if (!earlier) throw new SettlementRejectedError("OrderAlreadySettled");
      return this.result(earlier, "submitted");
    }

    const txHash = await walletClient.writeContract({
      address: contractAddress,
      abi: this.abi,
      functionName: "settleOrder",
      args: [...args],
      value,
      account: signer,
      chain: this.chain,
    });
    return this.result(txHash, "submitted");
  }

  /**
   * Looks for the transaction's receipt for at most `confirmWaitMs`. Confirmed only when the receipt
   * succeeded and the contract emitted SettlementExecuted. Any RPC failure leaves the outcome unknown,
   * which is reported as submitted.
   */
  async confirm(txHash: string): Promise<TransferResult> {
    if (!HASH_RE.test(txHash)) throw new SettlementRejectedError("INVALID_REQUEST");
    const contractAddress = this.contractAddress();
    const hash = txHash as Hex;

    const receipt = await this.pollReceipt(hash);
    if (!receipt) return this.result(hash, "submitted");

    const blockNumber = Number(receipt.blockNumber);
    if (receipt.status !== "success") {
      return this.result(hash, "failed", { blockNumber, failureCode: "REVERTED" });
    }
    const fromContract = receipt.logs.filter((log) => log.address.toLowerCase() === contractAddress.toLowerCase());
    const executed = parseEventLogs({ abi: this.abi, logs: fromContract, eventName: "SettlementExecuted" });
    if (executed.length === 0) {
      return this.result(hash, "failed", { blockNumber, failureCode: "EVENT_MISSING" });
    }
    return this.result(hash, "confirmed", { blockNumber });
  }

  async depositEscrow(_req: TransferRequest, _milestoneId: string): Promise<TransferResult> {
    throw new SettlementNotSupportedError("depositEscrow");
  }

  async releaseEscrow(_milestoneId: string, _toAddress: string): Promise<TransferResult> {
    throw new SettlementNotSupportedError("releaseEscrow");
  }

  private result(txHash: Hex, status: SettlementStatus, extra: Partial<TransferResult> = {}): TransferResult {
    const explorer = this.chainId === ARC_TESTNET_CHAIN_ID ? { explorerUrl: `${ARC_EXPLORER_TX_PREFIX}${txHash}` } : {};
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

  private contractAddress(): Address {
    const setting = this.contractSetting;
    if (!setting || !isAddress(setting)) {
      throw new SettlementNotConfiguredError(["BIND_SETTLEMENT_ADDRESS"]);
    }
    return getAddress(setting);
  }

  /** Validates the contract address and the signer key. The key is never copied into an error. */
  private requireSettings(): { contractAddress: Address; signer: PrivateKeyAccount; walletClient: WalletClient<Transport, Chain, PrivateKeyAccount> } {
    const missing: string[] = [];
    const contract = this.contractSetting;
    const key = this.keySetting;
    if (!contract || !isAddress(contract)) missing.push("BIND_SETTLEMENT_ADDRESS");
    if (!key || !PRIVATE_KEY_RE.test(key)) missing.push("ARC_SIGNER_PRIVATE_KEY");
    if (missing.length > 0 || !contract || !key) throw new SettlementNotConfiguredError(missing);

    if (!this.signer) {
      try {
        this.signer = privateKeyToAccount(key as Hex);
      } catch {
        throw new SettlementNotConfiguredError(["ARC_SIGNER_PRIVATE_KEY"]);
      }
    }
    if (!this.walletClient) {
      this.walletClient = createWalletClient({ account: this.signer, chain: this.chain, transport: this.transport });
    }
    return { contractAddress: getAddress(contract), signer: this.signer, walletClient: this.walletClient };
  }

  /** Checks eth_chainId once. A successful check is cached; a mismatch is never cached. */
  private async assertChain(): Promise<void> {
    if (this.chainVerified) return;
    const actual = await this.publicClient.getChainId();
    if (actual !== this.chainId) throw new SettlementChainMismatchError(this.chainId, actual);
    this.chainVerified = true;
  }

  private settlementEvent(): AbiEvent {
    const item = this.abi.find((entry) => entry.type === "event" && entry.name === "SettlementExecuted");
    if (!item) throw new Error(`BindSettlement artifact has no SettlementExecuted event`);
    return item as AbiEvent;
  }

  /** Recovers the transaction hash of the settlement that already paid this order id. */
  private async findSettlement(contractAddress: Address, orderId32: Hex): Promise<Hex | undefined> {
    const logs = await this.publicClient.getLogs({
      address: contractAddress,
      event: this.settlementEvent(),
      args: { orderId: orderId32 },
      fromBlock: 0n,
    });
    return logs[0]?.transactionHash ?? undefined;
  }

  private async pollReceipt(hash: Hex): Promise<TransactionReceipt | undefined> {
    const deadline = Date.now() + this.confirmWaitMs;
    for (;;) {
      try {
        return await this.publicClient.getTransactionReceipt({ hash });
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
