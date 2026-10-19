import { query } from "../../db/client.js";
import { config } from "../../config/env.js";
import { newId } from "../../utils/ids.js";
import { signPayload, verifySignature, WebhookNotConfiguredError } from "../../webhooks/signing.js";
import { InboundWebhookEvent } from "./types.js";

/** Reason returned when the event could not be stored. The database error itself is never returned (ADR 0022). */
export const WEBHOOK_NOT_RECORDED = "Webhook could not be recorded";

export type WebhookSecretSource = string | null | undefined | (() => string | null | undefined);

export interface ProcessEventResult {
  accepted: boolean;
  reason?: string;
  /** True when the event was not stored because of a storage failure. The caller may retry it. */
  retryable?: boolean;
}

/**
 * Standard webhooks: a shared secret from configuration, a signature over the raw body, and a replay check on
 * (provider, event_id). There is no default secret. With no secret configured, computing or verifying a signature
 * throws WebhookNotConfiguredError, and the route answers 503.
 */
export class WebhookReceiver {
  private readonly secretOf: () => string | null | undefined;

  constructor(secret: WebhookSecretSource = () => config.BIND_WEBHOOK_SECRET) {
    this.secretOf = typeof secret === "function" ? secret : () => secret;
  }

  private secret(): string {
    const value = this.secretOf();
    if (!value) throw new WebhookNotConfiguredError();
    return value;
  }

  /** HMAC SHA-256 over `timestamp.rawBody`, in hex. */
  computeSignature(payload: string | Buffer, timestamp: number): string {
    return signPayload(this.secret(), timestamp, payload);
  }

  /** Verifies the signature and rejects timestamps older than 300s or more than 60s in the future. Never throws on bad input. */
  verifySignature(rawBody: string | Buffer, signatureHeader: string, timestampHeader: number): boolean {
    return verifySignature({
      secret: this.secret(),
      timestamp: timestampHeader,
      rawBody,
      signature: signatureHeader,
    });
  }

  /**
   * Stores an incoming event. Returns accepted: false with a reason when the event was already recorded for this
   * provider, or when it could not be recorded (retryable). The row id is random and carries no client text.
   */
  async processEvent(event: InboundWebhookEvent): Promise<ProcessEventResult> {
    try {
      const res = await query(
        `INSERT INTO inbound_webhooks (id, provider, event_id, payload, status, received_at)
         VALUES ($1, $2, $3, $4, 'received', NOW())
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING id;`,
        [newId("wh"), event.provider, event.eventId, JSON.stringify(event.payload)]
      );

      if (res.rowCount === 0) {
        return {
          accepted: false,
          reason: `Duplicate webhook event '${event.eventId}' from provider '${event.provider}' ignored.`,
        };
      }

      return { accepted: true };
    } catch {
      return { accepted: false, reason: WEBHOOK_NOT_RECORDED, retryable: true };
    }
  }
}

/** The receiver for the process configuration. The API builds its own per app, so tests can run unconfigured. */
export const webhookReceiver = new WebhookReceiver();
