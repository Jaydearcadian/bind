import { describe, it, expect, beforeEach } from "vitest";
import {
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  http,
  keccak256,
  parseEventLogs,
  toHex,
  type AbiEvent,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployBindSettlementOn, loadArtifact } from "../helpers/bind-settlement.js";
import { ArcL1SettlementAdapter } from "../../src/adapters/settlement/arc-l1.js";
import { SettlementChainMismatchError, SettlementRejectedError } from "../../src/adapters/settlement/errors.js";
import type { TransferRequest, TransferResult } from "../../src/adapters/settlement/types.js";

/**
 * [anvil] BindSettlement and the Arc settlement adapter against a REAL Anvil node.
 *
 * NOT_RUN in the environment that wrote this file: Anvil and Foundry are not installed there (docs/decisions/0038).
 * It runs only when ANVIL_RPC_URL names a running node started with `anvil --chain-id 31337`. The Anvil run in
 * scripts/verify-local.sh and the quality-gates workflow start that node and set the variable.
 *
 * It deploys the committed artifact (contracts/artifacts/BindSettlement.json) over JSON-RPC, using the same viem
 * clients and the same adapter as the application. The in-process EVM (tests/helpers/local-chain.ts) is not used here.
 * The scenarios follow tests/integration/arc-settlement-evm.test.ts, which is the specification of expected behaviour.
 *
 * Keys: the default signer is the public Anvil development account 1, which Anvil funds at start. It holds no value
 * outside a local node. ANVIL_OWNER_KEY overrides it. The suite fails when the signer has no balance on the node.
 */

const ANVIL_RPC_URL = process.env.ANVIL_RPC_URL;
const ANVIL_CHAIN_ID = 31337;
const DEFAULT_OWNER_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
// Public Anvil development account 2, used only as a payment recipient. It signs nothing in this suite.
const SUPPLIER: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ONE_USDC_WEI = 10n ** 18n; // native USDC on Arc uses 18 decimals
const SETTLED_WEI = 24500n * 10n ** 16n; // 24500 cents = 245.00 USDC
const MATCH_HASH = keccak256(toHex("po|receipt|bill"));
const ORDER_ID = "ord_1";
const ORDER_ID32 = keccak256(toHex(ORDER_ID));
const TEST_TIMEOUT = 60_000;

if (!ANVIL_RPC_URL) {
  process.stdout.write(
    "SKIPPED [anvil]: ANVIL_RPC_URL is not set, so the Anvil settlement suite did not run (NOT_RUN). " +
      "Start Anvil with `anvil --chain-id 31337`, set ANVIL_RPC_URL to its URL, and run this file again. " +
      "The in-process suites do not replace this run.\n"
  );
}

function ownerKey(): Hex {
  return (process.env.ANVIL_OWNER_KEY || DEFAULT_OWNER_KEY) as Hex;
}

function ownerAddress(): Address {
  return privateKeyToAccount(ownerKey()).address;
}

type Deployed = Awaited<ReturnType<typeof deployBindSettlementOn>>;

interface Ctx {
  rpc: string;
  deployed: Deployed;
  adapter: ArcL1SettlementAdapter;
}

/** Walks the error cause chain for the hex revert data an RPC error carries for a custom error. */
function revertDataOf(error: unknown): Hex | undefined {
  let node: any = error;
  for (let depth = 0; node && depth < 10; depth++) {
    if (typeof node.data === "string" && node.data.startsWith("0x")) return node.data as Hex;
    node = node.cause;
  }
  return undefined;
}

function adapterFor(rpc: string, contract: Address, chainId = ANVIL_CHAIN_ID): ArcL1SettlementAdapter {
  return new ArcL1SettlementAdapter({
    rpcUrl: rpc,
    chainId,
    contractAddress: contract,
    signerPrivateKey: ownerKey(),
    transport: http(rpc),
    confirmWaitMs: 5000,
  });
}

/** A fresh contract on the node, so each test starts with zero limits, no whitelist and no settled orders. */
async function freshDeployment(): Promise<Ctx> {
  const rpc = ANVIL_RPC_URL;
  if (!rpc) throw new Error("ANVIL_RPC_URL is not set");
  const transport = http(rpc);
  const probe = createPublicClient({ transport });
  const chainId = await probe.getChainId();
  if (chainId !== ANVIL_CHAIN_ID) {
    throw new Error(`ANVIL_RPC_URL answers chain ${chainId}; expected ${ANVIL_CHAIN_ID}. Start Anvil with --chain-id 31337.`);
  }
  const balance = await probe.getBalance({ address: ownerAddress() });
  if (balance === 0n) {
    throw new Error(`signer ${ownerAddress()} has no balance on this node. Set ANVIL_OWNER_KEY to a funded Anvil key.`);
  }
  const deployed = await deployBindSettlementOn({ chainId, transport, pollingInterval: 100 }, ownerKey());
  return { rpc, deployed, adapter: adapterFor(rpc, deployed.address) };
}

/**
 * Waits until the node has mined the transaction and returns its receipt. The adapter's transferUSDC returns as soon as the
 * transaction is submitted, so any test that reads chain state about that transaction must wait here first. Bounded, so a
 * transaction that never mines fails the test instead of hanging it.
 */
async function mined(ctx: Ctx, hash: Hex): Promise<TransactionReceipt> {
  return ctx.deployed.publicClient.waitForTransactionReceipt({ hash, timeout: 15_000 });
}

async function ownerWrite(ctx: Ctx, functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
  const hash = await ctx.deployed.walletClient.writeContract({
    address: ctx.deployed.address,
    abi: ctx.deployed.abi,
    functionName: functionName as never,
    args: args as never,
    gas: 300_000n,
  });
  return ctx.deployed.publicClient.waitForTransactionReceipt({ hash });
}

async function settle(ctx: Ctx, orderId32: Hex, supplier: Address, value: bigint): Promise<TransactionReceipt> {
  const hash = await ctx.deployed.walletClient.writeContract({
    address: ctx.deployed.address,
    abi: ctx.deployed.abi,
    functionName: "settleOrder",
    args: [orderId32, supplier, MATCH_HASH],
    value,
    gas: 300_000n,
  });
  return ctx.deployed.publicClient.waitForTransactionReceipt({ hash });
}

/** Simulates settleOrder with eth_call on the node and returns the decoded custom error it reverted with. */
async function settleRevert(ctx: Ctx, orderId32: Hex, supplier: Address, value: bigint) {
  const data = encodeFunctionData({
    abi: ctx.deployed.abi,
    functionName: "settleOrder",
    args: [orderId32, supplier, MATCH_HASH],
  });
  try {
    await ctx.deployed.publicClient.call({ account: ownerAddress(), to: ctx.deployed.address, data, value });
  } catch (error) {
    const revert = revertDataOf(error);
    if (!revert) throw new Error(`no revert data from the node: ${(error as Error).message.split("\n")[0]}`);
    return decodeErrorResult({ abi: ctx.deployed.abi, data: revert });
  }
  throw new Error("expected settleOrder to revert on the node");
}

async function rejectionOf(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to reject, but it resolved");
}

function settlementLogs(ctx: Ctx) {
  const event = ctx.deployed.abi.find((item) => item.type === "event" && item.name === "SettlementExecuted") as AbiEvent;
  return ctx.deployed.publicClient.getLogs({ address: ctx.deployed.address, event, fromBlock: 0n });
}

async function supplierBalance(ctx: Ctx): Promise<bigint> {
  return ctx.deployed.publicClient.getBalance({ address: SUPPLIER });
}

function settleRequest(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    fromAddress: ownerAddress(),
    toAddress: SUPPLIER,
    amountCents: 24500n,
    currency: "USDC",
    orderId: ORDER_ID,
    idempotencyKey: "idem_pay_ord_1",
    matchHash: MATCH_HASH,
    ...overrides,
  };
}

describe.skipIf(!ANVIL_RPC_URL)("[anvil] BindSettlement and the Arc adapter on a real Anvil node", () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await freshDeployment();
  }, TEST_TIMEOUT);

  it("[anvil] deploys the committed artifact and reads its initial configuration", async () => {
    const code = await ctx.deployed.publicClient.getCode({ address: ctx.deployed.address });
    expect(code).toBeDefined();
    expect(code!.length).toBeGreaterThan(2);

    // BindSettlement has no constructor arguments and no immutables, so the deployed runtime code is the tail of the
    // creation bytecode the artifact carries. A mismatch means the node runs different code from the artifact.
    const artifact = loadArtifact();
    expect(artifact.bytecode.toLowerCase().endsWith(code!.slice(2).toLowerCase())).toBe(true);

    const read = (functionName: string) =>
      ctx.deployed.publicClient.readContract({ address: ctx.deployed.address, abi: ctx.deployed.abi, functionName: functionName as never });
    expect(await read("owner")).toBe(ownerAddress());
    expect(await read("dailySpendLimit")).toBe(0n);
    expect(await read("dailySpent")).toBe(0n);
    expect(await read("enforceVendorWhitelist")).toBe(false);
  }, TEST_TIMEOUT);

  it("[anvil] settleOrder pays the supplier the exact value and emits SettlementExecuted", async () => {
    const before = await supplierBalance(ctx);
    const receipt = await settle(ctx, ORDER_ID32, SUPPLIER, SETTLED_WEI);

    expect(receipt.status).toBe("success");
    expect((await supplierBalance(ctx)) - before).toBe(SETTLED_WEI);

    const events = parseEventLogs({
      abi: ctx.deployed.abi,
      logs: receipt.logs,
      eventName: "SettlementExecuted",
    }) as unknown as { args: Record<string, unknown> }[];
    expect(events.length).toBe(1);
    expect(events[0].args.orderId).toBe(ORDER_ID32);
    expect(events[0].args.payer).toBe(ownerAddress());
    expect(events[0].args.supplier).toBe(SUPPLIER);
    expect(events[0].args.amount).toBe(SETTLED_WEI);
    expect(events[0].args.matchHash).toBe(MATCH_HASH);
  }, TEST_TIMEOUT);

  it("[anvil] a repeated order id reverts with OrderAlreadySettled and pays nothing again", async () => {
    const before = await supplierBalance(ctx);
    expect((await settle(ctx, ORDER_ID32, SUPPLIER, SETTLED_WEI)).status).toBe("success");

    const err = await settleRevert(ctx, ORDER_ID32, SUPPLIER, SETTLED_WEI);
    expect(err.errorName).toBe("OrderAlreadySettled");
    expect(err.args ?? []).toEqual([]);
    expect((await supplierBalance(ctx)) - before).toBe(SETTLED_WEI);
    expect(await settlementLogs(ctx)).toHaveLength(1);
  }, TEST_TIMEOUT);

  it("[anvil] an over-limit settlement reverts with DailyLimitExceeded carrying attempted and limit", async () => {
    expect((await ownerWrite(ctx, "setDailyLimit", [ONE_USDC_WEI])).status).toBe("success");
    expect(
      await ctx.deployed.publicClient.readContract({
        address: ctx.deployed.address,
        abi: ctx.deployed.abi,
        functionName: "dailySpendLimit",
      })
    ).toBe(ONE_USDC_WEI);

    const before = await supplierBalance(ctx);
    const attempted = 2n * ONE_USDC_WEI;
    const err = await settleRevert(ctx, keccak256(toHex("ord_2")), SUPPLIER, attempted);
    expect(err.errorName).toBe("DailyLimitExceeded");
    expect(err.args).toEqual([attempted, ONE_USDC_WEI]);
    expect(await supplierBalance(ctx)).toBe(before);
  }, TEST_TIMEOUT);

  it("[anvil] an unwhitelisted vendor reverts with VendorNotWhitelisted, and whitelisting lets the same order through", async () => {
    expect((await ownerWrite(ctx, "setEnforceVendorWhitelist", [true])).status).toBe("success");

    const orderId32 = keccak256(toHex("ord_3"));
    const err = await settleRevert(ctx, orderId32, SUPPLIER, 10n ** 16n);
    expect(err.errorName).toBe("VendorNotWhitelisted");
    expect(String(err.args?.[0]).toLowerCase()).toBe(SUPPLIER.toLowerCase());

    expect((await ownerWrite(ctx, "setVendorStatus", [SUPPLIER, true])).status).toBe("success");
    expect((await settle(ctx, orderId32, SUPPLIER, 10n ** 16n)).status).toBe("success");
  }, TEST_TIMEOUT);

  it("[anvil] the adapter submits a settlement and confirm returns confirmed with the hash the node mined", async () => {
    const before = await supplierBalance(ctx);
    const sent: TransferResult = await ctx.adapter.transferUSDC(settleRequest());

    expect(sent.status).toBe("submitted");
    expect(sent.simulated).toBe(false);
    expect(sent.mode).toBe("arc-testnet");
    expect(sent.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(sent.explorerUrl).toBeUndefined(); // explorer links are for Arc Testnet (5042002) only

    const receipt = await mined(ctx, sent.txHash as Hex);
    expect(receipt.status).toBe("success");
    expect(receipt.to?.toLowerCase()).toBe(ctx.deployed.address.toLowerCase());
    expect((await supplierBalance(ctx)) - before).toBe(SETTLED_WEI);

    const confirmed = await ctx.adapter.confirm(sent.txHash);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.txHash).toBe(sent.txHash);
    expect(confirmed.failureCode).toBeUndefined();
    expect(confirmed.blockNumber).toBe(Number(receipt.blockNumber));
  }, TEST_TIMEOUT);

  it("[anvil] findTransfer returns the confirmed settlement for an order id and null for an order that was never paid", async () => {
    const sent = await ctx.adapter.transferUSDC(settleRequest());
    // findTransfer reads mined logs only, so the settlement must be mined before it is looked up.
    await mined(ctx, sent.txHash as Hex);

    const found = await ctx.adapter.findTransfer({ orderId: ORDER_ID });
    expect(found?.status).toBe("confirmed");
    expect(found?.txHash).toBe(sent.txHash);
    expect(found?.blockNumber).toBeGreaterThan(0);

    expect(await ctx.adapter.findTransfer({ orderId: "ord_never_paid" })).toBeNull();
  }, TEST_TIMEOUT);

  it("[anvil] a second transfer for the same order returns the earlier hash and pays the supplier once", async () => {
    const before = await supplierBalance(ctx);
    const first = await ctx.adapter.transferUSDC(settleRequest());
    const second = await ctx.adapter.transferUSDC(settleRequest());

    expect(second.txHash).toBe(first.txHash);
    expect(second.status).toBe("submitted");
    // Balance and logs are read only once the single settlement is mined.
    await mined(ctx, first.txHash as Hex);
    expect((await supplierBalance(ctx)) - before).toBe(SETTLED_WEI);
    expect(await settlementLogs(ctx)).toHaveLength(1);
  }, TEST_TIMEOUT);

  it("[anvil] an over-limit transfer through the adapter is rejected before anything is sent", async () => {
    expect((await ownerWrite(ctx, "setDailyLimit", [ONE_USDC_WEI])).status).toBe("success");

    const before = await supplierBalance(ctx);
    const error = await rejectionOf(ctx.adapter.transferUSDC(settleRequest()));
    expect(error).toBeInstanceOf(SettlementRejectedError);
    expect(error.code).toBe("DailyLimitExceeded");
    expect(error.args).toEqual([SETTLED_WEI, ONE_USDC_WEI]);

    expect(await supplierBalance(ctx)).toBe(before);
    expect(await settlementLogs(ctx)).toHaveLength(0);
  }, TEST_TIMEOUT);

  it("[anvil] a chain id that does not match the node is refused before anything is sent", async () => {
    const wrongChain = adapterFor(ctx.rpc, ctx.deployed.address, 5042002);

    const error = await rejectionOf(wrongChain.transferUSDC(settleRequest()));
    expect(error).toBeInstanceOf(SettlementChainMismatchError);
    expect(error.expected).toBe(5042002);
    expect(error.actual).toBe(ANVIL_CHAIN_ID);
    expect(await settlementLogs(ctx)).toHaveLength(0);
  }, TEST_TIMEOUT);
});
