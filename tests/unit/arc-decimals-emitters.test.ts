import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak256, parseTransaction, toHex, type Hex } from "viem";
import {
  ERC20_UNITS_PER_CENT,
  NATIVE_WEI_PER_CENT,
  centsToErc20Units,
  centsToNativeWei,
  erc20UnitsToCents,
  nativeWeiToCents,
} from "../../src/adapters/settlement/arc-l1.js";
import { LocalSettlementSimulator } from "../../src/adapters/settlement/local-sim.js";
import {
  SettlementRejectedError,
  TRANSFER_FAILED_RECIPIENT,
  ZERO_ADDRESS_RECIPIENT,
} from "../../src/adapters/settlement/errors.js";
import type { TransferRequest } from "../../src/adapters/settlement/types.js";
import {
  MATCH_HASH,
  SIGNER,
  SUPPLIER,
  SYSTEM_EMITTER,
  STUB_USDC,
  STUB_CONTRACT,
  adapterOn,
  customRevert,
  receiptWith,
  rpcStub,
  settlementLog,
} from "../helpers/arc-stub-rpc.js";

/**
 * USDC units, the emitter filter and the recipient refusals of the Arc adapter (docs/decisions/0087, items 2 to 4 and the
 * not-found flag of item 5). Every case runs the real adapter code against a stub transport, so an RPC the adapter makes is
 * recorded and asserted, not assumed.
 */

const ORDER_ID = "ord_units_1";
const ORDER_ID_32: Hex = keccak256(toHex(ORDER_ID));
const TX_HASH: Hex = `0x${"ab".repeat(32)}`;
const ZERO = "0x0000000000000000000000000000000000000000";

function request(overrides: Partial<TransferRequest> = {}): TransferRequest {
  return {
    fromAddress: SIGNER,
    toAddress: SUPPLIER,
    amountCents: 1n,
    currency: "USDC",
    orderId: ORDER_ID,
    idempotencyKey: "idem_units_1",
    matchHash: MATCH_HASH,
    ...overrides,
  };
}

describe("USDC unit helpers (docs/decisions/0087, item 2)", () => {
  it("1 cent is 1e16 native wei and 10,000 six-decimal ERC-20 units", () => {
    expect(NATIVE_WEI_PER_CENT).toBe(10n ** 16n);
    expect(ERC20_UNITS_PER_CENT).toBe(10_000n);
    expect(centsToNativeWei(1n)).toBe(10n ** 16n);
    expect(centsToNativeWei(1n)).toBe(10_000n * 10n ** 12n);
    expect(centsToErc20Units(1n)).toBe(10_000n);
  });

  it("a sub-1e-6 native amount is not visible through balanceOf: 1.5e-6 USDC is one unit of the ERC-20 view and no cents", () => {
    const nativeWei = 1_500_000_000_000n; // 1.5e-6 USDC at 18 decimals
    expect(nativeWeiToCents(nativeWei)).toBe(0n);
    // The ERC-20 view truncates the last 12 decimal places: 1.5e-6 USDC reads as 1 unit.
    expect(nativeWei / 10n ** 12n).toBe(1n);
    expect(erc20UnitsToCents(1n)).toBe(0n);
  });

  it("the cent conversions round-trip and truncate, and refuse a negative or non-bigint input", () => {
    for (const cents of [1n, 7n, 245n, 24_500n]) {
      expect(nativeWeiToCents(centsToNativeWei(cents))).toBe(cents);
      expect(erc20UnitsToCents(centsToErc20Units(cents))).toBe(cents);
    }
    expect(erc20UnitsToCents(9_999n)).toBe(0n);
    expect(erc20UnitsToCents(10_000n)).toBe(1n);
    expect(() => centsToNativeWei(-1n)).toThrow(TypeError);
    expect(() => erc20UnitsToCents(1 as unknown as bigint)).toThrow(TypeError);
  });

  it("getBalance reads the 6-decimal view: one million units is one USDC, a hundred cents, never a 18-decimal reading", async () => {
    const one = adapterOn(rpcStub({ balanceUnits: 1_000_000n }).transport);
    expect(await one.getBalance(SIGNER)).toBe(100n);
    const sub = adapterOn(rpcStub({ balanceUnits: 1n }).transport);
    expect(await sub.getBalance(SIGNER)).toBe(0n);
  });

  it("transferUSDC sends 1 cent as 1e16 native wei, not as six-decimal units", async () => {
    const rpc = rpcStub({ baseFeeWei: 20_000_000_000n });
    await adapterOn(rpc.transport).transferUSDC(request({ amountCents: 1n }));
    const tx = parseTransaction(rpc.raws[0] as Hex) as { value?: bigint };
    expect(tx.value).toBe(10n ** 16n);
    expect(tx.value).not.toBe(10_000n);
    expect(tx.value).not.toBe(1_000_000n);
  });

  it("no USDC amount in arc-l1.ts is multiplied or divided by 1e12 (the 18-to-6 step is named, never inlined)", () => {
    const path = fileURLToPath(new URL("../../src/adapters/settlement/arc-l1.ts", import.meta.url));
    const source = readFileSync(path, "utf8");
    const inlined = /(\*|\/)\s*10n\s*\*\*\s*12n|\b1e12\b|1_000_000_000_000\b|10n\s*\*\*\s*18n\s*\/|10n\s*\*\*\s*6n/;
    expect(source.match(inlined)).toBeNull();
  });

  it("the local simulator refuses a zero recipient before it moves any balance", async () => {
    const sim = new LocalSettlementSimulator();
    const before = await sim.getBalance(SIGNER);
    const err = await sim.transferUSDC(request({ toAddress: ZERO, amountCents: 5n, fromAddress: SIGNER })).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(SettlementRejectedError);
    expect((err as SettlementRejectedError).code).toBe(ZERO_ADDRESS_RECIPIENT);
    expect(await sim.getBalance(SIGNER)).toBe(before);
  });
});

describe("emitter filtering (docs/decisions/0087, item 3)", () => {
  it("confirm counts SettlementExecuted only from the BindSettlement address, and ignores same-topic logs from USDC and the system emitter", async () => {
    const foreign = [
      settlementLog({ emitter: STUB_USDC, orderId32: ORDER_ID_32, txHash: TX_HASH }),
      settlementLog({ emitter: SYSTEM_EMITTER, orderId32: ORDER_ID_32, txHash: TX_HASH }),
    ];
    const rpc = rpcStub({ receipt: receiptWith(foreign) });
    const outcome = await adapterOn(rpc.transport).confirm(TX_HASH);
    expect(outcome.status).toBe("failed");
    expect(outcome.failureCode).toBe("EVENT_MISSING");
  });

  it("confirm is confirmed when the contract's own SettlementExecuted is present, even beside foreign logs", async () => {
    const logs = [
      settlementLog({ emitter: SYSTEM_EMITTER, orderId32: ORDER_ID_32, txHash: TX_HASH }),
      settlementLog({ emitter: STUB_CONTRACT, orderId32: ORDER_ID_32, txHash: TX_HASH }),
      settlementLog({ emitter: STUB_USDC, orderId32: ORDER_ID_32, txHash: TX_HASH }),
    ];
    const rpc = rpcStub({ receipt: receiptWith(logs) });
    const outcome = await adapterOn(rpc.transport).confirm(TX_HASH);
    expect(outcome.status).toBe("confirmed");
  });

  it("a SettlementExecuted from another contract address is not this settlement", async () => {
    const other = "0x9999999999999999999999999999999999999999";
    const rpc = rpcStub({ receipt: receiptWith([settlementLog({ emitter: other, orderId32: ORDER_ID_32, txHash: TX_HASH })]) });
    const outcome = await adapterOn(rpc.transport).confirm(TX_HASH);
    expect(outcome.status).toBe("failed");
    expect(outcome.failureCode).toBe("EVENT_MISSING");
  });

  it("findTransfer sends the contract address in every log scan, and ignores a same-topic log from another emitter", async () => {
    const rpc = rpcStub({
      logs: [settlementLog({ emitter: STUB_USDC, orderId32: ORDER_ID_32, txHash: TX_HASH })],
    });
    const found = await adapterOn(rpc.transport).findTransfer({ orderId: ORDER_ID });
    expect(found).toBeNull();
    const scans = rpc.calls.filter((c) => c.method === "eth_getLogs");
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) {
      expect(String(scan.params[0].address).toLowerCase()).toBe(STUB_CONTRACT.toLowerCase());
    }
  });

  it("findTransfer answers the contract's own log, with its real hash", async () => {
    const rpc = rpcStub({
      logs: [
        settlementLog({ emitter: STUB_USDC, orderId32: ORDER_ID_32, txHash: `0x${"11".repeat(32)}` as Hex }),
        settlementLog({ emitter: STUB_CONTRACT, orderId32: ORDER_ID_32, txHash: TX_HASH, blockNumber: 9n }),
      ],
    });
    const found = await adapterOn(rpc.transport).findTransfer({ orderId: ORDER_ID });
    expect(found).not.toBeNull();
    expect(found?.txHash).toBe(TX_HASH);
    expect(found?.status).toBe("confirmed");
  });
});

describe("recipient refusals (docs/decisions/0087, item 4)", () => {
  it("refuses a zero-address recipient before any network call, with ZERO_ADDRESS_RECIPIENT", async () => {
    const rpc = rpcStub({});
    const err = await adapterOn(rpc.transport)
      .transferUSDC(request({ toAddress: ZERO }))
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SettlementRejectedError);
    expect((err as SettlementRejectedError).code).toBe(ZERO_ADDRESS_RECIPIENT);
    expect(rpc.calls, "no RPC call of any kind is made").toHaveLength(0);
    expect(rpc.raws).toHaveLength(0);
  });

  it("maps a pre-flight TransferFailed to TRANSFER_FAILED_RECIPIENT, and sends nothing", async () => {
    const rpc = rpcStub({ preflight: { revertData: customRevert("TransferFailed") } });
    const err = await adapterOn(rpc.transport)
      .transferUSDC(request())
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SettlementRejectedError);
    expect((err as SettlementRejectedError).code).toBe(TRANSFER_FAILED_RECIPIENT);
    expect((err as Error).message).toContain("may be blocklisted or invalid");
    expect(rpc.raws).toHaveLength(0);
  });

  it("maps the 'Zero address not allowed' revert text to TRANSFER_FAILED_RECIPIENT", async () => {
    const rpc = rpcStub({ preflight: { text: "execution reverted: Zero address not allowed" } });
    const err = await adapterOn(rpc.transport)
      .transferUSDC(request())
      .then(() => null, (e: unknown) => e);
    expect((err as SettlementRejectedError).code).toBe(TRANSFER_FAILED_RECIPIENT);
  });

  it("leaves every other revert's code as it was", async () => {
    const rpc = rpcStub({ preflight: { revertData: customRevert("Unauthorized") } });
    const err = await adapterOn(rpc.transport)
      .transferUSDC(request())
      .then(() => null, (e: unknown) => e);
    expect((err as SettlementRejectedError).code).toBe("Unauthorized");
  });
});

describe("the not-found flag on confirm (docs/decisions/0087, item 5)", () => {
  it("is set when no receipt arrives and the node does not know the transaction", async () => {
    const rpc = rpcStub({ receipt: "pending", transaction: null });
    const outcome = await adapterOn(rpc.transport).confirm(TX_HASH);
    expect(outcome.status).toBe("submitted");
    expect(outcome.notFoundOnNode).toBe(true);
  });

  it("is not set when the node still has the transaction pending", async () => {
    const rpc = rpcStub({ receipt: "pending", transaction: { hash: TX_HASH, blockNumber: null } });
    const outcome = await adapterOn(rpc.transport).confirm(TX_HASH);
    expect(outcome.status).toBe("submitted");
    expect(outcome.notFoundOnNode).toBeUndefined();
  });

  it("is not set when the transaction lookup itself fails", async () => {
    const rpc = rpcStub({ receipt: "pending", transaction: "error" });
    const outcome = await adapterOn(rpc.transport).confirm(TX_HASH);
    expect(outcome.status).toBe("submitted");
    expect(outcome.notFoundOnNode).toBeUndefined();
  });

  it("is not set when the receipt read fails, even if the transaction lookup says not found", async () => {
    const rpc = rpcStub({ receipt: "error", transaction: null });
    const outcome = await adapterOn(rpc.transport).confirm(TX_HASH);
    expect(outcome.status).toBe("submitted");
    expect(outcome.notFoundOnNode).toBeUndefined();
  });

  it("is never set on a confirmed or failed result", async () => {
    const confirmed = await adapterOn(
      rpcStub({ receipt: receiptWith([settlementLog({ orderId32: ORDER_ID_32, txHash: TX_HASH })]) }).transport
    ).confirm(TX_HASH);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.notFoundOnNode).toBeUndefined();
    const reverted = await adapterOn(rpcStub({ receipt: receiptWith([], "0x0") }).transport).confirm(TX_HASH);
    expect(reverted.failureCode).toBe("REVERTED");
    expect(reverted.notFoundOnNode).toBeUndefined();
  });

  it("the local simulator never reports notFoundOnNode", async () => {
    const sim = new LocalSettlementSimulator();
    expect((await sim.confirm(TX_HASH)).notFoundOnNode).toBeUndefined();
  });
});
