import { describe, it, expect, beforeEach } from "vitest";
import { custom, keccak256, toHex, type Address, type AbiEvent, type Hex, type Transport } from "viem";
import { inspect } from "node:util";
import { privateKeyToAccount } from "viem/accounts";
import { createLocalChain, type LocalChain } from "../helpers/local-chain.js";
import { deployBindSettlement } from "../helpers/bind-settlement.js";
import { ArcL1SettlementAdapter } from "../../src/adapters/settlement/arc-l1.js";
import {
  SettlementChainMismatchError,
  SettlementNotConfiguredError,
  SettlementNotSupportedError,
  SettlementPayerMismatchError,
  SettlementRejectedError,
  SettlementTransportError,
} from "../../src/adapters/settlement/errors.js";
import type { TransferRequest } from "../../src/adapters/settlement/types.js";

/**
 * Arc settlement adapter against the real compiled BindSettlement bytecode, executed by the
 * in-process EthereumJS EVM (not Anvil). Every test gets a fresh chain and a fresh deployment.
 *
 * The keys below are local test keys. They hold nothing outside the in-process chain created by
 * each test, and they sign nothing on any network.
 */
const SIGNER_KEY: Hex = `0x${"11".repeat(32)}`;
const SUPPLIER_KEY: Hex = `0x${"22".repeat(32)}`;
const SIGNER = privateKeyToAccount(SIGNER_KEY).address;
const SUPPLIER = privateKeyToAccount(SUPPLIER_KEY).address;
const CHAIN_ID = 31337;
const ONE_USDC_WEI = 10n ** 18n; // native USDC on Arc uses 18 decimals
const MATCH_HASH = keccak256(toHex("po|receipt|bill"));
const ORDER_ID32 = keccak256(toHex("ord_1"));
const SETTLED_WEI = 24500n * 10n ** 16n; // 24500 cents = 245.00 USDC

interface Env {
  chain: LocalChain;
  deployed: Awaited<ReturnType<typeof deployBindSettlement>>;
  adapter: ArcL1SettlementAdapter;
}

function transportFor(chain: LocalChain): Transport {
  return custom({ request: chain.request as any });
}

function makeAdapter(
  chain: LocalChain,
  contractAddress: Address | undefined,
  opts: { chainId?: number; transport?: Transport; signerPrivateKey?: Hex | undefined; deployBlock?: bigint } = {}
): ArcL1SettlementAdapter {
  return new ArcL1SettlementAdapter({
    chainId: opts.chainId ?? CHAIN_ID,
    contractAddress,
    deployBlock: opts.deployBlock,
    signerPrivateKey: "signerPrivateKey" in opts ? opts.signerPrivateKey : SIGNER_KEY,
    transport: opts.transport ?? transportFor(chain),
    confirmWaitMs: 0,
  });
}

async function setup(): Promise<Env> {
  const chain = await createLocalChain({ chainId: CHAIN_ID, balances: { [SIGNER]: 1000n * ONE_USDC_WEI } });
  const deployed = await deployBindSettlement(chain, SIGNER_KEY);
  return { chain, deployed, adapter: makeAdapter(chain, deployed.address) };
}

function settleRequest(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    fromAddress: SIGNER,
    toAddress: SUPPLIER,
    amountCents: 24500n,
    currency: "USDC",
    orderId: "ord_1",
    idempotencyKey: "idem_pay_ord_1",
    matchHash: MATCH_HASH,
    ...overrides,
  };
}

async function ownerWrite(env: Env, functionName: string, args: readonly unknown[]): Promise<void> {
  const hash = await env.deployed.walletClient.writeContract({
    address: env.deployed.address,
    abi: env.deployed.abi,
    functionName: functionName as never,
    args: args as never,
    gas: 300_000n,
  });
  const receipt = await env.deployed.publicClient.waitForTransactionReceipt({ hash });
  expect(receipt.status).toBe("success");
}

function settlementLogs(env: Env) {
  const event = env.deployed.abi.find((item) => item.type === "event" && item.name === "SettlementExecuted") as AbiEvent;
  return env.deployed.publicClient.getLogs({ address: env.deployed.address, event, fromBlock: 0n });
}

async function supplierBalance(env: Env): Promise<bigint> {
  return env.deployed.publicClient.getBalance({ address: SUPPLIER });
}

/** Resolves with the rejection reason, or fails the test if the promise resolves. */
async function rejectionOf(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

describe("Arc settlement adapter against the in-process BindSettlement contract", () => {
  let env: Env;

  beforeEach(async () => {
    env = await setup();
  });

  it("submits settleOrder and reports submitted with the real hash", async () => {
    const result = await env.adapter.transferUSDC(settleRequest());

    expect(result.status).toBe("submitted");
    expect(result.simulated).toBe(false);
    expect(result.mode).toBe("arc-testnet");
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const receipt = (await env.chain.request({
      method: "eth_getTransactionReceipt",
      params: [result.txHash],
    })) as { status: string; to: string } | null;
    expect(receipt).not.toBeNull();
    expect(receipt!.status).toBe("0x1");
    expect(receipt!.to.toLowerCase()).toBe(env.deployed.address.toLowerCase());
  });

  it("confirm returns confirmed with a block number once the event is emitted", async () => {
    const sent = await env.adapter.transferUSDC(settleRequest());

    const confirmed = await env.adapter.confirm(sent.txHash);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.simulated).toBe(false);
    expect(confirmed.txHash).toBe(sent.txHash);
    expect(confirmed.failureCode).toBeUndefined();
    expect(typeof confirmed.blockNumber).toBe("number");
    expect(confirmed.blockNumber).toBeGreaterThan(0);

    const receipt = (await env.chain.request({
      method: "eth_getTransactionReceipt",
      params: [sent.txHash],
    })) as { blockNumber: string };
    expect(confirmed.blockNumber).toBe(Number(BigInt(receipt.blockNumber)));
  });

  it("24500 cents settle exactly 245 USDC in wei (cents times 1e16)", async () => {
    const result = await env.adapter.transferUSDC(settleRequest({ amountCents: 24500n }));
    expect(result.status).toBe("submitted");

    expect(await supplierBalance(env)).toBe(245n * ONE_USDC_WEI);
  });

  it("an over-limit settlement is rejected before sending with DailyLimitExceeded and the supplier is not paid", async () => {
    await ownerWrite(env, "setDailyLimit", [ONE_USDC_WEI]);

    const error = await rejectionOf(env.adapter.transferUSDC(settleRequest({ amountCents: 24500n })));
    expect(error).toBeInstanceOf(SettlementRejectedError);
    expect(error.code).toBe("DailyLimitExceeded");
    expect(error.args).toEqual([245n * ONE_USDC_WEI, ONE_USDC_WEI]);

    expect(await supplierBalance(env)).toBe(0n);
    expect(await settlementLogs(env)).toHaveLength(0);
  });

  it("an unwhitelisted vendor is rejected with VendorNotWhitelisted", async () => {
    await ownerWrite(env, "setEnforceVendorWhitelist", [true]);

    const error = await rejectionOf(env.adapter.transferUSDC(settleRequest()));
    expect(error).toBeInstanceOf(SettlementRejectedError);
    expect(error.code).toBe("VendorNotWhitelisted");
    expect(String(error.args?.[0]).toLowerCase()).toBe(SUPPLIER.toLowerCase());

    expect(await supplierBalance(env)).toBe(0n);
    expect(await settlementLogs(env)).toHaveLength(0);
  });

  it("an already settled order id is recognised and not paid twice", async () => {
    const first = await env.adapter.transferUSDC(settleRequest());
    const second = await env.adapter.transferUSDC(settleRequest());

    expect(second.txHash).toBe(first.txHash);
    expect(second.status).toBe("submitted");
    expect(await supplierBalance(env)).toBe(SETTLED_WEI);
    expect(await settlementLogs(env)).toHaveLength(1);
  });

  it("an unknown outcome stays submitted when the RPC fails during confirm", async () => {
    const flakyTransport = custom({
      request: (args: { method: string; params?: unknown[] }) =>
        args.method === "eth_getTransactionReceipt"
          ? Promise.reject(new Error("rpc down"))
          : env.chain.request(args),
    } as any);
    const flaky = makeAdapter(env.chain, env.deployed.address, { transport: flakyTransport });

    const sent = await flaky.transferUSDC(settleRequest());
    const result = await flaky.confirm(sent.txHash);

    expect(result.status).toBe("submitted");
    expect(result.txHash).toBe(sent.txHash);
    expect(result.blockNumber).toBeUndefined();
    expect(result.failureCode).toBeUndefined();
  });

  it("a reverted transaction is reported failed", async () => {
    await env.adapter.transferUSDC(settleRequest());

    // Sent straight through viem with an explicit gas limit, so it is mined and reverts (OrderAlreadySettled).
    const revertedHash = await env.deployed.walletClient.writeContract({
      address: env.deployed.address,
      abi: env.deployed.abi,
      functionName: "settleOrder",
      args: [ORDER_ID32, SUPPLIER, MATCH_HASH],
      value: SETTLED_WEI,
      gas: 300_000n,
    });

    const result = await env.adapter.confirm(revertedHash);
    expect(result.status).toBe("failed");
    expect(result.failureCode).toBe("REVERTED");
    expect(result.txHash).toBe(revertedHash);

    // The first settlement is the only payment.
    expect(await supplierBalance(env)).toBe(SETTLED_WEI);
  });

  it("a chain id mismatch is refused", async () => {
    const wrongChain = makeAdapter(env.chain, env.deployed.address, { chainId: 5042002 });

    const error = await rejectionOf(wrongChain.transferUSDC(settleRequest()));
    expect(error).toBeInstanceOf(SettlementChainMismatchError);
    expect(error.expected).toBe(5042002);
    expect(error.actual).toBe(CHAIN_ID);

    expect(await settlementLogs(env)).toHaveLength(0);
  });

  it("a missing signer or contract address throws SettlementNotConfiguredError naming the variables and no key value appears in the message", async () => {
    const noSigner = makeAdapter(env.chain, env.deployed.address, { signerPrivateKey: undefined });
    const signerError = await rejectionOf(noSigner.transferUSDC(settleRequest()));
    expect(signerError).toBeInstanceOf(SettlementNotConfiguredError);
    expect(signerError.message).toContain("ARC_SIGNER_PRIVATE_KEY");
    expect(signerError.message).not.toContain(SIGNER_KEY);
    expect(signerError.message).not.toContain("11".repeat(32));

    const noContract = makeAdapter(env.chain, undefined);
    const contractError = await rejectionOf(noContract.transferUSDC(settleRequest()));
    expect(contractError).toBeInstanceOf(SettlementNotConfiguredError);
    expect(contractError.message).toContain("BIND_SETTLEMENT_ADDRESS");
    expect(contractError.message).not.toContain(SIGNER_KEY);
    expect(contractError.message).not.toContain("11".repeat(32));

    expect(await settlementLogs(env)).toHaveLength(0);
  });

  it("a payer that is not the signer is refused", async () => {
    const error = await rejectionOf(env.adapter.transferUSDC(settleRequest({ fromAddress: SUPPLIER })));
    expect(error).toBeInstanceOf(SettlementPayerMismatchError);

    expect(await supplierBalance(env)).toBe(0n);
    expect(await settlementLogs(env)).toHaveLength(0);
  });

  it("no hash begins with 0xarc_ and no explorer link is built for a local chain id", async () => {
    const sent = await env.adapter.transferUSDC(settleRequest());
    expect(sent.txHash.startsWith("0xarc_")).toBe(false);
    expect(sent.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent.explorerUrl).toBeUndefined();

    const confirmed = await env.adapter.confirm(sent.txHash);
    expect(confirmed.explorerUrl).toBeUndefined();
  });

  it("escrow methods throw SettlementNotSupportedError", async () => {
    const depositError = await rejectionOf(env.adapter.depositEscrow(settleRequest(), "ms_1"));
    expect(depositError).toBeInstanceOf(SettlementNotSupportedError);

    const releaseError = await rejectionOf(env.adapter.releaseEscrow("ms_1", SUPPLIER));
    expect(releaseError).toBeInstanceOf(SettlementNotSupportedError);
  });

  it("transport failures never expose the RPC URL or token", async () => {
    const RPC_URL = "https://rpc.example.test/v1/SECRETTOKEN-123";
    const failure = "request to https://rpc.example.test/v1/SECRETTOKEN-123 failed";
    const cases = [
      { method: "eth_chainId", operation: "chain id check", settledFirst: false },
      { method: "eth_call", operation: "pre-flight call", settledFirst: false },
      { method: "eth_sendRawTransaction", operation: "settleOrder send", settledFirst: false },
      { method: "eth_getLogs", operation: "settlement lookup", settledFirst: true },
    ];
    for (const c of cases) {
      // A fresh chain per case. For eth_getLogs, an earlier settlement must succeed so the lookup is reached.
      const local = await setup();
      if (c.settledFirst) await local.adapter.transferUSDC(settleRequest());
      const flaky = new ArcL1SettlementAdapter({
        chainId: CHAIN_ID,
        contractAddress: local.deployed.address,
        signerPrivateKey: SIGNER_KEY,
        rpcUrl: RPC_URL,
        transport: custom({
          request: (args: { method: string; params?: unknown[] }) =>
            args.method === c.method ? Promise.reject(new Error(failure)) : local.chain.request(args),
        } as any),
        confirmWaitMs: 0,
      });

      const error = await rejectionOf(flaky.transferUSDC(settleRequest()));
      expect(error, c.method).toBeInstanceOf(SettlementTransportError);
      expect(error.operation, c.method).toBe(c.operation);
      expect(error.message, c.method).not.toContain("SECRETTOKEN-123");
      expect(error.message, c.method).not.toContain("https://");
      expect(error.cause, c.method).toBeUndefined();
      const json = JSON.stringify(error);
      expect(json, c.method).not.toContain("SECRETTOKEN-123");
      expect(json, c.method).not.toContain("https://");
    }
  });

  it("the adapter does not expose the signer key through JSON.stringify or util.inspect", async () => {
    // A transfer builds the signer and the wallet client, which are the objects that hold the key.
    await env.adapter.transferUSDC(settleRequest());
    const json = JSON.stringify(env.adapter);
    const shown = inspect(env.adapter, { showHidden: true, depth: 6 });
    for (const text of [json, shown]) {
      expect(text).not.toContain(SIGNER_KEY);
      expect(text).not.toContain("11".repeat(32));
    }
  });

  it("settlement recovery scans from the configured deploy block", async () => {
    const first = await env.adapter.transferUSDC(settleRequest());
    const settledBlock = env.chain.blockNumber();

    // Control: a scan from block 0 finds the earlier settlement.
    const control = makeAdapter(env.chain, env.deployed.address, { deployBlock: 0n });
    expect((await control.transferUSDC(settleRequest())).txHash).toBe(first.txHash);

    // A scan that starts after the settlement block cannot see it, so the duplicate is refused.
    const late = makeAdapter(env.chain, env.deployed.address, { deployBlock: settledBlock + 1n });
    const error = await rejectionOf(late.transferUSDC(settleRequest()));
    expect(error).toBeInstanceOf(SettlementRejectedError);
    expect(error.code).toBe("OrderAlreadySettled");
  });
});
