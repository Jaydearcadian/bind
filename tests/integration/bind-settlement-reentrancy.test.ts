import { describe, it, expect } from "vitest";
import {
  decodeErrorResult,
  encodeFunctionData,
  keccak256,
  parseEventLogs,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createLocalChain, type LocalChain } from "../helpers/local-chain.js";
import {
  deployBindSettlement,
  deployHelperArtifact,
  loadHelperArtifact,
  viemClients,
  type ViemClients,
} from "../helpers/bind-settlement.js";

/**
 * Reentrancy against the real BindSettlement bytecode, on the in-process EVM (not Anvil, not Forge).
 * The attacker is tests/helpers' compiled contracts/test/helpers/ReentrantSupplier.sol. For each mode it re-enters
 * BindSettlement once from receive() and the test checks both outcomes: the inner call swallowed by the attacker and
 * the inner failure bubbled to the outer call.
 *
 * The keys are local test keys. They sign nothing on any network.
 */
const OWNER_KEY: Hex = `0x${"11".repeat(32)}`;
const P1_KEY: Hex = `0x${"33".repeat(32)}`;
const P2_KEY: Hex = `0x${"44".repeat(32)}`;
const CHAIN_ID = 31337;
const ONE = 10n ** 18n; // native USDC uses 18 decimals on Arc
const MATCH = keccak256(toHex("po|receipt|bill"));
const ORDER = keccak256(toHex("ord_reentry"));
const OTHER_ORDER = keccak256(toHex("ord_other"));
const E0 = keccak256(toHex("escrow_attacker_or_recipient"));
const E1 = keccak256(toHex("escrow_other"));
const E_NEW = keccak256(toHex("escrow_from_inside"));
const RECIPIENT_R = privateKeyToAccount(`0x${"55".repeat(32)}`).address;
const RECIPIENT_R2 = privateKeyToAccount(`0x${"66".repeat(32)}`).address;

const V = 5n * ONE; // the outer payment (settleOrder) or the escrow the outer release pays out
const INNER = 1n * ONE; // the value the attacker sends in its own inner call (other order, deposit)
const D = 2n * ONE; // the attacker-related escrow amount
const X = 3n * ONE; // a second, unrelated open escrow: a double payout would be paid out of it
const FUND = 10n * ONE;

const MODE = {
  SAME_ORDER: 1,
  OTHER_ORDER: 2,
  RELEASE: 3,
  REFUND: 4,
  DEPOSIT: 5,
  RELEASE_AS_RECIPIENT: 6,
} as const;

interface ModeCase {
  name: keyof typeof MODE;
  mode: number;
  /** settle: the outer call is settleOrder paid to the attacker. release: the outer call releases E0 to the attacker. */
  outer: "settle" | "release";
  /** Whether the inner call succeeds on the current contract. */
  innerOk: boolean;
  innerError?: string;
  /** Value the attacker itself pays into BindSettlement during the inner call. */
  attackerPays: bigint;
}

const CASES: ModeCase[] = [
  { name: "SAME_ORDER", mode: MODE.SAME_ORDER, outer: "settle", innerOk: false, innerError: "OrderAlreadySettled", attackerPays: 0n },
  { name: "OTHER_ORDER", mode: MODE.OTHER_ORDER, outer: "settle", innerOk: true, attackerPays: INNER },
  { name: "RELEASE", mode: MODE.RELEASE, outer: "settle", innerOk: true, attackerPays: 0n },
  { name: "REFUND", mode: MODE.REFUND, outer: "settle", innerOk: true, attackerPays: 0n },
  { name: "DEPOSIT", mode: MODE.DEPOSIT, outer: "settle", innerOk: true, attackerPays: INNER },
  {
    name: "RELEASE_AS_RECIPIENT",
    mode: MODE.RELEASE_AS_RECIPIENT,
    outer: "release",
    innerOk: false,
    innerError: "EscrowAlreadySettled",
    attackerPays: 0n,
  },
];

type Deployed = Awaited<ReturnType<typeof deployBindSettlement>>;

interface World {
  chain: LocalChain;
  settlement: Deployed;
  attacker: Address;
  attackerAbi: Abi;
  owner: ViemClients;
  p1: ViemClients;
  p2: ViemClients;
}

async function setupWorld(): Promise<World> {
  const owner = privateKeyToAccount(OWNER_KEY).address;
  const p1 = privateKeyToAccount(P1_KEY).address;
  const p2 = privateKeyToAccount(P2_KEY).address;
  const chain = await createLocalChain({
    chainId: CHAIN_ID,
    balances: { [owner]: 1000n * ONE, [p1]: 100n * ONE, [p2]: 100n * ONE },
  });
  const settlement = await deployBindSettlement(chain, OWNER_KEY);
  const attackerArtifact = loadHelperArtifact("ReentrantSupplier");
  const attackerDeployed = await deployHelperArtifact(chain, OWNER_KEY, attackerArtifact);
  return {
    chain,
    settlement,
    attacker: attackerDeployed.address,
    attackerAbi: attackerArtifact.abi,
    owner: viemClients(chain, OWNER_KEY),
    p1: viemClients(chain, P1_KEY),
    p2: viemClients(chain, P2_KEY),
  };
}

async function send(
  clients: ViemClients,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  value = 0n
) {
  const hash = await clients.walletClient.writeContract({
    address,
    abi,
    functionName: functionName as never,
    args: args as never,
    value,
    gas: 3_000_000n,
  });
  return clients.publicClient.waitForTransactionReceipt({ hash });
}

function revertDataOf(error: unknown): Hex | undefined {
  let node: any = error;
  while (node) {
    if (typeof node.data === "string" && node.data.startsWith("0x")) return node.data as Hex;
    node = node.cause;
  }
  return undefined;
}

type SimResult = { ok: true } | { ok: false; errorName: string | undefined; args: readonly unknown[] };

/** Runs a call with eth_call and decodes the custom error it reverts with. Changes no state. */
async function simulate(
  clients: ViemClients,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[],
  value = 0n,
  /** The ABI that declares the custom errors. A call through the attacker can bubble BindSettlement's errors. */
  errorAbi: Abi = abi
): Promise<SimResult> {
  const data = encodeFunctionData({ abi, functionName: functionName as never, args: args as never });
  try {
    await clients.publicClient.call({ account: clients.account, to: address, data, value });
    return { ok: true };
  } catch (error) {
    const raw = revertDataOf(error);
    if (!raw) throw new Error(`no revert data for ${functionName}: ${(error as Error).message.split("\n")[0]}`);
    const decoded = decodeErrorResult({ abi: errorAbi, data: raw });
    return { ok: false, errorName: decoded.errorName, args: decoded.args ?? [] };
  }
}

async function getEscrow(world: World, id: Hex) {
  return world.settlement.publicClient.readContract({
    address: world.settlement.address,
    abi: world.settlement.abi,
    functionName: "getEscrow",
    args: [id],
  }) as Promise<{ depositor: Address; recipient: Address; amount: bigint; released: boolean; refunded: boolean }>;
}

async function openEscrowTotal(world: World): Promise<bigint> {
  let total = 0n;
  for (const id of [E0, E1, E_NEW]) {
    const esc = await getEscrow(world, id);
    if (esc.depositor !== "0x0000000000000000000000000000000000000000" && !esc.released && !esc.refunded) {
      total += esc.amount;
    }
  }
  return total;
}

async function settledFlag(world: World, id: Hex): Promise<boolean> {
  return world.settlement.publicClient.readContract({
    address: world.settlement.address,
    abi: world.settlement.abi,
    functionName: "settledOrders",
    args: [id],
  }) as Promise<boolean>;
}

async function attackerRead(world: World, functionName: string): Promise<any> {
  return world.settlement.publicClient.readContract({
    address: world.attacker,
    abi: world.attackerAbi,
    functionName: functionName as never,
  });
}

async function settlementEventsFor(world: World, id: Hex): Promise<number> {
  const event = world.settlement.abi.find((i) => i.type === "event" && i.name === "SettlementExecuted") as any;
  const logs = await world.settlement.publicClient.getLogs({
    address: world.settlement.address,
    event,
    args: { orderId: id },
    fromBlock: 0n,
  });
  return logs.length;
}

/** Sets up the escrows and the attacker for one case. The attacker is funded before it is armed. */
async function arrange(world: World, c: ModeCase, swallow: boolean) {
  const settlementAddress = world.settlement.address;
  // The attacker learns its target first, unarmed (mode NONE), so its deposit helper can reach BindSettlement.
  const unarmed = await send(world.owner, world.attacker, world.attackerAbi, "configure", [
    { target: settlementAddress, mode: 0, swallow: true, orderId: ORDER, otherOrderId: OTHER_ORDER, escrowId: E0, recipient: RECIPIENT_R, matchHash: MATCH, innerValue: 0n },
  ]);
  expect(unarmed.status).toBe("success");
  // Funding goes through a plain transfer. The attacker is not armed yet, so its receive() only counts it.
  await world.owner.walletClient.sendTransaction({ to: world.attacker, value: FUND, gas: 100_000n });

  let escrowId: Hex = E0;
  if (c.mode === MODE.RELEASE || c.mode === MODE.REFUND) {
    const r = await send(world.owner, world.attacker, world.attackerAbi, "deposit", [E0, RECIPIENT_R, MATCH], D);
    expect(r.status).toBe("success");
  } else if (c.mode === MODE.RELEASE_AS_RECIPIENT) {
    // The attacker is the depositor and the recipient of E0. An unrelated escrow E1 (deposited by P2) stays open, so a
    // double payout of E0 would be paid out of E1 and show up in the balance check.
    const r0 = await send(world.owner, world.attacker, world.attackerAbi, "deposit", [E0, world.attacker, MATCH], D);
    expect(r0.status).toBe("success");
    const r1 = await send(world.p2, settlementAddress, world.settlement.abi, "depositEscrow", [E1, RECIPIENT_R2, MATCH], X);
    expect(r1.status).toBe("success");
  } else if (c.mode === MODE.DEPOSIT) {
    escrowId = E_NEW;
  }

  const config = {
    target: settlementAddress,
    mode: c.mode,
    swallow,
    orderId: ORDER,
    otherOrderId: OTHER_ORDER,
    escrowId,
    recipient: RECIPIENT_R,
    matchHash: MATCH,
    innerValue: INNER,
  };
  const armed = await send(world.owner, world.attacker, world.attackerAbi, "configure", [config]);
  expect(armed.status).toBe("success");
}

/**
 * The outer call: the transaction that the inner re-entry happens inside. For RELEASE_AS_RECIPIENT the attacker is the
 * depositor and the recipient of E0, and the outer call is the attacker's own release. So the inner releaseEscrow comes
 * from the depositor: a correct contract refuses it with EscrowAlreadySettled, and a contract that pays before it
 * marks the escrow released pays a second time.
 */
function outerCall(
  world: World,
  c: ModeCase
): { clients: ViemClients; to: Address; abi: Abi; functionName: string; args: readonly unknown[]; value: bigint; errorAbi: Abi } {
  if (c.outer === "settle") {
    return {
      clients: world.owner,
      to: world.settlement.address,
      abi: world.settlement.abi,
      functionName: "settleOrder",
      args: [ORDER, world.attacker, MATCH],
      value: V,
      errorAbi: world.settlement.abi,
    };
  }
  return {
    clients: world.owner,
    to: world.attacker,
    abi: world.attackerAbi,
    functionName: "release",
    args: [E0],
    value: 0n,
    errorAbi: world.settlement.abi,
  };
}

/** The value the attacker is owed by the events of the outer receipt (its own payouts, not the ones it paid). */
function legitimateIncoming(
  logs: readonly { eventName: string; args: Record<string, unknown> }[],
  attacker: Address
): bigint {
  let total = 0n;
  const a = attacker.toLowerCase();
  for (const log of logs) {
    const args = log.args;
    if (log.eventName === "SettlementExecuted" && String(args.supplier).toLowerCase() === a) total += args.amount as bigint;
    if (log.eventName === "EscrowReleased" && String(args.recipient).toLowerCase() === a) total += args.amount as bigint;
    if (log.eventName === "EscrowRefunded" && String(args.depositor).toLowerCase() === a) total += args.amount as bigint;
  }
  return total;
}

describe("BindSettlement reentrancy from a supplier, recipient or depositor (in-process EVM)", () => {
  for (const c of CASES) {
    for (const swallow of [true, false]) {
      const label = `${c.name} with the inner failure ${swallow ? "swallowed" : "bubbled"}`;

      it(label, async () => {
        const world = await setupWorld();
        await arrange(world, c, swallow);

        const before = {
          contract: await world.settlement.publicClient.getBalance({ address: world.settlement.address }),
          attacker: await world.settlement.publicClient.getBalance({ address: world.attacker }),
          attackerReceived: (await attackerRead(world, "receivedTotal")) as bigint,
          settled: await settledFlag(world, ORDER),
          openEscrows: await openEscrowTotal(world),
        };
        const outer = outerCall(world, c);

        // The simulated outer call says what would happen, and shows the revert reason when it fails.
        const sim = await simulate(outer.clients, outer.to, outer.abi, outer.functionName, outer.args, outer.value, outer.errorAbi);
        const outerSucceeds = swallow || c.innerOk;

        if (!outerSucceeds) {
          // A bubbled inner failure reverts the whole outer call with TransferFailed.
          expect(sim.ok, "the outer call must revert").toBe(false);
          if (!sim.ok) expect(sim.errorName).toBe("TransferFailed");

          const receipt = await send(outer.clients, outer.to, outer.abi, outer.functionName, outer.args, outer.value);
          expect(receipt.status, "the mined outer call reverts").toBe("reverted");

          // No state change: the contract, the attacker, the order and the escrows are as before.
          expect(await world.settlement.publicClient.getBalance({ address: world.settlement.address })).toBe(before.contract);
          expect(await world.settlement.publicClient.getBalance({ address: world.attacker })).toBe(before.attacker);
          expect(await attackerRead(world, "receivedTotal")).toBe(before.attackerReceived);
          expect(await attackerRead(world, "innerAttempted")).toBe(false);
          expect(await settledFlag(world, ORDER)).toBe(before.settled);
          expect(await openEscrowTotal(world)).toBe(before.openEscrows);
          expect(await settlementEventsFor(world, ORDER)).toBe(0);
          return;
        }

        expect(sim.ok, "the outer call must succeed").toBe(true);
        const receipt = await send(outer.clients, outer.to, outer.abi, outer.functionName, outer.args, outer.value);
        expect(receipt.status, "the mined outer call succeeds").toBe("success");

        // The attacker's record of the inner call.
        expect(await attackerRead(world, "innerAttempted")).toBe(true);
        expect(await attackerRead(world, "innerSucceeded")).toBe(c.innerOk);
        if (!c.innerOk) {
          const data = (await attackerRead(world, "innerReturnData")) as Hex;
          expect(decodeErrorResult({ abi: world.settlement.abi, data }).errorName).toBe(c.innerError);
        }

        const logs = parseEventLogs({
          abi: world.settlement.abi,
          logs: receipt.logs,
          eventName: ["SettlementExecuted", "EscrowReleased", "EscrowRefunded"],
        }) as unknown as { eventName: string; args: Record<string, unknown> }[];

        // 1. No order is settled twice.
        const settleEvents = await settlementEventsFor(world, ORDER);
        expect(settleEvents, "an order id is settled at most once").toBeLessThanOrEqual(1);
        if (c.outer === "settle") {
          expect(settleEvents).toBe(1);
          expect(await settledFlag(world, ORDER)).toBe(true);
          const again = await simulate(world.owner, world.settlement.address, world.settlement.abi, "settleOrder", [ORDER, world.attacker, MATCH], V);
          expect(again.ok).toBe(false);
          if (!again.ok) expect(again.errorName).toBe("OrderAlreadySettled");
        }
        // A released escrow cannot be released again, even through the attacker.
        if (c.outer === "release" || c.mode === MODE.RELEASE || c.mode === MODE.REFUND) {
          const esc = await getEscrow(world, E0);
          expect(esc.released && esc.refunded, "an escrow is never both released and refunded").toBe(false);
          const replay = await simulate(world.owner, world.settlement.address, world.settlement.abi, "releaseEscrow", [E0]);
          expect(replay.ok).toBe(false);
          if (!replay.ok) expect(replay.errorName).toBe("EscrowAlreadySettled");
        }

        // 2. The attacker never receives more than the legitimate value sent to it.
        const attackerReceived = ((await attackerRead(world, "receivedTotal")) as bigint) - before.attackerReceived;
        const legit = legitimateIncoming(logs, world.attacker);
        expect(attackerReceived, "received equals the legitimate payouts from the events").toBe(legit);
        const attackerBalanceDelta =
          (await world.settlement.publicClient.getBalance({ address: world.attacker })) - before.attacker;
        expect(attackerBalanceDelta, "net gain is legitimate income minus what the attacker paid in").toBe(legit - c.attackerPays);

        // 3. Contract balance equals the sum of open escrows (I2).
        expect(await world.settlement.publicClient.getBalance({ address: world.settlement.address })).toBe(
          await openEscrowTotal(world)
        );

        // 4. A swallowed re-entry leaves the outer settlement correct.
        if (c.outer === "settle") {
          expect(logs.filter((l) => l.eventName === "SettlementExecuted").length).toBeGreaterThanOrEqual(1);
          const outerSupplierCredit = logs.find((l) => l.eventName === "SettlementExecuted" && String(l.args.orderId) === ORDER);
          expect(outerSupplierCredit?.args.amount).toBe(V);
        } else {
          const released = await getEscrow(world, E0);
          expect(released.released).toBe(true);
        }
      });
    }
  }

  it("a second order id settled from inside the callback is paid once and the outer settlement is unaffected", async () => {
    const world = await setupWorld();
    await arrange(world, CASES[1], true); // OTHER_ORDER, swallowed
    const receipt = await send(world.owner, world.settlement.address, world.settlement.abi, "settleOrder", [ORDER, world.attacker, MATCH], V);
    expect(receipt.status).toBe("success");
    expect(await settledFlag(world, ORDER)).toBe(true);
    expect(await settledFlag(world, OTHER_ORDER)).toBe(true);
    expect(await settlementEventsFor(world, ORDER)).toBe(1);
    expect(await settlementEventsFor(world, OTHER_ORDER)).toBe(1);
  });
});
