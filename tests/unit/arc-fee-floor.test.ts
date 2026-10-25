import { describe, it, expect } from "vitest";
import { decodeFunctionData, parseTransaction, type Hex } from "viem";
import {
  ARC_DEFAULT_PRIORITY_FEE_WEI,
  ARC_FEE_FALLBACK_WEI,
  ARC_MAX_BASE_FEE_WEI,
  ARC_MIN_BASE_FEE_WEI,
  feeCapsFor,
} from "../../src/adapters/settlement/arc-l1.js";
import { BIND_SETTLEMENT_ABI } from "../../src/adapters/settlement/bind-settlement.abi.js";
import type { TransferRequest } from "../../src/adapters/settlement/types.js";
import {
  GWEI,
  MATCH_HASH,
  STUB_CONTRACT,
  SIGNER,
  SUPPLIER,
  adapterOn,
  rpcStub,
  type RpcStubOptions,
} from "../helpers/arc-stub-rpc.js";

/**
 * The fee cap of a settlement, pinned at the broadcast (docs/decisions/0087, item 1). Arc drops a transaction whose
 * maxFeePerGas is below 20 gwei with no receipt, and the documented ceiling is 20,000 gwei. Every case here decodes the raw
 * transaction the adapter would send, so a test cannot pass by inspecting a value the adapter did not use.
 */

const request: TransferRequest = {
  fromAddress: SIGNER,
  toAddress: SUPPLIER,
  amountCents: 24500n,
  currency: "USDC",
  orderId: "ord_fee_floor",
  idempotencyKey: "idem_fee_floor",
  matchHash: MATCH_HASH,
};

async function broadcastWith(opts: RpcStubOptions) {
  const rpc = rpcStub(opts);
  const result = await adapterOn(rpc.transport).transferUSDC(request);
  expect(rpc.raws, "exactly one transaction is broadcast").toHaveLength(1);
  const tx = parseTransaction(rpc.raws[0] as Hex) as {
    type: string;
    to: string;
    value: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas?: bigint;
    data: Hex;
  };
  return { result, tx, rpc };
}

describe("Arc transferUSDC fee cap", () => {
  it("raises an estimate below the 20 gwei floor to the floor", async () => {
    // 1 gwei base fee: viem's estimate is about 2.2 gwei, which the floor replaces.
    const { tx } = await broadcastWith({ baseFeeWei: 1n * GWEI, priorityFeeWei: 1n * GWEI });
    expect(tx.type).toBe("eip1559");
    expect(tx.maxFeePerGas).toBe(ARC_MIN_BASE_FEE_WEI);
  });

  it("keeps an estimate above the floor", async () => {
    // 20 gwei base fee: about 24 gwei plus a 1 gwei tip, so the estimate is above the floor and is sent as estimated.
    const { tx } = await broadcastWith({ baseFeeWei: 20n * GWEI, priorityFeeWei: 1n * GWEI });
    expect(tx.maxFeePerGas > ARC_MIN_BASE_FEE_WEI).toBe(true);
    expect(tx.maxFeePerGas <= ARC_MAX_BASE_FEE_WEI).toBe(true);
    expect(tx.maxFeePerGas).toBe(25n * GWEI);
  });

  it("falls back to 1.5 times the floor (30 gwei) when the estimate throws, and never sends without a cap", async () => {
    const { tx, rpc } = await broadcastWith({ baseFeeWei: "error" });
    expect(ARC_FEE_FALLBACK_WEI).toBe(30n * GWEI);
    expect(tx.maxFeePerGas).toBe(ARC_FEE_FALLBACK_WEI);
    // viem's parser omits a zero priority fee from the decoded transaction, so a missing value is zero.
    expect(tx.maxPriorityFeePerGas ?? 0n).toBe(ARC_DEFAULT_PRIORITY_FEE_WEI);
    expect(rpc.calls.some((c) => c.method === "eth_sendRawTransaction")).toBe(true);
  });

  it("clamps an absurd estimate to the documented 20,000 gwei ceiling", async () => {
    const { tx } = await broadcastWith({ baseFeeWei: 10n ** 18n, priorityFeeWei: 1n * GWEI });
    expect(tx.maxFeePerGas).toBe(ARC_MAX_BASE_FEE_WEI);
    expect(tx.maxFeePerGas).toBe(20_000n * GWEI);
    expect((tx.maxPriorityFeePerGas ?? 0n) <= tx.maxFeePerGas).toBe(true);
  });

  it("broadcasts a maxFeePerGas of at least 20 gwei in every case", async () => {
    const cases: RpcStubOptions[] = [
      { baseFeeWei: 1n * GWEI, priorityFeeWei: 1n * GWEI },
      { baseFeeWei: 20n * GWEI, priorityFeeWei: 1n * GWEI },
      { baseFeeWei: "error" },
      { baseFeeWei: 10n ** 18n, priorityFeeWei: 1n * GWEI },
      { baseFeeWei: 0n, priorityFeeWei: 0n },
    ];
    for (const opts of cases) {
      const { tx } = await broadcastWith(opts);
      expect(tx.maxFeePerGas >= ARC_MIN_BASE_FEE_WEI, `case ${JSON.stringify(opts, (_k, v) => String(v))}`).toBe(true);
      expect(tx.maxFeePerGas <= ARC_MAX_BASE_FEE_WEI).toBe(true);
    }
  });

  it("sends the settlement to the contract with 1 cent of native USDC as value", async () => {
    const { tx } = await broadcastWith({ baseFeeWei: 20n * GWEI });
    expect(tx.to.toLowerCase()).toBe(STUB_CONTRACT.toLowerCase());
    // 245.00 USDC is 24500 cents, so 24500 * 1e16 wei.
    expect(tx.value).toBe(24500n * 10n ** 16n);
    const decoded = decodeFunctionData({ abi: BIND_SETTLEMENT_ABI, data: tx.data });
    expect(decoded.functionName).toBe("settleOrder");
  });

  it("a pre-flight revert stops before any fee read and before any broadcast", async () => {
    // The pre-flight must still pass first: a revert there stops before any fee read or broadcast.
    const rpc = rpcStub({ preflight: { text: "execution reverted: nope" } });
    await expect(adapterOn(rpc.transport).transferUSDC(request)).rejects.toBeInstanceOf(Error);
    expect(rpc.raws).toHaveLength(0);
  });
});

describe("feeCapsFor (pure)", () => {
  it("has no estimate: the floor, with no tip", () => {
    expect(feeCapsFor(undefined)).toEqual({ maxFeePerGas: ARC_MIN_BASE_FEE_WEI, maxPriorityFeePerGas: 0n });
  });

  it("treats zero, negative-looking and missing values as no estimate", () => {
    expect(feeCapsFor({ maxFeePerGas: 0n }).maxFeePerGas).toBe(ARC_MIN_BASE_FEE_WEI);
    expect(feeCapsFor({ maxFeePerGas: undefined }).maxFeePerGas).toBe(ARC_MIN_BASE_FEE_WEI);
  });

  it("never returns a cap below the floor or above the ceiling", () => {
    for (const estimate of [1n, GWEI, 19n * GWEI, 20n * GWEI, 21n * GWEI, 20_000n * GWEI, 20_001n * GWEI, 10n ** 30n]) {
      const caps = feeCapsFor({ maxFeePerGas: estimate, maxPriorityFeePerGas: 0n });
      expect(caps.maxFeePerGas >= ARC_MIN_BASE_FEE_WEI).toBe(true);
      expect(caps.maxFeePerGas <= ARC_MAX_BASE_FEE_WEI).toBe(true);
    }
  });

  it("caps the priority fee at the max fee", () => {
    const caps = feeCapsFor({ maxFeePerGas: 25n * GWEI, maxPriorityFeePerGas: 40n * GWEI });
    expect(caps.maxPriorityFeePerGas).toBe(25n * GWEI);
  });

  it("keeps the estimate's priority fee when it is non-negative", () => {
    const caps = feeCapsFor({ maxFeePerGas: 25n * GWEI, maxPriorityFeePerGas: 2n * GWEI });
    expect(caps).toEqual({ maxFeePerGas: 25n * GWEI, maxPriorityFeePerGas: 2n * GWEI });
  });
});
