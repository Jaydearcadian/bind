import { describe, it, expect, beforeEach } from "vitest";
import {
  decodeErrorResult,
  encodeFunctionData,
  keccak256,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createLocalChain, type LocalChain } from "../helpers/local-chain.js";
import { deployBindSettlement } from "../helpers/bind-settlement.js";

/**
 * Client/contract integration against the real compiled BindSettlement bytecode, executed by an
 * in-process EthereumJS EVM (not Anvil). Every test gets a fresh chain and a fresh deployment.
 */
const OWNER_KEY: Hex = `0x${"11".repeat(32)}`;
const SUPPLIER_KEY: Hex = `0x${"22".repeat(32)}`;
const ONE_USDC = 10n ** 18n; // native USDC uses 18 decimals on Arc
const MATCH_HASH = keccak256(toHex("po|receipt|bill"));

type Deployed = Awaited<ReturnType<typeof deployBindSettlement>>;

interface Ctx extends Deployed {
  chain: LocalChain;
  supplier: Address;
}

async function setup(): Promise<Ctx> {
  const owner = privateKeyToAccount(OWNER_KEY);
  const chain = await createLocalChain({ balances: { [owner.address]: 1000n * ONE_USDC } });
  const deployed = await deployBindSettlement(chain, OWNER_KEY);
  return { ...deployed, chain, supplier: privateKeyToAccount(SUPPLIER_KEY).address };
}

/** Sends a settleOrder call with eth_call and returns the decoded custom error it reverted with. */
async function settleRevert(ctx: Ctx, args: readonly unknown[], value: bigint) {
  const data = encodeFunctionData({ abi: ctx.abi, functionName: "settleOrder", args: args as never });
  try {
    await ctx.publicClient.call({ account: ctx.account, to: ctx.address, data, value });
  } catch (error) {
    let node: any = error;
    while (node) {
      if (typeof node.data === "string" && node.data.startsWith("0x")) {
        return decodeErrorResult({ abi: ctx.abi, data: node.data as Hex });
      }
      node = node.cause;
    }
    throw new Error(`no revert data in error: ${(error as Error).message.split("\n")[0]}`);
  }
  throw new Error("expected settleOrder to revert");
}

async function ownerWrite(ctx: Ctx, functionName: string, args: readonly unknown[]) {
  const hash = await ctx.walletClient.writeContract({
    address: ctx.address,
    abi: ctx.abi,
    functionName: functionName as never,
    args: args as never,
    gas: 300_000n,
  });
  return ctx.publicClient.waitForTransactionReceipt({ hash });
}

async function settle(ctx: Ctx, orderId: Hex, supplier: Address, value: bigint) {
  const hash = await ctx.walletClient.writeContract({
    address: ctx.address,
    abi: ctx.abi,
    functionName: "settleOrder",
    args: [orderId, supplier, MATCH_HASH],
    value,
  });
  return ctx.publicClient.waitForTransactionReceipt({ hash });
}

describe("BindSettlement on the in-process chain", () => {
  let ctx: Ctx;

  beforeEach(async () => {
    ctx = await setup();
  });

  it("deploys the compiled contract", async () => {
    const owner = privateKeyToAccount(OWNER_KEY);
    const code = await ctx.publicClient.getCode({ address: ctx.address });
    expect(code).toBeDefined();
    expect(code!.length).toBeGreaterThan(2);
    expect(await ctx.publicClient.readContract({ address: ctx.address, abi: ctx.abi, functionName: "owner" })).toBe(
      owner.address
    );
    expect(
      await ctx.publicClient.readContract({ address: ctx.address, abi: ctx.abi, functionName: "dailySpendLimit" })
    ).toBe(0n);
  });

  it("settleOrder pays the supplier the exact value and emits SettlementExecuted", async () => {
    const orderId = keccak256(toHex("ord_1"));
    const value = 24500n * 10n ** 16n; // 245.00 USDC
    const receipt = await settle(ctx, orderId, ctx.supplier, value);

    expect(receipt.status).toBe("success");
    expect(await ctx.publicClient.getBalance({ address: ctx.supplier })).toBe(value);

    const events = parseEventLogs({
      abi: ctx.abi,
      logs: receipt.logs,
      eventName: "SettlementExecuted",
    }) as unknown as { args: Record<string, unknown> }[];
    expect(events.length).toBe(1);
    expect(events[0].args.orderId).toBe(orderId);
    expect(events[0].args.payer).toBe(privateKeyToAccount(OWNER_KEY).address);
    expect(events[0].args.supplier).toBe(ctx.supplier);
    expect(events[0].args.amount).toBe(value);
    expect(events[0].args.matchHash).toBe(MATCH_HASH);
  });

  it("a repeated order id reverts with OrderAlreadySettled", async () => {
    const orderId = keccak256(toHex("ord_1"));
    const value = 10n ** 16n;
    expect((await settle(ctx, orderId, ctx.supplier, value)).status).toBe("success");

    const err = await settleRevert(ctx, [orderId, ctx.supplier, MATCH_HASH], value);
    expect(err.errorName).toBe("OrderAlreadySettled");
    expect(err.args ?? []).toEqual([]);
  });

  it("setDailyLimit then an over-limit settlement reverts with DailyLimitExceeded carrying attempted and limit", async () => {
    const limit = ONE_USDC;
    const receipt = await ownerWrite(ctx, "setDailyLimit", [limit]);
    expect(receipt.status).toBe("success");
    expect(await ctx.publicClient.readContract({ address: ctx.address, abi: ctx.abi, functionName: "dailySpendLimit" })).toBe(limit);

    const attempted = 2n * ONE_USDC;
    const err = await settleRevert(ctx, [keccak256(toHex("ord_2")), ctx.supplier, MATCH_HASH], attempted);
    expect(err.errorName).toBe("DailyLimitExceeded");
    expect(err.args).toEqual([attempted, limit]);
  });

  it("an unwhitelisted supplier reverts with VendorNotWhitelisted when enforcement is on", async () => {
    expect((await ownerWrite(ctx, "setEnforceVendorWhitelist", [true])).status).toBe("success");

    const err = await settleRevert(ctx, [keccak256(toHex("ord_3")), ctx.supplier, MATCH_HASH], 10n ** 16n);
    expect(err.errorName).toBe("VendorNotWhitelisted");
    expect((err.args?.[0] as string).toLowerCase()).toBe(ctx.supplier.toLowerCase());

    // Whitelisting the supplier lets the same settlement through.
    expect((await ownerWrite(ctx, "setVendorStatus", [ctx.supplier, true])).status).toBe("success");
    expect((await settle(ctx, keccak256(toHex("ord_3")), ctx.supplier, 10n ** 16n)).status).toBe("success");
  });

  it("the daily window resets after advanceTime(86400 + 1)", async () => {
    expect((await ownerWrite(ctx, "setDailyLimit", [ONE_USDC])).status).toBe("success");
    const spend = (6n * ONE_USDC) / 10n; // 0.6 USDC-units of the 1e18 limit

    expect((await settle(ctx, keccak256(toHex("ord_day_a")), ctx.supplier, spend)).status).toBe("success");

    const over = await settleRevert(ctx, [keccak256(toHex("ord_day_b")), ctx.supplier, MATCH_HASH], spend);
    expect(over.errorName).toBe("DailyLimitExceeded");
    expect(over.args).toEqual([2n * spend, ONE_USDC]);

    ctx.chain.advanceTime(86400 + 1);

    expect((await settle(ctx, keccak256(toHex("ord_day_c")), ctx.supplier, spend)).status).toBe("success");
  });

  it("getLogs filtered by the indexed orderId returns the settlement", async () => {
    const orderId = keccak256(toHex("ord_1"));
    const value = 10n ** 16n;
    expect((await settle(ctx, orderId, ctx.supplier, value)).status).toBe("success");

    const event = ctx.abi.find((item) => item.type === "event" && item.name === "SettlementExecuted") as any;
    const logs = (await ctx.publicClient.getLogs({
      address: ctx.address,
      event,
      args: { orderId },
      fromBlock: 0n,
    })) as unknown as { args: Record<string, unknown> }[];
    expect(logs.length).toBe(1);
    expect(logs[0].args.orderId).toBe(orderId);
    expect(logs[0].args.amount).toBe(value);

    const other = await ctx.publicClient.getLogs({
      address: ctx.address,
      event,
      args: { orderId: keccak256(toHex("ord_unknown")) },
      fromBlock: 0n,
    });
    expect(other.length).toBe(0);
  });

  it("an unsupported RPC method throws code -32601", async () => {
    await expect(ctx.chain.request({ method: "eth_thisMethodDoesNotExist" })).rejects.toMatchObject({ code: -32601 });
  });
});
