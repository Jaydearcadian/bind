import { NotificationPayload, NotificationResult, NotificationChannel } from "./types.js";
import { newId } from "../../utils/ids.js";
import { config } from "../../config/env.js";
import { sendOwnerNoticeEmail } from "../../notifications/email.js";

export class NotificationEmitter {
  private sentNotifications: NotificationPayload[] = [];

  async send(payload: NotificationPayload): Promise<NotificationResult> {
    this.sentNotifications.push(payload);

    // Email goes to a live provider only when one is configured (ADR 0074). A send that the provider refuses throws, so the
    // effects ledger marks it failed. Without a provider, email is simulated like every other channel.
    if (payload.channel === "email" && config.BIND_EMAIL_PROVIDER !== undefined) {
      const accepted = await sendOwnerNoticeEmail(payload);
      return { messageId: accepted.id, channel: payload.channel, status: "sent", timestamp: new Date() };
    }

    const messageId = newId(`msg_${payload.channel}`);

    // In a live environment with configured API keys, this would dispatch to Twilio/Postmark/Telegram
    // In local / test mode, we provide deterministic delivery receipts
    return {
      messageId,
      channel: payload.channel,
      status: "simulated",
      timestamp: new Date(),
    };
  }

  getSentNotifications(channel?: NotificationChannel): NotificationPayload[] {
    if (channel) {
      return this.sentNotifications.filter((n) => n.channel === channel);
    }
    return [...this.sentNotifications];
  }

  clear(): void {
    this.sentNotifications = [];
  }
}

export const notificationEmitter = new NotificationEmitter();
