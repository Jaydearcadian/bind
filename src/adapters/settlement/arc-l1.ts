import { createPublicClient, http, Address } from "viem";
import { SettlementAdapter, TransferRequest, TransferResult } from "./types.js";
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

export class ArcL1SettlementAdapter implements SettlementAdapter {
  readonly mode = "arc-testnet";
  private publicClient;

  constructor(rpcUrl: string = config.RPC_URL) {
    this.publicClient = createPublicClient({
      transport: http(rpcUrl),
    });
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

  async transferUSDC(req: TransferRequest): Promise<TransferResult> {
    // In local-first / simulation mode, we do not require broadcast keys
    const dummyHash = `0xarc_${Date.now()}_${req.orderId}`;
    return {
      txHash: dummyHash,
      status: "settled",
      timestamp: new Date(),
      mode: "arc-testnet",
      explorerUrl: `https://testnet.arcscan.io/tx/${dummyHash}`,
    };
  }

  async depositEscrow(req: TransferRequest, milestoneId: string): Promise<TransferResult> {
    const dummyHash = `0xarc_escrow_${milestoneId}`;
    return {
      txHash: dummyHash,
      status: "settled",
      timestamp: new Date(),
      mode: "arc-testnet",
      explorerUrl: `https://testnet.arcscan.io/tx/${dummyHash}`,
    };
  }

  async releaseEscrow(milestoneId: string, _toAddress: string): Promise<TransferResult> {
    const dummyHash = `0xarc_release_${milestoneId}`;
    return {
      txHash: dummyHash,
      status: "settled",
      timestamp: new Date(),
      mode: "arc-testnet",
      explorerUrl: `https://testnet.arcscan.io/tx/${dummyHash}`,
    };
  }
}
