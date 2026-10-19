import { describe, it, expect, beforeEach } from "vitest";
import { custom, keccak256, toHex, type Address, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createLocalChain, type LocalChain } from "../helpers/local-chain.js";
import { deployBindSettlement } from "../helpers/bind-settlement.js";
import { ArcL1SettlementAdapter } from "../../src/adapters/settlement/arc-l1.js";
import { SettlementTransportError } from "../../src/adapters/settlement/errors.js";
import type { TransferRequest } from "../../src/adapters/settlement/types.js";

/**
 * findTransfer on the Arc adapter, against the in-process BindSettlement contract (not Anvil). It looks a
 * settlement up by order id in the SettlementExecuted logs. Local test keys only; they sign nothing on a network.
 */
const SIGNER_KEY: Hex = `0x${"11".repeat(32)}`;
const SUPPLIER_KEY: Hex = `0x${"22".repeat(32)}`;
const SIGNER = privateKeyToAccount(SIGNER_KEY).address;
const SUPPLIER = privateKeyToAccount(SUPPLIER_KEY).address;
const CHAIN_ID = 31337;
const ONE_USDC_WEI = 10n ** 18n;
const MATCH_HASH = keccak256(toHex("po|receipt|bill"));
const RPC_URL = "https://rpc.example.test/v1/SECRETTOKEN-123";

interface Env {
  chain: LocalChain;
  contract: Address;
  adapter: ArcL1SettlementAdapter;
}

function transportFor(chain: LocalChain): Transport {
  return custom({ request: chain.request as any });
}

function makeAdapter(
  chain: LocalChain,
  contract: Address,
  transport: Transport = transportFor(chain),
  rpcUrl?: string
): ArcL1SettlementAdapter {
  return new ArcL1SettlementAdapter({
    chainId: CHAIN_ID,
    contractAddress: contract,
    signerPrivateKey: SIGNER_KEY,
    transport,
    confirmWaitMs: 0,
    ...(rpcUrl ? { rpcUrl } : {}),
  });
}

async function setup(): Promise<Env> {
  const chain = await createLocalChain({ chainId: CHAIN_ID, balances: { [SIGNER]: 1000n * ONE_USDC_WEI } });
  const deployed = await deployBindSettlement(chain, SIGNER_KEY);
  return { chain, contract: deployed.address, adapter: makeAdapter(chain, deployed.address) };
}

function settleRequest(orderId: string, overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    fromAddress: SIGNER,
    toAddress: SUPPLIER,
    amountCents: 24500n,
    currency: "USDC",
    orderId,
    idempotencyKey: `idem_pay_${orderId}`,
    matchHash: MATCH_HASH,
    ...overrides,
  };
}

describe("Arc adapter findTransfer", () => {
  let env: Env;

  beforeEach(async () => {
    env = await setup();
  });

  it("finds the transfer of a settled order by order id", async () => {
    const sent = await env.adapter.transferUSDC(settleRequest("ord_found_1"));

    const found = await env.adapter.findTransfer({ orderId: "ord_found_1" });

    expect(found).not.toBeNull();
    expect(found!.txHash).toBe(sent.txHash);
    expect(found!.status).toBe("confirmed");
    expect(found!.mode).toBe("arc-testnet");
    expect(found!.simulated).toBe(false);
    expect(typeof found!.blockNumber).toBe("number");
    expect(found!.blockNumber).toBeGreaterThan(0);
  });

  it("returns null for an order that was never settled", async () => {
    expect(await env.adapter.findTransfer({ orderId: "ord_never_settled" })).toBeNull();
  });

  it("does not find another order's transfer", async () => {
    await env.adapter.transferUSDC(settleRequest("ord_other_a"));

    expect(await env.adapter.findTransfer({ orderId: "ord_other_b" })).toBeNull();
    expect(await env.adapter.findTransfer({ orderId: "ord_other_a" })).not.toBeNull();
  });

  it("an RPC failure is thrown, not reported as no transfer", async () => {
    await env.adapter.transferUSDC(settleRequest("ord_rpc_down"));
    const failure = `request to ${RPC_URL} failed`;
    const flaky = makeAdapter(
      env.chain,
      env.contract,
      custom({
        request: (args: { method: string; params?: unknown[] }) =>
          args.method === "eth_getLogs" ? Promise.reject(new Error(failure)) : env.chain.request(args),
      } as any),
      RPC_URL
    );

    const error = await flaky.findTransfer({ orderId: "ord_rpc_down" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SettlementTransportError);
    expect((error as SettlementTransportError).operation).toBe("settlement lookup");
    expect((error as Error).message).not.toContain("SECRETTOKEN-123");
    expect((error as Error).message).not.toContain("https://");
    expect((error as Error).cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("SECRETTOKEN-123");
  });
});
