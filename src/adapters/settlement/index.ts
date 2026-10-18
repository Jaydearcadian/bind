import { SettlementAdapter } from "./types.js";
import { LocalSettlementSimulator } from "./local-sim.js";
import { ArcL1SettlementAdapter } from "./arc-l1.js";
import { config } from "../../config/env.js";

const localSimulator = new LocalSettlementSimulator();
let arcAdapter: ArcL1SettlementAdapter | null = null;

export function getSettlementAdapter(mode: "local" | "arc-testnet" = config.SETTLEMENT_MODE as any): SettlementAdapter {
  if (mode === "arc-testnet") {
    if (!arcAdapter) {
      arcAdapter = new ArcL1SettlementAdapter();
    }
    return arcAdapter;
  }
  return localSimulator;
}
