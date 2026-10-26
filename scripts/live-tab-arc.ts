/**
 * Live sub-cent tab settlement on Arc testnet (opt-in, spends testnet USDC). It proves three things about the tab ledger
 * (docs/decisions/0081): a settlement pays exactly once, a crash after the send is recovered without a second send, and a
 * held settlement whose outcome is unknown is adopted, not re-sent and not reversed. Each scenario sends EXACTLY ONE payment
 * of exactly 1 cent (0.01 USDC) to the whitelisted vendor, through Bind's own code: TabLedger (accrueCharge, settleTab,
 * executeSettlement, confirmSettlement, reconcileHeld, cancelHeldAndRestore), the tab worker's tick (runTick) and
 * ArcL1SettlementAdapter. The harness never calls transferUSDC itself and never retries a send after a failure.
 *
 * Live (spends 0.01 USDC of testnet funds per scenario, 0.03 USDC plus gas for all three):
 *   npx tsx scripts/live-tab-arc.ts <settle|crash-after-send|held-adopt> --confirm-testnet-spend [--state <file>] [--write-evidence <new-file>] [--fresh]
 * Resume a started send (sends nothing; the chain decides: paid -> recover and verify; not sent -> refused; ambiguous -> hard stop):
 *   npx tsx scripts/live-tab-arc.ts <scenario> --resume --confirm-testnet-spend --state <file> [--write-evidence <new-file>]
 * Read-only preflight (arc; spawns nothing, sends nothing, writes nothing):
 *   npx tsx scripts/live-tab-arc.ts <scenario> --preflight
 * Offline rehearsal (no network, no spend; chain reads and chain assertions are skipped and labelled as such):
 *   npx tsx scripts/live-tab-arc.ts <scenario> --adapter local-sim [--state <file>] [--write-evidence <new-file>]
 *
 * --fresh starts a NEW payment of 0.01 USDC. It is refused unless the chain proves a prior started send was not made, and it
 * never bypasses the total cap (3 payments, counted on chain and in .live-state/tab-spend-ledger.jsonl). A second send for a
 * scenario is refused without it. See docs/RUNBOOK.md section 16.4 and docs/decisions/0090.
 *
 * Environment (names only, never printed or written): ARC_RPC_URL, ARC_SIGNER_PRIVATE_KEY, BIND_SETTLEMENT_ADDRESS (must be
 * 0x16E1Bd42F7C0FfD28D10919C87CaD22d05f2aA29), BIND_SETTLEMENT_DEPLOY_BLOCK, DATABASE_URL (a local host only, and a dedicated
 * database: see docs/RUNBOOK.md section 16.4). NODE_ENV must not be production; SETTLEMENT_MODE, if set, must be arc-testnet.
 *
 * Exit codes: 0 PASS (or PREFLIGHT_READY), 1 FAIL (an unexpected state or a failed assertion; nothing further is sent), 2 REFUSED
 * or BLOCKED (a guard or a read stopped the run before any send), 3 SUBMITTED_UNCONFIRMED (a transaction was broadcast and is not
 * confirmed: never a PASS, never reported as confirmed). Every output and written file goes through src/utils/redact.ts with
 * the RPC URL, its path segments, the signer key and the database URL as extra secrets.
 *
 * The children (send-child, recover-child) are this script run again under tsx, one process each. They are the only code
 * that can send, and each one re-checks every guard before its first possible broadcast.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  custom,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type Transport,
} from "viem";
import { ArcL1SettlementAdapter, centsToNativeWei } from "../src/adapters/settlement/arc-l1.js";
import { BIND_SETTLEMENT_ABI } from "../src/adapters/settlement/bind-settlement.abi.js";
import { ARC_LOG_CHUNK_BLOCKS, collectLogs, rangeLimitOfError } from "../src/adapters/settlement/log-scan.js";
import { LocalSettlementSimulator } from "../src/adapters/settlement/local-sim.js";
import type { SettlementAdapter, TransferRequest, TransferResult } from "../src/adapters/settlement/types.js";
import { centsToMicro, ledgerKeys, tabAdapterOrderId } from "../src/tabs/units.js";
import type { TabActor, RestoreOutcome, ReconcileOutcome, ExecuteOutcome } from "../src/tabs/ledger.js";
import {
  APPROVED_SETTLEMENT_ADDRESS,
  ARC_TESTNET_CHAIN_ID,
  BlockedError,
  PAYMENT_CENTS,
  PAYMENT_LABEL,
  RefusedError,
  VENDOR_ADDRESS,
  assertContractGuards,
  assertDeployBlockCode,
  databaseHostProblem,
  httpRpc,
  jsonText,
  makeScrubber,
  makeTimeoutTransport,
  oneCentInBaseUnits,
  readDecimals,
  readNonce,
  readReceipt,
  readSettledOrder,
  readSettlementLogs,
  readVendorBalance,
  realFiles,
  signerAddressOf,
  verdictOf,
  waitUntil,
  type Assertion,
  type AdapterKind,
  type ChildOutcome,
  type Env,
  type LogFact,
  type ReceiptFact,
  type RpcCall,
  type RunResult,
} from "./live-recovery-arc.js";

// ---------------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------------

export const SCENARIOS = ["settle", "crash-after-send", "held-adopt"] as const;
export type TabScenario = (typeof SCENARIOS)[number];
export type ChildPhase = "send" | "recover";

/** Each sub-cent charge the harness records. Three of them make 15_000 micro-USDC, which floors to exactly one cent. */
export const CHARGE_MICRO = 5_000n;
export const CHARGE_COUNT = 3;
/** The settlement that is expected: one cent, and the 5_000 micro left over carries over. */
export const TAB_TOTAL_MICRO = CHARGE_MICRO * BigInt(CHARGE_COUNT);
export const SETTLEMENT_MICRO = centsToMicro(PAYMENT_CENTS);
export const REMAINDER_MICRO = TAB_TOTAL_MICRO - SETTLEMENT_MICRO;
export const TAB_ACTOR: TabActor = { type: "system", id: "live-tab-arc" };
/** The local simulator's seeded treasury: the payer of a rehearsal (no key exists for it). */
export const LOCAL_SIM_PAYER = "0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2";

/** The payer address: the signer's (derived in process from the key) or, for a rehearsal, the simulator's treasury. */
function payerOf(env: Env): string {
  return signerAddressOf(env.ARC_SIGNER_PRIVATE_KEY) ?? LOCAL_SIM_PAYER;
}

/** Printed by the send child right before it kills itself, so a SIGKILL from anywhere else is not mistaken for the crash. */
export const KILL_ARMED_MARK = "LIVE_TAB_KILL_ARMED";
const RESULT_PREFIX = "LIVE_TAB_RESULT ";
/** Printed for every transaction the child attempts to broadcast, before it is forwarded (so a killed child still reports it). */
const BROADCAST_PREFIX = "LIVE_TAB_BROADCAST ";
const MINE_WAIT_MS = 90_000;
const POLL_MS = 2_000;
const CHILD_TIMEOUT_MS = 10 * 60_000;
/** A held settlement's effect is aged by this much in the local database, so the chain lookup is what refuses (see step 4). */
const RESTORE_AGE_FIXTURE_MINUTES = 31;
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
/** The tick is anchored a minute ahead, so a row the database clock stamped a moment ago still counts as stale. */
const TICK_CLOCK_MARGIN_MS = 60_000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const TAB_STATE_HARNESS = "live-tab-arc";

/**
 * The hard total cap: every payment this harness can make, across all scenarios, runs and state files, is counted. The
 * cap is checked against the chain (the signer's SettlementExecuted logs to the vendor, from the deploy block) and against
 * the spend ledger (one record per send attempt, written before the broadcast). Either one at the cap refuses the send.
 */
export const TOTAL_CAP_PAYMENTS = 3;
/** The gas margin the signer must hold on top of one cent: 0.003 USDC, in the native 18-decimal token (Arc). */
export const GAS_MARGIN_NATIVE_WEI = 3n * 10n ** 15n;
/** The native amount of one cent (1 cent = 1e16 wei), the same conversion the Arc adapter sends with. */
export const PAYMENT_NATIVE_WEI = centsToNativeWei(PAYMENT_CENTS);
/** The spend ledger lives in the repository's git-ignored .live-state directory, never in the temporary directory. */
export const DEFAULT_SPEND_LEDGER = path.join(os.homedir(), ".bind-live-state", "tab-spend-ledger.jsonl");
/**
 * The approved contract's deploy block: the block of the deployment that created APPROVED_SETTLEMENT_ADDRESS (recorded in
 * docs/RELEASE_EVIDENCE.md, the deployment receipts, L9). An operator override may only be this block or lower.
 */
export const APPROVED_DEPLOY_BLOCK = 67155017n;
/** The block the harness scans from: the approved one, or the operator's override when it is not higher (see tabStaticGuards). */
export function effectiveDeployBlock(env: Env): bigint {
  const override = env.BIND_SETTLEMENT_DEPLOY_BLOCK;
  if (override === undefined || !/^\d+$/.test(override)) return APPROVED_DEPLOY_BLOCK;
  const value = BigInt(override);
  return value > APPROVED_DEPLOY_BLOCK ? APPROVED_DEPLOY_BLOCK : value;
}
/** Exit code for a send that was broadcast but is not confirmed: neither a PASS nor a plain FAIL. */
export const EXIT_SUBMITTED_UNCONFIRMED = 3;
export type TabRunResult = RunResult | "SUBMITTED_UNCONFIRMED";

// ---------------------------------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------------------------------

export interface TabCliArgs {
  scenario: TabScenario;
  phase: "orchestrate" | "send-child" | "recover-child";
  adapter: AdapterKind;
  confirmTestnetSpend: boolean;
  writeEvidence?: string;
  statePath: string;
  fresh: boolean;
  resume: boolean;
  /** Read-only: reads the chain and the database, prints the plan, sends and spawns nothing, writes nothing. */
  preflight?: boolean;
}

export const USAGE =
  "usage: live-tab-arc.ts <scenario> [--preflight] [--confirm-testnet-spend] [--adapter arc|local-sim] [--write-evidence <new-file>] " +
  "[--state <file>] [--fresh] [--resume]; scenarios: " +
  SCENARIOS.join(" | ") +
  ". --fresh starts a NEW payment of 0.01 USDC: use it only on purpose, and never after a send whose outcome is not proven not-sent.";

const PHASES = ["orchestrate", "send-child", "recover-child"] as const;

/** Parses the command line. There is no option for the amount, the recipient, the contract or the RPC: an unknown option is refused. */
export function parseTabArgs(argv: string[], tmpDir: string = os.tmpdir()): TabCliArgs {
  const positional: string[] = [];
  let confirmTestnetSpend = false;
  let fresh = false;
  let resume = false;
  let writeEvidence: string | undefined;
  let statePath: string | undefined;
  let adapter: string = "arc";
  let phase: string = "orchestrate";
  let preflight = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (name: string): string => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${name} needs a value. ${USAGE}`);
      i++;
      return next;
    };
    if (arg === "--confirm-testnet-spend") confirmTestnetSpend = true;
    else if (arg === "--fresh") fresh = true;
    else if (arg === "--resume") resume = true;
    else if (arg === "--preflight") preflight = true;
    else if (arg === "--write-evidence") writeEvidence = value(arg);
    else if (arg === "--state") statePath = value(arg);
    else if (arg === "--adapter") adapter = value(arg);
    else if (arg === "--phase") phase = value(arg);
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg.split("=")[0]}. ${USAGE}`);
    else positional.push(arg);
  }
  if (positional.length !== 1) throw new Error(USAGE);
  const scenario = positional[0];
  if (!(SCENARIOS as readonly string[]).includes(scenario)) throw new Error(`unknown scenario. ${USAGE}`);
  if (adapter !== "arc" && adapter !== "local-sim") throw new Error(`--adapter must be arc or local-sim. ${USAGE}`);
  if (!(PHASES as readonly string[]).includes(phase)) throw new Error(`unknown phase. ${USAGE}`);
  if (resume && phase !== "orchestrate") throw new Error(`--resume is used with the orchestrate phase only. ${USAGE}`);
  if (preflight && (fresh || resume || writeEvidence !== undefined || phase !== "orchestrate")) {
    throw new Error(`--preflight writes nothing and sends nothing: it takes no --fresh, --resume, --write-evidence or --phase. ${USAGE}`);
  }
  return {
    scenario: scenario as TabScenario,
    phase: phase as TabCliArgs["phase"],
    adapter: adapter as AdapterKind,
    confirmTestnetSpend,
    writeEvidence,
    statePath: statePath ?? path.join(tmpDir, `bind-live-tab-${scenario}.json`),
    fresh,
    resume,
    ...(preflight ? { preflight: true } : {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Static guards (no network): run first, in the orchestrator and again in every child
// ---------------------------------------------------------------------------------------------------------------------

export interface GuardFailure {
  guard: string;
  reason: string;
}

function isHttpUrl(value: string | undefined): boolean {
  if (!value || !/^https?:\/\//i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** True when the RPC URL points at this machine. Used only to label evidence; it never changes what is sent. */
export function isLoopbackRpcUrl(value: string | undefined): boolean {
  if (!value || !isHttpUrl(value)) return false;
  const host = new URL(value).hostname.toLowerCase();
  return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
}

/** Every static guard. Each failure names the rule, never a value. An empty list means the static guards pass. */
export function tabStaticGuards(env: Env, args: Pick<TabCliArgs, "adapter" | "confirmTestnetSpend" | "writeEvidence">, evidenceExists: boolean): GuardFailure[] {
  const failures: GuardFailure[] = [];
  const add = (guard: string, reason: string): void => {
    failures.push({ guard, reason });
  };
  const arc = args.adapter === "arc";
  if (arc && !args.confirmTestnetSpend) {
    add("confirm-flag", `pass --confirm-testnet-spend: each scenario sends one ${PAYMENT_LABEL} on Arc testnet`);
  }
  if (env.NODE_ENV === "production") add("node-env", "NODE_ENV is production");
  const dbProblem = databaseHostProblem(env.DATABASE_URL);
  if (dbProblem !== undefined) add("database-host", dbProblem);
  if (env.SETTLEMENT_MODE !== undefined && env.SETTLEMENT_MODE !== "arc-testnet") {
    add("settlement-mode", "SETTLEMENT_MODE is set to something other than arc-testnet");
  }
  if (args.writeEvidence !== undefined && evidenceExists) {
    add("evidence-file", "the --write-evidence file already exists; choose a new file name");
  }
  if (arc) {
    const contract = env.BIND_SETTLEMENT_ADDRESS;
    if (!contract || !isAddress(contract) || contract.toLowerCase() !== APPROVED_SETTLEMENT_ADDRESS.toLowerCase()) {
      add("settlement-address", "BIND_SETTLEMENT_ADDRESS is not the owner-approved contract address");
    }
    const override = env.BIND_SETTLEMENT_DEPLOY_BLOCK;
    if (override !== undefined && (!/^\d+$/.test(override) || BigInt(override) > APPROVED_DEPLOY_BLOCK)) {
      add("deploy-block", "BIND_SETTLEMENT_DEPLOY_BLOCK, when set, must be a non-negative integer no higher than the approved deploy block");
    }
    if (!isHttpUrl(env.ARC_RPC_URL)) add("rpc-url", "ARC_RPC_URL is not set or is not an http(s) URL");
    if (signerAddressOf(env.ARC_SIGNER_PRIVATE_KEY) === undefined) {
      add("signer-key", "ARC_SIGNER_PRIVATE_KEY is not set or is not a 32-byte hex key");
    }
  } else if (env.ARC_RPC_URL || env.ARC_SIGNER_PRIVATE_KEY) {
    add("local-sim-offline", "local-sim requires ARC_RPC_URL and ARC_SIGNER_PRIVATE_KEY to be unset");
  }
  return failures;
}

// ---------------------------------------------------------------------------------------------------------------------
// Amount and pin guards (pure)
// ---------------------------------------------------------------------------------------------------------------------

function sameAddress(a: string, b: string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/** A settlement amount is exactly one cent, in whole cents. Anything else is refused before a send. */
export function assertOneCentSettlement(amountCents: string | bigint): void {
  const refusal = new RefusedError([`the settlement amount is not ${PAYMENT_LABEL}; nothing is sent`]);
  // A string that is not a whole number is refused the same way as a wrong amount (BigInt would throw a SyntaxError here).
  if (typeof amountCents === "string" && !/^\d+$/.test(amountCents)) throw refusal;
  if (BigInt(amountCents) !== PAYMENT_CENTS) throw refusal;
}

/** The settlement a transfer names must be a pending one-cent settlement of this tab. Checked in the database before a send. */
export async function pinSettlement(
  db: { settlementRow(workspaceId: string, settlementId: string): Promise<SettlementRowView | null> },
  workspaceId: string,
  counterpartyId: string,
  orderId: string
): Promise<void> {
  if (!orderId.startsWith("tab_") || orderId.length <= 4) {
    throw new RefusedError(["the transfer is not a tab settlement order id; nothing is sent"]);
  }
  const row = await db.settlementRow(workspaceId, orderId.slice(4));
  if (!row || row.counterpartyId !== counterpartyId) {
    throw new RefusedError(["the transfer's order id is not a settlement of this tab; nothing is sent"]);
  }
  if (row.status !== "pending") throw new RefusedError([`the settlement is ${row.status}, not pending; nothing is sent`]);
  assertOneCentSettlement(row.amountCents);
}

export interface SettlementRowView {
  id: string;
  counterpartyId: string;
  status: string;
  amountCents: string;
}

export interface TabSendHooks {
  /** Releases the spend lock the hook took. The child calls it when it exits, so the lock is held until then. */
  release?(): void;
  /** Before every transferUSDC: the database pin, then the chain reads (chain id, owner, whitelist, settledOrders). */
  beforeTransfer(req: TransferRequest): Promise<void>;
  /** After the real transfer returned a result. A throw here reaches the ledger as an unknown outcome. */
  afterTransfer?(result: TransferResult): Promise<void>;
  /** On entry to confirm (the state the confirmation sees is recorded by the caller). */
  beforeConfirm?(txHash: string): Promise<void>;
}

export interface GuardedTabAdapter {
  adapter: SettlementAdapter;
  /** How many times the real adapter's transferUSDC was called. Each call may broadcast. */
  transferCalls(): number;
}

/**
 * Wraps the adapter. A transfer is refused unless it is exactly one cent, pays from the signer, pays the pinned vendor and
 * names a tab settlement. The synchronous pins run first, then the hooks (the database pin and the chain reads), so a bad
 * request never reaches the chain. Reads (findTransfer, isOrderSettled, confirm) pass through.
 */
export function tabGuardedAdapter(
  inner: SettlementAdapter,
  hooks: TabSendHooks,
  pins: { payer: string; vendor: string }
): GuardedTabAdapter {
  let calls = 0;
  const adapter: SettlementAdapter = {
    mode: inner.mode,
    getBalance: (address: string) => inner.getBalance(address),
    transferUSDC: async (req: TransferRequest): Promise<TransferResult> => {
      // One payment per process, whatever the ledger does after a failure: a second transfer in the same process is refused.
      if (calls >= 1) throw new RefusedError(["a second payment in one process is refused; nothing is sent"]);
      if (req.amountCents !== PAYMENT_CENTS) throw new RefusedError([`the amount is not ${PAYMENT_LABEL}; nothing is sent`]);
      if (!sameAddress(req.fromAddress, pins.payer)) throw new RefusedError(["the transfer does not pay from the signer; nothing is sent"]);
      if (!sameAddress(req.toAddress, pins.vendor)) throw new RefusedError(["the transfer does not pay the pinned vendor; nothing is sent"]);
      if (!req.orderId.startsWith("tab_")) throw new RefusedError(["the transfer is not a tab settlement; nothing is sent"]);
      await hooks.beforeTransfer(req);
      calls += 1;
      const result = await inner.transferUSDC(req);
      await hooks.afterTransfer?.(result);
      return result;
    },
    confirm: async (txHash: string): Promise<TransferResult> => {
      await hooks.beforeConfirm?.(txHash);
      return inner.confirm(txHash);
    },
    findTransfer: inner.findTransfer ? (req: { orderId: string }) => inner.findTransfer!(req) : undefined,
    isOrderSettled: inner.isOrderSettled ? (orderId: string) => inner.isOrderSettled!(orderId) : undefined,
    depositEscrow: async () => {
      throw new RefusedError(["escrow is not used by a tab; nothing is sent"]);
    },
    releaseEscrow: async () => {
      throw new RefusedError(["escrow is not used by a tab; nothing is sent"]);
    },
  };
  return { adapter, transferCalls: () => calls };
}

// ---------------------------------------------------------------------------------------------------------------------
// Transports and the local adapter
// ---------------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------------
// The total cap, the spend ledger, the signer's balance and the pre-send simulation (checked before every send)
// ---------------------------------------------------------------------------------------------------------------------

/** One record per send attempt, written before the broadcast. A record is never edited or removed by the harness. */
export interface SpendRecord {
  kind: "intent";
  at: string;
  scenario: TabScenario;
  workspaceId: string;
  settlementId: string;
}

export interface SpendLock {
  release(): void;
}

export interface SpendLedger {
  /** Every record. A ledger that cannot be read, or holds a line that is not a record, throws (BLOCKED), never reads as empty. */
  read(): SpendRecord[];
  append(record: SpendRecord): void;
  /**
   * Takes the one lock for the cap check and the append. A lock file that exists, whoever wrote it and whether or not its owner
   * is still running, refuses (RefusedError). A lock is never broken automatically.
   */
  acquire(): SpendLock;
  /** True while a lock file exists. Read-only. */
  isLocked(): boolean;
}

const LOCK_HELD_REASON =
  "a live tab payment lock is held (the spend lock file exists). Its owner may still be running, or may have died after a broadcast, so the lock is never broken automatically. Inspect the chain and the ledger, confirm no live-tab process is running, then remove the lock file by hand. Nothing is sent";

/** The real ledger: a JSON-lines file in the operator's home directory, and an O_EXCL lock file beside it. */
export function realSpendLedger(file: string = DEFAULT_SPEND_LEDGER): SpendLedger {
  const lockFile = `${file}.lock`;
  return {
    read() {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw new BlockedError("the spend ledger cannot be read; nothing is sent");
      }
      const records: SpendRecord[] = [];
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        try {
          records.push(JSON.parse(line) as SpendRecord);
        } catch {
          throw new BlockedError("the spend ledger holds a line that is not a record; it is never reset: inspect it. Nothing is sent");
        }
      }
      return records;
    },
    append(record) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(file, "a", 0o600);
      try {
        fs.writeSync(fd, `${JSON.stringify(record)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
    acquire() {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const token = crypto.randomBytes(16).toString("hex");
      let fd: number;
      try {
        fd = fs.openSync(lockFile, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RefusedError([LOCK_HELD_REASON]);
        throw new BlockedError("the spend lock cannot be taken; nothing is sent");
      }
      try {
        fs.writeSync(fd, `${JSON.stringify({ token, pid: process.pid, at: new Date().toISOString() })}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return {
        release() {
          // Removes only the lock this handle wrote. Another owner's lock, or a missing one, is left as it is.
          try {
            const held = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { token?: string };
            if (held.token === token) fs.rmSync(lockFile, { force: true });
          } catch {
            // Nothing to release: the file is gone or unreadable. It is never removed on a guess.
          }
        },
      };
    },
    isLocked() {
      return fs.existsSync(lockFile);
    },
  };
}

/** Refusals of the total cap (pure). Empty when another payment is allowed. */
export function totalCapReasons(chainPayments: number, ledgerAttempts: number): string[] {
  const reasons: string[] = [];
  if (chainPayments >= TOTAL_CAP_PAYMENTS) {
    reasons.push(
      `the total cap is reached: the chain shows ${chainPayments} payment(s) from the signer to the vendor, the cap is ${TOTAL_CAP_PAYMENTS} (0.03 USDC); nothing is sent`
    );
  }
  if (ledgerAttempts >= TOTAL_CAP_PAYMENTS) {
    reasons.push(
      `the total cap is reached: the spend ledger holds ${ledgerAttempts} send attempt(s), the cap is ${TOTAL_CAP_PAYMENTS} (0.03 USDC); nothing is sent`
    );
  }
  return reasons;
}

/** The signer must hold one cent plus the gas margin, in the native token (pure). */
export function balanceReasons(balanceWei: bigint): string[] {
  if (balanceWei >= PAYMENT_NATIVE_WEI + GAS_MARGIN_NATIVE_WEI) return [];
  return ["the signer's balance is below one cent plus the 0.003 USDC gas margin; nothing is sent"];
}

/** The settleOrder call the Arc adapter sends for a transfer, built the same way (keccak of the order id, the supplier, the match hash). */
export function settleOrderCall(input: { contract: string; orderId: string; supplier: string; matchHash: string }): { to: string; data: Hex; value: bigint } {
  return {
    to: input.contract,
    data: encodeFunctionData({
      abi: BIND_SETTLEMENT_ABI,
      functionName: "settleOrder",
      args: [keccak256(toHex(input.orderId)), getAddress(input.supplier), input.matchHash as Hex],
    }),
    value: PAYMENT_NATIVE_WEI,
  };
}

/** The signer's native balance at the latest block. A failed or malformed read is BLOCKED: nothing is sent. */
export async function readNativeBalance(rpc: RpcCall, address: string): Promise<bigint> {
  let answer: unknown;
  try {
    answer = await rpc("eth_getBalance", [address, "latest"]);
  } catch (error) {
    throw new BlockedError(`the balance read failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (typeof answer !== "string" || !/^0x[0-9a-fA-F]+$/.test(answer)) throw new BlockedError("unexpected RPC answer for eth_getBalance");
  return BigInt(answer);
}

/**
 * The pre-send simulation: eth_estimateGas of the exact settleOrder call, from the signer. It must succeed. Any failure, a
 * node refusal or a network error alike, refuses the send (nothing is broadcast).
 */
export async function assertSimulates(rpc: RpcCall, from: string, call: { to: string; data: Hex; value: bigint }): Promise<void> {
  const refusal = () => new RefusedError(["the pre-send simulation (eth_estimateGas) did not succeed for this settlement; nothing is sent"]);
  let answer: unknown;
  try {
    answer = await rpc("eth_estimateGas", [{ from, to: call.to, data: call.data, value: `0x${call.value.toString(16)}` }]);
  } catch {
    throw refusal();
  }
  if (typeof answer !== "string" || !/^0x[0-9a-fA-F]+$/.test(answer) || BigInt(answer) === 0n) throw refusal();
}

/** Every payment from the signer to the vendor, from the deploy block to the head. A failed window throws (BLOCKED). */
export async function countVendorPayments(rpc: RpcCall, contract: string, payer: string, vendor: string, deployBlock: bigint): Promise<number> {
  return (await readPaymentsFromSigner(rpc, contract, payer, deployBlock, vendor)).length;
}

/**
 * The order must be unpaid on chain: the contract's settledOrders is false and no SettlementExecuted exists for it. Either one
 * refuses (RefusedError) before a broadcast.
 */
export async function assertOrderUnpaid(rpc: RpcCall, contract: string, orderId: string, deployBlock: bigint): Promise<void> {
  if (await readSettledOrder(rpc, contract, orderId)) throw new RefusedError(["the contract already settled this order; nothing is broadcast"]);
  const logs = await readSettlementLogs(rpc, contract, orderId, deployBlock);
  if (logs.length > 0) throw new RefusedError(["the chain already shows a payment for this order; nothing is broadcast"]);
}

/**
 * No code before the deploy block: at deployBlock-1 the address must hold no code, so the scan starts no later than the
 * deployment. Code there means the scan would start too late. A failed read is BLOCKED.
 */
export async function assertNoCodeBefore(rpc: RpcCall, contract: string, deployBlock: bigint): Promise<void> {
  if (deployBlock === 0n) return;
  let code: unknown;
  try {
    code = await rpc("eth_getCode", [contract, `0x${(deployBlock - 1n).toString(16)}`]);
  } catch (error) {
    throw new BlockedError(`the code read before the deploy block failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (typeof code !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(code)) {
    throw new BlockedError("unexpected RPC answer for eth_getCode before the deploy block");
  }
  if (code.length > 2) throw new RefusedError(["the contract has code before the deploy block: the scan would start too late; nothing is sent"]);
}

export interface CapCheckConfig {
  rpc: RpcCall;
  spend: SpendLedger;
  contract: string;
  signer: string;
  vendor: string;
  deployBlock: bigint;
}

/** The cap and the balance, read fresh. Shared by the orchestrator (before the spawn) and the child (before each broadcast). */
export async function assertCapAndBalance(cfg: CapCheckConfig): Promise<{ chainPayments: number; ledgerAttempts: number }> {
  const chainPayments = await countVendorPayments(cfg.rpc, cfg.contract, cfg.signer, cfg.vendor, cfg.deployBlock);
  const ledgerAttempts = cfg.spend.read().length;
  const reasons = [...totalCapReasons(chainPayments, ledgerAttempts)];
  reasons.push(...balanceReasons(await readNativeBalance(cfg.rpc, cfg.signer)));
  if (reasons.length > 0) throw new RefusedError(reasons);
  return { chainPayments, ledgerAttempts };
}

export interface SendHookConfig extends CapCheckConfig {
  db: { settlementRow(workspaceId: string, settlementId: string): Promise<SettlementRowView | null> };
  workspaceId: string;
  counterpartyId: string;
  scenario: TabScenario;
  /** False for the local rehearsal: no chain reads and no ledger. */
  onChain: boolean;
}

/**
 * The child's hooks, in the order every transfer meets them: the database pin, the contract guards, the order unpaid on
 * chain, the total cap, the balance, the simulation, and only then the ledger intent (written before the broadcast). A
 * refusal at any step means nothing is broadcast. The ledger intent is written even if the broadcast then fails.
 */
export function buildSendHooks(cfg: SendHookConfig): TabSendHooks {
  let held: SpendLock | undefined;
  return {
    beforeTransfer: async (req: TransferRequest) => {
      await pinSettlement(cfg.db, cfg.workspaceId, cfg.counterpartyId, req.orderId);
      if (!cfg.onChain) return;
      await assertContractGuards(cfg.rpc, { contract: cfg.contract, signer: cfg.signer, vendor: cfg.vendor });
      await assertOrderUnpaid(cfg.rpc, cfg.contract, req.orderId, cfg.deployBlock);
      // The cap check and the append are one critical section. The lock is held from here until this process exits (the
      // child releases it), so two runs cannot both see room under the cap. A refusal before the append releases it here.
      const lock = cfg.spend.acquire();
      try {
        const latest = await readNonce(cfg.rpc, cfg.signer, "latest");
        const pending = await readNonce(cfg.rpc, cfg.signer, "pending");
        if (pending !== latest) throw new RefusedError(["the signer has a transaction in flight; nothing is broadcast"]);
        await assertCapAndBalance(cfg);
        await assertSimulates(
          cfg.rpc,
          cfg.signer,
          settleOrderCall({ contract: cfg.contract, orderId: req.orderId, supplier: req.toAddress, matchHash: req.matchHash ?? "" })
        );
        cfg.spend.append({
          kind: "intent",
          at: new Date().toISOString(),
          scenario: cfg.scenario,
          workspaceId: cfg.workspaceId,
          settlementId: req.orderId.slice("tab_".length),
        });
        // Re-read after the append: a writer that did not take the lock could have added records since the check.
        const after = cfg.spend.read().length;
        if (after > TOTAL_CAP_PAYMENTS) {
          throw new RefusedError([
            `the spend ledger holds ${after} attempts after this one, over the cap of ${TOTAL_CAP_PAYMENTS}; nothing is broadcast`,
          ]);
        }
      } catch (error) {
        lock.release();
        throw error;
      }
      held = lock;
    },
    release: () => {
      held?.release();
      held = undefined;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Safe resume: what the chain proves about a send that started but has no recorded result (pure classification)
// ---------------------------------------------------------------------------------------------------------------------

export type SendOutcome = "PAID" | "NOT_SENT" | "AMBIGUOUS";

export interface SendFacts {
  /** SettlementExecuted logs for this run's order id (0 when the send never reserved a settlement). */
  orderLogs: number;
  orderSettled: boolean;
  startNonce: bigint;
  latestNonce: bigint;
  pendingNonce: bigint;
  /** Broadcast hashes recorded in the state by any child (0 when none was reported). */
  recordedBroadcasts: number;
  /** The signer's payments to the vendor since the baseline, for any order. */
  signerPaymentsSinceBaseline: number;
}

/**
 * PAID: the chain shows this order's payment. NOT_SENT: the chain proves nothing was sent (no payment, nonce unchanged, no
 * broadcast recorded). AMBIGUOUS: anything else. An ambiguous outcome is a hard stop: inspect the chain, never --fresh.
 */
export function classifySendFacts(f: SendFacts): { outcome: SendOutcome; reasons: string[] } {
  const hardStop = (why: string) => `HARD STOP: ${why}. Inspect the chain, do NOT use --fresh.`;
  if (f.orderLogs > 1) return { outcome: "AMBIGUOUS", reasons: [hardStop("the chain shows more than one payment for this order")] };
  if (f.orderLogs === 1) {
    return { outcome: "PAID", reasons: ["the chain shows the payment for this order: resume recovers and verifies it, and sends nothing"] };
  }
  if (f.orderSettled) return { outcome: "AMBIGUOUS", reasons: [hardStop("the contract shows this order settled, with no payment log")] };
  if (f.recordedBroadcasts > 0) {
    return { outcome: "AMBIGUOUS", reasons: [hardStop("a broadcast was recorded for this send and no payment for its order is on chain yet")] };
  }
  if (f.latestNonce !== f.startNonce || f.pendingNonce !== f.startNonce) {
    return {
      outcome: "AMBIGUOUS",
      reasons: [hardStop("the signer's nonce has moved: a transaction from the signer is mined or in flight, and it is not shown to be this payment")],
    };
  }
  if (f.signerPaymentsSinceBaseline > 0) {
    return { outcome: "AMBIGUOUS", reasons: [hardStop("the signer has made a payment since the baseline")] };
  }
  return {
    outcome: "NOT_SENT",
    reasons: [
      "the chain proves this send was not made: no payment for its order, the signer's nonce is unchanged, and no broadcast is recorded. Nothing was paid. This harness does not re-send a reserved settlement: a new run is --fresh in a NEW dedicated database",
    ],
  };
}

/** Every broadcast hash the state holds, from the children's results and their output lines (distinct, in order). */
export function recordedBroadcastHashes(state: TabState): string[] {
  const send = state.results.send as ChildEvidence | null | undefined;
  const recover = state.results.recover as ChildEvidence | null | undefined;
  const all = [
    ...(send?.broadcasts ?? []),
    ...(recover?.broadcasts ?? []),
    ...((state.results.broadcastLines as string[] | undefined) ?? []),
    ...((state.results.recoverLines as string[] | undefined) ?? []),
  ];
  return [...new Set(all)];
}

/** The chain facts a classification needs. Read-only. A failed read throws (BLOCKED at the caller). */
export async function readSendFacts(rpc: RpcCall, state: TabState, orderId: string | null): Promise<SendFacts> {
  const b = state.baseline!;
  const deployBlock = BigInt(b.deployBlock);
  const orderLogs = orderId === null ? [] : await readSettlementLogs(rpc, b.contract, orderId, deployBlock);
  const orderSettled = orderId === null ? false : await readSettledOrder(rpc, b.contract, orderId);
  const latestNonce = await readNonce(rpc, b.signer, "latest");
  const pendingNonce = await readNonce(rpc, b.signer, "pending");
  const since = b.headBlock !== undefined ? BigInt(b.headBlock) + 1n : deployBlock;
  const payments = await readPaymentsFromSigner(rpc, b.contract, b.signer, since);
  return {
    orderLogs: orderLogs.length,
    orderSettled,
    startNonce: BigInt(b.startNonce),
    latestNonce,
    pendingNonce,
    recordedBroadcasts: recordedBroadcastHashes(state).length,
    signerPaymentsSinceBaseline: payments.length,
  };
}

/**
 * A prior send's outcome, from the chain and the database. Any failed read is BLOCKED, and the message says what to do.
 */
export async function classifyPriorSend(
  rpc: RpcCall | undefined,
  db: TabDb,
  state: TabState
): Promise<{ outcome: SendOutcome; reasons: string[]; facts?: SendFacts }> {
  const unknown = (why: string) => new BlockedError(`the prior send cannot be classified (${why}). Inspect the chain, do NOT use --fresh.`);
  if (!rpc) throw unknown("no RPC client");
  let facts: SendFacts;
  try {
    const snap = await db.snapshot(state.workspaceId, state.counterpartyId);
    const settlement = snap.settlements[0];
    facts = await readSendFacts(rpc, state, settlement ? tabAdapterOrderId(settlement.id) : null);
  } catch (error) {
    throw unknown(error instanceof Error ? error.message : "unknown error");
  }
  return { ...classifySendFacts(facts), facts };
}

/**
 * A transport that reports every eth_sendRawTransaction attempt before it is forwarded. A retry of the same raw transaction
 * reports the same hash again; the harness counts distinct hashes, so a retry is never a second payment.
 */
export function broadcastReportingTransport(forward: RpcCall, onAttempt: (hash: Hex) => void): Transport {
  return custom(
    {
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        const list = Array.isArray(params) ? (params as unknown[]) : [];
        if (method === "eth_sendRawTransaction") onAttempt(keccak256(list[0] as Hex));
        return forward(method, list);
      },
    } as never,
    { retryCount: 3 }
  );
}

/**
 * The local rehearsal adapter. The simulator reports a transfer it remembers as `submitted`. The Arc log scan reports the same
 * fact as `confirmed`, because a settlement log exists only for a successful transaction. The rehearsal maps it so the
 * ledger's reconcile path runs the same way it would on Arc. Rehearsal only; never used on the live path.
 */
export function localRehearsalAdapter(): SettlementAdapter {
  const sim = new LocalSettlementSimulator();
  return {
    mode: "local",
    getBalance: (address: string) => sim.getBalance(address),
    transferUSDC: (req: TransferRequest) => sim.transferUSDC(req),
    confirm: (txHash: string) => sim.confirm(txHash),
    findTransfer: async (req: { orderId: string }) => {
      const found = await sim.findTransfer(req);
      return found === null ? null : { ...found, status: "confirmed" };
    },
    isOrderSettled: (orderId: string) => sim.isOrderSettled(orderId),
    depositEscrow: (req: TransferRequest, milestoneId: string) => sim.depositEscrow(req, milestoneId),
    releaseEscrow: (milestoneId: string, toAddress: string) => sim.releaseEscrow(milestoneId, toAddress),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Scenario state (one file per scenario): the phase guard and the record of what was run
// ---------------------------------------------------------------------------------------------------------------------

export interface TabBaseline {
  startNonce: string;
  vendorBalanceBefore: string;
  decimals: number;
  contract: string;
  deployBlock: string;
  signer: string;
  vendor: string;
  /** The head block read just before the send. Payments after it are what this run's deltas must be attributed to. */
  headBlock?: string;
}

export interface TabState {
  version: 1;
  harness: typeof TAB_STATE_HARNESS;
  scenario: TabScenario;
  adapter: AdapterKind;
  workspaceId: string;
  counterpartyId: string;
  payer: string;
  vendor: string;
  baseline?: TabBaseline;
  /** Set by the orchestrator just before the send child starts. Its presence means a send has started. */
  sendStartedAt?: string;
  /** Set by the recover child just before it runs. */
  recoverStartedAt?: string;
  results: Record<string, unknown>;
}

/** Parses a state file. Returns null for a file that is not a state record of this harness. */
export function parseTabState(text: string): TabState | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const s = value as Partial<TabState>;
  if (s.version !== 1 || s.harness !== TAB_STATE_HARNESS || typeof s.scenario !== "string" || typeof s.adapter !== "string") return null;
  if (typeof s.workspaceId !== "string" || typeof s.counterpartyId !== "string" || typeof s.payer !== "string") return null;
  if (typeof s.vendor !== "string" || typeof s.results !== "object" || s.results === null) return null;
  return s as TabState;
}

export function assertTabStateMatches(state: TabState, args: Pick<TabCliArgs, "scenario" | "adapter">): void {
  if (state.scenario !== args.scenario || state.adapter !== args.adapter) {
    throw new RefusedError(["the state file belongs to another scenario or adapter; use its own --state file or --fresh"]);
  }
}

/**
 * The phase guard. The send runs once per state, and the recover only after the send started and only once. Anything else
 * is refused before a process starts or a transfer is made.
 */
export function assertTabPhase(state: TabState | null, phase: ChildPhase, args: Pick<TabCliArgs, "scenario" | "adapter">): void {
  if (state === null) throw new RefusedError(["no prepared state for this scenario: the run has not been prepared"]);
  assertTabStateMatches(state, args);
  if (phase === "send") {
    if (state.sendStartedAt !== undefined) {
      throw new RefusedError(["the send already ran for this scenario; a second send is refused (use --fresh for a new payment)"]);
    }
    return;
  }
  if (state.sendStartedAt === undefined) throw new RefusedError(["the recover phase is refused: the send has not started"]);
  if (state.recoverStartedAt !== undefined) throw new RefusedError(["the recover phase already ran for this scenario"]);
}

/**
 * The reasons a --resume must refuse (empty when it may continue). Pure: it reads the state and the environment only.
 * A resume never sends. It needs the send to have started, the recovery not to have started, and the record that the send
 * ended in the way the scenario expects. The baseline must belong to this contract, deploy block, signer and vendor.
 */
export function resumeProblems(
  state: TabState | null,
  args: Pick<TabCliArgs, "scenario" | "adapter">,
  env: Env,
  signer: string
): string[] {
  if (state === null) return ["resume needs the state file of the send, and this scenario has none"];
  try {
    assertTabStateMatches(state, args);
  } catch (error) {
    return [error instanceof Error ? error.message : "the state does not match"];
  }
  if (state.recoverStartedAt !== undefined) return ["the recovery already started for this scenario; resume will not run it again"];
  if (state.sendStartedAt === undefined) return ["resume refused: the send has not started (the state file has no sendStartedAt)"];
  const reasons: string[] = [];
  const sendChild = state.results.sendChild as { signal?: string | null; killArmed?: boolean } | undefined;
  // On arc a send with no recorded result (a timeout, a SIGTERM, a parent that died, a crash before the broadcast) is decided
  // by the chain in runTabResume (classifySendFacts): not by the state file. Only the local rehearsal has no chain to read.
  if (args.adapter === "local-sim") {
    if (args.scenario === "crash-after-send") {
      if (!sendChild || sendChild.signal !== "SIGKILL" || sendChild.killArmed !== true) {
        reasons.push("resume refused: the state does not record the SIGKILL at the kill point");
      }
    } else if (!state.results.send) {
      reasons.push("resume refused: the send child did not finish, so the state does not show what it did");
    }
  }
  if (state.baseline === undefined) {
    reasons.push("resume refused: the state has no baseline");
  } else {
    const b = state.baseline;
    const contract = env.BIND_SETTLEMENT_ADDRESS ?? "";
    const deployBlock = effectiveDeployBlock(env).toString();
    if (args.adapter === "arc" && (b.contract.toLowerCase() !== contract.toLowerCase() || b.deployBlock !== deployBlock)) {
      reasons.push("baseline mismatch: the state's baseline names another contract or deploy block than this environment");
    }
    if (b.signer.toLowerCase() !== signer.toLowerCase() || b.vendor.toLowerCase() !== VENDOR_ADDRESS.toLowerCase()) {
      reasons.push("baseline mismatch: the state's baseline names another signer or vendor");
    }
  }
  return reasons;
}

/** The recover steps of each scenario, in order. A tick is the worker's own code. */
export function tabRecoverPlan(scenario: TabScenario): ("tick" | "tick-repeat")[] {
  if (scenario === "crash-after-send" || scenario === "settle") return ["tick", "tick-repeat"];
  return [];
}

// ---------------------------------------------------------------------------------------------------------------------
// The database as the harness reads it (pure shape + pure builder, so the tests can build one from rows)
// ---------------------------------------------------------------------------------------------------------------------

export interface SettlementView {
  id: string;
  amountCents: string;
  status: string;
  txHash: string | null;
  holdReason: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  confirmedBlock: string | null;
  reconcileAttempts: number;
}

export interface EffectView {
  status: string;
  attempts: number;
  operation: string;
  externalRef: string | null;
}

export interface EntryView {
  kind: "charge" | "clear" | "reversal";
  amountMicro: string;
  settlementId: string | null;
}

export interface AuditView {
  action: string;
  txHash: string | null;
}

export interface TabSnapshot {
  settlements: SettlementView[];
  /** The effect row of each settlement, by settlement id (null when no effect row exists). */
  effects: Record<string, EffectView | null>;
  entries: EntryView[];
  balanceMicro: string;
  audits: AuditView[];
  counterparty: { verified: boolean; paymentAddress: string | null } | null;
}

interface RawRows {
  settlements: Record<string, unknown>[];
  entries: Record<string, unknown>[];
  effects: Record<string, unknown>[];
  audits: Record<string, unknown>[];
  supplier?: Record<string, unknown> | null;
  workspaceId: string;
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Builds the snapshot from the rows the database returned. Pure. */
export function toTabSnapshot(raw: RawRows): TabSnapshot {
  const effectByKey = new Map<string, EffectView>();
  for (const e of raw.effects) {
    effectByKey.set(String(e.idempotency_key), {
      status: String(e.status),
      attempts: Number(e.attempts),
      operation: String(e.operation),
      externalRef: str(e.external_ref),
    });
  }
  const settlements: SettlementView[] = raw.settlements.map((s) => ({
    id: String(s.id),
    amountCents: String(s.amount_cents),
    status: String(s.status),
    txHash: str(s.tx_hash),
    holdReason: str(s.hold_reason),
    submittedAt: iso(s.submitted_at),
    confirmedAt: iso(s.confirmed_at),
    confirmedBlock: str(s.confirmed_block),
    reconcileAttempts: Number(s.reconcile_attempts ?? 0),
  }));
  const effects: Record<string, EffectView | null> = {};
  for (const s of settlements) effects[s.id] = effectByKey.get(ledgerKeys.effect(raw.workspaceId, s.id)) ?? null;
  const entries: EntryView[] = raw.entries.map((e) => ({
    kind: e.kind as EntryView["kind"],
    amountMicro: String(e.amount_micro),
    settlementId: str(e.settlement_id),
  }));
  let balance = 0n;
  for (const e of entries) {
    const micro = BigInt(e.amountMicro);
    balance += e.kind === "clear" ? -micro : micro;
  }
  const audits: AuditView[] = raw.audits.map((a) => ({ action: String(a.action), txHash: str(a.tx_hash) }));
  const counterparty = raw.supplier
    ? { verified: raw.supplier.verified === true, paymentAddress: str(raw.supplier.payment_address) }
    : null;
  return { settlements, effects, entries, balanceMicro: balance.toString(), audits, counterparty };
}

export function countAudits(snap: TabSnapshot, action: string): number {
  return snap.audits.filter((a) => a.action === action).length;
}

/** The index of the first audit row with this action, or -1. Order is the order the rows were written. */
export function auditIndex(snap: TabSnapshot, action: string): number {
  return snap.audits.findIndex((a) => a.action === action);
}

export function clearCountOf(snap: TabSnapshot, settlementId: string): number {
  return snap.entries.filter((e) => e.kind === "clear" && e.settlementId === settlementId).length;
}

export function reversalCount(snap: TabSnapshot): number {
  return snap.entries.filter((e) => e.kind === "reversal").length;
}

/** The preparation check: the tab holds exactly the three charges, no settlement, and 15_000 micro that floors to one cent. */
export function preparedTabAssertions(snap: TabSnapshot): Assertion[] {
  const charges = snap.entries.filter((e) => e.kind === "charge");
  const allCharges = charges.length === CHARGE_COUNT && charges.every((c) => BigInt(c.amountMicro) === CHARGE_MICRO);
  return [
    check("prepared_no_settlement", snap.settlements.length === 0, `settlements before the send: ${snap.settlements.length}`),
    check("prepared_three_charges", allCharges, `charges: ${charges.length}, each ${CHARGE_MICRO} micro-USDC`),
    check("prepared_balance", snap.balanceMicro === TAB_TOTAL_MICRO.toString(), `balance ${snap.balanceMicro} micro-USDC, expected ${TAB_TOTAL_MICRO}`),
  ];
}

/** The state of a settlement that was cleared but not yet sent, read after a process died inside the send. Pure. */
export function preRestartAssertions(snap: TabSnapshot): Assertion[] {
  const s = snap.settlements[0];
  const e = s ? snap.effects[s.id] : null;
  return [
    check("pre_restart_one_settlement", snap.settlements.length === 1, `settlements: ${snap.settlements.length}`),
    check("pre_restart_settlement_pending", s?.status === "pending", `status ${s?.status ?? "none"}`),
    check("pre_restart_no_hash", s !== undefined && s.txHash === null, "tx_hash must be unset: the send was never recorded"),
    check("pre_restart_clear_owned", s !== undefined && clearCountOf(snap, s.id) === 1 && reversalCount(snap) === 0, "one clear for the settlement, no reversal"),
    check("pre_restart_effect_started", e?.status === "started" && e.attempts === 1, `effect ${e?.status ?? "none"} after ${e?.attempts ?? 0} attempt(s)`),
    check("pre_restart_no_submitted_audit", countAudits(snap, "tab.settlement_submitted") === 0, "no tab.settlement_submitted without a stored hash"),
    check("pre_restart_reserved_audit", countAudits(snap, "tab.settlement_reserved") === 1, "tab.settlement_reserved is written once"),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Assertions over observed facts (pure)
// ---------------------------------------------------------------------------------------------------------------------

const check = (name: string, ok: boolean, detail: string): Assertion => ({ name, status: ok ? "PASS" : "FAIL", detail });
const info = (name: string, detail: string): Assertion => ({ name, status: "INFO", detail });
const skipped = (name: string): Assertion => ({ name, status: "SKIPPED", detail: "local-sim: no chain reads" });

export interface ChainFacts {
  contract: string;
  orderId: string;
  startNonce: string;
  endNonce: string;
  vendorBefore: string;
  vendorAfter: string;
  expectedDelta: string;
  logs: LogFact[];
  /** Every SettlementExecuted from the signer after the baseline head block, for any order. This run's payment must be the only one. */
  paymentsSinceBaseline: LogFact[];
}

export interface ConfirmSnapshot {
  txHash: string;
  settlementStatus: string | null;
  submittedAt: boolean;
  submittedAuditRows: number;
  txHashRecorded: string | null;
}

export interface TabStep {
  name: string;
  data: Record<string, unknown>;
}

/** What one child reports. The parent reads it, then re-reads the database and the chain itself. */
export interface ChildEvidence {
  phase: ChildPhase;
  stopped?: string;
  steps: TabStep[];
  confirmSnapshots: ConfirmSnapshot[];
  broadcasts: string[];
  transferCalls: number;
}

export function stepOf(steps: TabStep[], name: string): Record<string, unknown> | undefined {
  return steps.find((s) => s.name === name)?.data;
}

export interface VerifyInput {
  scenario: TabScenario;
  adapter: AdapterKind;
  snap: TabSnapshot;
  chain?: ChainFacts;
  /** Distinct transaction hashes the children attempted to broadcast (from their output and their results). */
  broadcasts: string[];
  receipts: Record<string, ReceiptFact | null>;
  send?: ChildEvidence;
  recover?: ChildEvidence;
  sendChild: { signal: string | null; killArmed: boolean };
  preRestart?: Assertion[];
}

/** Every final assertion of the three scenarios. Chain checks are SKIPPED for local-sim and FAIL on arc when skipped. */
export function tabAssertions(input: VerifyInput): Assertion[] {
  const out: Assertion[] = [];
  const onChain = (name: string, ok: () => boolean, detail: string): Assertion =>
    input.adapter === "arc" && input.chain !== undefined ? check(name, ok(), detail) : skipped(name);
  const snap = input.snap;
  const s = snap.settlements.length === 1 ? snap.settlements[0] : undefined;
  const chain = input.chain;
  const log = chain?.logs[0];
  const distinct = input.broadcasts.length;

  if (input.preRestart) out.push(...input.preRestart);
  if (input.scenario === "crash-after-send") {
    out.push(
      check(
        "child_killed_at_crash_point",
        input.sendChild.killArmed && input.sendChild.signal === "SIGKILL",
        `kill point reached: ${input.sendChild.killArmed}; child signal: ${input.sendChild.signal ?? "none"}`
      )
    );
  }

  // The settlement, its state and its money.
  out.push(check("single_settlement", snap.settlements.length === 1, `settlements for the tab: ${snap.settlements.length}`));
  out.push(check("settlement_confirmed", s?.status === "confirmed", `settlement status ${s?.status ?? "none"}`));
  out.push(check("settlement_one_cent", s?.amountCents === PAYMENT_CENTS.toString(), `settlement amount ${s?.amountCents ?? "none"} cents`));
  out.push(check("settlement_hash_set", s?.txHash !== null && s?.txHash !== undefined, "tx_hash is set"));
  out.push(check("settlement_confirmed_at_set", s?.confirmedAt !== null && s?.confirmedAt !== undefined, "confirmed_at is set"));
  out.push(
    onChain(
      "settlement_confirmed_block_set",
      () => s?.confirmedBlock !== null && s?.confirmedBlock !== undefined,
      `confirmed_block ${s?.confirmedBlock ?? "none"}`
    )
  );
  out.push(
    check(
      "ledger_charges",
      snap.entries.filter((e) => e.kind === "charge").length === CHARGE_COUNT &&
        snap.entries.filter((e) => e.kind === "charge").every((e) => BigInt(e.amountMicro) === CHARGE_MICRO),
      `charges: ${snap.entries.filter((e) => e.kind === "charge").length} of ${CHARGE_MICRO} micro`
    )
  );
  out.push(
    check(
      "ledger_one_clear",
      s !== undefined &&
        snap.entries.filter((e) => e.kind === "clear").length === 1 &&
        snap.entries.some((e) => e.kind === "clear" && e.settlementId === s.id && BigInt(e.amountMicro) === SETTLEMENT_MICRO),
      `clears: ${snap.entries.filter((e) => e.kind === "clear").length}, the settlement's clear is ${SETTLEMENT_MICRO} micro`
    )
  );
  out.push(check("ledger_zero_reversals", reversalCount(snap) === 0, `reversals: ${reversalCount(snap)}`));
  out.push(
    check("balance_remainder", snap.balanceMicro === REMAINDER_MICRO.toString(), `balance ${snap.balanceMicro} micro-USDC, expected ${REMAINDER_MICRO}`)
  );
  const attempts = s ? snap.effects[s.id]?.attempts : undefined;
  if (input.adapter === "arc" || input.scenario !== "crash-after-send") {
    out.push(
      check(
        "effect_attempts_one",
        attempts === 1,
        `effect attempts ${attempts ?? "none"}: 1 means the transfer was adopted or sent once`
      )
    );
  }
  if (input.adapter === "local-sim" && input.scenario === "crash-after-send") {
    out.push(
      info(
        "local_restart_resend",
        "local-sim: the simulator forgets its transfer across processes, so the restart sends again in the simulator; not evidence about the chain"
      )
    );
  }

  // The audit trail: submitted before confirmed (or adopted, for a held settlement), confirmed once.
  out.push(check("audit_confirmed_once", countAudits(snap, "tab.settlement_confirmed") === 1, `tab.settlement_confirmed: ${countAudits(snap, "tab.settlement_confirmed")}`));
  if (input.scenario === "held-adopt") {
    out.push(check("audit_hash_adopted_once", countAudits(snap, "tab.settlement_hash_adopted") === 1, `tab.settlement_hash_adopted: ${countAudits(snap, "tab.settlement_hash_adopted")}`));
    out.push(check("audit_no_submitted_on_adopt", countAudits(snap, "tab.settlement_submitted") === 0, "an adopted hash is not a new submission"));
  } else {
    out.push(check("audit_submitted_once", countAudits(snap, "tab.settlement_submitted") === 1, `tab.settlement_submitted: ${countAudits(snap, "tab.settlement_submitted")}`));
    const a = auditIndex(snap, "tab.settlement_submitted");
    const b = auditIndex(snap, "tab.settlement_confirmed");
    out.push(check("audit_submitted_before_confirmed", a >= 0 && b > a, `submitted at audit index ${a}, confirmed at ${b}`));
  }
  if (input.scenario === "crash-after-send") {
    // On Arc the restart adopts the mined transfer, so it calls transferUSDC zero times. The simulator forgets its transfer
    // across processes, so under local-sim that call is expected: it is reported, not checked.
    const calls = input.recover?.transferCalls;
    if (input.adapter === "arc") {
      out.push(check("restart_settles_without_resend", calls === 0, `real transferUSDC calls in the restart: ${calls ?? "not run"}`));
    } else {
      out.push(info("local_restart_transfer_calls", `local-sim: real transferUSDC calls in the restart: ${calls ?? "not run"}`));
    }
  }

  // Every confirmation the children made: the submitted milestone was on record before the adapter was asked.
  const snaps = [...(input.send?.confirmSnapshots ?? []), ...(input.recover?.confirmSnapshots ?? [])];
  const submittedFirst =
    input.scenario === "held-adopt"
      ? snaps.length >= 1 && snaps.every((c) => c.settlementStatus === "submitted" && c.txHashRecorded === c.txHash)
      : snaps.length >= 1 && snaps.every((c) => c.settlementStatus === "submitted" && c.submittedAt && c.submittedAuditRows === 1 && c.txHashRecorded === c.txHash);
  out.push(
    check(
      "submitted_recorded_before_confirm",
      submittedFirst,
      `confirm calls: ${snaps.length}; each saw the settlement submitted with its hash${input.scenario === "held-adopt" ? "" : " and one submitted audit row"}`
    )
  );

  // Chain facts (arc only). The delta is the number of distinct broadcasts, and that number must be exactly one.
  out.push(onChain("one_settlement_log", () => chain!.logs.length === 1, `SettlementExecuted logs for the order id: ${chain?.logs.length ?? "not read"}`));
  out.push(onChain("broadcasts_exactly_one", () => distinct === 1, `distinct broadcasts by the signer: ${distinct}`));
  out.push(
    onChain(
      "signer_nonce_delta_one",
      () => chain !== undefined && BigInt(chain.endNonce) - BigInt(chain.startNonce) === 1n && BigInt(chain.endNonce) - BigInt(chain.startNonce) === BigInt(distinct),
      `signer nonce ${chain?.startNonce ?? "?"} -> ${chain?.endNonce ?? "?"} against ${distinct} broadcast(s)`
    )
  );
  out.push(
    onChain(
      "vendor_delta_one_cent",
      () => chain !== undefined && BigInt(chain.vendorAfter) - BigInt(chain.vendorBefore) === BigInt(chain.expectedDelta),
      `vendor balance delta ${chain ? BigInt(chain.vendorAfter) - BigInt(chain.vendorBefore) : "?"} base units, expected ${chain?.expectedDelta ?? "?"}`
    )
  );
  out.push(
    onChain(
      "tx_hash_matches_log",
      () => log !== undefined && s?.txHash != null && log.transactionHash.toLowerCase() === s.txHash.toLowerCase(),
      `settlement tx_hash ${s?.txHash ?? "none"}, log ${log?.transactionHash ?? "none"}`
    )
  );
  out.push(
    onChain(
      "confirmed_block_matches_log",
      () => log !== undefined && s?.confirmedBlock != null && BigInt(s.confirmedBlock) === log.blockNumber,
      `confirmed block ${s?.confirmedBlock ?? "none"}, log block ${log?.blockNumber.toString() ?? "none"}`
    )
  );
  // The deltas above are this run's only when no other payment from the signer landed after its baseline. A later --resume of
  // an older state, or an interleaved scenario, would otherwise be counted against this run.
  out.push(
    onChain(
      "only_this_run_paid_since_baseline",
      () =>
        chain !== undefined &&
        chain.paymentsSinceBaseline.length === 1 &&
        s?.txHash != null &&
        chain.paymentsSinceBaseline[0].transactionHash.toLowerCase() === s.txHash.toLowerCase(),
      `signer payments after the baseline: ${chain?.paymentsSinceBaseline.length ?? "not read"}; the only one must be this settlement's`
    )
  );
  out.push(
    onChain(
      "receipt_success",
      () => [...input.broadcasts, ...(s?.txHash ? [s.txHash] : [])].every((h) => input.receipts[h]?.status === "success"),
      `receipts: ${Object.entries(input.receipts).map(([h, r]) => `${h.slice(0, 10)}…=${r?.status ?? "not found"}`).join(", ") || "none"}`
    )
  );

  // Scenario-specific observations, recorded by the children and checked here against the same facts.
  if (input.scenario === "settle") out.push(...settleChildAssertions(input));
  if (input.scenario === "crash-after-send") out.push(...crashChildAssertions(input));
  if (input.scenario === "held-adopt") out.push(...heldChildAssertions(input));
  return out;
}

function settleChildAssertions(input: VerifyInput): Assertion[] {
  const settle = stepOf(input.send?.steps ?? [], "settle");
  const repeat = stepOf(input.send?.steps ?? [], "repeat");
  const result = (settle?.result ?? {}) as { outcome?: string };
  const repeatResult = (repeat?.result ?? {}) as { outcome?: string };
  const repeatUnchanged = input.adapter === "local-sim" || (repeat?.nonceBefore !== undefined && repeat.nonceBefore === repeat.nonceAfter);
  return [
    check("settle_call_settlement", result.outcome === "settlement", `settleTab returned ${result.outcome ?? "nothing"}`),
    check(
      "repeat_below_threshold_no_send",
      repeatResult.outcome === "below_threshold" && repeat?.transferCallsDelta === 0 && repeatUnchanged,
      `repeat settleTab: ${repeatResult.outcome ?? "nothing"}; real transfers in the repeat: ${repeat?.transferCallsDelta ?? "not run"}; nonce unchanged: ${repeatUnchanged}`
    ),
  ];
}

function crashChildAssertions(input: VerifyInput): Assertion[] {
  const tick1 = stepOf(input.recover?.steps ?? [], "tick");
  const repeat = stepOf(input.recover?.steps ?? [], "tick-repeat");
  const repeatUnchanged = input.adapter === "local-sim" || (repeat?.nonceBefore !== undefined && repeat.nonceBefore === repeat.nonceAfter);
  const afterTick1 = tick1?.settlementStatus;
  return [
    check("restart_tick_confirms", afterTick1 === "confirmed", `settlement after the restart's first tick: ${String(afterTick1 ?? "not run")}`),
    check(
      "repeat_tick_sends_nothing",
      repeat?.transferCallsDelta === 0 && repeatUnchanged,
      `repeat tick: real transfers ${repeat?.transferCallsDelta ?? "not run"}; nonce unchanged: ${repeatUnchanged}`
    ),
  ];
}

function heldChildAssertions(input: VerifyInput): Assertion[] {
  const steps = input.send?.steps ?? [];
  const timeout = stepOf(steps, "timeout-send");
  const hold = stepOf(steps, "hold-unverified");
  const restore = stepOf(steps, "restore-refused");
  const tick = stepOf(steps, "worker-tick");
  const repeat = stepOf(steps, "reconcile-repeat");
  const holdOutcome = (hold?.outcome ?? {}) as { kind?: string; hold?: string };
  const restoreOutcome = (restore?.outcome ?? {}) as { kind?: string; code?: string; reason?: string };
  const reconcileOutcome = (repeat?.outcome ?? {}) as { kind?: string };
  const lookup = (restore?.lookup ?? {}) as { found?: boolean | string; isOrderSettled?: boolean | string };
  const local = input.adapter === "local-sim";
  const nonceOk = (d: Record<string, unknown> | undefined) => local || (d?.nonceBefore !== undefined && d.nonceBefore === d.nonceAfter);
  const tabTick = (tick?.tab ?? {}) as { reconciled?: number; failed?: number };
  const threwName = (timeout?.threw as { name?: string } | null | undefined)?.name ?? "nothing";
  return [
    check(
      "timeout_send_threw_unknown",
      timeout?.threw !== null && timeout?.threw !== undefined && timeout?.settlementStatus === "pending" && timeout?.effectStatus === "failed",
      `first call threw ${threwName}; settlement ${String(timeout?.settlementStatus)}; effect ${String(timeout?.effectStatus)}`
    ),
    check("timeout_one_broadcast", timeout?.broadcasts === 1, `broadcasts after the timed-out send: ${String(timeout?.broadcasts)}`),
    check(
      "hold_unverified_is_unknown_outcome",
      holdOutcome.kind === "held" && holdOutcome.hold === "SETTLEMENT_OUTCOME_UNKNOWN",
      `executeSettlement with the supplier unverified: ${holdOutcome.kind ?? "nothing"} ${holdOutcome.hold ?? ""}`
    ),
    check(
      "hold_keeps_clear_no_reversal_no_broadcast",
      hold?.clearsKept === true && hold?.reversals === 0 && hold?.broadcastsDelta === 0 && hold?.transferCallsDelta === 0,
      `clear kept ${String(hold?.clearsKept)}; reversals ${String(hold?.reversals)}; new broadcasts ${String(hold?.broadcastsDelta)}; new transfer calls ${String(hold?.transferCallsDelta)}`
    ),
    check("supplier_verified_restored", hold?.verifiedRestored === true, "the supplier is verified again after the hold"),
    check(
      "restore_refused_by_chain",
      restoreOutcome.kind === "refused" && (restoreOutcome as { code?: string }).code === "NOT_PROVABLY_UNSENT" &&
        String((restoreOutcome as { reason?: string }).reason ?? "").includes("transfer for the order was found"),
      `cancelHeldAndRestore(acknowledgeNotSent): ${restoreOutcome.kind ?? "nothing"}; reason: ${String((restoreOutcome as { reason?: string }).reason ?? "none")}`
    ),
    check(
      "restore_refused_no_reversal",
      restore?.reversals === 0 && restore?.holdStatus === "held",
      `reversals after the refused restore: ${String(restore?.reversals)}; status ${String(restore?.holdStatus)}`
    ),
    local
      ? skipped("restore_lookup_finds_transfer")
      : check(
          "restore_lookup_finds_transfer",
          lookup.found === true && lookup.isOrderSettled === true,
          `chain lookup: findTransfer ${String(lookup.found)}, settledOrders ${String(lookup.isOrderSettled)}`
        ),
    check(
      "worker_held_step_adopts_and_confirms",
      tabTick.reconciled !== undefined && tabTick.reconciled >= 1 && tabTick.failed === 0 && tick?.settlementStatus === "confirmed",
      `worker tick: reconciled ${String(tabTick.reconciled)}, failed ${String(tabTick.failed)}; settlement ${String(tick?.settlementStatus)}`
    ),
    check(
      "worker_tick_sends_nothing",
      tick?.transferCallsDelta === 0 && nonceOk(tick),
      `worker tick: real transfers ${String(tick?.transferCallsDelta)}; nonce unchanged ${String(nonceOk(tick))}`
    ),
    check(
      "reconcile_repeat_no_op",
      reconcileOutcome.kind === "current" && nonceOk(repeat),
      `repeat reconcileHeld: ${reconcileOutcome.kind ?? "nothing"}; nonce unchanged ${String(nonceOk(repeat))}`
    ),
    check("audit_restore_refused_once", countAudits(input.snap, "tab.settlement_restore_refused") === 1, `refusals audited: ${countAudits(input.snap, "tab.settlement_restore_refused")}`),
    check("audit_not_restored", countAudits(input.snap, "tab.settlement_restored") === 0, "no restore was written"),
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------------

export interface TabPorts {
  env: Env;
  /** Writes the report to stdout. The caller passes text that has already been redacted. */
  emit(text: string): void;
  /** A notice for a person (stderr). Already redacted by the caller. */
  notify(text: string): void;
  files: { exists(file: string): boolean; read(file: string): string | null; write(file: string, text: string, mode: "new" | "overwrite"): void };
  rpc: RpcCall | undefined;
  db: TabDb;
  /** The spend ledger (arc only). A rehearsal never reads or writes it. */
  spend: SpendLedger;
  spawnPhase(childArgv: string[], timeoutMs: number): Promise<ChildOutcome>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface PreparedTab {
  workspaceId: string;
  counterpartyId: string;
}

/** The database must be a dedicated live database: a bind_live_ name, or the bind_live_marker table. Pure. */
export function databaseNameProblem(name: string, hasMarkerTable: boolean): string | undefined {
  if (name.startsWith("bind_live_") || hasMarkerTable) return undefined;
  return "the database is not a dedicated live database (its name must start with bind_live_, or it must hold the bind_live_marker table); nothing is sent";
}

/**
 * The workspaces table must hold nothing but this run's rows: empty for a new run (expected null), or only the state's
 * workspace on a reuse or in a child. Pure.
 */
export function workspaceRowsProblem(ids: string[], expectedWorkspaceId: string | null): string | undefined {
  if (expectedWorkspaceId === null) {
    return ids.length === 0 ? undefined : "the workspaces table is not empty: a new run needs an empty, dedicated database (one database per scenario); nothing is sent";
  }
  return ids.every((id) => id === expectedWorkspaceId)
    ? undefined
    : "the workspaces table holds rows that are not this run's; the run's dedicated database is not the one in use; nothing is sent";
}

/** The parent's database port. Child-only writes are on ChildDb. */
export interface TabDb {
  /** Reasons this database cannot be used for a NEW run (dedicated name, empty workspaces, no other tab or order work). */
  precheck(): Promise<string[]>;
  /** Reasons this database cannot be used for this state's workspace (dedicated name, only this run's workspace rows). Read-only. */
  rowsCheck(expectedWorkspaceId: string): Promise<string[]>;
  prepare(input: { scenario: TabScenario; payer: string; vendor: string; adapter: AdapterKind }): Promise<PreparedTab>;
  snapshot(workspaceId: string, counterpartyId: string): Promise<TabSnapshot>;
  close(): Promise<void>;
}

/** The child's database port: the parent's reads, plus the writes the scenarios make on purpose (see the step notes). */
export interface ChildDb extends TabDb {
  settlementRow(workspaceId: string, settlementId: string): Promise<SettlementRowView | null>;
  setVerified(workspaceId: string, counterpartyId: string, verified: boolean): Promise<void>;
  /** Moves the effect row's last update back, so the 30-minute window of a restore has passed. A test clock on a local database. */
  ageEffect(workspaceId: string, settlementId: string, minutes: number): Promise<void>;
}

class TabReport {
  private readonly startedAt: number;
  private readonly steps: { name: string; at: string; data?: unknown }[] = [];
  private readonly children: unknown[] = [];
  private chain: unknown;
  private ids: unknown;
  private assertions: Assertion[] = [];
  /** Every transaction hash a child reported broadcasting, or the settlement recorded. Reported even on a failed run. */
  private submitted: string[] = [];
  private confirmed: { bool: boolean; block: string | null } = { bool: false, block: null };

  constructor(
    private readonly args: TabCliArgs,
    private readonly ports: TabPorts
  ) {
    this.startedAt = ports.now();
  }

  noteSubmitted(hashes: string[]): void {
    for (const hash of hashes) if (!this.submitted.includes(hash)) this.submitted.push(hash);
  }

  setConfirmed(bool: boolean, block: string | null): void {
    this.confirmed = { bool, block };
  }

  step(name: string, data?: unknown): void {
    this.steps.push({ name, at: new Date(this.ports.now()).toISOString(), data });
  }

  child(phase: string, outcome: ChildOutcome): void {
    this.children.push({
      phase,
      exitCode: outcome.code,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      killArmed: outcome.lines.some((line) => line.includes(KILL_ARMED_MARK)),
      result: outcome.result ?? null,
      logTail: outcome.lines.filter((l) => !l.startsWith(BROADCAST_PREFIX)).slice(-20),
    });
  }

  setChain(chain: unknown): void {
    this.chain = chain;
  }

  setIds(ids: unknown): void {
    this.ids = ids;
  }

  setAssertions(assertions: Assertion[]): void {
    this.assertions = assertions;
  }

  end(result: TabRunResult, reasons: string[] = []): number {
    const finishedAt = this.ports.now();
    const arc = this.args.adapter === "arc";
    // Only a PASS against a remote Arc RPC is VERIFIED_REMOTE. The same code on a loopback RPC (a fake chain for rehearsal)
    // is a local pass, and the report says so: it must never read as evidence from the Arc network.
    const loopback = arc && isLoopbackRpcUrl(this.ports.env.ARC_RPC_URL);
    const arcMode = loopback ? "ARC_ADAPTER_ON_LOOPBACK_NOT_ARC_NETWORK" : "LIVE_ARC_TESTNET";
    const evidenceClass =
      result === "PASS"
        ? arc && !loopback
          ? "VERIFIED_REMOTE"
          : "LOCAL_PASS"
        : result === "REFUSED"
          ? "NOT_RUN"
          : result === "BLOCKED"
            ? "BLOCKED"
            : result === "SUBMITTED_UNCONFIRMED"
              ? "SUBMITTED_UNCONFIRMED"
              : null;
    const exitCode =
      result === "PASS" ? 0 : result === "FAIL" ? 1 : result === "SUBMITTED_UNCONFIRMED" ? EXIT_SUBMITTED_UNCONFIRMED : 2;
    const doc = {
      harness: "live-tab-arc",
      harnessVersion: 2,
      scenario: this.args.scenario,
      phase: this.args.phase,
      resume: this.args.resume,
      adapter: this.args.adapter,
      mode: arc ? arcMode : "LOCAL_SIMULATOR_NO_CHAIN",
      chainAssertions: arc
        ? "CHECKED"
        : "SKIPPED (local-sim: no chain reads, so the one-payment, nonce and balance checks at the chain are not evaluated)",
      amount: { cents: PAYMENT_CENTS.toString(), usdc: "0.01", perScenario: true },
      result,
      evidenceClass,
      reasons,
      /** Transaction hashes broadcast by this run. A hash here is not a confirmed settlement. */
      submitted: [...this.submitted],
      /** Confirmed only when Bind's record and (on arc) the chain's SettlementExecuted log agree. */
      confirmed: this.confirmed,
      ids: this.ids ?? null,
      chain: this.chain ?? null,
      steps: this.steps,
      children: this.children,
      assertions: this.assertions,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date(finishedAt).toISOString(),
      durationMs: finishedAt - this.startedAt,
      exitCode,
    };
    const text = jsonText(doc, true);
    this.ports.emit(text);
    if (this.args.writeEvidence !== undefined) {
      try {
        this.ports.files.write(path.resolve(this.args.writeEvidence), `${text}\n`, "new");
        this.ports.notify(`wrote ${path.basename(this.args.writeEvidence)} (new file)`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "unknown error";
        this.ports.notify(`evidence file not written: ${reason}`);
        return 2;
      }
    }
    return exitCode;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The orchestrator (parent process). It never sends: every send is in a child.
// ---------------------------------------------------------------------------------------------------------------------

function loadState(files: TabPorts["files"], file: string): TabState | null {
  const text = files.read(file);
  if (text === null) return null;
  const state = parseTabState(text);
  if (state === null) throw new RefusedError(["the state file is not a valid record of this harness; use --fresh or another --state file"]);
  return state;
}

function saveState(ports: TabPorts, file: string, state: TabState): void {
  ports.files.write(file, jsonText(state, true), "overwrite");
}

/**
 * Re-reads the state file, applies one change and saves it. A child writes its own markers to the same file, so the
 * orchestrator never saves a copy it read before the child ran: that copy would drop them.
 */
function updateState(ports: TabPorts, file: string, change: (state: TabState) => void): TabState {
  const current = loadState(ports.files, file);
  if (current === null) throw new BlockedError("the state file disappeared during the run");
  change(current);
  saveState(ports, file, current);
  return current;
}

/** The distinct broadcast hashes reported by the children, in the order they were attempted. */
export function broadcastsFromOutcome(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (!line.startsWith(BROADCAST_PREFIX)) continue;
    const hash = line.slice(BROADCAST_PREFIX.length).trim();
    if (!out.includes(hash)) out.push(hash);
  }
  return out;
}

/**
 * Every SettlementExecuted log emitted for this payer (the signer), from `fromBlock` to the head. Chunked, like every log
 * read here. A failed window throws: it is never read as "no payment".
 */
export async function readPaymentsFromSigner(
  rpc: RpcCall,
  contract: string,
  payer: string,
  fromBlock: bigint,
  supplier?: string
): Promise<LogFact[]> {
  const topics = encodeEventTopics({
    abi: BIND_SETTLEMENT_ABI,
    eventName: "SettlementExecuted",
    args: supplier === undefined ? { payer: payer as Address } : { payer: payer as Address, supplier: supplier as Address },
  } as never);
  const latest = BigInt((await rpc("eth_blockNumber", [])) as string);
  return collectLogs<LogFact>({
    latest,
    deployBlock: fromBlock,
    chunkBlocks: ARC_LOG_CHUNK_BLOCKS,
    rangeLimitOf: rangeLimitOfError,
    fetchRange: async (from, to) => {
      const logs = (await rpc("eth_getLogs", [
        { address: contract, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics },
      ])) as { transactionHash: string; blockNumber: string }[];
      return logs.map((log) => ({ transactionHash: String(log.transactionHash), blockNumber: BigInt(log.blockNumber) }));
    },
  });
}

async function chainFacts(
  rpc: RpcCall,
  state: TabState,
  orderId: string,
  startNonce: string,
  vendorBefore: string,
  decimals: number
): Promise<ChainFacts> {
  const baseline = state.baseline!;
  const endNonce = await readNonce(rpc, baseline.signer, "latest");
  const vendorAfter = await readVendorBalance(rpc, VENDOR_ADDRESS);
  const logs = await readSettlementLogs(rpc, baseline.contract, orderId, BigInt(baseline.deployBlock));
  const paymentsSinceBaseline = await readPaymentsFromSigner(rpc, baseline.contract, baseline.signer, BigInt(baseline.headBlock ?? baseline.deployBlock) + (baseline.headBlock !== undefined ? 1n : 0n));
  return {
    paymentsSinceBaseline,
    contract: baseline.contract,
    orderId,
    startNonce,
    endNonce: endNonce.toString(),
    vendorBefore,
    vendorAfter: vendorAfter.toString(),
    expectedDelta: oneCentInBaseUnits(decimals).toString(),
    logs,
  };
}

/** The parent's verification. Reads the database and the chain fresh, then asserts. */
async function verifyTab(args: TabCliArgs, state: TabState, ports: TabPorts, report: TabReport): Promise<TabRunResult> {
  const snap = await ports.db.snapshot(state.workspaceId, state.counterpartyId);
  report.step("final-snapshot", snap);
  // A child that died (SIGKILL) left no result, so its broadcasts come from the lines it printed before it died.
  const send = (state.results.send ?? undefined) as ChildEvidence | undefined;
  const recover = (state.results.recover ?? undefined) as ChildEvidence | undefined;
  const sendChild = (state.results.sendChild ?? { signal: null, killArmed: false }) as { signal: string | null; killArmed: boolean };
  const preRestart = (state.results.preRestart ?? undefined) as Assertion[] | undefined;
  const broadcasts: string[] = [];
  const seen = [
    ...(send?.broadcasts ?? []),
    ...(recover?.broadcasts ?? []),
    ...((state.results.broadcastLines as string[] | undefined) ?? []),
    ...((state.results.recoverLines as string[] | undefined) ?? []),
  ];
  for (const hash of seen) if (!broadcasts.includes(hash)) broadcasts.push(hash);

  let chain: ChainFacts | undefined;
  const receipts: Record<string, ReceiptFact | null> = {};
  const settlement = snap.settlements[0];
  if (args.adapter === "arc") {
    if (!ports.rpc) throw new BlockedError("no RPC client for the arc adapter");
    const rpc = ports.rpc;
    const orderId = settlement ? tabAdapterOrderId(settlement.id) : "tab_none";
    chain = await chainFacts(rpc, state, orderId, state.baseline!.startNonce, state.baseline!.vendorBalanceBefore, state.baseline!.decimals);
    report.setChain({ ...state.baseline, ...chain });
    for (const hash of [...broadcasts, ...(settlement?.txHash ? [settlement.txHash] : [])]) {
      if (!(hash in receipts)) receipts[hash] = await readReceipt(rpc, hash);
    }
  }
  report.setIds({ workspaceId: state.workspaceId, counterpartyId: state.counterpartyId, settlementId: settlement?.id ?? null, orderId: settlement ? tabAdapterOrderId(settlement.id) : null });

  const assertions = tabAssertions({
    scenario: args.scenario,
    adapter: args.adapter,
    snap,
    chain,
    broadcasts,
    receipts,
    send,
    recover,
    sendChild,
    preRestart,
  });
  if (args.adapter === "local-sim") {
    assertions.unshift({
      name: "chain_assertions",
      status: "SKIPPED",
      detail: "local-sim rehearsal: no chain reads; the simulator is in memory and cannot show one payment across processes",
    });
  }
  report.setAssertions(assertions);
  report.noteSubmitted([...broadcasts, ...(settlement?.txHash ? [settlement.txHash] : [])]);
  const confirmedOnChain = args.adapter === "arc" ? chain !== undefined && chain.logs.length === 1 : true;
  report.setConfirmed(settlement?.status === "confirmed" && confirmedOnChain, settlement?.confirmedBlock ?? null);
  return verdictFor(assertions, args, broadcasts, chain, receipts);
}

/** The assertions that are about the confirmation alone. A failure of only these, with the payment on chain once, is not a FAIL. */
export const CONFIRMATION_CHECKS = new Set([
  "settlement_confirmed",
  "settlement_confirmed_at_set",
  "settlement_confirmed_block_set",
  "audit_confirmed_once",
  "confirmed_block_matches_log",
]);

/**
 * The run's verdict. A send that was broadcast and paid once on chain, but is not confirmed in Bind's record, is
 * SUBMITTED_UNCONFIRMED: never a PASS, never reported as confirmed, and not a plain FAIL either. Any other failure is FAIL.
 */
export function verdictFor(
  assertions: Assertion[],
  args: Pick<TabCliArgs, "adapter">,
  broadcasts: string[],
  chain: ChainFacts | undefined,
  receipts: Record<string, ReceiptFact | null>
): TabRunResult {
  const verdict = verdictOf(assertions, args.adapter);
  if (verdict !== "FAIL" || args.adapter !== "arc") return verdict;
  const failing = assertions.filter((a) => a.status === "FAIL");
  const onlyConfirmation = failing.every((a) => CONFIRMATION_CHECKS.has(a.name));
  const paidOnceOnChain = chain !== undefined && chain.logs.length === 1 && chain.paymentsSinceBaseline.length === 1;
  const sentOk = broadcasts.length >= 1 && broadcasts.every((h) => receipts[h]?.status !== "reverted");
  return onlyConfirmation && paidOnceOnChain && sentOk ? "SUBMITTED_UNCONFIRMED" : "FAIL";
}

/** After the send: wait for the transfer to be mined, run the recover child when the scenario needs it, then verify. */
async function afterSend(
  args: TabCliArgs,
  state: TabState,
  ports: TabPorts,
  report: TabReport,
  signer: string,
  contract: string
): Promise<number> {
  report.noteSubmitted(recordedBroadcastHashes(state));
  const snap = await ports.db.snapshot(state.workspaceId, state.counterpartyId);
  const settlement = snap.settlements[0];
  if (args.adapter === "arc" && settlement !== undefined) {
    if (!ports.rpc) return report.end("BLOCKED", ["no RPC client"]);
    const rpc = ports.rpc;
    const orderId = tabAdapterOrderId(settlement.id);
    const startNonce = BigInt(state.baseline!.startNonce);
    const mined = await waitUntil(
      async () => {
        const logs = await readSettlementLogs(rpc, contract, orderId, BigInt(state.baseline!.deployBlock));
        const latest = await readNonce(rpc, signer, "latest");
        return logs.length >= 1 && latest > startNonce;
      },
      { timeoutMs: MINE_WAIT_MS, pollMs: POLL_MS, now: ports.now, sleep: ports.sleep }
    );
    report.step("wait-for-mining", { mined, timeoutMs: MINE_WAIT_MS });
    if (!mined) {
      // A broadcast that is not mined within the bound is sent but unconfirmed: it is never reported as a settlement.
      if (recordedBroadcastHashes(state).length > 0) {
        return report.end("SUBMITTED_UNCONFIRMED", [
          "the transfer was broadcast but is not mined within the bound: it is unconfirmed. Nothing was sent again. Run --resume later to read the chain",
        ]);
      }
      return report.end("FAIL", ["the transfer is not mined within the bound; the recover step is not run and nothing was sent again"]);
    }
  }

  const needsRecover = args.scenario === "crash-after-send" || (args.scenario === "settle" && settlement?.status !== "confirmed");
  if (needsRecover && state.results.recover === undefined) {
    assertTabPhase(state, "recover", args);
    const recover = await ports.spawnPhase(childArgs(args, "recover-child"), CHILD_TIMEOUT_MS);
    report.child("recover-child", recover);
    state = updateState(ports, args.statePath, (s) => {
      s.results.recover = recover.result ?? null;
      s.results.recoverLines = recover.lines.filter((l) => l.startsWith(BROADCAST_PREFIX)).map((l) => l.slice(BROADCAST_PREFIX.length).trim());
    });
    report.noteSubmitted(recordedBroadcastHashes(state));
    if (recover.code === 2 && recordedBroadcastHashes(state).length === 0) {
      const stop = childStop(recover);
      return report.end(stop.result, stop.reasons);
    }
    if (recover.code !== 0 || recover.result === undefined) {
      if (recordedBroadcastHashes(state).length > 0) {
        return report.end("SUBMITTED_UNCONFIRMED", ["the recover process stopped after a broadcast: the outcome is not recorded. Nothing further was sent"]);
      }
      return report.end("FAIL", ["the recover process did not finish cleanly; nothing further was sent"]);
    }
  }
  const verdict = await verifyTab(args, state, ports, report);
  return report.end(verdict);
}

export async function runTabOrchestrator(args: TabCliArgs, ports: TabPorts): Promise<number> {
  const report = new TabReport(args, ports);
  try {
    const evidenceExists = args.writeEvidence !== undefined && ports.files.exists(path.resolve(args.writeEvidence));
    const failures = tabStaticGuards(ports.env, args, evidenceExists);
    if (failures.length > 0) return report.end("REFUSED", failures.map((f) => f.reason));

    const signer = payerOf(ports.env);
    const contract = ports.env.BIND_SETTLEMENT_ADDRESS ?? APPROVED_SETTLEMENT_ADDRESS;
    const deployBlock = effectiveDeployBlock(ports.env).toString();
    if (args.adapter === "arc") {
      if (!ports.rpc) return report.end("BLOCKED", ["no RPC client"]);
      const reading = await assertContractGuards(ports.rpc, { contract, signer, vendor: VENDOR_ADDRESS });
      await assertDeployBlockCode(ports.rpc, contract, BigInt(deployBlock));
      await assertNoCodeBefore(ports.rpc, contract, BigInt(deployBlock));
      report.step("contract-guards", { chainId: reading.chainId, owner: reading.owner, whitelisted: reading.vendorWhitelisted });
    }

    // Awaited on purpose: the finally below closes the database, and a bare return would close it before the resume reads it.
    if (args.resume) return await runTabResume(args, ports, report, signer, contract);

    const previous = loadState(ports.files, args.statePath);
    if (previous !== null) assertTabStateMatches(previous, args);
    if (previous?.sendStartedAt !== undefined) {
      if (!args.fresh) {
        return report.end("REFUSED", [
          "a send already started for this scenario: run with --resume, which reads the chain and decides. Nothing is sent by this run",
        ]);
      }
      // --fresh never continues a started send. It is allowed only when the chain proves that send was not made.
      if (args.adapter !== "arc") {
        return report.end("REFUSED", ["--fresh is refused: a started send's outcome cannot be proven without the chain. Nothing is sent"]);
      }
      const prior = await classifyPriorSend(ports.rpc, ports.db, previous);
      report.step("prior-send-decision", { outcome: prior.outcome, facts: prior.facts ?? null });
      if (prior.outcome !== "NOT_SENT") {
        const lead =
          prior.outcome === "PAID"
            ? "the chain shows the prior payment: --fresh would be a second payment, so it is refused. Use --resume to recover and verify it"
            : "the prior send's outcome is not proven";
        return report.end("REFUSED", [`${lead}. Nothing is sent. ${prior.reasons.join(" ")}`]);
      }
    }

    let state: TabState;
    if (previous !== null && !args.fresh) {
      state = previous;
      const rowsProblems = await ports.db.rowsCheck(state.workspaceId);
      if (rowsProblems.length > 0) return report.end("REFUSED", rowsProblems);
      report.step("prepare-reused", { workspaceId: state.workspaceId, counterpartyId: state.counterpartyId });
    } else {
      const blockers = await ports.db.precheck();
      if (blockers.length > 0) return report.end("REFUSED", blockers);
      const prepared = await ports.db.prepare({ scenario: args.scenario, payer: signer, vendor: VENDOR_ADDRESS, adapter: args.adapter });
      state = {
        version: 1,
        harness: TAB_STATE_HARNESS,
        scenario: args.scenario,
        adapter: args.adapter,
        workspaceId: prepared.workspaceId,
        counterpartyId: prepared.counterpartyId,
        payer: signer,
        vendor: VENDOR_ADDRESS,
        results: {},
      };
      saveState(ports, args.statePath, state);
      report.step("prepared", { workspaceId: state.workspaceId, counterpartyId: state.counterpartyId });
    }
    report.setIds({ workspaceId: state.workspaceId, counterpartyId: state.counterpartyId });

    const before = await ports.db.snapshot(state.workspaceId, state.counterpartyId);
    const prepareChecks = preparedTabAssertions(before);
    report.step("prepare-checks", prepareChecks);
    if (prepareChecks.some((a) => a.status !== "PASS")) {
      return report.end("REFUSED", ["the prepared tab is not the expected three charges of 0.005 USDC; nothing is sent"]);
    }

    assertTabPhase(state, "send", args);
    if (args.adapter === "arc") {
      if (!ports.rpc) return report.end("BLOCKED", ["no RPC client"]);
      const rpc = ports.rpc;
      const startNonce = await readNonce(rpc, signer, "latest");
      const pending = await readNonce(rpc, signer, "pending");
      if (pending !== startNonce) {
        return report.end("REFUSED", ["the signer has a transaction in flight; the nonce delta would not be exact. Nothing is sent"]);
      }
      // The total cap (chain and ledger) and the balance, read fresh before the child is spawned. --fresh does not skip them.
      const cap = await assertCapAndBalance({ rpc, spend: ports.spend, contract, signer, vendor: VENDOR_ADDRESS, deployBlock: BigInt(deployBlock) });
      report.step("cap-and-balance", { chainPayments: cap.chainPayments, ledgerAttempts: cap.ledgerAttempts, capPayments: TOTAL_CAP_PAYMENTS });
      state.baseline = {
        startNonce: startNonce.toString(),
        vendorBalanceBefore: (await readVendorBalance(rpc, VENDOR_ADDRESS)).toString(),
        decimals: await readDecimals(rpc),
        contract,
        deployBlock,
        signer,
        vendor: VENDOR_ADDRESS,
        headBlock: BigInt((await rpc("eth_blockNumber", [])) as string).toString(),
      };
    } else {
      state.baseline = { startNonce: "0", vendorBalanceBefore: "0", decimals: 18, contract: "", deployBlock: "0", signer, vendor: VENDOR_ADDRESS };
    }
    saveState(ports, args.statePath, state);
    report.step("baseline", state.baseline);

    // The send child writes sendStartedAt itself, just before its first possible broadcast, so a second run is refused.
    const send = await ports.spawnPhase(childArgs(args, "send-child"), CHILD_TIMEOUT_MS);
    report.child("send-child", send);
    const killArmed = send.lines.some((l) => l.includes(KILL_ARMED_MARK));
    state = updateState(ports, args.statePath, (s) => {
      s.results.send = send.result ?? null;
      s.results.sendChild = { signal: send.signal, code: send.code, killArmed };
      s.results.broadcastLines = broadcastsFromOutcome(send.lines);
    });
    const broadcastSeen = broadcastsFromOutcome(send.lines);
    report.noteSubmitted(broadcastSeen);
    if (send.code === 2 && broadcastSeen.length === 0) {
      const stop = childStop(send);
      return report.end(stop.result, stop.reasons);
    }

    if (args.scenario === "crash-after-send") {
      if (send.signal !== "SIGKILL" || !killArmed) {
        const snap = await ports.db.snapshot(state.workspaceId, state.counterpartyId);
        report.step("send-child-not-killed", snap);
        if (broadcastSeen.length > 0) {
          return report.end("SUBMITTED_UNCONFIRMED", [
            `the send child stopped (signal ${send.signal ?? "none"}) after it broadcast: the outcome is not recorded. Nothing further was sent. Run --resume to read the chain`,
          ]);
        }
        return report.end("FAIL", [
          `the send child did not die at its kill point (signal ${send.signal ?? "none"}, code ${send.code ?? "none"}); the restart is not run`,
        ]);
      }
      const preCrash = await ports.db.snapshot(state.workspaceId, state.counterpartyId);
      state = updateState(ports, args.statePath, (s) => {
        s.results.preCrash = preCrash;
        s.results.preRestart = preRestartAssertions(preCrash);
      });
      report.step("after-crash", preCrash);
    } else if (send.code !== 0 || send.result === undefined) {
      report.step("unexpected-send-child-outcome", { code: send.code, signal: send.signal, timedOut: send.timedOut });
      if (broadcastSeen.length > 0) {
        // A timeout, a SIGTERM or a lost result after a broadcast: sent, not proven confirmed. --resume reads the chain.
        return report.end("SUBMITTED_UNCONFIRMED", [
          "the send child did not finish cleanly after it broadcast: the outcome is not recorded. Nothing further was sent. Run --resume to read the chain",
        ]);
      }
      return report.end("FAIL", ["the send child did not finish cleanly; nothing further is sent"]);
    }
    return await afterSend(args, state, ports, report, signer, contract);
  } catch (error) {
    if (error instanceof RefusedError) return report.end("REFUSED", error.reasons);
    if (error instanceof BlockedError) return report.end("BLOCKED", [error.message]);
    const reason = error instanceof Error ? error.message : "unknown error";
    return report.end("FAIL", [`unexpected error: ${reason}`]);
  } finally {
    await ports.db.close().catch(() => undefined);
  }
}

/** Continues a run whose send already started. It never sends: no send child is spawned. */
async function runTabResume(args: TabCliArgs, ports: TabPorts, report: TabReport, signer: string, contract: string): Promise<number> {
  const previous = loadState(ports.files, args.statePath);
  const reasons = resumeProblems(previous, args, ports.env, signer);
  if (reasons.length > 0) return report.end("REFUSED", reasons);
  const state = previous!;
  report.setIds({ workspaceId: state.workspaceId, counterpartyId: state.counterpartyId });
  const rowsProblems = await ports.db.rowsCheck(state.workspaceId);
  if (rowsProblems.length > 0) return report.end("REFUSED", rowsProblems);
  report.step("resume", { baseline: state.baseline, sendsSpawnedByResume: 0 });
  if (args.adapter === "arc") {
    if (!ports.rpc) return report.end("BLOCKED", ["no RPC client"]);
    // The chain decides what the started send did. PAID: recover and verify, no send. NOT_SENT and AMBIGUOUS: stop here.
    const decision = await classifyPriorSend(ports.rpc, ports.db, state);
    report.step("chain-decision", { outcome: decision.outcome, facts: decision.facts ?? null });
    if (decision.outcome !== "PAID") return report.end("REFUSED", decision.reasons);
  }
  if (args.adapter === "arc") {
    if (!ports.rpc) return report.end("BLOCKED", ["no RPC client"]);
    if (state.results.preRestart === undefined && args.scenario === "crash-after-send") {
      const preCrash = await ports.db.snapshot(state.workspaceId, state.counterpartyId);
      updateState(ports, args.statePath, (s) => {
        s.results.preCrash = preCrash;
        s.results.preRestart = preRestartAssertions(preCrash);
      });
    }
  }
  return afterSend(args, loadState(ports.files, args.statePath)!, ports, report, signer, contract);
}

/**
 * --preflight: the chain and the database are READ, the plan is printed, and nothing else happens. It spawns no child,
 * sends nothing, writes no state, no ledger record and no evidence. Exit 0 only when every read check passes (PREFLIGHT_READY);
 * a refused or blocked check exits 2, so a script never reads a not-ready plan as green.
 */
export async function runTabPreflight(args: TabCliArgs, ports: TabPorts): Promise<number> {
  const checks: Assertion[] = [];
  const finish = (result: "PREFLIGHT_READY" | "REFUSED" | "BLOCKED", reasons: string[], plan: string[] = [], facts: unknown = null): number => {
    const exitCode = result === "PREFLIGHT_READY" ? 0 : 2;
    const doc = {
      harness: "live-tab-arc",
      harnessVersion: 2,
      mode: "PREFLIGHT_READ_ONLY",
      scenario: args.scenario,
      adapter: args.adapter,
      sendsMade: 0,
      childrenSpawned: 0,
      writes: "none",
      result,
      evidenceClass: result === "PREFLIGHT_READY" ? "LIVE_READ_PASS" : result === "BLOCKED" ? "BLOCKED" : "NOT_RUN",
      reasons,
      checks,
      plan,
      facts,
      exitCode,
    };
    ports.emit(jsonText(doc, true));
    return exitCode;
  };
  try {
    if (args.adapter !== "arc") return finish("REFUSED", ["--preflight is for adapter=arc; the local rehearsal has no chain to read"]);
    // The confirm flag is a spend guard: a preflight spends nothing, so it is not required here.
    const failures = tabStaticGuards(ports.env, { adapter: "arc", confirmTestnetSpend: true, writeEvidence: undefined }, false);
    if (failures.length > 0) return finish("REFUSED", failures.map((f) => f.reason));
    const rpc = ports.rpc;
    if (!rpc) return finish("BLOCKED", ["no RPC client"]);
    const signer = payerOf(ports.env);
    const contract = ports.env.BIND_SETTLEMENT_ADDRESS ?? APPROVED_SETTLEMENT_ADDRESS;
    const deployBlock = effectiveDeployBlock(ports.env);

    // The contract, read fresh. A refusal names the rule (thrown as RefusedError and caught below).
    await assertContractGuards(rpc, { contract, signer, vendor: VENDOR_ADDRESS });
    await assertDeployBlockCode(rpc, contract, deployBlock);
    await assertNoCodeBefore(rpc, contract, deployBlock);
    checks.push(check("contract_guards", true, "chain id, owner, whitelist and enforcement hold; code at the deploy block and none before it"));

    const latest = await readNonce(rpc, signer, "latest");
    const pending = await readNonce(rpc, signer, "pending");
    checks.push(check("no_transaction_in_flight", pending === latest, pending === latest ? "the signer has nothing in flight" : "the signer has a transaction in flight"));

    const balance = await readNativeBalance(rpc, signer);
    const balanceProblems = balanceReasons(balance);
    checks.push(check("signer_balance", balanceProblems.length === 0, balanceProblems.length === 0 ? "one cent plus the 0.003 USDC gas margin is covered" : balanceProblems[0]));

    const chainPayments = await countVendorPayments(rpc, contract, signer, VENDOR_ADDRESS, deployBlock);
    const ledgerAttempts = ports.spend.read().length;
    const capProblems = totalCapReasons(chainPayments, ledgerAttempts);
    checks.push(check("total_cap", capProblems.length === 0, capProblems.length === 0 ? `payments ${chainPayments}, ledger attempts ${ledgerAttempts}, cap ${TOTAL_CAP_PAYMENTS}` : capProblems[0]));
    const locked = ports.spend.isLocked();
    checks.push(check("spend_lock", !locked, locked ? "the spend lock file exists: inspect before any run (RUNBOOK 16.4)" : "no spend lock is held"));

    const previous = loadState(ports.files, args.statePath);
    if (previous !== null) assertTabStateMatches(previous, args);
    let priorDetail = "no prior send recorded for this scenario";
    let priorOk = true;
    let priorFacts: unknown = null;
    if (previous?.sendStartedAt !== undefined) {
      const prior = await classifyPriorSend(rpc, ports.db, previous);
      priorFacts = prior.facts ?? null;
      priorOk = prior.outcome !== "AMBIGUOUS";
      priorDetail = `a send started before: the chain says ${prior.outcome}`;
    }
    checks.push(check("prior_send", priorOk, priorDetail));

    if (previous === null) {
      const blockers = await ports.db.precheck();
      checks.push(check("database_fresh_run", blockers.length === 0, blockers.length === 0 ? "dedicated, empty of workspaces and tab work" : blockers[0]));
    } else {
      const rowsProblems = await ports.db.rowsCheck(previous.workspaceId);
      checks.push(check("database_state_reuse", rowsProblems.length === 0, rowsProblems.length === 0 ? "dedicated; only this state's workspace" : rowsProblems[0]));
    }

    const scenarioAfter: Record<TabScenario, string> = {
      settle: "then a repeat settleTab, which must send nothing",
      "crash-after-send": "the send child is killed after the transfer returns; then the worker tick is run twice",
      "held-adopt": "the first call times out after its broadcast; the settlement is held, a restore is refused, and the worker adopts the hash",
    };
    const plan = [
      previous === null
        ? "prepare: a new tab in this dedicated database (three 0.005 USDC charges, one-cent limits)"
        : "prepare: reuse the state's prepared tab (no new rows)",
      "send: one settleTab of 1 cent (0.01 USDC) to the whitelisted vendor from the signer, in a child process; every guard is read again before the broadcast",
      `after: ${scenarioAfter[args.scenario]}`,
      "spawned: none (this is a preflight); sent: none",
    ];
    const cap = { capPayments: TOTAL_CAP_PAYMENTS, chainPayments, ledgerAttempts, remainingAfterThisRun: Math.max(0, TOTAL_CAP_PAYMENTS - Math.max(chainPayments, ledgerAttempts) - 1) };
    const failing = checks.filter((c) => c.status !== "PASS");
    if (failing.length > 0) return finish("REFUSED", failing.map((c) => c.detail), plan, { cap, prior: priorFacts });
    return finish("PREFLIGHT_READY", [], plan, { cap, prior: priorFacts });
  } catch (error) {
    if (error instanceof RefusedError) return finish("REFUSED", error.reasons);
    if (error instanceof BlockedError) return finish("BLOCKED", [error.message]);
    return finish("BLOCKED", [`unexpected error: ${error instanceof Error ? error.message : "unknown error"}`]);
  } finally {
    await ports.db.close().catch(() => undefined);
  }
}

function childArgs(args: TabCliArgs, phase: "send-child" | "recover-child"): string[] {
  return [
    args.scenario,
    "--phase",
    phase,
    "--adapter",
    args.adapter,
    "--state",
    args.statePath,
    ...(args.confirmTestnetSpend ? ["--confirm-testnet-spend"] : []),
  ];
}

/** What a child that exited 2 says. A blocked read is BLOCKED; a guard that refused is REFUSED. Either way nothing was sent. */
function childStop(outcome: ChildOutcome): { result: RunResult; reasons: string[] } {
  const line = [...outcome.lines].reverse().find((l) => l.startsWith(RESULT_PREFIX));
  if (line) {
    try {
      const parsed = JSON.parse(line.slice(RESULT_PREFIX.length)) as { blocked?: boolean; reason?: string; reasons?: string[] };
      if (parsed.blocked === true) return { result: "BLOCKED", reasons: [String(parsed.reason ?? "a read was blocked")] };
      if (Array.isArray(parsed.reasons) && parsed.reasons.length > 0) return { result: "REFUSED", reasons: parsed.reasons };
    } catch {
      // fall through
    }
  }
  return { result: "REFUSED", reasons: ["a child process refused the run before sending"] };
}

// ---------------------------------------------------------------------------------------------------------------------
// The child phases. These run in their own process and are the only code that can send.
// ---------------------------------------------------------------------------------------------------------------------

interface ChildCtx {
  args: TabCliArgs;
  env: Env;
  emit: (text: string) => void;
  rpc: RpcCall | undefined;
  signer: string;
  contract: string;
  deployBlock: bigint;
  /** The signer's nonce at the baseline: the start of this run's nonce delta. */
  startNonce: bigint;
  ws: string;
  cp: string;
  db: ChildDb;
  ledger: import("../src/tabs/ledger.js").TabLedger;
  guard: GuardedTabAdapter;
  broadcasts: string[];
  confirmSnapshots: ConfirmSnapshot[];
  steps: TabStep[];
  stopped?: string;
  step(name: string, data: Record<string, unknown>): void;
  stop(reason: string): void;
}

function describeError(err: unknown): { name: string; message: string } {
  const e = err as { name?: string; message?: string };
  return { name: String(e?.name ?? "Error"), message: String(e?.message ?? "").slice(0, 200) };
}

function serialise(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

/** A tab's run, from the child's point of view: the scenario's steps, each one a call Bind's code makes. */
export async function runTabChild(
  args: TabCliArgs,
  env: Env,
  emit: (text: string) => void,
  open: () => Promise<ChildDb>,
  spend: SpendLedger = realSpendLedger()
): Promise<number> {
  /** The local rehearsal has no chain: its hooks never call this. */
  const noChainRpc: RpcCall = async () => {
    throw new BlockedError("no chain reads in the local rehearsal");
  };
  const phase: ChildPhase = args.phase === "send-child" ? "send" : "recover";
  const scrub = makeScrubber(env);
  const files = realFiles(scrub);
  const rpc = args.adapter === "arc" && env.ARC_RPC_URL ? httpRpc(env.ARC_RPC_URL) : undefined;
  const signer = payerOf(env);
  const contract = env.BIND_SETTLEMENT_ADDRESS ?? APPROVED_SETTLEMENT_ADDRESS;
  let db: ChildDb | undefined;
  let releaseSpendLock: (() => void) | undefined;
  try {
    const failures = tabStaticGuards(env, args, false);
    if (failures.length > 0) throw new RefusedError(failures.map((f) => f.reason));
    const state = loadState(files, args.statePath);
    assertTabPhase(state, phase, args);
    if (!state!.baseline) throw new RefusedError(["the baseline is missing: the orchestrator has not started the send"]);
    if (rpc) {
      await assertContractGuards(rpc, { contract, signer, vendor: VENDOR_ADDRESS });
      await assertDeployBlockCode(rpc, contract, effectiveDeployBlock(env));
      await assertNoCodeBefore(rpc, contract, effectiveDeployBlock(env));
    }
    db = await open();
    const ws = state!.workspaceId;
    const cp = state!.counterpartyId;
    // The dedicated-database rule, again, in the child: only this run's workspace may be in the database.
    const rowsProblems = await db.rowsCheck(ws);
    if (rowsProblems.length > 0) throw new RefusedError(rowsProblems);
    const stamp = new Date().toISOString();
    const marked = loadState(files, args.statePath)!;
    if (phase === "send") marked.sendStartedAt = stamp;
    else marked.recoverStartedAt = stamp;
    files.write(args.statePath, jsonText(marked, true), "overwrite");

    const broadcasts: string[] = [];
    const onBroadcast = (hash: Hex) => {
      if (broadcasts.includes(hash)) return;
      broadcasts.push(hash);
      emit(`${BROADCAST_PREFIX}${hash}`);
    };
    const timeoutFirst = args.scenario === "held-adopt" && phase === "send";
    let inner: SettlementAdapter;
    if (args.adapter === "local-sim") {
      inner = localRehearsalAdapter();
    } else {
      const transport = timeoutFirst && rpc ? makeTimeoutTransport(rpc, onBroadcast) : broadcastReportingTransport(rpc!, onBroadcast);
      inner = new ArcL1SettlementAdapter({
        rpcUrl: env.ARC_RPC_URL,
        chainId: ARC_TESTNET_CHAIN_ID,
        contractAddress: APPROVED_SETTLEMENT_ADDRESS,
        signerPrivateKey: env.ARC_SIGNER_PRIVATE_KEY as Hex,
        deployBlock: effectiveDeployBlock(env),
        transport,
      });
    }

    const confirmSnapshots: ConfirmSnapshot[] = [];
    let armedOnce = false;
    const kill = (): never => {
      emit(KILL_ARMED_MARK);
      process.kill(process.pid, "SIGKILL");
      throw new Error("unreachable: the process was killed");
    };
    const sendHooks = buildSendHooks({
      rpc: rpc ?? noChainRpc,
      spend,
      contract,
      signer,
      vendor: VENDOR_ADDRESS,
      deployBlock: effectiveDeployBlock(env),
      db: db!,
      workspaceId: ws,
      counterpartyId: cp,
      scenario: args.scenario,
      onChain: args.adapter === "arc",
    });
    releaseSpendLock = () => sendHooks.release?.();
    const guard = tabGuardedAdapter(
      inner,
      {
        beforeTransfer: sendHooks.beforeTransfer,
        afterTransfer:
          phase === "send" && args.scenario === "crash-after-send"
            ? async () => kill()
            : phase === "send" && timeoutFirst && args.adapter === "local-sim"
              ? async (result) => {
                  if (armedOnce) return;
                  armedOnce = true;
                  onBroadcast(result.txHash as Hex);
                  throw new Error("RPC request timed out after the transaction was sent");
                }
              : undefined,
        beforeConfirm: async (txHash) => {
          const s = await db!.snapshot(ws, cp);
          const row = s.settlements[0];
          confirmSnapshots.push({
            txHash,
            settlementStatus: row?.status ?? null,
            submittedAt: row?.submittedAt !== null && row?.submittedAt !== undefined,
            submittedAuditRows: countAudits(s, "tab.settlement_submitted"),
            txHashRecorded: row?.txHash ?? null,
          });
        },
      },
      { payer: signer, vendor: VENDOR_ADDRESS }
    );

    const { TabLedger } = await import("../src/tabs/ledger.js");
    const ledger = new TabLedger({ settlementFor: () => guard.adapter });
    const ctx: ChildCtx = {
      args,
      env,
      emit,
      rpc,
      signer,
      contract,
      deployBlock: effectiveDeployBlock(env),
      startNonce: BigInt(state!.baseline!.startNonce),
      ws,
      cp,
      db,
      ledger,
      guard,
      broadcasts,
      confirmSnapshots,
      steps: [],
      step(name, data) {
        ctx.steps.push({ name, data: serialise(data) as Record<string, unknown> });
      },
      stop(reason) {
        ctx.stopped = reason;
      },
    };

    // Each scenario's child work. The send child of settle and held-adopt does the whole sequence; the crash child sends
    // once and is killed; every recover child is the restart, a tick or two.
    if (phase === "recover") await runRecoverTicks(ctx);
    else if (args.scenario === "settle") await runSettleSend(ctx);
    else if (args.scenario === "crash-after-send") await runCrashSend(ctx);
    else await runHeldSend(ctx);

    const evidence: ChildEvidence = {
      phase,
      stopped: ctx.stopped,
      steps: ctx.steps,
      confirmSnapshots,
      broadcasts: [...broadcasts],
      transferCalls: guard.transferCalls(),
    };
    emitResult(emit, evidence);
    return ctx.stopped === undefined ? 0 : 1;
  } catch (error) {
    if (error instanceof RefusedError) {
      emitResult(emit, { refused: true, reasons: error.reasons });
      return 2;
    }
    if (error instanceof BlockedError) {
      emitResult(emit, { blocked: true, reason: error.message });
      return 2;
    }
    const reason = error instanceof Error ? error.message : "unknown error";
    emitResult(emit, { failed: true, reason });
    return 1;
  } finally {
    releaseSpendLock?.();
    if (db) await db.close().catch(() => undefined);
  }
}

function emitResult(emit: (text: string) => void, value: unknown): void {
  emit(`${RESULT_PREFIX}${jsonText(value)}`);
}

/** settle: one settleTab (reserve, send, confirm), then the same call again, which must find nothing to settle. */
async function runSettleSend(ctx: ChildCtx): Promise<void> {
  const settle = await ctx.ledger.settleTab({ workspaceId: ctx.ws, counterpartyId: ctx.cp, actor: TAB_ACTOR });
  ctx.step("settle", { result: settle as unknown as Record<string, unknown>, transferCalls: ctx.guard.transferCalls() });
  const callsBefore = ctx.guard.transferCalls();
  const nonceBefore = ctx.rpc ? await readNonce(ctx.rpc, ctx.signer, "latest") : undefined;
  const repeat = await ctx.ledger.settleTab({ workspaceId: ctx.ws, counterpartyId: ctx.cp, actor: TAB_ACTOR });
  const nonceAfter = ctx.rpc ? await readNonce(ctx.rpc, ctx.signer, "latest") : undefined;
  ctx.step("repeat", {
    result: repeat as unknown as Record<string, unknown>,
    transferCallsDelta: ctx.guard.transferCalls() - callsBefore,
    nonceBefore: nonceBefore?.toString(),
    nonceAfter: nonceAfter?.toString(),
  });
}

/** crash-after-send, the send: the transfer returns, then the guard's hook kills the process before the ledger records it. */
async function runCrashSend(ctx: ChildCtx): Promise<void> {
  ctx.emit("sending one 1 cent payment for the prepared tab settlement");
  const result = await ctx.ledger.settleTab({ workspaceId: ctx.ws, counterpartyId: ctx.cp, actor: TAB_ACTOR });
  // Reaching this line means the crash point was not reached. The parent treats it as unexpected.
  ctx.step("unexpected-return", { result: result as unknown as Record<string, unknown> });
  ctx.stop("the send returned: the crash point was not reached");
}

/** The restart: the worker's tick, twice. The second tick must find nothing to do. */
async function runRecoverTicks(ctx: ChildCtx): Promise<void> {
  const { runTick } = await import("../src/workers/runner.js");
  for (const kind of tabRecoverPlan(ctx.args.scenario)) {
    const callsBefore = ctx.guard.transferCalls();
    const nonceBefore = ctx.rpc ? await readNonce(ctx.rpc, ctx.signer, "latest") : undefined;
    const tick = await runTick({
      // A minute ahead, so rows the database clock stamped a moment ago still count as stale.
      now: new Date(Date.now() + TICK_CLOCK_MARGIN_MS),
      stuckSettlingAfterMs: 0,
      confirmAfterMs: 0,
      maxPollAgeMs: ONE_WEEK_MS,
      // The orders this run does not own are not resumed by the tick.
      staleAfterMs: ONE_YEAR_MS,
      deps: { settlementFor: () => ctx.guard.adapter },
      tabs: { ledger: ctx.ledger, reconcileAfterMs: 0 },
    });
    const nonceAfter = ctx.rpc ? await readNonce(ctx.rpc, ctx.signer, "latest") : undefined;
    const snap = await ctx.db.snapshot(ctx.ws, ctx.cp);
    ctx.step(kind, {
      tab: tick.tabSettlements,
      tabErrors: tick.errors.filter((e) => e.step === "tab_settlements").map((e) => e.error),
      settlementStatus: snap.settlements[0]?.status ?? null,
      transferCallsDelta: ctx.guard.transferCalls() - callsBefore,
      nonceBefore: nonceBefore?.toString(),
      nonceAfter: nonceAfter?.toString(),
    });
  }
}

/**
 * held-adopt, all in one process (so the rehearsal's simulator keeps its transfer):
 * 1. settleTab: the transport broadcasts once and then fails with a timeout, so the outcome is unknown.
 * 2. wait until the transfer is mined.
 * 3. the supplier is unverified; executeSettlement must hold the settlement UNKNOWN, keep the clear and send nothing.
 * 4. the restore is refused: the settlement's age is set past the window (a test clock), and the chain lookup finds the transfer.
 * 5. the worker's held step adopts the hash and confirms it.
 * 6. reconcileHeld again is a no-op.
 */
async function runHeldSend(ctx: ChildCtx): Promise<void> {
  const { ledger, db, ws, cp, guard } = ctx;
  let threw: { name: string; message: string } | null = null;
  try {
    await ledger.settleTab({ workspaceId: ws, counterpartyId: cp, actor: TAB_ACTOR });
  } catch (err) {
    threw = describeError(err);
  }
  let snap = await db.snapshot(ws, cp);
  const row = snap.settlements[0];
  if (!row) return ctx.stop("the first call made no settlement");
  const settlementId = row.id;
  const orderId = tabAdapterOrderId(settlementId);
  ctx.step("timeout-send", {
    threw,
    broadcasts: ctx.broadcasts.length,
    transferCalls: guard.transferCalls(),
    settlementStatus: row.status,
    effectStatus: snap.effects[settlementId]?.status ?? null,
  });
  if (!threw || ctx.broadcasts.length !== 1 || row.status !== "pending") {
    return ctx.stop("the first call did not end in the expected unknown outcome with one broadcast");
  }

  if (ctx.rpc) {
    const rpc = ctx.rpc;
    const mined = await waitUntil(
      async () => {
        const logs = await readSettlementLogs(rpc, ctx.contract, orderId, ctx.deployBlock);
        const latest = await readNonce(rpc, ctx.signer, "latest");
        return logs.length >= 1 && latest > ctx.startNonce;
      },
      { timeoutMs: MINE_WAIT_MS, pollMs: POLL_MS, now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }
    );
    ctx.step("wait-mined", { mined });
    if (!mined) return ctx.stop("the timed-out transfer was not mined within the bound");
  } else {
    ctx.step("wait-mined", { skipped: "local-sim" });
  }

  // 3. The hold. The supplier is restored in the finally, so a failure here cannot leave it unverified.
  const callsBefore = guard.transferCalls();
  const broadcastsBefore = ctx.broadcasts.length;
  await db.setVerified(ws, cp, false);
  let hold: ExecuteOutcome;
  try {
    hold = await ledger.executeSettlement(settlementId);
  } finally {
    await db.setVerified(ws, cp, true);
  }
  snap = await db.snapshot(ws, cp);
  ctx.step("hold-unverified", {
    outcome: hold as unknown as Record<string, unknown>,
    clearsKept: clearCountOf(snap, settlementId) === 1,
    reversals: reversalCount(snap),
    broadcastsDelta: ctx.broadcasts.length - broadcastsBefore,
    transferCallsDelta: guard.transferCalls() - callsBefore,
    verifiedRestored: snap.counterparty?.verified === true,
  });
  if (hold.kind !== "held" || hold.hold !== "SETTLEMENT_OUTCOME_UNKNOWN") return ctx.stop("the unverified supplier did not hold the settlement UNKNOWN");

  // 4. The restore. The age window is a test clock: the effect's last update is moved back, so the chain lookup decides.
  await db.ageEffect(ws, settlementId, RESTORE_AGE_FIXTURE_MINUTES);
  const restore: RestoreOutcome = await ledger.cancelHeldAndRestore(settlementId, { actor: TAB_ACTOR, acknowledgeNotSent: true });
  const lookup: { found: boolean | string; status?: string; isOrderSettled: boolean | string } = { found: "not read", isOrderSettled: "not read" };
  try {
    const found = await guard.adapter.findTransfer!({ orderId });
    lookup.found = found !== null;
    lookup.status = found?.status;
  } catch (err) {
    lookup.found = `unavailable: ${describeError(err).name}`;
  }
  try {
    lookup.isOrderSettled = await guard.adapter.isOrderSettled!(orderId);
  } catch (err) {
    lookup.isOrderSettled = `unavailable: ${describeError(err).name}`;
  }
  snap = await db.snapshot(ws, cp);
  ctx.step("restore-refused", {
    outcome: restore as unknown as Record<string, unknown>,
    reversals: reversalCount(snap),
    holdStatus: snap.settlements[0]?.status ?? null,
    lookup,
    ageFixtureMinutes: RESTORE_AGE_FIXTURE_MINUTES,
  });
  if (restore.kind !== "refused") return ctx.stop("the restore was not refused");

  // 5. The worker's held step (the tick), with the same guards. It never cancels or reverses; it adopts and confirms.
  const { runTick } = await import("../src/workers/runner.js");
  const nonceBeforeTick = ctx.rpc ? await readNonce(ctx.rpc, ctx.signer, "latest") : undefined;
  const callsBeforeTick = guard.transferCalls();
  const tick = await runTick({
    now: new Date(Date.now() + TICK_CLOCK_MARGIN_MS),
    stuckSettlingAfterMs: 0,
    confirmAfterMs: 0,
    maxPollAgeMs: ONE_WEEK_MS,
    staleAfterMs: ONE_YEAR_MS,
    deps: { settlementFor: () => guard.adapter },
    tabs: { ledger, reconcileAfterMs: 0 },
  });
  const nonceAfterTick = ctx.rpc ? await readNonce(ctx.rpc, ctx.signer, "latest") : undefined;
  snap = await db.snapshot(ws, cp);
  ctx.step("worker-tick", {
    tab: tick.tabSettlements,
    tabErrors: tick.errors.filter((e) => e.step === "tab_settlements").map((e) => e.error),
    settlementStatus: snap.settlements[0]?.status ?? null,
    txHash: snap.settlements[0]?.txHash ?? null,
    transferCallsDelta: guard.transferCalls() - callsBeforeTick,
    nonceBefore: nonceBeforeTick?.toString(),
    nonceAfter: nonceAfterTick?.toString(),
  });

  // 6. reconcileHeld again: nothing to adopt, nothing sent.
  const nonceBeforeRepeat = ctx.rpc ? await readNonce(ctx.rpc, ctx.signer, "latest") : undefined;
  const callsBeforeRepeat = guard.transferCalls();
  const repeat: ReconcileOutcome = await ledger.reconcileHeld(settlementId);
  const nonceAfterRepeat = ctx.rpc ? await readNonce(ctx.rpc, ctx.signer, "latest") : undefined;
  ctx.step("reconcile-repeat", {
    outcome: repeat as unknown as Record<string, unknown>,
    transferCallsDelta: guard.transferCalls() - callsBeforeRepeat,
    nonceBefore: nonceBeforeRepeat?.toString(),
    nonceAfter: nonceAfterRepeat?.toString(),
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The real edges: the database, child processes, the entry point
// ---------------------------------------------------------------------------------------------------------------------

/** Splits a stream into lines, keeping a partial line until its end arrives. */
function lineSplitter(onLine: (line: string) => void): { push(chunk: Buffer): void; flush(): void } {
  let pending = "";
  return {
    push(chunk: Buffer) {
      pending += chunk.toString("utf8");
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        onLine(pending.slice(0, index));
        pending = pending.slice(index + 1);
      }
    },
    flush() {
      if (pending.length > 0) onLine(pending);
      pending = "";
    },
  };
}

/** Runs one child phase: this script again, under tsx, with the same environment and no added variables. */
export function spawnTabChild(childArgv: string[], timeoutMs: number, scrub: (text: string) => string): Promise<ChildOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", SCRIPT_PATH, ...childArgv], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const lines: string[] = [];
    const keep = (line: string) => lines.push(scrub(line));
    const out = lineSplitter(keep);
    const err = lineSplitter(keep);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      out.flush();
      err.flush();
      const resultLine = [...lines].reverse().find((l) => l.startsWith(RESULT_PREFIX));
      let result: unknown;
      if (resultLine) {
        try {
          result = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
        } catch {
          result = undefined;
        }
      }
      resolve({ code, signal, timedOut, result, lines });
    });
  });
}

/** The real database port. Pools and the ledger are loaded on first use, so the static guards run without them. */
export async function openRealTabDb(): Promise<ChildDb> {
  const { query, closePool } = await import("../src/db/client.js");
  const { provisionWorkspace } = await import("../src/templates/registry.js");
  const { TabLedger } = await import("../src/tabs/ledger.js");
  const readSnapshot = async (ws: string, cp: string): Promise<TabSnapshot> => {
    const settlements = (
      await query(
        `SELECT id, amount_cents::text AS amount_cents, status, tx_hash, hold_reason, submitted_at, confirmed_at,
                confirmed_block::text AS confirmed_block, reconcile_attempts
         FROM tab_settlements WHERE workspace_id = $1 AND counterparty_id = $2 ORDER BY created_at, id;`,
        [ws, cp]
      )
    ).rows;
    const entries = (
      await query(
        `SELECT kind, amount_micro::text AS amount_micro, settlement_id FROM tab_entries
         WHERE workspace_id = $1 AND counterparty_id = $2 ORDER BY created_at, id;`,
        [ws, cp]
      )
    ).rows;
    const keys = settlements.map((s) => ledgerKeys.effect(ws, String(s.id)));
    const effects =
      keys.length === 0
        ? []
        : (await query(`SELECT idempotency_key, status, attempts, operation, external_ref FROM effects WHERE idempotency_key = ANY($1::text[]);`, [keys])).rows;
    const audits = (
      await query(`SELECT action, tx_hash FROM audit_logs WHERE workspace_id = $1 AND action LIKE 'tab.%' ORDER BY created_at, id;`, [ws])
    ).rows;
    const supplier = (await query(`SELECT verified, payment_address FROM suppliers WHERE workspace_id = $1 AND id = $2;`, [ws, cp])).rows[0] ?? null;
    return toTabSnapshot({ workspaceId: ws, settlements, entries, effects, audits, supplier });
  };
  /** The name and the workspaces: read-only. A new run needs no workspace rows; a reuse needs only the state's. */
  const rowsCheck = async (expected: string | null): Promise<string[]> => {
    const reasons: string[] = [];
    const current = await query(`SELECT current_database() AS name, to_regclass('public.bind_live_marker')::text AS marker;`);
    const problem = databaseNameProblem(String(current.rows[0].name), current.rows[0].marker !== null);
    if (problem) reasons.push(problem);
    const workspaces = await query(`SELECT id FROM workspaces;`);
    const rows = workspaceRowsProblem(
      workspaces.rows.map((r) => String(r.id)),
      expected
    );
    if (rows) reasons.push(rows);
    return reasons;
  };
  return {
    async rowsCheck(expectedWorkspaceId) {
      return rowsCheck(expectedWorkspaceId);
    },
    async precheck() {
      const reasons: string[] = await rowsCheck(null);
      const open = await query(`SELECT COUNT(*)::int AS n FROM tab_settlements WHERE status IN ('pending', 'submitted', 'held');`);
      if (open.rows[0].n > 0) {
        reasons.push("the database holds tab settlements that are pending, submitted or held; this run needs an empty, dedicated database");
      }
      const due = await query(
        `SELECT COUNT(*)::int AS n FROM (
           SELECT 1 FROM tab_entries GROUP BY workspace_id, counterparty_id
           HAVING SUM(CASE kind WHEN 'clear' THEN -amount_micro ELSE amount_micro END) >= 10000) x;`
      );
      if (due.rows[0].n > 0) reasons.push("the database holds a tab with at least one cent; the worker would settle it; use a dedicated database");
      const orders = await query(`SELECT COUNT(*)::int AS n FROM orders WHERE status IN ('settling', 'settlement_submitted');`);
      if (orders.rows[0].n > 0) reasons.push("the database holds orders in settlement; the worker's order steps would act on them; use a dedicated database");
      return reasons;
    },
    async prepare({ scenario, payer, vendor, adapter }) {
      const suffix = `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
      const workspaceId = `ws-tab-${suffix}`;
      const counterpartyId = `tabvendor-${suffix}`;
      // The fixture's limits are one cent a day and a one-cent approval threshold: the most this run can ever settle.
      await provisionWorkspace(workspaceId, `Live tab ${scenario} (${adapter})`, "kitchen-v1", {
        customDailyLimitCents: 1n,
        customApprovalThresholdCents: 1n,
      });
      // Set after provisioning: the settlement address is the signer, and the mode is arc-testnet for a live run.
      await query(`UPDATE workspaces SET settlement_address = $2 WHERE id = $1;`, [workspaceId, payer]);
      await query(`UPDATE workspaces SET settlement_mode = $2 WHERE id = $1;`, [workspaceId, adapter === "arc" ? "arc-testnet" : "local"]);
      // A fixture counterparty, verified, with the whitelisted vendor as its payment address.
      await query(
        `INSERT INTO suppliers (id, workspace_id, name, adapter_type, verified, is_simulated, payment_address)
         VALUES ($1, $2, 'Live tab vendor', 'simulated_sysco', TRUE, TRUE, $3);`,
        [counterpartyId, workspaceId, vendor]
      );
      const ledger = new TabLedger();
      for (let i = 1; i <= CHARGE_COUNT; i += 1) {
        await ledger.accrueCharge({
          workspaceId,
          counterpartyId,
          amountMicro: CHARGE_MICRO,
          idempotencyKey: `${scenario}-c${i}`,
          description: `Sub-cent charge ${i}`,
          actor: TAB_ACTOR,
        });
      }
      return { workspaceId, counterpartyId };
    },
    snapshot: readSnapshot,
    async settlementRow(ws, settlementId) {
      const row = (
        await query(`SELECT id, counterparty_id, status, amount_cents::text AS amount_cents FROM tab_settlements WHERE id = $1 AND workspace_id = $2;`, [
          settlementId,
          ws,
        ])
      ).rows[0];
      return row ? { id: String(row.id), counterpartyId: String(row.counterparty_id), status: String(row.status), amountCents: String(row.amount_cents) } : null;
    },
    async setVerified(ws, cp, verified) {
      await query(`UPDATE suppliers SET verified = $3 WHERE workspace_id = $1 AND id = $2;`, [ws, cp, verified]);
    },
    async ageEffect(ws, settlementId, minutes) {
      await query(`UPDATE effects SET updated_at = NOW() - ($2::int * INTERVAL '1 minute') WHERE idempotency_key = $1;`, [
        ledgerKeys.effect(ws, settlementId),
        minutes,
      ]);
    },
    close: () => closePool(),
  };
}

/** Writes a line of the child's own output. The scrubber is applied by the caller. */
function realTabPorts(env: Env, emit: (text: string) => void, scrub: (text: string) => string): TabPorts {
  let dbPromise: Promise<ChildDb> | undefined;
  const db = (): Promise<ChildDb> => (dbPromise ??= openRealTabDb());
  return {
    env,
    emit,
    notify: (text) => {
      process.stderr.write(`${scrub(text)}\n`);
    },
    files: realFiles(scrub),
    rpc: env.ARC_RPC_URL && isHttpUrl(env.ARC_RPC_URL) ? httpRpc(env.ARC_RPC_URL) : undefined,
    db: {
      precheck: async () => (await db()).precheck(),
      rowsCheck: async (ws) => (await db()).rowsCheck(ws),
      prepare: async (input) => (await db()).prepare(input),
      snapshot: async (ws, cp) => (await db()).snapshot(ws, cp),
      close: async () => {
        if (dbPromise) await (await dbPromise).close();
      },
    },
    spend: realSpendLedger(),
    spawnPhase: (argv, timeoutMs) => spawnTabChild(argv, timeoutMs, scrub),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}

/** The command. Child phases and the orchestrator share this entry point. Returns the exit code. */
export async function cli(argv: string[], env: Env = process.env): Promise<number> {
  const scrub = makeScrubber(env);
  const emit = (text: string) => {
    process.stdout.write(`${scrub(text)}\n`);
  };
  let args: TabCliArgs;
  try {
    args = parseTabArgs(argv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : USAGE;
    emit(jsonText({ result: "REFUSED", reasons: [reason] }, true));
    return 2;
  }
  if (args.phase === "send-child" || args.phase === "recover-child") {
    return runTabChild(args, env, emit, openRealTabDb);
  }
  if (args.preflight) return runTabPreflight(args, realTabPorts(env, emit, scrub));
  return runTabOrchestrator(args, realTabPorts(env, emit, scrub));
}

const isEntrypoint = process.argv[1] !== undefined && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isEntrypoint) {
  cli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const scrub = makeScrubber(process.env);
      const message = scrub(error instanceof Error ? error.message : String(error));
      process.stdout.write(`${jsonText({ result: "FAIL", reasons: [message] }, true)}\n`);
      process.exitCode = 1;
    }
  );
}
