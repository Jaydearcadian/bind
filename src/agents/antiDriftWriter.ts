import fs from "node:fs/promises";
import path from "node:path";
import { VerifiableDecisionRecord } from "./bindTemplateAgent.js";

export const CANONICAL_ARC_LOCK = {
  chainName: "ARC-TESTNET",
  chainId: 5042002,
  rpcUrl:
    process.env.ARC_RPC_URL ||
    process.env.RPC_URL ||
    "https://rpc.testnet.arc-node.thecanteenapp.com/v1/<ARC_RPC_TOKEN>",
  explorerBaseUrl: "https://testnet.arcscan.app",
  bindSettlementContract: "0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29",
  whitelistedVendor: "0xa8358AED200D6CB6C856F972D853C1be833006ea",
  verifiedDeploymentTx:
    "0xe152f9ced4c696548c42d629ea88917ca1b810de845407ac0b7c17698245300e",
  verifiedDailyLimitTx:
    "0x388196b8c8fdf16cf600a1f059fa8fa0fde6a710424588eea6f54c0425b5d1ab",
  verifiedWhitelistToggleTx:
    "0x4c8f5b2ca544c05a22caa639d4707cb8c81264ff38044d338d02f6bb7f2d7051",
  verifiedVendorWhitelistTx:
    "0x20f04822e1ea1fe0a79953071207a64db3575bd90e15f0243dc1a4be3575ae2a",
  verifiedSampleSettlementTx:
    "0x626129a1953e7fa8cea3c1d5f4904e246ec9eae5de1ecdb6fb91af581c711bbb",
  errorSelectors: {
    VendorNotWhitelisted: "0x65e822e9",
    DailyLimitExceeded: "0xef664d6a",
  },
} as const;

export class InvariantDriftError extends Error {
  constructor(message: string) {
    super(`[BIND_INVARIANT_DRIFT_BLOCKED] ${message}`);
    this.name = "InvariantDriftError";
  }
}

/**
 * Cancels runtime drift by verifying all non-negotiable spec & infrastructure invariants.
 */
export function assertNoSpecDrift(record: VerifiableDecisionRecord): void {
  if (
    record.onChainPolicyPreFlight.contractAddress.toLowerCase() !==
    CANONICAL_ARC_LOCK.bindSettlementContract.toLowerCase()
  ) {
    throw new InvariantDriftError(
      `Contract address drifted from canonical lock (${CANONICAL_ARC_LOCK.bindSettlementContract}).`
    );
  }

  if (record.onChainPolicyPreFlight.chainId !== CANONICAL_ARC_LOCK.chainId) {
    throw new InvariantDriftError(
      `Chain ID drifted from canonical lock (${CANONICAL_ARC_LOCK.chainId}).`
    );
  }

  if (record.supplierIntegrationMode !== "SIMULATED_SUPPLIER_ADAPTER") {
    throw new InvariantDriftError(
      `Simulated supplier quotes must be explicitly labeled SIMULATED_SUPPLIER_ADAPTER.`
    );
  }

  if (
    record.lifecycleSeparation.goodsFulfilmentStatus !==
    "NOT_FULFILLED_AWAITING_3WAY_MATCH"
  ) {
    throw new InvariantDriftError(
      `Decision phase cannot mark physical goods as fulfilled prior to 3-way match.`
    );
  }

  if (!/^0x[a-f0-9]{64}$/.test(record.decisionHash)) {
    throw new InvariantDriftError(
      `Invalid SHA-256 decisionHash format: ${record.decisionHash}`
    );
  }
}

export interface AntiDriftFilesOutput {
  workflowDir: string;
  stateAnchorPath: string;
  decisionEvidencePath: string;
  stateAnchorMarkdown: string;
  decisionEvidenceMarkdown: string;
}

/**
 * Generates and persists STATE_ANCHOR.md and DECISION_EVIDENCE.md for a workflow run.
 */
export async function writeWorkflowAntiDriftFiles(
  record: VerifiableDecisionRecord,
  options?: {
    baseDir?: string;
    settlementTxHash?: string;
    paymentStatusOverride?:
      | "PENDING_ARC_TESTNET_SETTLEMENT"
      | "SETTLED_ON_ARC_TESTNET"
      | "REVERTED_BY_ONCHAIN_POLICY";
  }
): Promise<AntiDriftFilesOutput> {
  assertNoSpecDrift(record);

  const rootDir = options?.baseDir ?? path.resolve(process.cwd(), "workflows");
  const workflowDir = path.join(rootDir, record.workflowId);
  await fs.mkdir(workflowDir, { recursive: true });

  const paymentStatus =
    options?.paymentStatusOverride ??
    record.lifecycleSeparation.paymentSettlementStatus;
  const approvalGateStatus = record.onChainPolicyPreFlight.requiresOwnerOverride
    ? "AWAITING_OWNER_APPROVAL_AND_ONCHAIN_OVERRIDE"
    : "WITHIN_AUTONOMOUS_POLICY_BOUNDS";

  const circleQueryCmd = [
    "circle contract query",
    `"whitelistedVendors(address)(bool)"`,
    record.selectedVendor.vendorWallet,
    `--contract ${CANONICAL_ARC_LOCK.bindSettlementContract}`,
    `--chain ${CANONICAL_ARC_LOCK.chainName}`,
    `--rpc-url ${CANONICAL_ARC_LOCK.rpcUrl}`,
  ].join(" ");

  const circleExecuteCmd = [
    "circle wallet execute",
    `"settleOrder(bytes32,address)"`,
    record.decisionHash,
    record.selectedVendor.vendorWallet,
    `--contract ${CANONICAL_ARC_LOCK.bindSettlementContract}`,
    `--chain ${CANONICAL_ARC_LOCK.chainName}`,
    `--amount ${record.selectedVendor.totalPriceUsdc}`,
    `--rpc-url ${CANONICAL_ARC_LOCK.rpcUrl}`,
  ].join(" ");

  const stateAnchorMarkdown = `# Workflow State Anchor: ${record.workflowId}

- **Business Template:** \`${record.templateId}\`
- **Current Phase:** \`${
    paymentStatus === "SETTLED_ON_ARC_TESTNET"
      ? "SETTLED_AWAITING_PHYSICAL_DELIVERY_3WAY_MATCH"
      : "DECISION_LOCKED_READY_FOR_SETTLEMENT"
  }\`
- **Last Updated (UTC):** \`${new Date().toISOString()}\`

## Lifecycle Separation Tracker (Anti-Drift Lock)
- **Supplier Quote Source:** \`${record.supplierIntegrationMode}\` *(Not a live supplier API)*
- **Market Benchmark Source:** \`${record.marketBenchmark.integrationMode}\` (\`${record.marketBenchmark.provider}\`)
- **Owner Authority Gate:** \`${approvalGateStatus}\`
- **Arc L1 Testnet Payment Status:** \`${paymentStatus}\`
- **Physical Goods Fulfilment Status:** \`${record.lifecycleSeparation.goodsFulfilmentStatus}\`

## Canonical On-Chain Policy Lock
- **Target Network:** \`${CANONICAL_ARC_LOCK.chainName}\` (Chain ID \`${CANONICAL_ARC_LOCK.chainId}\`)
- **Policy Contract (\`BindSettlement.sol\`):** \`${CANONICAL_ARC_LOCK.bindSettlementContract}\`
- **Selected Counterparty:** \`${record.selectedVendor.vendorName}\` (\`${record.selectedVendor.vendorWallet}\`)
- **Order Total:** \`${record.selectedVendor.totalPriceUsdc} USDC\`
- **Rolling 24h Cap (\`${record.onChainPolicyPreFlight.dailyLimitUsdc} USDC\`):** \`${
    record.onChainPolicyPreFlight.withinDailyLimit ? "PASS" : "EXCEEDS_LIMIT_0xef664d6a"
  }\`
- **Vendor Whitelist Check:** \`${
    record.onChainPolicyPreFlight.vendorWhitelisted ? "PASS" : "UNWHITELISTED_0x65e822e9"
  }\`
- **Canonical Decision Hash:** \`${record.decisionHash}\`
${
  options?.settlementTxHash
    ? `- **Settlement Transaction:** [${options.settlementTxHash}](${CANONICAL_ARC_LOCK.explorerBaseUrl}/tx/${options.settlementTxHash})\n`
    : ""
}`;

  const benchmarkRows = record.marketBenchmark.benchmarks
    .map(
      (b) =>
        `| \`${record.marketBenchmark.integrationMode}\` | \`${record.marketBenchmark.provider}\` | ${b.title.replace(/\|/g, "-")} | ${b.excerpt.replace(/\|/g, "-").replace(/\n/g, " ")} |`
    )
    .join("\n");

  const decisionEvidenceMarkdown = `# Verifiable Procurement Decision Record: ${record.workflowId}

## 1. Operational Context & Authority Basis
- **Business Template:** \`${record.templateId}\`
- **SKU & Quantity:** \`${record.quantityRequested}\` units of \`${record.skuName}\`
- **Selected Vendor:** \`${record.selectedVendor.vendorName}\` (\`${record.selectedVendor.vendorWallet}\`)
- **Unit / Total Price:** \`${record.selectedVendor.unitPriceUsdc} USDC\` / \`${record.selectedVendor.totalPriceUsdc} USDC\`
- **Reasoning Engine:** \`${record.reasoningProvider}\`${
    record.nebiusModel ? ` (\`${record.nebiusModel}\`)` : ""
  }
- **LangSmith Audit Project:** \`${record.langsmithProject ?? "bind-tameion-arc"}\`
- **SHA-256 Decision Hash:** \`${record.decisionHash}\`

## 2. Agent Rationale
> ${record.agentRationale}

## 3. Truthful Integration & Signal Classification
| Signal Category | Integration Mode Badge | Source / Adapter | Evidence Summary |
| :--- | :--- | :--- | :--- |
| **Supplier RFQ Quote** | \`SIMULATED_SUPPLIER_ADAPTER\` | \`MockSupplierAdapter\` | Quoted \`${record.selectedVendor.totalPriceUsdc} USDC\` with \`${record.selectedVendor.leadTimeDays}d\` lead time |
${benchmarkRows}

## 4. Circle Agent Stack & \`BindSettlement.sol\` Verification
- **Arc L1 Testnet Policy Contract:** [${CANONICAL_ARC_LOCK.bindSettlementContract}](${CANONICAL_ARC_LOCK.explorerBaseUrl}/address/${CANONICAL_ARC_LOCK.bindSettlementContract})
- **Circle CLI Pre-Flight Query:**
  \`\`\`bash
  ${circleQueryCmd}
  \`\`\`
- **Circle CLI Settlement Execution:**
  \`\`\`bash
  ${circleExecuteCmd}
  \`\`\`
- **On-Chain Error Guards Active:** \`VendorNotWhitelisted (${CANONICAL_ARC_LOCK.errorSelectors.VendorNotWhitelisted})\`, \`DailyLimitExceeded (${CANONICAL_ARC_LOCK.errorSelectors.DailyLimitExceeded})\`

## 5. Settlement vs. Fulfilment Invariant
- **Testnet Payment Status:** \`${paymentStatus}\`${
    options?.settlementTxHash
      ? ` ([View on Arcscan](${CANONICAL_ARC_LOCK.explorerBaseUrl}/tx/${options.settlementTxHash}))`
      : ""
  }
- **Goods Fulfilment Status:** \`${record.lifecycleSeparation.goodsFulfilmentStatus}\`
- **Invariant Statement:** This testnet USDC settlement on Arc L1 (\`5042002\`) does **not** represent a live commercial bank transfer and does **not** mark physical goods as delivered. Physical inventory increment requires 3-Way Match verification (Purchase Order + Delivery Receipt + Vendor Invoice).
`;

  const stateAnchorPath = path.join(workflowDir, "STATE_ANCHOR.md");
  const decisionEvidencePath = path.join(workflowDir, "DECISION_EVIDENCE.md");

  await Promise.all([
    fs.writeFile(stateAnchorPath, stateAnchorMarkdown, "utf8"),
    fs.writeFile(decisionEvidencePath, decisionEvidenceMarkdown, "utf8"),
  ]);

  return {
    workflowDir,
    stateAnchorPath,
    decisionEvidencePath,
    stateAnchorMarkdown,
    decisionEvidenceMarkdown,
  };
}
