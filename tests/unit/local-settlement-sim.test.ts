import { describe, it, expect } from "vitest";
import { LocalSettlementSimulator } from "../../src/adapters/settlement/local-sim.js";

const TREASURY = "0xA4D196C26F07bcd68FA76a0f1bECd2536C4ae9C2";
const SUPPLIER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

describe("LocalSettlementSimulator", () => {
  it("transfer returns submitted, simulated true, a 0x hash and no explorer link", async () => {
    const sim = new LocalSettlementSimulator();
    const result = await sim.transferUSDC({
      fromAddress: TREASURY,
      toAddress: SUPPLIER,
      amountCents: 100n,
      currency: "USDC",
      orderId: "ord_sim_1",
      idempotencyKey: "idem_pay_ord_sim_1",
    });

    expect(result.status).toBe("submitted");
    expect(result.simulated).toBe(true);
    expect(result.mode).toBe("local");
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.explorerUrl).toBeUndefined();
  });

  it("confirm returns confirmed with simulated true for the hash it issued", async () => {
    const sim = new LocalSettlementSimulator();
    const sent = await sim.transferUSDC({
      fromAddress: TREASURY,
      toAddress: SUPPLIER,
      amountCents: 100n,
      currency: "USDC",
      orderId: "ord_sim_2",
      idempotencyKey: "idem_pay_ord_sim_2",
    });

    const confirmed = await sim.confirm(sent.txHash);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.simulated).toBe(true);
    expect(confirmed.txHash).toBe(sent.txHash);
    expect(confirmed.explorerUrl).toBeUndefined();
  });

  it("an insufficient simulated balance still throws and moves nothing", async () => {
    const sim = new LocalSettlementSimulator();
    await expect(
      sim.transferUSDC({
        fromAddress: TREASURY,
        toAddress: SUPPLIER,
        amountCents: 999_999_999n,
        currency: "USDC",
        orderId: "ord_sim_3",
        idempotencyKey: "idem_pay_ord_sim_3",
      })
    ).rejects.toThrow(/Insufficient USDC balance/);
    expect(await sim.getBalance(SUPPLIER)).toBe(500000n);
  });

  it("an account drained to exactly zero stays at zero and cannot spend the default balance again", async () => {
    // Regression: getBalance used `||`, so a stored 0n fell back to the 5,000.00 default and the drained account could spend again.
    const sim = new LocalSettlementSimulator();
    const DRAINED = "0x00000000000000000000000000000000000000d1";
    await sim.transferUSDC({
      fromAddress: TREASURY,
      toAddress: DRAINED,
      amountCents: 1000000n,
      currency: "USDC",
      orderId: "ord_drain_fund",
      idempotencyKey: "idem_pay_ord_drain_fund",
    });
    await sim.transferUSDC({
      fromAddress: DRAINED,
      toAddress: SUPPLIER,
      amountCents: 1000000n,
      currency: "USDC",
      orderId: "ord_drain_out",
      idempotencyKey: "idem_pay_ord_drain_out",
    });

    expect(await sim.getBalance(DRAINED)).toBe(0n);
    await expect(
      sim.transferUSDC({
        fromAddress: DRAINED,
        toAddress: SUPPLIER,
        amountCents: 1n,
        currency: "USDC",
        orderId: "ord_drain_again",
        idempotencyKey: "idem_pay_ord_drain_again",
      })
    ).rejects.toThrow(/Insufficient USDC balance/);
    expect(await sim.getBalance(DRAINED)).toBe(0n);
  });
});

describe("LocalSettlementSimulator idempotency and transfer lookup", () => {
  const request = (overrides: Partial<{ amountCents: bigint; orderId: string; idempotencyKey: string }> = {}) => ({
    fromAddress: TREASURY,
    toAddress: SUPPLIER,
    amountCents: 100n,
    currency: "USDC",
    orderId: "ord_idem_1",
    idempotencyKey: "idem_pay_ord_idem_1",
    ...overrides,
  });

  it("the same idempotency key moves money once", async () => {
    const sim = new LocalSettlementSimulator();
    const first = await sim.transferUSDC(request());
    const second = await sim.transferUSDC(request());

    expect(second).toEqual(first);
    expect(await sim.getBalance(TREASURY)).toBe(1000000n - 100n);
    expect(await sim.getBalance(SUPPLIER)).toBe(100n);
  });

  it("a failed insufficient-balance attempt is not remembered", async () => {
    const sim = new LocalSettlementSimulator();
    const key = "idem_pay_ord_idem_retry";
    await expect(sim.transferUSDC(request({ amountCents: 999_999_999n, orderId: "ord_idem_retry", idempotencyKey: key }))).rejects.toThrow(
      /Insufficient USDC balance/
    );
    expect(await sim.findTransfer({ orderId: "ord_idem_retry" })).toBeNull();

    // The same key, with an amount the treasury can pay, is a new attempt and moves the money.
    const sent = await sim.transferUSDC(request({ amountCents: 100n, orderId: "ord_idem_retry", idempotencyKey: key }));
    expect(sent.status).toBe("submitted");
    expect(await sim.getBalance(TREASURY)).toBe(1000000n - 100n);
    expect(await sim.getBalance(SUPPLIER)).toBe(100n);
  });

  it("findTransfer returns the remembered transfer and null for an unknown order", async () => {
    const sim = new LocalSettlementSimulator();
    expect(await sim.findTransfer({ orderId: "ord_idem_lookup" })).toBeNull();

    const sent = await sim.transferUSDC(request({ orderId: "ord_idem_lookup", idempotencyKey: "idem_pay_ord_idem_lookup" }));

    expect(await sim.findTransfer({ orderId: "ord_idem_lookup" })).toEqual(sent);
    expect(await sim.findTransfer({ orderId: "ord_idem_unknown" })).toBeNull();
  });

  it("a second key for an order that is already settled returns the earlier transfer and moves nothing", async () => {
    // The Arc contract refuses a second settlement of one order id. The simulator does the same.
    const sim = new LocalSettlementSimulator();
    const first = await sim.transferUSDC(request({ orderId: "ord_idem_twice", idempotencyKey: "idem_a" }));
    const second = await sim.transferUSDC(request({ orderId: "ord_idem_twice", idempotencyKey: "idem_b" }));

    expect(second.txHash).toBe(first.txHash);
    expect(await sim.getBalance(TREASURY)).toBe(1000000n - 100n);
  });
});
