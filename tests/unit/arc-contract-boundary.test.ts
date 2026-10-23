import { describe, it, expect } from "vitest";
import { encodeFunctionData, decodeFunctionData, parseUnits, isAddress } from "viem";
import {
  USDC_ABI,
  ERC8183_ABI,
  ARC_USDC_PRECOMPILE,
  ARC_TESTNET_CHAIN_ID,
  ArcL1SettlementAdapter,
} from "../../src/adapters/settlement/arc-l1.js";

describe("Arc L1 Contract & ABI Boundary Verification (docs/CONTRACT_SCOPE.md)", () => {
  it("verifies Arc Testnet chain constants and precompile addresses", () => {
    expect(ARC_TESTNET_CHAIN_ID).toBe(5042002);
    expect(isAddress(ARC_USDC_PRECOMPILE)).toBe(true);
    expect(ARC_USDC_PRECOMPILE.toLowerCase()).toBe("0x3600000000000000000000000000000000000000");
  });

  it("correctly encodes and decodes native USDC transfer function calls", () => {
    const recipient = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
    const amountUnits = parseUnits("245.00", 6); // 245 USDC

    const encoded = encodeFunctionData({
      abi: USDC_ABI,
      functionName: "transfer",
      args: [recipient, amountUnits],
    });

    expect(encoded.startsWith("0xa9059cbb")).toBe(true); // ERC-20 transfer(address,uint256) selector

    const decoded = decodeFunctionData({
      abi: USDC_ABI,
      data: encoded,
    });

    expect(decoded.functionName).toBe("transfer");
    expect(decoded.args).toBeDefined();
    expect((decoded.args![0] as string).toLowerCase()).toBe(recipient.toLowerCase());
    expect(decoded.args![1]).toBe(amountUnits);
  });

  it("correctly encodes and decodes ERC-8183 Agent Escrow deposit and release calls", () => {
    const milestoneId = "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as const;
    const contractor = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
    const amountUnits = parseUnits("500.00", 6);

    const encodedDeposit = encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: "depositMilestone",
      args: [milestoneId, contractor, amountUnits],
    });

    expect(encodedDeposit).toBeDefined();

    const decodedDeposit = decodeFunctionData({
      abi: ERC8183_ABI,
      data: encodedDeposit,
    });

    expect(decodedDeposit.functionName).toBe("depositMilestone");
    expect(decodedDeposit.args).toBeDefined();
    expect(decodedDeposit.args![0]).toBe(milestoneId);
    expect((decodedDeposit.args![1] as string).toLowerCase()).toBe(contractor.toLowerCase());
    expect(decodedDeposit.args![2]).toBe(amountUnits);

    // Release Milestone
    const encodedRelease = encodeFunctionData({
      abi: ERC8183_ABI,
      functionName: "releaseMilestone",
      args: [milestoneId, contractor],
    });

    const decodedRelease = decodeFunctionData({
      abi: ERC8183_ABI,
      data: encodedRelease,
    });

    expect(decodedRelease.functionName).toBe("releaseMilestone");
    expect(decodedRelease.args).toBeDefined();
    expect(decodedRelease.args![0]).toBe(milestoneId);
    expect((decodedRelease.args![1] as string).toLowerCase()).toBe(contractor.toLowerCase());
  });

  it("safely handles offline RPC fallback without crashing", async () => {
    const adapter = new ArcL1SettlementAdapter({ rpcUrl: "http://127.0.0.1:9999" }); // offline port
    const balance = await adapter.getBalance("0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2");
    expect(balance).toBe(0n);
  });
});
