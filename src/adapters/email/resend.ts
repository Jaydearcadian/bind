/**
 * The Resend email transport (ADR 0074). One POST to `${apiBase}/emails` with a bearer key. It has no retries: the effects
 * ledger makes an owner notice at most once, so a send with an unknown outcome stays in doubt. A 2xx answer with an id is
 * the only success. Every failure is an EmailTransportError whose message names the reason and, for an HTTP answer, the
 * status. It never carries the key, the recipient address, the subject or the provider's response body.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailTransport {
  /** Resolves with the provider's message id once the provider has accepted the message. */
  send(message: EmailMessage): Promise<{ id: string }>;
}

export type EmailTransportFailure = "timeout" | "network" | "http" | "malformed_response";

export class EmailTransportError extends Error {
  readonly reason: EmailTransportFailure;
  readonly status?: number;

  constructor(reason: EmailTransportFailure, status?: number) {
    super(describe(reason, status));
    this.name = "EmailTransportError";
    this.reason = reason;
    this.status = status;
  }
}

function describe(reason: EmailTransportFailure, status?: number): string {
  switch (reason) {
    case "timeout":
      return "Email provider did not answer in time";
    case "network":
      return "Email provider could not be reached";
    case "http":
      return `Email provider refused the message (HTTP ${status ?? "unknown"})`;
    case "malformed_response":
      return "Email provider answered with an unexpected response";
  }
}

export interface ResendOptions {
  apiKey: string;
  from: string;
  /** Default https://api.resend.com. The caller has already checked the URL rule (emailBaseUrlAllowed). */
  apiBase?: string;
  /** Injected for tests. Default: the global fetch. */
  fetch?: typeof fetch;
  /** Default 10 seconds, for the whole exchange including the body. */
  timeoutMs?: number;
}

const DEFAULT_API_BASE = "https://api.resend.com";
const DEFAULT_TIMEOUT_MS = 10_000;
/** A provider id is short. A longer one is refused rather than stored. */
const MAX_ID_LENGTH = 200;

export function createResendTransport(options: ResendOptions): EmailTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const base = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async send(message: EmailMessage): Promise<{ id: string }> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(`${base}/emails`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              from: options.from,
              to: [message.to],
              subject: message.subject,
              text: message.text,
            }),
            signal: controller.signal,
          });
        } catch {
          throw new EmailTransportError(controller.signal.aborted ? "timeout" : "network");
        }

        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new EmailTransportError("http", response.status);
        }

        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new EmailTransportError(controller.signal.aborted ? "timeout" : "malformed_response");
        }
        const id = (body as { id?: unknown } | null)?.id;
        if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) {
          throw new EmailTransportError("malformed_response");
        }
        return { id };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
