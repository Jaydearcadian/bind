import { describe, it, expect } from "vitest";
import { decodeErrorResult, encodeFunctionData, keccak256, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createLocalChain, type LocalChain } from "../helpers/local-chain.js";
import { deployBindSettlement, viemClients, loadArtifact, type ViemClients } from "../helpers/bind-settlement.js";

/**
 * Property tests for BindSettlement on the in-process EVM (EthereumJS, not Anvil, not Forge).
 *
 * Each seed runs STEPS random operations. Every operation is applied to a TypeScript model of the contract and to the
 * real bytecode. The model predicts the outcome of each call (success, or the custom error and its arguments). The
 * chain must agree with that prediction, and the invariants below are checked against the chain after every step.
 *
 * This is a property test over one in-process EVM. It is not Forge invariant testing (contracts/test/*.invariant.t.sol,
 * NOT_RUN here) and it is not a formal proof. The seeds are fixed, so a failure reproduces: the message names the seed.
 *
 * Invariants (numbering as in docs/decisions/0039-contract-properties-and-live-check.md):
 *   I1  an order id settles at most once; settledOrders never goes from true to false.
 *   I2  the native balance of the contract equals the sum of the amounts of escrows that are neither released nor refunded.
 *   I3  a successful settleOrder raises the supplier's balance by exactly msg.value and leaves the contract balance
 *       unchanged; the payer pays msg.value plus gas (the supplier and contract deltas are the assertions, the payer's
 *       gas is the expected cost).
 *   I4  after a successful spend while the daily limit is non-zero, dailySpent <= dailySpendLimit.
 *   I5  an escrow ends released xor refunded, never both and never twice; only the depositor or the owner can release
 *       or refund. A stranger on an open escrow gets Unauthorized. (On a settled escrow the contract checks the status
 *       before the caller, so a stranger gets EscrowAlreadySettled there. The model encodes that order.)
 *   I6  only the owner can call the admin functions; anyone else gets Unauthorized.
 *   I7  a reverted call changes no contract state and moves no balance except the caller's gas.
 */

// Local test keys. They hold balances only on the in-process chain that each test creates.
const KEYS = {
  owner: `0x${"11".repeat(32)}`,
  p1: `0x${"33".repeat(32)}`,
  p2: `0x${"44".repeat(32)}`,
  x: `0x${"55".repeat(32)}`,
  s1: `0x${"66".repeat(32)}`,
  s2: `0x${"77".repeat(32)}`,
  s3: `0x${"88".repeat(32)}`,
} as const satisfies Record<string, Hex>;

const CHAIN_ID = 31337;
const START_TIME = 1_700_000_000;
const ONE = 10n ** 18n;
const DAY = 86_400n;
const ZERO: Address = "0x0000000000000000000000000000000000000000";
const MATCH = keccak256(toHex("po|receipt|bill"));

const SEEDS = [1, 2, 3, 42, 1337, 20261020];
const STEPS = 60;

const ORDER_IDS: Hex[] = Array.from({ length: 8 }, (_, i) => keccak256(toHex(`prop_order_${i}`)));
const ESCROW_IDS: Hex[] = Array.from({ length: 6 }, (_, i) => keccak256(toHex(`prop_escrow_${i}`)));

interface Actor {
  name: string;
  address: Address;
  clients: ViemClients;
}

interface World {
  chain: LocalChain;
  address: Address;
  abi: any;
  owner: Actor;
  p1: Actor;
  p2: Actor;
  x: Actor;
  suppliers: Actor[];
  /** Every actor whose balance the I7 check compares. */
  everyone: Actor[];
  /** Addresses whose whitelist status is checked. */
  vendorAddresses: Address[];
  /**
   * The gas price the EVM charges, learned from the first transaction. The receipt's effectiveGasPrice is not used: the
   * in-process chain reports 1 gwei there while it charges viem's 1.2 gwei (measured; see the note in runWrite).
   */
  gasPrice: { value?: bigint };
}

interface Escrow {
  depositor: string;
  recipient: string;
  amount: bigint;
  released: boolean;
  refunded: boolean;
}

interface Model {
  limit: bigint;
  dailySpent: bigint;
  lastDayReset: bigint;
  enforce: boolean;
  vendors: Map<string, boolean>;
  settled: Map<Hex, boolean>;
  escrows: Map<Hex, Escrow>;
  /** The chain clock after the last step. A transaction mined next gets clock + 1. */
  clock: bigint;
}

type Outcome = { ok: true } | { ok: false; error: string; args: unknown[] };

type WriteOp =
  | { kind: "settle"; payer: Actor; orderId: Hex; supplier: Address; value: bigint }
  | { kind: "deposit"; payer: Actor; escrowId: Hex; recipient: Address; value: bigint }
  | { kind: "release"; caller: Actor; escrowId: Hex }
  | { kind: "refund"; caller: Actor; escrowId: Hex }
  | { kind: "setLimit"; caller: Actor; limit: bigint }
  | { kind: "setVendor"; caller: Actor; vendor: Address; allowed: boolean }
  | { kind: "setEnforce"; caller: Actor; enforce: boolean };

type Op = WriteOp | { kind: "advance"; seconds: number };

interface Call {
  from: Actor;
  fn: string;
  args: unknown[];
  value: bigint;
}

/** How many times each outcome class was reached, across all seeds. The last test checks that none is missing. */
const coverage = new Map<string, number>();
function count(key: string) {
  coverage.set(key, (coverage.get(key) ?? 0) + 1);
}

/** mulberry32: a small deterministic PRNG, written here so that no dependency is needed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randBig(rng: () => number, max: bigint): bigint {
  const hi = BigInt(Math.floor(rng() * 2 ** 32));
  const lo = BigInt(Math.floor(rng() * 2 ** 32));
  return ((hi << 32n) | lo) % max;
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function pickWeighted<T>(rng: () => number, items: readonly (readonly [T, number])[]): T {
  const total = items.reduce((sum, [, w]) => sum + w, 0);
  let r = rng() * total;
  for (const [item, w] of items) {
    r -= w;
    if (r < 0) return item;
  }
  return items[items.length - 1][0];
}

function describeOp(op: Op): string {
  switch (op.kind) {
    case "settle":
      return `settleOrder(${op.orderId.slice(0, 10)}, ${op.supplier.slice(0, 8)}, value=${op.value}) by ${op.payer.name}`;
    case "deposit":
      return `depositEscrow(${op.escrowId.slice(0, 10)}, ${op.recipient.slice(0, 8)}, value=${op.value}) by ${op.payer.name}`;
    case "release":
      return `releaseEscrow(${op.escrowId.slice(0, 10)}) by ${op.caller.name}`;
    case "refund":
      return `refundEscrow(${op.escrowId.slice(0, 10)}) by ${op.caller.name}`;
    case "setLimit":
      return `setDailyLimit(${op.limit}) by ${op.caller.name}`;
    case "setVendor":
      return `setVendorStatus(${op.vendor.slice(0, 8)}, ${op.allowed}) by ${op.caller.name}`;
    case "setEnforce":
      return `setEnforceVendorWhitelist(${op.enforce}) by ${op.caller.name}`;
    case "advance":
      return `advance ${op.seconds}s`;
  }
}

function normalize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value.toLowerCase();
  if (Array.isArray(value)) return value.map(normalize);
  return value;
}

function outcomeText(o: Outcome): string {
  return o.ok ? "success" : `revert ${o.error}(${JSON.stringify(normalize(o.args))})`;
}

function sameOutcome(a: Outcome, b: Outcome): boolean {
  if (a.ok || b.ok) return a.ok === b.ok;
  return a.error === b.error && JSON.stringify(normalize(a.args)) === JSON.stringify(normalize(b.args));
}

function cloneModel(m: Model): Model {
  return {
    ...m,
    vendors: new Map(m.vendors),
    settled: new Map(m.settled),
    escrows: new Map([...m.escrows].map(([k, v]) => [k, { ...v }])),
  };
}

const reverted = (error: string, args: unknown[] = []): Outcome => ({ ok: false, error, args });

/**
 * The daily window as the contract writes it: reset at or after lastDayReset + 1 day, then check and add. Mutates m, so
 * the caller passes a copy and keeps the copy only when the call succeeds (a revert rolls the window back too).
 */
function modelSpend(m: Model, amount: bigint, now: bigint): Outcome {
  if (now >= m.lastDayReset + DAY) {
    m.dailySpent = 0n;
    m.lastDayReset = now;
  }
  if (m.limit > 0n && m.dailySpent + amount > m.limit) {
    return reverted("DailyLimitExceeded", [m.dailySpent + amount, m.limit]);
  }
  m.dailySpent += amount;
  return { ok: true };
}

/** Predicts one write. Returns the outcome and the model after it (unchanged on a revert, clock always advanced). */
function modelApply(before: Model, op: WriteOp, owner: Address, now: bigint): { outcome: Outcome; next: Model } {
  const m = cloneModel(before);
  m.clock = now;
  const revertWith = (o: Outcome) => ({ outcome: o, next: { ...cloneModel(before), clock: now } });
  const callerIsOwner = (caller: Actor) => caller.address.toLowerCase() === owner.toLowerCase();

  switch (op.kind) {
    case "settle": {
      // The order of checks mirrors settleOrder in contracts/src/BindSettlement.sol.
      if (op.value === 0n) return revertWith(reverted("InsufficientValue"));
      if (op.supplier === ZERO) return revertWith(reverted("Unauthorized"));
      if (m.enforce && m.vendors.get(op.supplier.toLowerCase()) !== true) {
        return revertWith(reverted("VendorNotWhitelisted", [op.supplier]));
      }
      if (m.settled.get(op.orderId)) return revertWith(reverted("OrderAlreadySettled"));
      const spend = modelSpend(m, op.value, now);
      if (!spend.ok) return revertWith(spend);
      m.settled.set(op.orderId, true);
      return { outcome: { ok: true }, next: m };
    }
    case "deposit": {
      if (op.value === 0n) return revertWith(reverted("InsufficientValue"));
      if (op.recipient === ZERO) return revertWith(reverted("Unauthorized"));
      if (m.enforce && m.vendors.get(op.recipient.toLowerCase()) !== true) {
        return revertWith(reverted("VendorNotWhitelisted", [op.recipient]));
      }
      if (m.escrows.has(op.escrowId)) return revertWith(reverted("EscrowAlreadyExists"));
      const spend = modelSpend(m, op.value, now);
      if (!spend.ok) return revertWith(spend);
      m.escrows.set(op.escrowId, {
        depositor: op.payer.address.toLowerCase(),
        recipient: op.recipient.toLowerCase(),
        amount: op.value,
        released: false,
        refunded: false,
      });
      return { outcome: { ok: true }, next: m };
    }
    case "release":
    case "refund": {
      const esc = m.escrows.get(op.escrowId);
      if (!esc) return revertWith(reverted("EscrowNotFound"));
      if (esc.released || esc.refunded) return revertWith(reverted("EscrowAlreadySettled"));
      const caller = op.caller.address.toLowerCase();
      if (caller !== esc.depositor && !callerIsOwner(op.caller)) return revertWith(reverted("Unauthorized"));
      if (op.kind === "release") {
        esc.released = true;
      } else {
        esc.refunded = true;
        if (m.dailySpent >= esc.amount) m.dailySpent -= esc.amount;
      }
      return { outcome: { ok: true }, next: m };
    }
    case "setLimit": {
      if (!callerIsOwner(op.caller)) return revertWith(reverted("Unauthorized"));
      m.limit = op.limit;
      return { outcome: { ok: true }, next: m };
    }
    case "setVendor": {
      if (!callerIsOwner(op.caller)) return revertWith(reverted("Unauthorized"));
      if (op.vendor === ZERO) return revertWith(reverted("Unauthorized"));
      m.vendors.set(op.vendor.toLowerCase(), op.allowed);
      return { outcome: { ok: true }, next: m };
    }
    case "setEnforce": {
      if (!callerIsOwner(op.caller)) return revertWith(reverted("Unauthorized"));
      m.enforce = op.enforce;
      return { outcome: { ok: true }, next: m };
    }
  }
}

function toCall(op: WriteOp): Call {
  switch (op.kind) {
    case "settle":
      return { from: op.payer, fn: "settleOrder", args: [op.orderId, op.supplier, MATCH], value: op.value };
    case "deposit":
      return { from: op.payer, fn: "depositEscrow", args: [op.escrowId, op.recipient, MATCH], value: op.value };
    case "release":
      return { from: op.caller, fn: "releaseEscrow", args: [op.escrowId], value: 0n };
    case "refund":
      return { from: op.caller, fn: "refundEscrow", args: [op.escrowId], value: 0n };
    case "setLimit":
      return { from: op.caller, fn: "setDailyLimit", args: [op.limit], value: 0n };
    case "setVendor":
      return { from: op.caller, fn: "setVendorStatus", args: [op.vendor, op.allowed], value: 0n };
    case "setEnforce":
      return { from: op.caller, fn: "setEnforceVendorWhitelist", args: [op.enforce], value: 0n };
  }
}

/** The caller whose gas a transaction spends. */
function callerOf(op: WriteOp): Actor {
  return op.kind === "settle" || op.kind === "deposit" ? op.payer : op.caller;
}

/** Revert data of a failed eth_call, decoded with the contract ABI. Undefined when the call did not revert with data. */
function decodeRevert(abi: any, error: unknown): { errorName: string; args: readonly unknown[] } | undefined {
  let node: any = error;
  while (node) {
    if (typeof node.data === "string" && node.data.startsWith("0x")) {
      const decoded = decodeErrorResult({ abi, data: node.data as Hex });
      return { errorName: decoded.errorName, args: decoded.args ?? [] };
    }
    node = node.cause;
  }
  return undefined;
}

/**
 * Runs the call with eth_call from the caller, at the clock a mined transaction would see. Changes no state.
 * It goes to the in-process chain's request function rather than through viem: viem builds a heavy error object on
 * every revert (about 100 ms each here), and the prediction only needs the revert data. Reads and writes stay on viem.
 */
async function simulateCall(world: World, call: Call): Promise<Outcome> {
  const data = encodeFunctionData({ abi: world.abi, functionName: call.fn as never, args: call.args as never });
  try {
    await world.chain.request({
      method: "eth_call",
      params: [{ from: call.from.address, to: world.address, data, value: toHex(call.value) }, "latest"],
    });
    return { ok: true };
  } catch (error) {
    const decoded = decodeRevert(world.abi, error);
    if (!decoded) throw new Error(`simulation of ${call.fn} failed without revert data: ${(error as Error).message.split("\n")[0]}`);
    return { ok: false, error: decoded.errorName, args: [...decoded.args] };
  }
}

async function sendCall(world: World, call: Call) {
  const hash = await call.from.clients.walletClient.writeContract({
    address: world.address,
    abi: world.abi,
    functionName: call.fn as never,
    args: call.args as never,
    value: call.value,
    gas: 500_000n,
  });
  return call.from.clients.publicClient.waitForTransactionReceipt({ hash });
}

interface Balances {
  contract: bigint;
  byActor: Record<string, bigint>;
}

async function balances(world: World): Promise<Balances> {
  const pc = world.owner.clients.publicClient;
  const byActor: Record<string, bigint> = {};
  for (const a of world.everyone) byActor[a.name] = await pc.getBalance({ address: a.address });
  return { contract: await pc.getBalance({ address: world.address }), byActor };
}

/** Every piece of contract state the model tracks, for the I7 comparison of a reverted call. */
interface StateSnapshot extends Balances {
  limit: bigint;
  dailySpent: bigint;
  lastDayReset: bigint;
  enforce: boolean;
  owner: string;
  vendors: Record<string, boolean>;
  settled: Record<string, boolean>;
  escrows: Record<string, string>;
}

async function snapshot(world: World): Promise<StateSnapshot> {
  const read = (fn: string, args: unknown[] = []): Promise<any> =>
    world.owner.clients.publicClient.readContract({ address: world.address, abi: world.abi, functionName: fn as never, args: args as never });
  const vendors: Record<string, boolean> = {};
  for (const v of world.vendorAddresses) vendors[v.toLowerCase()] = await read("whitelistedVendors", [v]);
  const settled: Record<string, boolean> = {};
  for (const id of ORDER_IDS) settled[id] = await read("settledOrders", [id]);
  const escrows: Record<string, string> = {};
  for (const id of ESCROW_IDS) {
    const e = await read("getEscrow", [id]);
    escrows[id] = JSON.stringify(normalize([e.depositor, e.recipient, e.amount, e.released, e.refunded]));
  }
  return {
    ...(await balances(world)),
    limit: await read("dailySpendLimit"),
    dailySpent: await read("dailySpent"),
    lastDayReset: await read("lastDayReset"),
    enforce: await read("enforceVendorWhitelist"),
    owner: String(await read("owner")).toLowerCase(),
    vendors,
    settled,
    escrows,
  };
}

function actor(chain: LocalChain, name: keyof typeof KEYS): Actor {
  const key = KEYS[name];
  return { name, address: privateKeyToAccount(key).address, clients: viemClients(chain, key) };
}

async function setup(): Promise<World> {
  const artifact = loadArtifact();
  const chain = await createLocalChain({
    chainId: CHAIN_ID,
    startTime: START_TIME,
    balances: {
      [privateKeyToAccount(KEYS.owner).address]: 10_000n * ONE,
      [privateKeyToAccount(KEYS.p1).address]: 10_000n * ONE,
      [privateKeyToAccount(KEYS.p2).address]: 10_000n * ONE,
      [privateKeyToAccount(KEYS.x).address]: 10_000n * ONE,
    },
  });
  const deployed = await deployBindSettlement(chain, KEYS.owner);
  const owner = actor(chain, "owner");
  const p1 = actor(chain, "p1");
  const p2 = actor(chain, "p2");
  const x = actor(chain, "x");
  const suppliers = [actor(chain, "s1"), actor(chain, "s2"), actor(chain, "s3")];
  return {
    chain,
    address: deployed.address,
    abi: artifact.abi,
    owner,
    p1,
    p2,
    x,
    suppliers,
    everyone: [owner, p1, p2, x, ...suppliers],
    vendorAddresses: [...suppliers.map((s) => s.address), x.address],
    gasPrice: {},
  };
}

function randomOp(rng: () => number, world: World): Op {
  const payers = [world.owner, world.p1, world.p2];
  const supplierAddresses = world.suppliers.map((s) => s.address);
  const kind = pickWeighted<Op["kind"]>(rng, [
    ["settle", 30],
    ["deposit", 15],
    ["release", 12],
    ["refund", 12],
    ["setLimit", 7],
    ["setVendor", 8],
    ["setEnforce", 4],
    ["advance", 12],
  ]);
  const amount = (): bigint => (rng() < 0.1 ? 0n : 1_000_000_000_000_000n + randBig(rng, 2n * 10n ** 18n));
  const anyCaller = (): Actor => pickWeighted<Actor>(rng, [[world.owner, 2], [world.p1, 2], [world.p2, 2], [world.x, 2]]);
  switch (kind) {
    case "settle":
      return {
        kind,
        payer: pick(rng, payers),
        orderId: pick(rng, ORDER_IDS),
        supplier: rng() < 0.03 ? ZERO : pick(rng, supplierAddresses),
        value: amount(),
      };
    case "deposit":
      return {
        kind,
        payer: pick(rng, payers),
        escrowId: pick(rng, ESCROW_IDS),
        recipient: rng() < 0.03 ? ZERO : pick(rng, supplierAddresses),
        value: amount(),
      };
    case "release":
      return { kind, caller: anyCaller(), escrowId: pick(rng, ESCROW_IDS) };
    case "refund":
      return { kind, caller: anyCaller(), escrowId: pick(rng, ESCROW_IDS) };
    case "setLimit":
      return {
        kind,
        caller: rng() < 0.8 ? world.owner : pick(rng, [world.p1, world.p2, world.x]),
        limit: pick(rng, [0n, ONE, 3n * ONE, 6n * ONE, 10n * ONE, randBig(rng, 5n * ONE)]),
      };
    case "setVendor":
      return {
        kind,
        caller: rng() < 0.7 ? world.owner : pick(rng, [world.p1, world.x]),
        vendor: rng() < 0.03 ? ZERO : pick(rng, world.vendorAddresses),
        allowed: rng() < 0.7,
      };
    case "setEnforce":
      return { kind, caller: rng() < 0.8 ? world.owner : pick(rng, [world.p1, world.x]), enforce: rng() < 0.5 };
    case "advance": {
      // Three bands: short steps, steps around the 24-hour boundary, and anything up to three days.
      const band = rng();
      const seconds =
        band < 0.4
          ? Math.floor(rng() * 3600)
          : band < 0.7
            ? 86_400 - 600 + Math.floor(rng() * 1200)
            : Math.floor(rng() * 3 * 86_400);
      return { kind, seconds };
    }
  }
}

interface Tracker {
  settledSeen: Map<Hex, boolean>;
  escrowSeen: Map<Hex, { released: boolean; refunded: boolean }>;
}

/** Checks the model against the chain, and I1, I2 and I5 (the state invariants), after every step. */
async function checkState(world: World, m: Model, tracker: Tracker, label: string) {
  const read = (fn: string, args: unknown[] = []): Promise<any> =>
    world.owner.clients.publicClient.readContract({ address: world.address, abi: world.abi, functionName: fn as never, args: args as never });

  expect(Number(m.clock), `${label}: the chain clock matches the model clock`).toBe(world.chain.currentTime());
  expect(await read("dailySpendLimit"), `${label}: dailySpendLimit`).toBe(m.limit);
  expect(await read("dailySpent"), `${label}: dailySpent`).toBe(m.dailySpent);
  expect(await read("lastDayReset"), `${label}: lastDayReset`).toBe(m.lastDayReset);
  expect(await read("enforceVendorWhitelist"), `${label}: enforceVendorWhitelist`).toBe(m.enforce);
  for (const v of world.vendorAddresses) {
    expect(await read("whitelistedVendors", [v]), `${label}: whitelistedVendors(${v.slice(0, 8)})`).toBe(
      m.vendors.get(v.toLowerCase()) === true
    );
  }

  // I1: settledOrders matches the model, and a true flag never goes back to false.
  for (const id of ORDER_IDS) {
    const settled: boolean = await read("settledOrders", [id]);
    expect(settled, `${label}: settledOrders(${id.slice(0, 10)})`).toBe(m.settled.get(id) === true);
    if (tracker.settledSeen.get(id) === true) {
      expect(settled, `${label}: I1 settledOrders went from true to false`).toBe(true);
    }
    tracker.settledSeen.set(id, settled);
  }

  // I5: escrow fields match the model; a release or refund flag never goes back; never both.
  let openSum = 0n;
  for (const id of ESCROW_IDS) {
    const e = await read("getEscrow", [id]);
    const mine = m.escrows.get(id);
    if (!mine) {
      expect(e.depositor, `${label}: escrow ${id.slice(0, 10)} should not exist`).toBe(ZERO);
      continue;
    }
    expect(String(e.depositor).toLowerCase(), `${label}: escrow depositor`).toBe(mine.depositor);
    expect(String(e.recipient).toLowerCase(), `${label}: escrow recipient`).toBe(mine.recipient);
    expect(e.amount, `${label}: escrow amount`).toBe(mine.amount);
    expect(e.released, `${label}: escrow released`).toBe(mine.released);
    expect(e.refunded, `${label}: escrow refunded`).toBe(mine.refunded);
    expect(e.released && e.refunded, `${label}: I5 released and refunded at once`).toBe(false);
    const seen = tracker.escrowSeen.get(id);
    if (seen) {
      expect(!seen.released || e.released, `${label}: I5 a release flag went back to false`).toBe(true);
      expect(!seen.refunded || e.refunded, `${label}: I5 a refund flag went back to false`).toBe(true);
    }
    tracker.escrowSeen.set(id, { released: e.released, refunded: e.refunded });
    if (!mine.released && !mine.refunded) openSum += mine.amount;
  }

  // I2: the native balance of the contract is the open escrows.
  const contractBalance = await world.owner.clients.publicClient.getBalance({ address: world.address });
  expect(contractBalance, `${label}: I2 contract balance equals the open escrows`).toBe(openSum);
}

async function runWrite(world: World, m: Model, op: WriteOp, label: string): Promise<void> {
  const now = m.clock + 1n;
  const { outcome: predicted, next } = modelApply(m, op, world.owner.address, now);
  const call = toCall(op);
  const caller = callerOf(op);

  // eth_call first: the chain must give the predicted outcome from the current state.
  const simulated = await simulateCall(world, call);
  expect(sameOutcome(simulated, predicted), `${label}: eth_call predicted ${outcomeText(predicted)}, chain says ${outcomeText(simulated)}`).toBe(true);

  // Full snapshot only when the call is predicted to revert: I7 needs the whole state before and after.
  const fullBefore = predicted.ok ? undefined : await snapshot(world);
  const before = await balances(world);
  const receipt = await sendCall(world, call);
  expect(receipt.status === "success", `${label}: mined status is ${receipt.status}, predicted ${outcomeText(predicted)}`).toBe(predicted.ok);
  expect(world.chain.currentTime(), `${label}: clock after the transaction`).toBe(Number(now));
  const after = await balances(world);

  // The caller's gas. It is read from the balances, not from the receipt's effectiveGasPrice (see World.gasPrice).
  // The value a successful settleOrder or depositEscrow sends is subtracted first. A reverted call sends nothing.
  const valueSent = predicted.ok && (op.kind === "settle" || op.kind === "deposit") ? op.value : 0n;
  const callerDelta = before.byActor[caller.name] - after.byActor[caller.name];
  const gasCharged = callerDelta - valueSent;
  expect(receipt.gasUsed > 0n && gasCharged % receipt.gasUsed, `${label}: the caller paid gas as gasUsed times one price`).toBe(0n);
  const price = gasCharged / receipt.gasUsed;
  if (world.gasPrice.value === undefined) world.gasPrice.value = price;
  expect(price, `${label}: one gas price for the whole run`).toBe(world.gasPrice.value);

  if (predicted.ok) {
    count(`success:${op.kind}`);
    if (op.kind === "settle") {
      // I3: the supplier is paid exactly msg.value and the contract keeps nothing. The payer's cost is msg.value plus gas.
      const supplier = world.suppliers.find((s) => s.address.toLowerCase() === op.supplier.toLowerCase());
      expect(supplier, `${label}: supplier is one of the test suppliers`).toBeDefined();
      expect(after.byActor[supplier!.name] - before.byActor[supplier!.name], `${label}: I3 supplier delta`).toBe(op.value);
      expect(after.contract - before.contract, `${label}: I3 contract delta`).toBe(0n);
      expect(callerDelta, `${label}: I3 payer pays msg.value plus gas`).toBe(op.value + gasCharged);
      expect(gasCharged > 0n, `${label}: I3 the payer paid gas`).toBe(true);
    }
    if ((op.kind === "settle" || op.kind === "deposit") && m.limit > 0n) {
      // I4: after a successful spend the window total is within the limit.
      const spent = (await world.owner.clients.publicClient.readContract({ address: world.address, abi: world.abi, functionName: "dailySpent" })) as bigint;
      const limit = (await world.owner.clients.publicClient.readContract({ address: world.address, abi: world.abi, functionName: "dailySpendLimit" })) as bigint;
      expect(spent <= limit, `${label}: I4 dailySpent ${spent} exceeds the limit ${limit}`).toBe(true);
    }
    if (op.kind === "release" || op.kind === "refund") {
      // I5: a successful release or refund was made by the depositor or the owner.
      const esc = m.escrows.get(op.escrowId);
      const authorised = esc !== undefined && (caller.address.toLowerCase() === esc.depositor || caller.address.toLowerCase() === world.owner.address.toLowerCase());
      expect(authorised, `${label}: I5 a release or refund succeeded for an unauthorised caller`).toBe(true);
    }
  } else {
    count(`revert:${predicted.error}`);
    // I7: the contract state is unchanged, and the only balance that moves is the caller's gas.
    const fullAfter = await snapshot(world);
    const expected: StateSnapshot = {
      ...fullBefore!,
      byActor: { ...fullBefore!.byActor, [caller.name]: fullBefore!.byActor[caller.name] - gasCharged },
    };
    expect(fullAfter, `${label}: I7 a reverted call changed state other than the caller's gas`).toEqual(expected);

    // I6: an admin call by anyone but the owner reverts with Unauthorized.
    if ((op.kind === "setLimit" || op.kind === "setVendor" || op.kind === "setEnforce") && caller.address.toLowerCase() !== world.owner.address.toLowerCase()) {
      expect(predicted, `${label}: I6 a non-owner admin call`).toEqual(reverted("Unauthorized"));
    }
    // I5: a stranger (neither the owner nor the depositor) on an open escrow is refused with Unauthorized.
    if (op.kind === "release" || op.kind === "refund") {
      const esc = m.escrows.get(op.escrowId);
      const isStranger = esc !== undefined && caller.address.toLowerCase() !== esc.depositor && caller.address.toLowerCase() !== world.owner.address.toLowerCase();
      if (isStranger && !esc.released && !esc.refunded) {
        expect(predicted, `${label}: I5 a stranger on an open escrow`).toEqual(reverted("Unauthorized"));
      }
    }
  }

  m.limit = next.limit;
  m.dailySpent = next.dailySpent;
  m.lastDayReset = next.lastDayReset;
  m.enforce = next.enforce;
  m.vendors = next.vendors;
  m.settled = next.settled;
  m.escrows = next.escrows;
  m.clock = now;
}

async function runSeed(seed: number): Promise<void> {
  const rng = mulberry32(seed);
  const world = await setup();
  const deployedAt = BigInt(world.chain.currentTime());
  const m: Model = {
    limit: 0n,
    dailySpent: 0n,
    lastDayReset: deployedAt,
    enforce: false,
    vendors: new Map(),
    settled: new Map(),
    escrows: new Map(),
    clock: deployedAt,
  };
  const tracker: Tracker = { settledSeen: new Map(), escrowSeen: new Map() };
  const log: string[] = [];
  let step = 0;
  try {
    for (step = 0; step < STEPS; step++) {
      const op = randomOp(rng, world);
      const label = `seed ${seed} step ${step}`;
      log.push(`${step}: ${describeOp(op)}`);
      if (op.kind === "advance") {
        world.chain.advanceTime(op.seconds);
        m.clock += BigInt(op.seconds);
        count("advance");
      } else {
        await runWrite(world, m, op, label);
      }
      await checkState(world, m, tracker, label);
    }
  } catch (error) {
    const message = (error as Error).message.split("\n").slice(0, 14).join("\n");
    throw new Error(
      `property run failed: seed=${seed} step=${step} (reproduce: mulberry32(${seed}), ${STEPS} steps)\n${message}\nlast operations:\n${log.slice(-12).join("\n")}`
    );
  }
}

describe("BindSettlement property tests on the in-process EVM (LOCAL_PASS; not Forge invariant testing, not a proof)", () => {
  for (const seed of SEEDS) {
    it(`seed ${seed}: ${STEPS} random steps keep I1 to I7 and agree with the model`, async () => {
      await runSeed(seed);
    }, 240_000);
  }

  it("the random runs reach every outcome class, so the properties are not vacuous", () => {
    const required = [
      "success:settle",
      "success:deposit",
      "success:release",
      "success:refund",
      "success:setLimit",
      "success:setVendor",
      "success:setEnforce",
      "revert:OrderAlreadySettled",
      "revert:DailyLimitExceeded",
      "revert:VendorNotWhitelisted",
      "revert:Unauthorized",
      "revert:EscrowNotFound",
      "revert:EscrowAlreadySettled",
      "revert:InsufficientValue",
      "revert:EscrowAlreadyExists",
      "advance",
    ];
    const missing = required.filter((k) => !coverage.get(k));
    expect(missing, `outcome classes never reached: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("daily spend limit: the two behaviours the model exposes (named tests)", () => {
  it("a refund after the daily window reset reduces today's spent amount (known issue)", async () => {
    // KNOWN ISSUE (CONTRACT_SCOPE): a refund of an earlier window's escrow reduces the current window's spent amount, so the limit can be exceeded
    const owner = privateKeyToAccount(KEYS.owner).address;
    const p1Address = privateKeyToAccount(KEYS.p1).address;
    const supplier = privateKeyToAccount(KEYS.s1).address;
    const chain = await createLocalChain({ chainId: CHAIN_ID, startTime: START_TIME, balances: { [owner]: 100n * ONE, [p1Address]: 100n * ONE } });
    const deployed = await deployBindSettlement(chain, KEYS.owner);
    const p1 = viemClients(chain, KEYS.p1);
    const run = async (client: ViemClients, fn: string, args: unknown[], value = 0n) => {
      const hash = await client.walletClient.writeContract({ address: deployed.address, abi: deployed.abi, functionName: fn as never, args: args as never, value, gas: 500_000n });
      return client.publicClient.waitForTransactionReceipt({ hash });
    };
    const read = (fn: string, args: unknown[] = []): Promise<any> =>
      deployed.publicClient.readContract({ address: deployed.address, abi: deployed.abi, functionName: fn as never, args: args as never });
    const ownerClients = { publicClient: deployed.publicClient, walletClient: deployed.walletClient, account: deployed.account };

    expect((await run(ownerClients, "setDailyLimit", [10n * ONE])).status).toBe("success");

    // Day 1: a 4 USDC escrow from P1.
    const escrowId = keccak256(toHex("known_issue_escrow"));
    expect((await run(p1, "depositEscrow", [escrowId, supplier, MATCH], 4n * ONE)).status).toBe("success");
    expect(await read("dailySpent")).toBe(4n * ONE);

    // Day 2: more than 24 hours later, a 5 USDC settlement resets the window and is counted in it.
    chain.advanceTime(86_400 + 1);
    expect((await run(ownerClients, "settleOrder", [keccak256(toHex("known_issue_day2")), supplier, MATCH], 5n * ONE)).status).toBe("success");
    expect(await read("dailySpent")).toBe(5n * ONE);

    // Refund the day-1 escrow. The contract subtracts its 4 USDC from today's window (the current behaviour).
    expect((await run(p1, "refundEscrow", [escrowId])).status).toBe("success");
    expect(await read("dailySpent"), "dropped by the refunded amount (current behaviour)").toBe(1n * ONE);

    // The consequence: 5 + 9 = 14 USDC were settled in this window against a 10 USDC limit, and the 9 USDC call succeeds.
    expect((await run(ownerClients, "settleOrder", [keccak256(toHex("known_issue_day2b")), supplier, MATCH], 9n * ONE)).status).toBe("success");
    expect(await read("dailySpent")).toBe(10n * ONE);
    const settledInWindow = 5n * ONE + 9n * ONE;
    expect(settledInWindow > 10n * ONE, "the limit was exceeded in this window (known issue)").toBe(true);
  });

  it("the daily limit is a fixed window reset, not a rolling window", async () => {
    // A spend stops counting at the reset (the first spend at or after lastDayReset + 24h), not 24h after it was made.
    const owner = privateKeyToAccount(KEYS.owner).address;
    const supplier = privateKeyToAccount(KEYS.s1).address;
    const chain = await createLocalChain({ chainId: CHAIN_ID, startTime: START_TIME, balances: { [owner]: 100n * ONE } });
    const d = await deployBindSettlement(chain, KEYS.owner);
    const send = async (fn: string, args: unknown[], value = 0n) => {
      const hash = await d.walletClient.writeContract({ address: d.address, abi: d.abi, functionName: fn as never, args: args as never, value, gas: 500_000n });
      return d.publicClient.waitForTransactionReceipt({ hash });
    };
    const read = (fn: string, args: unknown[] = []): Promise<any> =>
      d.publicClient.readContract({ address: d.address, abi: d.abi, functionName: fn as never, args: args as never });

    expect((await send("setDailyLimit", [10n * ONE])).status).toBe("success");
    const lastDayReset = (await read("lastDayReset")) as bigint;

    // Part 1: spend 9 at the start of the window. After 23h59m, the next 2 is blocked.
    expect((await send("settleOrder", [keccak256(toHex("fw_1")), supplier, MATCH], 9n * ONE)).status).toBe("success");
    chain.advanceTime(23 * 3600 + 59 * 60);
    expect(BigInt(chain.currentTime()) < lastDayReset + DAY, "still inside the window").toBe(true);
    const blocked = await simulateRevert(d.publicClient, d.address, d.abi, owner, "settleOrder", [keccak256(toHex("fw_2")), supplier, MATCH], 2n * ONE);
    expect(blocked.errorName).toBe("DailyLimitExceeded");
    expect(blocked.args).toEqual([11n * ONE, 10n * ONE]);

    // Part 2: past 24 hours from lastDayReset, the same 2 is allowed, and the window restarts at this call.
    chain.advanceTime(120);
    expect(BigInt(chain.currentTime()) >= lastDayReset + DAY, "past the window").toBe(true);
    expect((await send("settleOrder", [keccak256(toHex("fw_3")), supplier, MATCH], 2n * ONE)).status).toBe("success");
    expect(await read("dailySpent")).toBe(2n * ONE);
    expect(await read("lastDayReset")).toBe(BigInt(chain.currentTime()));

    // Part 3, the case that tells a fixed window from a rolling one: on a new chain, 9 is spent late in the window. A
    // rolling window would still count it 1000 seconds later and block the next 9. The fixed window does not count it
    // after the reset, so the next 9 is allowed.
    const chain2 = await createLocalChain({ chainId: CHAIN_ID, startTime: START_TIME, balances: { [owner]: 100n * ONE } });
    const d2 = await deployBindSettlement(chain2, KEYS.owner);
    const send2 = async (fn: string, args: unknown[], value = 0n) => {
      const hash = await d2.walletClient.writeContract({ address: d2.address, abi: d2.abi, functionName: fn as never, args: args as never, value, gas: 500_000n });
      return d2.publicClient.waitForTransactionReceipt({ hash });
    };
    expect((await send2("setDailyLimit", [10n * ONE])).status).toBe("success");
    chain2.advanceTime(86_000);
    expect((await send2("settleOrder", [keccak256(toHex("late_1")), supplier, MATCH], 9n * ONE)).status).toBe("success");
    chain2.advanceTime(1000);
    expect((await send2("settleOrder", [keccak256(toHex("late_2")), supplier, MATCH], 9n * ONE)).status, "allowed: the window reset at this call").toBe("success");
    expect(await d2.publicClient.readContract({ address: d2.address, abi: d2.abi, functionName: "dailySpent" })).toBe(9n * ONE);
  });
});

async function simulateRevert(
  publicClient: ViemClients["publicClient"],
  address: Address,
  abi: any,
  from: Address,
  fn: string,
  args: unknown[],
  value: bigint
): Promise<{ errorName: string; args: readonly unknown[] }> {
  const data = encodeFunctionData({ abi, functionName: fn as never, args: args as never });
  try {
    await publicClient.call({ account: from, to: address, data, value });
  } catch (error) {
    const decoded = decodeRevert(abi, error);
    if (decoded) return decoded;
    throw error;
  }
  throw new Error(`expected ${fn} to revert`);
}
