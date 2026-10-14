import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { closePool } from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";
import { webhookReceiver } from "../../src/adapters/web2/webhook-receiver.js";

describe("Inbound Webhook Receiver & Replay Protection", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it("verifies and accepts a valid signed webhook", async () => {
    const rawPayload = JSON.stringify({ event: "inventory.low_stock", sku: "FOOD-FLOUR-50LB" });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = webhookReceiver.computeSignature(rawPayload, timestamp);

    const isValid = webhookReceiver.verifySignature(rawPayload, signature, timestamp);
    expect(isValid).toBe(true);

    const eventId = `evt_test_${Date.now()}`;
    const res = await webhookReceiver.processEvent({
      provider: "toast_pos",
      eventId,
      timestamp,
      payload: JSON.parse(rawPayload),
    });

    expect(res.accepted).toBe(true);
  });

  it("rejects an invalid HMAC signature", () => {
    const rawPayload = JSON.stringify({ event: "order.placed" });
    const timestamp = Math.floor(Date.now() / 1000);
    const badSignature = "0000000000000000000000000000000000000000000000000000000000000000";

    const isValid = webhookReceiver.verifySignature(rawPayload, badSignature, timestamp);
    expect(isValid).toBe(false);
  });

  it("rejects expired webhook timestamps (>5 minutes old)", () => {
    const rawPayload = JSON.stringify({ event: "order.placed" });
    const oldTimestamp = Math.floor(Date.now() / 1000) - 400; // 400 seconds ago
    const signature = webhookReceiver.computeSignature(rawPayload, oldTimestamp);

    const isValid = webhookReceiver.verifySignature(rawPayload, signature, oldTimestamp);
    expect(isValid).toBe(false);
  });

  it("blocks replay attacks with duplicate eventId from the same provider", async () => {
    const eventId = `evt_replay_${Date.now()}`;
    const event = {
      provider: "square_pos",
      eventId,
      timestamp: Math.floor(Date.now() / 1000),
      payload: { item: "Coffee Beans", qty: 2 },
    };

    const firstAttempt = await webhookReceiver.processEvent(event);
    expect(firstAttempt.accepted).toBe(true);

    // Replay exact same event
    const secondAttempt = await webhookReceiver.processEvent(event);
    expect(secondAttempt.accepted).toBe(false);
    expect(secondAttempt.reason).toMatch(/Duplicate webhook event/i);
  });
});
