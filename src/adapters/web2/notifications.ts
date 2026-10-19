import { NotificationPayload, NotificationResult, NotificationChannel } from "./types.js";
import { newId } from "../../utils/ids.js";

export class NotificationEmitter {
  private sentNotifications: NotificationPayload[] = [];

  async send(payload: NotificationPayload): Promise<NotificationResult> {
    this.sentNotifications.push(payload);

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
