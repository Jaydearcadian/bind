import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeepAgent, FilesystemBackend } from "deepagents";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  CircleAgentStackAdapter,
  BIND_SETTLEMENT_CONTRACT,
  ARC_TESTNET_CHAIN,
} from "../adapters/circleAgentStack.js";
import { HybridMarketBenchmarkAdapter } from "../adapters/marketBenchmark.js";

export function createBindCircleAgent(params: {
  templateId: "kitchen-ops" | "coffee-roaster";
  checkpointer?: any;
}): any {
  const circleAdapter = new CircleAgentStackAdapter();
  const benchmarkAdapter = new HybridMarketBenchmarkAdapter();

  const model = new ChatOpenAI({
    model: process.env.NEBIUS_MODEL ?? "nousresearch/Hermes-4-405B",
    configuration: {
      baseURL: "https://api.tokenfactory.nebius.com/v1/",
      apiKey: process.env.NEBIUS_API_KEY || "mock-key-local-development",
    },
    temperature: 0,
  });

  // Tool 1: Read-only On-Chain Policy & Market Benchmark Check (No interrupt required)
  const preflightPolicyAndBenchmarkTool = tool(
    async ({ skuName, vendorAddress }) => {
      const [whitelistCheck, benchmark] = await Promise.all([
        circleAdapter.queryVendorWhitelistStatus(vendorAddress),
        benchmarkAdapter.fetchBenchmark(skuName, params.templateId),
      ]);
      return JSON.stringify({
        arcChain: ARC_TESTNET_CHAIN,
        policyContract: BIND_SETTLEMENT_CONTRACT,
        circleCliReadCommand: whitelistCheck.command,
        whitelistResult: whitelistCheck.rawOutput,
        marketBenchmark: benchmark,
      });
    },
    {
      name: "preflight_arc_policy_and_benchmark",
      description:
        "Runs `circle contract query` against BindSettlement.sol on ARC-TESTNET to verify vendor allowlist status and fetches live market pricing benchmarks.",
      schema: z.object({
        skuName: z.string(),
        vendorAddress: z.string(),
      }),
    }
  );

  // Tool 2: Value-moving Circle Agent Wallet execution on Arc L1 (Gated via interruptOn)
  const executeArcSettlementTool = tool(
    async ({ functionSignature, abiArgs, amountUsdc }) => {
      const result = await circleAdapter.executeBindSettlement({
        functionSignature,
        abiArgs,
        amountUsdc,
      });
      return JSON.stringify(result);
    },
    {
      name: "execute_circle_wallet_arc_settlement",
      description:
        "Executes USDC settlement on Arc L1 Testnet via Circle Agent Wallet (`circle wallet execute`) against BindSettlement.sol.",
      schema: z.object({
        functionSignature: z.string(),
        abiArgs: z.array(z.string()),
        amountUsdc: z.string(),
      }),
    }
  );

  const templateDir = path.resolve(process.cwd(), "templates", params.templateId);
  const circleGlobalSkillsDir = path.join(os.homedir(), ".agents", "skills");
  const skillsDirs = fs.existsSync(circleGlobalSkillsDir)
    ? ["/skills/", circleGlobalSkillsDir]
    : ["/skills/"];

  return createDeepAgent({
    model,
    tools: [preflightPolicyAndBenchmarkTool, executeArcSettlementTool],
    memory: ["/AGENTS.md"],
    // Loads both Bind's business template skills AND Circle Agent Stack's official CLI skills
    skills: skillsDirs,
    backend: new FilesystemBackend({
      rootDir: templateDir,
      virtualMode: false,
    }),
    checkpointer: params.checkpointer,
    // Matches circlefin/agent-stack-starter-kits/kits/langchain: gate value-moving commands
    interruptOn: {
      execute_circle_wallet_arc_settlement: {
        allowedDecisions: ["approve", "edit", "reject"],
      },
    },
    systemPrompt: `You are a Bind Operations Coordinator running on Circle Agent Stack and Arc L1 (${ARC_TESTNET_CHAIN}, Chain ID 5042002).
- Always run preflight_arc_policy_and_benchmark first to verify the counterparty against BindSettlement.sol (${BIND_SETTLEMENT_CONTRACT}) using Circle CLI.
- Explicitly label MockSupplierAdapter quotes as SIMULATED_SUPPLIER_ADAPTER and web benchmarks as LIVE_WEB_BENCHMARK.
- Execute settlement through execute_circle_wallet_arc_settlement (which invokes \`circle wallet execute --chain ARC-TESTNET\`).
- Keep on-chain USDC payment confirmation strictly separate from physical goods fulfilment and 3-way match.`,
  });
}
