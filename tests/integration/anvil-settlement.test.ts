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
import { deployBindSettlementOn, loadArtifact, viemClientsOn } from "../helpers/bind-settlement.js";
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

/**
 * [arc-anvil] Arc protocol differences. These run only on a node in Arc mode (latest base fee at least 20 gwei), which is
 * `arc-anvil --network arc --chain-id 31337`. Plain Anvil starts at 1 gwei and is a standard EVM, so on it this block is
 * reported NOT RUN, never passed. With ANVIL_EXPECT_ARC=1 (set by scripts/verify-local.sh for arc-anvil) the block runs
 * regardless, and its first test fails on a node that is not in Arc mode. See docs/decisions/0088.
 */
const ARC_MIN_BASE_FEE_WEI = 20n * 10n ** 9n;
const GWEI = 10n ** 9n;
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";
// The system emitter of Arc's native-value transfers. Its Transfer logs are not emitted by BindSettlement.
const SYSTEM_EMITTER: Address = "0xfffffffffffffffffffffffffffffffffffffffe";
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TRANSFER_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;
const EXPECT_ARC = process.env.ANVIL_EXPECT_ARC === "1";

interface ArcProbe {
  arc: boolean;
  baseFeeWei?: bigint;
  reason?: string;
}

async function probeArcMode(rpc: string): Promise<ArcProbe> {
  try {
    const block = await createPublicClient({ transport: http(rpc) }).getBlock({ blockTag: "latest" });
    if (block.baseFeePerGas === null || block.baseFeePerGas === undefined) {
      return { arc: false, reason: "the latest block has no baseFeePerGas" };
    }
    return { arc: block.baseFeePerGas >= ARC_MIN_BASE_FEE_WEI, baseFeeWei: block.baseFeePerGas };
  } catch (error) {
    return { arc: false, reason: `the node did not answer eth_getBlockByNumber: ${(error as Error).message.split("\n")[0]}` };
  }
}

const arcProbe: ArcProbe = ANVIL_RPC_URL ? await probeArcMode(ANVIL_RPC_URL) : { arc: false, reason: "ANVIL_RPC_URL is not set" };
const RUN_ARC = Boolean(ANVIL_RPC_URL) && (arcProbe.arc || EXPECT_ARC);

if (!RUN_ARC) {
  const reason =
    arcProbe.reason ??
    `the node at ${ANVIL_RPC_URL} has base fee ${arcProbe.baseFeeWei} wei, below 20 gwei, so it is not in Arc mode`;
  process.stdout.write(
    `NOT RUN [arc-anvil]: ${reason}. The Arc protocol difference tests were NOT RUN; they are not passed. ` +
      "Start `arc-anvil --network arc --chain-id 31337` and set ANVIL_RPC_URL to run them.\n"
  );
}

/** The error text of a viem or RPC error, including its cause chain. The node's reason can sit in any of these fields. */
function errorTextOf(error: unknown): string {
  const parts: string[] = [];
  let node: any = error;
  for (let depth = 0; node && depth < 10; depth++) {
    for (const key of ["shortMessage", "message", "details"]) {
      if (typeof node[key] === "string") parts.push(node[key]);
    }
    node = node.cause;
  }
  return parts.join("\n");
}

function requiredRpc(): string {
  if (!ANVIL_RPC_URL) throw new Error("ANVIL_RPC_URL is not set");
  return ANVIL_RPC_URL;
}

/** Owner clients on the node without a fresh contract, for the tests that only send native value. */
function ownerClients() {
  return viemClientsOn({ chainId: ANVIL_CHAIN_ID, transport: http(requiredRpc()), pollingInterval: 100 }, ownerKey());
}

describe.skipIf(!RUN_ARC)("[arc-anvil] Arc protocol differences", () => {
  it("[arc-anvil] the node is in Arc mode: the latest base fee is at least 20 gwei", async () => {
    const block = await createPublicClient({ transport: http(requiredRpc()) }).getBlock({ blockTag: "latest" });
    expect(block.baseFeePerGas, "the latest block carries a base fee").not.toBeNull();
    expect(
      block.baseFeePerGas! >= ARC_MIN_BASE_FEE_WEI,
      `base fee ${block.baseFeePerGas} wei is below 20 gwei: the node is not in Arc mode`
    ).toBe(true);
  }, TEST_TIMEOUT);

  it("[arc-anvil] a transaction whose maxFeePerGas is below the base fee is rejected by the node", async () => {
    const clients = ownerClients();
    // Explicit gas skips estimation, so the only check the node makes before it refuses is the fee check.
    const error = await rejectionOf(
      clients.walletClient.sendTransaction({ to: SUPPLIER, value: 1n, gas: 21_000n, maxFeePerGas: GWEI, maxPriorityFeePerGas: 0n })
    );
    expect(errorTextOf(error)).toMatch(/max fee per gas less than block base fee/i);
  }, TEST_TIMEOUT);

  it("[arc-anvil] a native value send to the zero address reverts with 'Zero address not allowed' and moves no value", async () => {
    const clients = ownerClients();
    const error = await rejectionOf(
      clients.publicClient.call({ account: clients.account.address, to: ZERO_ADDRESS, value: 1n })
    );
    expect(errorTextOf(error)).toContain("Zero address not allowed");

    // With an explicit gas limit nothing is estimated first, so the transaction is mined and its receipt says reverted.
    const zeroBefore = await clients.publicClient.getBalance({ address: ZERO_ADDRESS });
    const hash = await clients.walletClient.sendTransaction({ to: ZERO_ADDRESS, value: 1n, gas: 21_000n });
    const receipt = await clients.publicClient.waitForTransactionReceipt({ hash, timeout: 15_000 });
    expect(receipt.status).toBe("reverted");
    expect(await clients.publicClient.getBalance({ address: ZERO_ADDRESS })).toBe(zeroBefore);
  }, TEST_TIMEOUT);

  it("[arc-anvil] a native value send emits exactly one Transfer log from the system emitter, with from, to and an 18-decimal value", async () => {
    const clients = ownerClients();
    const hash = await clients.walletClient.sendTransaction({ to: SUPPLIER, value: ONE_USDC_WEI });
    const receipt = await clients.publicClient.waitForTransactionReceipt({ hash, timeout: 15_000 });
    expect(receipt.status).toBe("success");

    expect(receipt.logs).toHaveLength(1);
    const log = receipt.logs[0];
    expect(log.address.toLowerCase()).toBe(SYSTEM_EMITTER);
    expect(log.topics[0]).toBe(ERC20_TRANSFER_TOPIC);

    const decoded = parseEventLogs({ abi: TRANSFER_EVENT_ABI, logs: receipt.logs, eventName: "Transfer" }) as unknown as {
      args: Record<string, unknown>;
    }[];
    expect(decoded).toHaveLength(1);
    expect(decoded[0].args.from).toBe(clients.account.address);
    expect(decoded[0].args.to).toBe(SUPPLIER);
    expect(decoded[0].args.value).toBe(ONE_USDC_WEI); // 1 USDC = 10^18 native units
  }, TEST_TIMEOUT);

  it("[arc-anvil] a settlement through the Arc adapter: system-emitter Transfer logs beside exactly one SettlementExecuted, which confirm and findTransfer use", async () => {
    const ctx = await freshDeployment();
    const sent = await ctx.adapter.transferUSDC(settleRequest());
    expect(sent.status).toBe("submitted");

    const receipt = await mined(ctx, sent.txHash as Hex);
    expect(receipt.status).toBe("success");

    const systemLogs = receipt.logs.filter((log) => log.address.toLowerCase() === SYSTEM_EMITTER);
    expect(systemLogs.length, "the native value moves emit system-emitter logs").toBeGreaterThan(0);
    expect(systemLogs.every((log) => log.topics[0] === ERC20_TRANSFER_TOPIC)).toBe(true);

    const contractLogs = receipt.logs.filter((log) => log.address.toLowerCase() === ctx.deployed.address.toLowerCase());
    const executedFromContract = parseEventLogs({ abi: ctx.deployed.abi, logs: contractLogs, eventName: "SettlementExecuted" });
    const executedAnywhere = parseEventLogs({ abi: ctx.deployed.abi, logs: receipt.logs, eventName: "SettlementExecuted" });
    expect(executedFromContract).toHaveLength(1);
    expect(executedAnywhere).toHaveLength(1);

    // confirm must count only the contract's SettlementExecuted, so the system-emitter logs beside it do not matter.
    const confirmed = await ctx.adapter.confirm(sent.txHash);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.txHash).toBe(sent.txHash);
    expect(confirmed.blockNumber).toBe(Number(receipt.blockNumber));

    const found = await ctx.adapter.findTransfer({ orderId: ORDER_ID });
    expect(found?.status).toBe("confirmed");
    expect(found?.txHash).toBe(sent.txHash);
  }, TEST_TIMEOUT);

  it("[arc-anvil] a settlement to the zero-address supplier is refused by the adapter with no chain effect", async () => {
    const ctx = await freshDeployment();
    const client = ctx.deployed.publicClient;
    const ownerBefore = await client.getBalance({ address: ownerAddress() });
    const nonceBefore = await client.getTransactionCount({ address: ownerAddress() });
    const zeroBefore = await client.getBalance({ address: ZERO_ADDRESS });

    // The contract reverts Unauthorized for a zero supplier. The adapter's pre-flight call sees that revert and refuses
    // before any send, so this should be a SettlementRejectedError carrying the decoded name.
    const error = await rejectionOf(ctx.adapter.transferUSDC(settleRequest({ toAddress: ZERO_ADDRESS })));
    expect(error).toBeInstanceOf(SettlementRejectedError);
    expect(error.code).toBe("Unauthorized");

    expect(await settlementLogs(ctx)).toHaveLength(0);
    expect(await client.getTransactionCount({ address: ownerAddress() })).toBe(nonceBefore);
    expect(await client.getBalance({ address: ownerAddress() })).toBe(ownerBefore);
    expect(await client.getBalance({ address: ZERO_ADDRESS })).toBe(zeroBefore);
  }, TEST_TIMEOUT);
});
