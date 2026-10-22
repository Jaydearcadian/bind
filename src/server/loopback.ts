/**
 * The loopback marker (docs/decisions/0075). The hosted MCP endpoint calls its own app over a loopback listener, once per tool
 * call. Those calls already passed the outer request's gate, so the global per-address limits must not count them: otherwise
 * one tenant's bad keys, or the loopback address itself, would block every tenant's agents.
 *
 * A request is marked only by the listener this module's owner creates, and only when it carries that listener's secret header.
 * An external client cannot reach the listener (it is bound to 127.0.0.1 and the secret is random per process), and a header on
 * an ordinary request never marks it.
 */
import type { IncomingMessage } from "node:http";

/** The header that carries the loopback secret. Set by the factory (mcp/src/hosted.ts) on every loopback call. */
export const LOOPBACK_HEADER = "x-bind-loopback";

const marked = new WeakSet<IncomingMessage>();

/** Marks one request as a loopback call of this process. Called only by the loopback listener. */
export function markLoopback(req: IncomingMessage): void {
  marked.add(req);
}

/** True for a request the loopback listener marked. */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  return marked.has(req);
}
