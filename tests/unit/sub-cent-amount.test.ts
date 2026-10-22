import { describe, it, expect } from "vitest";
import { custom, numberToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ArcL1SettlementAdapter, ARC_TESTNET_CHAIN_ID } from "../../src/adapters/settlement/arc-l1.js";
import { LocalSettlementSimulator } from "../../src/adapters/settlement/local-sim.js";
import {
  SettlementRejectedError,
  SettlementTransportError,
  SUB_CENT_AMOUNT_NOT_SUPPORTED,
} from "../../src/adapters/settlement/errors.js";
import type { TransferRequest } from "../../src/adapters/settlement/types.js";

/*
 * Whole cents only (owner decision): nothing is paid below 0.01 USDC. Local test key only; nothing is signed or
 * broadcast. The transport is a stub that records every RPC method. The Arc adapter's pre-flight eth_call is
 * stopped with a plain error, so no transaction is ever built.
 */

const TREASURY = "0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2";
const SUPPLIER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const CONTRACT = "0x1111111111111111111111111111111111111111";
const MATCH_HASH = `0x${"ab".repeat(32)}`;
const SIGNER = privateKeyToAccount(TEST_KEY).address;
const MESSAGE = "amounts below one cent (0.01 USDC) are not supported yet, only whole cents are paid";

interface RpcCall {
  method: string;
  params: unknown;
}

function rpcStub() {
  const calls: RpcCall[] = [];
  const transport = custom({
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === "eth_chainId") return numberToHex(ARC_TESTNET_CHAIN_ID);
      if (method === "eth_call") throw new Error("stub stops the flow after the pre-flight");
      throw new Error(`unexpected RPC method in test: ${method}`);
    },
  });
  return { transport, calls };
}

function arcAdapter(transport: ReturnType<typeof custom>) {
  return new ArcL1SettlementAdapter({
    rpcUrl: "http://127.0.0.1:9",
    chainId: ARC_TESTNET_CHAIN_ID,
    contractAddress: CONTRACT,
    signerPrivateKey: TEST_KEY,
    transport,
  });
}

/** A request as an untyped caller might send it: `amountCents` may be any value, so the cast goes through unknown. */
function request(overrides: { amountCents?: unknown; orderId?: string } = {}): TransferRequest {
  return {
    fromAddress: SIGNER,
    toAddress: SUPPLIER,
    amountCents: 100n,
    currency: "USDC",
    orderId: "ord_subcent_1",
    idempotencyKey: "idem_subcent_1",
    matchHash: MATCH_HASH,
    ...overrides,
  } as unknown as TransferRequest;
}

async function rejectionOf(promise: Promise<unknown>): Promise<SettlementRejectedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SettlementRejectedError) return error;
    throw new Error(`expected a SettlementRejectedError, got ${String(error)}`);
  }
  throw new Error("expected the transfer to be refused, but it resolved");
}

/** Resolves with the error the promise rejects with, whatever its type. Fails the test if it resolves. */
async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw, but it resolved");
}

const REFUSED_AMOUNTS: Array<[string, unknown]> = [
  ["zero", 0n],
  ["negative", -1n],
  ["a large negative", -1_000_000n],
  ["a fractional JS number", 0.5],
  ["a JS number with a fraction above one", 1.5],
  ["an integer JS number", 5],
  ["a numeric string", "100"],
  ["undefined", undefined],
  ["null", null],
];

describe("sub-cent amounts are refused before any network call (Arc adapter)", () => {
  for (const [label, amount] of REFUSED_AMOUNTS) {
    it(`${label} gives ${SUB_CENT_AMOUNT_NOT_SUPPORTED} and the RPC transport is never invoked`, async () => {
      const { transport, calls } = rpcStub();
      const adapter = arcAdapter(transport);

      const error = await rejectionOf(adapter.transferUSDC(request({ amountCents: amount })));

      expect(error.code).toBe(SUB_CENT_AMOUNT_NOT_SUPPORTED);
      expect(error.message).toContain(MESSAGE);
      expect(calls).toEqual([]);
    });
  }

  it("does not throw a TypeError for a non-bigint amount", async () => {
    const { transport } = rpcStub();
    const adapter = arcAdapter(transport);

    const error = await rejectionOf(adapter.transferUSDC(request({ amountCents: 0.5 })));
    expect(error).toBeInstanceOf(SettlementRejectedError);
    expect(error.name).toBe("SettlementRejectedError");
  });

  it("the refusal does not depend on the other fields: a sub-cent amount with a missing orderId is still the sub-cent code", async () => {
    const { transport, calls } = rpcStub();
    const adapter = arcAdapter(transport);

    const error = await rejectionOf(adapter.transferUSDC(request({ amountCents: 0n, orderId: "" })));
    expect(error.code).toBe(SUB_CENT_AMOUNT_NOT_SUPPORTED);
    expect(calls).toEqual([]);
  });
});

describe("one cent passes the guard and reaches the pre-flight with the exact wei value", () => {
  it("1 cent reaches eth_call with value 1e16 wei and nothing is sent", async () => {
    const { transport, calls } = rpcStub();
    const adapter = arcAdapter(transport);

    const error = await thrownBy(adapter.transferUSDC(request({ amountCents: 1n })));
    // The stub stops the pre-flight with a plain error, so the adapter reports a transport failure, not a refusal.
    expect(error).toBeInstanceOf(SettlementTransportError);
    expect((error as SettlementTransportError).operation).toBe("pre-flight call");

    const methods = calls.map((c) => c.method);
    expect(methods).toContain("eth_chainId");
    expect(methods).toContain("eth_call");
    expect(methods).not.toContain("eth_sendRawTransaction");

    const preflight = calls.find((c) => c.method === "eth_call");
    const tx = (preflight?.params as [{ value?: string }])[0];
    expect(tx.value).toBeDefined();
    expect(BigInt(tx.value as string)).toBe(10n ** 16n);
    expect(BigInt(tx.value as string)).toBe(10_000_000_000_000_000n);
  });

  it("a whole-cent amount keeps the 1e16 wei per cent rule (2 cents = 2e16 wei)", async () => {
    const { transport, calls } = rpcStub();
    const adapter = arcAdapter(transport);

    await thrownBy(adapter.transferUSDC(request({ amountCents: 2n })));

    const preflight = calls.find((c) => c.method === "eth_call");
    const tx = (preflight?.params as [{ value?: string }])[0];
    expect(BigInt(tx.value as string)).toBe(2n * 10n ** 16n);
  });

  it("a 1-cent request with a missing orderId is still INVALID_REQUEST (the other request checks are unchanged)", async () => {
    const { transport, calls } = rpcStub();
    const adapter = arcAdapter(transport);

    const error = await rejectionOf(adapter.transferUSDC(request({ amountCents: 1n, orderId: "" })));
    expect(error.code).toBe("INVALID_REQUEST");
    expect(calls.map((c) => c.method)).not.toContain("eth_call");
  });
});

describe("local simulator parity", () => {
  for (const [label, amount] of REFUSED_AMOUNTS) {
    it(`${label} gives ${SUB_CENT_AMOUNT_NOT_SUPPORTED} and moves no balance`, async () => {
      const sim = new LocalSettlementSimulator();
      const treasuryBefore = await sim.getBalance(TREASURY);
      const supplierBefore = await sim.getBalance(SUPPLIER);

      const error = await rejectionOf(sim.transferUSDC(request({ amountCents: amount })));

      expect(error.code).toBe(SUB_CENT_AMOUNT_NOT_SUPPORTED);
      expect(error.message).toContain(MESSAGE);
      expect(await sim.getBalance(TREASURY)).toBe(treasuryBefore);
      expect(await sim.getBalance(SUPPLIER)).toBe(supplierBefore);
      expect(await sim.findTransfer({ orderId: "ord_subcent_1" })).toBeNull();
    });
  }

  it("a refused sub-cent transfer is not remembered, so the same order can still be paid in whole cents", async () => {
    const sim = new LocalSettlementSimulator();
    await rejectionOf(sim.transferUSDC(request({ amountCents: 0n })));

    const paid = await sim.transferUSDC(request({ amountCents: 1n }));
    expect(paid.status).toBe("submitted");
    expect(paid.simulated).toBe(true);
    expect(await sim.getBalance(SUPPLIER)).toBe(1n);
  });

  it("1 cent is accepted by the simulator", async () => {
    const sim = new LocalSettlementSimulator();
    const paid = await sim.transferUSDC(request({ amountCents: 1n }));
    expect(paid.status).toBe("submitted");
    expect(await sim.getBalance(SUPPLIER)).toBe(1n);
  });

  it("depositEscrow refuses a sub-cent amount and holds nothing", async () => {
    const sim = new LocalSettlementSimulator();
    const treasuryBefore = await sim.getBalance(TREASURY);

    const error = await rejectionOf(sim.depositEscrow(request({ amountCents: 0.5 }), "ms_subcent_1"));

    expect(error.code).toBe(SUB_CENT_AMOUNT_NOT_SUPPORTED);
    expect(await sim.getBalance(TREASURY)).toBe(treasuryBefore);
  });
});

describe("SettlementRejectedError message", () => {
  it("keeps the code-only message when no detail is given", () => {
    expect(new SettlementRejectedError("INVALID_REQUEST").message).toBe("Settlement rejected: INVALID_REQUEST");
  });

  it("appends the plain detail when one is given", () => {
    const error = new SettlementRejectedError(SUB_CENT_AMOUNT_NOT_SUPPORTED, undefined, MESSAGE);
    expect(error.message).toBe(`Settlement rejected: SUB_CENT_AMOUNT_NOT_SUPPORTED: ${MESSAGE}`);
  });
});
