import { describe, it, expect } from "vitest";
import { eventData } from "../../src/api/events.js";

/**
 * The sync's audit row carries three counts (docs/decisions/0090). They are numbers, and only numbers leave the server under those
 * keys, whatever the row holds. Free text is still dropped everywhere.
 */
describe("the analytics count keys in the event allowlist", () => {
  it("sends posts, inserted and updated only as numbers", () => {
    const out = eventData({ posts: "58", inserted: true, updated: [1, 2], accountId: "ana_1", status: "synced" }, null);
    expect(out).toEqual({ accountId: "ana_1", status: "synced" });
    expect(eventData({ posts: 58, inserted: 3, updated: 55 }, null)).toEqual({ posts: 58, inserted: 3, updated: 55 });
  });

  it("drops a non-finite number under a count key, as it does under any key", () => {
    expect(eventData({ posts: Number.NaN, inserted: Number.POSITIVE_INFINITY }, null)).toEqual({});
  });

  it("still drops free text, whatever key it sits under", () => {
    expect(eventData({ caption: "Buy our soup", posts: 4, brandLabel: "Acme" }, null)).toEqual({ posts: 4 });
  });
});
