/**
 * The open event streams of this process (docs/decisions/0035): the caps, the registry that shutdown walks, and the writer
 * that ends a stream whose client does not read. Process-wide on purpose: the caps are per process, and shutdown must reach
 * every stream the process holds.
 */
import type { EventEmitter } from "node:events";
import { sseStreams, sseStreamsRejected } from "../observability/metrics.js";

export type CapReason = "token" | "workspace" | "global";

/** The caps a new stream must fit under (docs/decisions/0035). Checked in this order: token, workspace, global. */
export interface StreamCaps {
  perToken: number;
  perWorkspace: number;
  global: number;
}

/** What a stream registers: whose it is, and how to end it. */
export interface StreamEntry {
  tokenId: string;
  workspaceId: string;
  /** Ends the stream. For reason "shutdown" the stream first tells the client to reconnect. Must be idempotent. */
  close: (reason: string) => void;
}

export type ClaimResult = { claimed: true; release: () => void } | { claimed: false; reason: CapReason };

const open = new Set<StreamEntry>();

function publishCount(): void {
  sseStreams.set({}, open.size);
}

/**
 * Registers a stream if the caps allow it. The check and the registration are one synchronous step, so two requests
 * cannot both take the last slot. A refusal is counted by reason.
 */
export function claimStream(entry: StreamEntry, caps: StreamCaps): ClaimResult {
  let forToken = 0;
  let forWorkspace = 0;
  for (const other of open) {
    if (other.tokenId === entry.tokenId) forToken += 1;
    if (other.workspaceId === entry.workspaceId) forWorkspace += 1;
  }
  let refusal: CapReason | null = null;
  if (forToken >= caps.perToken) refusal = "token";
  else if (forWorkspace >= caps.perWorkspace) refusal = "workspace";
  else if (open.size >= caps.global) refusal = "global";
  if (refusal !== null) {
    sseStreamsRejected.inc({ reason: refusal });
    return { claimed: false, reason: refusal };
  }

  open.add(entry);
  publishCount();
  let released = false;
  return {
    claimed: true,
    release: () => {
      if (released) return;
      released = true;
      open.delete(entry);
      publishCount();
    },
  };
}

/** The number of open streams in this process. */
export function countOpenStreams(): number {
  return open.size;
}

/** Open streams of one token, or of one workspace, for tests and diagnostics. */
export function countOpenStreamsFor(filter: { tokenId?: string; workspaceId?: string }): number {
  let count = 0;
  for (const entry of open) {
    if (filter.tokenId !== undefined && entry.tokenId !== filter.tokenId) continue;
    if (filter.workspaceId !== undefined && entry.workspaceId !== filter.workspaceId) continue;
    count += 1;
  }
  return count;
}

/**
 * Ends every open stream with the reason (docs/decisions/0035). Called by shutdown before the server stops. Returns how many
 * streams it asked to end. A stream that throws while ending is skipped, so one bad stream cannot hold the others open.
 */
export function closeAllEventStreams(reason: string = "shutdown"): number {
  const entries = [...open];
  for (const entry of entries) {
    try {
      entry.close(reason);
    } catch {
      // The stream is already gone or cannot be written. Its registration is removed by its own release.
    }
  }
  return entries.length;
}

/** The part of a response the writer needs. ServerResponse satisfies it. */
export interface BackpressureTarget extends EventEmitter {
  write(chunk: string): boolean;
  destroyed?: boolean;
  writableEnded?: boolean;
}

export type WriteOutcome = "written" | "drained" | "timed_out" | "closed";

/**
 * Writes one chunk. When the target reports a full buffer, waits for it to drain, for at most drainTimeoutMs. "written" and
 * "drained" are fine; "timed_out" means the client does not read and the stream must end; "closed" means it has gone.
 * Every listener it adds is removed before it resolves.
 */
export function writeWithBackpressure(
  target: BackpressureTarget,
  chunk: string,
  options: { drainTimeoutMs: number }
): Promise<WriteOutcome> {
  if (target.destroyed === true || target.writableEnded === true) return Promise.resolve("closed");
  if (target.write(chunk)) return Promise.resolve("written");
  return new Promise<WriteOutcome>((resolve) => {
    const finish = (outcome: WriteOutcome) => {
      clearTimeout(timer);
      target.removeListener("drain", onDrain);
      target.removeListener("close", onClose);
      resolve(outcome);
    };
    const onDrain = () => finish("drained");
    const onClose = () => finish("closed");
    const timer = setTimeout(() => finish("timed_out"), options.drainTimeoutMs);
    target.on("drain", onDrain);
    target.on("close", onClose);
  });
}
