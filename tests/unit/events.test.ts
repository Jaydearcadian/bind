import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import {
  parseCursor,
  formatCursor,
  mapAuditRow,
  eventData,
  isVisibleToRole,
  type AuditRowForEvents,
} from "../../src/api/events.js";
import { writeWithBackpressure } from "../../src/api/event-streams.js";

/*
 * Pure parts of the event stream (docs/decisions/0035): the cursor, the envelope and its key allowlist, the staff filter and
 * the backpressure helper. No database and no HTTP: the integration file covers those.
 */

function row(overrides: Partial<AuditRowForEvents> = {}): AuditRowForEvents {
  return {
    cursor_txid: "100",
    cursor_seq: "7",
    created_at: new Date("2026-10-20T10:00:00.000Z"),
    action: "approval.approved",
    effect_class: "commercial_commitment",
    policy_decision: "ALLOW",
    actor_type: "owner",
    actor_id: "owner:kitchen-owner",
    workflow_id: "wf_1",
    evidence: {},
    tx_hash: null,
    ...overrides,
  };
}

describe("event cursors", () => {
  it("a cursor round-trips", () => {
    const parsed = parseCursor("123456.789");
    expect(parsed).toEqual({ txid: "123456", seq: "789" });
    expect(formatCursor(parsed!.txid, parsed!.seq)).toBe("123456.789");
    expect(formatCursor("0", "0")).toBe("0.0");
    // The largest value a bigint column holds is accepted and comes back unchanged.
    expect(parseCursor("9223372036854775807.9223372036854775807")).toEqual({
      txid: "9223372036854775807",
      seq: "9223372036854775807",
    });
  });

  it("malformed cursors are rejected", () => {
    const malformed = [
      "",
      "abc",
      "1",
      "1.",
      ".1",
      "1.2.3",
      "-1.2",
      "1.-2",
      "1e3.2",
      "0x10.2",
      " 1.2",
      "1.2 ",
      "1.2\n",
      "1,2",
      "١.٢",
      "1.2&x=1",
      // More than a bigint holds: PostgreSQL would fail the comparison, so it is malformed here.
      "9223372036854775808.1",
      "1.9999999999999999999",
    ];
    for (const raw of malformed) {
      expect(parseCursor(raw), JSON.stringify(raw)).toBeNull();
    }
    expect(parseCursor(undefined)).toBeNull();
    expect(parseCursor(["1.2"])).toBeNull();
  });
});

describe("event envelope", () => {
  it("the envelope keeps only allowed keys", () => {
    const data = eventData(
      {
        orderId: "ord_1",
        supplierId: "sup_1",
        status: "accepted",
        code: "OK",
        codes: ["A", "B"],
        reason: "a free text reason the owner typed",
        error: "a database message",
        note: "a note",
        label: "a label",
        message: "a message",
        units: 4,
        sku: "SKU-1",
        hold: "PAYMENT",
        attempts: 2,
        extractedData: { payee: "someone" },
      },
      null
    );
    expect(Object.keys(data).sort()).toEqual(["attempts", "code", "codes", "hold", "orderId", "sku", "status", "supplierId", "units"]);
  });

  it("long strings and nested values are dropped", () => {
    const long = "x".repeat(201);
    const exact = "y".repeat(200);
    const data = eventData(
      {
        orderId: long,
        sku: exact,
        code: { nested: "object" },
        codes: ["fine", long],
        status: ["a", "b"],
        units: Number.NaN,
        attempts: Number.POSITIVE_INFINITY,
        kind: null,
        decision: "approved",
        channel: true,
        surface: 3,
        slotId: ["x", 1],
      },
      null
    );
    expect(data).toEqual({ sku: exact, status: ["a", "b"], decision: "approved", channel: true, surface: 3 });

    const many = Array.from({ length: 20 }, (_, i) => `c${i}`);
    expect(eventData({ codes: many }, null)).toEqual({ codes: many });
    expect(eventData({ codes: [...many, "one more"] }, null)).toEqual({});
  });

  it("maps a row to the envelope with its cursor id, the actor and the workflow when present", () => {
    const envelope = mapAuditRow(row({ evidence: { orderId: "ord_9", reason: "dropped" }, tx_hash: "0xabc" }));
    expect(envelope).toEqual({
      id: "100.7",
      type: "approval.approved",
      at: "2026-10-20T10:00:00.000Z",
      effectClass: "commercial_commitment",
      decision: "ALLOW",
      actor: { type: "owner", id: "owner:kitchen-owner" },
      workflowId: "wf_1",
      data: { orderId: "ord_9", txHash: "0xabc" },
    });
    const bare = mapAuditRow(row({ workflow_id: null, evidence: null }));
    expect(bare).not.toHaveProperty("workflowId");
    expect(bare.data).toEqual({});
  });

  it("a seeded secret inside a kept value is redacted", () => {
    const token = `bnd_${"A".repeat(43)}`;
    const envelope = mapAuditRow(row({ evidence: { code: `leaked ${token}` } }));
    expect(envelope.data.code).toBe("leaked [redacted-token]");
    expect(JSON.stringify(envelope)).not.toContain(token);
  });
});

describe("staff filter", () => {
  it("staff filter hides sensitive event types", () => {
    expect(isVisibleToRole("staff", "auth.token_issued")).toBe(false);
    expect(isVisibleToRole("staff", "auth.token_revoked")).toBe(false);
    expect(isVisibleToRole("staff", "connector.credential_set")).toBe(false);
    expect(isVisibleToRole("staff", "kitchen_capacity.set")).toBe(false);
    expect(isVisibleToRole("staff", "approval.approved")).toBe(true);
    expect(isVisibleToRole("staff", "orders.submit")).toBe(true);
    // The prefix is the namespace with its dot: a type that only starts with the same letters is not hidden.
    expect(isVisibleToRole("staff", "authorization.note")).toBe(true);
    expect(isVisibleToRole("owner", "auth.token_issued")).toBe(true);
    expect(isVisibleToRole("owner", "connector.credential_set")).toBe(true);
    expect(isVisibleToRole("owner", "kitchen_capacity.set")).toBe(true);
  });
});

describe("backpressure helper", () => {
  function fakeWritable(write: () => boolean) {
    const out = new EventEmitter() as EventEmitter & { write: () => boolean; destroyed: boolean };
    out.write = write;
    out.destroyed = false;
    return out;
  }

  it("backpressure helper ends a stream that does not drain", async () => {
    const out = fakeWritable(() => false);
    const outcome = await writeWithBackpressure(out as any, "id: 1\n\n", { drainTimeoutMs: 20 });
    expect(outcome).toBe("timed_out");
    // Nothing is left listening: a stream that is ended does not keep listeners on its socket.
    expect(out.listenerCount("drain")).toBe(0);
    expect(out.listenerCount("close")).toBe(0);
  });

  it("a write that is accepted, or drains in time, is not a failure", async () => {
    expect(await writeWithBackpressure(fakeWritable(() => true) as any, "x", { drainTimeoutMs: 20 })).toBe("written");

    const out = fakeWritable(() => false);
    const pending = writeWithBackpressure(out as any, "x", { drainTimeoutMs: 1000 });
    setTimeout(() => out.emit("drain"), 5);
    expect(await pending).toBe("drained");
    expect(out.listenerCount("drain")).toBe(0);
  });

  it("a stream that closes while waiting is reported as closed", async () => {
    const out = fakeWritable(() => false);
    const pending = writeWithBackpressure(out as any, "x", { drainTimeoutMs: 1000 });
    setTimeout(() => out.emit("close"), 5);
    expect(await pending).toBe("closed");
    expect(out.listenerCount("close")).toBe(0);
  });
});
