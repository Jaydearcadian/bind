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
});
