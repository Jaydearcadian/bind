import { describe, it, expect } from "vitest";
import { custom, decodeFunctionData, encodeFunctionResult, keccak256, numberToHex, toHex, type Hex } from "viem";
import { ArcL1SettlementAdapter, ARC_TESTNET_CHAIN_ID } from "../../src/adapters/settlement/arc-l1.js";
import { BIND_SETTLEMENT_ABI } from "../../src/adapters/settlement/bind-settlement.abi.js";
import { LocalSettlementSimulator } from "../../src/adapters/settlement/local-sim.js";
import { SettlementChainMismatchError, SettlementNotConfiguredError, SettlementTransportError } from "../../src/adapters/settlement/errors.js";

/**
 * The read that tells the tab ledger whether the contract settled an order (docs/decisions/0081, restore rules). Pinned
 * against a stub transport: the right contract function, the order id hashed as transferUSDC hashes it, the chain id
 * checked, and every failed read thrown rather than read as "not settled".
 */

const CONTRACT = "0x5a86a8f9c2d8f8f0a3b9d3c0e4b1f2a6c7d8e9f0" as const;
const KEY: Hex = `0x${"11".repeat(32)}`;

interface Seen {
  method: string;
  params: unknown;
}

/** A transport that answers eth_chainId with `chainId` and eth_call with `answer` (or throws when `answer` is an Error). */
function stub(opts: { chainId?: number; answer?: boolean | Error | "garbage" }) {
  const seen: Seen[] = [];
  const transport = custom(
    {
      async request({ method, params }: { method: string; params?: unknown }) {
        seen.push({ method, params });
        if (method === "eth_chainId") return numberToHex(opts.chainId ?? ARC_TESTNET_CHAIN_ID);
        if (method === "eth_call") {
          if (opts.answer instanceof Error) throw opts.answer;
          if (opts.answer === "garbage") return "0x";
          return encodeFunctionResult({ abi: BIND_SETTLEMENT_ABI, functionName: "settledOrders", result: opts.answer === true });
        }
        throw new Error(`unexpected RPC method in test: ${method}`);
      },
    } as never,
    { retryCount: 0 }
  );
  return { transport, seen };
}

function adapterOn(transport: ReturnType<typeof custom>) {
  return new ArcL1SettlementAdapter({
    rpcUrl: "http://127.0.0.1:9",
    chainId: ARC_TESTNET_CHAIN_ID,
    contractAddress: CONTRACT,
    signerPrivateKey: KEY,
    transport,
  });
}

describe("ArcL1SettlementAdapter.isOrderSettled (read only)", () => {
  it("answers true and false from the contract's settledOrders, for the order id as transferUSDC hashes it", async () => {
    for (const answer of [true, false]) {
      const rpc = stub({ answer });
      const settled = await adapterOn(rpc.transport).isOrderSettled("tab_stl_123");
      expect(settled).toBe(answer);

      const call = rpc.seen.find((s) => s.method === "eth_call") as { params: [{ to: string; data: Hex }] };
      expect(call.params[0].to.toLowerCase()).toBe(CONTRACT.toLowerCase());
      const decoded = decodeFunctionData({ abi: BIND_SETTLEMENT_ABI, data: call.params[0].data });
      expect(decoded.functionName).toBe("settledOrders");
      // The argument is keccak256 of the UTF-8 order id, the same hash transferUSDC sends for this order.
      expect(decoded.args).toEqual([keccak256(toHex("tab_stl_123"))]);
    }
  });

  it("sends nothing but reads: no transaction method is ever called", async () => {
    const rpc = stub({ answer: true });
    await adapterOn(rpc.transport).isOrderSettled("tab_stl_read");
    const methods = rpc.seen.map((s) => s.method);
    expect(methods.every((m) => m === "eth_chainId" || m === "eth_call")).toBe(true);
    expect(methods).not.toContain("eth_sendRawTransaction");
  });

  it("refuses to answer when the chain is not the configured one", async () => {
    const rpc = stub({ chainId: 1, answer: true });
    await expect(adapterOn(rpc.transport).isOrderSettled("tab_stl_chain")).rejects.toBeInstanceOf(SettlementChainMismatchError);
  });

  it("throws, and never answers false, when the RPC call fails", async () => {
    const rpc = stub({ answer: new Error("upstream returned 503 for https://rpc.example/secret-token") });
    const adapter = adapterOn(rpc.transport);
    const err = await adapter.isOrderSettled("tab_stl_rpc").then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(SettlementTransportError);
    expect(String((err as Error).message)).not.toContain("secret-token");
  });

  it("throws when the answer is not a boolean", async () => {
    const rpc = stub({ answer: "garbage" });
    await expect(adapterOn(rpc.transport).isOrderSettled("tab_stl_garbage")).rejects.toBeInstanceOf(SettlementTransportError);
  });

  it("throws before any call when no settlement contract is configured", async () => {
    const adapter = new ArcL1SettlementAdapter({
      rpcUrl: "http://127.0.0.1:9",
      chainId: ARC_TESTNET_CHAIN_ID,
      contractAddress: undefined,
      signerPrivateKey: KEY,
      transport: stub({ answer: true }).transport,
    });
    await expect(adapter.isOrderSettled("tab_stl_nocontract")).rejects.toBeInstanceOf(SettlementNotConfiguredError);
  });
});

describe("LocalSettlementSimulator.isOrderSettled (parity with the Arc read)", () => {
  it("is false for an order it never moved, and true once a transfer for that order was made", async () => {
    const sim = new LocalSettlementSimulator();
    expect(await sim.isOrderSettled("tab_never")).toBe(false);
    await sim.transferUSDC({
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: "0x2222222222222222222222222222222222222222",
      amountCents: 5n,
      currency: "USDC",
      orderId: "tab_paid",
      idempotencyKey: "idem_pay_tab_paid",
      matchHash: `0x${"aa".repeat(32)}`,
    });
    expect(await sim.isOrderSettled("tab_paid")).toBe(true);
    expect(await sim.isOrderSettled("tab_never")).toBe(false);
  });
});
