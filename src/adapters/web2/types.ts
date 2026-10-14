export type NotificationChannel = "whatsapp" | "email" | "telegram";

export interface NotificationPayload {
  workspaceId: string;
  channel: NotificationChannel;
  recipient: string;
  title: string;
  message: string;
  actionUrl?: string;
  approvalToken?: string;
  metadata?: Record<string, any>;
}

export interface InboundWebhookEvent {
  provider: string;
  eventId: string;
  timestamp: number;
  signature?: string;
  payload: Record<string, any>;
}

export interface NotificationResult {
  messageId: string;
  channel: NotificationChannel;
  status: "delivered" | "queued" | "simulated";
  timestamp: Date;
}
