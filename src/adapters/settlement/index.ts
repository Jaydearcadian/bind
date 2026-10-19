import type { Address, Hex } from "viem";
import { SettlementAdapter } from "./types.js";
import { LocalSettlementSimulator } from "./local-sim.js";
import { ArcL1SettlementAdapter } from "./arc-l1.js";
import { config } from "../../config/env.js";

const localSimulator = new LocalSettlementSimulator();
let arcAdapter: ArcL1SettlementAdapter | null = null;

/**
 * Returns the adapter for a settlement mode. The Arc adapter is built on first use from config and
 * validates its own settings when it is used, so importing this module never throws.
 */
export function getSettlementAdapter(mode: "local" | "arc-testnet" = config.SETTLEMENT_MODE as any): SettlementAdapter {
  if (mode === "arc-testnet") {
    if (!arcAdapter) {
      arcAdapter = new ArcL1SettlementAdapter({
        rpcUrl: config.ARC_RPC_URL,
        chainId: config.ARC_CHAIN_ID,
        contractAddress: config.BIND_SETTLEMENT_ADDRESS as Address | undefined,
        signerPrivateKey: config.ARC_SIGNER_PRIVATE_KEY as Hex | undefined,
      });
    }
    return arcAdapter;
  }
  return localSimulator;
}
