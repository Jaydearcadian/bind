/**
 * Chunked log scans for the settlement lookups. An Arc RPC refuses an eth_getLogs over a span of more than 100000
 * blocks ("query exceeds max block range 100000"), so a scan from the deploy block to the head fails on a long chain.
 * These helpers scan the span in windows instead.
 *
 * Rules that the callers rely on:
 * - Windows are inclusive at both ends, consecutive, and cover [deployBlock, latest] with no gap and no overlap.
 * - A window that fails throws. A failure is never read as "no log in this window".
 * - A "max block range N" error may shrink the window size once, to N, and the same window is retried once. A second
 *   range error throws. The loop is therefore bounded by the number of windows, which is finite.
 * - A deploy block ahead of the head leaves an empty span: there are no windows, and nothing is read. That is "no log in
 *   an empty span", not an error. Errors from the RPC still throw.
 * No RPC call is made here other than the ones the caller's fetchRange makes.
 */

/** The window size the Arc settlement lookups use. Below the RPC's 100000-block limit, with room to spare. */
export const ARC_LOG_CHUNK_BLOCKS = 90_000;

export interface LogScanInput<T> {
  /** The head block, read by the caller just before the scan. */
  latest: bigint;
  /** The first block that can hold the contract's logs. */
  deployBlock: bigint;
  /** The window size, a positive integer. */
  chunkBlocks: number;
  /** Returns the logs of one inclusive window. Any error propagates. */
  fetchRange: (from: bigint, to: bigint) => Promise<T[]>;
  /** Reads a smaller window size named by a "max block range N" error, or undefined when the error names none. */
  rangeLimitOf: (error: unknown) => number | undefined;
}

/** The windows of a scan, newest first, as inclusive [from, to] pairs. Exposed so the tests can assert the exact sequence. */
export function windowsNewestFirst(latest: bigint, deployBlock: bigint, chunkBlocks: number): Array<[bigint, bigint]> {
  const out: Array<[bigint, bigint]> = [];
  let to = latest;
  const size = BigInt(chunkBlocks);
  while (to >= deployBlock) {
    let from = to - size + 1n;
    if (from < deployBlock) from = deployBlock;
    out.push([from, to]);
    to = from - 1n;
  }
  return out;
}

/**
 * Scans the windows newest first and calls onWindow with each window's logs. onWindow returns true to stop the scan.
 * Returns true when it stopped early. Throws on a bad chunk size or on any failed window. An empty span reads nothing.
 */
export async function scanLogWindows<T>(
  input: LogScanInput<T>,
  onWindow: (logs: T[]) => boolean
): Promise<boolean> {
  if (!Number.isInteger(input.chunkBlocks) || input.chunkBlocks < 1) {
    throw new Error("the scan window size must be a positive integer");
  }
  let size = BigInt(input.chunkBlocks);
  let retried = false;
  let to = input.latest;
  while (to >= input.deployBlock) {
    let from = to - size + 1n;
    if (from < input.deployBlock) from = input.deployBlock;
    let logs: T[];
    try {
      logs = await input.fetchRange(from, to);
    } catch (error) {
      const limit = input.rangeLimitOf(error);
      if (!retried && limit !== undefined && limit >= 1 && BigInt(limit) < size) {
        retried = true;
        size = BigInt(limit);
        continue;
      }
      throw error;
    }
    if (onWindow(logs)) return true;
    to = from - 1n;
  }
  return false;
}

/** The first log of the newest window that holds one, or undefined when no window does. */
export async function findNewestLog<T>(input: LogScanInput<T>): Promise<T | undefined> {
  let found: T | undefined;
  await scanLogWindows(input, (logs) => {
    if (logs.length === 0) return false;
    found = logs[0];
    return true;
  });
  return found;
}

/** Every log in [deployBlock, latest], gathered window by window. */
export async function collectLogs<T>(input: LogScanInput<T>): Promise<T[]> {
  const all: T[] = [];
  await scanLogWindows(input, (logs) => {
    all.push(...logs);
    return false;
  });
  return all;
}

/**
 * Reads a "max block range N" limit from an error and its causes. The RPC text can sit in the message, shortMessage, details
 * or a cause. Only a positive integer after the phrase counts. The walk is bounded.
 */
export function rangeLimitOfError(error: unknown): number | undefined {
  let node: unknown = error;
  for (let depth = 0; node !== null && typeof node === "object" && depth < 6; depth++) {
    const record = node as { message?: unknown; shortMessage?: unknown; details?: unknown; cause?: unknown };
    for (const text of [record.message, record.shortMessage, record.details]) {
      if (typeof text !== "string") continue;
      const match = /max block range[^0-9]*(\d+)/i.exec(text);
      if (match) {
        const value = Number(match[1]);
        if (Number.isSafeInteger(value) && value >= 1) return value;
      }
    }
    node = record.cause;
  }
  return undefined;
}
