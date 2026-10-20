import { describe, it, expect } from "vitest";
import {
  decidePromise,
  type PromiseFacts,
  type PromiseInput,
} from "../../src/workflows/fulfilment-promise.js";

/*
 * The pure promise decision for customer orders (Task 8a, ADR 0026). No database and no clock: every fact is passed in.
 * Bind promises a time only when stock minus reservations covers every line and a kitchen slot has room.
 */

const NOW = new Date("2026-10-20T12:00:00.000Z");
const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

function facts(overrides: Partial<PromiseFacts> = {}): PromiseFacts {
  return {
    stock: {
      FLOUR: { onHand: 10, reserved: 0 },
      MILK: { onHand: 5, reserved: 0 },
    },
    slots: [{ id: "cap_one", startsAt: at(1), capacityUnits: 10, usedUnits: 0 }],
    roleGranted: true,
    agentsPaused: false,
    ...overrides,
  };
}

function input(overrides: Partial<PromiseInput> = {}): PromiseInput {
  return {
    lines: [{ sku: "FLOUR", quantity: 2 }],
    now: NOW,
    actor: "agent",
    ...overrides,
  };
}

describe("customer order promise decision", () => {
  it("never promises a time when stock does not cover the order", () => {
    const decision = decidePromise(
      facts({ stock: { FLOUR: { onHand: 1, reserved: 0 } } }),
      input({ lines: [{ sku: "FLOUR", quantity: 2 }] })
    );

    expect(decision.status).toBe("declined");
    expect(decision.reasons).toEqual([{ code: "INSUFFICIENT_STOCK", sku: "FLOUR" }]);
    expect(decision.promisedFor).toBeUndefined();
    expect(decision.slotId).toBeUndefined();
    expect("promisedFor" in decision).toBe(false);
    expect("slotId" in decision).toBe(false);
  });

  it("never promises a time when no capacity slot exists", () => {
    const none = decidePromise(facts({ slots: [] }), input());
    expect(none.status).toBe("declined");
    expect(none.reasons).toEqual([{ code: "NO_CAPACITY_SLOT" }]);
    expect("promisedFor" in none).toBe(false);

    const full = decidePromise(
      facts({ slots: [{ id: "cap_full", startsAt: at(1), capacityUnits: 3, usedUnits: 3 }] }),
      input()
    );
    expect(full.status).toBe("declined");
    expect(full.reasons).toEqual([{ code: "NO_CAPACITY_SLOT" }]);
    expect("promisedFor" in full).toBe(false);
  });

  it("a promise is the start of the earliest slot with enough room at or after the requested time", () => {
    const slots = [
      // Listed last but earliest: must be picked only when it is at or after the requested time with room.
      { id: "cap_c", startsAt: at(3), capacityUnits: 10, usedUnits: 0 },
      { id: "cap_before", startsAt: at(0.5), capacityUnits: 10, usedUnits: 0 },
      { id: "cap_small", startsAt: at(1.5), capacityUnits: 10, usedUnits: 9 },
      { id: "cap_b", startsAt: at(2), capacityUnits: 5, usedUnits: 0 },
    ];

    const requested = decidePromise(facts({ slots }), input({ lines: [{ sku: "FLOUR", quantity: 2 }], requestedFor: at(1.5) }));
    expect(requested.status).toBe("accepted");
    expect(requested.promisedFor?.getTime()).toBe(at(2).getTime());
    expect(requested.slotId).toBe("cap_b");
    expect(requested.reasons).toEqual([]);
    expect(requested.units).toBe(2);

    // Without a requested time the earliest slot at or after now with room is chosen, not the first in the list.
    const immediate = decidePromise(facts({ slots }), input({ lines: [{ sku: "FLOUR", quantity: 2 }] }));
    expect(immediate.status).toBe("accepted");
    expect(immediate.slotId).toBe("cap_before");
    expect(immediate.promisedFor?.getTime()).toBe(at(0.5).getTime());
  });

  it("a requested time after every slot is declined, not given an earlier slot", () => {
    const decision = decidePromise(
      facts({ slots: [{ id: "cap_early", startsAt: at(1), capacityUnits: 10, usedUnits: 0 }] }),
      input({ requestedFor: at(5) })
    );

    expect(decision.status).toBe("declined");
    expect(decision.reasons).toEqual([{ code: "NO_CAPACITY_SLOT" }]);
    expect("promisedFor" in decision).toBe(false);
    expect("slotId" in decision).toBe(false);
  });

  it("some lines covered and some not is partially available with no date", () => {
    const decision = decidePromise(
      facts(),
      input({
        lines: [
          { sku: "FLOUR", quantity: 2 },
          { sku: "MILK", quantity: 9 },
        ],
      })
    );

    expect(decision.status).toBe("partially_available");
    expect(decision.reasons).toEqual([{ code: "INSUFFICIENT_STOCK", sku: "MILK" }]);
    expect("promisedFor" in decision).toBe(false);
    expect("slotId" in decision).toBe(false);
  });

  it("an unknown sku is reported and nothing is promised", () => {
    const unknown = decidePromise(facts(), input({ lines: [{ sku: "NOT-STOCKED", quantity: 1 }] }));
    expect(unknown.status).toBe("declined");
    expect(unknown.reasons).toEqual([{ code: "UNKNOWN_SKU", sku: "NOT-STOCKED" }]);
    expect("promisedFor" in unknown).toBe(false);

    // A sku named like an inherited object property is unknown, not a stock record.
    const inherited = decidePromise(facts(), input({ lines: [{ sku: "constructor", quantity: 1 }] }));
    expect(inherited.status).toBe("declined");
    expect(inherited.reasons).toEqual([{ code: "UNKNOWN_SKU", sku: "constructor" }]);

    const mixed = decidePromise(
      facts(),
      input({
        lines: [
          { sku: "FLOUR", quantity: 1 },
          { sku: "NOT-STOCKED", quantity: 1 },
        ],
      })
    );
    expect(mixed.status).toBe("partially_available");
    expect(mixed.reasons).toEqual([{ code: "UNKNOWN_SKU", sku: "NOT-STOCKED" }]);
    expect("promisedFor" in mixed).toBe(false);
  });

  it("reserved stock is not available again", () => {
    const reservedFacts = facts({ stock: { FLOUR: { onHand: 10, reserved: 9 } } });

    const short = decidePromise(reservedFacts, input({ lines: [{ sku: "FLOUR", quantity: 2 }] }));
    expect(short.status).toBe("declined");
    expect(short.reasons).toEqual([{ code: "INSUFFICIENT_STOCK", sku: "FLOUR" }]);
    expect("promisedFor" in short).toBe(false);

    const exact = decidePromise(reservedFacts, input({ lines: [{ sku: "FLOUR", quantity: 1 }] }));
    expect(exact.status).toBe("accepted");
    expect(exact.reasons).toEqual([]);
  });

  it("a non-integer, zero, negative or oversized quantity is invalid", () => {
    for (const quantity of [1.5, 0, -1, 10_001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = decidePromise(facts(), input({ lines: [{ sku: "FLOUR", quantity }] }));
      expect(decision.status, `quantity ${quantity}`).toBe("declined");
      // Invalid input reports only the invalid line: no stock, capacity or role reasons are added.
      expect(decision.reasons, `quantity ${quantity}`).toEqual([{ code: "INVALID_QUANTITY", sku: "FLOUR" }]);
      expect(decision.units, `quantity ${quantity}`).toBe(0);
      expect("promisedFor" in decision, `quantity ${quantity}`).toBe(false);
    }

    // 10000 is the largest valid quantity when stock covers it.
    const largest = decidePromise(
      facts({
        stock: { FLOUR: { onHand: 20_000, reserved: 0 } },
        slots: [{ id: "cap_big", startsAt: at(1), capacityUnits: 10_000, usedUnits: 0 }],
      }),
      input({ lines: [{ sku: "FLOUR", quantity: 10_000 }] })
    );
    expect(largest.status).toBe("accepted");
    expect(largest.units).toBe(10_000);
  });

  it("duplicate skus in one order are invalid", () => {
    const decision = decidePromise(
      facts(),
      input({
        lines: [
          { sku: "FLOUR", quantity: 1 },
          { sku: "FLOUR", quantity: 2 },
        ],
      })
    );

    expect(decision.status).toBe("declined");
    expect(decision.reasons).toEqual([{ code: "INVALID_QUANTITY", sku: "FLOUR" }]);
    expect(decision.units).toBe(0);
    expect("promisedFor" in decision).toBe(false);
  });

  it("an empty order or one with more than 50 lines is invalid", () => {
    const empty = decidePromise(facts(), input({ lines: [] }));
    expect(empty.status).toBe("declined");
    expect(empty.reasons).toEqual([{ code: "INVALID_QUANTITY" }]);

    const many = Array.from({ length: 51 }, (_, i) => ({ sku: `SKU-${i}`, quantity: 1 }));
    const tooMany = decidePromise(
      facts({ stock: Object.fromEntries(many.map((l) => [l.sku, { onHand: 5, reserved: 0 }])) }),
      input({ lines: many })
    );
    expect(tooMany.status).toBe("declined");
    expect(tooMany.reasons).toEqual([{ code: "INVALID_QUANTITY" }]);
  });

  it("an automated order without the role is held for the owner", () => {
    // Stock and capacity are short of nothing here, and they are not evaluated for a held order.
    const held = decidePromise(facts({ roleGranted: false }), input());
    expect(held.status).toBe("needs_owner");
    expect(held.reasons).toEqual([{ code: "ROLE_NOT_PERMITTED" }]);
    expect("promisedFor" in held).toBe(false);
    expect(held.units).toBe(2);

    const heldShort = decidePromise(
      facts({ roleGranted: false, stock: { FLOUR: { onHand: 0, reserved: 0 } }, slots: [] }),
      input()
    );
    expect(heldShort.status).toBe("needs_owner");
    expect(heldShort.reasons).toEqual([{ code: "ROLE_NOT_PERMITTED" }]);
  });

  it("a paused workspace holds an automated order for the owner", () => {
    const paused = decidePromise(facts({ agentsPaused: true }), input());
    expect(paused.status).toBe("needs_owner");
    expect(paused.reasons).toEqual([{ code: "AGENTS_PAUSED" }]);
    expect("promisedFor" in paused).toBe(false);

    // Both holds are reported together, role first.
    const both = decidePromise(facts({ agentsPaused: true, roleGranted: false }), input());
    expect(both.status).toBe("needs_owner");
    expect(both.reasons).toEqual([{ code: "ROLE_NOT_PERMITTED" }, { code: "AGENTS_PAUSED" }]);
  });

  it("an owner decision does not need the role", () => {
    const decision = decidePromise(facts({ roleGranted: false }), input({ actor: "owner" }));

    expect(decision.status).toBe("accepted");
    expect(decision.reasons).toEqual([]);
    expect(decision.slotId).toBe("cap_one");
    expect(decision.promisedFor?.getTime()).toBe(at(1).getTime());
  });

  it("the decision never changes its inputs", () => {
    const f = facts({
      slots: [
        { id: "cap_one", startsAt: at(1), capacityUnits: 10, usedUnits: 0 },
        { id: "cap_two", startsAt: at(2), capacityUnits: 10, usedUnits: 0 },
      ],
    });
    const i = input({ lines: [{ sku: "FLOUR", quantity: 2 }, { sku: "NOT-STOCKED", quantity: 1 }], requestedFor: at(0.5) });
    const factsBefore = structuredClone(f);
    const inputBefore = structuredClone(i);

    decidePromise(f, i);
    decidePromise(f, { ...i, actor: "owner" });

    expect(f).toEqual(factsBefore);
    expect(i).toEqual(inputBefore);
    // Slot order in the caller's array is not reordered by the decision.
    expect(f.slots.map((s) => s.id)).toEqual(["cap_one", "cap_two"]);
  });
});
