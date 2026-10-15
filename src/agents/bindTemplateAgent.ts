import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  HybridMarketBenchmarkAdapter,
  MarketBenchmarkResult,
} from "../adapters/marketBenchmark.js";
import { writeWorkflowAntiDriftFiles } from "./antiDriftWriter.js";

export type BindTemplateId = string;

export interface AvailableTemplateInfo {
  id: string;
  dir: string;
  agentsSpecPath: string;
  hasSkills: boolean;
}

/**
 * Discovers available business templates from disk dynamically at runtime.
 */
export function listAvailableTemplates(): AvailableTemplateInfo[] {
  const templatesRoot = path.resolve(process.cwd(), "templates");
  if (!fs.existsSync(templatesRoot)) return [];
  const entries = fs.readdirSync(templatesRoot, { withFileTypes: true });
  return entries
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(templatesRoot, d.name);
      const agentsSpecPath = path.join(dir, "AGENTS.md");
      const skillsDir = path.join(dir, "skills");
      return {
        id: d.name,
        dir,
        agentsSpecPath,
        hasSkills: fs.existsSync(skillsDir),
      };
    })
    .filter((t) => fs.existsSync(t.agentsSpecPath));
}

/**
 * Resolves directory for any template ID, handling common aliases (e.g., kitchen-v1 -> kitchen-ops).
 */
export function resolveTemplateDir(templateId: string): string {
  const templatesRoot = path.resolve(process.cwd(), "templates");
  const directPath = path.join(templatesRoot, templateId);
  if (fs.existsSync(directPath)) return directPath;

  if (templateId === "kitchen-v1" && fs.existsSync(path.join(templatesRoot, "kitchen-ops"))) {
    return path.join(templatesRoot, "kitchen-ops");
  }
  const fallback = path.join(templatesRoot, "kitchen-ops");
  if (fs.existsSync(fallback)) return fallback;
  return directPath;
}

export interface SimulatedVendorQuote {
  vendorId: string;
  vendorName: string;
  vendorWallet: string;
  unitPriceUsdc: string;
  totalPriceUsdc: string;
  leadTimeDays: number;
  isWhitelistedOnChain: boolean;
}

export interface VerifiableDecisionRecord {
  workflowId: string;
  templateId: BindTemplateId;
  skuName: string;
  quantityRequested: number;
  selectedVendor: SimulatedVendorQuote;
  supplierIntegrationMode: "SIMULATED_SUPPLIER_ADAPTER";
  marketBenchmark: MarketBenchmarkResult;
  onChainPolicyPreFlight: {
    contractAddress: "0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29";
    chainId: 5042002;
    dailyLimitUsdc: string;
    withinDailyLimit: boolean;
    vendorWhitelisted: boolean;
    requiresOwnerOverride: boolean;
  };
  lifecycleSeparation: {
    paymentSettlementStatus: "PENDING_ARC_TESTNET_SETTLEMENT";
    goodsFulfilmentStatus: "NOT_FULFILLED_AWAITING_3WAY_MATCH";
  };
  agentRationale: string;
  reasoningProvider: "nebius-deepagent" | "deterministic-policy-engine";
  nebiusModel?: string;
  langsmithProject?: string;
  decisionHash: `0x${string}`;
  createdAt: string;
}

const DEFAULT_CONTRACT = "0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29" as const;

export async function generateVerifiableDecisionRecord(params: {
  workflowId: string;
  templateId: BindTemplateId;
  skuName: string;
  quantityRequested: number;
  candidateQuotes: SimulatedVendorQuote[];
  dailyLimitUsdc?: string;
}): Promise<VerifiableDecisionRecord> {
  const dailyLimitUsdc = params.dailyLimitUsdc ?? "1.0";
  const templateDir = resolveTemplateDir(params.templateId);

  if (!fs.existsSync(templateDir)) {
    throw new Error(`Bind template directory not found: ${templateDir}`);
  }

  const benchmarkAdapter = new HybridMarketBenchmarkAdapter();
  const contextDomain =
    params.templateId.includes("coffee")
      ? "coffee roastery"
      : params.templateId.includes("kitchen") || params.templateId.includes("restaurant")
      ? "commercial restaurant kitchen"
      : `${params.templateId} operations`;
  const marketBenchmark = await benchmarkAdapter.fetchBenchmark(
    params.skuName,
    contextDomain
  );

  // Deterministic vendor selection baseline (whitelisted + lowest total cost)
  const whitelistedQuotes = params.candidateQuotes.filter((q) => q.isWhitelistedOnChain);
  const pool = whitelistedQuotes.length > 0 ? whitelistedQuotes : params.candidateQuotes;
  const selectedVendor = [...pool].sort(
    (a, b) => parseFloat(a.totalPriceUsdc) - parseFloat(b.totalPriceUsdc)
  )[0];

  const withinDailyLimit =
    parseFloat(selectedVendor.totalPriceUsdc) <= parseFloat(dailyLimitUsdc);
  const requiresOwnerOverride =
    !withinDailyLimit || !selectedVendor.isWhitelistedOnChain;

  let agentRationale =
    `Selected ${selectedVendor.vendorName} (${selectedVendor.vendorWallet}) at ${selectedVendor.totalPriceUsdc} USDC ` +
    `via SIMULATED_SUPPLIER_ADAPTER. On-chain whitelist=${selectedVendor.isWhitelistedOnChain}, ` +
    `within ${dailyLimitUsdc} USDC daily cap=${withinDailyLimit}. Goods fulfilment remains pending 3-way match.`;
  let reasoningProvider: "nebius-deepagent" | "deterministic-policy-engine" =
    "deterministic-policy-engine";
  const nebiusModelId = process.env.NEBIUS_MODEL ?? "nousresearch/Hermes-4-405B";

  // If NEBIUS_API_KEY is present, run the full deepagents harness with AGENTS.md + SKILL.md
  if (process.env.NEBIUS_API_KEY) {
    try {
      const model = new ChatOpenAI({
        model: nebiusModelId,
        configuration: {
          baseURL: "https://api.tokenfactory.nebius.com/v1/",
          apiKey: process.env.NEBIUS_API_KEY,
        },
        temperature: 0,
      });

      const inspectQuotesTool = tool(
        async () =>
          JSON.stringify({
            supplierIntegrationMode: "SIMULATED_SUPPLIER_ADAPTER",
            candidateQuotes: params.candidateQuotes,
            marketBenchmark,
          }),
        {
          name: "inspect_quotes_and_benchmarks",
          description:
            "Returns simulated vendor quotes alongside live market benchmark data.",
          schema: z.object({}),
        }
      );

      const agent = createDeepAgent({
        model,
        tools: [inspectQuotesTool],
        memory: ["/AGENTS.md"],
        skills: ["/skills/"],
        backend: new FilesystemBackend({
          rootDir: templateDir,
          virtualMode: true,
        }),
        systemPrompt:
          "You are Bind's Procurement Coordinator. Read your AGENTS.md and supply-replenishment skill, " +
          "call inspect_quotes_and_benchmarks, and provide a concise 2-sentence procurement justification " +
          "that explicitly distinguishes SIMULATED_SUPPLIER_ADAPTER quotes from LIVE_WEB_BENCHMARK data " +
          "and confirms whether the spend satisfies BindSettlement.sol policy.",
      });

      const result = await agent.invoke({
        messages: [
          {
            role: "user",
            content: `Evaluate replenishment of ${params.quantityRequested} units of ${params.skuName} for workflow ${params.workflowId}.`,
          },
        ],
      });

      const lastMsg = result.messages[result.messages.length - 1];
      if (lastMsg && typeof lastMsg.content === "string" && lastMsg.content.trim()) {
        agentRationale = lastMsg.content.trim();
        reasoningProvider = "nebius-deepagent";
      }
    } catch {
      // Preserve deterministic rationale if external LLM call fails or times out
    }
  }

  const unsignedRecord = {
    workflowId: params.workflowId,
    templateId: params.templateId,
    skuName: params.skuName,
    quantityRequested: params.quantityRequested,
    selectedVendor,
    supplierIntegrationMode: "SIMULATED_SUPPLIER_ADAPTER" as const,
    marketBenchmark,
    onChainPolicyPreFlight: {
      contractAddress: DEFAULT_CONTRACT,
      chainId: 5042002 as const,
      dailyLimitUsdc,
      withinDailyLimit,
      vendorWhitelisted: selectedVendor.isWhitelistedOnChain,
      requiresOwnerOverride,
    },
    lifecycleSeparation: {
      paymentSettlementStatus: "PENDING_ARC_TESTNET_SETTLEMENT" as const,
      goodsFulfilmentStatus: "NOT_FULFILLED_AWAITING_3WAY_MATCH" as const,
    },
    agentRationale,
    reasoningProvider,
    nebiusModel: reasoningProvider === "nebius-deepagent" ? nebiusModelId : undefined,
    langsmithProject: process.env.LANGCHAIN_PROJECT ?? "bind-tameion-arc",
    createdAt: new Date().toISOString(),
  };

  const decisionHash = (`0x` +
    crypto
      .createHash("sha256")
      .update(JSON.stringify(unsignedRecord))
      .digest("hex")) as `0x${string}`;

  const fullRecord: VerifiableDecisionRecord = {
    ...unsignedRecord,
    decisionHash,
  };

  // Automatically writes /workflows/<workflowId>/STATE_ANCHOR.md & DECISION_EVIDENCE.md
  // and blocks any runtime invariant drift before settlement can occur.
  await writeWorkflowAntiDriftFiles(fullRecord);

  return fullRecord;
}
