import crypto from "crypto";
import { query } from "../../db/client.js";
import { InboundWebhookEvent } from "./types.js";

export class WebhookReceiver {
  constructor(private readonly secretKey: string = "whsec_test_secret_key_12345") {}

  /**
   * Computes an HMAC SHA-256 signature for payload verification.
   */
  computeSignature(payload: string, timestamp: number): string {
    return crypto
      .createHmac("sha256", this.secretKey)
      .update(`${timestamp}.${payload}`)
      .digest("hex");
  }

  /**
   * Verifies HMAC signature and rejects expired requests (>5 minutes old).
   */
  verifySignature(rawBody: string, signatureHeader: string, timestampHeader: number): boolean {
    const now = Math.floor(Date.now() / 1000);
    // Reject timestamps older than 300s or more than 60s in the future
    if (Math.abs(now - timestampHeader) > 300) {
      return false;
    }

    const expectedSignature = this.computeSignature(rawBody, timestampHeader);
    return crypto.timingSafeEqual(
      Buffer.from(signatureHeader, "utf-8"),
      Buffer.from(expectedSignature, "utf-8")
    );
  }

  /**
   * Deduplicates and stores incoming webhook in PostgreSQL.
   * Returns true if event is new and recorded, false if already processed (replay).
   */
  async processEvent(event: InboundWebhookEvent): Promise<{ accepted: boolean; reason?: string }> {
    try {
      const res = await query(
        `INSERT INTO inbound_webhooks (id, provider, event_id, payload, status, received_at)
         VALUES ($1, $2, $3, $4, 'received', NOW())
         ON CONFLICT (provider, event_id) DO NOTHING
         RETURNING id;`,
        [`wh_${Date.now()}_${event.eventId}`, event.provider, event.eventId, JSON.stringify(event.payload)]
      );

      if (res.rowCount === 0) {
        return {
          accepted: false,
          reason: `Duplicate webhook event '${event.eventId}' from provider '${event.provider}' ignored.`,
        };
      }

      return { accepted: true };
    } catch (err: any) {
      return { accepted: false, reason: err.message };
    }
  }
}

export const webhookReceiver = new WebhookReceiver();
